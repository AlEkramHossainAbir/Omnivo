// Step 19b: the cryptography of the device's copy, on the browser's own Web Crypto (no library).
// A random data key seals every row (AES-GCM, 256 bits). The data key itself is kept only wrapped:
// once by a key the server gives an active device, once by a key made from the person's PIN
// (keys.ts). No Dexie here: the lock screen and the PIN dialog import this file.

const IV_BYTES = 12;

// PBKDF2-SHA256 rounds for a PIN (OWASP's 2023 advice). A PIN has only a million values, so the
// rounds make each guess slow: about half a second on a cheap phone, on purpose.
export const PIN_ITERATIONS = 600_000;
const SALT_BYTES = 16;
export const PIN_LENGTH = 6;

declare const sealedValue: unique symbol;

// Sealed bytes of a T: a 12-byte iv, then AES-GCM's ciphertext and tag. The type parameter is only
// for the reader (unseal gives back a T); the bytes do not carry it. The property is optional and
// never set, so plain bytes from IndexedDB fit the type.
export type Box<T> = Uint8Array<ArrayBuffer> & { readonly [sealedValue]?: T };

const DATA_KEY = { name: 'AES-GCM', length: 256 } as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function joined(iv: Uint8Array<ArrayBuffer>, body: ArrayBuffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(iv.length + body.byteLength);
  out.set(iv);
  out.set(new Uint8Array(body), iv.length);
  return out;
}

function newIv(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(IV_BYTES));
}

// The first 12 bytes of a box: a new random iv for every seal, so a row written again has a new
// one. The in-memory copy (copy.ts) tells a changed row by it without opening it.
export function ivOf(box: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  return box.slice(0, IV_BYTES);
}

// `label` is the additional data: where the row lives ("products\n<id>"). It is not stored, but
// the tag covers it, so a box copied to another row or another table no longer opens.
export async function seal<T>(key: CryptoKey, label: string, value: T): Promise<Box<T>> {
  const iv = newIv();
  const body = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(label) },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  return joined(iv, body);
}

// Throws when the key, the label or a single byte is wrong (AES-GCM checks the tag).
export async function unseal<T>(key: CryptoKey, label: string, box: Box<T>): Promise<T> {
  // Promise.resolve: Dexie's liveQuery follows the reads of a query through Dexie's own promises
  // only. A query that awaits Web Crypto's promise as it is stops being followed after it, so a
  // pull would no longer refresh what it reads next. Wrapped, the await stays inside Dexie's zone.
  // Every read of the copy opens its rows here, so this is the one place that needs it.
  const plain = await Promise.resolve(
    crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: box.subarray(0, IV_BYTES), additionalData: encoder.encode(label) },
      key,
      box.subarray(IV_BYTES),
    ),
  );
  const value: unknown = JSON.parse(decoder.decode(plain));
  // The one cast of the copy. The bytes are what seal() made from a T under this label: the tag
  // proves it, so a changed or moved box throws above instead of reaching here. Dexie's typed
  // tables trusted the stored rows the same way before step 19b.
  return value as T;
}

// A new data key. Extractable only so it can be wrapped right now; the copy runs on a
// non-extractable one, unwrapped again (keys.ts).
export function newDataKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(DATA_KEY, true, ['encrypt', 'decrypt']);
}

export async function wrapDataKey(
  dataKey: CryptoKey,
  wrapping: CryptoKey,
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = newIv();
  const body = await crypto.subtle.wrapKey('raw', dataKey, wrapping, { name: 'AES-GCM', iv });
  return joined(iv, body);
}

// null = this wrapping key does not open it (a wrong PIN, another server key). Any other error
// is a real failure, and goes up.
export async function unwrapDataKey(
  wrapped: Uint8Array<ArrayBuffer>,
  wrapping: CryptoKey,
  extractable: boolean,
): Promise<CryptoKey | null> {
  try {
    return await crypto.subtle.unwrapKey(
      'raw',
      wrapped.subarray(IV_BYTES),
      wrapping,
      { name: 'AES-GCM', iv: wrapped.subarray(0, IV_BYTES) },
      DATA_KEY,
      extractable,
      ['encrypt', 'decrypt'],
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === 'OperationError') return null;
    throw error;
  }
}

// The 32 bytes the server keeps for this device (step 19b.2), as a key that only wraps
export function serverWrappingKey(bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (bytes.length !== 32) throw new Error('A device key is 32 bytes');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['wrapKey', 'unwrapKey']);
}

export function newSalt(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

export async function pinWrappingKey(
  pin: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    DATA_KEY,
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

// PIN_LENGTH ASCII digits. The app turns Bangla digits into these first (the money input's rule).
export function isPin(value: string): boolean {
  return value.length === PIN_LENGTH && /^[0-9]+$/.test(value);
}
