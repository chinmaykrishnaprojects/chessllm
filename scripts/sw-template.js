const UI_CACHE = 'chessllm-ui-__BUILD__'
const SHELL = __SHELL__
self.addEventListener('install', event => {
  event.waitUntil(caches.open(UI_CACHE).then(cache => cache.addAll(SHELL)))
  // Activate on the next page load, so an open game keeps a consistent build.
})
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter(key => key.startsWith('chessllm-ui-') && key !== UI_CACHE).map(key => caches.delete(key)))
    await self.clients.claim()
  })())
})
self.addEventListener('fetch', event => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  // Large models have their own integrity-checked, durable cache in the worker.
  if (url.pathname.startsWith('/models/') && !url.pathname.endsWith('/manifest.json')) return
  if (request.mode === 'navigate' || url.pathname.endsWith('/manifest.json')) {
    event.respondWith((async () => {
      const cache = await caches.open(UI_CACHE)
      const key = request.mode === 'navigate' ? (url.pathname.startsWith('/coach') ? '/coach/' : '/') : request
      try {
        const response = await fetch(request)
        // Shell updates activate atomically via a new SW, not per-navigation.
        if (response.ok) return response
      } catch { /* offline */ }
      return await cache.match(key, { ignoreVary: true }) || new Response('Offline: open this app online once first.', { status: 503 })
    })())
  } else if (url.pathname.startsWith('/assets/') || SHELL.includes(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(UI_CACHE)
      // Immutable same-origin filenames identify exact bytes. Vite's Vary:
      // Origin otherwise prevents a precached response from matching a module
      // script request after an offline navigation.
      const cached = await cache.match(request, { ignoreVary: true })
      if (cached) return cached
      const response = await fetch(request)
      if (response.ok) await cache.put(request, response.clone())
      return response
    })())
  }
})
