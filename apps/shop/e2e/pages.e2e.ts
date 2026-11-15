import { expect, test } from '@playwright/test';

import { expectNoSideScroll } from './helpers.js';

// Step 26e: the footer's four text pages (/pages/<slug>) and "page not found" (404.astro)

test('every footer link opens its page, under the footer’s own word', async ({ page }) => {
  // The title is the footer's word (decision 15), so the link and the page always say the same
  const pages = [
    { link: 'Privacy Policy', path: '/pages/privacy' },
    { link: 'Terms & Condition', path: '/pages/terms' },
    { link: 'About Us', path: '/pages/about' },
    { link: 'Contact Us', path: '/pages/contact' },
  ];
  for (const { link, path } of pages) {
    await page.goto('/');
    await page
      .getByRole('navigation', { name: 'Shop pages' })
      .getByRole('link', { name: link })
      .click();
    await expect(page).toHaveURL(path);
    await expect(page.getByRole('heading', { level: 1, name: link })).toBeVisible();
    await expect(page).toHaveTitle(`${link} | Omnivo`);
    await expectNoSideScroll(page);
  }
});

test('a page says when it was last updated, and only when that is known', async ({ page }) => {
  await page.goto('/pages/terms');
  await expect(page.getByText('Last updated 1 Nov 2026')).toBeVisible();
  // The delivery charges come from the checkout's own settings, so the terms cannot disagree
  await expect(page.getByRole('main')).toContainText('2 to 4 days, ৳120.');
  // The mock's About page has no date
  await page.goto('/pages/about');
  await expect(page.getByText(/^Last updated/)).toHaveCount(0);
});

test('an address the shop has no page for gets the shop’s own 404', async ({ page }) => {
  // No route, a product that is not sold, a text page that is not one of the four (case counts),
  // and an order page opened by a browser that did not place the order (26c)
  for (const path of ['/nope', '/p/nope', '/pages/refunds', '/pages/Terms', '/order/W-000121']) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(404);
    await expect(page).toHaveTitle('Page not found | Omnivo');
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  }
  // The full layout: the header is there to search or open a category from
  await expect(page.getByRole('banner')).toBeVisible();
  await expectNoSideScroll(page);
  await page.getByRole('link', { name: 'Go to the home page' }).click();
  await expect(page).toHaveURL('/');
});
