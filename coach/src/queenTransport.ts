/** Browser-only Queen transport. Parent integration: import { askQueen } from
 * './queenTransport'. No API keys, local Python, retry, or provider switching.
 * CORS checked 2026-11-13 using Origin https://queen-coach.example:
 * GET /config 200 ACAO reflected origin; OPTIONS /gradio_api/call/v2/analyze
 * 200 ACAO reflected origin, allow-methods POST, allow-headers content-type.
 * No inference was submitted while implementing this module (two-call cap used).
 * The existing /api/queen/analyze is an explicit optional parent-owned backend;
 * a browser transport failure never automatically uploads there.
 */
import { Chess } from 'chess.js'

export const QUEEN_PROVENANCE = Object.freeze({
  provider: 'huggingface_space',
  model_id: 'princeton-nlp/queen_pawn-8',
  revision: '5027687fac08b64b2403b13aca5b198e68294fe9',
  space_id: 'hugging-apps/queen-pawn-8',
  space_revision: 'be3887a37c4ab90e4a4ecad5605a9ece7d48250f',
  revision_verification: 'Reviewed Hub and Space revisions, not live attestation. Space loads unpinned model; loaded remote weights are not attested.',
})
export const QUEEN_SPACE_URL = 'https://hugging-apps-queen-pawn-8.hf.space'
export const QUEEN_LOCAL_BACKEND_PATH = '/api/queen/analyze'
const DEFAULT_QUESTION = 'Analyze the position carefully and find the best move for player.'
const START_FEN = new Chess().fen()
const cache = new Map<string, QueenResult>()

export interface QueenPayload {
  /** CURRENT board, never the initial board of pgn. */
  fen: string
  pgn?: string
  question?: string
  max_new_tokens?: number
  allow_remote: boolean
}

export interface QueenResult {
  provider: string
  model_id: string
  revision: string
  space_id: string
  space_revision: string
  revision_verification: string
  selected_move_uci: string
  pv_uci: string[]
  explanation: string
  elapsed_ms: number
  /** JSON model result only. Remote board HTML/SVG and summary HTML are dropped. */
  raw_output: Record<string, unknown>
  raw_text?: string
  move_source: string
  fallback_used: boolean
  random_fallback: boolean
  adapter_fallback_used: false
  status: 'ok' | 'fallback'
  fen: string
  pv_matches_selected: boolean
  pv_truncated_at?: number
  finish_reason?: string
  generated_tokens?: number
  remote_event_id?: string
  history_transmitted: boolean
  history_note?: string
  cache_hit: boolean
}

/** askQueen rejects with this structured Error; selected_move_uci stays null.
 * Existing UI try/catch can use .message, or inspect .code/.http_status. */
export class QueenTransportError extends Error {
  readonly code: string
  readonly http_status?: number
  readonly detail?: unknown
  readonly local_backend_path = QUEEN_LOCAL_BACKEND_PATH
  readonly selected_move_uci = null
  readonly pv_uci: string[] = []
  readonly adapter_fallback_used = false
  readonly provider = QUEEN_PROVENANCE.provider
  readonly model_id = QUEEN_PROVENANCE.model_id
  readonly revision = QUEEN_PROVENANCE.revision
  constructor(code: string, message: string, httpStatus?: number, detail?: unknown) {
    super(message)
    this.name = 'QueenTransportError'
    this.code = code
    this.http_status = httpStatus
    this.detail = detail
  }
  toJSON() {
    return { ...QUEEN_PROVENANCE, status: 'error', error: { code: this.code, message: this.message },
      http_status: this.http_status, selected_move_uci: null, pv_uci: [],
      adapter_fallback_used: false, local_backend_path: this.local_backend_path }
  }
}

function fail(code: string, message: string, status?: number, detail?: unknown): never {
  throw new QueenTransportError(code, message, status, detail)
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function canonicalFen(fen: string): string {
  try { return new Chess(fen).fen() }
  catch { return fail('invalid_fen', 'The current FEN is invalid. Nothing was uploaded.') }
}
function uciMove(board: Chess, uci: unknown): void {
  if (typeof uci !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) throw new Error('Invalid UCI')
  const move = board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
  if (!move) throw new Error('Illegal move')
}

function prepare(payload: QueenPayload) {
  if (!payload || payload.allow_remote !== true) fail('consent_required', 'Allow sending this public position to hosted Queen first.')
  if (typeof payload.fen !== 'string' || !payload.fen.trim() || payload.fen.length > 200 ||
      (payload.pgn != null && typeof payload.pgn !== 'string') ||
      (payload.question != null && typeof payload.question !== 'string')) fail('invalid_request', 'Expected a current FEN and optional PGN/question strings.')
  const fen = canonicalFen(payload.fen.trim())
  const board = new Chess(fen)
  if (board.isGameOver()) fail('game_over', 'This game is already over. No Queen request was sent.')
  const pgn = (payload.pgn ?? '').trim()
  const question = (payload.question ?? '').trim() || DEFAULT_QUESTION
  const tokens = payload.max_new_tokens ?? 1024
  if (pgn.length > 100_000 || question.length > 2000 || !Number.isInteger(tokens) || tokens < 128 || tokens > 2048)
    fail('invalid_request', 'PGN/question too long, or max_new_tokens outside 128–2048.')
  let initialFen = fen
  let moves: string[] = []
  if (pgn) {
    const game = new Chess()
    try { game.loadPgn(pgn) }
    catch { return fail('invalid_pgn', 'PGN could not be parsed from its standard or SetUp/FEN initial position. Nothing was uploaded.') }
    if (game.fen() !== fen) fail('pgn_position_mismatch', 'The PGN final position does not match the current board. Nothing was uploaded.')
    const history = game.history({ verbose: true })
    initialFen = history[0]?.before ?? game.fen()
    moves = history.map(move => move.from + move.to + (move.promotion ?? ''))
  }
  // Space's _resolve ignores fen whenever moves is nonempty and always starts
  // that move list from START_FEN. Preserve SetUp's CURRENT board using FEN-only;
  // explicitly report that its custom history could not be transmitted.
  const historyTransmitted = moves.length > 0 && initialFen === START_FEN
  const historyNote = moves.length && !historyTransmitted
    ? 'Queen received the current FEN only: this Space cannot encode history from a custom SetUp/FEN start.' : undefined
  const request = { fen: historyTransmitted ? START_FEN : fen,
    moves: historyTransmitted ? moves.join(' ') : '', max_tokens: tokens,
    temperature: 0.6, seed: 20260823, prompt: question }
  // Include complete canonical history even when upstream cannot transmit it.
  const key = JSON.stringify([QUEEN_PROVENANCE, fen, initialFen, moves, request])
  return { fen, request, key, historyTransmitted, historyNote }
}

function normalize(data: unknown, fen: string, elapsed: number, historyTransmitted: boolean, historyNote?: string): QueenResult {
  if (!Array.isArray(data) || data.length !== 4 || !record(data[3]) || typeof data[2] !== 'string')
    fail('invalid_remote_output', 'Queen returned an unexpected response structure.')
  const raw = data[3]
  if (typeof raw.fen !== 'string' || canonicalFen(raw.fen) !== fen)
    fail('remote_position_mismatch', 'Queen returned analysis for a different position. No move was substituted.')
  const source = raw.move_source
  if (typeof source !== 'string' || !['best_move', 'critical_line', 'promising_or_analysis', 'random_legal_fallback', 'no_legal_moves'].includes(source))
    fail('unknown_move_source', 'Queen omitted a recognized move_source. No move was substituted.')
  const selected = raw.best_move_uci
  try { uciMove(new Chess(fen), selected) }
  catch { return fail('illegal_remote_move', 'Queen returned no legal selected move. No replacement was generated.') }
  let line: unknown = raw.critical_line_uci
  if (line == null) {
    const critical = raw.critical_line
    if (!record(critical) || !Array.isArray(critical.legal_steps)) fail('invalid_remote_output', 'Queen omitted its critical line.')
    line = critical.legal_steps.map(step => record(step) ? step.uci : null)
  }
  if (!Array.isArray(line) || line.length > 256) fail('invalid_remote_output', 'Queen returned an invalid or oversized variation.')
  const pv: string[] = []
  const check = new Chess(fen)
  let truncatedAt: number | undefined
  for (const move of line) {
    try { uciMove(check, move) }
    catch { truncatedAt = pv.length; break }
    pv.push(move as string)
  }
  const fallback = ['critical_line', 'promising_or_analysis', 'random_legal_fallback'].includes(source)
  // data[0] (SVG/HTML) and data[1] (UI summary) are never returned or cached.
  return { ...QUEEN_PROVENANCE, selected_move_uci: selected as string, pv_uci: pv,
    explanation: data[2], elapsed_ms: elapsed, raw_output: raw,
    raw_text: typeof raw.raw_text === 'string' ? raw.raw_text : undefined,
    move_source: source, fallback_used: fallback, random_fallback: source === 'random_legal_fallback',
    adapter_fallback_used: false, status: fallback ? 'fallback' : 'ok', fen,
    pv_matches_selected: pv.length > 0 && pv[0] === selected, pv_truncated_at: truncatedAt,
    finish_reason: typeof raw.finish_reason === 'string' ? raw.finish_reason : undefined,
    generated_tokens: typeof raw.generated_tokens === 'number' ? raw.generated_tokens : undefined,
    history_transmitted: historyTransmitted, history_note: historyNote, cache_hit: false }
}

async function checkedFetch(url: string, init: RequestInit): Promise<Response> {
  const response = await fetch(url, { ...init, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 4000)
    const code = [401, 403].includes(response.status) ? 'remote_auth_required' : response.status === 429 ? 'remote_quota' : 'remote_http_error'
    fail(code, `Queen Space returned HTTP ${response.status}. ${code === 'remote_auth_required' ? 'This public ZeroGPU request may require Hugging Face login; no credentials were used.' : code === 'remote_quota' ? 'Free ZeroGPU quota is unavailable; no retry was submitted.' : 'No retry or provider switch was attempted.'}`, response.status, detail)
  }
  return response
}

async function readComplete(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) fail('missing_stream', 'Queen returned no event stream.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = '', event = '', lines: string[] = [], bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      if (value) { bytes += value.byteLength; pending += decoder.decode(value, { stream: true }) }
      if (bytes > 2_000_000) fail('response_too_large', 'Queen event stream exceeded the response size limit.')
      if (done) pending += decoder.decode() + '\n\n'
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, '')
        pending = pending.slice(newline + 1)
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''))
        else if (!line && lines.length) {
          let data: unknown
          try { data = JSON.parse(lines.join('\n')) }
          catch { return fail('invalid_event', 'Queen returned malformed event JSON.') }
          if (event === 'complete') return data
          if (event === 'error') {
            const detail = JSON.stringify(data)
            const code = /quota|exceed|rate.limit/i.test(detail) ? 'remote_quota' : /login|log.in|auth|token/i.test(detail) ? 'remote_auth_required' : 'remote_error'
            fail(code, `Queen ZeroGPU rejected the request: ${detail.slice(0, 1000)}. No retry was submitted.`, 503, data)
          }
          event = ''; lines = []
        }
      }
      if (done) break
    }
    return fail('remote_incomplete', 'Queen disconnected without a complete result. Remote work may continue; no retry was submitted.')
  } finally {
    try { await reader.cancel() } catch { /* already closed/aborted */ }
    reader.releaseLock()
  }
}

/** Returns a validated result or rejects with QueenTransportError. Success-only
 * 32-entry LRU, full context keys, no persistent storage, no auto retries. */
export async function askQueen(payload: QueenPayload, signal?: AbortSignal): Promise<QueenResult> {
  if (signal?.aborted) throw new QueenTransportError('aborted', 'Queen request cancelled before submission.')
  const prepared = prepare(payload)
  const cached = cache.get(prepared.key)
  if (cached) {
    cache.delete(prepared.key); cache.set(prepared.key, cached)
    return { ...structuredClone(cached), cache_hit: true }
  }
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', abort, { once: true })
  // Close the race between the first aborted check and listener registration.
  if (signal?.aborted) abort()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, 60_000)
  const started = performance.now()
  try {
    const submit = await checkedFetch(`${QUEEN_SPACE_URL}/gradio_api/call/v2/analyze`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prepared.request), signal: controller.signal,
    })
    const submission: unknown = await submit.json()
    if (!record(submission) || typeof submission.event_id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(submission.event_id))
      fail('invalid_submission', 'Queen did not return a valid Gradio event ID.')
    const events = await checkedFetch(`${QUEEN_SPACE_URL}/gradio_api/call/analyze/${encodeURIComponent(submission.event_id)}`, {
      method: 'GET', signal: controller.signal,
    })
    const data = await readComplete(events, controller.signal)
    const result = normalize(data, prepared.fen, Math.round(performance.now() - started), prepared.historyTransmitted, prepared.historyNote)
    result.remote_event_id = submission.event_id
    cache.set(prepared.key, structuredClone(result))
    if (cache.size > 32) cache.delete(cache.keys().next().value as string)
    return result
  } catch (error) {
    if (timedOut) throw new QueenTransportError('remote_timeout', 'Queen exceeded the 60-second deadline. Remote work may continue; no retry was submitted.', 504)
    if (signal?.aborted) throw new QueenTransportError('aborted', 'Queen request cancelled. Remote work may continue; no retry was submitted.')
    if (error instanceof QueenTransportError) throw error
    if (error instanceof TypeError) throw new QueenTransportError('network_or_cors', 'The browser could not reach Queen Space (network or CORS). No retry was submitted. The parent may explicitly select the existing local backend /api/queen/analyze; it is never used automatically.', undefined, error.message)
    throw new QueenTransportError('transport_error', error instanceof Error ? error.message : 'Queen returned an unreadable response.')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
