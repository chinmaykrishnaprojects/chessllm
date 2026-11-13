import { Chess } from 'chess.js'

export type Participant = {
  id: string
  name: string
} & ({ kind: 'chessgpt'; model: 'stockfish' | 'lichess'; temperature: number; turbo: boolean; topP: number; minP: number }
  | { kind: 'stockfish'; depth: number; movetimeMs: number })
export interface TournamentConfig { participants: Participant[]; cycles: number; maxPlies: number; seedPgn: string }
export type Result = '1-0' | '0-1' | '1/2-1/2'
export type Termination = 'checkmate' | 'stalemate' | 'threefold repetition' | 'fifty-move rule' | 'insufficient material' | 'natural draw' | 'ply-cap adjudication'
export interface Fixture { id: string; cycle: number; whiteId: string; blackId: string }
export interface TournamentGame extends Fixture {
  status: 'pending' | 'running' | 'completed' | 'aborted' | 'error'
  pgn: string
  fen: string
  plies: number
  result: Result | null
  termination: Termination | null
  error?: string
}
export interface TournamentState {
  version: 1
  id: string
  createdAt: string
  updatedAt: string
  config: TournamentConfig
  status: 'idle' | 'running' | 'paused' | 'stopped' | 'completed' | 'error'
  games: TournamentGame[]
  error?: string
}
export const CHECKPOINT_KEY = 'chessllm.tournament.v1'
export const DEFAULT_CONFIG: TournamentConfig = {
  participants: [
    { id: 'gpt-stockfish', name: 'Stockfish-trained ChessGPT', kind: 'chessgpt', model: 'stockfish', temperature: 0.3, turbo: true, topP: 0.9, minP: 0.02 },
    { id: 'gpt-lichess', name: 'Lichess-trained ChessGPT', kind: 'chessgpt', model: 'lichess', temperature: 0.3, turbo: true, topP: 0.9, minP: 0.02 },
    { id: 'stockfish', name: 'Stockfish', kind: 'stockfish', depth: 8, movetimeMs: 150 },
  ], cycles: 1, maxPlies: 40, seedPgn: '',
}

function bounded(value: unknown, min: number, max: number, name: string, integer = false): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be ${integer ? 'an integer ' : ''}from ${min} to ${max}`)
  }
}

/** Replay from the normal initial position: FEN alone cannot supply the native model's history. */
export function boardFromPgn(pgn: string): Chess {
  if (typeof pgn !== 'string' || pgn.length > 200_000) throw new Error('Invalid PGN')
  const loaded = new Chess()
  loaded.loadPgn(pgn)
  const headers = loaded.getHeaders()
  if (Object.keys(headers).some(key => /^(fen|setup)$/i.test(key))) {
    throw new Error('Use PGN history from the standard starting position; arbitrary FEN is unsupported for ChessGPT')
  }
  const board = new Chess()
  for (const san of loaded.history()) {
    if (board.isGameOver()) throw new Error('PGN continues after a natural game ending')
    board.move(san)
  }
  return board
}

/** Header-free, stable move text for the recovered model tokenizer. */
export function moveText(board: Chess): string {
  return board.history().map((san, i) => `${i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ` : ''}${san}`).join(' ')
}

export function validateConfig(config: TournamentConfig): TournamentConfig {
  if (!config || !Array.isArray(config.participants) || config.participants.length < 2 || config.participants.length > 12) throw new Error('Select 2–12 participants')
  bounded(config.cycles, 1, 20, 'Paired rounds', true)
  bounded(config.maxPlies, 1, 1000, 'Ply cap', true)
  const ids = new Set<string>()
  for (const p of config.participants) {
    if (!p || typeof p.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.id) || ids.has(p.id)) throw new Error('Participant IDs must be unique')
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 120) throw new Error('Invalid participant name')
    ids.add(p.id)
    if (p.kind === 'chessgpt') {
      if (!['stockfish', 'lichess'].includes(p.model) || typeof p.turbo !== 'boolean') throw new Error('Invalid ChessGPT settings')
      bounded(p.temperature, 0, 5, 'Temperature')
      bounded(p.topP, 0.01, 1, 'Top p')
      bounded(p.minP, 0, 1, 'Min p')
    } else if (p.kind === 'stockfish') {
      bounded(p.depth, 1, 40, 'Stockfish depth', true)
      bounded(p.movetimeMs, 10, 60_000, 'Stockfish milliseconds', true)
    } else throw new Error('Unknown participant kind')
  }
  const seed = boardFromPgn(config.seedPgn)
  if (seed.isGameOver()) throw new Error('Seed PGN is already game over')
  return { ...structuredClone(config), seedPgn: moveText(seed) }
}

export function createFixtures(participants: Pick<Participant, 'id'>[], cycles = 1): Fixture[] {
  const fixtures: Fixture[] = []
  for (let cycle = 1; cycle <= cycles; cycle++) {
    for (let i = 0; i < participants.length; i++) {
      for (let j = i + 1; j < participants.length; j++) {
        for (const [white, black] of [[participants[i], participants[j]], [participants[j], participants[i]]]) {
          fixtures.push({ id: `game-${fixtures.length + 1}`, cycle, whiteId: white.id, blackId: black.id })
        }
      }
    }
  }
  return fixtures
}

export function createTournament(input: TournamentConfig): TournamentState {
  const config = validateConfig(input)
  const now = new Date().toISOString()
  const fen = boardFromPgn(config.seedPgn).fen()
  return {
    version: 1, id: crypto.randomUUID(), createdAt: now, updatedAt: now, config, status: 'idle',
    games: createFixtures(config.participants, config.cycles).map(f => ({ ...f, status: 'pending', pgn: config.seedPgn, fen, plies: 0, result: null, termination: null })),
  }
}

export function gameEnding(board: Chess, plies: number, cap: number): { result: Result; termination: Termination } | null {
  if (board.isCheckmate()) return { result: board.turn() === 'w' ? '0-1' : '1-0', termination: 'checkmate' }
  if (board.isGameOver()) {
    const termination = board.isStalemate() ? 'stalemate' : board.isThreefoldRepetition() ? 'threefold repetition'
      : board.isInsufficientMaterial() ? 'insufficient material' : board.isDrawByFiftyMoves() ? 'fifty-move rule' : 'natural draw'
    return { result: '1/2-1/2', termination }
  }
  return plies >= cap ? { result: '1/2-1/2', termination: 'ply-cap adjudication' } : null
}

export interface Standing { id: string; name: string; played: number; wins: number; losses: number; draws: number; adjudications: number; points: number }
export function standings(state: TournamentState): Standing[] {
  const rows = new Map(state.config.participants.map(p => [p.id, { id: p.id, name: p.name, played: 0, wins: 0, losses: 0, draws: 0, adjudications: 0, points: 0 }]))
  for (const game of state.games) {
    if (game.status !== 'completed' || !game.result) continue
    const white = rows.get(game.whiteId)!, black = rows.get(game.blackId)!
    white.played++; black.played++
    if (game.result === '1/2-1/2') {
      white.points += 0.5; black.points += 0.5
      if (game.termination === 'ply-cap adjudication') { white.adjudications++; black.adjudications++ }
      else { white.draws++; black.draws++ }
    } else {
      const winner = game.result === '1-0' ? white : black, loser = game.result === '1-0' ? black : white
      winner.wins++; winner.points++; loser.losses++
    }
  }
  return [...rows.values()].sort((a, b) => b.points - a.points || b.wins - a.wins || a.name.localeCompare(b.name))
}

export function serializeCheckpoint(state: TournamentState): string { return JSON.stringify(state) }

/** Validate identity, legal history, schedule and scoring, then require explicit resume. */
export function parseCheckpoint(text: string): TournamentState {
  if (text.length > 5_000_000) throw new Error('Checkpoint is too large')
  const state = JSON.parse(text) as TournamentState
  if (!state || state.version !== 1) throw new Error('Unsupported tournament checkpoint version')
  if (typeof state.id !== 'string' || !state.id || !Number.isFinite(Date.parse(state.createdAt)) || !Number.isFinite(Date.parse(state.updatedAt))) throw new Error('Invalid checkpoint identity')
  const config = validateConfig(state.config)
  if (config.seedPgn !== state.config.seedPgn) throw new Error('Invalid checkpoint seed')
  if (!['idle', 'running', 'paused', 'stopped', 'completed', 'error'].includes(state.status)) throw new Error('Invalid checkpoint status')
  const expected = createFixtures(config.participants, config.cycles)
  if (!Array.isArray(state.games) || expected.length !== state.games.length) throw new Error('Checkpoint schedule mismatch')
  const seedHistory = boardFromPgn(config.seedPgn).history()
  let unfinished = false
  let activeCount = 0
  for (const [i, game] of state.games.entries()) {
    const fixture = expected[i]
    if (!game || game.id !== fixture.id || game.cycle !== fixture.cycle || game.whiteId !== fixture.whiteId || game.blackId !== fixture.blackId) throw new Error('Checkpoint fixture identity mismatch')
    if (!['pending', 'running', 'completed', 'aborted', 'error'].includes(game.status)) throw new Error('Invalid game status')
    if (game.error !== undefined && typeof game.error !== 'string') throw new Error('Invalid game error')
    bounded(game.plies, 0, config.maxPlies, 'Saved plies', true)
    const board = boardFromPgn(game.pgn), history = board.history()
    if (game.pgn !== moveText(board) || board.fen() !== game.fen || history.length !== seedHistory.length + game.plies || seedHistory.some((san, j) => history[j] !== san)) throw new Error('Checkpoint PGN/FEN/history mismatch')
    const ending = gameEnding(board, game.plies, config.maxPlies)
    if (game.status === 'completed') {
      if (unfinished || !ending || game.result !== ending.result || game.termination !== ending.termination) throw new Error('Invalid completed result')
    } else {
      unfinished = true
      if (game.result !== null || game.termination !== null || ending) throw new Error('Unfinished game cannot have a result')
      if (game.status === 'pending') {
        if (game.plies !== 0) throw new Error('Pending game has moves')
      } else {
        activeCount++
        if (activeCount > 1 || state.games.slice(0, i).some(g => g.status !== 'completed')) throw new Error('Invalid active game order')
      }
    }
  }
  if ((state.status === 'completed') !== !unfinished || (state.status === 'idle' && state.games.some(g => g.status !== 'pending')) || (state.status !== 'stopped' && state.games.some(g => g.status === 'aborted'))) throw new Error('Inconsistent tournament status')
  if (state.error !== undefined && typeof state.error !== 'string') throw new Error('Invalid checkpoint error')
  return { ...state, config, status: state.status === 'running' ? 'paused' : state.status }
}

export interface MoveRequest {
  readonly fixtureId: string
  readonly participant: Readonly<Participant>
  readonly fen: string
  readonly pgn: string
  readonly ply: number
}
export type MoveProvider = (request: Readonly<MoveRequest>, signal: AbortSignal) => Promise<string>
export interface PositionEvent {
  readonly fixtureId: string; readonly fen: string; readonly pgn: string; readonly preMoveFen: string; readonly preMovePgn: string; readonly san: string
}
interface RunnerOptions {
  move: MoveProvider
  save: (checkpoint: string) => void
  onState?: (state: TournamentState) => void
  onPosition?: (position: Readonly<PositionEvent>) => void
  dispose?: () => void
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

/** A single sequential runner. Abort and epoch checks discard even uncooperative late replies. */
export class TournamentRunner {
  private state: TournamentState
  private controller: AbortController | null = null
  private task: Promise<void> | null = null
  private epoch = 0
  private options: RunnerOptions
  constructor(state: TournamentState, options: RunnerOptions) {
    this.state = parseCheckpoint(serializeCheckpoint(state))
    this.options = options
  }
  getSnapshot(): TournamentState { return structuredClone(this.state) }
  private publish(next: TournamentState) {
    const candidate = { ...next, updatedAt: new Date().toISOString() }
    try { this.options.save(serializeCheckpoint(candidate)) }
    catch (error) {
      this.state = { ...this.state, status: 'error', error: `Checkpoint could not be saved: ${error instanceof Error ? error.message : String(error)}` }
      this.options.onState?.(this.getSnapshot())
      throw error
    }
    this.state = candidate
    this.options.onState?.(this.getSnapshot())
  }
  private changeGame(index: number, game: TournamentGame) {
    const games = this.state.games.map((g, i) => i === index ? game : g)
    this.publish({ ...this.state, games, status: games.every(g => g.status === 'completed') ? 'completed' : this.state.status })
  }
  start(): Promise<void> {
    if (this.state.status !== 'idle') return Promise.resolve()
    return this.launch()
  }
  async resume(): Promise<void> {
    const epoch = this.epoch
    if (this.task) await this.task
    if (epoch !== this.epoch || !['paused', 'error'].includes(this.state.status)) return
    await this.launch()
  }
  private launch(): Promise<void> {
    const epoch = ++this.epoch
    const controller = new AbortController()
    this.controller = controller
    const task = this.run(epoch, controller.signal).finally(() => {
      if (this.controller === controller) { this.controller = null; this.task = null; this.options.dispose?.() }
    })
    this.task = task
    return task
  }
  pause() {
    if (this.state.status !== 'running') return
    this.cancel()
    this.publish({ ...this.state, status: 'paused' })
  }
  stop() {
    if (!['running', 'paused', 'error'].includes(this.state.status)) return
    this.cancel()
    const index = this.state.games.findIndex(g => g.status !== 'completed')
    this.publish({ ...this.state, status: 'stopped', error: undefined, games: this.state.games.map((g, i) => i === index ? { ...g, status: 'aborted', result: null, termination: null, error: undefined } : g) })
  }
  /** Safe for unmount: persist as paused, never award a result. */
  dispose() {
    if (this.state.status === 'running') this.pause()
    else this.cancel()
  }
  private cancel() { ++this.epoch; this.controller?.abort(); this.options.dispose?.() }
  private async run(epoch: number, signal: AbortSignal) {
    let index = -1
    try {
      this.publish({ ...this.state, status: 'running', error: undefined })
      while (epoch === this.epoch && !signal.aborted) {
        index = this.state.games.findIndex(g => g.status !== 'completed')
        if (index < 0) { this.publish({ ...this.state, status: 'completed' }); return }
        let game = this.state.games[index]
        const board = boardFromPgn(game.pgn)
        this.changeGame(index, { ...game, status: 'running', error: undefined })
        while (epoch === this.epoch && !signal.aborted) {
          game = this.state.games[index]
          const playerId = board.turn() === 'w' ? game.whiteId : game.blackId
          const participant = this.state.config.participants.find(p => p.id === playerId)!
          const request = Object.freeze({ fixtureId: game.id, participant: Object.freeze({ ...participant }), fen: board.fen(), pgn: moveText(board), ply: game.plies })
          const reply = await abortable(this.options.move(request, signal), signal)
          if (epoch !== this.epoch || signal.aborted) return
          const move = /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(reply)
            ? board.move({ from: reply.slice(0, 2), to: reply.slice(2, 4), promotion: reply[4] }) : board.move(reply)
          const plies = game.plies + 1
          const ending = gameEnding(board, plies, this.state.config.maxPlies)
          // Persist a terminal ply and its score atomically, too.
          this.changeGame(index, { ...game, status: ending ? 'completed' : 'running', pgn: moveText(board), fen: board.fen(), plies, result: ending?.result ?? null, termination: ending?.termination ?? null, error: undefined })
          const position = Object.freeze({ fixtureId: game.id, fen: board.fen(), pgn: moveText(board), preMoveFen: request.fen, preMovePgn: request.pgn, san: move.san })
          this.options.onPosition?.(position)
          if (ending) break
          // Yield to browser controls even with a cached model or an instant engine.
          await abortable(new Promise<void>(resolve => setTimeout(resolve, 0)), signal)
        }
      }
    } catch (error) {
      if (epoch !== this.epoch || signal.aborted) return
      const message = this.state.error?.startsWith('Checkpoint could not be saved:') ? this.state.error : error instanceof Error ? error.message : String(error)
      // Never convert engine, network, illegal-move, or persistence errors into forfeits.
      const games = this.state.games.map((g, i) => i === index && g.status !== 'completed' ? { ...g, status: 'error' as const, error: message, result: null, termination: null } : g)
      try { this.publish({ ...this.state, games, status: 'error', error: message }) } catch { /* already exposed the persistence error */ }
    }
  }
}

/** Real adapters, lazily loaded so tests and setup don't download either engine. */
export function createBrowserMoveProvider(): { move: MoveProvider; dispose: () => void } {
  let engine: { analyze: (fen: string, depth?: number, movetimeMs?: number) => Promise<{ bestmove: string }>; dispose: () => void } | undefined
  const dispose = () => { engine?.dispose(); engine = undefined }
  const move: MoveProvider = async (request, signal) => {
    signal.throwIfAborted()
    const p = request.participant
    if (p.kind === 'stockfish') {
      const { getStockfishEngine } = await import('./stockfishUci')
      signal.throwIfAborted()
      const readyEngine = await getStockfishEngine()
      signal.throwIfAborted()
      engine = readyEngine
      signal.addEventListener('abort', dispose, { once: true })
      try { return (await abortable(engine.analyze(request.fen, p.depth, p.movetimeMs), signal)).bestmove }
      finally { signal.removeEventListener('abort', dispose) }
    }
    const { chessFetch } = await import('./recoveryApi')
    signal.throwIfAborted()
    const response = await chessFetch('/api/move', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ fen: request.fen, pgn: request.pgn, model: p.model, temperature: p.temperature, turbo: p.turbo, top_p: p.topP, min_p: p.minP, stochastic: p.temperature > 0 }),
    })
    const data = await response.json()
    if (!response.ok || !data.success || typeof data.move_san !== 'string') throw new Error(data.error || 'ChessGPT returned no move')
    return data.move_san
  }
  return { move, dispose }
}

function tag(value: string): string { return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ') }
export function participantDescription(p: Participant): string {
  return p.kind === 'stockfish' ? `Stockfish depth ≤${p.depth}, ≤${p.movetimeMs} ms/move` : `${p.model}-trained ChessGPT; temperature ${p.temperature}; ${p.turbo ? 'Turbo' : 'exact'}; top_p ${p.topP}; min_p ${p.minP}`
}
export function exportTournamentPgn(state: TournamentState): string {
  return state.games.filter(g => g.status !== 'pending').map(game => {
    const white = state.config.participants.find(p => p.id === game.whiteId)!, black = state.config.participants.find(p => p.id === game.blackId)!
    const result = game.status === 'completed' ? game.result! : '*'
    const headers: Record<string, string> = { Event: 'ChessLLM browser tournament', Site: 'Browser', Date: state.createdAt.slice(0, 10).replace(/-/g, '.'), Round: `${game.cycle}.${game.id.slice(5)}`, White: white.name, Black: black.name, Result: result, WhiteId: white.id, BlackId: black.id, WhiteSettings: participantDescription(white), BlackSettings: participantDescription(black), TournamentId: state.id, Termination: game.termination ?? `${game.status} (unscored)`, PlyCount: String(boardFromPgn(game.pgn).history().length) }
    return `${Object.entries(headers).map(([key, value]) => `[${key} "${tag(value)}"]`).join('\n')}\n\n${game.pgn}${game.pgn ? ' ' : ''}${result}`
  }).join('\n\n')
}
