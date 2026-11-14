import { lineToSan } from './chess'

export interface QueenResponse {
  provider: string; model_id: string; revision: string;
  selected_move_uci: string; pv_uci: string[]; explanation: string;
  elapsed_ms: number; raw_output: unknown; move_source: string;
  fallback_used?: boolean; random_fallback?: boolean; pv_matches_selected?: boolean;
  revision_verification?: string; pv_truncated_at?: number | null;
}

export function validateQueenResponse(value: unknown, fen: string): QueenResponse {
  if (!value || typeof value !== 'object') throw new Error('Queen returned an unreadable response.')
  const r = value as QueenResponse
  if (typeof r.provider !== 'string' || typeof r.model_id !== 'string' || typeof r.revision !== 'string' || typeof r.explanation !== 'string' || typeof r.move_source !== 'string' || !Number.isFinite(r.elapsed_ms) || r.elapsed_ms < 0 || !Array.isArray(r.pv_uci) || r.pv_uci.length > 256 || !r.pv_uci.every(m => typeof m === 'string')) throw new Error('Queen returned an incomplete response.')
  try {
    lineToSan(fen, [r.selected_move_uci])
    lineToSan(fen, r.pv_uci)
  } catch { throw new Error('Queen returned an invalid move or variation for this position. No replacement move was generated.') }
  return r
}

export async function askQueen(payload: { fen: string; pgn: string; question: string; max_new_tokens: number; allow_remote: boolean }, signal: AbortSignal): Promise<QueenResponse> {
  if (payload.allow_remote !== true) throw new Error('Check the hosted Queen consent box first.')
  const response = await fetch('/api/queen/analyze', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal,
  })
  let value: unknown
  try { value = await response.json() } catch { throw new Error(`Queen endpoint unavailable (HTTP ${response.status}). Open the hosted model below, or try again later.`) }
  if (!response.ok) {
    const r = value as { error?: unknown; detail?: unknown; provider?: unknown; status?: unknown }
    const detail = [r.error, r.detail].filter(x => typeof x === 'string').join(': ')
    const source = typeof r.provider === 'string' ? ` · ${r.provider}` : ''
    throw new Error(`${detail || 'Queen is unavailable'} (HTTP ${response.status}${source}).`)
  }
  return validateQueenResponse(value, payload.fen)
}
