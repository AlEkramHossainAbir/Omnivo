import { readFile } from 'node:fs/promises';

import type { Download, Page } from '@playwright/test';

import { expect, expectNoSideScroll, listItem, openFromNav, test, toastShown } from './helpers.js';

// Step 16 in the mock garments workspace. Aarong reads its documents in Bangla, has no email
// address and a mobile number; its open quotation is QT-…-0003. H&M reads English; its declined
// quotation QT-…-0001 went out a month ago (an email, a link that has ended and one turned off).
// The mock's pretend worker makes a PDF in 1.2 seconds and sends an email in 2.5; an address with
// "bounce" in it never arrives. The mock's "PDF" is a line of text that names its language.

const QT_3 = /QT-\d{4}-\d{2}-0003/;

async function openQuotation(page: Page, number: RegExp) {
  await openFromNav(page, 'Quotations');
  await listItem(page, number).click();
  await expect(page.getByRole('heading', { level: 1, name: number })).toBeVisible();
}

// The Send menu's button, then one of its items
async function send(page: Page, item: string) {
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

// A row of the history cards. In the page's main region: a toast is a list item too, and the
// email toast names the same address.
function historyRow(page: Page, text: string) {
  return page.getByRole('main').getByRole('listitem').filter({ hasText: text });
}

// The mock's file says which language it was made in
async function languageOf(download: Download): Promise<string> {
  return readFile(await download.path(), 'utf8');
}

test.describe('in the app', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test("downloads a quotation's PDF in the customer's language, and in the other", async ({
    page,
  }) => {
    await openQuotation(page, QT_3);
    // Aarong reads Bangla: the first item is its language, the second names the other one
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Download PDF in English' })).toBeVisible();
    const bangla = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'Download PDF', exact: true }).click();
    // While the worker draws it, the button says so and takes no second click
    await expect(page.getByRole('button', { name: 'Making the PDF…' })).toBeDisabled();
    expect((await bangla).suggestedFilename()).toMatch(/^QT-\d{4}-\d{2}-0003\.pdf$/);
    expect(await languageOf(await bangla)).toContain('(bn)');

    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    const english = page.waitForEvent('download');
    await send(page, 'Download PDF in English');
    expect((await english).suggestedFilename()).toMatch(/^QT-\d{4}-\d{2}-0003\.pdf$/);
    expect(await languageOf(await english)).toContain('(en)');
    await expectNoSideScroll(page);
  });

  test("emails a quotation in the customer's language, or in another, and the history shows it go", async ({
    page,
  }) => {
    await openQuotation(page, QT_3);
    await send(page, 'Email');
    const dialog = page.getByRole('dialog', { name: /Email QT-\d{4}-\d{2}-0003/ });
    // The server's draft, in Aarong's Bangla; no address to send it to yet
    await expect(dialog.getByLabel('Language')).toHaveValue('bn');
    await expect(dialog.getByLabel('Subject')).toHaveValue(
      /^Rahman Garments Ltd\. থেকে কোটেশন QT-\d{4}-\d{2}-0003$/,
    );
    await expect(dialog.getByLabel('To', { exact: true })).toHaveValue('');
    await expect(
      dialog.getByText('This customer has no email address.', { exact: false }),
    ).toBeVisible();
    // The mock company has no email in Settings, so replies have nowhere to go
    await expect(
      dialog.getByText('Add your company’s email in Settings', { exact: false }),
    ).toBeVisible();
    await expect(dialog.getByText(/^Attached: QT-\d{4}-\d{2}-0003\.pdf$/)).toBeVisible();
    await expectNoSideScroll(page);

    // The form checks the boxes before anything goes out
    await dialog.getByRole('button', { name: 'Send email' }).click();
    await expect(dialog.getByText('Type at least one address to send it to.')).toBeVisible();
    await dialog.getByLabel('To', { exact: true }).fill('accounts@aarong.com');
    await dialog.getByLabel('CC (optional)').fill('mahmudul@aarong.com, not-an-address');
    await dialog.getByRole('button', { name: 'Send email' }).click();
    await expect(dialog.getByText('Enter an email like name@company.com.')).toBeVisible();
    await dialog
      .getByLabel('CC (optional)')
      .fill('a@aarong.com b@aarong.com c@aarong.com d@aarong.com e@aarong.com f@aarong.com');
    await dialog.getByRole('button', { name: 'Send email' }).click();
    await expect(dialog.getByText('Up to 5 addresses in a box.', { exact: false })).toBeVisible();
    // Pasted from a mail program: a semicolon, capitals and the same address twice
    await dialog.getByLabel('CC (optional)').fill('Mahmudul@Aarong.com; mahmudul@aarong.com');

    // English instead: the subject and the message are written again; To and CC stay
    await dialog.getByLabel('Language').selectOption({ label: 'English' });
    await expect(dialog.getByLabel('Subject')).toHaveValue(
      /^Quotation QT-\d{4}-\d{2}-0003 from Rahman Garments Ltd\.$/,
    );
    await expect(dialog.getByLabel('Message')).toHaveValue(/^Dear Aarong,/);
    await expect(dialog.getByLabel('To', { exact: true })).toHaveValue('accounts@aarong.com');
    await dialog.getByRole('button', { name: 'Send email' }).click();
    await expect(page.getByText('Sending to accounts@aarong.com')).toBeVisible();
    await expect(dialog).toBeHidden();

    // Queued, then sent: the history asks again by itself while an email is on its way. Checked
    // before the toast closes, which takes longer than the mock's email.
    const row = historyRow(page, 'accounts@aarong.com');
    await expect(row).toContainText('Sending');
    await expect(row).toContainText('Sent');
    await expect(row).toContainText('CC mahmudul@aarong.com');
    await expect(row).toContainText('English · Farhana Rahman');
    await expectNoSideScroll(page);
  });

  test('says when an email bounced, and the bell opens the quotation', async ({ page }) => {
    await openQuotation(page, QT_3);
    await send(page, 'Email');
    const dialog = page.getByRole('dialog', { name: /Email QT-\d{4}-\d{2}-0003/ });
    await dialog.getByLabel('To', { exact: true }).fill('accounts@aarong.bounce');
    await dialog.getByRole('button', { name: 'Send email' }).click();
    await toastShown(page, 'Sending to accounts@aarong.bounce');

    const row = historyRow(page, 'accounts@aarong.bounce');
    await expect(row).toContainText('Failed');
    await expect(row).toContainText("The mail server didn't take it.");

    // From another page, the bell names the quotation and opens it
    await openFromNav(page, 'Overview');
    await page.getByRole('button', { name: /^Notifications/ }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /Quotation QT-\d{4}-\d{2}-0003 couldn't be emailed/ })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: QT_3 })).toBeVisible();
  });

  test('makes a link to share on WhatsApp, copies it, and turns it off', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openQuotation(page, QT_3);
    await send(page, 'Share on WhatsApp');
    const dialog = page.getByRole('dialog', { name: /Share QT-\d{4}-\d{2}-0003/ });
    await expect(dialog.getByLabel('Language')).toHaveValue('bn');
    await dialog.getByRole('button', { name: 'Make link' }).click();

    // The link and the message in Bangla, with the link in it
    const link = dialog.getByLabel('Link', { exact: true });
    await expect(link).toHaveValue(/\/d\/[A-Za-z0-9_-]{22}$/);
    const url = await link.inputValue();
    await expect(dialog.getByLabel('Message')).toHaveValue(
      new RegExp(`^Rahman Garments Ltd\\.: কোটেশন QT-\\d{4}-\\d{2}-0003, ৳[০-৯,.]+।`),
    );
    expect(await dialog.getByLabel('Message').inputValue()).toContain(url);
    await expect(dialog.getByText('The link is shown only now.', { exact: false })).toBeVisible();
    // WhatsApp opens in a new tab, to Aarong's mobile, with the message typed in
    const whatsApp = dialog.getByRole('link', { name: 'Open WhatsApp' });
    await expect(whatsApp).toHaveAttribute('href', /^https:\/\/wa\.me\/8801713045678\?text=/);
    await expect(whatsApp).toHaveAttribute('target', '_blank');
    await expect(dialog.getByText('is not a mobile number', { exact: false })).toHaveCount(0);
    await expectNoSideScroll(page);

    await dialog.getByRole('button', { name: 'Copy link' }).click();
    await toastShown(page, 'Link copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // The new link heads the list; turning it off asks first
    const active = historyRow(page, 'Active');
    await expect(active).toContainText('বাংলা');
    await expect(active).toContainText('Not opened yet');
    await active.getByRole('button', { name: /^Turn off the link made / }).click();
    const confirm = page.getByRole('dialog', { name: 'Turn off this link?' });
    await confirm.getByRole('button', { name: 'Turn off link' }).click();
    await toastShown(page, 'Link turned off');
    await expect(historyRow(page, 'Active')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Turn off the link made / })).toHaveCount(0);
  });

  test("starts from the customer's document language, and says when the phone is no mobile", async ({
    page,
  }) => {
    await openFromNav(page, 'Customers');
    await listItem(page, /Aarong/).click();
    await expect(page.locator('dt:text-is("Document language") + dd')).toHaveText('বাংলা');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByLabel('Document language').selectOption({ label: 'English' });
    // A Dhaka landline, written the way people do
    await page.getByLabel('Phone (optional)', { exact: true }).fill('02-9123456');
    await page.getByRole('button', { name: 'Save customer' }).click();
    await toastShown(page, 'Aarong saved');
    await expect(page.locator('dt:text-is("Document language") + dd')).toHaveText('English');

    await openQuotation(page, QT_3);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Download PDF in বাংলা' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Share on WhatsApp' }).click();
    const dialog = page.getByRole('dialog', { name: /Share QT-\d{4}-\d{2}-0003/ });
    await expect(dialog.getByLabel('Language')).toHaveValue('en');
    await dialog.getByRole('button', { name: 'Make link' }).click();
    await expect(dialog.getByLabel('Message')).toHaveValue(
      /^Rahman Garments Ltd\.: Quotation QT-\d{4}-\d{2}-0003 for ৳[\d,.]+\./,
    );
    // No number to send to: WhatsApp asks for the contact
    await expect(dialog.getByText('is not a mobile number', { exact: false })).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'Open WhatsApp' })).toHaveAttribute(
      'href',
      /^https:\/\/wa\.me\/\?text=/,
    );
  });

  test('shows where an older quotation went', async ({ page }) => {
    await openQuotation(page, /QT-\d{4}-\d{2}-0001/);
    const email = historyRow(page, 'sourcing.dhaka@hm.com');
    await expect(email).toContainText('Sent');
    await expect(email).toContainText('CC merchandising@rahmangarments.com');
    // A link that ran its 30 days, and one turned off: neither can be turned off now
    await expect(historyRow(page, 'Ended')).toContainText('First opened');
    await expect(historyRow(page, 'Turned off')).toContainText('Not opened yet');
    await expect(page.getByRole('button', { name: /^Turn off the link made / })).toHaveCount(0);
    await expectNoSideScroll(page);
  });

  test('downloads an invoice, and prints its amount in words', async ({ page }) => {
    await openFromNav(page, 'Invoices');
    await page.getByRole('button', { name: 'New invoice' }).first().click();
    // The list has a "Customer" filter too: wait for the form
    await expect(page.getByRole('heading', { level: 1, name: 'New invoice' })).toBeVisible();
    await page.getByRole('button', { name: 'Customer', exact: true }).click();
    await page.getByRole('combobox', { name: 'Search customers' }).fill('aarong');
    await page.getByRole('option', { name: /Aarong/ }).click();
    await page.getByRole('button', { name: 'Add items' }).click();
    const picker = page.getByRole('dialog');
    await picker.getByRole('searchbox', { name: 'Search products and services' }).fill('crew-neck');
    const item = picker.getByRole('listitem').filter({ hasText: 'Basic crew-neck T-shirt' });
    await item.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(item.getByRole('button', { name: 'Added' })).toBeVisible();
    await page.keyboard.press('Escape');
    // 10 T-shirts at ৳290 and 15% VAT: ৳3,335
    await page.getByRole('group', { name: 'Line 1' }).getByLabel('Quantity').fill('10');
    await page.getByLabel('Deliver from (optional)').selectOption({ label: 'MAIN · Main store' });
    await page.getByRole('button', { name: 'Post invoice' }).click();
    await toastShown(page, /INV-\d{4}-\d{2}-0001 posted/);

    const pdf = page.waitForEvent('download');
    await send(page, 'Download PDF');
    expect((await pdf).suggestedFilename()).toMatch(/^INV-\d{4}-\d{2}-0001\.pdf$/);

    // The printed page, in the screen's language, under the totals
    await expect(page.locator('[data-print-sheet]')).toContainText(
      'In words: Three thousand three hundred thirty-five taka only',
    );
  });
});

// A link opens in a new tab, which starts its own mock: these tests open the mock's demo links
test.describe('the page behind a link', () => {
  test('shows an invoice and downloads its PDF, without a login', async ({ page }) => {
    await page.goto('/d/demo-invoice-link-0042');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Invoice INV-2026-27-0042' }),
    ).toBeVisible();
    await expect(page.getByText('From Rahman Garments Ltd.')).toBeVisible();
    await expect(page.getByText('For Aarong')).toBeVisible();
    await expect(page.getByText('৳1,15,000.00')).toBeVisible();
    await expect(page.getByText('Still due')).toBeVisible();
    await expect(page.getByText('৳40,000.00')).toBeVisible();
    await expect(page).toHaveTitle('Invoice INV-2026-27-0042 from Rahman Garments Ltd.');
    // No app shell: the customer is not an Omnivo user
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await expectNoSideScroll(page);

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download PDF' }).click();
    expect((await download).suggestedFilename()).toBe('INV-2026-27-0042.pdf');
  });

  test("reads in the link's language, in this tab only, and waits for the PDF", async ({
    page,
  }) => {
    await page.goto('/d/demo-bangla-quote-0003');
    await expect(
      page.getByRole('heading', { level: 1, name: 'কোটেশন QT-2026-27-0003' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'PDF তৈরি হচ্ছে…' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'PDF ডাউনলোড' })).toBeEnabled();

    // The person's own language was not changed: the app opens in English
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  });

  test("says when the PDF couldn't be made", async ({ page }) => {
    await page.goto('/d/demo-failed-receipt-07');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Money receipt MR-2026-27-0007' }),
    ).toBeVisible();
    await expect(page.getByText("The PDF couldn't be made.", { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download PDF' })).toHaveCount(0);
  });

  test('says when a link no longer works', async ({ page }) => {
    // Unknown, ended and turned off look the same
    await page.goto('/d/link-turned-off-000001');
    await expect(page.getByText('This link no longer works')).toBeVisible();
    await expectNoSideScroll(page);
    // Not the shape of a link: the page does not ask the server
    await page.goto('/d/not-a-link');
    await expect(page.getByText('This link no longer works')).toBeVisible();
  });
});
