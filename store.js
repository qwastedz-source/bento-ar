// Недавние картинки в IndexedDB (до 8 штук), чтобы не терялись между заходами.
const DB = 'bento-ar', STORE = 'images', MAX = 8;
let dbp = null;

function open() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => { dbp = null; rej(r.error); };
    });
  }
  return dbp;
}
async function run(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

export async function listImages() {
  const all = (await run('readonly', (s) => s.getAll())) || [];
  return all.sort((a, b) => b.t - a.t);
}
export async function addImage(blob, name) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await run('readwrite', (s) => s.put({ id, t: Date.now(), name, blob }));
  const all = await listImages();
  for (const old of all.slice(MAX)) await run('readwrite', (s) => s.delete(old.id));
  return id;
}
export async function touchImage(rec) {
  await run('readwrite', (s) => s.put({ ...rec, t: Date.now() }));
}
export async function deleteImage(id) {
  await run('readwrite', (s) => s.delete(id));
}
