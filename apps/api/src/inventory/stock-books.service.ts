import { Injectable } from '@nestjs/common';
import {
  type AdjustmentReason,
  compareMoney,
  type EntryRef,
  isZeroMoney,
  negateMoney,
  type StockAccountUse,
  type StockJournalSource,
  subtractMoney,
  sumMoney,
} from '@omnivo/contracts';
import { journalEntries, ledgerAccounts, stockAccounts, warehouses } from '@omnivo/db';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import { AppError } from '../common/http/app-error.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { type LineInput, PostingService } from '../journal/posting.service.js';

// One amount on one side of the entry before lines are summed: + debit, − credit
interface Amount {
  accountId: string;
  branchId: string | null;
  amount: string;
}

// What a stock posting moved, in one warehouse: the books tag it with the warehouse's branch
interface WarehouseValue {
  warehouseId: string;
  value: string;
}

// The accounts a stock entry may need. inventory and equity are found by their purpose (every chart
// has them, and they cannot be deleted or archived); the others are the choices in Settings →
// Inventory, each of which must still be an active ledger.
interface Accounts {
  inventory: string;
  openingEquity: string;
  use: (use: StockAccountUse) => string;
}

function missing(use: string): AppError {
  return new AppError(
    409,
    'stock_account_missing',
    `No usable account is chosen for "${use}" in Settings → Inventory.`,
    { params: { use } },
  );
}

// The journal half of every stock document (step 14). StockPostingService works out what each
// movement is worth; this turns those values into one journal entry per posting — the inventory
// account on one side, the account the document says on the other — and posts it through the
// journal's PostingService, inside the document's own transaction. So the stock and the books
// change together or not at all, and the books always say what the stock is worth.
// Lines are summed per account and branch: an opening stock of 400 items is a two-line entry,
// not 800 lines. An entry worth nothing (stock at zero cost) is not written at all.
@Injectable()
export class StockBooksService {
  constructor(private readonly posting: PostingService) {}

  // An adjustment: Dr Inventory / Cr the reason's account when stock comes in, the other way round
  // when it goes out. Opening stock is against opening balance equity, like opening balances.
  async adjustment(
    tx: Transaction,
    document: { id: string; number: string; date: string },
    input: {
      direction: 'in' | 'out';
      reason: AdjustmentReason;
      moved: readonly WarehouseValue[];
    },
  ): Promise<EntryRef | null> {
    const accounts = await this.accounts(tx);
    const against =
      input.reason === 'opening' ? accounts.openingEquity : accounts.use(input.reason);
    const branchOf = await this.branches(tx, input.moved);
    const sign = input.direction === 'in' ? (value: string) => value : negateMoney;
    return this.write(tx, document, 'stock_adjustment', `Stock adjustment ${document.number}`, [
      ...input.moved.map((part) => ({
        accountId: accounts.inventory,
        branchId: branchOf(part.warehouseId),
        amount: sign(part.value),
      })),
      ...input.moved.map((part) => ({
        accountId: against,
        branchId: branchOf(part.warehouseId),
        amount: negateMoney(sign(part.value)),
      })),
    ]);
  }

  // A transfer leaving: between two branches, the goods move from the source branch's inventory to
  // goods in transit (Dr Goods in transit / Cr Inventory). Inside one branch nothing changes in the
  // books (you chose this): the stock is still that branch's, only in another room.
  async transferSent(
    tx: Transaction,
    document: { id: string; number: string; date: string },
    input: { fromWarehouseId: string; toWarehouseId: string; value: string },
  ): Promise<EntryRef | null> {
    const branchOf = await this.branches(tx, [
      { warehouseId: input.fromWarehouseId, value: '0' },
      { warehouseId: input.toWarehouseId, value: '0' },
    ]);
    const from = branchOf(input.fromWarehouseId);
    if (from === branchOf(input.toWarehouseId)) return null;
    const accounts = await this.accounts(tx);
    return this.write(tx, document, 'stock_transfer', `Stock transfer ${document.number} sent`, [
      { accountId: accounts.use('in_transit'), branchId: null, amount: input.value },
      { accountId: accounts.inventory, branchId: from, amount: negateMoney(input.value) },
    ]);
  }

  // A transfer arriving with `received` of the `sent` value. Between two branches: Dr Inventory at
  // the destination for what arrived, Dr the shortage account for what did not (the source
  // branch's loss: it left there), Cr Goods in transit for everything that was sent. Inside one
  // branch, only a shortage is written: Dr shortage / Cr Inventory.
  async transferReceived(
    tx: Transaction,
    document: { id: string; number: string; date: string },
    input: { fromWarehouseId: string; toWarehouseId: string; sent: string; received: string },
  ): Promise<EntryRef | null> {
    const branchOf = await this.branches(tx, [
      { warehouseId: input.fromWarehouseId, value: '0' },
      { warehouseId: input.toWarehouseId, value: '0' },
    ]);
    const from = branchOf(input.fromWarehouseId);
    const to = branchOf(input.toWarehouseId);
    const short = subtractMoney(input.sent, input.received);
    const sameBranch = from === to;
    if (sameBranch && isZeroMoney(short)) return null;
    const accounts = await this.accounts(tx);
    const shortage = isZeroMoney(short)
      ? []
      : [{ accountId: accounts.use('transfer_shortage'), branchId: from, amount: short }];
    const narration = `Stock transfer ${document.number} received`;
    if (sameBranch) {
      return this.write(tx, document, 'stock_transfer', narration, [
        ...shortage,
        { accountId: accounts.inventory, branchId: from, amount: negateMoney(short) },
      ]);
    }
    return this.write(tx, document, 'stock_transfer', narration, [
      { accountId: accounts.inventory, branchId: to, amount: input.received },
      ...shortage,
      { accountId: accounts.use('in_transit'), branchId: null, amount: negateMoney(input.sent) },
    ]);
  }

  // A revaluation: each warehouse's part of the difference on the inventory account (with its
  // branch), and the opposite on the revaluation account. Worth more: Dr Inventory / Cr
  // revaluation; worth less: the other way round.
  async revaluation(
    tx: Transaction,
    document: { id: string; number: string; date: string },
    moved: readonly WarehouseValue[],
  ): Promise<EntryRef | null> {
    if (moved.length === 0) return null;
    const accounts = await this.accounts(tx);
    const branchOf = await this.branches(tx, moved);
    const revaluation = accounts.use('revaluation');
    return this.write(tx, document, 'stock_revaluation', `Stock revaluation ${document.number}`, [
      ...moved.map((part) => ({
        accountId: accounts.inventory,
        branchId: branchOf(part.warehouseId),
        amount: part.value,
      })),
      ...moved.map((part) => ({
        accountId: revaluation,
        branchId: branchOf(part.warehouseId),
        amount: negateMoney(part.value),
      })),
    ]);
  }

  // The posted entries of a document, oldest first: an adjustment has at most one, a transfer two
  async entriesOf(tx: Transaction, documentId: string): Promise<EntryRef[]> {
    const rows = await tx
      .select({ id: journalEntries.id, number: journalEntries.number })
      .from(journalEntries)
      .where(
        and(eq(journalEntries.tenantId, getTenantId()), eq(journalEntries.documentId, documentId)),
      )
      .orderBy(asc(journalEntries.postedAt), asc(journalEntries.id));
    return rows.flatMap((row) => (row.number === null ? [] : [{ id: row.id, number: row.number }]));
  }

  // Sums the amounts per account and branch, turns each sum into a debit or a credit line, and
  // posts the entry. null when nothing is left (every amount was zero).
  private async write(
    tx: Transaction,
    document: { id: string; number: string; date: string },
    source: StockJournalSource,
    narration: string,
    amounts: readonly Amount[],
  ): Promise<EntryRef | null> {
    const sums = new Map<string, Amount[]>();
    for (const amount of amounts) {
      const key = `${amount.accountId}|${amount.branchId ?? ''}`;
      sums.set(key, [...(sums.get(key) ?? []), amount]);
    }
    const lines: LineInput[] = [...sums.values()].flatMap((group) => {
      const [first] = group;
      if (!first) return [];
      const total = sumMoney(group.map((amount) => amount.amount));
      if (isZeroMoney(total)) return [];
      const debit = compareMoney(total, '0') > 0;
      return [
        {
          accountId: first.accountId,
          branchId: first.branchId,
          // No stock account is kept per party
          partyId: null,
          description: null,
          debit: debit ? total : '0',
          credit: debit ? '0' : negateMoney(total),
        },
      ];
    });
    if (lines.length < 2) return null;
    const entry = await this.posting.postNew(tx, {
      date: document.date,
      narration,
      source,
      document: { id: document.id, number: document.number },
      lines,
    });
    if (entry.number === null) throw new Error('A posted entry has no number');
    return { id: entry.id, number: entry.number };
  }

  // The inventory and opening equity accounts, and the Settings → Inventory choices. A choice that
  // is missing, archived or a group is refused with stock_account_missing when a posting needs it:
  // the person is told where to fix it, and nothing is posted.
  private async accounts(tx: Transaction): Promise<Accounts> {
    const tenantId = getTenantId();
    // FOR SHARE: until we commit, nobody archives or deletes them (AccountsService locks FOR
    // UPDATE), while other postings to the same accounts go on in parallel
    const purposes = await tx
      .select({ id: ledgerAccounts.id, purpose: ledgerAccounts.purpose })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.tenantId, tenantId),
          inArray(ledgerAccounts.purpose, ['inventory', 'opening_balance_equity']),
        ),
      )
      .for('share');
    const inventory = purposes.find((row) => row.purpose === 'inventory')?.id;
    const openingEquity = purposes.find((row) => row.purpose === 'opening_balance_equity')?.id;
    // A workspace whose chart is still being made by the setup job
    if (inventory === undefined) throw missing('inventory');
    if (openingEquity === undefined) throw missing('opening_balance_equity');

    const chosen = await tx
      .select({ use: stockAccounts.use, accountId: stockAccounts.accountId })
      .from(stockAccounts)
      .innerJoin(
        ledgerAccounts,
        and(
          eq(ledgerAccounts.tenantId, stockAccounts.tenantId),
          eq(ledgerAccounts.id, stockAccounts.accountId),
        ),
      )
      .where(
        and(
          eq(stockAccounts.tenantId, tenantId),
          eq(ledgerAccounts.isGroup, false),
          isNull(ledgerAccounts.archivedAt),
        ),
      )
      .for('share', { of: ledgerAccounts });
    const byUse = new Map(chosen.map((row) => [row.use, row.accountId]));
    return {
      inventory,
      openingEquity,
      use: (use) => {
        const id = byUse.get(use);
        if (id === undefined) throw missing(use);
        return id;
      },
    };
  }

  // warehouse → its branch, for the parts a posting moved
  private async branches(
    tx: Transaction,
    parts: readonly WarehouseValue[],
  ): Promise<(warehouseId: string) => string> {
    const ids = [...new Set(parts.map((part) => part.warehouseId))];
    const rows = await tx
      .select({ id: warehouses.id, branchId: warehouses.branchId })
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, getTenantId()), inArray(warehouses.id, ids)));
    const byId = new Map(rows.map((row) => [row.id, row.branchId]));
    return (warehouseId) => {
      const branchId = byId.get(warehouseId);
      if (branchId === undefined) throw new Error(`Warehouse ${warehouseId} has no branch`);
      return branchId;
    };
  }
}
