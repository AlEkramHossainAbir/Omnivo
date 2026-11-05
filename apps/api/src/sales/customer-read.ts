import type { Customer } from '@omnivo/contracts';
import { type parties, partyAddresses } from '@omnivo/db';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';

type PartyRow = typeof parties.$inferSelect;

// A customer without its balance. The customer page adds the balance for people who may see it;
// the sync's pull (step 18a) never sends one (decision 10).
export type CustomerWithoutBalance = Omit<Customer, 'balance'>;

// Whole customers from their rows: the addresses of all of them in one query. The customer page
// reads one; the sync's pull reads a page of up to 1000. The answer keeps the order of `rows`.
export async function customersOf(
  tx: Transaction,
  rows: PartyRow[],
): Promise<CustomerWithoutBalance[]> {
  if (rows.length === 0) return [];
  const addresses = await tx
    .select()
    .from(partyAddresses)
    .where(
      and(
        eq(partyAddresses.tenantId, getTenantId()),
        inArray(
          partyAddresses.partyId,
          rows.map((row) => row.id),
        ),
      ),
    )
    // The billing address first, then the shipping ones in the order the person put them
    .orderBy(sql`${partyAddresses.kind} = 'billing' DESC`, asc(partyAddresses.position));
  const addressesOf = new Map<string, (typeof addresses)[number][]>();
  for (const address of addresses) {
    const own = addressesOf.get(address.partyId);
    if (own) own.push(address);
    else addressesOf.set(address.partyId, [address]);
  }
  return rows.map((party) => ({
    id: party.id,
    code: party.code,
    name: party.name,
    groupId: party.customerGroupId,
    contactPerson: party.contactPerson,
    phone: party.phone,
    email: party.email,
    documentLanguage: party.documentLanguage,
    bin: party.bin,
    paymentTermsDays: party.paymentTermsDays,
    creditLimit: party.creditLimit,
    priceListId: party.priceListId,
    notes: party.notes,
    addresses: (addressesOf.get(party.id) ?? []).map((address) => ({
      id: address.id,
      kind: address.kind,
      label: address.label,
      address: address.address,
      phone: address.phone,
    })),
    isSupplier: party.isSupplier,
    archivedAt: party.archivedAt?.toISOString() ?? null,
    version: party.version,
    updatedAt: party.updatedAt.toISOString(),
  }));
}
