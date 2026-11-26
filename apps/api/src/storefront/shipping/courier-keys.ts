import { z } from 'zod';

import { type CredentialsKey, openSecret, sealSecret } from '../../payments/credentials.js';
import type { CourierKeys } from '../../shipping/courier.js';

// Step 28a (decision 7): a courier account's two keys, sealed as one JSON text with 27d's sealing
// (28a.2's keys_sealed: one box, one nonce, one key version, so the two keys are never sealed by
// two different keys). The table is in the seal's context: a box copied into the gateway's row
// does not open there.

const keysSchema = z.object({ apiKey: z.string().min(1), secretKey: z.string().min(1) });

export function sealKeys(
  key: CredentialsKey,
  tenantId: string,
  keys: CourierKeys,
): { sealed: Buffer; keyVersion: number } {
  // Only the two fields, in this order: a wider object passed in by mistake seals nothing more
  const text = JSON.stringify({ apiKey: keys.apiKey, secretKey: keys.secretKey });
  return sealSecret(key, 'courier_accounts', tenantId, text);
}

// The keys, or null when they cannot be opened: no CREDENTIALS_KEY on this server, a box sealed by
// another key, changed in the database or another workspace's, or a text that is not the two keys.
// The caller says which workspace in its log, never the value
export function openKeys(
  key: CredentialsKey | null,
  row: { tenantId: string; keysSealed: Buffer | null; keyVersion: number | null },
): CourierKeys | null {
  if (key === null || row.keysSealed === null || row.keyVersion === null) return null;
  const text = openSecret(key, 'courier_accounts', row.tenantId, row.keysSealed, row.keyVersion);
  if (text === null) return null;
  try {
    const keys = keysSchema.safeParse(JSON.parse(text));
    return keys.success ? keys.data : null;
  } catch {
    // JSON.parse throws on a text that is not JSON: the box opened, so this is a bug, not an attack
    return null;
  }
}
