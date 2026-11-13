import { Chess } from 'chess.js'

/** Measurements belong to the position BEFORE the recorded SAN was played. */
export interface MoveTelemetry {
  source_fen: string
  source_pgn: string
  model: string
  temperature: number
  score_mode?: string
  model_entropy_bits?: number
  inference_ms?: number
  request_ms?: number
  model_forwards?: number
  cache_hits?: number
  model_probability?: number
  sampling_probability?: number
  sampling_entropy_bits?: number
  surprisal_bits?: number | null
}

export interface PlyRecord {
  san: string
  actor: 'human' | 'engine' | 'unknown'
  telemetry?: MoveTelemetry
}

/** FEN cloning drops repetition history; a PGN replay preserves it. */
export function cloneWithHistory(game: Chess): Chess {
  const clone = new Chess()
  const record = game.pgn()
  if (record) clone.loadPgn(record)
  return clone
}

export function probabilityContextKey(fen: string, pgn: string, model: string, temperature: number): string {
  return JSON.stringify([fen, pgn, model, temperature])
}

/** Only attach an async measurement to the SAN and ply that produced it. */
export function withPlyTelemetry(records: (PlyRecord | undefined)[], index: number, san: string, telemetry: MoveTelemetry): (PlyRecord | undefined)[] {
  if (records[index]?.san !== san) return records
  const updated = records.slice()
  updated[index] = { ...records[index], san, telemetry } as PlyRecord
  return updated
}

export function observedMoveProbability(probabilities: { move: string; prob: number }[], san: string): number | undefined {
  return probabilities.find(entry => entry.move === san)?.prob
}
