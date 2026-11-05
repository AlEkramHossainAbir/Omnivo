import type {
  Customer,
  PriceLookupItem,
  SyncSettings,
  TaxRate,
  Unit,
  Warehouse,
} from '@omnivo/contracts';

// Step 18b (decision 35): what the queries and the line editor read from the device's copy. The
// session that opens the copy (local-session.ts) fills it, and empties it when the copy closes.
// queries.ts and stock-parts.tsx are on the path of almost every page: through this file they
// carry no code of @omnivo/sync, which took a dozen chunks over their budget.
export interface DeviceReads {
  units: () => Promise<Unit[]>;
  taxRates: () => Promise<TaxRate[]>;
  // The active warehouses of the device's branch: the only ones it keeps
  warehouses: () => Promise<Warehouse[]>;
  // The server's row with the outbox on top; null = not on this device
  customer: (customerId: string) => Promise<Customer | null>;
  // The customer has commands waiting in the outbox
  hasCommands: (customerId: string) => Promise<boolean>;
  // The workspace's settings in the copy: its time zone and how it writes prices
  settings: () => Promise<SyncSettings | null>;
  // The sales price lookup on the device ('' = no customer), with the customer as the outbox has it
  prices: (
    customerId: string,
    items: readonly { variantId: string; unitId: string }[],
  ) => Promise<PriceLookupItem[]>;
}

let reads: DeviceReads | null = null;

export function setDeviceReads(next: DeviceReads | null): void {
  reads = next;
}

export function deviceReads(): DeviceReads | null {
  return reads;
}
