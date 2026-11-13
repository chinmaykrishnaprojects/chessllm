import { describe, expect, it } from 'vitest'
import { Chess } from 'chess.js'
import { cloneWithHistory, observedMoveProbability, probabilityContextKey, withPlyTelemetry } from './telemetry'

describe('position and ply bookkeeping', () => {
  it('keeps repeated positions when cloning the full PGN', () => {
    const board = new Chess()
    for (const san of ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8']) board.move(san)
    expect(board.isThreefoldRepetition()).toBe(true)
    const copy = cloneWithHistory(board)
    expect(copy.fen()).toBe(board.fen())
    expect(copy.history()).toEqual(board.history())
    expect(copy.isThreefoldRepetition()).toBe(true)
  })

  it('separates identical FENs with different PGN contexts and model settings', () => {
    const start = new Chess()
    const old = probabilityContextKey(start.fen(), '', 'stockfish', 0.3)
    start.move('e4')
    expect(probabilityContextKey(start.fen(), '1. e4', 'stockfish', 0.3)).not.toBe(old)
    expect(probabilityContextKey(new Chess().fen(), '1. Nf3 Nf6 2. Ng1 Ng8', 'stockfish', 0.3)).not.toBe(old)
    expect(probabilityContextKey(new Chess().fen(), '', 'lichess', 0.3)).not.toBe(old)
    expect(probabilityContextKey(new Chess().fen(), '', 'stockfish', 0.8)).not.toBe(old)
  })

  it('attaches pre-move measurements to matching SAN only and retains missing values', () => {
    const record = { san: 'e4', actor: 'human' as const }
    const old = [record, { san: 'e5', actor: 'engine' as const }]
    const telemetry = { source_fen: new Chess().fen(), source_pgn: '', model: 'stockfish', temperature: 0.3, model_probability: 0.21 }
    const updated = withPlyTelemetry(old, 0, 'e4', telemetry)
    expect(updated[0]?.telemetry?.model_probability).toBe(0.21)
    expect(updated[1]?.telemetry).toBeUndefined()
    expect(withPlyTelemetry(updated, 0, 'd4', telemetry)).toBe(updated)
    expect(observedMoveProbability([{ move: 'e4', prob: 0.21 }], 'e4')).toBe(0.21)
    expect(observedMoveProbability([], 'e4')).toBeUndefined()
  })
})
