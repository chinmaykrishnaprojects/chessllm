/** Only-move pressure proxy, NOT a causal estimate of the value of extra time.
 * Parent UI supplies pre-ply FENs from a complete game; max 120 positions.
 */
import { Chess } from 'chess.js'
import { analyzeMultiPv, type MultiPvLine, type MultiPvResult } from './multiPv'

export interface CriticalPosition {
  ply: number; fen: string; score: number; bestMove: string; secondMove?: string
  gapCp?: number; analysis: MultiPvResult
}
export function lineUtility(line: MultiPvLine): number {
  if (line.mate !== undefined) return line.mate > 0 ? 1 : -1
  if (line.cp === undefined || !Number.isFinite(line.cp)) throw new Error('Unmeasured MultiPV score')
  return Math.tanh(line.cp / 400)
}
export function criticalPosition(ply: number, analysis: MultiPvResult): CriticalPosition {
  const legal = new Chess(analysis.fen).moves({ verbose: true })
  const forced = legal.length < 2
  const best = analysis.lines.find(l => l.rank === 1)
  const second = analysis.lines.find(l => l.rank === 2)
  if (!forced && (!best || !second)) throw new Error('Criticality requires two scores at the same completed depth')
  const score = forced ? 0 : Math.max(0, Math.min(100, 100 * (lineUtility(best!) - lineUtility(second!)) / 2))
  return { ply, fen: analysis.fen, score,
    bestMove: best?.pv[0] ?? (legal[0] ? legal[0].from + legal[0].to + (legal[0].promotion ?? '') : ''),
    secondMove: forced ? undefined : second?.pv[0],
    gapCp: !forced && best?.cp !== undefined && second?.cp !== undefined ? best.cp - second.cp : undefined,
    analysis }
}
export async function scanCriticalPositions(fens: string[], onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<CriticalPosition[]> {
  if (fens.length > 120) throw new Error('Criticality scan supports at most 120 pre-ply positions; submit one complete game within that limit')
  const results: CriticalPosition[] = []
  onProgress?.(0, fens.length)
  for (const [ply, fen] of fens.entries()) {
    if (signal?.aborted) throw new DOMException('Criticality scan cancelled', 'AbortError')
    const board = new Chess(fen)
    if (!board.isGameOver()) {
      const analysis = board.moves().length < 2
        ? { fen, lines: [], depth: 0, timeMs: 0 }
        : await analyzeMultiPv(fen, { count: 3, depth: 10, movetimeMs: 150, signal })
      results.push(criticalPosition(ply, analysis))
    }
    onProgress?.(ply + 1, fens.length)
  }
  return results.sort((a, b) => b.score - a.score || a.ply - b.ply)
}
