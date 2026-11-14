import { Chess } from 'chess.js'
import type { MultiPvResult } from './multiPv'

export interface CoachTurn { question: string; answer: string }
export interface CoachPromptInput {
  fen: string
  question: string
  userColor?: 'w' | 'b'
  playedSan?: string
  analysis?: MultiPvResult
  previous?: CoachTurn[]
}

/** A bounded question with explicit board context, rather than a disconnected chat. */
export function buildCoachPrompt(input: CoachPromptInput): string {
  const board = new Chess(input.fen)
  const side = board.turn() === 'w' ? 'White' : 'Black'
  const owner = input.userColor === 'w' ? 'White' : input.userColor === 'b' ? 'Black' : side
  const question = input.question.trim().slice(0, 650) || 'What should I learn from this position?'
  let playedDescription = input.playedSan
  if (input.playedSan) {
    try {
      const move = new Chess(input.fen).move(input.playedSan)
      const piece = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }[move.piece]
      playedDescription = `${move.san}: ${side} ${piece} ${move.from}-${move.to} (${move.from}${move.to}${move.promotion ?? ''})`
    } catch { /* Imported SAN is validated by the game loader. */ }
  }
  const lines = [
    `Coach the player of ${owner}. Current board: move ${board.moveNumber()}, ${side} to move.`,
    playedDescription ? `In the game, ${side} played ${playedDescription}. Explain the decision BEFORE that move. Do not substitute another piece's move to the same destination.` : '',
    'Answer the question directly, then give a concrete candidate line, the opponent threat to check, and one reusable training habit. Distinguish a fact from a speculative plan. Do not invent thinking times or claim to know the player\'s intentions.',
  ].filter(Boolean)
  if (input.analysis?.fen === input.fen) {
    const facts = input.analysis.lines.slice(0, 3).map(line => {
      const position = new Chess(input.fen)
      const moves: string[] = []
      for (const uci of line.pv.slice(0, 5)) {
        try { moves.push(position.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san) }
        catch { break }
      }
      const score = line.mate !== undefined ? `mate ${line.mate}` : `${(line.cp! / 100).toFixed(2)} pawns`
      return moves.length ? `${moves.join(' ')} (${score}, ${side}'s perspective)` : ''
    }).filter(Boolean)
    if (facts.length) lines.push(`Local engine candidate lines, depth ${input.analysis.depth}; finite-search estimates, not human win probabilities: ${facts.join('; ')}.`)
  }
  const last = input.previous?.at(-1)
  if (last) lines.push(`Previous question: ${last.question.slice(0, 140)}\nPrevious answer, which may need correction: ${last.answer.slice(0, 230)}`)
  const finalQuestion = `Question: ${question}`
  return lines.join('\n').slice(0, 1989 - finalQuestion.length) + '\n' + finalQuestion
}
