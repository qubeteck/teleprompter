/**
 * IndexedDB persistence layer.
 *
 * The database intentionally stores content exactly as the user entered it.
 * Validation and sanitisation happen in script-validation.js before records
 * reach this module. All multi-record operations use a single transaction.
 */

export const DB_NAME = 'advanced-teleprompter-studio';
export const DB_VERSION = 1;
export const STORES = Object.freeze({
  scripts: 'scripts',
  folders: 'folders',
  presets: 'presets',
  settings: 'settings',
  revisions: 'revisions',
  metadata: 'metadata',
});

let dbPromise = null;
let dbInstance = null;
let resetPromise = null;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new DOMException('The database transaction was aborted.', 'AbortError'));
    tx.onerror = () => {
      // The abort handler provides the actionable error; this prevents an
      // unhandled error event in some browsers.
    };
  });
}

function buildSchema(db, tx) {
  if (!db.objectStoreNames.contains(STORES.scripts)) {
    const scripts = db.createObjectStore(STORES.scripts, { keyPath: 'id' });
    scripts.createIndex('title', 'title', { unique: false });
    scripts.createIndex('folderId', 'folderId', { unique: false });
    scripts.createIndex('updatedAt', 'updatedAt', { unique: false });
    scripts.createIndex('createdAt', 'createdAt', { unique: false });
    scripts.createIndex('lastOpenedAt', 'lastOpenedAt', { unique: false });
    scripts.createIndex('isFavorite', 'isFavorite', { unique: false });
    scripts.createIndex('deletedAt', 'deletedAt', { unique: false });
    scripts.createIndex('contentHash', 'contentHash', { unique: false });
  }

  if (!db.objectStoreNames.contains(STORES.folders)) {
    const folders = db.createObjectStore(STORES.folders, { keyPath: 'id' });
    folders.createIndex('name', 'name', { unique: false });
    folders.createIndex('updatedAt', 'updatedAt', { unique: false });
  }

  if (!db.objectStoreNames.contains(STORES.presets)) {
    const presets = db.createObjectStore(STORES.presets, { keyPath: 'id' });
    presets.createIndex('name', 'name', { unique: false });
    presets.createIndex('createdAt', 'createdAt', { unique: false });
  }

  if (!db.objectStoreNames.contains(STORES.settings)) {
    db.createObjectStore(STORES.settings, { keyPath: 'key' });
  }

  if (!db.objectStoreNames.contains(STORES.revisions)) {
    const revisions = db.createObjectStore(STORES.revisions, { keyPath: 'id' });
    revisions.createIndex('scriptId', 'scriptId', { unique: false });
    revisions.createIndex('createdAt', 'createdAt', { unique: false });
    revisions.createIndex('scriptId_createdAt', ['scriptId', 'createdAt'], { unique: false });
  }

  if (!db.objectStoreNames.contains(STORES.metadata)) {
    db.createObjectStore(STORES.metadata, { keyPath: 'key' });
  }

  // Record the current schema version in-band so backup/restore tooling and
  // diagnostics can identify the store shape without opening the database.
  tx.objectStore(STORES.metadata).put({
    key: 'schema',
    value: { version: DB_VERSION, createdAt: new Date().toISOString() },
  });
}

export function openDatabase() {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('This browser does not support IndexedDB. The studio cannot save scripts locally.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let blockedTimer = null;

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction;
      buildSchema(db, tx);
      if (event.oldVersion > 0 && event.oldVersion < DB_VERSION) {
        // Placeholder for future migrations. Each future version gets an
        // explicit, tested branch rather than destructive recreation.
      }
    };

    request.onsuccess = () => {
      clearTimeout(blockedTimer);
      const db = request.result;
      dbInstance = db;
      db.onversionchange = () => {
        db.close();
        dbInstance = null;
        dbPromise = null;
        window.dispatchEvent(new CustomEvent('teleprompter:db-versionchange'));
      };
      db.onclose = () => {
        dbInstance = null;
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      clearTimeout(blockedTimer);
      dbPromise = null;
      reject(request.error || new Error('The local database could not be opened.'));
    };

    request.onblocked = () => {
      blockedTimer = setTimeout(() => {
        dbPromise = null;
        reject(new Error('The database is blocked by another open tab. Close other studio tabs and try again.'));
      }, 4000);
    };
  });

  return dbPromise;
}

export async function closeDatabase() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
  dbPromise = null;
}

export async function resetDatabaseConnection() {
  await closeDatabase();
}

async function getStore(storeName, mode = 'readonly') {
  const db = await openDatabase();
  return db.transaction(storeName, mode).objectStore(storeName);
}

export async function getAll(storeName) {
  const store = await getStore(storeName);
  return requestToPromise(store.getAll());
}

export async function getRecord(storeName, key) {
  const store = await getStore(storeName);
  return requestToPromise(store.get(key));
}

export async function putRecord(storeName, record) {
  const store = await getStore(storeName, 'readwrite');
  await requestToPromise(store.put(record));
  return record;
}

export async function deleteRecord(storeName, key) {
  const store = await getStore(storeName, 'readwrite');
  return requestToPromise(store.delete(key));
}

/* ============================================================
   Scripts
   ============================================================ */

export async function getAllScripts({ includeDeleted = false } = {}) {
  const scripts = await getAll(STORES.scripts);
  const filtered = includeDeleted ? scripts : scripts.filter((script) => !script.deletedAt);
  return filtered.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export async function getScript(id) {
  if (!id) return null;
  return (await getRecord(STORES.scripts, id)) || null;
}

export async function saveScript(script) {
  const saved = { ...script, updatedAt: script.updatedAt || new Date().toISOString() };
  await putRecord(STORES.scripts, saved);
  return saved;
}

export async function saveScripts(scripts) {
  if (!scripts.length) return [];
  const db = await openDatabase();
  const tx = db.transaction(STORES.scripts, 'readwrite');
  const store = tx.objectStore(STORES.scripts);
  for (const script of scripts) store.put(script);
  await txDone(tx);
  return scripts;
}

/**
 * Patches many scripts in one transaction. patchFn receives a copy of each
 * record and may return a replacement record or mutate the copy.
 */
export async function bulkUpdateScripts(ids, patchFn) {
  const targetIds = new Set(ids);
  if (!targetIds.size) return [];
  const db = await openDatabase();
  const tx = db.transaction(STORES.scripts, 'readwrite');
  const store = tx.objectStore(STORES.scripts);
  const updated = [];
  const done = txDone(tx);
  await new Promise((resolve, reject) => {
    const request = store.openCursor();
    request.onerror = () => reject(request.error || new Error('Could not update scripts.'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      if (targetIds.has(cursor.value.id)) {
        const next = patchFn({ ...cursor.value }) || cursor.value;
        cursor.update(next);
        updated.push(next);
      }
      cursor.continue();
    };
  });
  await done;
  return updated;
}

export async function trashScript(id) {
  const timestamp = new Date().toISOString();
  const [updated] = await bulkUpdateScripts([id], (script) => ({
    ...script,
    deletedAt: timestamp,
    updatedAt: timestamp,
  }));
  return updated || null;
}

export async function restoreScript(id) {
  const timestamp = new Date().toISOString();
  const [updated] = await bulkUpdateScripts([id], (script) => ({
    ...script,
    deletedAt: null,
    updatedAt: timestamp,
  }));
  return updated || null;
}

export async function deleteScriptPermanently(id) {
  const db = await openDatabase();
  const tx = db.transaction([STORES.scripts, STORES.revisions], 'readwrite');
  tx.objectStore(STORES.scripts).delete(id);
  const revisions = tx.objectStore(STORES.revisions);
  const index = revisions.index('scriptId');
  const request = index.openKeyCursor(IDBKeyRange.only(id));
  const done = txDone(tx);
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    revisions.delete(cursor.primaryKey);
    cursor.continue();
  };
  await done;
}

export async function emptyTrash() {
  const db = await openDatabase();
  const scripts = await getAllScripts({ includeDeleted: true });
  const deletedIds = scripts.filter((script) => script.deletedAt).map((script) => script.id);
  if (!deletedIds.length) return 0;
  const tx = db.transaction([STORES.scripts, STORES.revisions], 'readwrite');
  const done = txDone(tx);
  const scriptStore = tx.objectStore(STORES.scripts);
  const revisionStore = tx.objectStore(STORES.revisions);
  for (const id of deletedIds) scriptStore.delete(id);
  const index = revisionStore.index('scriptId');
  for (const id of deletedIds) {
    const request = index.openKeyCursor(IDBKeyRange.only(id));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      revisionStore.delete(cursor.primaryKey);
      cursor.continue();
    };
  }
  await done;
  return deletedIds.length;
}

export async function findScriptsByContentHash(hash) {
  if (!hash) return [];
  const db = await openDatabase();
  const store = db.transaction(STORES.scripts).objectStore(STORES.scripts);
  const index = store.index('contentHash');
  return requestToPromise(index.getAll(IDBKeyRange.only(hash)));
}

export async function duplicateScript(id, { titleSuffix = ' copy' } = {}) {
  const original = await getScript(id);
  if (!original) throw new Error('The script could not be found.');
  const timestamp = new Date().toISOString();
  const copy = {
    ...original,
    id: crypto?.randomUUID ? crypto.randomUUID() : `script-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: `${original.title}${titleSuffix}`.slice(0, 200),
    createdAt: timestamp,
    updatedAt: timestamp,
    lastOpenedAt: null,
    lastPosition: null,
    isFavorite: false,
    deletedAt: null,
  };
  await saveScript(copy);
  return copy;
}

/* ============================================================
   Folders
   ============================================================ */

export async function getAllFolders() {
  const folders = await getAll(STORES.folders);
  return folders.sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveFolder(folder) {
  return putRecord(STORES.folders, folder);
}

export async function deleteFolder(folderId) {
  const db = await openDatabase();
  const tx = db.transaction([STORES.folders, STORES.scripts], 'readwrite');
  const done = txDone(tx);
  tx.objectStore(STORES.folders).delete(folderId);
  const scripts = tx.objectStore(STORES.scripts);
  const index = scripts.index('folderId');
  const request = index.openCursor(IDBKeyRange.only(folderId));
  const timestamp = new Date().toISOString();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    cursor.update({ ...cursor.value, folderId: null, updatedAt: timestamp });
    cursor.continue();
  };
  await done;
}

/* ============================================================
   Presets
   ============================================================ */

export async function getAllUserPresets() {
  return getAll(STORES.presets);
}

export async function savePreset(preset) {
  return putRecord(STORES.presets, preset);
}

export async function deletePreset(id) {
  return deleteRecord(STORES.presets, id);
}

/* ============================================================
   Settings & metadata
   ============================================================ */

export async function loadSettingsRecord() {
  return (await getRecord(STORES.settings, 'app')) || null;
}

export async function persistSettingsRecord(settings) {
  const record = { key: 'app', value: settings, updatedAt: new Date().toISOString() };
  await putRecord(STORES.settings, record);
  return record;
}

export async function getMetadata(key) {
  const record = await getRecord(STORES.metadata, key);
  return record?.value ?? null;
}

export async function setMetadata(key, value) {
  await putRecord(STORES.metadata, { key, value, updatedAt: new Date().toISOString() });
  return value;
}

/* ============================================================
   Revisions
   ============================================================ */

export async function addRevision(revision) {
  await putRecord(STORES.revisions, revision);
  return revision;
}

export async function getRevisionsForScript(scriptId) {
  const db = await openDatabase();
  const store = db.transaction(STORES.revisions).objectStore(STORES.revisions);
  const index = store.index('scriptId_createdAt');
  const request = index.getAll(IDBKeyRange.bound([scriptId, ''], [scriptId, '\uffff']));
  const revisions = await requestToPromise(request);
  return revisions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function getRevision(id) {
  return (await getRecord(STORES.revisions, id)) || null;
}

export async function deleteRevision(id) {
  return deleteRecord(STORES.revisions, id);
}

export async function pruneRevisions(scriptId, keep = 30) {
  const revisions = await getRevisionsForScript(scriptId);
  const excess = revisions.slice(Math.max(1, keep));
  if (!excess.length) return 0;
  const db = await openDatabase();
  const tx = db.transaction(STORES.revisions, 'readwrite');
  const store = tx.objectStore(STORES.revisions);
  for (const revision of excess) store.delete(revision.id);
  await txDone(tx);
  return excess.length;
}

export async function deleteRevisionsForScript(scriptId) {
  const db = await openDatabase();
  const tx = db.transaction(STORES.revisions, 'readwrite');
  const store = tx.objectStore(STORES.revisions);
  const index = store.index('scriptId');
  const request = index.openKeyCursor(IDBKeyRange.only(scriptId));
  const done = txDone(tx);
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    store.delete(cursor.primaryKey);
    cursor.continue();
  };
  await done;
}

/* ============================================================
   Backup / restore primitives
   ============================================================ */

export async function exportAllData({ includeDeleted = true, includeRevisions = true } = {}) {
  const [scripts, folders, presets, settings, revisions] = await Promise.all([
    getAllScripts({ includeDeleted: true }),
    getAll(STORES.folders),
    getAll(STORES.presets),
    loadSettingsRecord(),
    includeRevisions ? getAll(STORES.revisions) : Promise.resolve([]),
  ]);
  return {
    scripts: includeDeleted ? scripts : scripts.filter((script) => !script.deletedAt),
    folders,
    presets,
    settings: settings?.value ?? null,
    revisions,
  };
}

/**
 * Replaces the complete local library. Settings are optional so a user can
 * restore scripts without unexpectedly changing their reader preferences.
 */
export async function replaceAllData(data, { includeSettings = false, includeFolders = true, includePresets = true } = {}) {
  const db = await openDatabase();
  const storeNames = [STORES.scripts, STORES.folders, STORES.presets, STORES.revisions, STORES.settings];
  const tx = db.transaction(storeNames, 'readwrite');
  tx.objectStore(STORES.scripts).clear();
  if (includeFolders) tx.objectStore(STORES.folders).clear();
  if (includePresets) tx.objectStore(STORES.presets).clear();
  tx.objectStore(STORES.revisions).clear();

  const scriptStore = tx.objectStore(STORES.scripts);
  for (const script of data.scripts || []) scriptStore.put(script);
  if (includeFolders) {
    const folderStore = tx.objectStore(STORES.folders);
    for (const folder of data.folders || []) folderStore.put(folder);
  }
  if (includePresets) {
    const presetStore = tx.objectStore(STORES.presets);
    for (const preset of data.presets || []) presetStore.put(preset);
  }
  const revisionStore = tx.objectStore(STORES.revisions);
  for (const revision of data.revisions || []) revisionStore.put(revision);
  if (includeSettings && data.settings) {
    tx.objectStore(STORES.settings).put({ key: 'app', value: data.settings, updatedAt: new Date().toISOString() });
  }
  await txDone(tx);
}

export async function putImportedData({ scripts = [], folders = [], presets = [], revisions = [] }) {
  const db = await openDatabase();
  const tx = db.transaction([STORES.scripts, STORES.folders, STORES.presets, STORES.revisions], 'readwrite');
  for (const folder of folders) tx.objectStore(STORES.folders).put(folder);
  for (const preset of presets) tx.objectStore(STORES.presets).put(preset);
  for (const script of scripts) tx.objectStore(STORES.scripts).put(script);
  for (const revision of revisions) tx.objectStore(STORES.revisions).put(revision);
  await txDone(tx);
}

export async function clearAllData({ keepSettings = false } = {}) {
  const db = await openDatabase();
  const storeNames = [STORES.scripts, STORES.folders, STORES.presets, STORES.revisions];
  if (!keepSettings) storeNames.push(STORES.settings);
  const tx = db.transaction(storeNames, 'readwrite');
  for (const name of storeNames) tx.objectStore(name).clear();
  await txDone(tx);
}

/* ============================================================
   Storage helpers
   ============================================================ */

export async function getStorageEstimate() {
  if (!navigator.storage?.estimate) return null;
  try {
    const estimate = await navigator.storage.estimate();
    return {
      usage: estimate.usage || 0,
      quota: estimate.quota || 0,
      percent: estimate.quota ? (estimate.usage / estimate.quota) * 100 : 0,
    };
  } catch {
    return null;
  }
}

export async function isStoragePersisted() {
  if (!navigator.storage?.persisted) return false;
  try {
    return await navigator.storage.persisted();
  } catch {
    return false;
  }
}

export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** Test helper: deletes the database. */
export async function deleteDatabaseForTests() {
  await closeDatabase();
  if (!globalThis.indexedDB) return;
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}
