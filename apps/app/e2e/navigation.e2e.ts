import {
  actAs,
  expect,
  expectNoSideScroll,
  openFromNav,
  openModule,
  pinAnswered,
  test,
} from './helpers.js';

// Step 29: the module rail and the module menu (CLAUDE.md → Module rail, Module menu). Before
// this step the sidebar held all 78 links at once; now the menu holds one module's links and the
// rail says which module the page is in.

test('the rail holds the modules and the menu holds only the open one', async ({ page }) => {
  await page.goto('/');
  await pinAnswered(page);
  const rail = page.getByRole('navigation', { name: 'Modules' });
  // The eight modules, and no more: the Owner of the mock workspace may open all of them
  await expect(rail.getByRole('link')).toHaveCount(8);
  await expect(rail.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');

  // The Overview is Home's page, so Sell's links are nowhere on the screen
  await expect(page.getByRole('navigation', { name: 'Home' })).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Customers' })).toHaveCount(
    0,
  );

  await openModule(page, 'Sell');
  const sell = page.getByRole('navigation', { name: 'Sell' });
  await expect(rail.getByRole('link', { name: 'Sell' })).toHaveAttribute('aria-current', 'page');
  await expect(sell.getByRole('link', { name: 'Customers' })).toBeVisible();
  // The sync line is the menu's last item in every module, not an item of one
  await expect(sell.getByRole('link', { name: /^Sync/ })).toBeVisible();
  // Buy's links went when Sell opened
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Suppliers' })).toHaveCount(
    0,
  );
  // On a phone the modules are a second row under the module's links; neither row widens the page
  await expectNoSideScroll(page);
});

test('a page inside a module keeps its rail item marked, and /sync marks none', async ({
  page,
}) => {
  await page.goto('/stock/adjustments');
  await pinAnswered(page);
  const rail = page.getByRole('navigation', { name: 'Modules' });
  // The rail is not the router's active link: Stock's item points at /stock, and it stays marked
  // on every page of the module
  await expect(rail.getByRole('link', { name: 'Stock' })).toHaveAttribute('aria-current', 'page');

  // The sync page belongs to no module, so no module is marked (Home's menu is shown)
  await openFromNav(page, /^Sync/);
  await expect(page.locator('nav[aria-label="Modules"] a[aria-current="page"]')).toHaveCount(0);
});

test('the rail leaves out a module the role cannot use', async ({ page }) => {
  await actAs(page, { name: 'Store keeper', permissions: ['inventory.stock.adjust'] });
  await page.goto('/');
  await pinAnswered(page);
  const rail = page.getByRole('navigation', { name: 'Modules' });
  // Every shop link needs a storefront permission, and every report link a report one
  await expect(rail.getByRole('link', { name: /^Shop\b/ })).toHaveCount(0);
  await expect(rail.getByRole('link', { name: /^Reports\b/ })).toHaveCount(0);
  // What is left still opens: the documents and lists everyone reads
  await expect(rail.getByRole('link', { name: 'Sell' })).toBeVisible();
  await openModule(page, 'Stock');
  await expect(
    page.getByRole('navigation', { name: 'Stock' }).getByRole('link', { name: 'Stock on hand' }),
  ).toBeVisible();
});
