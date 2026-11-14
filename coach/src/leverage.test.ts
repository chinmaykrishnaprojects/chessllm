import { describe, it, expect } from 'vitest'
import { criticalPosition, lineUtility, scanCriticalPositions } from './leverage'
import type { MultiPvResult } from './multiPv'

const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const result = (best: number, second: number): MultiPvResult => ({ fen, depth: 8, timeMs: 150,
  lines: [{ rank: 1, cp: best, pv: ['e2e4'] }, { rank: 2, cp: second, pv: ['d2d4'] }] })
describe('only-move pressure proxy', () => {
  it('ranks a severe alternative loss above interchangeable good moves', () => {
    expect(criticalPosition(0, result(100, -900)).score > criticalPosition(1, result(100, 90)).score).toBe(true)
    expect(criticalPosition(0, result(100, -900)).gapCp).toBe(1000)
  })
  it('gives a forced legal move zero pressure without inventing an engine score', () => {
    const analysis: MultiPvResult = { fen: '7k/5K2/8/6Q1/8/8/8/8 b - - 0 1', depth: 0, timeMs: 0, lines: [] }
    const r = criticalPosition(4, analysis)
    expect(r.score).toBe(0)
    expect(r.bestMove).toBe('h8h7')
    expect(r.gapCp).toBe(undefined)
  })
  it('uses signed mate utility without manufactured centipawns', () => {
    expect(lineUtility({ rank: 1, mate: 2, pv: [] })).toBe(1)
    expect(lineUtility({ rank: 1, mate: -3, pv: [] })).toBe(-1)
    const analysis = result(0, 0)
    analysis.lines[0] = { rank: 1, mate: 1, pv: ['e2e4'] }
    analysis.lines[1] = { rank: 2, mate: -2, pv: ['d2d4'] }
    expect(criticalPosition(0, analysis).score).toBe(100)
    expect(criticalPosition(0, analysis).gapCp).toBe(undefined)
  })
  it('does not manufacture a gap from one measured PV', () => {
    const analysis = result(0, 0); analysis.lines.pop()
    expect(() => criticalPosition(0, analysis)).toThrow()
  })
  it('skips terminal boards and counts them in progress', async () => {
    const progress: number[] = []
    const r = await scanCriticalPositions(['7k/6Q1/5K2/8/8/8/8/8 b - - 0 1'], done => progress.push(done))
    expect(r.length).toBe(0)
    expect(progress.join(',')).toBe('0,1')
  })
})
