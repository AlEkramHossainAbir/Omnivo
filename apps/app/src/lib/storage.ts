// Step 19a: whether the browser keeps the device's copy, and how much space it uses. Without
// "persistent" storage, a browser low on space may delete a site's data, the outbox with it.

export type StorageKept = 'kept' | 'may-be-cleared' | 'unknown';

export interface StorageInfo {
  kept: StorageKept;
  // Bytes, for the whole site: the copy, the outbox and the service worker's files. null = the
  // browser does not say.
  used: number | null;
  quota: number | null;
}

// navigator.storage exists only on https:// and localhost. TypeScript's types say it is always
// there, so the check is `in`, which they cannot rule out.
function storageManager(): StorageManager | null {
  return 'storage' in navigator ? navigator.storage : null;
}

async function keptState(storage: StorageManager): Promise<StorageKept> {
  if (!('persisted' in storage)) return 'unknown';
  try {
    return (await storage.persisted()) ? 'kept' : 'may-be-cleared';
  } catch {
    return 'unknown';
  }
}

async function estimate(storage: StorageManager): Promise<StorageEstimate | null> {
  if (!('estimate' in storage)) return null;
  try {
    return await storage.estimate();
  } catch {
    return null;
  }
}

export async function readStorage(): Promise<StorageInfo> {
  const storage = storageManager();
  if (!storage) return { kept: 'unknown', used: null, quota: null };
  const [kept, space] = await Promise.all([keptState(storage), estimate(storage)]);
  return { kept, used: space?.usage ?? null, quota: space?.quota ?? null };
}

// Asked when the device's copy is set up (local-session.ts), and by the Sync page's button. No
// browser shows a question for it but Firefox: Chrome and Edge answer at once from how the site is
// used (installed, bookmarked), Safari by its own rules. null = this browser cannot be asked.
export async function askToKeep(): Promise<boolean | null> {
  const storage = storageManager();
  if (!storage || !('persist' in storage)) return null;
  try {
    return await storage.persist();
  } catch {
    return null;
  }
}
