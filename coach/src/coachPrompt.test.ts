import { describe, expect, it } from 'vitest'
import { Chess } from 'chess.js'
import { buildCoachPrompt } from './coachPrompt'

describe('position-grounded coaching question', () => {
  it('keeps the actual user question, played move and perspective', () => {
    const fen = new Chess().fen()
    const prompt = buildCoachPrompt({ fen, userColor: 'b', playedSan: 'e4', question: 'How do I avoid losing time in the opening?',
      analysis: { fen, depth: 12, timeMs: 100, lines: [{ rank: 1, cp: 30, pv: ['e2e4', 'e7e5'] }] } })
    expect(prompt).toContain('player of Black')
    expect(prompt).toContain('White played e4')
    expect(prompt).toContain('White pawn e2-e4 (e2e4)')
    expect(prompt).toContain("0.30 pawns, White's perspective")
    expect(prompt).toContain('e4 e5')
    expect(prompt).toContain('How do I avoid losing time')
  })
  it('never attaches stale engine facts to a new board', () => {
    const board = new Chess(); const old = board.fen(); board.move('e4')
    expect(buildCoachPrompt({ fen: board.fen(), question: 'Why?', analysis: { fen: old, depth: 12, timeMs: 1, lines: [{ rank: 1, cp: 500, pv: ['d2d4'] }] } })).not.toContain('5.00')
  })
  it('bounds conversational context and preserves the question at the end', () => {
    const prompt = buildCoachPrompt({ fen: new Chess().fen(), question: 'My question', previous: [{ question: 'q'.repeat(9000), answer: 'a'.repeat(9000) }] })
    expect(prompt.length).toBeLessThan(2000)
    expect(prompt).toContain('Previous answer')
    expect(prompt).toContain('Question: My question')
  })
})
