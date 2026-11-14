/** Local, side-to-move UCI MultiPV. Each search owns stop/bestmove/readyok. */
import { Chess } from 'chess.js'

export const MULTIPV_ENGINE_HASH = '723fda70117bfa8d5053a7bc4ae50cdc96dc9e3fd41b57627e4dfa0a0025957a'
const STORAGE_KEY = 'queen-coach.multipv.v1'
export interface MultiPvLine { rank: number; cp?: number; mate?: number; pv: string[] }
export interface MultiPvResult { fen: string; lines: MultiPvLine[]; depth: number; nodes?: number; timeMs: number }
export interface MultiPvOptions { count?: number; depth?: number; movetimeMs?: number; signal?: AbortSignal }
const cancelled = () => new DOMException('Stockfish MultiPV cancelled', 'AbortError')
const clone = (r: MultiPvResult): MultiPvResult => ({ ...r, lines: r.lines.map(l => ({ ...l, pv: [...l.pv] })) })

/** Buckets never combine ranks from different search depths. Bounds are ignored. */
export class CompletedMultiPv {
  private depths = new Map<number, Map<number, MultiPvLine>>()
  private metrics = new Map<number, number>()
  constructor(private count: number) {}
  accept(text: string): void {
    if (!text.startsWith('info ') || /\b(?:lowerbound|upperbound)\b/.test(text)) return
    const depth = Number(text.match(/\bdepth (\d+)/)?.[1])
    const rank = Number(text.match(/\bmultipv (\d+)/)?.[1] ?? 1)
    const score = text.match(/\bscore (cp|mate) (-?\d+)/)
    const pv = text.match(/\bpv (.+)$/)?.[1].trim().split(/\s+/)
    if (!Number.isInteger(depth) || depth < 1 || rank < 1 || rank > this.count || !score || !pv?.length || pv.length > 256 || pv.some(m => !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m))) return
    const bucket = this.depths.get(depth) ?? new Map<number, MultiPvLine>()
    bucket.set(rank, { rank, ...(score[1] === 'cp' ? { cp: Number(score[2]) } : { mate: Number(score[2]) }), pv })
    this.depths.set(depth, bucket)
    const nodes = text.match(/\bnodes (\d+)/)?.[1]
    if (nodes) this.metrics.set(depth, Number(nodes))
  }
  completed(fen?: string): { lines: MultiPvLine[]; depth: number; nodes?: number } | undefined {
    for (const depth of [...this.depths.keys()].sort((a, b) => b - a)) {
      const bucket = this.depths.get(depth)!
      const lines = Array.from({ length: this.count }, (_, i) => bucket.get(i + 1))
      if (lines.every((line): line is MultiPvLine => Boolean(line))) {
        const result = { depth, lines: lines.map(l => ({ ...l, pv: [...l.pv] })), nodes: this.metrics.get(depth) }
        // A stop can leave a partly replaced set of ranks at the last depth.
        // Select a complete, legal set from a shallower depth when needed.
        if (new Set(result.lines.map(line => line.pv[0])).size !== this.count) continue
        if (fen && !validResult({ fen, ...result, timeMs: 0 })) continue
        return result
      }
    }
  }
}

function validResult(value: unknown): value is MultiPvResult {
  if (!value || typeof value !== 'object') return false
  const r = value as MultiPvResult
  if (typeof r.fen !== 'string' || r.fen.split(' ').length !== 6 || !Number.isInteger(r.depth) || r.depth < 1 || !Number.isFinite(r.timeMs) || r.timeMs < 0 || !Array.isArray(r.lines) || r.lines.length < 1 || r.lines.length > 3) return false
  try {
    for (const [i, line] of r.lines.entries()) {
      if (line.rank !== i + 1 || (line.cp === undefined) === (line.mate === undefined) || !Number.isFinite(line.cp ?? line.mate) || !Array.isArray(line.pv) || !line.pv.length || line.pv.length > 256) return false
      const board = new Chess(r.fen)
      for (const uci of line.pv) {
        if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return false
        board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
      }
    }
    return new Set(r.lines.map(l => l.pv[0])).size === r.lines.length
  } catch { return false }
}

/** Persisted LRU: all six original FEN fields + engine hash + all budgets. */
export class MultiPvCache {
  private entries = new Map<string, MultiPvResult>()
  constructor(private storage?: Pick<Storage, 'getItem' | 'setItem'>) {
    try {
      const raw = storage?.getItem(STORAGE_KEY)
      if (!raw || raw.length > 256_000) return
      const saved = JSON.parse(raw)
      if (saved.engine !== MULTIPV_ENGINE_HASH || !Array.isArray(saved.entries)) return
      for (const entry of saved.entries.slice(-64))
        if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[0].length < 2000 && validResult(entry[1])) this.entries.set(entry[0], clone(entry[1]))
    } catch { /* Optional, corrupt or unavailable storage is a miss. */ }
  }
  get(key: string): MultiPvResult | undefined {
    const r = this.entries.get(key)
    if (!r) return
    this.entries.delete(key); this.entries.set(key, r)
    return clone(r)
  }
  set(key: string, result: MultiPvResult): void {
    if (!validResult(result)) return
    this.entries.delete(key); this.entries.set(key, clone(result))
    const encoded = () => JSON.stringify({ engine: MULTIPV_ENGINE_HASH, entries: [...this.entries] })
    while (this.entries.size && (this.entries.size > 64 || encoded().length > 256_000)) this.entries.delete(this.entries.keys().next().value!)
    try { this.storage?.setItem(STORAGE_KEY, encoded()) } catch { /* memory only */ }
  }
}
export function multiPvCacheKey(fen: string, count: number, depth: number, movetimeMs: number): string {
  return JSON.stringify([MULTIPV_ENGINE_HASH, fen, count, depth, movetimeMs])
}

/** Separate worker from the parent's single-PV graph, one bounded queue. */
export class MultiPvEngine {
  private worker: Worker
  private queue: Promise<void> = Promise.resolve()
  private ready: Promise<void>
  private listeners = new Set<(line: string) => void>()
  private waiters = new Set<(error: Error) => void>()
  private failure?: Error
  constructor(options: { workerFactory?: (url: string) => Worker; cache?: MultiPvCache; timeoutMs?: number } = {}) {
    this.cache = options.cache ?? new MultiPvCache()
    this.timeoutMs = options.timeoutMs ?? 15_000
    const url = new URL(`${import.meta.env.BASE_URL}stockfish/stockfish.js`, globalThis.location?.href ?? 'http://localhost/')
    if (url.origin !== new URL(globalThis.location?.href ?? 'http://localhost/').origin) throw new Error('Stockfish must be same-origin')
    this.worker = (options.workerFactory ?? (path => new Worker(path, { name: 'queen-coach-multipv' })))(url.href)
    this.worker.onmessage = e => {
      if (typeof e.data !== 'string' || this.failure) return
      for (const line of e.data.split(/\r?\n/)) for (const consume of [...this.listeners]) consume(line.trim())
    }
    this.worker.onerror = () => this.fail(new Error('Stockfish MultiPV worker failed'))
    this.worker.onmessageerror = () => this.fail(new Error('Stockfish MultiPV worker message failed'))
    this.ready = this.exchange('uci', line => line === 'uciok').then(async () => {
      this.post('setoption name Hash value 16')
      await this.exchange('isready', line => line === 'readyok')
    })
    void this.ready.catch(() => undefined)
  }
  private cache: MultiPvCache
  private timeoutMs: number
  private post(command: string): void { if (this.failure) throw this.failure; this.worker.postMessage(command) }
  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error; this.worker.terminate()
    for (const reject of [...this.waiters]) reject(error)
    this.listeners.clear()
  }
  private exchange(command: string, consume: (line: string) => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.failure) { reject(this.failure); return }
      const cleanup = () => { clearTimeout(timer); this.listeners.delete(listener); this.waiters.delete(failed) }
      const failed = (error: Error) => { cleanup(); reject(error) }
      const listener = (line: string) => {
        try { if (consume(line)) { cleanup(); resolve() } }
        catch (e) { this.fail(e instanceof Error ? e : new Error(String(e))) }
      }
      const timer = setTimeout(() => this.fail(new Error('Stockfish MultiPV timed out; worker terminated before queue advance')), this.timeoutMs)
      this.listeners.add(listener); this.waiters.add(failed)
      try { this.post(command) } catch (e) { this.fail(e instanceof Error ? e : new Error(String(e))) }
    })
  }
  analyze(fen: string, options: MultiPvOptions = {}): Promise<MultiPvResult> {
    if (options.signal?.aborted) return Promise.reject(cancelled())
    let game: Chess
    const fullFen = fen.trim().replace(/ +/g, ' ')
    try {
      if (fullFen.split(' ').length !== 6 || /[\r\n\t]/.test(fullFen)) throw new Error('Expected all six FEN fields')
      game = new Chess(fullFen)
    } catch (e) { return Promise.reject(e) }
    const count = options.count ?? 3, depth = options.depth ?? 10, time = options.movetimeMs ?? 150
    if (![count, depth, time].every(Number.isInteger) || count < 1 || count > 3 || depth < 1 || depth > 32 || time < 1 || time > 5000) return Promise.reject(new Error('Use count 1–3, depth 1–32 and movetimeMs 1–5000'))
    if (game.isGameOver()) return Promise.resolve({ fen: fullFen, lines: [], depth: 0, timeMs: 0 })
    const wanted = Math.min(count, game.moves().length)
    const key = multiPvCacheKey(fullFen, count, depth, time)
    return new Promise((resolve, reject) => {
      let aborted = false, searching = false
      const abort = () => {
        aborted = true; reject(cancelled())
        if (searching && !this.failure) { try { this.post('stop') } catch (e) { this.fail(e as Error) } }
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) abort()
      const run = async () => {
        try {
          if (aborted) return
          await this.ready
          if (this.failure) throw this.failure
          if (aborted) return
          const cached = this.cache.get(key)
          if (cached && cached.lines.length === wanted && cached.fen === fullFen) { resolve(cached); return }
          this.post('ucinewgame'); this.post(`setoption name MultiPV value ${wanted}`)
          await this.exchange('isready', l => l === 'readyok')
          if (aborted) return
          this.post(`position fen ${fullFen}`)
          const collector = new CompletedMultiPv(wanted)
          const start = performance.now()
          searching = true
          await this.exchange(`go depth ${depth} movetime ${time}`, line => {
            collector.accept(line)
            return line.startsWith('bestmove ')
          })
          searching = false
          // Even cancellation must drain bestmove AND readyok before next go.
          await this.exchange('isready', l => l === 'readyok')
          if (aborted) return
          const completed = collector.completed(fullFen)
          if (!completed) throw new Error(`Stockfish did not complete a shared depth for ${wanted} lines; no mixed-depth scores were returned`)
          const result: MultiPvResult = { fen: fullFen, ...completed, timeMs: Math.round(performance.now() - start) }
          if (!validResult(result)) throw new Error('Stockfish returned an illegal or invalid MultiPV result')
          this.cache.set(key, result); resolve(clone(result))
        } catch (e) { reject(e) }
        finally { options.signal?.removeEventListener('abort', abort) }
      }
      const work = this.queue.then(run)
      this.queue = work.then(() => undefined, () => undefined)
    })
  }
  dispose(): void { this.fail(new Error('Stockfish MultiPV disposed')) }
}

let singleton: MultiPvEngine | undefined
export function analyzeMultiPv(fen: string, options?: MultiPvOptions): Promise<MultiPvResult> {
  try {
    if (!singleton) {
      let storage: Storage | undefined
      try { storage = globalThis.localStorage } catch { /* private mode */ }
      singleton = new MultiPvEngine({ cache: new MultiPvCache(storage) })
    }
    return singleton.analyze(fen, options)
  } catch (e) { return Promise.reject(e) }
}
