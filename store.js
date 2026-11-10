// Хранилище в IndexedDB. Всё лежит только на устройстве.
//   clips  — метаданные клипов (без видео), ключ: id
//   chunks — части записи во время съёмки, ключ: [clipId, idx] (нужны для восстановления)
//   blobs  — готовое видео клипа, ключ: id

const DB_NAME = 'videopovtor';
const DB_VERSION = 1;
let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('clips', { keyPath: 'id' });
      db.createObjectStore('chunks', { keyPath: ['clipId', 'idx'] });
      db.createObjectStore('blobs', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const wrap = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/** Открыть транзакцию. Возвращает объекты хранилищ и promise завершения (данные реально записаны). */
async function open(names, mode = 'readonly') {
  const db = await openDB();
  const t = db.transaction(names, mode);
  const stores = Object.fromEntries([].concat(names).map((n) => [n, t.objectStore(n)]));
  const done = new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Транзакция прервана'));
  });
  return { stores, done };
}

const chunkRange = (id) => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);

// ---- клипы -----------------------------------------------------------------

export async function putClip(meta) {
  const { stores, done } = await open('clips', 'readwrite');
  stores.clips.put(meta);
  await done;
}

export async function getClip(id) {
  const { stores } = await open('clips');
  return wrap(stores.clips.get(id));
}

/** Список клипов, новые сверху. */
export async function listClips() {
  const { stores } = await open('clips');
  const all = await wrap(stores.clips.getAll());
  return all.sort((a, b) => (b.endedAt || b.startedAt) - (a.endedAt || a.startedAt));
}

export async function updateClip(id, patch) {
  const { stores, done } = await open('clips', 'readwrite');
  const cur = await wrap(stores.clips.get(id));
  if (cur) stores.clips.put({ ...cur, ...patch });
  await done;
  return cur ? { ...cur, ...patch } : null;
}

export async function getBlob(id) {
  const { stores } = await open('blobs');
  const rec = await wrap(stores.blobs.get(id));
  return rec ? rec.blob : null;
}

export async function deleteClip(id) {
  const { stores, done } = await open(['clips', 'blobs', 'chunks'], 'readwrite');
  stores.clips.delete(id);
  stores.blobs.delete(id);
  stores.chunks.delete(chunkRange(id));
  await done;
}

// ---- части записи ------------------------------------------------------------

export async function putChunk(rec) { // { clipId, idx, blob, t }
  const { stores, done } = await open('chunks', 'readwrite');
  stores.chunks.put(rec);
  await done;
}

/** Все части клипа по порядку. */
export async function getChunks(id) {
  const { stores } = await open('chunks');
  return wrap(stores.chunks.getAll(chunkRange(id)));
}

export async function assembleBlob(id, mimeType) {
  const chunks = await getChunks(id);
  return new Blob(chunks.map((c) => c.blob), { type: mimeType });
}

/** Атомарно: положить готовое видео, обновить метаданные, удалить части. */
export async function saveFinal(meta, blob) {
  const { stores, done } = await open(['clips', 'blobs', 'chunks'], 'readwrite');
  stores.blobs.put({ id: meta.id, blob });
  stores.clips.put(meta);
  stores.chunks.delete(chunkRange(meta.id));
  await done;
}

// ---- обслуживание --------------------------------------------------------------

/** Оставить maxClips последних НЕзакреплённых клипов; закреплённые не трогаем. Возвращает число удалённых. */
export async function cleanup(maxClips) {
  const all = (await listClips()).filter((c) => c.status !== 'recording');
  const unpinned = all.filter((c) => !c.pinned);
  const extra = unpinned.slice(Math.max(1, maxClips));
  for (const c of extra) await deleteClip(c.id);
  return extra.length;
}

/**
 * Восстановление после закрытия вкладки во время записи:
 * клипы со статусом «recording» собираются из частей и помечаются «interrupted».
 */
export async function recoverInterrupted() {
  const all = await listClips();
  let recovered = 0;
  for (const clip of all.filter((c) => c.status === 'recording')) {
    const chunks = await getChunks(clip.id);
    if (!chunks.length) { await deleteClip(clip.id); continue; }
    const blob = new Blob(chunks.map((c) => c.blob), { type: clip.mimeType });
    const endedAt = Math.max(...chunks.map((c) => c.t));
    const meta = {
      ...clip,
      status: 'interrupted',
      endedAt,
      durationMs: Math.max(0, endedAt - clip.startedAt),
      size: blob.size,
    };
    // Имя файла строится по времени окончания; если его нет — по последней сохранённой части
    const { makeFileName } = await import('./recorder.js');
    meta.fileName = makeFileName(endedAt, clip.label, clip.mimeType);
    await saveFinal(meta, blob);
    recovered++;
  }
  return recovered;
}
