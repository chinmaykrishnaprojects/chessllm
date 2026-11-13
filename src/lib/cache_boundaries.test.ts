import { describe, expect, it } from 'vitest'
import { LogitCache } from './scoring'
import { applyDistFilters, sampleFromDist } from './sampling'
import type { RawLogitStore } from './logitStore'

describe('persistent raw-logit contract', () => {
  it('restores across sessions without inference and keeps model namespaces separate', async () => {
    const disk = new Map<string, Float32Array>()
    const store = (namespace: string): RawLogitStore => ({
      get: async key => disk.get(namespace + ':' + key),
      set: async (key, values) => { disk.set(namespace + ':' + key, values) },
    })
    const first = new LogitCache(async () => new Float32Array([3, 1]), 2, store('model-A-v1'))
    expect(Array.from(await first.get([4, 5]))).toEqual([3, 1])
    const reloaded = new LogitCache(async () => { throw new Error('Inference should not run') }, 2, store('model-A-v1'))
    expect(Array.from(await reloaded.get([4, 5]))).toEqual([3, 1])
    expect(reloaded.forwards).toBe(0)
    const different = new LogitCache(async () => new Float32Array([9, 2]), 2, store('model-B-v1'))
    expect(Array.from(await different.get([4, 5]))).toEqual([9, 2])
    expect(different.forwards).toBe(1)
    await first.get([4, 6])
    expect(first.forwards).toBe(2)
  })
  it('fails open when browser storage is unavailable', async () => {
    const cache = new LogitCache(async () => new Float32Array([2]), 2, {
      get: async () => { throw new Error('storage denied') },
      set: async () => { throw new Error('quota') },
    })
    expect((await cache.get([1]))[0]).toBe(2)
    expect((await cache.get([1]))[0]).toBe(2)
    expect(cache.forwards).toBe(1)
  })
})

describe('sampling probabilities', () => {
  it('uses min-p relative to the most likely move, not an absolute cutoff', () => {
    const result = applyDistFilters({ a: .4, b: .3, c: .2, d: .1 }, undefined, .5)
    expect(Object.keys(result)).toEqual(['a', 'b', 'c'])
    expect(result.a).toBeCloseTo(4 / 9)
    expect(Object.values(result).reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  })
  it('normalizes retained input before nucleus selection', () => {
    expect(applyDistFilters({ a: .4, b: .3 }, .5, 0)).toEqual({ a: 1 })
  })
  it('cannot select a zero-probability move at the RNG boundary', () => {
    expect(sampleFromDist({ impossible: 0, legal: 1 }, () => 0)).toBe('legal')
    expect(() => sampleFromDist({ a: 1 }, () => 1)).toThrow()
    expect(() => applyDistFilters({ a: -1 })).toThrow()
  })
})
