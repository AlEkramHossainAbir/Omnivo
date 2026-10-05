import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

// The nav says "Categories" and "Imports"; their pages say more in their headings
async function openPage(page: Page, link: string, heading: string) {
  await page.getByRole('navigation').getByRole('link', { name: link, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
}

async function newProduct(page: Page) {
  await openFromNav(page, 'Products');
  await page.getByRole('button', { name: 'Add product' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New product' })).toBeVisible();
}

test('finds a product by name or by a scanned barcode, and opens it', async ({ page }) => {
  await openFromNav(page, 'Products');
  const search = page.getByRole('searchbox', { name: 'Search products' });
  await search.fill('pique');
  await expect(listItem(page, /Pique polo shirt/)).toBeVisible();
  // A barcode is matched whole, like a scan into the box
  await search.fill('8941100500118');
  await expect(listItem(page, /Basic crew-neck T-shirt/)).toBeVisible();
  await expect(listItem(page, /Pique polo shirt/)).toBeHidden();
  await search.fill('cashmere');
  await expect(page.getByText('No product matches "cashmere"')).toBeVisible();

  await search.fill('pique');
  await listItem(page, /Pique polo shirt/).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Edit ST-118' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'M / Navy blue' }).getByLabel('SKU')).toHaveValue(
    'ST-118-M-NAVY-BLUE',
  );
  await expectNoSideScroll(page);
});

test('adds a simple product with a pack, and fills in a standard unit’s size', async ({ page }) => {
  await newProduct(page);
  await page.getByLabel('Name').fill('Poly mailer bag 12x16');
  await page.getByRole('button', { name: 'Add a pack' }).click();
  // A dozen is always 12 pieces: filled in, not typed
  await page.getByLabel('Pack', { exact: true }).selectOption({ label: 'dozen · Dozen' });
  await expect(page.getByLabel('Holds')).toHaveValue('12');
  await expect(page.getByText('A standard size, filled in for you.')).toBeVisible();
  // A carton's size is the product's own
  await page.getByLabel('Pack', { exact: true }).selectOption({ label: 'carton · Carton' });
  await page.getByLabel('Holds').fill('500');
  await page.getByLabel('Buy in').selectOption({ label: 'carton · Carton' });
  await page.getByLabel('Barcode (optional)', { exact: true }).fill('8941100500119');
  await page.getByRole('button', { name: 'Add product' }).click();
  // One wrong digit of a retail barcode is caught before anything is sent
  await expect(page.getByText('The last digit is wrong for this barcode.')).toBeVisible();
  await page.getByLabel('Barcode (optional)', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Add product' }).click();

  await expect(page.getByText('Poly mailer bag 12x16 added')).toBeVisible();
  // The next code of the series (the mock's sewing machine of step 13 is P-00005)
  await expect(page.getByRole('heading', { level: 1, name: 'Edit P-00006' })).toBeVisible();
  await expectNoSideScroll(page);
});

test('makes a product with sizes and colours, one variant per combination', async ({ page }) => {
  await newProduct(page);
  await page.getByLabel('Name').fill('Fleece hoodie');
  // Optional fields say so in their label
  await page.getByLabel('Code (optional)', { exact: true }).fill('ST-305');
  await page.getByText('With variants').click();
  await page.getByLabel('Option', { exact: true }).fill('Size');
  await page.getByLabel('Values').fill('S, M');
  await page.getByRole('button', { name: 'Add an option' }).click();
  await page.getByLabel('Option', { exact: true }).nth(1).fill('Colour');
  await page.getByLabel('Values').nth(1).fill('Navy, White');
  await page.getByRole('button', { name: 'Create the variants' }).click();

  const variants = page.getByRole('list', { name: 'Variants' });
  await expect(variants.getByRole('group')).toHaveCount(4);
  await variants
    .getByRole('group', { name: 'S / Navy' })
    .getByLabel('Sale price per pcs')
    .fill('950');
  await variants
    .getByRole('group', { name: 'M / White' })
    .getByRole('button', { name: 'Remove M / White' })
    .click();
  await expect(variants.getByRole('group')).toHaveCount(3);
  await page.getByRole('button', { name: 'Add product' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Edit ST-305' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'S / White' }).getByLabel('SKU')).toHaveValue(
    'ST-305-S-WHITE',
  );
  // Back to the list: three variants, the one price
  await page.getByRole('link', { name: '← Products' }).click();
  await page.getByRole('searchbox', { name: 'Search products' }).fill('fleece');
  await expect(listItem(page, /Fleece hoodie/)).toContainText('3 variants');
  await expect(listItem(page, /Fleece hoodie/)).toContainText('৳950.00');
});

test('keeps categories in a tree, and an emptied one only can go', async ({ page }) => {
  await openPage(page, 'Categories', 'Product categories');
  await page.getByRole('button', { name: 'Add a category to Fabrics' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add category' });
  await expect(dialog.getByLabel('Inside')).toHaveValue(/.+/);
  await dialog.getByLabel('Name').fill('knit');
  await dialog.getByRole('button', { name: 'Add category' }).click();
  await expect(dialog.getByText('This place already has a category with this name.')).toBeVisible();
  await dialog.getByLabel('Name').fill('Denim');
  await dialog.getByRole('button', { name: 'Add category' }).click();
  await expect(page.getByText('Denim added')).toBeVisible();

  const tree = page.getByRole('list', { name: 'Product categories' });
  await tree.getByRole('button', { name: 'Knit', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Knit' });
  await edit.getByRole('button', { name: 'Delete' }).click();
  await edit.getByRole('button', { name: 'Delete Knit' }).click();
  await expect(edit.getByRole('alert')).toHaveText(/Move them to another category first/);
});

test('adds a custom field, which the product form then shows', async ({ page }) => {
  await openFromNav(page, 'Custom fields');
  await page.getByRole('button', { name: 'Add field' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add field' });
  await dialog.getByLabel('Label').fill('Wash care');
  // The column name follows the label until it is typed by hand
  await expect(dialog.getByLabel('Column name in imports')).toHaveValue('wash_care');
  await dialog.getByLabel('Type').selectOption({ label: 'Choice from a list' });
  await dialog.getByLabel('Choices').fill('Hand wash\nMachine wash 30°C');
  await dialog.getByRole('button', { name: 'Add field' }).click();
  await expect(page.getByText('Wash care added')).toBeVisible();

  await newProduct(page);
  await expect(page.getByLabel('Wash care')).toBeVisible();
  await page.getByLabel('GSM').fill('heavy');
  await page.getByLabel('Name').fill('Rib cuff sweatshirt');
  await page.getByRole('button', { name: 'Add product' }).click();
  await expect(page.getByText('Enter a number, like 180 or 12.5.')).toBeVisible();
});

test('imports a CSV file, or lists what to fix in it', async ({ page }) => {
  await openPage(page, 'Imports', 'Import products');
  const file = page.getByLabel('CSV file');
  await file.setInputFiles({
    name: 'trims.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('name,unit,sale_price\nYKK zipper 7 inch,pcs,18\nCare label,pcs,1.5\n'),
  });
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText('trims.csv is being imported.')).toBeVisible();
  await expect(page.getByText('2 products')).toBeVisible();
  await expect(page.getByText('Imported', { exact: true })).toBeVisible();

  await file.setInputFiles({
    name: 'bad.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('name,unit\nWoven label,tablet\n'),
  });
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.getByRole('button', { name: /See problems/ }).click();
  const problems = page.getByRole('dialog', { name: 'Problems in bad.csv' });
  await expect(problems.getByRole('row', { name: /2 unit No unit "tablet"/ })).toBeVisible();

  // A spreadsheet that is not a CSV is refused before any upload
  await page.keyboard.press('Escape');
  await file.setInputFiles({
    name: 'products.xlsx',
    mimeType: 'application/vnd.ms-excel',
    buffer: Buffer.from('x'),
  });
  await expect(page.getByText('Pick a CSV file.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
  await expectNoSideScroll(page);
});
