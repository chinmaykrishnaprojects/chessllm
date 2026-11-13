import { Chess } from 'chess.js'
import WorkerFactory from './recoveryWorker?worker'
import { applyDistFilters, sampleFromDist } from './sampling'
import type { InferRequest } from './recoveryWorker'

type Model = 'stockfish' | 'lichess'
type ProbMap = Record<string, number>
interface InferenceResult { probs: ProbMap; inferenceMs: number; forwards: number; hits: number }
export interface EngineStatus { text: string; error: boolean }
let status: EngineStatus = { text: 'Browser engine · models download on first use', error: false }
const listeners = new Set<() => void>()
export const subscribeStatus = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const getEngineStatus = () => status
function report(text: string, error = false) { status = { text, error }; listeners.forEach(fn => fn()) }
const slots = new Map<Model, { worker: Worker; ready: Promise<void>; pending: Map<number, {
  resolve: (value: InferenceResult) => void; reject: (reason: Error) => void
}> }>()
let nextId = 0
export const diagnostics = { requests: 0, forwards: 0, hits: 0, inferenceMs: 0 }

function getSlot(model: Model) {
  const existing = slots.get(model)
  if (existing) return existing
  const worker = new WorkerFactory()
  const pending = new Map<number, { resolve: (value: InferenceResult) => void; reject: (reason: Error) => void }>()
  let resolveLoad: () => void
  let rejectLoad: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { resolveLoad = resolve; rejectLoad = reject })
  const slot = { worker, ready, pending }
  const fail = (error: Error) => {
    report(error.message, true)
    rejectLoad(error)
    for (const req of pending.values()) req.reject(error)
    pending.clear()
    worker.terminate()
    slots.delete(model)
  }
  worker.onerror = event => fail(new Error(event.message || 'Browser engine failed'))
  worker.onmessage = event => {
    const msg = event.data
    if (msg.type === 'progress') report(`${model} · ${msg.cached ? 'cached' : 'downloading'} ${(msg.loaded / 1e6).toFixed(1)} / ${(msg.total / 1e6).toFixed(1)} MB`)
    if (msg.type === 'initializing') report(`${model} · starting browser engine`)
    if (msg.type === 'ready') { resolveLoad(); report(`${model} · browser engine ready`) }
    if (msg.type === 'error') {
      const error = new Error(msg.message)
      if (msg.id === undefined) fail(error)
      else { pending.get(msg.id)?.reject(error); pending.delete(msg.id); report(error.message, true) }
    }
    if (msg.type === 'result') {
      diagnostics.forwards += msg.forwards
      diagnostics.hits += msg.hits
      diagnostics.inferenceMs = msg.inferenceMs
      report(`${model} · ${Math.round(msg.inferenceMs)} ms · ${msg.forwards === 0 ? 'cached position' : 'browser inference'}`)
      pending.get(msg.id)?.resolve({ probs: msg.probs, inferenceMs: msg.inferenceMs, forwards: msg.forwards, hits: msg.hits })
      pending.delete(msg.id)
    }
  }
  slots.set(model, slot)
  // KV remains an explicit opt-in until this recovery has browser long-game evidence.
  const kv = new URLSearchParams(location.search).get('kv') === '1'
  worker.postMessage({ type: 'load', model, kv })
  return slot
}

interface Body {
  fen?: string; pgn?: string; model?: string; temperature?: number; turbo?: boolean
  turbo_mode?: string; stochastic?: boolean; top_p?: number; top_k?: number; min_p?: number; move?: string; from_square?: string
}
async function infer(board: Chess, body: Body, exact: boolean, signal?: AbortSignal | null) {
  const model = body.model ?? 'stockfish'
  if (model !== 'stockfish' && model !== 'lichess') throw new Error(`Unknown model ${model}`)
  signal?.throwIfAborted()
  const slot = getSlot(model)
  // Race model loading too: stopping a match must not wait for a 51 MB download.
  await abortable(slot.ready, signal)
  signal?.throwIfAborted()
  const id = ++nextId
  diagnostics.requests++
  const request: InferRequest = { type: 'infer', id, pgn: body.pgn ?? '', whiteToMove: board.turn() === 'w',
    fullmove: board.moveNumber(), legal: board.moves(), temperature: body.temperature ?? 0.3, exact }
  const promise = new Promise<InferenceResult>((resolve, reject) => { slot.pending.set(id, { resolve, reject }); slot.worker.postMessage(request) })
  try { return await abortable(promise, signal) } finally { slot.pending.delete(id) }
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export async function chessFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const requestStarted = performance.now()
  const path = new URL(input, location.origin).pathname
  const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Body
  try {
    if (path === '/api/status') return Response.json({ status: 'ok', available_models: ['stockfish', 'lichess'] })
    let board = new Chess(body.fen)
    if (path === '/api/legal_moves') {
      const moves = board.moves({ verbose: true }).filter(m => !body.from_square || m.from === body.from_square)
      return Response.json({ success: true, moves: moves.map(m => ({ san: m.san, uci: m.lan, from_square: m.from, to_square: m.to })) })
    }
    if (path !== '/api/move' && path !== '/api/analyze') throw new Error(`Unsupported browser endpoint ${path}`)
    const replay = new Chess()
    if (body.pgn?.trim()) replay.loadPgn(body.pgn)
    if (replay.fen() !== board.fen()) throw new Error('ChessGPT needs PGN history matching this board. Stockfish can analyze a FEN directly.')
    board = replay
    if (board.isGameOver()) return Response.json({ success: true, game_over: true, probabilities: [] })
    const temperature = body.temperature ?? 0.3
    if (!Number.isFinite(temperature) || temperature < 0) throw new Error('Temperature must be nonnegative')
    const exact = path === '/api/analyze' || body.turbo === false
    const inference = await infer(board, body, exact, init.signal)
    let probs = inference.probs
    const entropy = (map: ProbMap) => -Object.values(map).reduce((n, p) => n + (p > 0 ? p * Math.log2(p) : 0), 0)
    const telemetry = { source_fen: board.fen(), source_pgn: body.pgn ?? '', model: body.model ?? 'stockfish',
      temperature, score_mode: exact ? 'exact' : 'pruned', model_entropy_bits: entropy(probs),
      inference_ms: inference.inferenceMs, model_forwards: inference.forwards, cache_hits: inference.hits }
    const probabilities = Object.entries(probs).sort((a, b) => b[1] - a[1]).map(([move, prob]) => {
      const candidate = new Chess(board.fen()).move(move)
      return { move, prob, san: move, probability: prob, from_square: candidate.from, to_square: candidate.to }
    })
    if (path === '/api/analyze') return Response.json({ success: true, probabilities, telemetry: { ...telemetry, request_ms: performance.now() - requestStarted } })
    // Cache only model outputs. Every request still samples a fresh move.
    const total = Object.values(probs).reduce((sum, p) => sum + p, 0)
    if (total <= 0) throw new Error('All moves were pruned; disable Turbo for exact scoring')
    if (body.top_k && body.top_k > 0) probs = Object.fromEntries(Object.entries(probs).sort((a, b) => b[1] - a[1]).slice(0, body.top_k))
    probs = applyDistFilters(probs, body.top_p ?? 0.9, body.min_p ?? 0.02)
    const san = temperature === 0 || body.stochastic === false
      ? Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0] : sampleFromDist(probs)
    const chosen = board.move(san)
    const samplingProbability = temperature === 0 || body.stochastic === false ? 1 : probs[san]
    return Response.json({ success: true, move_san: san, from_square: chosen.from, to_square: chosen.to, probabilities,
      sampling_probabilities: probs, illegal_moves: [], telemetry: { ...telemetry,
        model_probability: inference.probs[san], sampling_probability: samplingProbability,
        sampling_entropy_bits: temperature === 0 || body.stochastic === false ? 0 : entropy(probs),
        surprisal_bits: inference.probs[san] > 0 ? -Math.log2(inference.probs[san]) : null,
        request_ms: performance.now() - requestStarted } })
  } catch (error) {
    if (init.signal?.aborted) throw error
    const message = error instanceof Error ? error.message : String(error)
    report(message, true)
    return Response.json({ success: false, error: message }, { status: 503 })
  }
}
