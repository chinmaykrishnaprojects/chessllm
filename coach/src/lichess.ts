/** Public Lichess export, browser fetch, no credentials or analysis requests.
 * API: https://lichess.org/api#tag/Games/operation/apiGamesUser
 * Verified 2026-11-14: analysis[i] is White-POV AFTER ply i+1, in cp;
 * clocks[i] is remaining centiseconds after that ply. No initial eval exists.
 * Confucius/parent API: importLichessNdjson(text, username),
 * fetchLatestLichessGames(username?, options?), summarizeOpeningPatterns(games,
 * options?). Groups stay separated by speed and color; positive eval favors
 * the requested player. This module neither uploads games nor runs an engine.
 */
import { Chess } from 'chess.js'

export const LICHESS_SPEEDS = ['bullet', 'blitz', 'rapid', 'classical'] as const
export type LichessSpeed = typeof LICHESS_SPEEDS[number]
export type PlayerColor = 'white' | 'black'
export interface SuppliedEvaluation {
  cpWhite?: number; mateWhite?: number
  source: 'lichess.analysis' | 'lichess.pgn'
}
export interface LichessPly {
  /** One-based ply in this game's exported movetext. */
  ply: number; color: PlayerColor; san: string; uci: string
  fenBefore: string; fenAfter: string; evaluation?: SuppliedEvaluation
  clockRemainingCs?: number
}
export interface ImportedLichessGame {
  id: string; url: string; username: string; speed: LichessSpeed; playerColor: PlayerColor
  variant: 'standard' | 'fromPosition'
  createdAt: number; lastMoveAt?: number; status: string
  winner?: PlayerColor; opponent?: string; initialFen: string; pgn?: string
  opening?: { eco?: string; name?: string; ply?: number }
  clock?: { initialSeconds: number; incrementSeconds: number }
  moves: LichessPly[]
}
export interface LichessImport {
  username: string; games: ImportedLichessGame[]
  counts: Record<LichessSpeed, number>
  rejected: { id?: string; reason: string }[]
  /** A bounded latest-game sample, never a complete account archive. */
  completeArchive: false
  sourceUrls: string[]
}
export interface OpeningObservation {
  gameId: string; speed: LichessSpeed; color: PlayerColor; playerMove: number; ply: number
  /** Positive favors this player, independent of White/Black. */
  playerEvalCp?: number; playerMate?: number
  /** Adjacent AFTER/BEFORE position change for this player's move; may be >0. */
  signedChangeCp?: number
  /** max(0,-signedChangeCp), only with two adjacent genuine cp values.
   * An observed eval-drop estimate, NOT official Lichess ACPL, best-vs-played
   * search regret, rating change, or an inferred loss from the initial board. */
  adjacentEvalLossCp?: number
  clockRemainingCs?: number
}
export interface OpeningTrajectoryPoint {
  playerMove: number; gamesAtMove: number
  cpSamples: number; meanPlayerEvalCp?: number
  mateSamples: number; winningMateSamples: number; losingMateSamples: number
  adjacentPairSamples: number; meanSignedChangeCp?: number; meanAdjacentEvalLossCp?: number
}
export interface GameOpeningPattern {
  gameId: string; speed: LichessSpeed; color: PlayerColor; createdAt: number
  observedCpPositions: number
  baseline?: { playerMove: number; cp: number }
  trough?: { playerMove: number; cp: number }
  last?: { playerMove: number; cp: number }
  dropCp?: number; recoveryCp?: number
  /** Uses three observed points IN THIS SAME GAME; null means not measurable. */
  dipThenRecovery: boolean | null
}
export interface OpeningGroup {
  speed: LichessSpeed; color: PlayerColor; games: number; gamesWithAnyEvaluations: number
  standardStartGames: number; excludedNonstandardStartGames: number
  gamesWithOpeningEvaluations: number; observedOpeningCpPositions: number
  adjacentCpPairs: number; meanAdjacentEvalLossCp?: number
  trajectory: OpeningTrajectoryPoint[]; patterns: GameOpeningPattern[]
  patternEligibleGames: number; dipRecoveryGames: number
}
export interface OpeningReport {
  username: string; openingPlayerMoves: number; dipThresholdCp: number; recoveryThresholdCp: number
  groups: OpeningGroup[]; observations: OpeningObservation[]
  limitations: string[]
}

type Obj = Record<string, unknown>
const obj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const speedIsKnown = (v: unknown): v is LichessSpeed => LICHESS_SPEEDS.includes(v as LichessSpeed)
const ended = new Set(['mate', 'resign', 'stalemate', 'timeout', 'draw', 'outoftime', 'cheat', 'variantEnd', 'unknownFinish'])
const normalizedUser = (name: string) => name.trim().toLowerCase()
const mean = (values: number[]): number | undefined => values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined
function usernameChecked(name: string): string {
  const value = normalizedUser(name)
  if (!/^[a-z0-9_-]{2,30}$/.test(value)) throw new Error('Invalid public Lichess username')
  return value
}
function evaluation(v: unknown): SuppliedEvaluation | undefined {
  if (!obj(v)) return
  // Never translate mate to an invented cp value, or accept both score types.
  if (finite(v.eval) && v.mate === undefined) return { cpWhite: v.eval, source: 'lichess.analysis' }
  if (Number.isInteger(v.mate) && v.eval === undefined) return { mateWhite: v.mate as number, source: 'lichess.analysis' }
}
function pgnEvaluation(comment: string): SuppliedEvaluation | undefined {
  const match = comment.match(/\[%eval\s+(#[+-]?\d+|[+-]?(?:\d+(?:\.\d+)?|\.\d+))(?:,\s*\d+)?\s*\]/)
  if (!match) return
  if (match[1].startsWith('#')) return { mateWhite: Number(match[1].slice(1)), source: 'lichess.pgn' }
  const cp = Number(match[1]) * 100
  return Number.isFinite(cp) ? { cpWhite: Math.round(cp), source: 'lichess.pgn' } : undefined
}

/** Strict normalization; throws for unsupported/unfinished/unrelated records.
 * Importers record these exclusions rather than manufacturing missing games. */
export function parseLichessGame(value: unknown, username = 'sampleplayer'): ImportedLichessGame {
  const user = usernameChecked(username)
  if (!obj(value) || typeof value.id !== 'string' || !/^[a-zA-Z0-9]{8}$/.test(value.id)) throw new Error('Invalid game record/id')
  if (!speedIsKnown(value.speed)) throw new Error('Unsupported speed')
  if (value.variant !== 'standard' && value.variant !== 'fromPosition') throw new Error('Only standard chess rules are supported')
  if (value.variant === 'fromPosition' && typeof value.initialFen !== 'string') throw new Error('A fromPosition game requires its real initial FEN')
  if (typeof value.status !== 'string' || !ended.has(value.status)) throw new Error('Ongoing, aborted or unstarted game excluded')
  if (!finite(value.createdAt) || !obj(value.players)) throw new Error('Missing game timestamp/players')
  const identity = (color: PlayerColor): Obj | undefined => {
    const p = value.players as Obj
    const player = p[color]
    return obj(player) && obj(player.user) ? player.user : undefined
  }
  const matches = (color: PlayerColor) => [identity(color)?.id, identity(color)?.name].some(n => typeof n === 'string' && normalizedUser(n) === user)
  if (matches('white') === matches('black')) throw new Error('Requested player not uniquely present')
  const playerColor: PlayerColor = matches('white') ? 'white' : 'black'
  const pgn = typeof value.pgn === 'string' ? value.pgn : undefined
  const parsedPgn = new Chess()
  const comments = new Map<string, string>()
  let pgnLoaded = false
  if (pgn) {
    try {
      parsedPgn.loadPgn(pgn); pgnLoaded = true
      for (const c of parsedPgn.getComments()) comments.set(c.fen, c.comment)
    } catch { /* Valid SAN+JSON analysis can still be imported without PGN. */ }
  }
  const pgnHistory = pgnLoaded ? parsedPgn.history({ verbose: true }) : []
  const initial = typeof value.initialFen === 'string' ? value.initialFen : pgnHistory[0]?.before
  const board = new Chess(initial)
  const initialFen = board.fen()
  const sans = typeof value.moves === 'string' ? value.moves.trim().split(/\s+/).filter(Boolean) : pgnHistory.map(m => m.san)
  if (!sans.length || sans.length > 2000) throw new Error('Missing or oversized movetext')
  const analysis = Array.isArray(value.analysis) ? value.analysis : []
  const clocks = Array.isArray(value.clocks) ? value.clocks : []
  const moves: LichessPly[] = []
  for (const [i, san] of sans.entries()) {
    const before = board.fen()
    const move = board.move(san)
    if (!move) throw new Error('Illegal exported move')
    const after = board.fen()
    moves.push({ ply: i + 1, color: move.color === 'w' ? 'white' : 'black', san: move.san,
      uci: move.from + move.to + (move.promotion ?? ''), fenBefore: before, fenAfter: after,
      evaluation: evaluation(analysis[i]) ?? pgnEvaluation(comments.get(after) ?? ''),
      clockRemainingCs: finite(clocks[i]) && clocks[i] >= 0 ? clocks[i] : undefined })
  }
  if (pgnLoaded && parsedPgn.fen() !== board.fen()) throw new Error('PGN and JSON movetext disagree')
  const opponent = identity(playerColor === 'white' ? 'black' : 'white')
  const opening = obj(value.opening) ? value.opening : undefined
  const clock = obj(value.clock) && finite(value.clock.initial) && finite(value.clock.increment)
    ? { initialSeconds: value.clock.initial, incrementSeconds: value.clock.increment } : undefined
  return { id: value.id, url: `https://lichess.org/${value.id}`, username: user, speed: value.speed, variant: value.variant,
    playerColor, createdAt: value.createdAt, lastMoveAt: finite(value.lastMoveAt) ? value.lastMoveAt : undefined,
    status: value.status, winner: value.winner === 'white' || value.winner === 'black' ? value.winner : undefined,
    opponent: typeof opponent?.name === 'string' ? opponent.name : undefined, initialFen, pgn, clock,
    opening: opening ? { eco: typeof opening.eco === 'string' ? opening.eco : undefined,
      name: typeof opening.name === 'string' ? opening.name : undefined, ply: finite(opening.ply) ? opening.ply : undefined } : undefined,
    moves }
}

function emptyImport(username: string): LichessImport {
  return { username, games: [], counts: { bullet: 0, blitz: 0, rapid: 0, classical: 0 }, rejected: [], completeArchive: false, sourceUrls: [] }
}
function addRecord(result: LichessImport, raw: unknown): void {
  try {
    const game = parseLichessGame(raw, result.username)
    if (result.games.some(g => g.id === game.id)) return
    result.games.push(game); result.counts[game.speed]++
  } catch (e) { result.rejected.push({ id: obj(raw) && typeof raw.id === 'string' ? raw.id : undefined, reason: e instanceof Error ? e.message : 'Invalid game' }) }
}
/** Consumes actual downloaded NDJSON, including missing-evaluation games. */
export function importLichessNdjson(text: string, username = 'sampleplayer'): LichessImport {
  if (text.length > 20_000_000) throw new Error('Lichess sample exceeds 20 MB')
  const result = emptyImport(usernameChecked(username))
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    let raw: unknown
    try { raw = JSON.parse(line) } catch { throw new Error(`Invalid Lichess NDJSON on line ${i + 1}`) }
    addRecord(result, raw)
  }
  result.games.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
  return result
}

export interface LichessFetchOptions {
  speeds?: LichessSpeed[]; maxPerSpeed?: number; signal?: AbortSignal
  /** The deployed app's bounded, read-only public API proxy. */
  useProxy?: boolean
  onProgress?: (speed: LichessSpeed, received: number) => void
}
/** Sequential anonymous public GETs, separate latest-N sample per speed.
 * Never filters for analyzed games (which would hide evaluation coverage).
 * No retries: HTTP 429 asks the caller to wait at least a minute. */
export async function fetchLatestLichessGames(username = 'sampleplayer', options: LichessFetchOptions = {}): Promise<LichessImport> {
  const user = usernameChecked(username), max = options.maxPerSpeed ?? 20
  const speeds = [...new Set(options.speeds ?? LICHESS_SPEEDS)]
  if (!Number.isInteger(max) || max < 1 || max > 100 || speeds.some(s => !speedIsKnown(s))) throw new Error('Use 1–100 games per supported speed')
  const result = emptyImport(user)
  for (const speed of speeds) {
    options.signal?.throwIfAborted()
    const query = new URLSearchParams({ max: String(max), perfType: speed, ongoing: 'false', moves: 'true', clocks: 'true', evals: 'true', opening: 'true', pgnInJson: 'true' })
    const url = `https://lichess.org/api/games/user/${encodeURIComponent(user)}?${query}`
    const requestUrl = options.useProxy ? `/api/lichess-games?${new URLSearchParams({ username: user, speed, max: String(max) })}` : url
    const response = await fetch(requestUrl, { headers: { Accept: 'application/x-ndjson' }, credentials: 'omit', mode: 'cors', signal: options.signal, referrerPolicy: 'no-referrer' })
    if (!response.ok) throw new Error(response.status === 429 ? 'Lichess rate limit reached. Wait at least one minute; no retry was submitted.' : `Lichess export failed (HTTP ${response.status})`)
    if (!response.body) throw new Error('Lichess returned no NDJSON stream')
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let buffer = '', bytes = 0, received = 0
    const consume = (line: string) => {
      if (!line.trim()) return
      let raw: unknown
      try { raw = JSON.parse(line) } catch { throw new Error('Lichess returned malformed NDJSON') }
      if (++received > max) throw new Error('Lichess returned more than the requested bounded sample')
      if (obj(raw) && raw.speed !== speed) throw new Error('Lichess speed filter mismatch; refusing to mix samples')
      addRecord(result, raw); options.onProgress?.(speed, received)
    }
    try {
      while (true) {
        const part = await reader.read()
        options.signal?.throwIfAborted()
        if (part.value) { bytes += part.value.byteLength; buffer += decoder.decode(part.value, { stream: true }) }
        if (bytes > 20_000_000) throw new Error('Lichess response exceeds 20 MB')
        if (part.done) { buffer += decoder.decode(); if (buffer.trim()) consume(buffer); break }
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1) }
      }
    } finally { try { await reader.cancel() } catch { /* disconnected */ }; reader.releaseLock() }
    result.sourceUrls.push(url)
  }
  result.games.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
  return result
}

export interface OpeningSummaryOptions { openingPlayerMoves?: number; dipThresholdCp?: number; recoveryThresholdCp?: number }
export function summarizeOpeningPatterns(games: ImportedLichessGame[], options: OpeningSummaryOptions = {}): OpeningReport {
  const limit = options.openingPlayerMoves ?? 12, dip = options.dipThresholdCp ?? 100, recovery = options.recoveryThresholdCp ?? 100
  if (!Number.isInteger(limit) || limit < 2 || limit > 40 || !finite(dip) || !finite(recovery) || dip <= 0 || recovery <= 0) throw new Error('Use 2–40 opening player moves and positive finite dip/recovery thresholds')
  const usernames = [...new Set(games.map(g => g.username))]
  if (usernames.length > 1) throw new Error('Summarize one player at a time')
  const unique = [...new Map(games.map(g => [g.id, g])).values()]
  const standardFen = new Chess().fen()
  const isStandardStart = (g: ImportedLichessGame) => g.initialFen === standardFen
  const observations: OpeningObservation[] = [], patterns: GameOpeningPattern[] = []
  for (const game of unique) {
    // Import custom/odds games faithfully; keep their starting positions out
    // of standard-opening trajectories and report the exclusions explicitly.
    if (!isStandardStart(game)) continue
    const sign = game.playerColor === 'white' ? 1 : -1
    let playerMove = 0
    const points: { playerMove: number; cp: number }[] = []
    for (const [i, move] of game.moves.entries()) {
      if (move.color !== game.playerColor || ++playerMove > limit) continue
      const after = move.evaluation, before = i > 0 ? game.moves[i - 1].evaluation : undefined
      const cp = after?.cpWhite === undefined ? undefined : sign * after.cpWhite
      // No synthetic 0 cp initial position, no bridge across missing evals,
      // and no cross-color loss attribution to the opponent's move.
      const change = before?.cpWhite !== undefined && cp !== undefined ? cp - sign * before.cpWhite : undefined
      observations.push({ gameId: game.id, speed: game.speed, color: game.playerColor, playerMove, ply: move.ply,
        playerEvalCp: cp, playerMate: after?.mateWhite === undefined ? undefined : sign * after.mateWhite,
        signedChangeCp: change, adjacentEvalLossCp: change === undefined ? undefined : Math.max(0, -change), clockRemainingCs: move.clockRemainingCs })
      if (cp !== undefined) points.push({ playerMove, cp })
    }
    const baseline = points[0], last = points.at(-1)
    const trough = points.length >= 3 ? points.slice(1, -1).reduce((a, b) => b.cp < a.cp ? b : a) : undefined
    const drop = baseline && trough ? baseline.cp - trough.cp : undefined
    const regained = last && trough ? last.cp - trough.cp : undefined
    patterns.push({ gameId: game.id, speed: game.speed, color: game.playerColor, createdAt: game.createdAt,
      observedCpPositions: points.length, baseline, last, trough, dropCp: drop, recoveryCp: regained,
      dipThenRecovery: drop === undefined || regained === undefined ? null : drop >= dip && regained >= recovery })
  }
  const groups: OpeningGroup[] = []
  for (const speed of LICHESS_SPEEDS) for (const color of ['white', 'black'] as const) {
    const cohort = unique.filter(g => g.speed === speed && g.playerColor === color)
    const observed = observations.filter(o => o.speed === speed && o.color === color)
    const groupPatterns = patterns.filter(p => p.speed === speed && p.color === color)
    const losses = observed.flatMap(o => o.adjacentEvalLossCp === undefined ? [] : [o.adjacentEvalLossCp])
    const trajectory: OpeningTrajectoryPoint[] = []
    for (let playerMove = 1; playerMove <= limit; playerMove++) {
      const atMove = observed.filter(o => o.playerMove === playerMove)
      const cp = atMove.flatMap(o => o.playerEvalCp === undefined ? [] : [o.playerEvalCp])
      const pairs = atMove.filter(o => o.signedChangeCp !== undefined)
      trajectory.push({ playerMove, gamesAtMove: atMove.length, cpSamples: cp.length, meanPlayerEvalCp: mean(cp),
        mateSamples: atMove.filter(o => o.playerMate !== undefined).length,
        winningMateSamples: atMove.filter(o => o.playerMate !== undefined && o.playerMate > 0).length,
        losingMateSamples: atMove.filter(o => o.playerMate !== undefined && o.playerMate < 0).length,
        adjacentPairSamples: pairs.length, meanSignedChangeCp: mean(pairs.map(o => o.signedChangeCp!)),
        meanAdjacentEvalLossCp: mean(pairs.map(o => o.adjacentEvalLossCp!)) })
    }
    groups.push({ speed, color, games: cohort.length, standardStartGames: cohort.filter(isStandardStart).length,
      excludedNonstandardStartGames: cohort.filter(g => !isStandardStart(g)).length,
      gamesWithAnyEvaluations: cohort.filter(g => g.moves.some(m => m.evaluation)).length,
      gamesWithOpeningEvaluations: new Set(observed.filter(o => o.playerEvalCp !== undefined || o.playerMate !== undefined).map(o => o.gameId)).size,
      observedOpeningCpPositions: observed.filter(o => o.playerEvalCp !== undefined).length,
      adjacentCpPairs: losses.length, meanAdjacentEvalLossCp: mean(losses), trajectory, patterns: groupPatterns,
      patternEligibleGames: groupPatterns.filter(p => p.dipThenRecovery !== null).length,
      dipRecoveryGames: groupPatterns.filter(p => p.dipThenRecovery === true).length })
  }
  return { username: usernames[0] ?? '', openingPlayerMoves: limit, dipThresholdCp: dip, recoveryThresholdCp: recovery, groups, observations,
    limitations: ['Latest exported games are a bounded sample, not a complete account history.',
      'Evaluated games and evaluated positions are a selected, possibly sparse subset; counts are explicit. No missing evaluations are imputed.',
      'Positive cp is from this player’s perspective. Speeds and colors are separate; mate scores are not converted to cp.',
      'Adjacent eval loss is max(0, before-after) from supplied adjacent cp scores, not official ACPL, engine best-vs-played regret, rating change, or causal time value.',
      'Trajectory means have changing coverage at each move. Dip/recovery flags require three cp observations in the same game, but sparse points can miss an earlier/later trough.',
      'Custom/odds starting positions are imported, but excluded from standard-opening trajectories and pattern flags with explicit exclusion counts.',
      'The opening window is this player’s first N observed turns, not the ECO opening boundary. Clock values are remaining centiseconds, not elapsed thinking time.'] }
}
