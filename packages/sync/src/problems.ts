// The problem code of a browser that refuses IndexedDB (a private window, a full disk). Not an
// API error code: the server never sends it, so it is not in ERROR_CODES. A file of its own, with
// no imports: the app's pages read it without loading Dexie (see index.ts).
export const STORAGE_FAILED = 'storage_failed';
