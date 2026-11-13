/** Device-only cache of raw model logits. Namespace includes model/vocabulary hashes. */
export interface RawLogitStore { get(key: string): Promise<Float32Array | undefined>; set(key: string, values: Float32Array): Promise<void> }
export class BrowserLogitStore implements RawLogitStore {
  private ready: Promise<IDBDatabase | undefined>
  private namespace: string
  constructor(namespace: string) {
    this.namespace = namespace
    this.ready = new Promise(resolve => {
      if (typeof indexedDB === 'undefined') return resolve(undefined)
      try {
        const request = indexedDB.open('chessllm-logits-v1', 1)
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore('entries', { keyPath: 'key' })
          store.createIndex('created', 'created')
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = request.onblocked = () => resolve(undefined)
      } catch { resolve(undefined) }
    })
  }
  async get(context: string) {
    const db = await this.ready
    if (!db) return undefined
    return new Promise<Float32Array | undefined>(resolve => {
      try {
        const request = db.transaction('entries', 'readonly').objectStore('entries').get(`${this.namespace}:${context}`)
        request.onsuccess = () => {
          const values = request.result?.values
          resolve(values instanceof Float32Array && values.length === 32 && values.every(Number.isFinite) ? values : undefined)
        }
        request.onerror = () => resolve(undefined)
      } catch { resolve(undefined) }
    })
  }
  async set(context: string, values: Float32Array) {
    const db = await this.ready
    if (!db) return
    await new Promise<void>(resolve => {
      try {
        const tx = db.transaction('entries', 'readwrite'), store = tx.objectStore('entries')
        store.put({ key: `${this.namespace}:${context}`, created: Date.now(), values })
        const count = store.count()
        count.onsuccess = () => {
          let remove = count.result - 4096
          if (remove <= 0) return
          const cursor = store.index('created').openCursor()
          cursor.onsuccess = () => {
            if (!cursor.result || remove-- <= 0) return
            cursor.result.delete(); cursor.result.continue()
          }
        }
        tx.oncomplete = tx.onerror = tx.onabort = () => resolve()
      } catch { resolve() }
    })
  }
}
