import type { Product, SyncCustomer } from '@omnivo/contracts';
import { liveQuery } from 'dexie';

import { type Box, ivOf, seal, unseal } from './crypto.js';
import type { MirroredTable, SealedRow, SyncDatabase } from './database.js';
import {
  type CustomerRecord,
  customerRecord,
  type ProductRecord,
  productRecord,
} from './records.js';
import { sealLegacy } from './sealed.js';

// Step 19b: the device's copy, open. The database holds sealed rows; this object holds the data
// key that opens them, and an in-memory copy of the two big tables, products and customers. A list
// sorts and searches 10,000 products on every key press, and cannot open 10,000 rows each time.
// This module brings Dexie (liveQuery): the app loads it lazily, like database.ts.

interface Held<E> {
  // The row's iv: a row written again has a new one (crypto.ts → ivOf)
  iv: Uint8Array<ArrayBuffer>;
  entry: E;
}

interface Snapshot<T> {
  // The table's mark (database.ts → TableMark), read before the rows: the rows are then at least
  // as new as the mark says
  version: number;
  rows: SealedRow<T>[];
}

interface Waiter {
  version: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

// One table, opened, in memory. A liveQuery reads the sealed table whenever a write changes it (a
// pull in this tab or another, a push's answer), and only the rows with a new iv are opened again.
// The reads come one after another: a liveQuery answer that comes while one is being opened waits,
// and only the newest waiting one is opened (the ones before it are already out of date).
export class Mirror<T, E extends { key: string }> {
  private held = new Map<string, Held<E>>();
  // The mark of the rows in `held`; -1 = nothing yet
  private version = -1;
  // Sorted views, made on first use after each change
  private readonly orders = new Map<string, readonly E[]>();
  private waiters: Waiter[] = [];
  private waiting: Snapshot<T> | null = null;
  private opening = false;
  private problem: Error | null = null;
  private closed = false;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly db: SyncDatabase,
    private readonly table: MirroredTable,
    private readonly read: () => Promise<SealedRow<T>[]>,
    private readonly open: (key: string, box: Box<T>) => Promise<T>,
    private readonly toEntry: (key: string, data: T) => E,
  ) {}

  private async mark(): Promise<number> {
    return (await this.db.marks.get(this.table))?.version ?? 0;
  }

  // Resolves once the table is in memory; rejects when a row of it does not open
  start(): Promise<void> {
    const loaded = this.reach(0);
    const subscription = liveQuery(async (): Promise<Snapshot<T>> => ({
      version: await this.mark(),
      rows: await this.read(),
    })).subscribe({
      next: (snapshot) => {
        this.waiting = snapshot;
        void this.drain();
      },
      error: (error: unknown) => {
        this.fail(error);
      },
    });
    this.unsubscribe = () => {
      subscription.unsubscribe();
    };
    return loaded;
  }

  // A row that does not open (changed on the disk), or a read that fails: the waiting reads fail
  // with it, and so does every read after, until a later snapshot opens
  private fail(error: unknown): void {
    this.problem = new Error('The copy could not be opened', { cause: error });
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.problem);
  }

  private async drain(): Promise<void> {
    if (this.opening) return;
    this.opening = true;
    try {
      while (this.waiting && !this.closed) {
        const snapshot = this.waiting;
        this.waiting = null;
        await this.take(snapshot);
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.opening = false;
    }
  }

  private async take({ version, rows }: Snapshot<T>): Promise<void> {
    const next = new Map<string, Held<E>>();
    const opened = await Promise.all(
      rows.map(async (row) => {
        const iv = ivOf(row.box);
        const old = this.held.get(row.key);
        if (old && sameBytes(old.iv, iv)) {
          next.set(row.key, old);
          return false;
        }
        next.set(row.key, { iv, entry: this.toEntry(row.key, await this.open(row.key, row.box)) });
        return true;
      }),
    );
    if (this.closed) return;
    if (opened.includes(true) || next.size !== this.held.size) this.orders.clear();
    this.held = next;
    this.version = version;
    this.problem = null;
    const still: Waiter[] = [];
    for (const waiter of this.waiters) {
      if (waiter.version <= version) waiter.resolve();
      else still.push(waiter);
    }
    this.waiters = still;
  }

  private reach(version: number): Promise<void> {
    if (this.closed) return Promise.reject(new Error('The copy is locked'));
    if (this.problem) return Promise.reject(this.problem);
    if (this.version >= version) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.waiters.push({ version, resolve, reject });
    });
  }

  // The table as the last write left it. A read inside the copy's watch (liveQuery) reads the mark,
  // so it runs again after every write to the table, and then waits here until the liveQuery above
  // has opened that write too. A list therefore never shows a customer twice, or not at all, in
  // the moment between a push's answer and the in-memory copy catching up with it.
  async current(): Promise<this> {
    const version = await this.mark();
    // No wrap needed here, unlike unseal's Web Crypto call (crypto.ts): reach() makes its promise
    // while the read runs, inside Dexie's zone, so the caller stays followed (copy.spec.ts)
    await this.reach(version);
    return this;
  }

  get(key: string): E | undefined {
    return this.held.get(key)?.entry;
  }

  // Every entry in the order `compare` gives, kept until the next change under `name`
  ordered(name: string, compare: (a: E, b: E) => number): readonly E[] {
    let order = this.orders.get(name);
    if (!order) {
      order = [...this.held.values()].map((held) => held.entry).sort(compare);
      this.orders.set(name, order);
    }
    return order;
  }

  close(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.held.clear();
    this.orders.clear();
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('The copy is locked'));
  }
}

export class LocalCopy {
  readonly products: Mirror<Product, ProductRecord>;
  readonly customers: Mirror<SyncCustomer, CustomerRecord>;
  private key: CryptoKey | null;

  private constructor(
    readonly db: SyncDatabase,
    key: CryptoKey,
  ) {
    this.key = key;
    this.products = new Mirror(
      db,
      'products',
      () => db.products.toArray(),
      (rowKey, box) => this.open('products', rowKey, box),
      productRecord,
    );
    this.customers = new Mirror(
      db,
      'customers',
      () => db.customers.toArray(),
      (rowKey, box) => this.open('customers', rowKey, box),
      customerRecord,
    );
  }

  // The copy with its data key (keys.ts → openKey). What version 2 left clear is sealed first; then
  // the two big tables come into memory. Only then can a page read, so a list never shows a half
  // copy.
  static async open(db: SyncDatabase, key: CryptoKey): Promise<LocalCopy> {
    const copy = new LocalCopy(db, key);
    try {
      await sealLegacy(copy);
      await Promise.all([copy.products.start(), copy.customers.start()]);
    } catch (error) {
      copy.close();
      throw error;
    }
    return copy;
  }

  private dataKey(): CryptoKey {
    if (this.key === null) throw new Error('The copy is locked');
    return this.key;
  }

  // The label is the row's table and key (crypto.ts → seal)
  seal<T>(table: string, key: string, value: T): Promise<Box<T>> {
    return seal(this.dataKey(), `${table}\n${key}`, value);
  }

  open<T>(table: string, key: string, box: Box<T>): Promise<T> {
    return unseal(this.dataKey(), `${table}\n${key}`, box);
  }

  // Lock now, sign-out, a move: the key and the opened rows leave memory. The database stays open
  // for the caller to close; a read that still runs fails ("locked") instead of opening a row.
  close(): void {
    this.key = null;
    this.products.close();
    this.customers.close();
  }
}
