import { syncPullSchema } from '@omnivo/contracts';
import { newDeviceId, saveDevice } from '@omnivo/sync';
import { test as base, expect, type Locator, type Page, type Response } from '@playwright/test';

import { HEAD_OFFICES, OWNER, WORKSPACES } from '../src/mocks/fixtures.js';

export { expect };

const copies = new WeakMap<Page, Promise<void>>();

// The first pull of the copy ends: a page of /sync/pull with nothing more to send
function copyOf(page: Page): Promise<void> {
  return new Promise((resolve) => {
    const listener = (response: Response) => {
      if (!response.url().includes('/sync/pull') || !response.ok()) return;
      void response.json().then(
        (body: unknown) => {
          const parsed = syncPullSchema.pick({ hasMore: true }).safeParse(body);
          if (parsed.success && !parsed.data.hasMore) {
            page.off('response', listener);
            resolve();
          }
        },
        // The page closed before the body was read
        () => undefined,
      );
    };
    page.on('response', listener);
  });
}

// Step 18a: every test imports `test` from here. The garments workspace has three active branches,
// so a new device asks which branch it is in (decision 12), and each test is a new browser profile,
// a new device. Before the app starts, the fixture leaves in localStorage what that dialog leaves:
// a device of the head office. The mock does not know the device, so the first pull registers it
// again (device_not_found → registerAgain) and the dialog never shows. The key and the value come
// from @omnivo/sync's own saveDevice(), so their format is written in one place. A test of the
// dialog itself turns this off with test.use({ seedDevice: false }).
export const test = base.extend<{ seedDevice: boolean }>({
  seedDevice: [true, { option: true }],
  // `provide`, not Playwright's usual `use`: the React hooks lint rule reads `use(…)` as a hook
  page: async ({ page, seedDevice }, provide) => {
    copies.set(page, copyOf(page));
    if (seedDevice) {
      const [garments] = WORKSPACES;
      const saved = new Map<string, string>();
      saveDevice(
        { getItem: () => null, setItem: (key, value) => saved.set(key, value) },
        garments.tenantId,
        OWNER.id,
        { id: newDeviceId(), branchId: HEAD_OFFICES[garments.slug], later: false },
      );
      // Only when nothing is there: a reload keeps what the app saved since
      await page.addInitScript(
        (entries) => {
          for (const [key, value] of entries) {
            if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
          }
        },
        [...saved],
      );
    }
    await provide(page);
  },
});

// Until the device holds its first full copy. The products and customers pages and the pickers
// read only the copy (decision 5); the garments workspace's 10,000 styles take a few seconds to
// arrive, more than an assertion's 5 seconds on a busy machine.
export async function waitForCopy(page: Page): Promise<void> {
  const copy = copies.get(page);
  if (!copy) throw new Error('waitForCopy needs the page of the test fixture in helpers.ts');
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('The first pull did not finish in 25 seconds'));
    }, 25_000);
  });
  try {
    await Promise.race([copy, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

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
// Step 17d: a string matches part of the name; a RegExp when another item holds it too ("Refunds" and
// "Supplier refunds", step 17d).
export async function openFromNav(page: Page, name: string | RegExp): Promise<void> {
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
