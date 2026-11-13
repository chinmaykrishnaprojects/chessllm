/**
 * Browser-side nanogpt inference via onnxruntime-web.
 * Handles tokenization, ONNX inference, sampling, and legal move filtering.
 * Model files are served from /models/ (e.g. /models/stockfish16_int8.onnx, /models/vocab.json).
 */
import * as ort from 'onnxruntime-web';

export interface Vocab {
  stoi: Record<string, number>;
  itos: Record<string, string>;
}

export interface MoveResult {
  san: string;
  prob: number;
  alternatives: Record<string, number>;
}

export interface SampleOpts {
  temperature?: number;
  topP?: number;
  minP?: number;
}

/** Match Python preprocessing: strip headers, "1. e4" -> "1.e4", ";" prefix, trailing space. */
export function preprocessPgn(pgn: string): string {
  let s = pgn;
  const headerEnd = s.indexOf('\n\n');
  if (headerEnd !== -1) s = s.slice(headerEnd + 2).replace(/^\s+/, '');
  s = s.replace(/(\d+\.) /g, '$1');
  const endsWithMoveNumber = /\d+\.$/.test(s);
  if (!s.endsWith(' ') && !endsWithMoveNumber) s += ' ';
  return ';' + s;
}

export function tokenize(text: string, vocab: Vocab): number[] {
  const ids: number[] = [];
  for (const ch of text) {
    const id = vocab.stoi[ch];
    if (id === undefined) throw new Error(`Unknown character in input: ${JSON.stringify(ch)}`);
    ids.push(id);
  }
  return ids;
}

export function detokenize(ids: number[], vocab: Vocab): string {
  return ids.map((id) => {
    const ch = vocab.itos[String(id)];
    if (ch === undefined) throw new Error(`Unknown token id: ${id}`);
    return ch;
  }).join('');
}

/** Softmax over logits / temperature (temperature defaults to 1). */
export function softmax(logits: Float32Array, temperature = 1): Float32Array {
  const scaled = new Float32Array(logits.length);
  for (let i = 0; i < logits.length; i++) scaled[i] = logits[i] / temperature;
  let max = -Infinity;
  for (const v of scaled) if (v > max) max = v;
  const out = new Float32Array(scaled.length);
  let sum = 0;
  for (let i = 0; i < scaled.length; i++) {
    out[i] = Math.exp(scaled[i] - max);
    sum += out[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= sum;
  return out;
}

/**
 * Build the model context exactly like the Flask backend's /api/move does:
 * append the fullmove number ("N. ") when it is White's turn, collapse
 * "N. " -> "N.", add the ";" prefix and trailing space.
 */
export function buildEngineContext(pgn: string, whiteToMove: boolean, fullmoveNumber: number): string {
  let s = pgn.trim();
  if (s.length > 0) s += ' ';
  if (whiteToMove) s += `${fullmoveNumber}. `;
  s = s.replace(/(\d+\.) /g, '$1');
  const endsWithMoveNumber = /\d+\.$/.test(s);
  if (!s.endsWith(' ') && !endsWithMoveNumber) s += ' ';
  return ';' + s;
}

export type NextLogitsFn = (tokenIds: number[]) => Promise<Float32Array>;

/**
 * Probability distribution over legal moves using the same smart pruning as the
 * server's get_move_probabilities_from_logits (the "turbo" gameplay path):
 * - temperature is applied at the character level (logits / temp before softmax)
 * - first-char groups below 0.1% are pruned to 0
 * - partial move paths whose running product drops below 0.1% are pruned to 0
 * - the result is normalized over legal moves (all zeros if everything pruned)
 */
export async function computePrunedMoveProbs(
  nextLogits: NextLogitsFn,
  vocab: Vocab,
  context: string,
  legalMoves: string[],
  temperature: number,
): Promise<Record<string, number>> {
  const effTemp = temperature < 0.01 ? Math.max(temperature, 0.001) : temperature;
  const MIN_P_THRESHOLD = 0.001;
  const baseIds = tokenize(context, vocab);

  const probsCache = new Map<string, Float32Array>();
  const probsAfter = async (suffix: string): Promise<Float32Array> => {
    let p = probsCache.get(suffix);
    if (!p) {
      const suffixIds: number[] = [];
      for (const ch of suffix) {
        const id = vocab.stoi[ch];
        if (id === undefined) throw new Error(`Unknown character: ${JSON.stringify(ch)}`);
        suffixIds.push(id);
      }
      const logits = await nextLogits(baseIds.concat(suffixIds));
      p = softmax(logits, effTemp);
      probsCache.set(suffix, p);
    }
    return p;
  };

  // Group moves by first char so a low-probability group is pruned with one pass
  const byFirstChar = new Map<string, string[]>();
  for (const san of legalMoves) {
    const fc = san[0];
    const group = byFirstChar.get(fc);
    if (group) group.push(san);
    else byFirstChar.set(fc, [san]);
  }

  const moveProbs: Record<string, number> = {};
  const firstTokenProbs = await probsAfter('');

  for (const [fc, moves] of byFirstChar) {
    const fcId = vocab.stoi[fc];
    const groupProb = fcId === undefined ? 0 : firstTokenProbs[fcId];
    if (groupProb < MIN_P_THRESHOLD) {
      for (const san of moves) moveProbs[san] = 0;
      continue;
    }
    for (const san of moves) {
      let prob = groupProb;
      let prefix = fc;
      for (const ch of san.slice(1)) {
        const id = vocab.stoi[ch];
        if (id === undefined) { prob = 0; break; }
        const probs = await probsAfter(prefix);
        prob *= probs[id];
        prefix += ch;
        if (prob < MIN_P_THRESHOLD) { prob = 0; break; }
      }
      moveProbs[san] = prob;
    }
  }

  let total = 0;
  for (const san of legalMoves) total += moveProbs[san] ?? 0;
  if (total > 0) {
    for (const san of Object.keys(moveProbs)) moveProbs[san] /= total;
  }
  return moveProbs;
}

/** Mirror the server's apply_dist_filters: min_p filter (keep at least the best), then top_p nucleus cut, then renormalize. */
export { applyDistFilters, sampleFromDist } from './sampling';
import { applyDistFilters, sampleFromDist } from './sampling';

export interface TurboMoveResult {
  san: string;
  prob: number;
  probabilities: { move: string; prob: number }[];
  fallback: boolean;
}

export class NanoGptOnnx {
  private session: ort.InferenceSession;
  private vocab: Vocab;

  private constructor(session: ort.InferenceSession, vocab: Vocab) {
    this.session = session;
    this.vocab = vocab;
  }

  static async load(modelUrl: string, vocabUrl: string): Promise<NanoGptOnnx> {
    const [session, vocabResp] = await Promise.all([
      ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] }),
      fetch(vocabUrl),
    ]);
    if (!vocabResp.ok) throw new Error(`Failed to fetch vocab: ${vocabResp.status}`);
    const vocab = (await vocabResp.json()) as Vocab;
    return new NanoGptOnnx(session, vocab);
  }

  /** Create from an already-downloaded model buffer (lets callers show download progress). */
  static async fromBuffer(modelBytes: Uint8Array, vocab: Vocab): Promise<NanoGptOnnx> {
    // Own ArrayBuffer slice — ORT is picky about shared byteOffset views from fetch.
    const ab = modelBytes.buffer.slice(
      modelBytes.byteOffset,
      modelBytes.byteOffset + modelBytes.byteLength,
    );
    const session = await ort.InferenceSession.create(ab, {
      executionProviders: ['wasm'],
    });
    return new NanoGptOnnx(session, vocab);
  }

  tokenize(text: string): number[] {
    return tokenize(text, this.vocab);
  }

  detokenize(ids: number[]): string {
    return detokenize(ids, this.vocab);
  }

  /** Logits over the vocab for the next token after tokenIds. */
  async nextTokenLogits(tokenIds: number[]): Promise<Float32Array> {
    const input = new ort.Tensor(
      'int64',
      BigInt64Array.from(tokenIds.map((v) => BigInt(v))),
      [1, tokenIds.length],
    );
    const out = await this.session.run({ idx: input });
    return out.logits.data as Float32Array;
  }

  /**
   * Pruned move distribution matching the server turbo path
   * (get_move_probabilities_from_logits): char-level temperature, 0.1% pruning.
   * `context` must be a fully preprocessed model context (see buildEngineContext).
   */
  async getTurboMoveProbs(context: string, legalMoves: string[], temperature: number): Promise<Record<string, number>> {
    return computePrunedMoveProbs(
      (ids) => this.nextTokenLogits(ids),
      this.vocab,
      context,
      legalMoves,
      temperature,
    );
  }

  /**
   * Full server-parity turbo move: pruned probs -> top_p/min_p filters -> sample
   * proportional to the (already temperature-shaped) distribution. Falls back to
   * a uniform random legal move if everything was pruned, like the server does.
   */
  async getTurboMove(
    context: string,
    legalMoves: string[],
    opts: { temperature: number; topP?: number; minP?: number; rng?: () => number },
  ): Promise<TurboMoveResult> {
    if (legalMoves.length === 0) throw new Error('No legal moves');
    const rng = opts.rng ?? Math.random;
    let probs = await this.getTurboMoveProbs(context, legalMoves, opts.temperature);
    const total = Object.values(probs).reduce((a, b) => a + b, 0);

    let san: string;
    let fallback = false;
    if (total <= 0) {
      fallback = true;
      san = legalMoves[Math.min(legalMoves.length - 1, Math.floor(rng() * legalMoves.length))];
    } else {
      probs = applyDistFilters(probs, opts.topP, opts.minP);
      san = sampleFromDist(probs, rng);
    }
    const probabilities = Object.entries(probs)
      .sort((a, b) => b[1] - a[1])
      .map(([move, prob]) => ({ move, prob }));
    return { san, prob: probs[san] ?? 0, probabilities, fallback };
  }

  /**
   * P(move | position) for each legal SAN, normalized over legal moves.
   * P(move) = prod over chars of (san + ' ') of P(char | prefix).
   */
  async getMoveProbabilities(pgn: string, legalMoves: string[]): Promise<Record<string, number>> {
    const context = preprocessPgn(pgn);
    const baseIds = this.tokenize(context);
    const probCache = new Map<string, Float32Array>();

    const probsAfter = async (suffix: string): Promise<Float32Array> => {
      const cached = probCache.get(suffix);
      if (cached) return cached;
      const logits = await this.nextTokenLogits(baseIds.concat(this.tokenize(suffix)));
      const probs = softmax(logits);
      probCache.set(suffix, probs);
      return probs;
    };

    const raw: Record<string, number> = {};
    for (const san of legalMoves) {
      let p = 1;
      let prefix = '';
      for (const ch of san + ' ') {
        const id = this.vocab.stoi[ch];
        if (id === undefined) { p = 0; break; }
        const probs = await probsAfter(prefix);
        p *= probs[id];
        if (p === 0) break;
        prefix += ch;
      }
      raw[san] = p;
    }

    let total = 0;
    for (const san of legalMoves) total += raw[san];
    const out: Record<string, number> = {};
    for (const san of legalMoves) {
      out[san] = total > 0 ? raw[san] / total : 1 / legalMoves.length;
    }
    return out;
  }

  /** Sample a legal move with temperature / top-p / min-p over the move distribution. */
  async getMove(pgn: string, legalMoves: string[], opts: SampleOpts = {}): Promise<MoveResult> {
    if (legalMoves.length === 0) throw new Error('No legal moves');
    const { temperature = 1.0, topP, minP } = opts;
    const probs = await this.getMoveProbabilities(pgn, legalMoves);

    let entries = legalMoves.map((san) => ({ san, p: probs[san] }));

    if (minP !== undefined && minP > 0) {
      const kept = entries.filter((e) => e.p >= minP);
      if (kept.length > 0) entries = kept;
    }

    let weights: number[];
    if (temperature < 0.001) {
      const best = entries.reduce((a, b) => (b.p > a.p ? b : a));
      weights = entries.map((e) => (e === best ? 1 : 0));
    } else {
      weights = entries.map((e) => (e.p > 0 ? Math.pow(e.p, 1 / temperature) : 0));
    }

    if (topP !== undefined && topP < 1.0) {
      const order = entries.map((_, i) => i).sort((a, b) => weights[b] - weights[a]);
      const wSum = weights.reduce((a, b) => a + b, 0) || 1;
      let cum = 0;
      const keep = new Set<number>();
      for (const i of order) {
        keep.add(i);
        cum += weights[i] / wSum;
        if (cum >= topP) break;
      }
      weights = weights.map((w, i) => (keep.has(i) ? w : 0));
    }

    let total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) {
      weights = entries.map(() => 1);
      total = entries.length;
    }

    let r = Math.random() * total;
    let chosen = entries[entries.length - 1];
    for (let i = 0; i < entries.length; i++) {
      r -= weights[i];
      if (r <= 0) { chosen = entries[i]; break; }
    }

    const alternatives: Record<string, number> = {};
    for (const san of legalMoves) {
      if (san !== chosen.san) alternatives[san] = probs[san];
    }
    return { san: chosen.san, prob: probs[chosen.san], alternatives };
  }
}
