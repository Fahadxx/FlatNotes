// FlatNotes persistence: IndexedDB (docs + light meta records + settings).

const DB_NAME = 'flatnotes';
const DB_VER = 1;
let dbPromise = null;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txDone(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function reqResult(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/**
 * The sidebar draws the whole notebook tree from these records alone, so everything it needs
 * (including the collection a notebook belongs to) has to be here. Reading 38 documents to
 * draw a list would mean loading well over a hundred megabytes.
 */
function metaOf(doc) {
  return {
    id: doc.id,
    name: doc.name,
    collection: doc.collection || null,
    modified: doc.modified,
    created: doc.created,
    pageCount: doc.pages.length,
    thumb: doc.pages[0]?.thumb || null,
  };
}

/** Save a full document plus its lightweight meta record. */
export async function saveDoc(doc) {
  const d = await db();
  const t = d.transaction(['docs', 'meta'], 'readwrite');
  t.objectStore('docs').put(doc);
  t.objectStore('meta').put(metaOf(doc));
  await txDone(t);
}

/**
 * Change only the header fields of a stored document (name, collection) and rewrite its meta
 * record in the same transaction, so the two can never drift apart. IndexedDB has no partial
 * update, so the document is still read and written whole; callers use this for notebooks
 * that are not open and go through saveDoc for the one that is.
 */
export async function patchDoc(id, fields) {
  const d = await db();
  const t = d.transaction(['docs', 'meta'], 'readwrite');
  const docs = t.objectStore('docs');
  const doc = await reqResult(docs.get(id));
  if (!doc) return null;
  Object.assign(doc, fields);
  docs.put(doc);
  const meta = metaOf(doc);
  t.objectStore('meta').put(meta);
  await txDone(t);
  return meta;
}

export async function loadDoc(id) {
  const d = await db();
  return reqResult(d.transaction('docs').objectStore('docs').get(id));
}

export async function listDocs() {
  const d = await db();
  const all = await reqResult(d.transaction('meta').objectStore('meta').getAll());
  return all.sort((a, b) => (b.modified || 0) - (a.modified || 0));
}

export async function deleteDoc(id) {
  const d = await db();
  const t = d.transaction(['docs', 'meta'], 'readwrite');
  t.objectStore('docs').delete(id);
  t.objectStore('meta').delete(id);
  await txDone(t);
}

export async function getKV(key) {
  const d = await db();
  return reqResult(d.transaction('kv').objectStore('kv').get(key));
}

export async function setKV(key, value) {
  const d = await db();
  const t = d.transaction('kv', 'readwrite');
  t.objectStore('kv').put(value, key);
  await txDone(t);
}
