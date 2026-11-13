export const MODEL_CACHE = 'chessllm-models-v1'

export interface ModelAsset { file: string; bytes: number; sha256: string }
export interface ModelManifest {
  vocab: ModelAsset
  stockfish: ModelAsset
  lichess: ModelAsset
  stockfishKv: ModelAsset
  lichessKv: ModelAsset
}

// CacheStorage survives reloads and works in workers. A failed storage write must
// never prevent play (private browsing / quota limits still allow a network load).
export async function fetchAsset(
  asset: ModelAsset,
  progress: (loaded: number, total: number, cached: boolean) => void = () => {},
): Promise<Uint8Array> {
  const url = new URL(`${import.meta.env.BASE_URL}models/${asset.file}`, self.location.origin).href
  let cache: Cache | undefined
  try { cache = await caches.open(MODEL_CACHE) } catch { /* storage unavailable */ }
  let response: Response | undefined
  try { response = await cache?.match(url) } catch { /* use network */ }
  if (response) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength === asset.bytes) {
      progress(bytes.byteLength, asset.bytes, true)
      return bytes
    }
    await cache?.delete(url).catch(() => false)
  }
  response = await fetch(url)
  if (!response.ok) throw new Error(`Model download failed: HTTP ${response.status}`)
  if (response.headers.get('content-type')?.includes('text/html')) throw new Error('Model URL returned HTML')
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      loaded += value.byteLength
      progress(loaded, asset.bytes, false)
    }
  } else {
    const bytes = new Uint8Array(await response.arrayBuffer())
    chunks.push(bytes)
    loaded = bytes.byteLength
  }
  if (loaded !== asset.bytes) throw new Error(`Incomplete model: expected ${asset.bytes} bytes, received ${loaded}`)
  const bytes = new Uint8Array(loaded)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hash = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('')
  if (hash !== asset.sha256) throw new Error('Model integrity check failed')
  try {
    await cache?.put(url, new Response(bytes, { headers: {
      'Content-Type': asset.file.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      'Content-Length': String(loaded),
    } }))
  } catch { /* quota / persistence is best effort */ }
  progress(loaded, asset.bytes, false)
  return bytes
}
