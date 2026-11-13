import { afterEach, describe, expect, it, vi } from 'vitest'
import { Chess } from 'chess.js'
import { EVAL_CACHE_STORAGE_KEY, StockfishEvalCache, StockfishUci, formatEval, stockfishCacheKey, whiteScore } from './stockfishUci'
import type { StockfishEval } from './stockfishUci'

const START = new Chess().fen()
const board = new Chess()
board.move('e4')
const AFTER_E4 = board.fen()
const example: StockfishEval = { bestmove: 'e2e4', depth: 8, pv: ['e2e4'], scoreCp: 35, nodes: 123, timeMs: 20 }

class FakeWorker {
  onmessage: Worker['onmessage'] = null
  onerror: Worker['onerror'] = null
  onmessageerror: Worker['onmessageerror'] = null
  commands: string[] = []
  terminated = false
  postMessage(command: string) {
    this.commands.push(command)
    if (command === 'uci') queueMicrotask(() => this.emit('id name Fake Stockfish\nuciok'))
    if (command === 'isready') queueMicrotask(() => this.emit('readyok'))
  }
  emit(line: string) { this.onmessage?.call(this as unknown as Worker, { data: line } as MessageEvent) }
  terminate() { this.terminated = true }
}
class MemoryStorage {
  data = new Map<string, string>()
  getItem(key: string) { return this.data.get(key) ?? null }
  setItem(key: string, value: string) { this.data.set(key, value) }
}
const engines: StockfishUci[] = []
afterEach(() => { engines.splice(0).forEach(engine => engine.dispose()); vi.useRealTimers() })
async function setup(cache = new StockfishEvalCache(), timeoutMs = 30_000) {
  const worker = new FakeWorker()
  const engine = await StockfishUci.create({ workerFactory: () => worker as unknown as Worker, cache, timeoutMs })
  engines.push(engine)
  worker.commands = []
  return { worker, engine, cache }
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve() }
function finish(worker: FakeWorker, bestmove = 'e2e4', cp = 35) {
  worker.emit(`info depth 8 score cp ${cp} nodes 123 time 20 pv ${bestmove}\nbestmove ${bestmove}`)
}

describe('whole-search UCI serialization', () => {
  it('waits for bestmove and drains late info before positioning the next search', async () => {
    const { worker, engine } = await setup()
    const first = engine.analyze(START, 8)
    const second = engine.analyze(AFTER_E4, 8)
    await flush()
    expect(worker.commands).toEqual(['ucinewgame', 'isready', `position fen ${START}`, 'go depth 8'])
    finish(worker, 'e2e4', 42)
    worker.emit('info depth 99 score cp 9000 pv a1a8')
    expect((await first).scoreCp).toBe(42)
    await flush()
    expect(worker.commands).toEqual(['ucinewgame', 'isready', `position fen ${START}`, 'go depth 8', 'isready', 'ucinewgame', 'isready', `position fen ${AFTER_E4}`, 'go depth 8'])
    finish(worker, 'e7e5', -25)
    const result = await second
    expect(result.scoreCp).toBe(-25)
    expect(result.pv).toEqual(['e7e5'])
    expect(whiteScore(result, false)).toBe(25)
  })

  it('isolates info from readiness, alternate PV and bound scores', async () => {
    const { worker, engine } = await setup()
    worker.emit('info depth 44 score cp 999 pv a1a8')
    const pending = engine.analyze(START, 8, 500)
    await flush()
    expect(worker.commands.at(-1)).toBe('go depth 8 movetime 500')
    worker.emit('info depth 7 score cp 18 nodes 12 pv d2d4 d7d5')
    worker.emit('info depth 8 multipv 2 score cp 200 nodes 20 pv a2a3')
    worker.emit('info depth 8 score cp 80 lowerbound nodes 24 pv e2e4')
    worker.emit('bestmove d2d4 ponder d7d5')
    const result = await pending
    expect(result).toMatchObject({ depth: 7, scoreCp: 18, pv: ['d2d4', 'd7d5'], ponder: 'd7d5' })
  })

  it('resets mate/cp snapshots and never invents a score if info is absent', async () => {
    const { worker, engine } = await setup()
    const pending = engine.analyze(START, 8)
    await flush()
    worker.emit('info depth 7 score mate 3 pv e2e4\ninfo depth 8 score cp 25 pv d2d4\nbestmove d2d4')
    expect(await pending).toMatchObject({ scoreCp: 25, scoreMate: undefined })
    const next = engine.analyze(START, 9)
    await flush()
    worker.emit('bestmove e2e4')
    const result = await next
    expect(result).toMatchObject({ depth: 0, pv: [] })
    expect(result.scoreCp).toBeUndefined()
    expect(result.scoreMate).toBeUndefined()
    // A scoreless timed/cold search must not poison the evaluation cache.
    const retried = engine.analyze(START, 9)
    await flush()
    expect(worker.commands.filter(command => command === 'go depth 9')).toHaveLength(2)
    finish(worker)
    expect((await retried).scoreCp).toBe(35)
  })

  it('rejects cancelled searches immediately but drains before running the next', async () => {
    const { worker, engine, cache } = await setup()
    const controller = new AbortController()
    const cancelled = engine.analyze(START, 8, undefined, controller.signal)
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    const next = engine.analyze(AFTER_E4, 8)
    await flush()
    controller.abort()
    await rejected
    expect(worker.commands.at(-1)).toBe('stop')
    expect(worker.commands).not.toContain(`position fen ${AFTER_E4}`)
    finish(worker, 'e2e4', 999)
    worker.emit('info depth 40 score cp 888 pv a1a8')
    await flush()
    expect(cache.get(stockfishCacheKey(START, 8))).toBeUndefined()
    finish(worker, 'e7e5', -17)
    expect((await next).scoreCp).toBe(-17)
  })

  it('does not send queued cancelled work and rejects disposed active/queued jobs', async () => {
    const { worker, engine } = await setup()
    const current = engine.analyze(START)
    const queuedController = new AbortController()
    const queued = engine.analyze(AFTER_E4, 8, undefined, queuedController.signal)
    const rejectedQueued = expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    queuedController.abort()
    await rejectedQueued
    const disposedQueued = engine.analyze(AFTER_E4, 9)
    const rejects = Promise.all([expect(current).rejects.toMatchObject({ name: 'AbortError' }), expect(disposedQueued).rejects.toMatchObject({ name: 'AbortError' })])
    await flush()
    engine.dispose()
    await rejects
    expect(engine.ready).toBe(false)
    expect(worker.terminated).toBe(true)
    expect(worker.commands.filter(command => command.startsWith('position'))).toHaveLength(1)
    await expect(engine.analyze(START)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('poisons a timed-out worker so its late bestmove cannot satisfy future work', async () => {
    vi.useFakeTimers()
    const { worker, engine } = await setup(undefined, 10)
    const current = engine.analyze(START)
    const queued = engine.analyze(AFTER_E4)
    const rejected = Promise.all([expect(current).rejects.toThrow('timed out'), expect(queued).rejects.toThrow('timed out')])
    await flush()
    await vi.advanceTimersByTimeAsync(5010)
    await rejected
    finish(worker)
    await expect(engine.analyze(START)).rejects.toThrow('timed out')
    expect(worker.terminated).toBe(true)
  })

  it('rejects worker failures and permits clean failure of an invalid bestmove', async () => {
    const { worker, engine } = await setup()
    const pending = engine.analyze(START)
    await flush()
    worker.emit('bestmove (none)')
    await expect(pending).rejects.toThrow('nonterminal')
    const failed = engine.analyze(START)
    const rejected = expect(failed).rejects.toThrow('crashed')
    await flush()
    worker.onerror?.call(worker as unknown as Worker, {} as ErrorEvent)
    await rejected
  })
})

describe('terminal chess rules and score perspective', () => {
  it('distinguishes actual checkmate and stalemate without asking the worker', async () => {
    const { worker, engine } = await setup()
    const mate = await engine.analyze('7k/6Q1/6K1/8/8/8/8/8 b - - 0 1')
    expect(mate).toMatchObject({ terminal: 'checkmate', winner: 'w', scoreMate: 0, bestmove: '(none)' })
    expect(whiteScore(mate, false)).toBe(Infinity)
    expect(formatEval(mate, false)).toBe('1–0 · Checkmate')
    const stale = await engine.analyze('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1')
    expect(stale).toMatchObject({ terminal: 'stalemate', scoreCp: 0, bestmove: '(none)' })
    expect(formatEval(stale, false)).toBe('½–½ · Stalemate')
    const blackWins = await engine.analyze('8/8/8/8/8/6k1/6q1/7K w - - 0 1')
    expect(blackWins.winner).toBe('b')
    expect(whiteScore(blackWins, true)).toBe(-Infinity)
    expect(worker.commands).toEqual([])
  })

  it('converts cp/mate from either side to move once, and preserves unknown', () => {
    expect(formatEval(example, true)).toBe('+0.35')
    expect(formatEval(example, false)).toBe('-0.35')
    const mate = { ...example, scoreCp: undefined, scoreMate: 3 }
    expect(formatEval(mate, true)).toBe('M3')
    expect(formatEval(mate, false)).toBe('−M3')
    expect(whiteScore({ ...mate, scoreMate: -3 }, false)).toBe(Infinity)
    expect(whiteScore({ ...mate, scoreMate: 0 }, true)).toBe(-Infinity)
    expect(formatEval({ ...example, scoreCp: undefined }, true)).toBe('Unmeasured')
  })

  it('rejects incomplete/injected FEN and invalid limits before any commands', async () => {
    const { worker, engine } = await setup()
    await expect(engine.analyze('startpos')).rejects.toThrow()
    await expect(engine.analyze(`${START}\ngo infinite`)).rejects.toThrow()
    await expect(engine.analyze(START, 0)).rejects.toThrow()
    await expect(engine.analyze(START, 12, NaN)).rejects.toThrow()
    expect(worker.commands).toEqual([])
  })
})

describe('persistent bounded exact evaluation cache', () => {
  it('keys all six FEN fields, engine version, depth and time independently', async () => {
    const { worker, engine, cache } = await setup()
    const pending = engine.analyze(START, 8, 500)
    await flush(); finish(worker); await pending
    const count = worker.commands.length
    const hit = await engine.analyze(START, 8, 500)
    expect(worker.commands).toHaveLength(count)
    hit.pv.push('a1a8')
    expect(cache.get(stockfishCacheKey(START, 8, 500))?.pv).toEqual(['e2e4'])
    for (const key of [stockfishCacheKey(START, 9, 500), stockfishCacheKey(START, 8, 501), stockfishCacheKey(START, 8), stockfishCacheKey(START, 8, 500, 'different-engine'), stockfishCacheKey(START.replace('0 1', '1 1'), 8, 500), stockfishCacheKey(START.replace('0 1', '0 2'), 8, 500), stockfishCacheKey(START.replace('KQkq', '-'), 8, 500), stockfishCacheKey(AFTER_E4.replace(' - 0 1', ' e3 0 1'), 8, 500)]) {
      expect(cache.get(key)).toBeUndefined()
    }
  })

  it('persists measurements across instances and evicts least recently used', () => {
    const storage = new MemoryStorage()
    const cache = new StockfishEvalCache({ storage, maxEntries: 2 })
    cache.set('one', example); cache.set('two', example)
    cache.get('one'); cache.set('three', example)
    expect(cache.get('two')).toBeUndefined()
    const restored = new StockfishEvalCache({ storage, maxEntries: 2 })
    expect(restored.get('one')).toEqual(example)
    expect(restored.get('three')).toEqual(example)
    restored.set('four', example)
    expect(restored.get('one')).toBeUndefined()
  })

  it('keeps side to move and en-passant fields in full-FEN cache identity', () => {
    const epFen = AFTER_E4.replace(' - 0 1', ' e3 0 1')
    expect(epFen).not.toBe(AFTER_E4)
    expect(stockfishCacheKey(epFen, 8)).not.toBe(stockfishCacheKey(AFTER_E4, 8))
    expect(stockfishCacheKey(START.replace(' w ', ' b '), 8)).not.toBe(stockfishCacheKey(START, 8))
  })

  it('bounds serialized size and ignores malformed, old-schema and oversized storage', () => {
    const storage = new MemoryStorage()
    const cache = new StockfishEvalCache({ storage, maxBytes: 320 })
    for (let i = 0; i < 15; i++) cache.set(`key-${i}`, example)
    expect(storage.getItem(EVAL_CACHE_STORAGE_KEY)!.length).toBeLessThanOrEqual(320)
    for (const raw of ['invalid-json', JSON.stringify({ schema: 0, entries: [['one', example]] }), JSON.stringify({ schema: 1, entries: [['one', { ...example, scoreCp: 'not-a-score' }]] }), 'x'.repeat(321)]) {
      storage.setItem(EVAL_CACHE_STORAGE_KEY, raw)
      expect(new StockfishEvalCache({ storage, maxBytes: 320 }).get('one')).toBeUndefined()
    }
    const denied = new StockfishEvalCache({ storage: { getItem() { throw Error('denied') }, setItem() { throw Error('quota') } } })
    denied.set('one', example)
    expect(denied.get('one')).toEqual(example)
  })
})
