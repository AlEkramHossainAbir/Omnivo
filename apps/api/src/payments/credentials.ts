import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { PaymentsConfig } from '../config.js';

// Step 27d (decision 4): a gateway password, sealed with AES-256-GCM before it reaches the
// database, and opened only in this process when the API calls the gateway. GCM gives secrecy and
// a check in one: a sealed value changed by one bit, or moved to another workspace's row, does not
// open at all, instead of opening to a wrong password.

export type CredentialsKey = NonNullable<PaymentsConfig['credentialsKey']>;

// GCM's usual sizes: a 12-byte nonce (random for every seal, so the same password sealed twice
// gives two different values) and its 16-byte tag
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

// Step 28a: the tables that keep a sealed secret: the gateway's password (27d) and a courier
// account's keys. The key is the same; the table is part of each seal's context
export type SealedTable = 'storefront_payment_gateways' | 'courier_accounts';

// What the seal is tied to, besides the key: the table and the workspace. GCM checks this
// "additional data" on opening without storing it, so a sealed password copied into another
// workspace's row (a bug, or someone with database access) fails to open there, and (28a) a
// courier's keys copied into the gateway's row do not open as a password. The gateway's text is
// the one 27d wrote, so the passwords sealed before 28a still open
function contextOf(table: SealedTable, tenantId: string): Buffer {
  return Buffer.from(`omnivo ${table} ${tenantId}`, 'utf8');
}

// One bytea: nonce ‖ tag ‖ ciphertext (27d.2's storefront_payment_gateways_sealed_check counts on
// this order and these sizes)
export function sealSecret(
  key: CredentialsKey,
  table: SealedTable,
  tenantId: string,
  secret: string,
): { sealed: Buffer; keyVersion: number } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key.key, nonce);
  cipher.setAAD(contextOf(table, tenantId));
  const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return { sealed: Buffer.concat([nonce, cipher.getAuthTag(), body]), keyVersion: key.version };
}

// The password, or null when it cannot be opened: sealed by another key (a key change the server
// has not caught up with), changed in the database, or another workspace's. The caller logs which
// workspace, never the value. Never throws: a payment page that does not open is an answer the
// shop can show ("Try again", "Pay on delivery"), a 500 is not
export function openSecret(
  key: CredentialsKey,
  table: SealedTable,
  tenantId: string,
  sealed: Buffer,
  keyVersion: number,
): string | null {
  if (keyVersion !== key.version || sealed.length <= NONCE_BYTES + TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.key, sealed.subarray(0, NONCE_BYTES));
    decipher.setAAD(contextOf(table, tenantId));
    decipher.setAuthTag(sealed.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(sealed.subarray(NONCE_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // final() throws when the tag does not match: the value or its context was changed
    return null;
  }
}
