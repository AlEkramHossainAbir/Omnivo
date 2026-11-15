import { expect, test } from '@playwright/test';

import { expectNoSideScroll } from './helpers.js';

// Step 26d, walked once in a real browser: the category page, a sub-category from a chip's menu,
// the sort in the address, Load More, search, and the category drawer

test('a category chip’s menu leads to a sub-category, and Sort By puts the sort in the address', async ({
  page,
}, testInfo) => {
  // The phone has no chips with menus and no Sort By (Figma home_page_mobile): the next test
  test.skip(testInfo.project.name === 'phone', 'desktop only');
  await page.goto('/c/all');
  await expect(page.getByRole('heading', { level: 1, name: 'All Products' })).toBeVisible();
  const filters = page.getByRole('navigation', { name: 'Filter the products' });
  await filters.getByRole('button', { name: 'Cosmetics' }).click();
  await page.getByRole('link', { name: 'Hair care' }).click();
  await expect(page).toHaveURL('/c/hair-care');
  await expect(page.getByRole('heading', { level: 1, name: 'Hair care' })).toBeVisible();

  await filters.getByRole('button', { name: 'Sort By' }).click();
  await page.getByRole('link', { name: 'Price: low to high' }).click();
  await expect(page).toHaveURL('/c/hair-care?sort=price_asc');
});

test('on a phone the categories are pills that lead to their page', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone only');
  await page.goto('/c/all');
  await page
    .getByRole('navigation', { name: 'Filter the products' })
    .getByRole('link', { name: 'Cosmetics' })
    .click();
  await expect(page).toHaveURL('/c/cosmetics');
  await expect(page.getByRole('heading', { level: 1, name: 'Cosmetics' })).toBeVisible();
  await expectNoSideScroll(page);
});

test('the sort in the address orders the cards', async ({ page }) => {
  await page.goto('/c/all?sort=price_asc');
  // Each card's price, read from the card. The price is the paragraph that is only an amount:
  // the discount ribbon ("৳10 off") also starts with ৳
  const prices = await page
    .getByRole('main')
    .getByRole('article')
    .evaluateAll((cards) =>
      cards.map((card) => {
        const price = [...card.querySelectorAll('p')]
          .map((p) => p.textContent.trim())
          .find((text) => /^৳[\d,]+(\.\d+)?$/.test(text));
        return Number((price ?? '').replace(/[৳,]/g, ''));
      }),
    );
  expect(prices).toHaveLength(20);
  // A card whose price was not found would be 0 (Number('')) and still sort; none may be
  expect(prices.every((price) => price > 0)).toBe(true);
  expect(prices).toEqual(prices.toSorted((a, b) => a - b));
});

test('Load More adds the next twenty and says so', async ({ page }) => {
  await page.goto('/c/all');
  const cards = page.getByRole('main').getByRole('article');
  await expect(cards).toHaveCount(20);
  await page.getByRole('link', { name: 'Load More' }).click();
  await expect(cards).toHaveCount(40);
  // The live region speaks, and the address stays (the next page is the link's, for no script)
  await expect(page.getByRole('main').getByRole('status')).toHaveText('20 more products');
  await expect(page).toHaveURL('/c/all');
  await expectNoSideScroll(page);
});

test('search finds by name, and a search that finds nothing says what to do', async ({ page }) => {
  await page.goto('/search?q=neem');
  await expect(page.getByRole('heading', { level: 1, name: 'Results for “neem”' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('article').first()).toContainText(/neem/i);

  await page.goto('/search?q=zzzz');
  await expect(page.getByRole('heading', { name: 'Nothing matches “zzzz”' })).toBeVisible();
  await page.getByRole('link', { name: 'See all products' }).click();
  await expect(page).toHaveURL('/c/all');
});

test('the category drawer opens from the header and leads to a category', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('banner').getByRole('button', { name: 'Categories' }).click();
  const drawer = page.getByRole('dialog', { name: 'Categories' });
  await drawer.getByRole('button', { name: 'Show the categories in Beverages' }).click();
  await drawer.getByRole('link', { name: 'Tea' }).click();
  await expect(page).toHaveURL('/c/tea');
  await expect(page.getByRole('heading', { level: 1, name: 'Tea' })).toBeVisible();
  await expectNoSideScroll(page);
});
