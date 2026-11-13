import * as ort from 'onnxruntime-web'
import { fetchAsset, type ModelManifest } from './assetCache'
import { NanoGptOnnx, buildEngineContext, computePrunedMoveProbs, tokenize, type Vocab } from './nanogptOnnx'
import { NanoGptKv } from './nanogptKv'
import { LogitCache, exactMoveProbs } from './scoring'
import { BrowserLogitStore } from './logitStore'

ort.env.wasm.numThreads = 1
export interface InferRequest {
  id: number; type: 'infer'; pgn: string; whiteToMove: boolean; fullmove: number
  legal: string[]; temperature: number; exact: boolean
}
interface LoadRequest { type: 'load'; model: 'stockfish' | 'lichess'; kv: boolean }
let vocab: Vocab
let cache: LogitCache
let kvEngine: NanoGptKv | undefined
let queue = Promise.resolve()

async function load(req: LoadRequest) {
  const response = await fetch(`${import.meta.env.BASE_URL}models/manifest.json`, { cache: 'no-cache' })
  if (!response.ok) throw new Error('Model manifest unavailable')
  const manifest = await response.json() as ModelManifest
  const key: keyof ModelManifest = req.kv ? (req.model === 'stockfish' ? 'stockfishKv' : 'lichessKv') : req.model
  const model = manifest[key]
  const bytes = await fetchAsset(model, (loaded, total, cached) => {
    self.postMessage({ type: 'progress', model: req.model, loaded, total, cached })
  })
  vocab = JSON.parse(new TextDecoder().decode(await fetchAsset(manifest.vocab))) as Vocab
  if (Object.keys(vocab.stoi).length !== 32) throw new Error('Expected native 32-character chess vocabulary')
  self.postMessage({ type: 'initializing', model: req.model })
  const engine = req.kv ? await NanoGptKv.fromBuffer(bytes, vocab) : await NanoGptOnnx.fromBuffer(bytes, vocab)
  if (engine instanceof NanoGptKv) kvEngine = engine
  const namespace = `${model.sha256}:${manifest.vocab.sha256}:${req.kv ? 'kv' : 'stateless'}`
  cache = new LogitCache(ids => engine.nextTokenLogits(ids), 2048, new BrowserLogitStore(namespace))
  self.postMessage({ type: 'ready', model: req.model })
}

async function infer(req: InferRequest) {
  if (!cache) throw new Error('Model not loaded')
  const context = buildEngineContext(req.pgn, req.whiteToMove, req.fullmove)
  const ids = tokenize(context, vocab)
  // Stateless cropping resets learned positions. Keep the full stateless path
  // as default; the opt-in KV export commits the same 1024-character window.
  if (kvEngine) await kvEngine.setContext(ids.slice(-1024))
  const start = performance.now()
  const forwards = cache.forwards
  const hits = cache.hits
  const probs = await (req.exact ? exactMoveProbs : computePrunedMoveProbs)(
    input => cache.get(input), vocab, context, req.legal, req.temperature,
  )
  self.postMessage({ type: 'result', id: req.id, probs,
    inferenceMs: performance.now() - start, forwards: cache.forwards - forwards, hits: cache.hits - hits })
}

self.onmessage = (event: MessageEvent<LoadRequest | InferRequest>) => {
  const req = event.data
  queue = queue.then(async () => {
    try { if (req.type === 'load') await load(req); else await infer(req) }
    catch (error) { self.postMessage({ type: 'error', id: req.type === 'infer' ? req.id : undefined,
      message: error instanceof Error ? error.message : String(error) }) }
  })
}
