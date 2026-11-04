import type { Locator, Page } from '@playwright/test';

import { actAs, expect, expectNoSideScroll, test, waitForCopy } from './helpers.js';

// Step 21a in the mock garments workspace. The mock works the Overview out from its own books
// (dashboard-data.ts). Its money accounts hold ৳48,19,000 (Dutch-Bangla Bank) and ৳31,549.50 (cash
// in hand); customers owe ৳63,00,000 (H&M and Primark), suppliers are owed ৳21,00,000; one reorder
// level is reached (the poly mailer bags at the Main store). The one sale of the last 30 days is
// the Primark export sale, booked at the Gazipur factory 3 days ago: nothing was sold at the
// Chattogram depot. The tests never read a number that depends on the day they run.

// A card, by its title. A card is a <section> with no name of its own, so it is found by its heading.
function card(page: Page, title: string): Locator {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

// A cell of the KPI strip, by its label (a <span>: "Cash and bank" is also the cash card's heading)
function kpi(page: Page, label: string): Locator {
  return page.locator('span', { hasText: new RegExp(`^${label}$`) }).locator('..');
}

async function openOverview(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
}

test('shows the cash, the dues and the low stock of the whole workspace', async ({ page }) => {
  await openOverview(page);
  await expect(kpi(page, 'Cash and bank')).toContainText('৳48,50,550');

  // Every account money is kept in, the largest first, in whole taka
  const cash = card(page, 'Cash and bank');
  await expect(cash.getByRole('listitem')).toHaveText([
    /1121\s*Dutch-Bangla Bank CD A\/C 1234\s*৳48,19,000/,
    /1110\s*Cash in hand\s*৳31,550/,
  ]);
  await expect(cash.getByText('৳48,50,550')).toBeVisible();
  // A long account name is cut short, never the amounts: the card's content fits inside it
  expect(await cash.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  const dues = card(page, 'Customers owe');
  await expect(dues.getByText('৳63,00,000')).toBeVisible();
  await expect(dues.getByText('৳21,00,000')).toBeVisible();
  await expect(dues.getByText('Nothing overdue')).toHaveCount(2);

  const low = card(page, 'Low stock');
  await expect(low.getByText('1 item')).toBeVisible();
  await expect(low.getByRole('listitem')).toHaveText([
    /Poly mailer bag 10x14\s*Main store\s*3,000 of 4,000 pcs/,
  ]);
  await expectNoSideScroll(page);

  await low.getByRole('link', { name: 'See the reorder list' }).click();
  await expect(page).toHaveURL(/\/stock\/reorder$/);
});

test('the strip is one row on a computer and two by two on a phone', async ({ page }, testInfo) => {
  await openOverview(page);
  // boundingBox() is no assertion, so the fixture does not answer the PIN dialog for it: measure
  // once the dialog is gone and the strip is drawn
  await waitForCopy(page);
  await expect(kpi(page, 'Cash and bank')).toContainText('৳48,50,550');
  const boxes = await Promise.all(
    ['Sales today', 'Sales this month', 'Gross margin this month', 'Cash and bank'].map(
      async (label) => {
        const box = await kpi(page, label).boundingBox();
        if (!box) throw new Error(`No KPI cell ${label}`);
        return box;
      },
    ),
  );
  const [today, month, margin, cashBox] = boxes;
  if (!today || !month || !margin || !cashBox) throw new Error('Four cells expected');
  expect(month.y).toBe(today.y);
  expect(cashBox.y).toBe(margin.y);
  if (testInfo.project.name === 'phone') {
    expect(margin.y).toBeGreaterThan(today.y);
    expect(margin.x).toBe(today.x);
  } else {
    expect(margin.y).toBe(today.y);
  }
});

test('a branch changes what was sold, never the cash', async ({ page }) => {
  await openOverview(page);
  const trend = card(page, 'Sales, last 30 days');
  const chart = trend.getByRole('group', { name: /^Sales of each day from / });
  // The whole workspace sold to Primark, so the chart is drawn
  await expect(chart).toBeVisible();

  const branch = page.getByLabel('Branch', { exact: true });
  await branch.selectOption({ label: 'CTG · Chattogram depot' });
  await expect(kpi(page, 'Sales this month')).toContainText('৳0');
  await expect(trend.getByText('Nothing sold in the last 30 days')).toBeVisible();
  await expect(
    card(page, 'Top products').getByText('Nothing sold in the last 30 days'),
  ).toBeVisible();
  await expect(kpi(page, 'Cash and bank')).toContainText('৳48,50,550');
  await expect(card(page, 'Customers owe').getByText('৳63,00,000')).toBeVisible();

  // The factory booked the sale
  await branch.selectOption({ label: 'GZP · Gazipur factory' });
  await expect(chart).toBeVisible();
});

test('offline, it shows the numbers this device kept and when they were made', async ({ page }) => {
  await openOverview(page);
  await waitForCopy(page);
  await page
    .getByLabel('Branch', { exact: true })
    .selectOption({ label: 'CTG · Chattogram depot' });
  await expect(
    card(page, 'Sales, last 30 days').getByText('Nothing sold in the last 30 days'),
  ).toBeVisible();

  await page.context().setOffline(true);
  await expect(page.getByText(/· As of \d{1,2}:\d{2}/)).toBeVisible();
  await expect(
    page.getByText('You are offline, so these numbers are not live.', { exact: false }),
  ).toBeVisible();
  // The kept answer is the depot's: the select says so, and cannot change until the connection is back
  const branch = page.getByLabel('Branch', { exact: true });
  await expect(branch).toBeDisabled();
  await expect(branch.locator('option:checked')).toHaveText('CTG · Chattogram depot');
  await expect(page.getByText('Connect to the internet to see another branch.')).toBeVisible();
  await expect(kpi(page, 'Cash and bank')).toContainText('৳48,50,550');

  await page.context().setOffline(false);
  await expect(page.getByText(/As of/)).toBeHidden();
  await expect(branch).toBeEnabled();
});

test('the sales chart walks the days with the arrow keys and says each one', async ({ page }) => {
  await openOverview(page);
  // The PIN dialog shows once the copy opens and takes the focus: wait for it to be answered first
  await waitForCopy(page);
  const chart = page.getByRole('group', { name: /^Sales of each day from / });
  await expect(chart).toBeVisible();
  // "Sales of each day from 6 Oct 2026 to 4 Nov 2026": the first and the last day, from the page
  const [, first, last] =
    /from (.+) to (.+)$/.exec((await chart.getAttribute('aria-label')) ?? '') ?? [];
  if (first === undefined || last === undefined) throw new Error('The chart names no days');
  const said = chart.locator('[aria-live]');

  // The focus starts on today, the end point
  await chart.focus();
  await expect(said).toHaveText(new RegExp(`^${last}: ৳`));
  await page.keyboard.press('Home');
  await expect(said).toHaveText(`${first}: ৳0`);
  await page.keyboard.press('ArrowRight');
  await expect(said).not.toHaveText(`${first}: ৳0`);
  await page.keyboard.press('End');
  await expect(said).toHaveText(new RegExp(`^${last}: ৳`));
});

test('a store keeper sees only the low stock, across the whole row', async ({ page }) => {
  await actAs(page, {
    name: 'Store keeper',
    permissions: ['inventory.stock.adjust', 'inventory.stock.transfer', 'inventory.report.read'],
  });
  await openOverview(page);
  const low = card(page, 'Low stock');
  await expect(low.getByText('Poly mailer bag 10x14')).toBeVisible();
  // No sales, cash or dues, and no branch select: nothing on the page would change with it
  await expect(page.getByText('Sales today')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Cash and bank' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Customers owe' })).toHaveCount(0);
  await expect(page.getByLabel('Branch', { exact: true })).toHaveCount(0);

  // Alone in its row, the card is as wide as the row
  const [own, row] = await low.evaluate((element) => [
    element.getBoundingClientRect().width,
    element.parentElement?.getBoundingClientRect().width ?? 0,
  ]);
  expect(own).toBeCloseTo(row, 0);
});

test('a role with no card gets an empty state, not zeros', async ({ page }) => {
  await actAs(page, { name: 'Sales officer', permissions: ['sales.customer.manage'] });
  await openOverview(page);
  await expect(page.getByRole('heading', { name: 'No numbers for your role' })).toBeVisible();
  await expect(page.getByText('৳0')).toHaveCount(0);
});
