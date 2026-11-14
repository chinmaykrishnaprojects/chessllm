import { describe, it, expect } from 'vitest'
import { CompletedMultiPv, MultiPvCache, MultiPvEngine, multiPvCacheKey } from './multiPv'

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const info = (depth: number, rank: number, cp: number, move: string) => `info depth ${depth} multipv ${rank} score cp ${cp} nodes 50 pv ${move}`
const pause = () => new Promise(resolve => setTimeout(resolve, 0))

describe('shared-depth MultiPV', () => {
  it('falls back when a stopped deeper iteration has duplicate or illegal lines', () => {
    const c = new CompletedMultiPv(2)
    c.accept(info(5, 1, 30, 'e2e4')); c.accept(info(5, 2, 20, 'd2d4'))
    c.accept(info(6, 1, 50, 'e2e4')); c.accept(info(6, 2, 40, 'e2e4'))
    expect(c.completed(FEN)?.depth).toBe(5)
    c.accept(info(6, 2, 40, 'a1a8'))
    expect(c.completed(FEN)?.depth).toBe(5)
    c.accept(info(6, 2, 40, 'g1f3'))
    expect(c.completed(FEN)?.depth).toBe(6)
  })
  it('never mixes a new rank-one score with older second/third scores', () => {
    const c = new CompletedMultiPv(3)
    c.accept(info(7, 1, 40, 'e2e4')); c.accept(info(7, 2, 20, 'd2d4')); c.accept(info(7, 3, 10, 'g1f3'))
    c.accept(info(8, 1, 900, 'e2e4'))
    expect(c.completed()?.depth).toBe(7)
    expect(c.completed()?.lines[0].cp).toBe(40)
    c.accept(info(8, 2, 50, 'd2d4')); c.accept(info(8, 3, 30, 'g1f3') + ' upperbound')
    expect(c.completed()?.depth).toBe(7)
    c.accept(info(8, 3, 30, 'g1f3'))
    expect(c.completed()?.depth).toBe(8)
  })
  it('drains cancelled bestmove before another queued go command', async () => {
    const commands: string[] = []
    const worker = { onmessage: null as null | ((e: { data: string }) => void), onerror: null, onmessageerror: null,
      postMessage(command: string) { commands.push(command); if (command === 'uci') queueMicrotask(() => this.onmessage?.({ data: 'uciok' })); if (command === 'isready') queueMicrotask(() => this.onmessage?.({ data: 'readyok' })) }, terminate() {} }
    const engine = new MultiPvEngine({ workerFactory: () => worker as unknown as Worker, cache: new MultiPvCache(), timeoutMs: 2000 })
    const control = new AbortController()
    const first = engine.analyze(FEN, { signal: control.signal }).catch(e => e)
    await pause(); control.abort()
    const second = engine.analyze(FEN, { depth: 9 })
    await pause()
    expect(commands.filter(c => c.startsWith('go ')).length).toBe(1)
    expect(commands.includes('stop')).toBe(true)
    worker.onmessage?.({ data: 'bestmove e2e4' })
    await pause()
    expect(commands.filter(c => c.startsWith('go ')).length).toBe(2)
    worker.onmessage?.({ data: [info(5, 1, 40, 'e2e4'), info(5, 2, 20, 'd2d4'), info(5, 3, 10, 'g1f3'), 'bestmove e2e4'].join('\n') })
    expect((await first).name).toBe('AbortError')
    expect((await second).depth).toBe(5)
    engine.dispose()
  })
  it('separates counters, engine budget and PV count in cache keys', () => {
    const key = multiPvCacheKey(FEN, 3, 10, 150)
    expect(key === multiPvCacheKey(FEN.replace(' 0 1', ' 2 1'), 3, 10, 150)).toBe(false)
    expect(key === multiPvCacheKey(FEN, 2, 10, 150)).toBe(false)
    expect(key === multiPvCacheKey(FEN, 3, 11, 150)).toBe(false)
  })
})
