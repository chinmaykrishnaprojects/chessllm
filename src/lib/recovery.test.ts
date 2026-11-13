import { describe, expect, it, vi, afterEach } from 'vitest'
import { LogitCache, exactMoveProbs } from './scoring'
import { softmax, tokenize, computePrunedMoveProbs, type Vocab } from './nanogptOnnx'
import { fetchAsset, MODEL_CACHE, type ModelAsset } from './assetCache'

const chars = ' ;.1234567890abcdefghKQRBNOx=+#-'
const vocab: Vocab = { stoi: Object.fromEntries([...chars].map((ch, i) => [ch, i])), itos: Object.fromEntries([...chars].map((ch, i) => [i, ch])) }
const logits = async (ids: number[]) => Float32Array.from(chars, (_, i) => Math.sin(ids.reduce((a, b) => a + b, 0) + i))
const moves = ['e4', 'e3', 'd4', 'd3', 'Nf3', 'Nc3', 'Na3', 'Nh3']
afterEach(() => { vi.unstubAllGlobals() })

describe('exact SAN scores and bounded raw-logit reuse', () => {
  it('matches uncached original per-character likelihoods, without a terminating space', async () => {
    let legacyCalls = 0
    const raw: Record<string, number> = {}
    for (const san of moves) {
      let context = ';1.'
      let prob = 1
      for (const char of san) {
        prob *= softmax(await logits(tokenize(context, vocab)), 0.3)[vocab.stoi[char]]
        context += char
        legacyCalls++
      }
      raw[san] = prob
    }
    const total = Object.values(raw).reduce((a, b) => a + b, 0)
    const cache = new LogitCache(logits)
    const first = await exactMoveProbs(ids => cache.get(ids), vocab, ';1.', moves, 0.3)
    for (const san of moves) expect(first[san]).toBeCloseTo(raw[san] / total, 6)
    expect(cache.forwards).toBeLessThan(legacyCalls)
    const forwards = cache.forwards
    const repeated = await exactMoveProbs(ids => cache.get(ids), vocab, ';1.', moves, 0.3)
    expect(repeated).toEqual(first)
    expect(cache.forwards).toBe(forwards)
    const differentTemp = await exactMoveProbs(ids => cache.get(ids), vocab, ';1.', moves, 1)
    expect(cache.forwards).toBe(forwards)
    expect(differentTemp).not.toEqual(first)
    await exactMoveProbs(ids => cache.get(ids), vocab, ';1.d4 ', moves, 0.3)
    expect(cache.forwards).toBeGreaterThan(forwards)
  })
  it('bounds memory, preserves model isolation, and crops to 1024 tokens', async () => {
    const calls: number[][] = []
    const cache = new LogitCache(async ids => { calls.push(ids); return logits(ids) }, 2)
    await cache.get([1]); await cache.get([2]); await cache.get([3]); await cache.get([1])
    expect(cache.forwards).toBe(4)
    await cache.get(Array(1100).fill(2))
    expect(calls.at(-1)).toHaveLength(1024)
    const isolated = new LogitCache(async () => new Float32Array([123]))
    expect((await isolated.get([1]))[0]).toBe(123)
  })
  it('keeps the existing turbo prefix sharing and normalizes exact greedy scores', async () => {
    const cache = new LogitCache(logits)
    const first = await computePrunedMoveProbs(ids => cache.get(ids), vocab, ';1.', moves, 1)
    const calls = cache.forwards
    expect(await computePrunedMoveProbs(ids => cache.get(ids), vocab, ';1.', moves, 1)).toEqual(first)
    expect(cache.forwards).toBe(calls)
    const greedy = await exactMoveProbs(logits, vocab, ';1.', moves, 0)
    expect(Object.values(greedy).reduce((a, b) => a + b, 0)).toBeCloseTo(1)
    expect(Object.values(greedy).every(Number.isFinite)).toBe(true)
  })
})

describe('durable model download cache', () => {
  const bytes = new Uint8Array([1, 2, 3, 4])
  async function asset(): Promise<ModelAsset> {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    return { file: 'test.9f64a747.onnx', bytes: 4, sha256: Array.from(hash, b => b.toString(16).padStart(2, '0')).join('') }
  }
  function setup() {
    const entries = new Map<string, Response>()
    const match = vi.fn(async (key: string) => entries.get(key)?.clone())
    const put = vi.fn(async (key: string, value: Response) => { entries.set(key, value.clone()) })
    const remove = vi.fn(async (key: string) => entries.delete(key))
    const open = vi.fn(async () => ({ match, put, delete: remove }))
    const network = vi.fn(async () => new Response(bytes))
    vi.stubGlobal('self', { location: { origin: 'https://chess.test' } })
    vi.stubGlobal('caches', { open })
    vi.stubGlobal('fetch', network)
    return { entries, open, network, put, remove }
  }
  it('does one real fetch across independent loads and serves the second load offline', async () => {
    const { open, network } = setup()
    const model = await asset()
    expect(await fetchAsset(model)).toEqual(bytes)
    network.mockRejectedValue(new Error('offline'))
    const progress = vi.fn()
    expect(await fetchAsset(model, progress)).toEqual(bytes)
    expect(network).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(MODEL_CACHE)
    expect(progress).toHaveBeenLastCalledWith(4, 4, true)
  })
  it('recovers a truncated cache and rejects truncated or changed network bodies', async () => {
    const { entries, network, remove } = setup()
    const model = await asset()
    entries.set(`https://chess.test/models/${model.file}`, new Response(new Uint8Array([1])))
    expect(await fetchAsset(model)).toEqual(bytes)
    expect(remove).toHaveBeenCalledTimes(1)
    entries.clear()
    network.mockResolvedValue(new Response(new Uint8Array([1])))
    await expect(fetchAsset(model)).rejects.toThrow('Incomplete model')
    network.mockResolvedValue(new Response(new Uint8Array([4, 3, 2, 1])))
    await expect(fetchAsset(model)).rejects.toThrow('integrity')
  })
  it('continues when persistent storage is unavailable', async () => {
    const { open, network } = setup()
    open.mockRejectedValue(new Error('quota / private browsing'))
    expect(await fetchAsset(await asset())).toEqual(bytes)
    expect(network).toHaveBeenCalledTimes(1)
  })
  it('rejects an HTML fallback before it can poison the model cache', async () => {
    const { network, put } = setup()
    network.mockResolvedValue(new Response('<html>missing</html>', { headers: { 'Content-Type': 'text/html' } }))
    await expect(fetchAsset(await asset())).rejects.toThrow('HTML')
    expect(put).not.toHaveBeenCalled()
  })
})
