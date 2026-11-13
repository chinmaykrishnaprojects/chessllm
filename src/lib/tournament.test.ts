import { describe, expect, it, vi, afterEach } from 'vitest'
import { Chess } from 'chess.js'
import {
  DEFAULT_CONFIG, TournamentRunner, boardFromPgn, createBrowserMoveProvider, createFixtures, createTournament,
  exportTournamentPgn, gameEnding, parseCheckpoint, serializeCheckpoint, standings, validateConfig,
} from './tournament'
import type { MoveProvider, MoveRequest, PositionEvent, TournamentConfig, TournamentState } from './tournament'

const adapters = vi.hoisted(() => ({ fetch: vi.fn(), analyze: vi.fn(), dispose: vi.fn() }))
vi.mock('./recoveryApi', () => ({ chessFetch: adapters.fetch }))
vi.mock('./stockfishUci', () => ({ getStockfishEngine: () => ({ analyze: adapters.analyze, dispose: adapters.dispose }) }))
afterEach(() => vi.clearAllMocks())

function config(overrides: Partial<TournamentConfig> = {}): TournamentConfig {
  return { ...structuredClone(DEFAULT_CONFIG), participants: structuredClone(DEFAULT_CONFIG.participants.slice(0, 2)), maxPlies: 4, ...overrides }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
const firstLegal: MoveProvider = async request => new Chess(request.fen).moves()[0]
function harness(input = config(), move: MoveProvider = firstLegal) {
  const saved: string[] = [], positions: Readonly<PositionEvent>[] = []
  const runner = new TournamentRunner(createTournament(input), { move, save: text => saved.push(text), onPosition: p => positions.push(p) })
  return { runner, saved, positions }
}

describe('fixtures and setup', () => {
  it('schedules each pair in both colors in every cycle with unique fixture IDs', () => {
    const fixtures = createFixtures(DEFAULT_CONFIG.participants, 2)
    expect(fixtures).toHaveLength(12)
    expect(new Set(fixtures.map(f => f.id)).size).toBe(12)
    for (const cycle of [1, 2]) {
      for (const white of DEFAULT_CONFIG.participants) {
        for (const black of DEFAULT_CONFIG.participants.filter(p => p.id !== white.id)) {
          expect(fixtures.filter(f => f.cycle === cycle && f.whiteId === white.id && f.blackId === black.id)).toHaveLength(1)
        }
      }
    }
  })
  it('accepts seeded PGN history and strips metadata before native model inference', () => {
    const state = createTournament(config({ seedPgn: '[Event "Opening"]\n\n1. e4 e5 2. Nf3 *' }))
    expect(state.config.seedPgn).toBe('1. e4 e5 2. Nf3')
    expect(state.games[0].fen).toBe(boardFromPgn(state.config.seedPgn).fen())
    expect(state.games[0].plies).toBe(0)
  })
  it('rejects FEN seeds, already-finished openings, duplicate identity, and invalid budgets', () => {
    expect(() => validateConfig(config({ seedPgn: '[SetUp "1"]\n[FEN "7k/8/8/8/8/8/8/K7 w - - 0 1"]\n\n*' }))).toThrow(/FEN/)
    expect(() => validateConfig(config({ seedPgn: '1. f3 e5 2. g4 Qh4#' }))).toThrow(/already game over/)
    const duplicate = config(); duplicate.participants[1].id = duplicate.participants[0].id
    expect(() => validateConfig(duplicate)).toThrow(/unique/)
    expect(() => validateConfig(config({ cycles: 0 }))).toThrow(/Paired rounds/)
    expect(() => validateConfig(config({ maxPlies: NaN }))).toThrow(/Ply cap/)
    const budget = structuredClone(DEFAULT_CONFIG); const sf = budget.participants[2]
    if (sf.kind === 'stockfish') sf.movetimeMs = -1
    expect(() => validateConfig(budget)).toThrow(/milliseconds/)
  })
})

describe('results, immutable history and PGNs', () => {
  it('credits identity through reversed colors, even when display names are identical', async () => {
    const setup = config({ maxPlies: 10 })
    setup.participants.forEach(p => { p.name = 'Same display name' })
    const sequences: Record<string, string[]> = { 'game-1': ['f3', 'e5', 'g4', 'Qh4#'], 'game-2': ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#'] }
    const { runner, saved } = harness(setup, async r => sequences[r.fixtureId][r.ply])
    await runner.start()
    const state = runner.getSnapshot()
    expect(state.status).toBe('completed')
    expect(state.games.map(g => g.result)).toEqual(['0-1', '1-0'])
    const winner = standings(state).find(row => row.id === setup.participants[1].id)!
    expect(winner).toMatchObject({ points: 2, wins: 2, played: 2 })
    expect(standings(state).find(row => row.id === setup.participants[0].id)).toMatchObject({ points: 0, losses: 2 })
    // Every intermediate persisted state, including the final scoring ply, must be resumable/valid.
    saved.forEach(text => expect(() => parseCheckpoint(text)).not.toThrow())
    const pgn = exportTournamentPgn(state)
    expect(pgn).toContain('[WhiteId "gpt-stockfish"]')
    expect(pgn).toContain('[BlackId "gpt-stockfish"]')
    expect(pgn.match(/\[Termination "checkmate"\]/g)).toHaveLength(2)
    expect(pgn).toContain('2. g4 Qh4# 0-1')
  })
  it('captures frozen pre-move PGN for requests and callbacks with full seed context', async () => {
    const requests: Readonly<MoveRequest>[] = []
    const { runner, positions } = harness(config({ seedPgn: '1. e4 e5', maxPlies: 2 }), async r => { requests.push(r); return new Chess(r.fen).moves()[0] })
    await runner.start()
    expect(requests[0].pgn).toBe('1. e4 e5')
    expect(requests[1].pgn).toBe(positions[0].pgn)
    expect(positions[0].preMovePgn).toBe('1. e4 e5')
    expect(positions[0].preMoveFen).toBe(requests[0].fen)
    expect(Object.isFrozen(requests[0])).toBe(true)
    expect(Object.isFrozen(requests[0].participant)).toBe(true)
    expect(Object.isFrozen(positions[0])).toBe(true)
    expect(requests[0].pgn).toBe('1. e4 e5')
    expect(runner.getSnapshot().games[0].plies).toBe(2)
    expect(boardFromPgn(runner.getSnapshot().games[0].pgn).history()).toHaveLength(4)
  })
  it('keeps natural repetition draws separate from explicit cap adjudications', async () => {
    const repetition = ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8']
    const natural = harness(config({ maxPlies: 8 }), async r => repetition[r.ply])
    await natural.runner.start()
    expect(natural.runner.getSnapshot().games[0].termination).toBe('threefold repetition')
    expect(standings(natural.runner.getSnapshot())[0]).toMatchObject({ draws: 2, adjudications: 0, points: 1 })
    const capped = harness(config({ maxPlies: 1 }))
    await capped.runner.start()
    expect(standings(capped.runner.getSnapshot())[0]).toMatchObject({ draws: 0, adjudications: 2, points: 1 })
    expect(exportTournamentPgn(capped.runner.getSnapshot())).toContain('[Termination "ply-cap adjudication"]')
    expect(gameEnding(new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'), 1, 1)?.termination).toBe('stalemate')
    expect(gameEnding(new Chess('7k/8/8/8/8/8/8/K7 w - - 0 1'), 1, 1)?.termination).toBe('insufficient material')
  })
})

describe('cancellation and failure are never forfeits', () => {
  it('stops immediately and ignores late non-abortable engine replies', async () => {
    const pending = deferred<string>(), entered = deferred<void>()
    const move = vi.fn<MoveProvider>(async () => { entered.resolve(); return pending.promise })
    const { runner } = harness(config(), move)
    const task = runner.start()
    await entered.promise
    runner.stop()
    await task
    pending.resolve('e4')
    await Promise.resolve()
    const state = runner.getSnapshot()
    expect(state.status).toBe('stopped')
    expect(state.games[0]).toMatchObject({ status: 'aborted', result: null, plies: 0 })
    expect(standings(state).every(row => row.played === 0 && row.points === 0)).toBe(true)
    expect(exportTournamentPgn(state)).toContain('[Result "*"]')
    expect(move).toHaveBeenCalledTimes(1)
    expect(() => parseCheckpoint(serializeCheckpoint(state))).not.toThrow()
  })
  it.each(['network unavailable', 'illegal move'])('leaves %s unscored and retries from saved position', async reason => {
    let fail = true
    const move: MoveProvider = async r => {
      if (fail) { if (reason === 'illegal move') return 'e9'; throw new Error(reason) }
      return firstLegal(r, new AbortController().signal)
    }
    const { runner } = harness(config({ maxPlies: 1 }), move)
    await runner.start()
    expect(runner.getSnapshot().status).toBe('error')
    expect(runner.getSnapshot().games[0]).toMatchObject({ status: 'error', result: null, plies: 0 })
    expect(standings(runner.getSnapshot()).every(row => row.played === 0)).toBe(true)
    fail = false
    await runner.resume()
    expect(runner.getSnapshot().status).toBe('completed')
  })
  it('pauses at a saved ply, ignores a stale reply, and resumes exactly once', async () => {
    const pending = deferred<string>(), entered = deferred<void>()
    let requests = 0
    const { runner } = harness(config({ maxPlies: 2 }), async r => {
      if (++requests === 2) { entered.resolve(); return pending.promise }
      return new Chess(r.fen).moves()[0]
    })
    const task = runner.start()
    await entered.promise
    runner.pause()
    await task
    const paused = runner.getSnapshot()
    expect(paused.status).toBe('paused')
    expect(paused.games[0].plies).toBe(1)
    expect(standings(paused).every(row => row.played === 0)).toBe(true)
    const one = runner.resume(), two = runner.resume()
    pending.resolve('e5')
    await Promise.all([one, two])
    expect(runner.getSnapshot().status).toBe('completed')
    expect(requests).toBe(5) // two old requests, retry black, then both plies of the reverse fixture
    expect(runner.getSnapshot().games.every(g => g.plies === 2)).toBe(true)
  })
  it('stops on checkpoint write failure before publishing an unpersisted ply or win', async () => {
    const runner = new TournamentRunner(createTournament(config()), {
      move: firstLegal,
      save: text => { if ((JSON.parse(text) as TournamentState).games.some(g => g.plies > 0)) throw new Error('quota') },
    })
    await runner.start()
    expect(runner.getSnapshot().status).toBe('error')
    expect(runner.getSnapshot().error).toContain('Checkpoint could not be saved')
    expect(runner.getSnapshot().games[0].plies).toBe(0)
    expect(standings(runner.getSnapshot()).every(row => row.played === 0)).toBe(true)
  })
})

describe('versioned checkpoint validation and explicit refresh resume', () => {
  it('restores history and color after refresh without an automatic move or duplicate score', async () => {
    const entered = deferred<void>(), pending = deferred<string>()
    const original = harness(config({ maxPlies: 2 }), async r => {
      if (r.ply === 1) { entered.resolve(); return pending.promise }
      return 'e4'
    })
    const originalTask = original.runner.start()
    await entered.promise
    // Simulate a crash: latest durable snapshot says running, with one legal saved ply.
    const recovered = parseCheckpoint(original.saved.at(-1)!)
    expect(recovered.status).toBe('paused')
    original.runner.stop()
    await originalTask
    const requests: Readonly<MoveRequest>[] = []
    const writes: string[] = []
    const fresh = new TournamentRunner(recovered, { move: async r => { requests.push(r); return new Chess(r.fen).moves()[0] }, save: s => writes.push(s) })
    expect(requests).toHaveLength(0)
    await fresh.start() // only Resume may continue a checkpoint
    expect(requests).toHaveLength(0)
    await fresh.resume()
    expect(requests[0]).toMatchObject({ pgn: '1. e4', ply: 1, participant: { id: recovered.games[0].blackId } })
    expect(fresh.getSnapshot().games.map(g => g.plies)).toEqual([2, 2])
    expect(standings(fresh.getSnapshot()).map(row => row.played)).toEqual([2, 2])
    writes.forEach(s => expect(() => parseCheckpoint(s)).not.toThrow())
  })
  it.each([
    ['version', (s: TournamentState) => { (s as { version: number }).version = 99 }],
    ['fixture identity', (s: TournamentState) => { s.games[0].whiteId = s.games[0].blackId }],
    ['fabricated win', (s: TournamentState) => { Object.assign(s.games[0], { status: 'completed', result: '1-0', termination: 'checkmate' }) }],
    ['FEN', (s: TournamentState) => { s.games[0].fen = new Chess().fen().replace(' w ', ' b ') }],
    ['illegal history', (s: TournamentState) => { s.games[0].pgn = '1. e5' }],
    ['missing game', (s: TournamentState) => { s.games.pop() }],
    ['plies', (s: TournamentState) => { s.games[0].plies = -1 }],
  ])('rejects corrupted %s', (_name, corrupt) => {
    const state = createTournament(config())
    corrupt(state)
    expect(() => parseCheckpoint(serializeCheckpoint(state))).toThrow()
  })
})

describe('real adapter contract', () => {
  it('passes immutable pre-move history, sampling controls, and AbortSignal to chessFetch', async () => {
    const p = DEFAULT_CONFIG.participants[0]
    const signal = new AbortController().signal
    const request = { fixtureId: 'game-1', participant: p, fen: new Chess().fen(), pgn: '', ply: 0 }
    adapters.fetch.mockResolvedValue(Response.json({ success: true, move_san: 'e4', probabilities: [] }))
    expect(await createBrowserMoveProvider().move(request, signal)).toBe('e4')
    expect(adapters.fetch).toHaveBeenCalledWith('/api/move', expect.objectContaining({ signal }))
    const body = JSON.parse(adapters.fetch.mock.calls[0][1].body)
    expect(body).toMatchObject({ fen: request.fen, pgn: '', model: 'stockfish', temperature: 0.3, turbo: true, top_p: 0.9, min_p: 0.02, stochastic: true })
    adapters.fetch.mockResolvedValue(Response.json({ success: false, error: 'offline' }, { status: 503 }))
    await expect(createBrowserMoveProvider().move(request, signal)).rejects.toThrow('offline')
  })
  it('uses actual Stockfish analyze budgets and disposes the engine on abort', async () => {
    const entered = deferred<void>(), pending = deferred<{ bestmove: string }>()
    adapters.analyze.mockImplementation(() => { entered.resolve(); return pending.promise })
    const provider = createBrowserMoveProvider(), controller = new AbortController()
    const task = provider.move({ fixtureId: 'game-1', participant: DEFAULT_CONFIG.participants[2], fen: new Chess().fen(), pgn: '', ply: 0 }, controller.signal)
    await entered.promise
    expect(adapters.analyze).toHaveBeenCalledWith(new Chess().fen(), 8, 150)
    controller.abort()
    await expect(task).rejects.toBeDefined()
    expect(adapters.dispose).toHaveBeenCalledTimes(1)
    pending.resolve({ bestmove: 'e2e4' })
  })
})
