import { describe, expect, it } from 'vitest'
import { Chess, DEFAULT_POSITION } from 'chess.js'
import { loadGame, PUBLIC_PGN, uciSan } from './game'

const after = (pgn: string) => {
  const chess = new Chess()
  chess.loadPgn(pgn)
  return chess.fen()
}
const BLACK_START = after('1. e4').replace(' 0 1', ' 0 7')
const CUSTOM_PGN = `[SetUp "1"]\n[FEN "${BLACK_START}"]\n\n7... e5 8. Nf3 *`

describe('loadGame positions and sanitized prefixes', () => {
  it('loads the public unfinished Scotch Gambit with initial and final positions', () => {
    const game = loadGame(PUBLIC_PGN)
    expect(game.sans.slice(0, 8)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'd4', 'exd4', 'Bc4', 'Bc5'])
    expect(game.fens).toHaveLength(game.sans.length + 1)
    expect(game.fens[0]).toBe(DEFAULT_POSITION)
    expect(game.fens.at(-1)).toBe(after(PUBLIC_PGN))
    expect(game.clocks).toHaveLength(game.sans.length)
    expect(game.elapsed).toHaveLength(game.sans.length)
    expect(game.result).toBe('*')
    expect(game.completed).toBe(false)
  })

  it('matches only the final PGN FEN, including counters', () => {
    const final = after('1. e4 e5')
    expect(loadGame('1. e4 e5', final).fens.at(-1)).toBe(final)
    expect(() => loadGame('1. e4 e5', DEFAULT_POSITION)).toThrow(/final PGN/)
    expect(() => loadGame('1. e4 e5', after('1. e4'))).toThrow(/final PGN/)
    expect(() => loadGame('1. e4 e5', final.replace(' 0 2', ' 1 2'))).toThrow(/final PGN/)
  })

  it('compares canonical FENs, including irrelevant en-passant targets', () => {
    const final = after('1. e4')
    expect(loadGame('1. e4', final.replace(' - 0 1', ' e3 0 1')).fens.at(-1)).toBe(final)
  })

  it('supports FEN alone without inventing moves or clocks', () => {
    const game = loadGame('', BLACK_START)
    expect(game.fens).toEqual([BLACK_START])
    expect(game.sans).toEqual([])
    expect(game.clocks).toEqual([])
    expect(game.elapsed).toEqual([])
    expect(game.completed).toBe(false)
    expect(game.pgnAt(0)).toBe(`[SetUp "1"]\n[FEN "${BLACK_START}"]`)
  })

  it('requires complete six-field valid FENs, also in PGN headers', () => {
    const short = DEFAULT_POSITION.split(' ').slice(0, 4).join(' ')
    expect(() => loadGame('', short)).toThrow(/six fields/)
    expect(() => loadGame('1. e4', short)).toThrow(/six fields/)
    expect(() => loadGame(`[SetUp "1"]\n[FEN "${short}"]\n\n*`)).toThrow(/six fields/)
    expect(() => loadGame('', '8/8/8/8/8/8/8/8 w - - 0 1')).toThrow()
    expect(() => loadGame('')).toThrow()
    expect(() => loadGame('', '')).toThrow()
  })

  it('preserves custom starts and black move numbering in every prefix', () => {
    const game = loadGame(CUSTOM_PGN)
    expect(game.fens[0]).toBe(BLACK_START)
    expect(game.sans).toEqual(['e5', 'Nf3'])
    for (const ply of [0, 1, 2]) {
      const prefix = game.pgnAt(ply)
      const restored = new Chess()
      restored.loadPgn(prefix, { strict: true })
      expect(restored.fen()).toBe(game.fens[ply])
      expect(Object.keys(restored.getHeaders()).filter(key => ['SetUp', 'FEN'].includes(key))).toEqual(['SetUp', 'FEN'])
    }
    expect(game.pgnAt(1)).toContain('7. ... e5')
  })

  it('never exports names, other headers, comments, variations, clocks or future moves', () => {
    const game = loadGame('[White "Private Alice"]\n[Black "Private Bob"]\n[Event "Secret"]\n[Result "1-0"]\n[TimeControl "300+2"]\n\n1. e4 {private note [%clk 0:04:59]} (1. d4 d5) e5 2. Nf3 1-0')
    expect(game.pgnAt(0)).toBe('')
    expect(game.pgnAt(1)).toBe('1. e4')
    expect(game.pgnAt(3)).toBe('1. e4 e5 2. Nf3')
    expect(game.pgnAt(3)).not.toMatch(/Private|Secret|private|clk|TimeControl|White|Black|Result|1-0|d4|\[/)
    expect(() => game.pgnAt(-1)).toThrow()
    expect(() => game.pgnAt(4)).toThrow()
    expect(() => game.pgnAt(1.5)).toThrow()
    expect(() => game.pgnAt(NaN)).toThrow()
  })

  it('exports only SetUp and FEN for custom starts, even with private headers', () => {
    const game = loadGame('[White "Private Alice"]\n[Event "Secret"]\n' + CUSTOM_PGN.replace('e5', 'e5 {private [%clk 1:00:00]}'))
    const prefix = game.pgnAt(1)
    expect(prefix.match(/^\[\w+/gm)).toEqual(['[SetUp', '[FEN'])
    expect(prefix).not.toMatch(/Private|Secret|private|clk/)
  })

  it('rejects FEN headers that would silently be ignored by strict chess.js', () => {
    expect(() => loadGame(`[FEN "${BLACK_START}"]\n\n*`)).toThrow(/SetUp/)
  })
})

describe('one PGN game only', () => {
  it('rejects two headered games and headerless games after a result', () => {
    expect(() => loadGame('[Event "A"]\n\n1. e4 *\n\n[Event "B"]\n\n1. d4 *')).toThrow()
    expect(() => loadGame('1. e4 *\n\n1. d4 *')).toThrow()
    expect(() => loadGame('1. e4 1-0 1. d4 0-1')).toThrow()
    expect(() => loadGame('1. e4 * *')).toThrow()
  })

  it('rejects restarted move numbering even without a result delimiter', () => {
    expect(() => loadGame('1. e4 e5\n\n1. d4 d5')).toThrow(/numbering/)
    expect(() => loadGame('[Event "A"]\n[Event "B"]\n\n1. e4')).toThrow()
  })

  it('ignores fake game delimiters inside comments and variations', () => {
    const game = loadGame('1. e4 {1-0 [Event "Not a second game"]} (1. d4 {1/2-1/2} d5) e5 ; 0-1 [Event "Also a comment"]\n2. Nf3 *')
    expect(game.sans).toEqual(['e4', 'e5', 'Nf3'])
    expect(game.completed).toBe(false)
  })

  it('rejects illegal moves, unclosed comments and null moves', () => {
    expect(() => loadGame('1. e5')).toThrow()
    expect(() => loadGame('1. e4 {unfinished')).toThrow()
    expect(() => loadGame('1. e4 (1. d4')).toThrow()
    expect(() => loadGame('1. --')).toThrow()
  })
})

describe('source-clock reconstruction (estimated, not measured elapsed time)', () => {
  it('uses only the same side previous clock plus the known increment', () => {
    const game = loadGame('[TimeControl "300+2"]\n\n1. e4 {[%clk 0:04:59]} e5 {[%clk 0:04:58]} 2. Nf3 {[%clk 0:04:57]} Nc6 {[%clk 0:04:55]} *')
    expect(game.timeControl).toBe('300+2')
    expect(game.clocks).toEqual([299, 298, 297, 295])
    expect(game.elapsed).toEqual([undefined, undefined, 4, 5])
  })

  it('supports hours and a known zero increment', () => {
    const game = loadGame('[TimeControl "7200+0"]\n\n1. e4 {[%clk 2:01:00]} e5 {[%clk 1:59:00]} 2. Nf3 {[%clk 2:00:50]} *')
    expect(game.clocks).toEqual([7260, 7140, 7250])
    expect(game.elapsed).toEqual([undefined, undefined, 10])
  })

  it('does not bridge missing same-side clocks or use the base as a prior clock', () => {
    const game = loadGame('[TimeControl "300+2"]\n\n1. e4 {[%clk 0:04:59]} e5 2. Nf3 Nc6 3. Bc4 {[%clk 0:04:40]} Bc5 4. d3 {[%clk 0:04:38]} *')
    expect(game.elapsed).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, 4])
  })

  it('does not assume the base clock for a custom midgame start', () => {
    const game = loadGame('[TimeControl "300+2"]\n' + CUSTOM_PGN.replace('e5', 'e5 {[%clk 0:02:00]}').replace('Nf3', 'Nf3 {[%clk 0:03:00]}'))
    expect(game.clocks).toEqual([120, 180])
    expect(game.elapsed).toEqual([undefined, undefined])
  })

  it('keeps source clocks but never estimates unsupported or staged time controls', () => {
    for (const control of [undefined, '?', '-', '300', '40/7200:3600+30', '300+2:60', '300+-2', '1e3+2', '300+9007199254740992']) {
      const header = control === undefined ? '' : `[TimeControl "${control}"]\n\n`
      const game = loadGame(header + '1. e4 {[%clk 0:04:59]} e5 2. Nf3 {[%clk 0:04:50]} *')
      expect(game.clocks).toEqual([299, undefined, 290])
      expect(game.elapsed).toEqual([undefined, undefined, undefined])
    }
  })

  it('leaves malformed, duplicate, negative and overflowing clocks unknown', () => {
    for (const comment of ['[%clk 0:60:00]', '[%clk 0:00:60]', '[%clk -0:01:00]', '[%clk 4:59]', '[%clk 0:04:59] [%clk 0:04:58]', '[%clk 999999999999999999:00:00]']) {
      expect(loadGame(`1. e4 {${comment}}`).clocks).toEqual([undefined])
    }
    const game = loadGame('[TimeControl "300+2"]\n\n1. e4 {[%clk 0:04:59]} e5 2. Nf3 {[%clk 0:05:10]}')
    expect(game.clocks[2]).toBe(310)
    expect(game.elapsed[2]).toBe(undefined)
  })
})

describe('completion and SAN', () => {
  it('recognizes decisive and drawn result markers without requiring mate', () => {
    for (const result of ['1-0', '0-1', '1/2-1/2']) {
      const game = loadGame(`1. e4 ${result}`)
      expect(game.result).toBe(result)
      expect(game.completed).toBe(true)
      expect(game.pgnAt(1)).toBe('1. e4')
    }
    expect(loadGame('[Result "1-0"]\n\n1. e4').completed).toBe(true)
  })

  it('recognizes checkmate and repetition from the rules even with unfinished markers', () => {
    const mate = loadGame('1. f3 e5 2. g4 Qh4# *')
    expect(mate.completed).toBe(true)
    expect(mate.result).toBe('0-1')
    const repetition = loadGame('1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8 *')
    expect(repetition.completed).toBe(true)
    expect(repetition.result).toBe('1/2-1/2')
    expect(loadGame('', '7k/8/6QK/8/8/8/8/8 b - - 0 1').result).toBe('1/2-1/2')
  })

  it('converts a legal UCI PV sequentially, including castling and promotion checks', () => {
    expect(uciSan(DEFAULT_POSITION, ['e2e4', 'e7e5', 'g1f3'])).toBe('e4 e5 Nf3')
    expect(uciSan(after('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5'), ['e1g1'])).toBe('O-O')
    expect(uciSan('7k/P7/8/8/8/8/8/7K w - - 0 1', ['a7a8q'])).toBe('a8=Q+')
    expect(uciSan(DEFAULT_POSITION, [])).toBe('')
  })

  it('rejects malformed or illegal UCI moves and incomplete FENs', () => {
    expect(() => uciSan(DEFAULT_POSITION, ['e2e5'])).toThrow()
    expect(() => uciSan(DEFAULT_POSITION, ['e2e4', 'e2e3'])).toThrow()
    expect(() => uciSan(DEFAULT_POSITION, ['e4'])).toThrow()
    expect(() => uciSan(DEFAULT_POSITION, ['e2e4garbage'])).toThrow()
    expect(() => uciSan(DEFAULT_POSITION.split(' ').slice(0, 4).join(' '), [])).toThrow(/six fields/)
  })
})
