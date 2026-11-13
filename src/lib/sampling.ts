export function applyDistFilters(
  moveProbs: Record<string, number>,
  topP?: number,
  minP?: number,
): Record<string, number> {
  const keys = Object.keys(moveProbs);
  if (topP !== undefined && (!Number.isFinite(topP) || topP < 0 || topP > 1)) throw new Error('Top-p must be between zero and one');
  if (minP !== undefined && (!Number.isFinite(minP) || minP < 0 || minP > 1)) throw new Error('Min-p must be between zero and one');
  if (keys.some(k => !Number.isFinite(moveProbs[k]) || moveProbs[k] < 0)) throw new Error('Invalid move probabilities');
  if (keys.length === 0) return {};
  let items = keys.map((m) => [m, moveProbs[m]] as [string, number]).sort((a, b) => b[1] - a[1]);
  const initialTotal = items.reduce((n, [, p]) => n + p, 0);
  if (initialTotal <= 0) throw new Error('Empty probability support');
  items = items.map(([m, p]) => [m, p / initialTotal]);
  if (minP !== undefined) {
    const kept = items.filter(([, p]) => p >= minP * items[0][1]);
    items = kept.length > 0 ? kept : items.slice(0, 1);
  }
  if (topP !== undefined) {
    const remainingTotal = items.reduce((n, [, p]) => n + p, 0);
    items = items.map(([m, p]) => [m, p / remainingTotal]);
    const kept: [string, number][] = [];
    let cum = 0;
    for (const it of items) {
      kept.push(it);
      cum += it[1];
      if (cum >= topP) break;
    }
    items = kept;
  }
  const total = items.reduce((a, [, p]) => a + p, 0);
  if (total <= 0) return moveProbs;
  const out: Record<string, number> = {};
  for (const [m, p] of items) out[m] = p / total;
  return out;
}

/** Weighted random choice proportional to the probabilities (rng injectable for tests). */
export function sampleFromDist(moveProbs: Record<string, number>, rng: () => number = Math.random): string {
  if (Object.values(moveProbs).some(p => !Number.isFinite(p) || p < 0)) throw new Error('Invalid move probabilities');
  const entries = Object.entries(moveProbs).filter(([, p]) => p > 0);
  if (entries.length === 0) throw new Error('Empty distribution');
  const total = entries.reduce((a, [, p]) => a + p, 0);
  const unit = rng();
  if (!Number.isFinite(unit) || unit < 0 || unit >= 1) throw new Error('Random source must return a value in [0,1)');
  let r = unit * total;
  for (const [m, p] of entries) {
    r -= p;
    if (r <= 0) return m;
  }
  return entries[entries.length - 1][0];
}
