import { fiscalYearOf, shiftIsoDate, todayIn } from '@omnivo/contracts';
import type { Locator, Page } from '@playwright/test';

import { actAs, expect, expectNoSideScroll, readOnlyItem, test, waitForCopy } from './helpers.js';

// Step 21c: the VAT report and the stock movement report on the mock.

// A cell of the KPI strip, by its label. The tables' headers have the same words, so only the
// strip's caption is looked for (like trade-reports.e2e.ts).
function kpi(page: Page, label: string): Locator {
  return page.locator('span.text-caption', { hasText: new RegExp(`^${label}$`) }).locator('..');
}

// A row of the VAT rates table. It stays a table on a phone, scrolling inside its card.
function rateRow(page: Page, name: string): Locator {
  return page.getByRole('row').filter({ hasText: name });
}

test.describe('VAT report', () => {
  // Last month's documents with VAT (mocks/vat-month-data.ts), the month the page opens at
  // (decision 60). In that month: output net ৳10,700, VAT ৳855 (৳75 of it taken back by a credit
  // note); input net ৳8,500, VAT ৳1,275 (৳75 taken back by a debit note, ৳450 on a bill with no
  // Mushak 6.3). Net VAT ৳855 − ৳1,275: ৳420 to carry forward.
  test.use({ vatMonth: true });

  async function openVat(page: Page): Promise<void> {
    await page.goto('/reports/vat');
    await waitForCopy(page);
    await expect(page.getByRole('heading', { level: 1, name: 'VAT report' })).toBeVisible();
    await expect(page.getByLabel('Period')).toHaveValue('last_month');
  }

  test('adds up last month by rate, to the paisa, and agrees with the books', async ({ page }) => {
    await openVat(page);
    await expect(kpi(page, 'Output VAT')).toContainText('৳855.00');
    await expect(kpi(page, 'Output VAT')).toContainText(
      '৳75.00 taken off by credit notes and POS returns',
    );
    await expect(kpi(page, 'Input VAT')).toContainText('৳1,275.00');
    await expect(kpi(page, 'Input VAT')).toContainText('৳75.00 taken off by debit notes');
    await expect(kpi(page, 'Input VAT')).toContainText(
      '৳450.00 on bills with no Mushak 6.3 number',
    );
    // More paid than charged: the strip shows the amount without its sign, and says what it is
    await expect(kpi(page, 'Net VAT')).toContainText('৳420.00');
    await expect(kpi(page, 'Net VAT')).toContainText('To carry forward');

    // One books line per side, each with its own pill
    await expect(page.getByText('Books agree')).toHaveCount(2);
    await expect(page.getByText('Output VAT in the books: ৳855.00')).toBeVisible();
    await expect(page.getByText('Input VAT in the books: ৳1,275.00')).toBeVisible();

    // Standard first; zero-rated is its own row, never folded into another 0%
    const standard = rateRow(page, 'VAT 15% · 15%');
    await expect(standard).toContainText('৳5,700.00');
    await expect(standard).toContainText('৳855.00');
    await expect(standard).toContainText('৳8,500.00');
    await expect(standard).toContainText('৳1,275.00');
    await expect(standard).toContainText('৳420.00 to carry forward');
    const zero = rateRow(page, 'Zero-rated · 0%');
    await expect(zero).toContainText('৳5,000.00');
    await expect(rateRow(page, 'Total')).toContainText('৳10,700.00');
    await expect(page.getByRole('row').filter({ hasText: 'Exempt' })).toHaveCount(0);
    await expectNoSideScroll(page);
  });

  test('lists the documents behind each side, oldest first', async ({ page }, testInfo) => {
    await openVat(page);
    // Output: the two invoices, the POS sale and the credit note, which takes VAT off
    await expect(readOnlyItem(page, 'Walk-in customer')).toContainText('৳180.00');
    const credit = readOnlyItem(page, 'Credit note');
    await expect(credit).toContainText('-৳500.00');
    await expect(credit).toContainText('-৳75.00');
    if (testInfo.project.name === 'desktop') {
      const rows = page.getByRole('table', { name: 'Documents' }).getByRole('row');
      // The header row, then the 5th, the 8th, the 12th and the 15th of the month
      await expect(rows).toHaveCount(5);
      await expect(rows.nth(1)).toContainText('Primark');
      await expect(rows.nth(2)).toContainText('POS sale');
      await expect(rows.nth(3)).toContainText('Credit note');
      await expect(rows.nth(4)).toContainText('H&M');
      // Not sortable: the server's order is the register's order (decision 18)
      await expect(page.getByRole('button', { name: /^Sort by/ })).toHaveCount(0);
    }

    // Input: the two bills and the debit note. One row per document: Meghna's bill is its
    // buttons and its truck rent together. A bill without its Mushak 6.3 says so.
    await page.getByText('Input', { exact: true }).click();
    const meghna = readOnlyItem(page, 'MSM-6.3-0918');
    await expect(meghna).toContainText('৳6,000.00');
    await expect(meghna).toContainText('৳900.00');
    await expect(readOnlyItem(page, 'Gazipur Carton')).toContainText('No Mushak 6.3');
    await expect(readOnlyItem(page, 'Debit note')).toContainText('-৳75.00');
    await expect(readOnlyItem(page, 'Primark')).toHaveCount(0);
  });

  test('a branch keeps only that branch’s documents', async ({ page }) => {
    await openVat(page);
    await expect(kpi(page, 'Output VAT')).toContainText('৳855.00');
    await page
      .getByLabel('Branch', { exact: true })
      .selectOption({ label: 'GZP · Gazipur factory' });
    // Only H&M's zero-rated invoice was made there
    await expect(kpi(page, 'Output VAT')).toContainText('৳0.00');
    await expect(kpi(page, 'Net VAT')).toContainText('Nothing to pay');
    await expect(rateRow(page, 'Zero-rated · 0%')).toContainText('৳5,000.00');
    await expect(rateRow(page, 'VAT 15% · 15%')).toHaveCount(0);
    await expect(page.getByText('Books agree')).toHaveCount(2);
  });

  test('a period with no VAT says so', async ({ page }) => {
    await openVat(page);
    await expect(kpi(page, 'Output VAT')).toContainText('৳855.00');
    // Nothing was posted in the last fiscal year without the year of trade
    await page.getByLabel('Period').selectOption({ label: 'Last fiscal year' });
    await expect(page.getByRole('heading', { name: 'No VAT in these dates' })).toBeVisible();
  });
});

test.describe('stock movement report', () => {
  // The workspace's own stock (mocks/stock-data.ts): opening stock a week ago at the Main store
  // (480 T-shirts at ৳185), and 48 of them sent to the Chattogram depot yesterday, still on the
  // truck. "This fiscal year" with "Also what did not move", so every product has its row on any
  // day. In the first week of July the week-old stock is from the year before: its opening, not its
  // movement. The test works out which, so it passes on every day.
  const today = todayIn('Asia/Dhaka');
  const yearStart = fiscalYearOf(today, 7).start;
  const openedBefore = shiftIsoDate(today, -7) < yearStart;
  const sentBefore = shiftIsoDate(today, -1) < yearStart;
  const pcs = (quantity: number) =>
    quantity === 0 ? '—' : `${quantity < 0 ? '-' : ''}${String(Math.abs(quantity))} pcs`;

  async function openStock(page: Page): Promise<void> {
    await page.goto('/reports/stock-movement');
    await waitForCopy(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Stock movement' })).toBeVisible();
    await page.getByLabel('Period').selectOption({ label: 'This fiscal year' });
    await page.getByLabel('Show').selectOption({ label: 'Also what did not move' });
  }

  test('opens, moves and closes each product in its base unit', async ({ page }, testInfo) => {
    await openStock(page);
    // 6 polo variants, the T-shirt, the fabric, the buttons, the mailers and the machine
    await expect(kpi(page, 'Products')).toContainText('11');
    await expect(kpi(page, 'Closing value')).toContainText('৳12,53,620');

    const tee = readOnlyItem(page, 'Basic crew-neck T-shirt');
    // closing = opening + purchased − sold + transfers + adjusted
    await expect(tee).toContainText('432 pcs');
    await expect(tee).toContainText('৳79,920');
    if (!openedBefore) await expect(tee).toContainText(pcs(480));
    // A minus in Transfers: the 48 are on the truck, in no warehouse
    if (!sentBefore) await expect(tee).toContainText(pcs(-48));
    await expect(page.getByText(/A minus in Transfers is stock still on the way/)).toBeVisible();
    // Metres keep the unit's decimals. The fabric is the last row: a phone's card list draws only
    // the cards on the screen.
    if (testInfo.project.name === 'desktop') {
      await expect(readOnlyItem(page, 'Single jersey 180 GSM')).toContainText('1,250.50 m');
    }
    await expectNoSideScroll(page);
  });

  test('a warehouse counts only its own movements', async ({ page }) => {
    await openStock(page);
    await expect(kpi(page, 'Products')).toContainText('11');
    await page.getByLabel('Warehouse').selectOption({ label: 'MAIN · Main store' });
    // The truck has left the Main store: 480 less 48
    await expect(readOnlyItem(page, 'Basic crew-neck T-shirt')).toContainText('432 pcs');

    // Nothing reached the depot yet
    await page.getByLabel('Warehouse').selectOption({ label: 'CTG · Chattogram depot' });
    await expect(page.getByRole('heading', { name: 'Nothing moved in these dates' })).toBeVisible();
  });

  test('sorts on the server, by a click on the header', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'A phone shows cards, with no headers');
    await openStock(page);
    const rows = page.getByRole('table', { name: 'Stock movement' }).getByRole('row');
    // A to Z at first
    await expect(rows.nth(1)).toContainText('Basic crew-neck T-shirt');
    // The header's name is its sort button's; exact, or "Closing value" matches too
    const closing = { name: 'Sort by Closing', exact: true };
    await page.getByRole('button', closing).click();
    await expect(page.getByRole('columnheader', closing)).toHaveAttribute('aria-sort', 'ascending');
    // The 3 sewing machines are the least
    await expect(rows.nth(1)).toContainText('Juki DDL-8000A');
  });

  test('a row opens the stock card', async ({ page }) => {
    await openStock(page);
    await page
      .getByRole('link', { name: 'Open the stock card of Basic crew-neck T-shirt' })
      .click();
    await expect(page).toHaveURL(/\/stock\/[0-9a-f-]+$/);
  });

  test('without the stock value, the values are not there at all', async ({ page }) => {
    await actAs(page, { name: 'Store keeper', permissions: ['inventory.report.read'] });
    await openStock(page);
    await expect(kpi(page, 'Products')).toContainText('11');
    await expect(readOnlyItem(page, 'Basic crew-neck T-shirt')).toContainText('432 pcs');
    await expect(page.getByText('Closing value')).toHaveCount(0);
    await expect(page.getByText('৳79,920')).toHaveCount(0);
    // The store keeper reads this report, and no other in the Reports group
    const nav = page.getByRole('navigation');
    await expect(nav.getByRole('link', { name: 'Stock movement' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'VAT report' })).toHaveCount(0);
  });
});
