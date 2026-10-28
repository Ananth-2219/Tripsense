// Pending recordings, unfinished scoring/feedback and compact results live here.
// Remove capabilities only after both scoring and feedback finish; never archive them.
let databasePromise

function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) return reject(new Error('Device storage unavailable'))
      const request = indexedDB.open('tripsense-follow-ups', 2)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('entries')) request.result.createObjectStore('entries', { keyPath: 'id' })
        if (!request.result.objectStoreNames.contains('results')) request.result.createObjectStore('results', { keyPath: 'id' })
      }
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('Device storage blocked'))
      request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => { db.close(); databasePromise = null }
        resolve(db)
      }
    }).catch(error => { databasePromise = null; throw error })
  }
  return databasePromise
}

async function transaction(mode, operation, storeName = 'entries') {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode)
    const request = operation(tx.objectStore(storeName))
    tx.oncomplete = () => resolve(request.result)
    tx.onabort = () => reject(tx.error ?? new Error('Device storage interrupted'))
    tx.onerror = () => reject(tx.error)
  })
}

export const readEntries = () => transaction('readonly', store => store.getAll())
export const putEntry = entry => transaction('readwrite', store => store.put(entry))
export const removeEntry = id => transaction('readwrite', store => store.delete(id))
export const readResults = () => transaction('readonly', store => store.getAll(), 'results')
export async function putResult(result) {
  const db = await openDatabase()
  await new Promise((resolve, reject) => {
    const tx = db.transaction('results', 'readwrite'), store = tx.objectStore('results')
    const request = store.get(result.id)
    request.onsuccess = () => {
      const existing = request.result
      if (existing?.score.status === 'final') return
      store.put({ ...result, feedbackComplete: Boolean(result.feedbackComplete || existing?.feedbackComplete) })
    }
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error)
  })
  const all = (await readResults()).sort((a, b) => b.endedAt.localeCompare(a.endedAt))
  for (const old of all.slice(20)) await transaction('readwrite', store => store.delete(old.id), 'results')
}
