import { fiscalYearOf, shiftIsoDate, todayIn } from '@omnivo/contracts';
import type { Locator, Page } from '@playwright/test';

import {
  actAs,
  expect,
  expectNoSideScroll,
  listItem,
  openFromNav,
  readOnlyItem,
  test,
} from './helpers.js';

// Step 21b on the mock's year of trade (mocks/trade-history-data.ts). Every number is of the last
// fiscal year, so the tests never depend on the day they run. In that year: sold ৳71,000, taken back
// ৳2,000, net ৳69,000, cost ৳52,800. Bought ৳17,000, taken back ৳500, net ৳16,500.
test.use({ tradeHistory: true });

const today = todayIn('Asia/Dhaka');
// The day before this fiscal year's first day: the last day of the last one
const yearEnd = shiftIsoDate(fiscalYearOf(today, 7).start, -1);

// A cell of the KPI strip, by its label. The table's headers have the same words, so only the
// strip's caption is looked for.
function kpi(page: Page, label: string): Locator {
  return page.locator('span.text-caption', { hasText: new RegExp(`^${label}$`) }).locator('..');
}

async function lastYear(page: Page): Promise<void> {
  await page.getByLabel('Period').selectOption({ label: 'Last fiscal year' });
}

async function openReport(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await openFromNav(page, name);
}

// The filters are in the address, so an aging opens at the day the test wants
async function openAging(page: Page, path: string, asOf: string): Promise<void> {
  await page.goto(`/reports/${path}?asOf=${asOf}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

test.describe('sales report', () => {
  test('adds up the year, with the cost, and compares with the books', async ({ page }) => {
    await openReport(page, 'Sales report');
    await lastYear(page);
    await expect(kpi(page, 'Sold')).toContainText('৳71,000');
    await expect(kpi(page, 'Returns')).toContainText('৳2,000');
    await expect(kpi(page, 'Net sales')).toContainText('৳69,000');
    await expect(kpi(page, 'Margin')).toContainText('৳16,200');
    await expect(kpi(page, 'Margin')).toContainText('23.5% of net sales');

    // The mock's journal has a sale written by hand that year: no document, so the two differ. To
    // the paisa, because a difference under one taka would read ৳0 in whole taka.
    await expect(page.getByText('Out by ৳38,50,000.00')).toBeVisible();
    await expect(page.getByText('In the books: ৳39,19,000')).toBeVisible();

    // The largest net sale first; a walk-in has its own row
    const hm = readOnlyItem(page, /H&M Hennes/);
    await expect(hm).toContainText('৳30,000');
    await expect(hm).toContainText('৳2,000');
    await expect(hm).toContainText('৳28,000');
    await expect(readOnlyItem(page, /Walk-in customers/)).toContainText('৳3,000');
    await expectNoSideScroll(page);
  });

  test('groups by product, category, branch and month', async ({ page }) => {
    await openReport(page, 'Sales report');
    await lastYear(page);
    await expect(kpi(page, 'Net sales')).toContainText('৳69,000');
    const groupBy = page.getByLabel('Group by');

    await groupBy.selectOption({ label: 'Product' });
    // 100 + 40 + 10 at the counter; only the product group has a quantity
    await expect(readOnlyItem(page, /Basic crew-neck T-shirt/)).toContainText('150 pcs');

    await groupBy.selectOption({ label: 'Category' });
    await expect(readOnlyItem(page, /T-shirts/)).toContainText('৳36,000');
    await expect(readOnlyItem(page, /Buttons/)).toContainText('৳5,000');

    await groupBy.selectOption({ label: 'Branch' });
    await expect(readOnlyItem(page, /Gazipur factory/)).toContainText('৳28,000');

    await groupBy.selectOption({ label: 'Month' });
    // A month's row is named by its month, and the rows still add up to the year
    await expect(readOnlyItem(page, /\d{4}/).first()).toBeVisible();
    await expect(kpi(page, 'Net sales')).toContainText('৳69,000');
  });

  test('a customer group has no figure in the books', async ({ page }) => {
    await openReport(page, 'Sales report');
    await lastYear(page);
    await expect(page.getByText(/^Out by/)).toBeVisible();

    await page.getByLabel('Customer group').selectOption({ label: 'Local buyers' });
    await expect(kpi(page, 'Net sales')).toContainText('৳5,000');
    await expect(readOnlyItem(page, /Aarong/)).toBeVisible();
    // A group leaves the walk-ins out: they belong to none
    await expect(readOnlyItem(page, /Walk-in customers/)).toHaveCount(0);
    await expect(
      page.getByText('A customer group or a category has no figure in the books'),
    ).toBeVisible();
    await expect(page.getByText(/^Out by/)).toHaveCount(0);
  });

  test('a branch keeps only that branch’s sales', async ({ page }) => {
    await openReport(page, 'Sales report');
    await lastYear(page);
    await expect(kpi(page, 'Net sales')).toContainText('৳69,000');
    await page
      .getByLabel('Branch', { exact: true })
      .selectOption({ label: 'GZP · Gazipur factory' });
    await expect(kpi(page, 'Net sales')).toContainText('৳28,000');
    await expect(readOnlyItem(page, /Primark/)).toHaveCount(0);
    // The sale written by hand has no branch, so in this branch the books and the report agree
    await expect(page.getByText('Books agree')).toBeVisible();
    await expect(page.getByText('In the books: ৳28,000')).toBeVisible();
  });

  test('a period with no sales says so', async ({ page }) => {
    await openReport(page, 'Sales report');
    await page.getByLabel('Period').selectOption({ label: 'Last fiscal year' });
    await expect(kpi(page, 'Net sales')).toContainText('৳69,000');
    await page
      .getByLabel('Branch', { exact: true })
      .selectOption({ label: 'CTG · Chattogram depot' });
    await expect(page.getByRole('heading', { name: 'Nothing sold in these dates' })).toBeVisible();
  });

  test('sorts on the server, by a click on the header', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'A phone shows cards, with no headers');
    await openReport(page, 'Sales report');
    await lastYear(page);
    const rows = page.getByRole('row');
    // The header row, then the largest net sale
    await expect(rows.nth(1)).toContainText('H&M Hennes');
    await page.getByRole('button', { name: 'Net sales' }).click();
    await expect(page.getByRole('columnheader', { name: 'Net sales' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    await expect(rows.nth(1)).toContainText('Walk-in customers');
  });

  test('without the stock value, cost and margin are not there at all', async ({ page }) => {
    await actAs(page, { name: 'Sales officer', permissions: ['sales.report.read'] });
    await openReport(page, 'Sales report');
    await lastYear(page);
    await expect(kpi(page, 'Net sales')).toContainText('৳69,000');
    await expect(kpi(page, 'Margin')).toHaveCount(0);
    await expect(page.getByText(/Cost is what the sold goods cost/)).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'Cost' })).toHaveCount(0);
  });

  test('offline, it says it needs a connection', async ({ page }) => {
    await openReport(page, 'Sales report');
    await expect(page.getByLabel('Period')).toBeVisible();
    await page.context().setOffline(true);
    await expect(page.getByRole('heading', { name: 'Needs a connection' })).toBeVisible();
    await expect(page.getByLabel('Period')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Export' })).toHaveCount(0);

    await page.context().setOffline(false);
    await expect(page.getByLabel('Period')).toBeVisible();
  });
});

test.describe('purchase report', () => {
  test('adds up the bills, less the debit notes', async ({ page }) => {
    await openReport(page, 'Purchase report');
    await lastYear(page);
    await expect(kpi(page, 'Billed')).toContainText('৳17,000');
    await expect(kpi(page, 'Debit notes')).toContainText('৳500');
    await expect(kpi(page, 'Net purchases')).toContainText('৳16,500');
    const meghna = readOnlyItem(page, /Meghna Spinning/);
    await expect(meghna).toContainText('৳11,000');
    await expect(meghna).toContainText('৳10,500');
    await expectNoSideScroll(page);
  });

  test('an expense has a row of its own by product, and goods by account', async ({ page }) => {
    await openReport(page, 'Purchase report');
    await lastYear(page);
    await expect(kpi(page, 'Net purchases')).toContainText('৳16,500');
    const groupBy = page.getByLabel('Group by');

    await groupBy.selectOption({ label: 'Product' });
    await expect(readOnlyItem(page, /Expenses/)).toContainText('৳1,000');
    await expect(readOnlyItem(page, /Shirt buttons 4-hole/)).toContainText('2,000 pcs');

    await groupBy.selectOption({ label: 'Expense account' });
    await expect(readOnlyItem(page, /Products/)).toContainText('৳15,500');
    await expect(readOnlyItem(page, /5170/)).toContainText('৳1,000');
  });
});

test.describe('the agings', () => {
  test('receivables: each customer in its buckets, and the party’s documents', async ({ page }) => {
    await openAging(page, 'ar-aging', yearEnd);
    await expect(page.getByRole('heading', { level: 1, name: 'Receivables aging' })).toBeVisible();

    // 10,000 + 25,000 + 5,000 + 8,000 open, 2,000 of it paid in advance
    await expect(kpi(page, 'Total due')).toContainText('৳48,000');
    await expect(kpi(page, 'Overdue')).toContainText('৳43,000');
    await expect(kpi(page, 'Overdue')).toContainText('৳8,000 over 90 days');
    await expect(kpi(page, 'Advances')).toContainText('৳2,000');
    await expect(kpi(page, 'Balance')).toContainText('৳46,000');

    // Nine columns do not fit a laptop: the table scrolls in its box, and the name keeps its room
    // (found in the browser in 21b.7: the names were cut to "Benga…")
    const name = page.getByText('Bengal Buying House Ltd.');
    await expect(name).toBeVisible();
    expect(await name.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

    const hm = listItem(page, /H&M Hennes/);
    await expect(hm).toContainText('৳10,000');
    await expect(hm).toContainText('৳2,000');
    await expect(hm).toContainText('৳8,000');
    await expectNoSideScroll(page);

    // The row opens the customer's page, at the same day
    await hm.click();
    await expect(page.getByRole('heading', { level: 1, name: /H&M Hennes/ })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`asOf=${yearEnd}`));
    await expect(kpi(page, 'Balance')).toContainText('৳8,000');
    await expect(page.getByText('1 open invoice')).toBeVisible();
    await expect(page.getByText('70 days', { exact: true })).toBeVisible();
    await expect(page.getByText('61–90 days').first()).toBeVisible();
    await expect(page.getByRole('link', { name: /^MR-/ })).toBeVisible();
    await expectNoSideScroll(page);

    // Back on the report, the same day; a number opens its invoice
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`asOf=${yearEnd}`));
    await expect(kpi(page, 'Total due')).toContainText('৳48,000');
    // The name is a link of its own (open in a new tab): it keeps the day too, and only it navigates
    await page.getByRole('link', { name: /See what H&M Hennes/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: /H&M Hennes/ })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`asOf=${yearEnd}`));
    await page.getByRole('link', { name: /^INV-/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: /^INV-/ })).toBeVisible();
  });

  test('receivables: a day in the past shows that day', async ({ page }) => {
    // Before H&M's receipt and credit note: all 30,000 is open, and no advance yet
    await openAging(page, 'ar-aging', shiftIsoDate(yearEnd, -65));
    const hm = listItem(page, /H&M Hennes/);
    await expect(hm).toContainText('৳30,000');
    await expect(kpi(page, 'Advances')).toContainText('৳0');
  });

  test('overdue only, and back to everyone when nothing is late', async ({ page }) => {
    await openAging(page, 'ar-aging', yearEnd);
    await expect(listItem(page, /Aarong/)).toBeVisible();
    await page.getByText('Overdue only').click();
    // Aarong's invoice is not due yet
    await expect(listItem(page, /Aarong/)).toHaveCount(0);
    await expect(listItem(page, /Primark/)).toBeVisible();
    await expect(
      page.getByText('The books know nothing of due dates, so “Overdue only” has no figure'),
    ).toBeVisible();
    await expect(page).toHaveURL(/show=overdue/);

    // 171 days before the year's end only Bengal's invoice exists, and it is not due yet
    await openAging(page, 'ar-aging', shiftIsoDate(yearEnd, -171));
    await page.getByText('Overdue only').click();
    await expect(page.getByRole('heading', { name: 'Nothing overdue on this day' })).toBeVisible();
    await page.getByRole('button', { name: 'Show everyone' }).click();
    await expect(listItem(page, /Bengal Buying/)).toBeVisible();
  });

  test('a customer group keeps its customers, and the books follow', async ({ page }) => {
    await openAging(page, 'ar-aging', yearEnd);
    await expect(listItem(page, /Aarong/)).toBeVisible();
    await page.getByLabel('Customer group').selectOption({ label: 'Local buyers' });
    await expect(kpi(page, 'Total due')).toContainText('৳5,000');
    await expect(listItem(page, /Primark/)).toHaveCount(0);
    await expect(page.getByText('In the books: ৳5,000')).toBeVisible();
  });

  test('payables: the suppliers, their bills and their own numbers', async ({ page }) => {
    await openAging(page, 'ap-aging', yearEnd);
    await expect(page.getByRole('heading', { level: 1, name: 'Payables aging' })).toBeVisible();
    await expect(kpi(page, 'Total due')).toContainText('৳11,000');
    await expect(kpi(page, 'Advances')).toContainText('৳500');
    await expect(kpi(page, 'Balance')).toContainText('৳10,500');

    await listItem(page, /Meghna Spinning/).click();
    await expect(page.getByRole('heading', { level: 1, name: /Meghna Spinning/ })).toBeVisible();
    await expect(page.getByText('Their bill MSM-2026-1104')).toBeVisible();
    await expect(page.getByText('60 days', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /^PV-/ })).toBeVisible();
  });

  test('offline, an aging says it needs a connection', async ({ page }) => {
    await openAging(page, 'ar-aging', yearEnd);
    await expect(listItem(page, /Aarong/)).toBeVisible();
    await page.context().setOffline(true);
    await expect(page.getByRole('heading', { name: 'Needs a connection' })).toBeVisible();
  });
});

test.describe('who sees what', () => {
  test('a sales report reader sees the sales reports and Exports, nothing of purchases', async ({
    page,
  }) => {
    await actAs(page, { name: 'Sales officer', permissions: ['sales.report.read'] });
    await page.goto('/');
    const nav = page.getByRole('navigation');
    await expect(nav.getByRole('link', { name: 'Sales report' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Receivables aging' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Purchase report' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Payables aging' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Trial balance' })).toHaveCount(0);

    await openFromNav(page, 'Exports');
    await expect(page.getByRole('heading', { level: 1, name: 'Exports' })).toBeVisible();
  });

  test('exports the report and brings the file to the Exports page', async ({ page }) => {
    await openReport(page, 'Sales report');
    await lastYear(page);
    await expect(kpi(page, 'Net sales')).toContainText('৳69,000');
    await page.getByRole('button', { name: 'Export' }).click();
    await page.getByRole('menuitem', { name: 'Excel' }).click();
    await expect(page.getByText(/Preparing the Excel file/)).toBeVisible();

    await page.waitForTimeout(1_600);
    await openFromNav(page, 'Exports');
    await expect(readOnlyItem(page, /Sales report/)).toContainText('Ready');
  });
});
