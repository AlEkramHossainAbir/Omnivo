import {
  absMoney,
  addMoney,
  defaultNumberFormat,
  formatDocumentNumber,
  isNegativeMoney,
  isZeroMoney,
  type JournalEntry,
  type JournalEntrySummary,
  type JournalLineInput,
  type JournalSource,
  type LedgerPage,
  type OpeningBalances,
  type OpeningBalancesInput,
  periodOf,
  shiftIsoDate,
  subtractMoney,
  sumMoney,
  todayIn,
} from '@omnivo/contracts';

import { MockProblem } from './mock';
import type { WorkspaceData } from './workspace-data';

// The mock's books: the API's rules (journal.service.ts, posting.service.ts) on plain arrays, so
// `pnpm dev:mock` and the e2e tests walk the same paths as the real API
export interface MockJournal {
  // In the order they were written
  entries: JournalEntry[];
  lockDate: string | null;
  // 0 = never set, like the API's lazy row
  lockVersion: number;
  // The last number given per period ('2026-27')
  counters: Map<string, number>;
}

export function emptyJournal(): MockJournal {
  return { entries: [], lockDate: null, lockVersion: 0, counters: new Map() };
}

type LineIn = Pick<JournalLineInput, 'accountId' | 'branchId' | 'description' | 'debit' | 'credit'>;

// "18500" → "18500.0000", the way Postgres sends NUMERIC(19,4)
function fixed(value: string): string {
  return addMoney(value, '0');
}

function linesProblem(
  code: 'journal_account_invalid' | 'journal_branch_invalid',
  field: string,
  indexes: number[],
) {
  return new MockProblem(
    409,
    code,
    Object.fromEntries(indexes.map((index) => [`lines.${String(index)}.${field}`, [code]])),
  );
}

export function checkLines(
  data: WorkspaceData,
  lines: readonly LineIn[],
  allowArchived = false,
): void {
  const badAccounts = lines.flatMap((line, index) => {
    const account = data.accounts.find((item) => item.id === line.accountId);
    return account && !account.isGroup && (allowArchived || account.archivedAt === null)
      ? []
      : [index];
  });
  if (badAccounts.length > 0)
    throw linesProblem('journal_account_invalid', 'accountId', badAccounts);
  const badBranches = lines.flatMap((line, index) => {
    if (line.branchId === null) return [];
    const branch = data.branches.find((item) => item.id === line.branchId);
    return branch && (allowArchived || branch.archivedAt === null) ? [] : [index];
  });
  if (badBranches.length > 0) throw linesProblem('journal_branch_invalid', 'branchId', badBranches);
}

function assertOpen(data: WorkspaceData, date: string): void {
  if (data.journal.lockDate !== null && date <= data.journal.lockDate) {
    throw new MockProblem(409, 'journal_period_locked', { date: ['journal_period_locked'] });
  }
}

function nextNumber(data: WorkspaceData, date: string): string {
  const format = data.series.get('accounting.journal') ?? defaultNumberFormat('accounting.journal');
  const period = periodOf(date, format.yearStyle, data.settings.fiscalYearStartMonth);
  const next = (data.journal.counters.get(period) ?? 0) + 1;
  data.journal.counters.set(period, next);
  return formatDocumentNumber(format, period, next);
}

export function findEntry(data: WorkspaceData, id: string): JournalEntry {
  const found = data.journal.entries.find((entry) => entry.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// The list's shape: everything but the lines
export function summaryOf(entry: JournalEntry): JournalEntrySummary {
  return {
    id: entry.id,
    number: entry.number,
    date: entry.date,
    narration: entry.narration,
    status: entry.status,
    source: entry.source,
    total: entry.total,
    reversalOf: entry.reversalOf,
    reversedBy: entry.reversedBy,
    postedAt: entry.postedAt,
    version: entry.version,
    updatedAt: entry.updatedAt,
  };
}

// Newest date first; on the same date, the last written first (the API's order is by id, UUIDv7)
export function sortedEntries(data: WorkspaceData): JournalEntry[] {
  const order = new Map(data.journal.entries.map((entry, index) => [entry.id, index]));
  return data.journal.entries.toSorted(
    (a, b) => b.date.localeCompare(a.date) || (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0),
  );
}

export function writeDraft(
  data: WorkspaceData,
  input: { date: string; narration: string | null; lines: readonly LineIn[] },
  source: JournalSource = 'manual',
  reversalOf: JournalEntry['reversalOf'] = null,
): JournalEntry {
  const now = new Date().toISOString();
  const entry: JournalEntry = {
    id: crypto.randomUUID(),
    number: null,
    date: input.date,
    narration: input.narration,
    status: 'draft',
    source,
    total: sumMoney(input.lines.map((line) => line.debit)),
    reversalOf,
    reversedBy: null,
    postedAt: null,
    version: 1,
    updatedAt: now,
    lines: input.lines.map((line) => ({
      id: crypto.randomUUID(),
      accountId: line.accountId,
      branchId: line.branchId,
      description: line.description,
      debit: fixed(line.debit),
      credit: fixed(line.credit),
    })),
  };
  data.journal.entries.push(entry);
  return entry;
}

export function replaceDraft(
  entry: JournalEntry,
  input: { date: string; narration: string | null; lines: readonly LineIn[] },
): void {
  Object.assign(entry, {
    date: input.date,
    narration: input.narration,
    total: sumMoney(input.lines.map((line) => line.debit)),
    version: entry.version + 1,
    updatedAt: new Date().toISOString(),
    lines: input.lines.map((line) => ({
      id: crypto.randomUUID(),
      accountId: line.accountId,
      branchId: line.branchId,
      description: line.description,
      debit: fixed(line.debit),
      credit: fixed(line.credit),
    })),
  });
}

export function postDraft(data: WorkspaceData, entry: JournalEntry): void {
  assertOpen(data, entry.date);
  if (entry.lines.length < 2) throw new MockProblem(409, 'journal_lines_too_few');
  const debits = sumMoney(entry.lines.map((line) => line.debit));
  const credits = sumMoney(entry.lines.map((line) => line.credit));
  if (debits !== credits) throw new MockProblem(409, 'journal_unbalanced');
  checkLines(data, entry.lines, entry.source === 'reversal');
  Object.assign(entry, {
    status: 'posted',
    number: nextNumber(data, entry.date),
    postedAt: new Date().toISOString(),
    version: entry.version + 1,
    updatedAt: new Date().toISOString(),
  });
}

export function reverseEntry(data: WorkspaceData, entry: JournalEntry, date: string): JournalEntry {
  if (entry.status !== 'posted') throw new MockProblem(409, 'journal_not_posted');
  if (entry.source === 'reversal') throw new MockProblem(409, 'journal_is_reversal');
  if (entry.reversedBy !== null) throw new MockProblem(409, 'journal_already_reversed');
  if (date < entry.date) {
    throw new MockProblem(409, 'journal_reversal_date', { date: ['journal_reversal_date'] });
  }
  const reversal = writeDraft(
    data,
    {
      date,
      narration: `Reversal of ${entry.number ?? ''}`,
      lines: entry.lines.map((line) => ({ ...line, debit: line.credit, credit: line.debit })),
    },
    'reversal',
    { id: entry.id, number: entry.number ?? '' },
  );
  try {
    postDraft(data, reversal);
  } catch (error) {
    data.journal.entries = data.journal.entries.filter((item) => item.id !== reversal.id);
    throw error;
  }
  entry.reversedBy = { id: reversal.id, number: reversal.number ?? '' };
  return reversal;
}

// Posts in one go, or leaves nothing behind (the API's transaction)
export function postNew(
  data: WorkspaceData,
  input: { date: string; narration: string | null; lines: readonly LineIn[] },
  source: JournalSource = 'manual',
): JournalEntry {
  const entry = writeDraft(data, input, source);
  try {
    postDraft(data, entry);
  } catch (error) {
    data.journal.entries = data.journal.entries.filter((item) => item.id !== entry.id);
    throw error;
  }
  return entry;
}

export function ledgerOf(
  data: WorkspaceData,
  accountId: string,
  query: {
    from?: string | undefined;
    to?: string | undefined;
    cursor?: string | undefined;
    limit: number;
  },
): LedgerPage {
  if (!data.accounts.some((account) => account.id === accountId)) {
    throw new MockProblem(404, 'not_found');
  }
  const order = new Map(data.journal.entries.map((entry, index) => [entry.id, index]));
  const all = data.journal.entries
    .filter((entry) => entry.status === 'posted')
    .toSorted(
      (a, b) => a.date.localeCompare(b.date) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
    )
    .flatMap((entry) =>
      entry.lines.filter((line) => line.accountId === accountId).map((line) => ({ entry, line })),
    );
  const before = all.filter(({ entry }) => query.from !== undefined && entry.date < query.from);
  const inRange = all.filter(
    ({ entry }) =>
      (query.from === undefined || entry.date >= query.from) &&
      (query.to === undefined || entry.date <= query.to),
  );
  const net = (rows: typeof all) =>
    subtractMoney(
      sumMoney(rows.map(({ line }) => line.debit)),
      sumMoney(rows.map(({ line }) => line.credit)),
    );
  const opening = net(before);
  // The mock's cursor is an offset into the range, like its other lists
  const start = query.cursor === undefined ? 0 : Number(query.cursor);
  let balance = addMoney(opening, net(inRange.slice(0, start)));
  const page = inRange.slice(start, start + query.limit);
  const end = start + page.length;
  return {
    items: page.map(({ entry, line }) => {
      balance = addMoney(balance, subtractMoney(line.debit, line.credit));
      return {
        lineId: line.id,
        entryId: entry.id,
        number: entry.number ?? '',
        date: entry.date,
        narration: entry.narration,
        description: line.description,
        debit: line.debit,
        credit: line.credit,
        balance,
      };
    }),
    nextCursor: end < inRange.length ? String(end) : null,
    openingBalance: opening,
    closingBalance: net(
      all.filter(({ entry }) => query.to === undefined || entry.date <= query.to),
    ),
  };
}

function currentOpening(data: WorkspaceData): JournalEntry | undefined {
  return data.journal.entries.findLast(
    (entry) =>
      entry.source === 'opening_balance' && entry.status === 'posted' && entry.reversedBy === null,
  );
}

function equityOf(data: WorkspaceData) {
  return data.accounts.find((account) => account.purpose === 'opening_balance_equity');
}

export function openingOf(data: WorkspaceData): OpeningBalances {
  const entry = currentOpening(data);
  if (!entry?.number) return { goLiveDate: null, entry: null, lines: [] };
  const equity = equityOf(data);
  return {
    goLiveDate: shiftIsoDate(entry.date, 1),
    entry: { id: entry.id, number: entry.number },
    lines: entry.lines
      .filter((line) => line.accountId !== equity?.id)
      .map((line) => ({ accountId: line.accountId, debit: line.debit, credit: line.credit })),
  };
}

export function saveOpening(data: WorkspaceData, input: OpeningBalancesInput): void {
  const current = currentOpening(data);
  if ((current?.id ?? null) !== input.replaces) throw new MockProblem(409, 'version_conflict');
  const equity = equityOf(data);
  if (!equity) throw new Error('The mock chart has no opening balance equity account');
  const filled = input.lines.flatMap((line, index) =>
    isZeroMoney(line.debit) && isZeroMoney(line.credit) ? [] : [{ ...line, index }],
  );
  const invalid = filled.flatMap((line) => {
    const account = data.accounts.find((item) => item.id === line.accountId);
    const ok =
      account &&
      !account.isGroup &&
      account.archivedAt === null &&
      account.id !== equity.id &&
      ['asset', 'liability', 'equity'].includes(account.type);
    return ok ? [] : [line.index];
  });
  if (invalid.length > 0) {
    throw new MockProblem(
      409,
      'opening_account_invalid',
      Object.fromEntries(
        invalid.map((index) => [`lines.${String(index)}.accountId`, ['opening_account_invalid']]),
      ),
    );
  }
  if (current) reverseEntry(data, current, current.date);
  if (filled.length === 0) return;
  const lines: LineIn[] = filled.map((line) => ({
    accountId: line.accountId,
    branchId: null,
    description: null,
    debit: line.debit,
    credit: line.credit,
  }));
  const difference = subtractMoney(
    sumMoney(lines.map((line) => line.debit)),
    sumMoney(lines.map((line) => line.credit)),
  );
  if (!isZeroMoney(difference)) {
    const amount = absMoney(difference);
    const negative = isNegativeMoney(difference);
    lines.push({
      accountId: equity.id,
      branchId: null,
      description: null,
      debit: negative ? amount : '0',
      credit: negative ? '0' : amount,
    });
  }
  postNew(
    data,
    { date: shiftIsoDate(input.goLiveDate, -1), narration: 'Opening balances', lines },
    'opening_balance',
  );
}

export function setLockDate(data: WorkspaceData, lockDate: string | null, version: number): void {
  if (data.journal.lockVersion !== version) throw new MockProblem(409, 'version_conflict');
  if (lockDate !== null && lockDate > todayIn(data.settings.timezone)) {
    throw new MockProblem(409, 'period_lock_future', { lockDate: ['period_lock_future'] });
  }
  data.journal.lockDate = lockDate;
  data.journal.lockVersion += 1;
}

// The garments workspace's first weeks on Omnivo: capital, rent, petty cash, a DESCO bill at the
// factory, salaries — and one draft still waiting. Dated in the last three weeks, but never before
// the fiscal year started, so the ledger's default range (this fiscal year) always shows them.
export function seedJournal(data: WorkspaceData): void {
  const today = todayIn(data.settings.timezone);
  const startMonth = String(data.settings.fiscalYearStartMonth).padStart(2, '0');
  const year = Number(today.slice(0, 4));
  const fiscalStart =
    today.slice(5, 7) >= startMonth
      ? `${String(year)}-${startMonth}-01`
      : `${String(year - 1)}-${startMonth}-01`;
  const day = (ago: number) => {
    const date = shiftIsoDate(today, -ago);
    return date < fiscalStart ? fiscalStart : date;
  };
  const id = (code: string) => {
    const found = data.accounts.find((account) => account.code === code);
    if (!found) throw new Error(`The mock chart has no ${code}`);
    return found.id;
  };
  const factory = data.branches.find((branch) => branch.code === 'GZP')?.id ?? null;
  const line = (code: string, debit: string, credit: string, branchId: string | null = null) => ({
    accountId: id(code),
    branchId,
    description: null,
    debit,
    credit,
  });

  postNew(data, {
    date: day(20),
    narration: 'Share capital paid in by the directors',
    lines: [line('1121', '5000000', '0'), line('3100', '0', '5000000')],
  });
  postNew(data, {
    date: day(15),
    narration: 'Office rent for the Banani head office',
    lines: [line('5220', '185000', '0'), line('1121', '0', '185000')],
  });
  postNew(data, {
    date: day(12),
    narration: 'Petty cash for the Gazipur factory',
    lines: [line('1110', '50000', '0', factory), line('1121', '0', '50000')],
  });
  postNew(data, {
    date: day(8),
    narration: 'DESCO electricity bill, Gazipur factory',
    lines: [line('5230', '18450.50', '0', factory), line('1110', '0', '18450.50', factory)],
  });
  postNew(data, {
    date: day(5),
    narration: 'Salaries for the month, payable on the 7th',
    lines: [line('5210', '1240000', '0'), line('2140', '0', '1240000')],
  });
  writeDraft(data, {
    date: day(2),
    narration: 'LC opening charges, Dutch-Bangla Bank',
    lines: [line('5410', '2300', '0'), line('1121', '0', '2300')],
  });
}
