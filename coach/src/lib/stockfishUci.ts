/** Same-origin UCI engine, recovered from the original ChessLLM dev source.
 * Scores retain UCI's SIDE-TO-MOVE perspective; use whiteScore/formatEval for UI.
 * One queue owns each entire search, including its bestmove and ready barrier.
 */
import { Chess } from 'chess.js'

export const STOCKFISH_ENGINE_VERSION = 'stockfish.js:723fda70117bfa8d5053a7bc4ae50cdc96dc9e3fd41b57627e4dfa0a0025957a'
export const EVAL_CACHE_STORAGE_KEY = 'chessllm.stockfish.evals.v1'
const CACHE_SCHEMA = 1
const DEFAULT_WORKER = `${import.meta.env.BASE_URL}stockfish/stockfish.js`

export interface StockfishEval {
  bestmove: string
  ponder?: string
  pv: string[]
  scoreCp?: number
  scoreMate?: number
  depth: number
  nodes?: number
  timeMs: number
  terminal?: 'checkmate' | 'stalemate'
  winner?: 'w' | 'b'
}

export interface StockfishEngine {
  readonly ready: boolean
  /** Stops at depth or movetime, whichever comes first. Optional signal cancels only this job. */
  analyze(fen: string, depth?: number, movetimeMs?: number, signal?: AbortSignal): Promise<StockfishEval>
  dispose(): void
}

function clone(result: StockfishEval): StockfishEval { return { ...result, pv: [...result.pv] } }
function abortError(message = 'Stockfish analysis cancelled'): Error {
  return new DOMException(message, 'AbortError')
}
function validEval(value: unknown): value is StockfishEval {
  if (!value || typeof value !== 'object') return false
  const e = value as StockfishEval
  return typeof e.bestmove === 'string' && /^(?:[a-h][1-8][a-h][1-8][qrbn]?|\(none\))$/.test(e.bestmove)
    && Array.isArray(e.pv) && e.pv.length <= 256 && e.pv.every(m => typeof m === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m))
    && Number.isInteger(e.depth) && e.depth >= 0 && e.depth <= 256
    && Number.isFinite(e.timeMs) && e.timeMs >= 0
    && (e.nodes === undefined || (Number.isFinite(e.nodes) && e.nodes >= 0))
    && (e.scoreCp === undefined || Number.isFinite(e.scoreCp))
    && (e.scoreMate === undefined || Number.isInteger(e.scoreMate))
    && !(e.scoreCp !== undefined && e.scoreMate !== undefined)
    && (e.terminal === undefined || e.terminal === 'checkmate' || e.terminal === 'stalemate')
    && (e.winner === undefined || e.winner === 'w' || e.winner === 'b')
}

export function stockfishCacheKey(fen: string, depth = 12, movetimeMs?: number, engineVersion = STOCKFISH_ENGINE_VERSION): string {
  // Keep all six fields, including EP square, halfmove clock and move number.
  return JSON.stringify([CACHE_SCHEMA, engineVersion, fen.trim().replace(/ +/g, ' '), depth, movetimeMs ?? null])
}

/** Bounded persistent LRU. Storage failures/private mode fall back to memory. */
export class StockfishEvalCache {
  private entries = new Map<string, StockfishEval>()
  private storage?: Pick<Storage, 'getItem' | 'setItem'>
  private maxEntries: number
  private maxBytes: number

  constructor(options: { storage?: Pick<Storage, 'getItem' | 'setItem'>; maxEntries?: number; maxBytes?: number } = {}) {
    this.storage = options.storage
    this.maxEntries = Math.max(1, options.maxEntries ?? 256)
    this.maxBytes = Math.max(256, options.maxBytes ?? 512 * 1024)
    try {
      const raw = this.storage?.getItem(EVAL_CACHE_STORAGE_KEY)
      if (!raw || raw.length > this.maxBytes) return
      const saved = JSON.parse(raw)
      if (saved.schema !== CACHE_SCHEMA || !Array.isArray(saved.entries)) return
      for (const entry of saved.entries) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[0].length <= 2048 && validEval(entry[1])) {
          this.entries.set(entry[0], clone(entry[1]))
        }
      }
      this.trim()
    } catch { /* Corrupt/disabled storage is a cache miss. */ }
  }

  private serialize(): string { return JSON.stringify({ schema: CACHE_SCHEMA, entries: [...this.entries] }) }
  private trim(): void {
    while (this.entries.size && (this.entries.size > this.maxEntries || this.serialize().length > this.maxBytes)) {
      this.entries.delete(this.entries.keys().next().value!)
    }
  }
  private persist(): void {
    try { this.storage?.setItem(EVAL_CACHE_STORAGE_KEY, this.serialize()) } catch { /* Optional storage. */ }
  }
  get(key: string): StockfishEval | undefined {
    const value = this.entries.get(key)
    if (!value) return undefined
    this.entries.delete(key)
    this.entries.set(key, value)
    this.persist()
    return clone(value)
  }
  peek(key: string): StockfishEval | undefined {
    const value = this.entries.get(key)
    return value ? clone(value) : undefined
  }
  set(key: string, value: StockfishEval): void {
    if (key.length > 2048 || !validEval(value)) return
    this.entries.delete(key)
    this.entries.set(key, clone(value))
    this.trim()
    this.persist()
  }
}

function browserCache(): StockfishEvalCache {
  try { return new StockfishEvalCache({ storage: globalThis.localStorage }) }
  catch { return new StockfishEvalCache() }
}
const evaluationCache = browserCache()
/** Reads only an exact measured result, never a nearby FEN or different limit. */
export function getCachedStockfishEval(fen: string, depth = 12, movetimeMs?: number): StockfishEval | undefined {
  return evaluationCache.peek(stockfishCacheKey(fen, depth, movetimeMs))
}

type Job = { cancelled: boolean; searching: boolean; reject: (error: Error) => void }
type EngineOptions = {
  workerUrl?: string
  workerFactory?: (url: string) => Worker
  cache?: StockfishEvalCache
  timeoutMs?: number
}

export class StockfishUci implements StockfishEngine {
  ready = false
  private worker: Worker
  private queue: Promise<void> = Promise.resolve()
  private listeners = new Set<(line: string) => void>()
  private waiters = new Set<(error: Error) => void>()
  private jobs = new Set<Job>()
  private failure?: Error
  private cache: StockfishEvalCache
  private timeoutMs: number

  private constructor(worker: Worker, options: EngineOptions) {
    this.worker = worker
    this.cache = options.cache ?? evaluationCache
    this.timeoutMs = options.timeoutMs ?? 30_000
    worker.onmessage = event => {
      if (this.failure || typeof event.data !== 'string') return
      for (const line of event.data.split(/\r?\n/)) {
        for (const listener of [...this.listeners]) listener(line.trim())
      }
    }
    worker.onerror = () => this.fail(new Error('Stockfish worker failed to load or crashed'))
    worker.onmessageerror = () => this.fail(new Error('Stockfish worker sent an unreadable message'))
  }

  static async create(options: EngineOptions = {}): Promise<StockfishUci> {
    const base = globalThis.location?.href ?? 'http://localhost/'
    const url = new URL(options.workerUrl ?? DEFAULT_WORKER, base)
    if (url.origin !== new URL(base).origin) throw new Error('Stockfish worker must be same-origin')
    const engine = new StockfishUci((options.workerFactory ?? (url => new Worker(url, { name: 'chessllm-stockfish' })))(url.href), options)
    try {
      await engine.exchange('uci', line => line === 'uciok')
      engine.post('setoption name Hash value 16')
      engine.post('setoption name MultiPV value 1')
      await engine.exchange('isready', line => line === 'readyok')
      engine.ready = true
      return engine
    } catch (error) {
      engine.fail(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    this.ready = false
    this.worker.terminate()
    for (const reject of [...this.waiters]) reject(error)
    for (const job of this.jobs) job.reject(error)
    this.listeners.clear()
    this.jobs.clear()
  }
  private post(command: string): void {
    if (this.failure) throw this.failure
    this.worker.postMessage(command)
  }
  private exchange(command: string, consume: (line: string) => boolean, timeoutMs = this.timeoutMs): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.failure) { reject(this.failure); return }
      const cleanup = () => {
        clearTimeout(timer)
        this.listeners.delete(listener)
        this.waiters.delete(failed)
      }
      const failed = (error: Error) => { cleanup(); reject(error) }
      const listener = (line: string) => {
        try { if (consume(line)) { cleanup(); resolve() } }
        catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
      }
      const timer = setTimeout(() => this.fail(new Error(`Stockfish timed out: ${command}`)), timeoutMs)
      this.waiters.add(failed)
      this.listeners.add(listener)
      try { this.post(command) } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
    })
  }

  analyze(fen: string, depth = 12, movetimeMs?: number, signal?: AbortSignal): Promise<StockfishEval> {
    if (this.failure || !this.ready) return Promise.reject(this.failure ?? new Error('Stockfish is not ready'))
    if (signal?.aborted) return Promise.reject(abortError())
    if (!Number.isInteger(depth) || depth < 1 || depth > 64
      || (movetimeMs !== undefined && (!Number.isInteger(movetimeMs) || movetimeMs < 1 || movetimeMs > 60_000))) {
      return Promise.reject(new Error('Use depth 1–64 and optional movetime 1–60000 ms'))
    }
    let game: Chess
    const fullFen = fen.trim().replace(/ +/g, ' ')
    try {
      if (fullFen.split(' ').length !== 6 || /[\r\n\t]/.test(fullFen)) throw new Error('Expected a complete six-field FEN')
      game = new Chess(fullFen)
    } catch (error) { return Promise.reject(error) }
    const key = stockfishCacheKey(fullFen, depth, movetimeMs)

    return new Promise((resolve, reject) => {
      const job: Job = { cancelled: false, searching: false, reject }
      this.jobs.add(job)
      const cancel = () => {
        job.cancelled = true
        reject(abortError())
        // Drain the corresponding bestmove before letting another search start.
        if (job.searching && !this.failure) {
          try { this.post('stop') } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
        }
      }
      signal?.addEventListener('abort', cancel, { once: true })
      const run = async () => {
        try {
          if (this.failure) throw this.failure
          if (job.cancelled) return
          const cached = this.cache.get(key)
          if (cached) { resolve(cached); return }
          // UCI mate 0 alone cannot encode the winner. Derive terminal outcomes
          // from legal chess rules, not an absent bestmove or a material guess.
          if (game.isCheckmate() || game.isStalemate()) {
            const mate = game.isCheckmate()
            const result: StockfishEval = { bestmove: '(none)', pv: [], depth: 0, timeMs: 0,
              ...(mate ? { scoreMate: 0, terminal: 'checkmate' as const, winner: game.turn() === 'w' ? 'b' as const : 'w' as const }
                : { scoreCp: 0, terminal: 'stalemate' as const }) }
            this.cache.set(key, result)
            resolve(clone(result))
            return
          }
          this.post('ucinewgame')
          await this.exchange('isready', line => line === 'readyok')
          if (job.cancelled) return
          this.post(`position fen ${fullFen}`)
          let result: StockfishEval = { bestmove: '', pv: [], depth: 0, timeMs: 0 }
          const started = performance.now()
          job.searching = true
          await this.exchange(`go depth ${depth}${movetimeMs === undefined ? '' : ` movetime ${movetimeMs}`}`, line => {
            if (line.startsWith('info ')) {
              const multipv = line.match(/\bmultipv (\d+)/)
              if (multipv && Number(multipv[1]) !== 1) return false
              const nodes = line.match(/\bnodes (\d+)/)
              if (nodes) result.nodes = Number(nodes[1])
              const score = line.match(/\bscore (cp|mate) (-?\d+)/)
              // Bounds are not exact evaluations; don't overwrite a measured score.
              if (score && !/\b(?:lowerbound|upperbound)\b/.test(line)) {
                const seenDepth = Number(line.match(/\bdepth (\d+)/)?.[1] ?? 0)
                if (seenDepth >= result.depth) {
                  result = { ...result, depth: seenDepth,
                    scoreCp: score[1] === 'cp' ? Number(score[2]) : undefined,
                    scoreMate: score[1] === 'mate' ? Number(score[2]) : undefined,
                    pv: line.match(/\bpv (.+)$/)?.[1].trim().split(/\s+/).slice(0, 256) ?? [] }
                }
              }
            }
            if (!line.startsWith('bestmove ')) return false
            const parts = line.split(/\s+/)
            result.bestmove = parts[1]
            if (parts[2] === 'ponder') result.ponder = parts[3]
            return true
          }, Math.max(this.timeoutMs, (movetimeMs ?? 0) + 5000))
          job.searching = false
          result.timeMs = Math.round(performance.now() - started)
          // This barrier drains late info from a stopped/completed search.
          await this.exchange('isready', line => line === 'readyok')
          if (job.cancelled) return
          if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(result.bestmove)) throw new Error('Stockfish returned no legal move for a nonterminal position')
          try { game.move(result.bestmove) } catch { throw new Error('Stockfish returned an illegal best move') }
          // A cold/time-limited search may report only bestmove. Let the next
          // request try again rather than persistently caching an unmeasured eval.
          if (result.scoreCp !== undefined || result.scoreMate !== undefined) this.cache.set(key, result)
          resolve(clone(result))
        } catch (error) { reject(error) }
        finally { signal?.removeEventListener('abort', cancel); this.jobs.delete(job) }
      }
      const work = this.queue.then(run)
      this.queue = work.then(() => undefined, () => undefined)
    })
  }

  dispose(): void { this.fail(abortError('Stockfish engine disposed')) }
}

let singleton: StockfishUci | undefined
let loading: Promise<StockfishUci> | undefined
export function getStockfishEngine(): Promise<StockfishEngine> {
  if (singleton?.ready) return Promise.resolve(singleton)
  if (!loading) {
    loading = StockfishUci.create().then(engine => { singleton = engine; return engine }).finally(() => { loading = undefined })
  }
  return loading
}

/** White-relative score for graph/bar; mate uses an endpoint, not invented cp. */
export function whiteScore(result: StockfishEval, whiteToMove: boolean): number | undefined {
  if (result.terminal === 'checkmate') return result.winner === 'w' ? Infinity : -Infinity
  if (result.scoreMate !== undefined) {
    const mate = (whiteToMove ? 1 : -1) * result.scoreMate
    return mate > 0 ? Infinity : mate < 0 ? -Infinity : (whiteToMove ? -Infinity : Infinity)
  }
  return result.scoreCp === undefined ? undefined : (whiteToMove ? 1 : -1) * result.scoreCp
}

export function formatEval(result: StockfishEval, whiteToMove: boolean): string {
  if (result.terminal === 'checkmate') return result.winner === 'w' ? '1–0 · Checkmate' : '0–1 · Checkmate'
  if (result.terminal === 'stalemate') return '½–½ · Stalemate'
  if (result.scoreMate !== undefined) {
    const mate = (whiteToMove ? 1 : -1) * result.scoreMate
    return mate > 0 ? `M${mate}` : `−M${Math.abs(mate)}`
  }
  const cp = whiteScore(result, whiteToMove)
  return cp === undefined ? 'Unmeasured' : `${cp >= 0 ? '+' : ''}${(cp / 100).toFixed(2)}`
}
