import { expect, test } from '@playwright/test';

import { expectNoSideScroll, openFromNav, readOnlyItem } from './helpers.js';

// The mock garments workspace has last fiscal year in four entries (sales 38,50,000, interest
// 54,000, cost of goods 21,00,000, salaries 9,00,000: profit 9,04,000, not closed yet) and this
// year's first weeks. The numbers checked here do not depend on the day the test runs.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test("shows a trial balance that balances, and opens an account's ledger from it", async ({
  page,
}) => {
  await openFromNav(page, 'Trial balance');
  await expect(page.getByText('Balanced', { exact: true })).toBeVisible();
  // Last year's balances are this year's opening: both sides of the totals row
  await expect(page.getByText('৳69,04,000.00 Dr')).toBeVisible();
  await expect(page.getByText('৳69,04,000.00 Cr')).toBeVisible();
  await expectNoSideScroll(page);

  await page.getByRole('link', { name: 'Open the ledger of Accounts receivable' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Ledger' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Account' })).toHaveValue(/.+/);
  // 38,50,000 from last year + 24,50,000 this year
  await expect(page.getByText('৳63,00,000.00 Dr').first()).toBeVisible();
});

test("shows last year's profit, and one branch's profit this year", async ({ page }) => {
  await openFromNav(page, 'Profit and loss');
  await page.getByLabel('Period').selectOption({ label: 'Last fiscal year' });
  const table = page.getByRole('table', { name: 'Profit and loss' });
  await expect(table.getByRole('row', { name: /^Net profit/ })).toContainText('৳9,04,000.00');
  await expect(table.getByRole('row', { name: /^Total income/ })).toContainText('৳39,04,000.00');

  // This year at the Gazipur factory: the Primark sale less the DESCO bill
  await page.getByLabel('Period').selectOption({ label: 'This fiscal year' });
  await page.getByLabel('Branch').selectOption({ label: 'GZP · Gazipur factory' });
  await expect(table.getByRole('row', { name: /^Net profit/ })).toContainText('৳24,31,549.50');
  await expectNoSideScroll(page);
});

test('shows a balance sheet whose two sides are equal', async ({ page }) => {
  await openFromNav(page, 'Balance sheet');
  await page.getByLabel('Compare with').selectOption({ label: 'Last year end' });
  await expect(page.getByText('Balanced', { exact: true })).toBeVisible();
  const table = page.getByRole('table', { name: 'Balance sheet' });
  // At the last year end: receivable 38,50,000 + bank 54,000 = payables 30,00,000 + profit 9,04,000
  await expect(table.getByRole('row', { name: /^Total liabilities and equity/ })).toContainText(
    '৳39,04,000.00',
  );
  await expectNoSideScroll(page);
});

test('closes last year into retained earnings, and reopens it', async ({ page }) => {
  await openFromNav(page, 'Year-end close');
  await page.getByRole('button', { name: 'Close year' }).click();
  const dialog = page.getByRole('dialog', { name: /^Close FY \d{4}-\d{2}$/ });
  await expect(dialog).toContainText('৳9,04,000.00');
  await dialog.getByRole('button', { name: 'Close year' }).click();
  await expect(page.getByText(/^FY \d{4}-\d{2} closed$/)).toBeVisible();
  await expect(page.getByText(/Books closed up to /)).toBeVisible();

  // The closing entry is in the journal, and it is undone only from this page
  await page.getByRole('link', { name: /^Closing entry JV-/ }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: /^JV-\d{4}-\d{2}-0005$/ }),
  ).toBeVisible();
  await expect(page.getByText('Year-end close', { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reverse' })).toBeHidden();

  // The profit and loss of the closed year still shows its profit
  await openFromNav(page, 'Profit and loss');
  await page.getByLabel('Period').selectOption({ label: 'Last fiscal year' });
  await expect(
    page.getByRole('table', { name: 'Profit and loss' }).getByRole('row', { name: /^Net profit/ }),
  ).toContainText('৳9,04,000.00');

  await openFromNav(page, 'Year-end close');
  await page.getByRole('button', { name: 'Reopen' }).click();
  await page
    .getByRole('dialog', { name: /^Reopen FY/ })
    .getByRole('button', { name: 'Reopen year' })
    .click();
  await expect(page.getByText(/^FY \d{4}-\d{2} reopened$/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close year' })).toBeVisible();
  await expectNoSideScroll(page);
});

test('exports a report to PDF and downloads it when the bell says it is ready', async ({
  page,
}) => {
  await openFromNav(page, 'Profit and loss');
  await page.getByRole('button', { name: 'Export' }).click();
  await page.getByRole('menuitem', { name: 'PDF' }).click();
  await expect(
    page.getByText("Preparing the PDF file. The bell tells you when it's ready."),
  ).toBeVisible();

  // The pretend worker takes 1.5 seconds; the bell's list is read fresh when it opens
  await page.waitForTimeout(1_600);
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Profit and loss \(PDF\) is ready to download/ })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Exports' })).toBeVisible();
  await expect(readOnlyItem(page, /Profit and loss/)).toContainText('Ready');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  expect((await download).suggestedFilename()).toMatch(
    /^profit-and-loss-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.pdf$/,
  );
  await expectNoSideScroll(page);
});
