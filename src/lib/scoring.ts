import { tokenize, type Vocab, type NextLogitsFn } from './nanogptOnnx'
import type { RawLogitStore } from './logitStore'

// Store raw logits, so temperature changes do not contaminate cached results.
// An instance belongs to exactly one model/session. Keys are the actual cropped
// input IDs; PGNs sharing a board can still have different model probabilities.
export class LogitCache {
  private entries = new Map<string, Float32Array>()
  hits = 0
  forwards = 0
  private next: NextLogitsFn
  private capacity: number
  private persistent?: RawLogitStore
  constructor(next: NextLogitsFn, capacity = 2048, persistent?: RawLogitStore) { this.next = next; this.capacity = capacity; this.persistent = persistent }
  async get(ids: number[]): Promise<Float32Array> {
    const input = ids.slice(-1024)
    const key = input.join(',')
    const cached = this.entries.get(key)
    if (cached) {
      this.entries.delete(key)
      this.entries.set(key, cached)
      this.hits++
      return cached
    }
    const restored = await this.persistent?.get(key).catch(() => undefined)
    if (restored) {
      this.entries.set(key, restored); this.hits++
      if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!)
      return restored
    }
    const logits = new Float32Array(await this.next(input))
    this.entries.set(key, logits)
    this.forwards++
    void this.persistent?.set(key, logits).catch(() => undefined)
    if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!)
    return logits
  }
}

// Exact prod-v1 SAN likelihood: no pruning, no extra terminating space, and
// temperature is applied per character. Log space avoids long-SAN underflow.
export async function exactMoveProbs(
  next: NextLogitsFn, vocab: Vocab, context: string, legalMoves: string[], temperature: number,
): Promise<Record<string, number>> {
  if (!legalMoves.length) return {}
  const prefixProbs = new Map<string, Float64Array>()
  const logs: [string, number][] = []
  const base = tokenize(context, vocab)
  for (const san of legalMoves) {
    let score = 0
    let prefix = ''
    for (const char of san) {
      let probs = prefixProbs.get(prefix)
      if (!probs) {
        const logits = await next(base.concat(tokenize(prefix, vocab)))
        const temp = Math.max(temperature, 0.001)
        const maxLogit = Math.max(...logits)
        const logSum = Math.log(Array.from(logits, value => Math.exp((value - maxLogit) / temp)).reduce((a, b) => a + b, 0))
        probs = Float64Array.from(logits, value => (value - maxLogit) / temp - logSum)
        prefixProbs.set(prefix, probs)
      }
      const id = vocab.stoi[char]
      if (id === undefined) throw new Error(`Unknown SAN character ${char}`)
      score += probs[id]
      prefix += char
    }
    logs.push([san, score])
  }
  const max = Math.max(...logs.map(([, score]) => score))
  if (!Number.isFinite(max)) throw new Error('Model assigned zero probability to every legal move')
  const weights = logs.map(([san, score]) => [san, Math.exp(score - max)] as const)
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0)
  return Object.fromEntries(weights.map(([san, weight]) => [san, weight / total]))
}
