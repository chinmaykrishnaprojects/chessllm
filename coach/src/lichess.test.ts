/** Synthetic regression fixtures only; never presented as observed games. */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { fetchLatestLichessGames, importLichessNdjson, parseLichessGame, summarizeOpeningPatterns } from './lichess'

const sans = 'e4 e5 Nf3 Nc6 Bc4 Nf6'
function fixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'test0001', variant: 'standard', speed: 'bullet', createdAt: 1000, status: 'resign',
    players: { white: { user: { id: 'sampleplayer' }, ratingDiff: 900 }, black: { user: { id: 'other' }, ratingDiff: -900 } },
    moves: sans, analysis: [{ eval: 20 }, { eval: 40 }, { eval: -200 }, { eval: -180 }, { eval: 30 }, { eval: 40 }],
    clocks: [6000, 5900, 5800, 5700, 5600, 5500], clock: { initial: 60, increment: 0 }, ...overrides }
}
afterEach(() => vi.unstubAllGlobals())

describe('public Lichess import and observed opening analysis', () => {
  it('does not invent an initial eval or first White move loss', () => {
    const game = parseLichessGame(fixture())
    const report = summarizeOpeningPatterns([game])
    const first = report.observations[0]
    expect(first.playerEvalCp).toBe(20)
    expect(first.signedChangeCp).toBe(undefined)
    expect(first.adjacentEvalLossCp).toBe(undefined)
    expect(report.groups.find(g => g.speed === 'bullet' && g.color === 'white')?.adjacentCpPairs).toBe(2)
  })
  it('measures adjacent own-move loss, not rating changes or own-turn-to-own-turn fall', () => {
    const report = summarizeOpeningPatterns([parseLichessGame(fixture())])
    const second = report.observations[1]
    expect(second.signedChangeCp).toBe(-240) // White POV: +40 after ...e5 -> -200 after Nf3
    expect(second.adjacentEvalLossCp).toBe(240)
    expect(report.observations[2].signedChangeCp).toBe(210)
    expect(report.observations[2].adjacentEvalLossCp).toBe(0)
  })
  it('normalizes Black to player perspective and attributes only Black moves', () => {
    const game = parseLichessGame(fixture({ players: { white: { user: { id: 'other' } }, black: { user: { id: 'SamplePlayer' } } } }))
    const o = summarizeOpeningPatterns([game]).observations
    expect(o[0].ply).toBe(2)
    expect(o[0].playerEvalCp).toBe(-40)
    expect(o[0].signedChangeCp).toBe(-20)
    expect(o[0].adjacentEvalLossCp).toBe(20)
    expect(o[1].signedChangeCp).toBe(-20)
  })
  it('does not bridge missing evaluations or manufacture mate centipawns', () => {
    const game = parseLichessGame(fixture({ analysis: [{ eval: 20 }, {}, { eval: -100 }, { mate: -3 }, { eval: -10 }, { mate: 0 }] }))
    const report = summarizeOpeningPatterns([game])
    expect(report.observations[1].adjacentEvalLossCp).toBe(undefined)
    expect(report.observations[2].adjacentEvalLossCp).toBe(undefined)
    const black = parseLichessGame(fixture({ players: { white: { user: { id: 'other' } }, black: { user: { id: 'sampleplayer' } } }, analysis: [{ eval: 20 }, { mate: -3 }] }))
    const observation = summarizeOpeningPatterns([black]).observations[0]
    expect(observation.playerMate).toBe(3)
    expect(observation.playerEvalCp).toBe(undefined)
  })
  it('requires an observed dip and recovery within the same game', () => {
    const report = summarizeOpeningPatterns([parseLichessGame(fixture())])
    const pattern = report.groups.find(g => g.speed === 'bullet' && g.color === 'white')!.patterns[0]
    expect(pattern.dipThenRecovery).toBe(true)
    expect(pattern.dropCp).toBe(220)
    expect(pattern.recoveryCp).toBe(230)
    const tooSparse = summarizeOpeningPatterns([parseLichessGame(fixture({ analysis: [{ eval: 20 }] }))])
    expect(tooSparse.groups.find(g => g.speed === 'bullet' && g.color === 'white')!.patterns[0].dipThenRecovery).toBe(null)
  })
  it('keeps missing-eval games in denominators and speeds/colors separate', () => {
    const imported = importLichessNdjson([fixture(), fixture({ id: 'test0002', analysis: [] }), fixture({ id: 'test0003', speed: 'blitz' })].map(g => JSON.stringify(g)).join('\n'))
    const report = summarizeOpeningPatterns(imported.games)
    const bullet = report.groups.find(g => g.speed === 'bullet' && g.color === 'white')!
    expect(bullet.games).toBe(2)
    expect(bullet.gamesWithAnyEvaluations).toBe(1)
    expect(bullet.trajectory[0].gamesAtMove).toBe(2)
    expect(bullet.trajectory[0].cpSamples).toBe(1)
    expect(report.groups.find(g => g.speed === 'blitz' && g.color === 'white')!.games).toBe(1)
    expect(report.groups.find(g => g.speed === 'bullet' && g.color === 'black')!.games).toBe(0)
  })
  it('preserves centisecond clocks and converts genuine PGN pawn evals only', () => {
    const game = parseLichessGame(fixture({ moves: 'e4 e5', analysis: [], pgn: '1. e4 { [%eval 0.25] } e5 { [%eval #-2] } 0-1' }))
    expect(game.moves[0].evaluation?.cpWhite).toBe(25)
    expect(game.moves[0].evaluation?.source).toBe('lichess.pgn')
    expect(game.moves[1].evaluation?.mateWhite).toBe(-2)
    expect(game.moves[0].clockRemainingCs).toBe(6000)
    expect(game.clock?.initialSeconds).toBe(60)
  })
  it('excludes ongoing games, deduplicates ids and sorts actual dates', () => {
    const text = [fixture(), fixture(), fixture({ id: 'test0002', createdAt: 2000 }), fixture({ id: 'test0003', status: 'started' })].map(g => JSON.stringify(g)).join('\r\n')
    const imported = importLichessNdjson(text)
    expect(imported.games.map(g => g.id)).toEqual(['test0002', 'test0001'])
    expect(imported.counts.bullet).toBe(2)
    expect(imported.rejected.length).toBe(1)
    expect(imported.completeArchive).toBe(false)
  })
  it('rejects mixed-player summaries and malformed NDJSON', () => {
    const game = parseLichessGame(fixture())
    expect(() => summarizeOpeningPatterns([game, { ...game, id: 'test0002', username: 'another' }])).toThrow()
    expect(() => importLichessNdjson('{bad json}')).toThrow()
  })
  it('fetches each speed separately, parses split NDJSON and requests evals/clocks', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      requests.push(url)
      const speed = new URL(url).searchParams.get('perfType')
      const text = JSON.stringify(fixture({ id: speed === 'bullet' ? 'test0001' : 'test0002', speed }))
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text.slice(0, 100))); c.enqueue(new TextEncoder().encode(text.slice(100) + '\n')); c.close() } }))
    })
    const result = await fetchLatestLichessGames('sampleplayer', { speeds: ['bullet', 'rapid'], maxPerSpeed: 1 })
    expect(result.counts.bullet).toBe(1)
    expect(result.counts.rapid).toBe(1)
    expect(requests.length).toBe(2)
    expect(new URL(requests[0]).searchParams.get('evals')).toBe('true')
    expect(new URL(requests[0]).searchParams.get('clocks')).toBe('true')
    expect(new URL(requests[0]).searchParams.get('ongoing')).toBe('false')
  })
  it('imports real custom starts without mixing odds games into standard openings', () => {
    const game = parseLichessGame(fixture({ variant: 'fromPosition', initialFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1' }))
    expect(game.variant).toBe('fromPosition')
    const report = summarizeOpeningPatterns([game])
    const group = report.groups.find(g => g.speed === 'bullet' && g.color === 'white')!
    expect(group.games).toBe(1)
    expect(group.excludedNonstandardStartGames).toBe(1)
    expect(group.standardStartGames).toBe(0)
    expect(report.observations.length).toBe(0)
  })
  it('stops on rate limits without retries or additional speed requests', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => { calls++; return new Response('', { status: 429 }) })
    await expect(fetchLatestLichessGames()).rejects.toThrow('Wait at least one minute')
    expect(calls).toBe(1)
  })
  it('honors cancellation before any API request', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => { calls++; return new Response('') })
    const control = new AbortController(); control.abort()
    await expect(fetchLatestLichessGames('sampleplayer', { signal: control.signal })).rejects.toThrow()
    expect(calls).toBe(0)
  })
  it('uses only the fixed same-origin proxy while retaining public source provenance', async () => {
    const requests: string[] = []
    const credentials: (RequestCredentials | undefined)[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      requests.push(url)
      credentials.push(init.credentials)
      return new Response(JSON.stringify(fixture()) + '\n')
    })
    const result = await fetchLatestLichessGames('sampleplayer', { speeds: ['bullet'], maxPerSpeed: 1, useProxy: true })
    expect(requests).toEqual(['/api/lichess-games?username=sampleplayer&speed=bullet&max=1'])
    expect(credentials).toEqual(['same-origin'])
    expect(result.sourceUrls[0]).toMatch(/^https:\/\/lichess\.org\/api\/games\/user\/sampleplayer\?/)
  })
})
