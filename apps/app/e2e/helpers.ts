import { crc32, deflateSync } from 'node:zlib';

import { syncPullSchema } from '@omnivo/contracts';
import { newDeviceId, saveDevice } from '@omnivo/sync';
import { test as base, expect, type Locator, type Page, type Response } from '@playwright/test';

import {
  HEAD_OFFICES,
  MOCK_NO_HISTORY_KEY,
  MOCK_NO_SHOP_ORDERS_KEY,
  MOCK_NO_SHOP_PAYOUTS_KEY,
  MOCK_NO_VAT_MONTH_KEY,
  MOCK_ROLE_KEY,
  type MockRole,
  OWNER,
  WORKSPACES,
} from '../src/mocks/fixtures.js';

export { expect };

const copies = new WeakMap<Page, Promise<void>>();
// The pages whose PIN dialog the fixture still has to answer (see openFromNav)
const pinWaiting = new WeakSet<Page>();

// The first pull of the copy ends: a page of /sync/pull with nothing more to send
function copyOf(page: Page): Promise<void> {
  return new Promise((resolve) => {
    const listener = (response: Response) => {
      if (!response.url().includes('/sync/pull') || !response.ok()) return;
      void response.json().then(
        (body: unknown) => {
          const parsed = syncPullSchema.pick({ hasMore: true }).safeParse(body);
          if (parsed.success && !parsed.data.hasMore) {
            page.off('response', listener);
            resolve();
          }
        },
        // The page closed before the body was read
        () => undefined,
      );
    };
    page.on('response', listener);
  });
}

// Step 18a: every test imports `test` from here. The garments workspace has three active branches,
// so a new device asks which branch it is in (decision 12), and each test is a new browser profile,
// a new device. Before the app starts, the fixture leaves in localStorage what that dialog leaves:
// a device of the head office. The mock does not know the device, so the first pull registers it
// again (device_not_found → registerAgain) and the dialog never shows. The key and the value come
// from @omnivo/sync's own saveDevice(), so their format is written in one place. A test of the
// dialog itself turns this off with test.use({ seedDevice: false }).
//
// Step 19b: the first opening of a copy asks for a device PIN (decision 5), in every test that sets
// up a device. The fixture answers "Not now" whenever the dialog shows, before the test's next
// action or assertion (Playwright's locator handler), so the tests of step 18 and before run as
// they did. A test of the PIN itself turns this off with test.use({ answerPinDialog: false }).
// The dialog closes a menu or a panel that was open: a test that opens one right after the first
// load waits for the copy first (waitForCopy), so the dialog has shown and is answered before.
export const test = base.extend<{
  seedDevice: boolean;
  answerPinDialog: boolean;
  tradeHistory: boolean;
  vatMonth: boolean;
  shopOrders: boolean;
  shopPayouts: boolean;
}>({
  seedDevice: [true, { option: true }],
  answerPinDialog: [true, { option: true }],
  // Step 21b: the year of invoices and bills the reports read (fixtures.ts → MOCK_NO_HISTORY_KEY)
  tradeHistory: [false, { option: true }],
  // Step 21c: last month's documents with VAT (fixtures.ts → MOCK_NO_VAT_MONTH_KEY)
  vatMonth: [false, { option: true }],
  // Step 27b: Rahman Fashion's shop orders (fixtures.ts → MOCK_NO_SHOP_ORDERS_KEY)
  shopOrders: [false, { option: true }],
  // Step 28c: Steadfast Dhaka's last week for Shop payouts, with the shop orders
  // (fixtures.ts → MOCK_NO_SHOP_PAYOUTS_KEY)
  shopPayouts: [false, { option: true }],
  // `provide`, not Playwright's usual `use`: the React hooks lint rule reads `use(…)` as a hook
  page: async (
    { page, seedDevice, answerPinDialog, tradeHistory, vatMonth, shopOrders, shopPayouts },
    provide,
  ) => {
    copies.set(page, copyOf(page));
    if (!tradeHistory) {
      await page.addInitScript((key) => {
        localStorage.setItem(key, '1');
      }, MOCK_NO_HISTORY_KEY);
    }
    if (!vatMonth) {
      await page.addInitScript((key) => {
        localStorage.setItem(key, '1');
      }, MOCK_NO_VAT_MONTH_KEY);
    }
    if (!shopOrders) {
      await page.addInitScript((key) => {
        localStorage.setItem(key, '1');
      }, MOCK_NO_SHOP_ORDERS_KEY);
    }
    if (!shopPayouts) {
      await page.addInitScript((key) => {
        localStorage.setItem(key, '1');
      }, MOCK_NO_SHOP_PAYOUTS_KEY);
    }
    if (answerPinDialog) {
      // A new seeded device always asks once; without the seed the branch dialog comes first
      if (seedDevice) pinWaiting.add(page);
      await page.addLocatorHandler(
        page.getByRole('dialog', { name: 'Set a PIN for this device' }),
        async (dialog) => {
          await dialog.getByRole('button', { name: 'Not now' }).click();
          pinWaiting.delete(page);
        },
      );
    }
    if (seedDevice) {
      const [garments] = WORKSPACES;
      const saved = new Map<string, string>();
      saveDevice(
        { getItem: () => null, setItem: (key, value) => saved.set(key, value) },
        garments.tenantId,
        OWNER.id,
        { id: newDeviceId(), branchId: HEAD_OFFICES[garments.slug], later: false },
      );
      // Only when nothing is there: a reload keeps what the app saved since
      await page.addInitScript(
        (entries) => {
          for (const [key, value] of entries) {
            if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
          }
        },
        [...saved],
      );
    }
    await provide(page);
  },
});

// Until the device holds its first full copy. The products and customers pages and the pickers
// read only the copy (decision 5); the garments workspace's 10,000 styles take a few seconds to
// arrive, more than an assertion's 5 seconds on a busy machine.
export async function waitForCopy(page: Page): Promise<void> {
  const copy = copies.get(page);
  if (!copy) throw new Error('waitForCopy needs the page of the test fixture in helpers.ts');
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('The first pull did not finish in 25 seconds'));
    }, 25_000);
  });
  try {
    await Promise.race([copy, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ডেস্কটপে টেবিলের রো, ফোনে কার্ড (role="button") — একই টেস্ট দুই আকারেই
export function listItem(page: Page, name: string | RegExp): Locator {
  return page.getByRole('row', { name }).or(page.getByRole('button', { name }));
}

// শুধু-পড়ার তালিকা (audit log): ডেস্কটপে রো, ফোনে কার্ড — কিন্তু কার্ড ক্লিক করা যায় না বলে
// role="button" নেই, সাধারণ <li>। listitem-এর নাম লেখা থেকে আসে না (ARIA), তাই নাম না, hasText
export function readOnlyItem(page: Page, text: string | RegExp): Locator {
  return page.getByRole('row').or(page.getByRole('listitem')).filter({ hasText: text });
}

// পেজ reload করলে MSW-এর mock ডেটা শুরুতে ফেরে — তাই পেজ বদলানো সবসময় nav-এর লিংকে ক্লিক করে
// (client-side), page.goto দিয়ে না। ফোনে nav একটা আড়াআড়ি scroll-এর সারি; Playwright নিজেই scroll করে
// Step 17d: a string matches part of the name; a RegExp when another item holds it too ("Refunds" and
// "Supplier refunds", step 17d).
// Step 29: a link is in the menu only while its module is open (CLAUDE.md → Module rail), so the
// module's name is needed before the click. The table is here and not read from the app, because
// the app holds i18n keys, not the English words a test asks for. A link missing from it throws
// with what to add, so a new page's first test says so plainly instead of timing out.
const MODULE_OF_LINK: Record<string, string | null> = {
  // null: the sync line is in every module's menu, so no module has to be opened for it
  Sync: null,
  Overview: 'Home',
  'Kitchen sink': 'Home',
  POS: 'Sell',
  'POS sales': 'Sell',
  'POS returns': 'Sell',
  'POS shifts': 'Sell',
  Quotations: 'Sell',
  'Sales orders': 'Sell',
  Deliveries: 'Sell',
  Invoices: 'Sell',
  'Money receipts': 'Sell',
  'Sales returns': 'Sell',
  'Credit notes': 'Sell',
  Refunds: 'Sell',
  Customers: 'Sell',
  'Customer groups': 'Sell',
  'Price lists': 'Sell',
  Requisitions: 'Buy',
  'Purchase orders': 'Buy',
  'Goods receipts': 'Buy',
  'Supplier bills': 'Buy',
  'Supplier payments': 'Buy',
  'Purchase returns': 'Buy',
  'Debit notes': 'Buy',
  'Supplier refunds': 'Buy',
  Approvals: 'Buy',
  Suppliers: 'Buy',
  'Supplier groups': 'Buy',
  Products: 'Stock',
  Categories: 'Stock',
  Units: 'Stock',
  Imports: 'Stock',
  'Stock on hand': 'Stock',
  Adjustments: 'Stock',
  Transfers: 'Stock',
  'Batches and expiry': 'Stock',
  'Sold short': 'Stock',
  Reorder: 'Stock',
  Valuation: 'Stock',
  Revaluations: 'Stock',
  Warehouses: 'Stock',
  'Chart of accounts': 'Accounts',
  Journal: 'Accounts',
  Ledger: 'Accounts',
  'Opening balances': 'Accounts',
  'Year-end close': 'Accounts',
  'Shop orders': 'Shop',
  'Shop payouts': 'Shop',
  Catalog: 'Shop',
  'Shop coupons': 'Shop',
  'Shop categories': 'Shop',
  'Shop appearance': 'Shop',
  'Shop pages': 'Shop',
  'Shop settings': 'Shop',
  'Shop couriers': 'Shop',
  'Trial balance': 'Reports',
  'Profit and loss': 'Reports',
  'Balance sheet': 'Reports',
  'VAT report': 'Reports',
  'Sales report': 'Reports',
  'Receivables aging': 'Reports',
  'Purchase report': 'Reports',
  'Payables aging': 'Reports',
  'Stock movement': 'Reports',
  Exports: 'Reports',
  'Scheduled emails': 'Reports',
  Team: 'Setup',
  Roles: 'Setup',
  'Approval levels': 'Setup',
  'Custom fields': 'Setup',
  'POS registers': 'Setup',
  'POS cash reasons': 'Setup',
  Branches: 'Setup',
  Devices: 'Setup',
  Numbering: 'Setup',
  'Audit log': 'Setup',
  Settings: 'Setup',
};

function moduleOfLink(name: string | RegExp): string | null {
  const link =
    typeof name === 'string'
      ? Object.keys(MODULE_OF_LINK).find((key) => key === name || key.startsWith(name))
      : Object.keys(MODULE_OF_LINK).find((key) => name.test(key));
  if (link === undefined) {
    throw new Error(`No nav link matches ${String(name)}: add it to MODULE_OF_LINK in helpers.ts`);
  }
  return MODULE_OF_LINK[link] ?? null;
}

// Open a module from the rail. It clicks only when the module is not open already, so a test that
// stays inside one module still makes one page load, not two
export async function openModule(page: Page, module: string): Promise<void> {
  await pinAnswered(page);
  const item = page
    .getByRole('navigation', { name: 'Modules' })
    .getByRole('link', { name: new RegExp(`^${module}\\b`) });
  if ((await item.getAttribute('aria-current')) !== 'page') await item.click();
}

// পেজ reload করলে MSW-এর mock ডেটা শুরুতে ফেরে — তাই পেজ বদলানো সবসময় nav-এর লিংকে ক্লিক করে
// (client-side), page.goto দিয়ে না। ফোনে nav একটা আড়াআড়ি scroll-এর সারি; Playwright নিজেই scroll করে
// Step 17d: a string matches part of the name; a RegExp when another item holds it too ("Refunds" and
// "Supplier refunds", step 17d).
export async function openFromNav(page: Page, name: string | RegExp): Promise<void> {
  await pinAnswered(page);
  const link = page.getByRole('navigation').getByRole('link', { name });
  const heading = page.getByRole('heading', { level: 1, name });
  // The link is in the menu only while its module is open. count() does not wait: 0 means another
  // module is open (or the shell is still drawing, and opening the module draws it anyway)
  const switched = (await link.count()) === 0;
  if (switched) {
    const module = moduleOfLink(name);
    if (module !== null) await openModule(page, module);
  }
  // A rail item lands on its module's landing page, which is one of the module's own links, so a
  // test that asked for that page is there already — one page load instead of two. With the module
  // open to begin with, the click always happens, as it did before the rail
  if (!switched || (await heading.count()) === 0) await link.click();
  await expect(heading).toBeVisible();
}

// Step 19b: the PIN dialog opens when the copy is ready, at a moment the test does not choose. On
// a slow CI runner that was in the middle of a test: it closed an open dialog, or took a forced
// click (check({ force: true }) skips the checks that run the locator handler). So the first
// openFromNav of a test waits until the fixture has answered it. An auto-waiting assertion runs
// the handler when the dialog shows, so the loop asserts until the handler has run. A copy that
// has not opened by then has not asked either: the test goes on, and the handler still answers
// the dialog whenever it shows. A test file's own nav helper (a link whose page has another
// heading, or an exact link name) calls it before its click too.
export async function pinAnswered(page: Page): Promise<void> {
  if (!pinWaiting.has(page)) return;
  // Step 29: first(), because the shell has two navigations now — the module rail and the module
  // menu. Without it this assertion is a strict-mode error that never passes, and the loop below
  // spends its whole 25 seconds in every test that waits for the PIN dialog
  const nav = page.getByRole('navigation').first();
  try {
    await expect(async () => {
      await expect(nav).toBeVisible();
      expect(pinWaiting.has(page)).toBe(false);
    }).toPass({ timeout: 25_000 });
  } catch {
    pinWaiting.delete(page);
  }
}

// পেজ আড়াআড়ি scroll হয় না (CLAUDE.md → Page gutters) — চওড়া টেবিল শুধু নিজের বাক্সে
export async function expectNoSideScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

// A toast, then wait for it to close. On a phone it sits over the buttons at the bottom of the
// page, and it stays open while the pointer that just clicked rests on it: move the pointer away.
// Step 19b: `timeout` for a toast that waits for the copy to open (the branch dialog's).
// The close waits 10 seconds, not the config's 5: the toast closes by itself after about 3, and
// a busy CI runner (two workers, 1.1 h for the suite) ran past 5 before it did.
export async function toastShown(
  page: Page,
  text: string | RegExp,
  timeout?: number,
): Promise<void> {
  // No `timeout` key without a value (exactOptionalPropertyTypes): the config's 5 seconds
  await expect(page.getByText(text)).toBeVisible(timeout === undefined ? {} : { timeout });
  await page.mouse.move(0, 0);
  await expect(page.getByText(text)).toBeHidden({ timeout: 10_000 });
}

// Step 21a: the person signs in with this role, not as the owner (fixtures.ts → MOCK_ROLE_KEY).
// Before the app starts, so the first /me already answers with it; call it before page.goto.
export async function actAs(page: Page, role: MockRole): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key, value);
    },
    [MOCK_ROLE_KEY, JSON.stringify(role)] as const,
  );
}

// A real PNG of one grey colour, for a photo or picture upload (step 26g; shared with 26h's
// pictures). The mock decodes it in the browser like the
// image job does with sharp, so its size decides: 200 pixels or more on each side is a photo the
// shop can use, less is "too small". Built here so the test needs no file on disk
export function png(width: number, height: number): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const name = Buffer.from(type, 'ascii');
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc32(Buffer.concat([name, body])));
    return Buffer.concat([length, name, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  // 8 bits per channel, RGB; compression, filter and interlace stay 0
  header[8] = 8;
  header[9] = 2;
  // Each row starts with its filter byte (0 = none), then 3 bytes a pixel
  const row = Buffer.alloc(1 + width * 3, 0xd0);
  row[0] = 0;
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
