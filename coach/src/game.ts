import { Chess, DEFAULT_POSITION } from 'chess.js'

export interface CoachGame {
  fens: string[]
  sans: string[]
  pgnAt: (ply: number) => string
  clocks: (number | undefined)[]
  /** Estimated seconds from source clocks, not measured move durations. */
  elapsed: (number | undefined)[]
  result: string
  completed: boolean
  timeControl?: string
}

/** Public opening moves only; no player data or imported annotations. */
export const PUBLIC_PGN = '1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Bc4 Bc5 5. c3 Nf6 *'

function completeFen(fen: string): string {
  const fields = fen.trim().split(/\s+/)
  if (fields.length !== 6) throw new Error('Enter a complete FEN with all six fields.')
  return new Chess(fields.join(' ')).fen()
}

/** Inspect only the mainline. Comments, quoted headers and RAVs cannot delimit games. */
function mainline(pgn: string): string {
  let text = ''
  let depth = 0
  let started = false
  const tags = new Set<string>()
  for (let i = 0; i < pgn.length;) {
    const c = pgn[i]
    if (c === '{' || c === ';') {
      const end = c === '{' ? pgn.indexOf('}', i + 1) : pgn.indexOf('\n', i + 1)
      if (end < 0 && c === '{') throw new Error('Unclosed PGN comment.')
      i = end < 0 ? pgn.length : end + 1
      text += ' '
    } else if (c === '[') {
      const tag = /^\[([A-Za-z0-9_]+)\s+"((?:\\.|[^"\\])*)"\s*\]/.exec(pgn.slice(i))
      if (!tag || started || depth || tags.has(tag[1])) throw new Error('Load one PGN game only; invalid or repeated headers.')
      if (tag[1] === 'FEN') completeFen(tag[2].replace(/\\(["\\])/g, '$1'))
      tags.add(tag[1])
      i += tag[0].length
    } else if (c === '(') {
      depth++
      i++
      text += ' '
    } else if (c === ')') {
      if (!depth) throw new Error('Unmatched PGN variation.')
      depth--
      i++
      text += ' '
    } else {
      if (!depth) {
        text += c
        if (!/\s/.test(c)) started = true
      }
      i++
    }
  }
  if (depth) throw new Error('Unclosed PGN variation.')
  return text
}

const RESULTS = new Set(['*', '1-0', '0-1', '1/2-1/2'])

function checkMainline(text: string, initial: string, count: number): string | undefined {
  const fields = initial.split(' ')
  const firstPly = (Number(fields[5]) - 1) * 2 + (fields[1] === 'b' ? 1 : 0)
  const tokens = text.replace(/(\d+\.(?:\.\.)?)/g, ' $1 ').trim().split(/\s+/).filter(Boolean)
  let ply = 0
  let result: string | undefined
  for (const token of tokens) {
    if (result !== undefined) throw new Error('Load one PGN game only; content follows its result.')
    if (RESULTS.has(token)) { result = token; continue }
    const number = /^(\d+)\.(\.\.)?$/.exec(token)
    if (number) {
      const expected = firstPly + ply
      if (Number(number[1]) !== Math.floor(expected / 2) + 1 || Boolean(number[2]) !== Boolean(expected % 2)) {
        throw new Error('Invalid PGN move numbering; load one game only.')
      }
    } else if (!/^\$\d+$|^[!?]+$|^\.\.\.$/.test(token)) {
      ply++
    }
  }
  if (ply !== count) throw new Error('Invalid PGN mainline.')
  return result
}

function clockSeconds(comment: string | undefined): number | undefined {
  // Multiple or malformed clock annotations are ambiguous, so leave them unknown.
  const annotations = comment?.match(/\[%clk\b[^\]]*\]/g) ?? []
  if (annotations.length !== 1) return undefined
  const clock = /^\[%clk\s+(\d+):([0-5]\d):([0-5]\d)\s*\]$/.exec(annotations[0])
  if (!clock) return undefined
  const seconds = Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])
  return Number.isSafeInteger(seconds) ? seconds : undefined
}

export function loadGame(pgn: string, fen?: string): CoachGame {
  const suppliedFen = fen === undefined ? undefined : completeFen(fen)
  const source = pgn.trim()
  if (!source && suppliedFen === undefined) throw new Error('Enter one PGN game or a complete FEN.')
  const game = new Chess(suppliedFen && !source ? suppliedFen : DEFAULT_POSITION)
  const text = source ? mainline(source) : ''
  if (source) game.loadPgn(source, { strict: true })
  const headers = game.getHeaders()
  if (headers.FEN !== undefined) {
    completeFen(headers.FEN)
    if (headers.SetUp !== '1') throw new Error('A PGN FEN requires SetUp "1".')
  }
  const moves = game.history({ verbose: true })
  if (moves.some(move => move.san === '--')) throw new Error('Null moves are not played chess moves.')
  const initial = moves[0]?.before ?? game.fen()
  const terminal = checkMainline(text, initial, moves.length)
  if (suppliedFen !== undefined && suppliedFen !== game.fen()) {
    throw new Error('The supplied FEN must match the final PGN position, including counters.')
  }

  const fens = [initial, ...moves.map(move => move.after)]
  const sans = moves.map(move => move.san)
  const comments = new Map(game.getComments().map(({ fen, comment }) => [fen, comment]))
  const clocks = moves.map(move => clockSeconds(comments.get(move.after)))
  const timeControl = headers.TimeControl
  const control = timeControl?.match(/^(\d+)\+(\d+)$/)
  const increment = control && Number.isSafeInteger(Number(control[1])) && Number.isSafeInteger(Number(control[2]))
    ? Number(control[2]) : undefined
  const prior: Partial<Record<'w' | 'b', number>> = {}
  const elapsed = moves.map((move, i) => {
    const previous = prior[move.color]
    const current = clocks[i]
    prior[move.color] = current
    if (increment === undefined || previous === undefined || current === undefined) return undefined
    const estimate = previous + increment - current
    return Number.isSafeInteger(estimate) && estimate >= 0 ? estimate : undefined
  })

  let result = terminal ?? headers.Result ?? '*'
  if (!RESULTS.has(result)) throw new Error('Invalid PGN result.')
  if (result === '*' && game.isCheckmate()) result = game.turn() === 'w' ? '0-1' : '1-0'
  else if (result === '*' && game.isDraw()) result = '1/2-1/2'

  return {
    fens, sans, clocks, elapsed, result, completed: result !== '*', timeControl,
    pgnAt(ply: number): string {
      if (!Number.isInteger(ply) || ply < 0 || ply > sans.length) throw new Error('Ply is outside this game.')
      const prefix = new Chess(initial)
      for (const san of sans.slice(0, ply)) prefix.move(san)
      // chess.js restores mandatory roster headers when removed. Strip its serialized
      // headers and result, then add only the canonical setup needed for this prefix.
      const movetext = prefix.pgn().split('\n').filter(line => !/^\[/.test(line)).join('\n')
        .trim().replace(/(?:^|\s)(?:\*|1-0|0-1|1\/2-1\/2)$/, '').trim()
      const setup = initial === DEFAULT_POSITION ? '' : `[SetUp "1"]\n[FEN "${initial}"]`
      return [setup, movetext].filter(Boolean).join('\n\n')
    },
  }
}

/** Convert an engine's legal UCI mainline to SAN, without making any requests. */
export function uciSan(fen: string, pv: string[]): string {
  const game = new Chess(completeFen(fen))
  return pv.map(uci => {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) throw new Error('Invalid UCI move.')
    return game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san
  }).join(' ')
}
