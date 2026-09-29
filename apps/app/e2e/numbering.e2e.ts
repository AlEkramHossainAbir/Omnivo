import { periodOf, todayIn } from '@omnivo/contracts';
import { expect, test } from '@playwright/test';

import { listItem, openFromNav } from './helpers.js';

// তারিখ-নির্ভর: আজ কোন অর্থবছর, সেটা অ্যাপের একই ফাংশন দিয়ে হিসাব — কোনো বছর হাতে লেখা নেই
const today = todayIn('Asia/Dhaka');

test('previews the format while typing and saves it', async ({ page }) => {
  await page.goto('/');
  await openFromNav(page, 'Numbering');
  await listItem(page, /Sales invoice/).click();

  const dialog = page.getByRole('dialog', { name: 'Edit Sales invoice numbering' });
  await expect(dialog.getByText(`INV-${periodOf(today, 'fiscal', 7)}-0001`)).toBeVisible();

  await dialog.getByLabel('Prefix').fill('si');
  await dialog.getByLabel('Year in the number').selectOption('calendar');
  await dialog.getByLabel('Digits').selectOption('5');
  await expect(dialog.getByText(`SI-${today.slice(0, 4)}-00001`)).toBeVisible();

  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Sales invoice numbering saved')).toBeVisible();
  await expect(listItem(page, /Sales invoice/)).toContainText(`SI-${today.slice(0, 4)}-00001`);
});
