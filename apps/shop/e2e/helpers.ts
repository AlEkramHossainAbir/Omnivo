import { randomBytes } from 'node:crypto';

import { expect, type Page } from '@playwright/test';

// The storefront's rule for every width: the page never scrolls sideways (CLAUDE.md → Storefront
// shape and layout). A box that is too wide shows up here as the page being wider than the screen.
export async function expectNoSideScroll(page: Page): Promise<void> {
  const extra = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(extra, 'the page is wider than the screen').toBe(0);
}

// A visitor of its own for one test. The /track form's limit (26e.2) counts misses per address,
// and every test reaches one server, so tests that miss on purpose would use up each other's tries
// if they all came from 127.0.0.1. The server reads X-Forwarded-For (astro.config.ts → security),
// as it would from Caddy. IPv6 in the documentation block 2001:db8::/32, with a random /64: the
// limit counts a whole /64 as one visitor, and 32 random bits mean two tests (or a rerun against
// a server still running, which keeps its counts for 15 minutes) never meet
export function newVisitor(): Record<string, string> {
  const [a, b] = [randomBytes(2).toString('hex'), randomBytes(2).toString('hex')];
  return { 'X-Forwarded-For': `2001:db8:${a}:${b}::1` };
}
