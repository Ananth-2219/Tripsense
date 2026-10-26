// Only local, unsent recordings and unfinished questionnaires live here.
// Successful feedback submission or Skip removes the local capability token.
let databasePromise

function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) return reject(new Error('Device storage unavailable'))
      const request = indexedDB.open('tripsense-follow-ups', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('entries', { keyPath: 'id' })
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

async function transaction(mode, operation) {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('entries', mode)
    const request = operation(tx.objectStore('entries'))
    tx.oncomplete = () => resolve(request.result)
    tx.onabort = () => reject(tx.error ?? new Error('Device storage interrupted'))
    tx.onerror = () => reject(tx.error)
  })
}

export const readEntries = () => transaction('readonly', store => store.getAll())
export const putEntry = entry => transaction('readwrite', store => store.put(entry))
export const removeEntry = id => transaction('readwrite', store => store.delete(id))
