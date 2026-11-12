import { describe, expect, it } from 'vitest';

import { encodeCursor } from '../data/mock/browse';
import { createMockSource } from '../data/mock/mock-source';
import { loadListing, type ListingLoad } from './listing-page';
import { listingHref } from './listing-query';

const source = createMockSource();

function load(slug: string | null, search = ''): Promise<ListingLoad> {
  return loadListing(slug, new URLSearchParams(search), source);
}

describe('loadListing', () => {
  it('finds a category by its slug', async () => {
    const answer = await load('cosmetics', 'sort=name');
    if (answer.kind !== 'found') throw new Error(`expected a list, got ${answer.kind}`);
    expect(answer.category?.name).toBe('Cosmetics');
    expect(answer.query).toMatchObject({ category: 'cosmetics', sort: 'name' });
    expect(answer.page.items.length).toBeGreaterThan(0);
  });

  it('shows every listing on /c/all', async () => {
    const answer = await load('all');
    if (answer.kind !== 'found') throw new Error(`expected a list, got ${answer.kind}`);
    expect(answer.category).toBeNull();
    expect(answer.query.category).toBeNull();
    expect(answer.page.items).toHaveLength(20);
  });

  it('answers missing for a slug no category has', async () => {
    expect(await load('no-such-category')).toEqual({ kind: 'missing' });
  });

  it('sends a search with no words to /c/all, keeping the other choices', async () => {
    expect(await load(null, 'q=%20%20&offer=1')).toEqual({
      kind: 'restart',
      href: '/c/all?offer=1',
    });
  });

  it('starts again at the first page for a cursor the source did not make', async () => {
    expect(await load('tea', 'sort=price_asc&cursor=not-a-cursor')).toEqual({
      kind: 'restart',
      href: '/c/tea?sort=price_asc',
    });
  });

  it('starts again when a cursor points past the end', async () => {
    // The mock's cursor is the position: 'mock:500' is past its 63 listings
    const past = encodeCursor(500);
    expect(await load('all', `cursor=${past}`)).toEqual({ kind: 'restart', href: '/c/all' });
  });

  it('follows its own next cursor to the next page', async () => {
    // What Load More does: the link the first page wrote gives the cards after it
    const first = await load('all');
    if (first.kind !== 'found' || first.page.nextCursor === null) throw new Error('no next page');
    const next = new URL(
      listingHref(first.query, { cursor: first.page.nextCursor }),
      'https://shop.example',
    );
    const second = await load('all', next.search);
    if (second.kind !== 'found') throw new Error(`expected a list, got ${second.kind}`);
    const firstIds = first.page.items.map((item) => item.id);
    expect(second.page.items.some((item) => firstIds.includes(item.id))).toBe(false);
  });
});
