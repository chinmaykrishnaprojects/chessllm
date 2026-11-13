/**
 * KV-cached nanogpt inference (models exported by export/export_kv_onnx.py:
 * inputs idx/past_k/past_v, outputs logits/present_k/present_v).
 *
 * Strategy: commit the game context once (prefill or incremental extension of
 * the previous context), then answer per-move-candidate suffix queries by
 * running only the suffix with the committed past as read-only input. ONNX
 * never mutates inputs, so candidate branches share the same past tensors.
 */
import * as ort from 'onnxruntime-web';
import type { Vocab } from './nanogptOnnx';
import { softmax } from './nanogptOnnx';

const N_LAYER = 16;
const N_HEAD = 8;
const HEAD_DIM = 64; // n_embd 512 / 8 heads

function emptyPast(): ort.Tensor {
  return new ort.Tensor('float32', new Float32Array(0), [N_LAYER, 1, N_HEAD, 0, HEAD_DIM]);
}

function idxTensor(ids: number[]): ort.Tensor {
  return new ort.Tensor('int64', BigInt64Array.from(ids.map((v) => BigInt(v))), [1, ids.length]);
}

function commonPrefixLen(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

export class NanoGptKv {
  private session: ort.InferenceSession;
  readonly vocab: Vocab;

  /** Committed context state. */
  private ctxIds: number[] = [];
  private pastK: ort.Tensor = emptyPast();
  private pastV: ort.Tensor = emptyPast();
  private ctxLogits: Float32Array | null = null;

  private constructor(session: ort.InferenceSession, vocab: Vocab) {
    this.session = session;
    this.vocab = vocab;
  }

  static async fromBuffer(modelBytes: Uint8Array, vocab: Vocab): Promise<NanoGptKv> {
    const ab = modelBytes.buffer.slice(
      modelBytes.byteOffset,
      modelBytes.byteOffset + modelBytes.byteLength,
    );
    const session = await ort.InferenceSession.create(ab, { executionProviders: ['wasm'] });
    return new NanoGptKv(session, vocab);
  }

  static async load(modelUrl: string, vocab: Vocab): Promise<NanoGptKv> {
    const session = await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] });
    return new NanoGptKv(session, vocab);
  }

  /** For tests: inject a fake session. */
  static forTest(session: ort.InferenceSession, vocab: Vocab): NanoGptKv {
    return new NanoGptKv(session, vocab);
  }

  get committedLength(): number {
    return this.ctxIds.length;
  }

  private async run(ids: number[], pastK: ort.Tensor, pastV: ort.Tensor) {
    return this.session.run({ idx: idxTensor(ids), past_k: pastK, past_v: pastV });
  }

  /**
   * Commit a context: if it extends the committed one, run only the delta;
   * otherwise re-prefill from scratch. Stores next-token logits for the context.
   */
  async setContext(ids: number[]): Promise<void> {
    if (ids.length === 0) throw new Error('empty context');
    const lcp = commonPrefixLen(this.ctxIds, ids);
    let startFrom: number;
    if (lcp === this.ctxIds.length && this.ctxIds.length > 0 && ids.length > lcp) {
      startFrom = lcp; // pure extension: reuse committed past
    } else if (lcp === this.ctxIds.length && ids.length === lcp) {
      return; // identical context already committed
    } else {
      // divergence (takeback / new game): reset
      this.ctxIds = [];
      this.pastK = emptyPast();
      this.pastV = emptyPast();
      startFrom = 0;
    }
    const delta = ids.slice(startFrom);
    const out = await this.run(delta, this.pastK, this.pastV);
    this.pastK = out.present_k as ort.Tensor;
    this.pastV = out.present_v as ort.Tensor;
    this.ctxIds = ids.slice();
    this.ctxLogits = (out.logits.data as Float32Array).slice();
  }

  /**
   * Next-token logits for context + suffix. Suffix runs are read-only against
   * the committed past (branching is free). Empty suffix returns the cached
   * context logits without any inference.
   */
  async nextTokenLogits(tokenIds: number[]): Promise<Float32Array> {
    const lcp = commonPrefixLen(this.ctxIds, tokenIds);
    if (lcp !== this.ctxIds.length || this.ctxIds.length === 0) {
      // caller passed a context that isn't an extension of the committed one
      await this.setContext(tokenIds);
      return this.ctxLogits!;
    }
    const suffix = tokenIds.slice(lcp);
    if (suffix.length === 0) {
      if (!this.ctxLogits) throw new Error('context committed without logits');
      return this.ctxLogits;
    }
    const out = await this.run(suffix, this.pastK, this.pastV);
    return out.logits.data as Float32Array;
  }

  /** Convenience: probability distribution after context+suffix at temperature. */
  async nextTokenProbs(tokenIds: number[], temperature = 1): Promise<Float32Array> {
    return softmax(await this.nextTokenLogits(tokenIds), temperature);
  }
}
