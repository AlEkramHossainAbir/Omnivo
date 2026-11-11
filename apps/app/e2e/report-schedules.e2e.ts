import type { Locator, Page } from '@playwright/test';

import {
  actAs,
  expect,
  expectNoSideScroll,
  openFromNav,
  readOnlyItem,
  test,
  toastShown,
  waitForCopy,
} from './helpers.js';

// Step 21c: scheduled report emails on the mock (mocks/report-schedule-data.ts). The garments
// workspace has the four of the approved mockup: a monthly VAT report, a weekly sales report with
// Kamal Uddin on it (a Purchase manager, who may not read it), a daily payables aging paused because
// nobody on it may read it, and a stock movement someone paused. Nusrat Jahan and Rafiq Ahmed are the
// Finance desk, who read every report.

async function openSchedules(page: Page): Promise<void> {
  await page.goto('/');
  await waitForCopy(page);
  await openFromNav(page, 'Scheduled emails');
}

// A schedule's row (a card on a phone), by its report's name
function scheduleRow(page: Page, report: string): Locator {
  return readOnlyItem(page, report);
}

async function rowAction(page: Page, report: string, action: string): Promise<void> {
  await page.getByRole('button', { name: `Actions for ${report}` }).click();
  await page.getByRole('menuitem', { name: action }).click();
}

test('emails a report on a schedule from its Export menu', async ({ page }) => {
  await page.goto('/reports/vat');
  await waitForCopy(page);
  await page.getByLabel('Branch', { exact: true }).selectOption({ label: 'GZP · Gazipur factory' });
  await page.getByRole('button', { name: 'Export' }).click();
  await page.getByRole('menuitem', { name: 'Email on a schedule' }).click();

  const dialog = page.getByRole('dialog', { name: 'Email the VAT report on a schedule' });
  // The page's filters go with every email; its dates never do
  await expect(dialog.getByText('Branch: GZP · Gazipur factory')).toBeVisible();
  // Only the members who may read the report are offered
  await expect(dialog.getByRole('checkbox', { name: /Kamal Uddin/ })).toHaveCount(0);

  // Nobody ticked: the contract's own check, under the box
  await dialog.getByRole('button', { name: 'Schedule email' }).click();
  await expect(dialog.getByText('Pick at least one person to send it to.')).toBeVisible();

  await dialog.getByLabel('How often').selectOption({ label: 'Every month' });
  await expect(dialog.getByText('Each email has the whole month before.')).toBeVisible();
  await dialog.getByLabel('Day of the month').selectOption('5');
  await dialog.getByLabel('Time').selectOption({ label: '07:00' });
  await dialog.getByRole('checkbox', { name: /Nusrat Jahan/ }).check();
  await dialog.getByRole('button', { name: 'Schedule email' }).click();
  await toastShown(page, /^The VAT report is scheduled\. The first email goes on /);

  await openFromNav(page, 'Scheduled emails');
  await expect(page.getByText('5 of 20 scheduled emails')).toBeVisible();
  const made = scheduleRow(page, 'Branch: GZP · Gazipur factory');
  await expect(made).toContainText('Day 5 of every month at 07:00');
  await expect(made).toContainText('1 person');
  await expect(made).toContainText('Not sent yet');
  await expect(made).toContainText('Made by Farhana Rahman');
  await expectNoSideScroll(page);
});

test('a change keeps the filters and drops who may not read the report', async ({ page }) => {
  await openSchedules(page);
  const sales = scheduleRow(page, 'Sales report');
  await expect(sales).toContainText('Branch: HO · Head office');
  await expect(sales).toContainText('3 people');
  await expect(sales).toContainText('1 person gets nothing');

  await rowAction(page, 'Sales report', 'Change');
  const dialog = page.getByRole('dialog', { name: 'Change the Sales report email' });
  await expect(dialog.getByText('Group by: Customer')).toBeVisible();
  // Kamal is still listed, unticked and not to be ticked, with the reason
  const kamal = dialog.getByRole('checkbox', { name: /Kamal Uddin/ });
  await expect(kamal).not.toBeChecked();
  await expect(kamal).toBeDisabled();
  await expect(dialog.getByText('Gets nothing: may not read this report now')).toBeVisible();

  await dialog.getByLabel('How often').selectOption({ label: 'Every day' });
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await toastShown(page, 'The Sales report email is changed');
  await expect(sales).toContainText('Every day at 08:00');
  await expect(sales).toContainText('2 people');
  await expect(sales).not.toContainText('gets nothing');
});

test('pauses, resumes and deletes a schedule', async ({ page }) => {
  await openSchedules(page);
  const stock = scheduleRow(page, 'Stock movement');
  await expect(stock).toContainText('Someone paused it. Resume it to send it again.');
  await rowAction(page, 'Stock movement', 'Resume');
  await toastShown(page, 'The Stock movement email is on again');
  await expect(stock).toContainText('Active');
  await expect(stock).toContainText('Every Saturday at 18:00');

  await rowAction(page, 'Stock movement', 'Pause');
  await toastShown(page, 'The Stock movement email is paused');
  await expect(stock).toContainText('Paused');

  // Nobody on it may read the payables aging: it would only pause itself again (decision 31)
  await rowAction(page, 'Payables aging', 'Resume');
  await expect(
    page.getByText('Nobody on this email may read the report now.', { exact: false }),
  ).toBeVisible();
  await expect(scheduleRow(page, 'Payables aging')).toContainText('Paused');

  await rowAction(page, 'VAT report', 'Delete');
  const confirm = page.getByRole('dialog', { name: 'Delete this scheduled email?' });
  await confirm.getByRole('button', { name: 'Delete schedule' }).click();
  await toastShown(page, 'The VAT report email is deleted');
  await expect(scheduleRow(page, 'VAT report')).toHaveCount(0);
  await expect(page.getByText('3 of 20 scheduled emails')).toBeVisible();
});

test('a person sees only the schedules of the reports they read', async ({ page }) => {
  await actAs(page, {
    name: 'Store keeper',
    permissions: ['inventory.report.read', 'core.report.schedule'],
  });
  await openSchedules(page);
  await expect(scheduleRow(page, 'Stock movement')).toContainText(
    'Warehouse: CTG · Chattogram depot',
  );
  await expect(scheduleRow(page, 'VAT report')).toHaveCount(0);
  await expect(scheduleRow(page, 'Sales report')).toHaveCount(0);
});

test('without core.report.schedule there is no schedule to make or see', async ({ page }) => {
  await actAs(page, { name: 'Accountant', permissions: ['accounting.report.read'] });
  await page.goto('/reports/vat');
  await waitForCopy(page);
  await page.getByRole('button', { name: 'Export' }).click();
  await expect(page.getByRole('menuitem', { name: 'Excel (.xlsx)' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Email on a schedule' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('navigation').getByRole('link', { name: 'Scheduled emails' }),
  ).toHaveCount(0);
});
