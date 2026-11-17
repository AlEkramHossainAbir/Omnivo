import { SHOP_TEXT_PAGES, todayIn, type ShopTextPageSlug } from '@omnivo/contracts';

// Step 26e: the footer's text pages (/pages/<slug>).

// A slug from the address, as one of the footer's four pages. A type guard, so the page can hand
// the slug to the source (textPage takes ShopTextPageSlug) without a cast. Exact: "Terms" is not
// "terms", because the footer links to the lower-case one and two addresses for one page would be
// two pages to a search engine
export function isTextPageSlug(slug: string | undefined): slug is ShopTextPageSlug {
  return SHOP_TEXT_PAGES.some((page) => page === slug);
}

// The day a page was last changed, in the shop's time zone, as a Date that formatDate() reads
// right. formatDate() reads a Date's local parts (the server's time zone), and a server in UTC
// would write 1 Nov 2026 00:30 in Dhaka as "31 Oct 2026". So the shop's calendar day is worked out
// first (todayIn, the ERP's helper), then made into midnight of that day on the server's clock
export function dayInShop(iso: string, timeZone: string): Date {
  const [year = 0, month = 1, day = 1] = todayIn(timeZone, new Date(iso)).split('-').map(Number);
  return new Date(year, month - 1, day);
}
