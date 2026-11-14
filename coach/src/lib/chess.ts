import { Chess, DEFAULT_POSITION } from 'chess.js'

export interface Study { initialFen: string; moves: string[]; title: string }

export function legalPosition(fen: string): Chess {
  if (fen.trim().split(/\s+/).length !== 6) throw new Error('Enter a complete FEN with all six fields.')
  const game = new Chess(fen.trim())
  const previous = game.turn() === 'w' ? 'b' : 'w'
  const previousKing = game.findPiece({ color: previous, type: 'k' })[0]
  if (game.isAttacked(previousKing, game.turn())) throw new Error('Illegal position: the side that just moved left its king in check.')
  for (const color of ['w', 'b'] as const) {
    const pieces = game.board().flat().filter(p => p?.color === color)
    if (pieces.length > 16 || pieces.filter(p => p?.type === 'p').length > 8) throw new Error('Illegal number of pieces or pawns.')
    const rank = color === 'w' ? '1' : '8'
    const rights = game.fen().split(' ')[2]
    for (const [flag, file] of (color === 'w' ? [['K', 'h'], ['Q', 'a']] : [['k', 'h'], ['q', 'a']])) {
      if (rights.includes(flag) && (game.get(`e${rank}` as 'e1')?.type !== 'k' || game.get(`e${rank}` as 'e1')?.color !== color || game.get(`${file}${rank}` as 'h1')?.type !== 'r' || game.get(`${file}${rank}` as 'h1')?.color !== color)) throw new Error('Castling rights do not match the king and rooks.')
    }
  }
  return game
}

export function importPgn(pgn: string): Study {
  if (!pgn.trim()) throw new Error('Paste a PGN first.')
  if (pgn.length > 100_000) throw new Error('Use one game under 100,000 characters.')
  const game = new Chess()
  game.loadPgn(pgn, { strict: true })
  const history = game.history({ verbose: true })
  const initialFen = history[0]?.before ?? game.fen()
  legalPosition(initialFen)
  return { initialFen, moves: history.map(m => m.san), title: 'Imported game' }
}

export function positionAt(study: Study, ply: number): Chess {
  const game = new Chess(study.initialFen)
  study.moves.slice(0, ply).forEach(san => game.move(san))
  return game
}

/** A clean mainline ending at the CURRENT board. No names, comments or future moves. */
export function requestPgn(study: Study, ply: number): string {
  if (!ply) return ''
  const game = positionAt(study, ply)
  for (const key of Object.keys(game.getHeaders())) game.removeHeader(key)
  if (study.initialFen !== DEFAULT_POSITION) {
    game.setHeader('SetUp', '1')
    game.setHeader('FEN', study.initialFen)
  }
  return game.pgn().trim()
}

export function lineToSan(fen: string, line: string[]): string[] {
  const game = new Chess(fen)
  return line.map(uci => {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) throw new Error('Invalid UCI move in response.')
    return game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san
  })
}

export const EXAMPLE = importPgn('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6')
EXAMPLE.title = 'Ruy López · an opening to explore'
export const NEW_GAME: Study = { initialFen: DEFAULT_POSITION, moves: [], title: 'New analysis' }
