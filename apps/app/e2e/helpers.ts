import { expect, type Locator, type Page } from '@playwright/test';

// ডেস্কটপে টেবিলের রো, ফোনে কার্ড (role="button") — একই টেস্ট দুই আকারেই
export function listItem(page: Page, name: string | RegExp): Locator {
  return page.getByRole('row', { name }).or(page.getByRole('button', { name }));
}

// শুধু-পড়ার তালিকা (audit log): ডেস্কটপে রো, ফোনে কার্ড — কিন্তু কার্ড ক্লিক করা যায় না বলে
// role="button" নেই, সাধারণ <li>। listitem-এর নাম লেখা থেকে আসে না (ARIA), তাই নাম না, hasText
export function readOnlyItem(page: Page, text: string | RegExp): Locator {
  return page.getByRole('row').or(page.getByRole('listitem')).filter({ hasText: text });
}

// পেজ reload করলে MSW-এর mock ডেটা শুরুতে ফেরে — তাই পেজ বদলানো সবসময় nav-এর লিংকে ক্লিক করে
// (client-side), page.goto দিয়ে না। ফোনে nav একটা আড়াআড়ি scroll-এর সারি; Playwright নিজেই scroll করে
export async function openFromNav(page: Page, name: string): Promise<void> {
  await page.getByRole('navigation').getByRole('link', { name }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

// পেজ আড়াআড়ি scroll হয় না (CLAUDE.md → Page gutters) — চওড়া টেবিল শুধু নিজের বাক্সে
export async function expectNoSideScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

// A toast, then wait for it to close. On a phone it sits over the buttons at the bottom of the
// page, and it stays open while the pointer that just clicked rests on it: move the pointer away.
export async function toastShown(page: Page, text: string | RegExp): Promise<void> {
  await expect(page.getByText(text)).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(page.getByText(text)).toBeHidden();
}
