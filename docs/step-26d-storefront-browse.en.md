# Step 26d: Storefront, part 4 — the category and search pages

> The implementation guide for "Phase 10 → Step 26", the fourth part, of [build-plan.bn.md](build-plan.bn.md). Step 26
> has five parts:
>
> - **26a (done):** `apps/shop`, the tokens, the data contract, the mock, the header, the footer and the home page.
> - **26b (done):** server mode, the product page `/p/<slug>` and the cart drawer.
> - **26c (done):** the checkout, the phone code, the "Order Confirmed" dialog and the order page.
> - **26d (this guide):** the category and search pages (`/c/<slug>`, `/search`) with the chip menus, the filters, the
>   sort and Load More, and the category drawer. Before them, the shop's words leave the ERP app's first load.
> - **26e:** order tracking `/track`, the text pages, "page not found" and a closed shop, and the shop's first
>   Playwright tests.

> Every file in this guide was placed in a separate copy of the repo (on top of commit `3d74aea`, "Merge branch
> 'main' into dev") and checked on 2026-11-12: `pnpm dedupe --check`, `pnpm build`, `pnpm lint`, `pnpm format`,
> `pnpm typecheck`, `pnpm test` (1,156, of them 160 in `apps/shop`, 465 in `packages/contracts` and 210 in
> `apps/app`), `pnpm boundaries`, `pnpm test:bundle-size` (the ERP app's first load 231.7 KB gz, down from 233.3; budget
> 235) and `pnpm test:openapi`, all clean.
>
> **Not run:** `test:integration`, `test:tenant-leak` and the e2e suites. This step changes no code in `apps/api`, and
> in `apps/app` only the words it loads: the `shop` block it never showed leaves `en.ts` and `bn.ts`. The type check
> proves no ERP screen asks for a `shop.*` key (it would not compile), and the unit tests, the build and the bundle
> check cover the rest. The shop's Playwright tests come with 26e.
>
> Also checked, in Chromium (Playwright, against the built server), at 1440, 900 and 390px:
>
> - **The lists against the home page's "All Category" block.** On `/c/all`, `/c/cosmetics`, `/c/skin-care`,
>   `/search?q=neem` and a filtered `/c/all`: the title 36px under the header (16px on a phone), 36px from the title to
>   the filter row and from the row to the grid (12px and 16px on a phone), as on the home page. At 1440px the cards
>   are 243×458 in five columns from x 80, as on the home page; three columns at 900px, one at 390px. Load More 48px
>   under the grid (24px on a phone). Nothing scrolls sideways at any width.
> - **Load More:** 20, 40, 60, then 62 cards, none twice; the live region says "20 more products", then "2 more
>   products", and the focus lands on the 61st card.
> - **The filters:** Offer + ৳100–500 + in stock + price high to low gives 11 cards from ৳270 down to ৳120.
>   `/search?q=নিম` finds the Bangla-named neem face wash; `/search?q=zzzz` shows the empty state; `/c/nope` is 404.
> - **The drawer:** opens from the menu button on every width (420px, the whole width at 390px), the focus on its close
>   button, the list on screen marked and its group open; Escape, the close button and the backdrop shut it and give
>   the focus back; Back after a link in it lands with it shut. A long shop name ends in "…" at 390px.
> - **In Bangla** (`language: 'bn'` in the mock): the titles, the chips, the sort menu, the filter panel, the empty
>   state, Load More's "আরও ২০টি পণ্য" and the drawer, with Bangla digits in the prices.
> - **Broken on purpose** while the parts were written, each caught by a test, the type check or a hand check. Each
>   part's "Check this part" lists them.
> - **No console errors** on any of these pages.

## Goal

🗂️ **A shopper can browse and search.** After 26c every chip, "View All", "Load More" and the header's search box led
to a 404. After this step:

- **`/c/<slug>` and `/c/all`** show a category's products (with those of the categories under it) in the home page's
  "All Category" block: the title, the filter row, the 5-column grid and Load More.
- **`/search?q=neem`** shows the same block for a search, by name, SKU or category, in English or Bangla.
- **The filter row works:** a category chip opens a menu of the categories under it, "Offer" switches the sale filter
  on and off, "All Filter" filters by price and stock, and "Sort By" sorts by date, price or name. Every choice is in
  the address, so a link to a filtered page can be shared and the Back button works.
- **Load More adds 20 cards** without leaving the page, and says "Loading" while it waits. Without JavaScript it is
  still a link to the next 20.
- **The header's menu button** opens the category drawer.
- **The ERP app loads less:** the shop's words move out of `en.ts` into their own entry, `@omnivo/i18n/shop`.

## The whole picture

```
packages/i18n        locales/shop/en.ts, bn.ts ─► the entry @omnivo/i18n/shop (setShopLanguage); only apps/shop
                     imports it, so the ERP app's first load drops the shop's words
packages/contracts   storefront.ts: SHOP_SORTS, SHOP_PAGE_SIZE (20), shopListingQuerySchema, shopListingPageSchema
      │
      ▼
apps/shop/src/data   source.listings(query) → ShopListingPage | null       mock/browse.ts: 62 listings, cursor "mock:<n>"
      │
      ▼
src/lib              listing-query.ts: the address ⇄ ShopListingQuery      listing-page.ts: loadListing()
      │              category-tree.ts: the drawer's tree
      ├───────────────────────────────┬────────────────────────────────────┐
      ▼                               ▼                                    ▼
/c/<slug>, /search              /c/<slug>/more, /search/more         every page
  ListingView: the title,         the next 20 cards only               ShopLayout ─► Header (Menu01)
  CategoryFilters (popovers),     (partial = true); 404 or 409,                    ─► CategoryDrawer (<dialog>)
  ListingGrid, LoadMore           never a redirect
      │
      ▼
the browser
  Load More's script ─► fetch('/c/all/more?cursor=…') ─► moves the new <li> into the grid, takes the next link
  the filter form's script ─► leaves the empty boxes out of the address

Thursday 12 Nov 2026, a shopper in Sylhet wants a face wash under ৳300:
  the menu button ─► Cosmetics ─► /c/cosmetics: 20 cards and Load More
  the Cosmetics chip ─► Skin care ─► /c/skin-care: 10 cards
  Sort By ─► Price: low to high ─► /c/skin-care?sort=price_asc: ৳85 first
  All Filter, To 300, Apply ─► /c/skin-care?sort=price_asc&max=300: 9 cards. They send the link to their sister.
```

## Not in this step, on purpose

- **No `/track`, text pages, "page not found" page or closed shop.** 26e.
- **No Playwright tests.** 26e, when every screen of the shop is there.
- **No search suggestions while typing.** A search is a page, like a category.
- **No "Popular" sort.** It needs sales numbers per listing, which the public API does not give.
- **No filters or sort on the phone.** `CLAUDE.md` → Filter row: the phone shows the categories only.

## What changes in the code you already have

| File | Change |
|---|---|
| `packages/i18n/src/locales/en.ts`, `bn.ts` | The `shop` block moves out, to `locales/shop/` |
| `packages/i18n/src/types.ts`, `package.json` | `Translation` becomes an interface; the `./shop` entry |
| `eslint.config.js` | One override for `packages/i18n/src/shop.ts` |
| `packages/contracts/src/storefront.ts`, `storefront.spec.ts` | The listing query and the listing page |
| `apps/shop/src/lib/locale.ts` | Loads the shop's words with `setShopLanguage` |
| `apps/shop/src/boundaries.spec.ts` | `@omnivo/i18n/shop` is as heavy as the main entry for a browser script |
| `apps/shop/src/data/types.ts`, `mock/mock-source.ts` | `listings(query)` on the source |
| `apps/shop/src/data/mock/listings.ts`, `products.ts`, `shop.ts`, `mock.spec.ts` | 62 listings, newest first; Skin care and Hair care under Cosmetics |
| `apps/shop/src/components/CategoryFilters.astro` | Reads the query; the chip menus, the filter panel and the sort menu |
| `apps/shop/src/components/Header.astro`, `Logo.astro`, `layouts/ShopLayout.astro` | The menu button on every screen size, the drawer, the search box keeps `q` |
| `apps/shop/src/pages/index.astro`, `checkout.astro`, `checkout/verify.astro`, `order/[no].astro`, `p/[slug].astro` | Each page gives the layout its categories |
| `apps/shop/src/styles/shop.css` | `chip-menu`, the menus' place under their chip |

New: `packages/i18n/src/locales/shop/` and `src/shop.ts`; in `apps/shop/src`: the mock's `browse.ts`, `lib/listing-query.ts`,
`listing-page.ts` and `category-tree.ts`, the components `ListingView`, `ListingGrid`, `LoadMore`, `EmptyState`,
`CategoryDrawer` and `CategoryTreeList`, the pages `/c/<slug>` and `/search`, and their Load More partials.

## The decisions behind this step

The first nine were agreed before the step started. The rest were made while writing it; each says why.

0. **The shop's words leave the ERP app's first load.** They were in `packages/i18n/src/locales/en.ts`, which the ERP
   app loads at start, and its first load was 233.3 KB gz of its 235 KB budget after 26c. No ERP screen shows them. They
   move into `locales/shop/en.ts` and `bn.ts`, behind a new entry `@omnivo/i18n/shop` that only the shop imports. The
   other choice, a bigger budget, would grow again with every shop word.
1. **26d is split in two.** 26d is browsing (this guide); 26e is tracking, the text pages, the error pages and the
   Playwright tests. One guide for all of it would be twice the size of 26c's.
2. **The filters live in the address** (`/c/cosmetics?sort=price_asc&min=100&max=500&stock=1&offer=1`), and the server
   draws the page. A filtered page can be shared and bookmarked, Back works, and it needs no JavaScript.
3. **Load More is a link that a script improves.** Without JavaScript it opens the next page. With it, a small script
   asks the server for the next cards as HTML (an Astro partial) and adds them under the others. The cards are drawn
   by the same `ProductCard.astro` on the server, so there is no second card template in the browser.
4. **20 cards a page and an opaque cursor.** Four rows of five. The cursor is a string only the source reads, as in
   the ERP's lists (`pagination.ts`): the real API pages by keyset, the mock by position. The mock grows to about 60
   listings so that Load More, sorting and the filters have something to show.
5. **The chip menus use the browser's own `popover`.** A category chip is a button (`popovertarget`) that opens a list
   of links: "All of Cosmetics" first, then the categories under it. No script: the browser closes it on Escape or a
   click outside.
6. **"Offer" is a switch.** It has no menu, so it has no chevron. This differs from Figma, and `CLAUDE.md` says so.
7. **"All Filter" and "Sort By" are popovers too.** The filter is a GET form: price from and to, "In stock only",
   Apply and Clear. The sort is a list of four links: Newest (the default), Price: low to high, Price: high to low,
   Name: A to Z.
8. **Search runs on the server.** It looks at the name, the SKU and the category's name, ignores upper and lower case,
   and works with Bangla words. An empty search goes to `/c/all`; no results shows the empty state.
9. **The category drawer is a native `<dialog>`** like the cart drawer, from the left, with the category tree.
<!-- DECISIONS-26d.1 -->
10. **The shop's keys are typed in the shop only.** `t()` checks its keys against one type. That type is now an
    interface, `Translation` (`packages/i18n/src/types.ts`), and `@omnivo/i18n/shop` adds `shop` to it by declaration
    merging. A program sees the addition only when it imports that entry: in the ERP app `t('shop.cart.title')` is a
    compile error, in the shop it type-checks. A type alias cannot be merged into, so the interface is empty on
    purpose, and one ESLint override allows that shape in that one file.
11. **The shop's words join the same namespace.** They are added to `translation` with `addResourceBundle`, deep, so
    every key keeps its name (`shop.cart.title`), and `errors.*` and `common.*` work in the shop as before. A second
    namespace would have changed all 172 calls.
12. **`errors.shop_*` stay in `en.ts`.** `en.errors` must have a word for every `ErrorCode` (its `satisfies`), and the
    ERP's `errorText()` reads it to know a code. They are about 0.5 KB.
13. **The page size is not a request field.** A shopper's address cannot ask for 1,000 cards in one answer.
14. **A price filter is whole taka**, written as a decimal string like every amount. Nobody filters by paisa. A pair
    typed the wrong way round (from 500 to 100) is swapped by the page; the schema refuses it only for a caller that
    skipped the page.
15. **No total in the answer**, as in the ERP's lists: the page never shows a count, and counting every match costs
    the database a full read.
16. **A category includes the categories under it.** "Beverages" shows the tea too; otherwise a top category with
    only sub-categories would look empty.
<!-- DECISIONS-26d.2 -->
17. **A cursor the source did not make is not an error.** `listings()` answers `null`, and the page sends the shopper
    to the first page of the same list (26d.3). An old bookmark or an edited address is normal traffic, like an
    unknown slug on the product page. The ERP API answers `invalid_cursor` (400) instead, because there only the app
    makes the cursors.
18. **`/c/all` is every listing**, so `all` is a reserved slug: a category with that slug could not have a page.
19. **What a search looks in:** the name, the names of the listing's category and of every category above it (a
    search for "beverages" finds the teas), and the SKU. Not the pack size, as agreed in decision 8. Every word must
    be found, in any order. Upper and lower case are the same, and Bangla is compared in one Unicode form (NFC), so a
    letter like য় matches however the keyboard typed it.
20. **Equal prices or names keep the newest first.** Without a rule, two cards at ৳99 could swap places between two
    loads, and Load More could show one twice and the other never.
21. **The mock gets two sub-categories under Cosmetics** (Skin care, Hair care), and the face washes and shampoos move
    into them. Then `/c/cosmetics` shows the listings of the categories under it, and the category drawer (26d.4) has a
    top category with more than one child.
22. **The address is read leniently and written one way.** A value that makes no sense (an unknown sort, `min=abc`)
    is dropped, never an error page. Bangla digits, the grouping comma and leading zeros are accepted. The links the
    pages write leave out the defaults and put the keys in one order, so one list has one address.

<!-- DECISIONS-26d.3 -->
23. **"All Categories" is a plain link, with no chevron.** Figma draws a chevron on it, but its menu could only list
    the chips that sit next to it. Like the Offer chip (decision 6), this differs from Figma, and `CLAUDE.md` will say
    so (26d.5).
24. **A top category with nothing under it is a link, not a menu.** A menu with one line ("All of Household") is a
    click for nothing. Only a chip with a menu has a chevron, so the chevron always means "this opens".
25. **The menus are white cards with the rule line** (`card`, 1px `rule`, radius 8, no shadow), and the current line
    is bold with a `Tick02` icon. Figma has no open menu; this follows the storefront's flat cards, and `CLAUDE.md`
    gets the look in 26d.5.
26. **A Load More partial never redirects.** It answers 404 (unknown category) or 409 (start again) instead. `fetch()`
    follows a redirect by itself, so a redirect to the first page would give the script the first 20 cards again, and
    it would add them a second time. On any answer that is not 200, the script follows the link, and the page
    itself redirects.
27. **An empty page after a cursor starts again too.** The cards the cursor pointed past were taken off the shop since,
    and "No products here yet" would be wrong about the list.
28. **Load More keeps the focus where it is**, and says "20 more products" in a live region. Only on the last page,
    when the link goes away, the focus moves to the first new card's name, so a keyboard user is never left on
    nothing.
29. **The filter panel leaves empty boxes out of the address**, with a small script. A Bangla number stays in the
    address as typed (`min=৫০০`): the page reads it like `500`, so the list is right, and a redirect to the tidy
    address would cost a second request for every filter. Without JavaScript the native form sends `min=&max=`, which
    the page reads as "not set".
30. **The menus are placed with CSS anchor positioning**, with no positioning script. A browser without it (an older
    Firefox or Safari) shows the menu in the middle of the screen, where the browser puts a popover by itself. It still
    works and still closes with Escape.

<!-- DECISIONS-26d.4 -->
31. **The phone gets the menu button too**, at the left of the header before the logo, as a 40px white button like the
    three on the right (agreed with you on 2026-11-12). Figma's phone header has no menu. A button in the header
    reaches the drawer from every page, the product page and the checkout included. A pill in the category row would
    reach it only from the home page and the lists. This differs from Figma, and `CLAUDE.md` will say so (26d.5).
32. **The layout gets the categories from the page, as a required prop.** The layout does not ask the data source
    itself. Most pages already have the list (the filter row needs it, and the product page needs its category). A
    page that forgets it fails the type check, instead of drawing an empty drawer.
33. **A category's name and its show/hide button are two controls.** A tap on "Cosmetics" opens the Cosmetics list,
    like its chip. The arrow next to it shows "Skin care" and "Hair care" without leaving the page. The drawer opens
    with the list on screen in view: its group and every group above it start open, and its row is marked.
34. **The drawer closes when the page is left.** The browser may keep a page in its back/forward cache with the
    drawer open. Without this, Back after a tap on "Hair care" would land on an open drawer.

## 26d.1 — `packages/i18n` and `packages/contracts`: the shop's own words and the listing page

This part moves the shop's words, adds the contract of the category and search pages, and adds their words. Nothing
the shopper sees changes yet; the ERP app's first load gets smaller.

### Move the words: `src/locales/shop/en.ts`, `bn.ts` and `messages.ts`

In `packages/i18n/src/locales/en.ts`, cut the whole `shop: { … }` group (it starts with `shop: {` and ends with the
`},` before the `print` group's comment), together with the two comment lines above it. Do the same in `bn.ts` (there
it has no comment). Then make three new files. The words in them are the ones you cut, moved two spaces to the left,
plus 26d's new `listing` and `drawer` groups before `footer`:

```ts
// Step 26a: the tenant's public online shop (apps/shop). Its buttons keep the design's Title Case
// ("Load More", "Sort By"), as CLAUDE.md → Storefront design system says.
// Step 26d: its own file, out of en.ts. The ERP app loads en.ts at start, and none of its screens
// shows these words; here they reach only the shop, through '@omnivo/i18n/shop' (../../shop.ts).
// The keys stay under `shop.*`: the shop calls t('shop.cart.title') as before
export const shopEn = {
  skipToContent: 'Skip to content',
  header: {
    home: '{{shop}} home',
    search: 'Search',
    searchLabel: 'Search the shop',
    searchPlaceholder: 'Search for Cosmetics, Food',
    openSearch: 'Open search',
    closeSearch: 'Close search',
    categories: 'Categories',
    cart_one: 'Cart, {{count}} item',
    cart_other: 'Cart, {{count}} items',
    cartEmpty: 'Cart, empty',
    added: 'Added to cart',
    account: 'Account',
  },
  home: {
    title: '{{shop}}: shop online',
    allCategory: 'All Category',
    allCategories: 'All Categories',
    categoryFilters: 'Filter the products',
    all: 'All',
    offer: 'Offer',
    allFilter: 'All Filter',
    sortBy: 'Sort By',
    featured: 'Featured Products',
    viewAll: 'View All',
    loadMore: 'Load More',
    previous: 'Previous products',
    next: 'Next products',
  },
  card: {
    addToCart: 'Add to cart',
    addToCartLabel: 'Add {{name}} to cart',
    outOfStock: 'Out of Stock',
    // The ribbon's two lines: "৳10" over "OFF"
    off: 'OFF',
    // What a screen reader says for the ribbon
    discount: '{{amount}} off',
    badge: {
      most_picked: 'Most Picked',
      new: 'NEW',
      buy_one_get_one: 'Buy 1 Get 1',
    },
  },
  // The product page (/p/<slug>)
  product: {
    title: '{{name}} | {{shop}}',
    gallery: 'Photos of {{name}}',
    showPhoto: 'Show photo {{index}} of {{count}}',
    // The countdown's words for a screen reader, read once: a clock that changes every second
    // is not read out
    saleEnds: 'Sale ends {{date}}',
    size: 'Size',
    // Before the struck-out price, for a screen reader: <s> alone is not read as "was"
    wasPrice: 'Was {{price}}',
    perUnit: 'Per {{unit}}',
    placeOrder: 'Place Order',
    inStock: 'Available in stock',
    outOfStock: 'Out of stock',
    sku: 'SKU: {{sku}}',
    hotline: 'Hotline:',
    callHotline: 'Call {{phone}}',
    details: 'Product details',
    overview: 'Overview',
    related: 'Related Products',
  },
  // The cart drawer, opened from the header's cart button
  cart: {
    title: 'Your Cart',
    close: 'Close cart',
    loading: 'Getting today’s prices…',
    failed: 'The prices did not load. Check the connection, then try again.',
    retry: 'Try again',
    decrease: 'One less {{name}}',
    increase: 'One more {{name}}',
    quantity: 'How many {{name}}',
    remove: 'Remove {{name}}',
    outOfStock: 'Out of stock: not in the subtotal',
    // Said when the answer drops listings the shop no longer sells
    removed_one: '{{count}} item is no longer sold, so it left your cart.',
    removed_other: '{{count}} items are no longer sold, so they left your cart.',
    subtotal: 'Subtotal',
    checkout: 'Checkout',
    emptyTitle: 'Your cart is empty',
    emptyText: 'Add products with “Add to cart” and they wait for you here.',
    continueShopping: 'Continue shopping',
  },
  // Step 26c: /checkout (Figma checkout_process). The words of the React island come from here
  // too: the page translates them on the server and hands them over as props
  checkout: {
    title: 'Checkout',
    // The browser tab: the page, then the shop
    pageTitle: 'Checkout | {{shop}}',
    heading: 'Shipping & Contact Details',
    name: 'Full Name',
    phone: 'Mobile Number',
    address: 'Delivery Address',
    zone: 'Delivery Location',
    zoneOption: '{{name}} — {{charge}}',
    freeDeliveryFrom: 'Free delivery on orders over {{amount}}',
    items: 'Your items',
    outOfStock: 'Out of stock: remove it to order',
    // Under a line whose price changed after Confirm Order was refused (shop_order_changed)
    priceChanged: 'Was {{old}}',
    deliveryCharge: 'Delivery Charge',
    free: 'Free',
    // In the Delivery Charge row before a location is picked
    pickZone: 'Pick a location',
    discount: 'Discount ({{code}})',
    total: 'Total',
    promo: 'Promo code',
    promoPlaceholder: 'Add Promo',
    apply: 'Apply Coupon',
    applying: 'Applying…',
    removeCoupon: 'Remove the code',
    couponApplied: '{{code}} applied: {{off}} off',
    payment: 'Payment Method',
    cod: 'Cash on Delivery',
    online: 'Mobile Banking',
    // Three parts, because the link sits inside the sentence and Bangla puts it first
    termsBefore: 'I agree with the ',
    termsLink: 'Terms and Conditions',
    termsAfter: '',
    confirm: 'Confirm Order',
    placing: 'Placing the order…',
    // No answer from the server: the order may not have reached it
    orderFailed: 'The order was not sent. Check the connection, then try again.',
    belowMinimum: 'Orders start at {{minimum}}. Add {{more}} more to order.',
    emptyTitle: 'Your cart is empty',
    emptyText: 'Add products to your cart, then come back here to order them.',
  },
  // Step 26c: /checkout/verify, the phone code for Cash on Delivery
  verify: {
    title: 'Verify Your Phone',
    pageTitle: 'Verify your phone | {{shop}}',
    sent: 'We sent a 6-digit code to {{phone}}',
    code: '6-digit code',
    triesLeft_one: '{{count}} try left.',
    triesLeft_other: '{{count}} tries left.',
    resend: 'Resend code',
    resendIn: 'in {{time}}',
    resent: 'A new code is on its way.',
    checking: 'Checking the code…',
    // No answer from the server: the code may not have reached it
    failed: 'The code was not sent. Check the connection, then try again.',
    // Only in the mock shop, which sends no SMS
    mockCode: 'Test shop: no SMS is sent. The code is {{code}}.',
    startAgain: 'Back to checkout',
  },
  // Step 26c: the dialog after the order (Figma confirmation_status)
  confirmed: {
    title: 'Order Confirmed',
    // The phone sits between two parts, in weight 500
    textBefore: 'We have received your order. We’ll send updates by SMS to ',
    textAfter: '.',
    close: 'Close',
    details: 'View Order Details',
    continueShopping: 'Continue shopping',
  },
  // Step 26c: /order/<no>
  order: {
    title: 'Order Details',
    // The browser tab: the number, then the shop
    pageTitle: 'Order {{orderNo}} | {{shop}}',
    placedOn: 'Placed on {{date}}',
    timeline: 'Order status',
    statuses: {
      pending: 'Order placed',
      confirmed: 'Confirmed',
      packed: 'Packed',
      shipped: 'On the way',
      delivered: 'Delivered',
      cancelled: 'Cancelled',
      returned: 'Returned',
    },
    delivery: 'Delivery details',
    payment: 'Payment',
    items: 'Items',
    lineQuantity: '{{quantity}} × {{price}}',
    subtotal: 'Subtotal',
    // The Delivery Charge row of an order that went out for free
    free: 'Free',
  },
  // Step 26d: the category and search pages (/c/<slug>, /search)
  listing: {
    pageTitle: '{{title}} | {{shop}}',
    all: 'All Products',
    searchTitle: 'Results for “{{q}}”',
    // The first item of a category chip's menu: the category itself, with what is under it
    allOf: 'All of {{category}}',
    // A chip that is a switch (Offer, In stock) says its state to a screen reader
    on: '{{filter}}, on',
    filter: {
      title: 'Filter the products',
      price: 'Price',
      from: 'From',
      to: 'To',
      inStock: 'In stock only',
      apply: 'Apply',
      clear: 'Clear',
    },
    sort: {
      title: 'Sort the products',
      newest: 'Newest',
      price_asc: 'Price: low to high',
      price_desc: 'Price: high to low',
      name: 'Name: A to Z',
    },
    loading: 'Loading',
    // Said by the live region when Load More has added the cards
    loaded_one: '{{count}} more product',
    loaded_other: '{{count}} more products',
    noResultsTitle: 'Nothing matches “{{q}}”',
    noResultsText: 'Check the spelling, or try a shorter word, like “neem”.',
    noMatchTitle: 'No products match these filters',
    noMatchText: 'Clear the filters to see every product here.',
    clearFilters: 'Clear filters',
    emptyTitle: 'No products here yet',
    emptyText: 'New products come soon. Until then, look in another category.',
    seeAll: 'See all products',
  },
  // Step 26d: the category drawer, opened by the header's menu button
  drawer: {
    title: 'Categories',
    close: 'Close categories',
    all: 'All Products',
    // A top category's button that shows or hides the ones under it
    toggle: 'Show the categories in {{category}}',
  },
  footer: {
    pages: 'Shop pages',
    social: '{{shop}} on social media',
    privacy: 'Privacy Policy',
    terms: 'Terms & Condition',
    about: 'About Us',
    contact: 'Contact Us',
    copyright: '©{{year}} All rights reserved by {{shop}}',
    facebook: 'Facebook',
    instagram: 'Instagram',
    x: 'X',
    linkedin: 'LinkedIn',
  },
};
```

`shopEn` has no type of its own: like `en`, it is the source the other language's type comes from. The keys inside
did not change, so every `t('shop.…')` call in the shop stays as it is.

The new groups, from `listing:` on:

- `pageTitle` puts the shop's name after the page's own title, like the product page's `title`.
- `searchTitle` is `CLAUDE.md`'s `Results for "neem"`, with typographic quotes like the cart's words.
- `allOf` is the first item of a chip's menu. Without it, a shopper who opened "Cosmetics" could reach every
  sub-category but not Cosmetics itself.
- `on` is for a chip that is a switch (Offer). A link has no "pressed" state for a screen reader, so the words say it:
  "Offer, on".
- `sort` has a key per `SHOP_SORTS` value, so the page can write `t(\`shop.listing.sort.${sort}\`)` and a new sort
  without words fails the type check.
- `loaded_one` / `loaded_other` are what the live region says after Load More: a screen reader user does not see the
  new cards appear.
- Three empty states, because they need different advice: no search results (try another word), nothing left after
  the filters (clear them), and a category with no products yet (look elsewhere).
- `drawer.toggle` is the label of a top category's show/hide button in the drawer: its visible text is only an icon.

```ts
import type { ShopMessages } from './messages.js';

// ShopMessages: a key missing here, or one en.ts does not have, is a compile error, as for bn.ts
export const shopBn: ShopMessages = {
  skipToContent: 'মূল অংশে যান',
  header: {
    home: '{{shop}} হোম',
    search: 'খুঁজুন',
    searchLabel: 'দোকানে খুঁজুন',
    searchPlaceholder: 'কসমেটিকস, খাবার খুঁজুন',
    openSearch: 'খোঁজার বক্স খুলুন',
    closeSearch: 'খোঁজার বক্স বন্ধ করুন',
    categories: 'ক্যাটাগরি',
    cart_one: 'কার্ট, {{count}}টি পণ্য',
    cart_other: 'কার্ট, {{count}}টি পণ্য',
    cartEmpty: 'কার্ট, খালি',
    added: 'কার্টে যোগ হয়েছে',
    account: 'অ্যাকাউন্ট',
  },
  home: {
    title: '{{shop}}: অনলাইনে কিনুন',
    allCategory: 'সব ক্যাটাগরি',
    allCategories: 'সব ক্যাটাগরি',
    categoryFilters: 'পণ্য বাছাই করুন',
    all: 'সব',
    offer: 'অফার',
    allFilter: 'সব ফিল্টার',
    sortBy: 'সাজান',
    featured: 'বাছাই করা পণ্য',
    viewAll: 'সব দেখুন',
    loadMore: 'আরও দেখুন',
    previous: 'আগের পণ্য',
    next: 'পরের পণ্য',
  },
  card: {
    addToCart: 'কার্টে যোগ করুন',
    addToCartLabel: '{{name}} কার্টে যোগ করুন',
    outOfStock: 'স্টকে নেই',
    off: 'ছাড়',
    discount: '{{amount}} ছাড়',
    badge: {
      most_picked: 'সবচেয়ে জনপ্রিয়',
      new: 'নতুন',
      buy_one_get_one: '১টি কিনলে ১টি ফ্রি',
    },
  },
  product: {
    title: '{{name}} | {{shop}}',
    gallery: '{{name}}-এর ছবি',
    showPhoto: '{{count}}টির মধ্যে {{index}} নম্বর ছবি দেখুন',
    saleEnds: 'অফার শেষ হবে {{date}}',
    size: 'সাইজ',
    wasPrice: 'আগের দাম {{price}}',
    perUnit: 'প্রতি {{unit}}',
    placeOrder: 'অর্ডার করুন',
    inStock: 'স্টকে আছে',
    outOfStock: 'স্টকে নেই',
    sku: 'SKU: {{sku}}',
    hotline: 'হটলাইন:',
    callHotline: '{{phone}} নম্বরে কল করুন',
    details: 'পণ্যের বিবরণ',
    overview: 'বিবরণ',
    related: 'একই রকম পণ্য',
  },
  cart: {
    title: 'আপনার কার্ট',
    close: 'কার্ট বন্ধ করুন',
    loading: 'আজকের দাম আনা হচ্ছে…',
    failed: 'দাম আনা যায়নি। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।',
    retry: 'আবার চেষ্টা করুন',
    decrease: '{{name}} একটি কমান',
    increase: '{{name}} একটি বাড়ান',
    quantity: '{{name}} কয়টি',
    remove: '{{name}} সরান',
    outOfStock: 'স্টকে নেই: সাবটোটালে ধরা হয়নি',
    removed_one: '{{count}}টি পণ্য আর বিক্রি হয় না, তাই কার্ট থেকে সরানো হয়েছে।',
    removed_other: '{{count}}টি পণ্য আর বিক্রি হয় না, তাই কার্ট থেকে সরানো হয়েছে।',
    subtotal: 'সাবটোটাল',
    checkout: 'চেকআউট',
    emptyTitle: 'আপনার কার্ট খালি',
    emptyText: '"কার্টে যোগ করুন" চাপলে পণ্য এখানে অপেক্ষা করবে।',
    continueShopping: 'কেনাকাটা চালিয়ে যান',
  },
  checkout: {
    title: 'চেকআউট',
    pageTitle: 'চেকআউট | {{shop}}',
    heading: 'ডেলিভারি ও যোগাযোগের তথ্য',
    name: 'পুরো নাম',
    phone: 'মোবাইল নম্বর',
    address: 'ডেলিভারির ঠিকানা',
    zone: 'ডেলিভারির এলাকা',
    zoneOption: '{{name}} — {{charge}}',
    freeDeliveryFrom: '{{amount}}-এর বেশি অর্ডারে ডেলিভারি ফ্রি',
    items: 'আপনার পণ্য',
    outOfStock: 'স্টকে নেই: অর্ডার করতে এটি সরান',
    priceChanged: 'আগে ছিল {{old}}',
    deliveryCharge: 'ডেলিভারি চার্জ',
    free: 'ফ্রি',
    pickZone: 'এলাকা বেছে নিন',
    discount: 'ছাড় ({{code}})',
    total: 'মোট',
    promo: 'প্রোমো কোড',
    promoPlaceholder: 'প্রোমো কোড লিখুন',
    apply: 'কুপন প্রয়োগ করুন',
    applying: 'প্রয়োগ হচ্ছে…',
    removeCoupon: 'কোডটি সরান',
    couponApplied: '{{code}} প্রয়োগ হয়েছে: {{off}} ছাড়',
    payment: 'পেমেন্টের উপায়',
    cod: 'ক্যাশ অন ডেলিভারি',
    online: 'মোবাইল ব্যাংকিং',
    termsBefore: 'আমি ',
    termsLink: 'শর্তাবলি',
    termsAfter: ' মেনে নিচ্ছি',
    confirm: 'অর্ডার নিশ্চিত করুন',
    placing: 'অর্ডার দেওয়া হচ্ছে…',
    orderFailed: 'অর্ডারটি পাঠানো যায়নি। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।',
    belowMinimum: 'সবচেয়ে ছোট অর্ডার {{minimum}}। অর্ডার করতে আরও {{more}}-এর পণ্য যোগ করুন।',
    emptyTitle: 'আপনার কার্ট খালি',
    emptyText: 'কার্টে পণ্য যোগ করে এখানে ফিরে এসে অর্ডার করুন।',
  },
  verify: {
    title: 'ফোন নম্বর যাচাই করুন',
    pageTitle: 'ফোন নম্বর যাচাই | {{shop}}',
    sent: '{{phone}} নম্বরে ৬ অঙ্কের একটি কোড পাঠিয়েছি',
    code: '৬ অঙ্কের কোড',
    triesLeft_one: 'আর {{count}} বার চেষ্টা করা যাবে।',
    triesLeft_other: 'আর {{count}} বার চেষ্টা করা যাবে।',
    resend: 'আবার কোড পাঠান',
    resendIn: '{{time}} পরে',
    resent: 'নতুন কোড পাঠানো হয়েছে।',
    checking: 'কোড মেলানো হচ্ছে…',
    failed: 'কোডটি পাঠানো যায়নি। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।',
    mockCode: 'টেস্ট শপ: কোনো SMS যায় না। কোড হলো {{code}}।',
    startAgain: 'চেকআউটে ফিরে যান',
  },
  confirmed: {
    title: 'অর্ডার নিশ্চিত হয়েছে',
    textBefore: 'আপনার অর্ডার পেয়েছি। ',
    textAfter: ' নম্বরে SMS-এ অর্ডারের খবর পাঠাব।',
    close: 'বন্ধ করুন',
    details: 'অর্ডারের বিস্তারিত দেখুন',
    continueShopping: 'কেনাকাটা চালিয়ে যান',
  },
  order: {
    title: 'অর্ডারের বিস্তারিত',
    pageTitle: 'অর্ডার {{orderNo}} | {{shop}}',
    placedOn: '{{date}} তারিখে দেওয়া',
    timeline: 'অর্ডারের অবস্থা',
    statuses: {
      pending: 'অর্ডার দেওয়া হয়েছে',
      confirmed: 'নিশ্চিত হয়েছে',
      packed: 'প্যাক হয়েছে',
      shipped: 'পথে আছে',
      delivered: 'ডেলিভারি হয়েছে',
      cancelled: 'বাতিল হয়েছে',
      returned: 'ফেরত এসেছে',
    },
    delivery: 'ডেলিভারির তথ্য',
    payment: 'পেমেন্ট',
    items: 'পণ্য',
    lineQuantity: '{{quantity}} × {{price}}',
    subtotal: 'সাবটোটাল',
    free: 'ফ্রি',
  },
  listing: {
    pageTitle: '{{title}} | {{shop}}',
    all: 'সব পণ্য',
    searchTitle: '“{{q}}”-এর ফলাফল',
    allOf: 'সব {{category}}',
    on: '{{filter}}, চালু',
    filter: {
      title: 'পণ্য বাছাই করুন',
      price: 'দাম',
      from: 'থেকে',
      to: 'পর্যন্ত',
      inStock: 'শুধু স্টকে আছে এমন',
      apply: 'প্রয়োগ করুন',
      clear: 'মুছুন',
    },
    sort: {
      title: 'পণ্য সাজান',
      newest: 'নতুন আগে',
      price_asc: 'দাম: কম থেকে বেশি',
      price_desc: 'দাম: বেশি থেকে কম',
      name: 'নাম অনুযায়ী',
    },
    loading: 'আনা হচ্ছে',
    loaded_one: 'আরও {{count}}টি পণ্য',
    loaded_other: 'আরও {{count}}টি পণ্য',
    noResultsTitle: '“{{q}}”-এর সাথে কিছু মেলেনি',
    noResultsText: 'বানান দেখুন, অথবা ছোট কোনো শব্দ দিয়ে খুঁজুন, যেমন “নিম”।',
    noMatchTitle: 'এই বাছাইয়ে কোনো পণ্য নেই',
    noMatchText: 'এখানের সব পণ্য দেখতে বাছাই মুছে দিন।',
    clearFilters: 'বাছাই মুছুন',
    emptyTitle: 'এখানে এখনো কোনো পণ্য নেই',
    emptyText: 'শিগগিরই নতুন পণ্য আসবে। ততক্ষণ অন্য ক্যাটাগরি দেখুন।',
    seeAll: 'সব পণ্য দেখুন',
  },
  drawer: {
    title: 'ক্যাটাগরি',
    close: 'ক্যাটাগরি বন্ধ করুন',
    all: 'সব পণ্য',
    toggle: '{{category}}-এর ভেতরের ক্যাটাগরি দেখান',
  },
  footer: {
    pages: 'দোকানের পেজ',
    social: 'সোশ্যাল মিডিয়ায় {{shop}}',
    privacy: 'গোপনীয়তা নীতি',
    terms: 'শর্তাবলি',
    about: 'আমাদের সম্পর্কে',
    contact: 'যোগাযোগ',
    copyright: '©{{year}} সর্বস্বত্ব সংরক্ষিত, {{shop}}',
    facebook: 'Facebook',
    instagram: 'Instagram',
    x: 'X',
    linkedin: 'LinkedIn',
  },
};
```

`ShopMessages` makes the compiler check Bangla against English, as `Messages` does for `bn.ts`: a missing or extra key
fails the build. `loaded_one` and `loaded_other` are the same in Bangla, which has no plural, but i18next asks for the
form `Intl.PluralRules` names, so both must be there.

```ts
import type { shopEn } from './en.js';

// The shop's words take their shape from English, like Messages (../messages.ts)
export type ShopMessages = typeof shopEn;
```

### `src/types.ts`

```diff
@@ -1,10 +1,16 @@
-import type { en } from './locales/en.js';
+import type { Messages } from './locales/messages.js';
+
+// The words the typed t() knows. An interface, not `typeof en` itself, so that another entry of
+// this package can add words by declaration merging: '@omnivo/i18n/shop' (shop.ts) adds `shop`.
+// Only a program that imports that entry sees the shop's keys; in the ERP app t('shop.…') stays
+// a compile error, because those words are never loaded there (step 26d)
+export interface Translation extends Messages {}
 
 // t('nav.overview')-এর key এখন টাইপ-চেকড: ভুল key compile error, আর IDE-তে autocomplete।
 // .d.ts না, .ts: tsc src-এর .d.ts ফাইল dist-এ কপি করে না, তখন ui/app এই augmentation দেখত না
 declare module 'i18next' {
   interface CustomTypeOptions {
     defaultNS: 'translation';
-    resources: { translation: typeof en };
+    resources: { translation: Translation };
   }
 }
```

Before, the typed `t()` used `typeof en` directly. A type alias is closed: nothing can add to it later. An
`interface` that `extends` it is open: another file can declare `interface Translation { shop: … }` in the same
module, and TypeScript merges the two. That is how the shop's words become typed keys without being in `en.ts`.

`Translation` has no members of its own, and the repo's ESLint rule `no-empty-object-type` refuses that by default.
The override in `eslint.config.js` (below) allows exactly one `extends` in this one file, so the rule still guards
every other file.

### `src/shop.ts`

```ts
import { i18n, setLanguage, type Language } from './i18n.js';
import { shopEn } from './locales/shop/en.js';
import type { ShopMessages } from './locales/shop/messages.js';

// Step 26d: the public shop's words, out of the ERP app's first load. The ERP imports only the
// main entry ('@omnivo/i18n'); the shop imports this one as well, which adds the `shop` words to
// the same i18next instance and the same `translation` namespace. So the keys stay `shop.*`, and
// errors.*, common words and the formatters work in the shop as before.

// What makes t('shop.cart.title') type-check, in the shop only: a program sees this merge only
// when it imports this file (types.ts explains the interface)
declare module './types.js' {
  interface Translation {
    shop: ShopMessages;
  }
}

// Bangla is a chunk of its own, like the main words (i18n.ts). satisfies: a new language does not
// compile until the shop has its words
const LOADERS = {
  bn: async () => (await import('./locales/shop/bn.js')).shopBn,
} satisfies Record<Exclude<Language, 'en'>, () => Promise<ShopMessages>>;

const added = new Set<Language>();

// deep = true merges `shop` into the language's words instead of replacing them. Once per
// language: a server process answers many pages, and the words never change while it runs
function addShopWords(language: Language, words: ShopMessages): void {
  if (added.has(language)) return;
  i18n.addResourceBundle(language, 'translation', { shop: words }, true, true);
  added.add(language);
}

// English at once: it is the fallback for a Bangla word that is missing, as in the ERP
addShopWords('en', shopEn);

// The shop's replacement for setLanguage(). The order matters: setLanguage() loads a language's
// main words only when that language has none yet (i18n.ts, loadLanguage), so adding the shop's
// Bangla words first would leave the shop without Bangla errors.* and common words.
// remember: false: a shop speaks its own language (PublicShop.language) and never stores a choice
export async function setShopLanguage(language: Language): Promise<void> {
  await setLanguage(language, { remember: false });
  if (language !== 'en') addShopWords(language, await LOADERS[language]());
}

export type { ShopMessages };
```

- `declare module './types.js'` is the merge. It sits in this file, so it reaches a program only through
  `import '@omnivo/i18n/shop'`. The ERP app never imports it, so it never sees the `shop` keys. A `t('shop.…')` that
  slipped into an ERP screen would show the bare key at run time; now it is a compile error.
- `addResourceBundle(language, 'translation', { shop: words }, true, true)`: the fourth argument (`deep`) merges
  `shop` into the words already there. Without it, i18next would replace the whole `translation` bundle of that
  language with `{ shop }`, and every `errors.*` word would be gone. The fifth (`overwrite`) lets the same call run
  again without harm.
- `added` keeps each language to one call. The shop's server answers many pages in one process, and every page
  calls `shopLocale()`.
- English is added when the file is imported, not when English is asked for: it is the fallback for a missing Bangla
  word, so it must be there even on a Bangla shop.
- `setShopLanguage()` calls `setLanguage()` first. `setLanguage()` loads a language's main words only when that
  language has no words yet (`hasResourceBundle`, in `i18n.ts`). If the shop's Bangla words went in first, that check
  would see "Bangla is there" and never load the main Bangla words, and a Bangla shop would show its errors in
  English.
- `LOADERS` keeps Bangla in a chunk of its own, as `i18n.ts` does. `satisfies` makes a third language fail the build
  until the shop has its words.

### `package.json`

```diff
@@ -11,6 +11,10 @@
     "./format": {
       "types": "./dist/format.d.ts",
       "default": "./dist/format.js"
+    },
+    "./shop": {
+      "types": "./dist/shop.d.ts",
+      "default": "./dist/shop.js"
     }
   },
   "scripts": {
```

The entry the shop imports. Like `./format`, it points at `dist/`, so run `pnpm --filter @omnivo/i18n build` before
you type-check the shop.

### `eslint.config.js` (the repo's root)

```diff
@@ -18,4 +18,16 @@ export default [
       ],
     },
   },
+  {
+    // Step 26d: `interface Translation extends Messages {}` is empty on purpose: it is the place
+    // '@omnivo/i18n/shop' adds the shop's words by declaration merging, which a type alias cannot
+    // take. The option allows exactly that shape (one `extends`), in this one file.
+    files: ['packages/i18n/src/types.ts'],
+    rules: {
+      '@typescript-eslint/no-empty-object-type': [
+        'error',
+        { allowInterfaces: 'with-single-extends' },
+      ],
+    },
+  },
 ];
```

Scoped to `packages/i18n/src/types.ts`, like the two overrides above it. `with-single-extends` is the rule's own
option for this case: an empty interface that extends one type is a real, mergeable type, not a mistake.

### `apps/shop/src/lib/locale.ts`

```diff
@@ -1,4 +1,5 @@
-import { i18n, setLanguage, type Language } from '@omnivo/i18n';
+import { i18n, type Language } from '@omnivo/i18n';
+import { setShopLanguage } from '@omnivo/i18n/shop';
 
 import { shopMoney } from './money';
 
@@ -7,9 +8,9 @@ import { shopMoney } from './money';
 // choice in the ERP, so the stored preference is neither read nor written here.
 export async function shopLocale(language: Language) {
   // Loads the language's words (Bangla is a chunk of its own). It also makes it the current
-  // language, which step 26b's React islands render with on the server. remember: false, so the
-  // build never writes a preference
-  await setLanguage(language, { remember: false });
+  // language, which step 26b's React islands render with on the server. Step 26d: the shop's own
+  // words come from '@omnivo/i18n/shop', which also never writes a stored preference
+  await setShopLanguage(language);
   // A t() fixed to this language: the components never depend on which language is current
   const t = i18n.getFixedT(language);
   return {
```

The only place in the shop that loads words. `setShopLanguage()` takes over `setLanguage(language, { remember: false })`:
it does the same, then adds the shop's words. Every page and component gets `t` from here, so nothing else changes.

### `apps/shop/src/boundaries.spec.ts`

```diff
@@ -96,7 +96,8 @@ describe('shop imports', () => {
     // A broken pattern would find nothing to check; cart, quote and money at least
     expect(libs.size).toBeGreaterThanOrEqual(3);
 
-    const heavy = /^(zod|react|react-dom|@omnivo\/contracts|@omnivo\/i18n)$/;
+    // Step 26d: '@omnivo/i18n/shop' as well, which imports the main entry and adds the shop's words
+    const heavy = /^(zod|react|react-dom|@omnivo\/contracts|@omnivo\/i18n(\/shop)?)$/;
     const offenders = [
       ...scripts,
       ...[...libs].map((path) => ({ path, source: files[path] ?? '' })),
@@ -131,7 +132,7 @@ describe('shop imports', () => {
     const offenders = islands
       .filter(([, source]) =>
         importsOf(source, VALUE_IMPORT).some(
-          (name) => name === '@omnivo/i18n' || name.endsWith('/lib/locale'),
+          (name) => /^@omnivo\/i18n(\/shop)?$/.test(name) || name.endsWith('/lib/locale'),
         ),
       )
       .map(([path]) => path);
```

The two rules that keep i18next out of the browser now also name `@omnivo/i18n/shop`. It imports the main entry, so
a browser script that imported it would ship i18next and every English word, exactly what the rules are there to stop.

### `packages/contracts/src/storefront.ts`

```diff
@@ -2,6 +2,7 @@ import { z } from 'zod';
 
 import { errorCode } from './errors.js';
 import { isMoneyAmount } from './money.js';
+import { pageOf } from './pagination.js';
 import { LANGUAGE_CODES } from './preferences.js';
 import { isTimeZone } from './settings.js';
 
@@ -498,3 +499,67 @@ export type ShopCodeResent = z.infer<typeof shopCodeResentSchema>;
 export type ShopOrderStatus = (typeof SHOP_ORDER_STATUSES)[number];
 export type ShopOrderLine = z.infer<typeof shopOrderLineSchema>;
 export type ShopOrder = z.infer<typeof shopOrderSchema>;
+
+// ---------------------------------------------------------------------------------------------
+// Step 26d: the category and search pages (/c/<slug>, /search).
+
+// "Sort By". newest: the most recently published first, the order a shop shows by default. The
+// four a shopper understands without a word of help; "Popular" needs sales numbers the public API
+// does not give
+export const SHOP_SORTS = ['newest', 'price_asc', 'price_desc', 'name'] as const;
+
+// Cards per answer: four rows of the desktop grid's five columns, so Load More always adds whole
+// rows. Not a request field: a shopper cannot ask for 1,000 cards in one page
+export const SHOP_PAGE_SIZE = 20;
+
+// A search word longer than this is never a real search. The header's box has the same maxlength
+export const SHOP_SEARCH_MAX_LENGTH = 100;
+
+// A price filter: whole taka, as a decimal string like every amount. A shopper types "500", never
+// paisa, and an amount over ৳999,999,999 is not a filter
+const shopPriceFilterSchema = z.string().regex(/^(0|[1-9]\d{0,8})$/);
+
+// What the category and search pages ask the source for. The page builds it from the address
+// (apps/shop/src/lib/listing-query.ts), where every value is optional and a broken one is dropped,
+// so this is the clean shape: every field is present, with null for "not set"
+export const shopListingQuerySchema = z
+  .object({
+    // A category's slug: its listings and those of every category under it. null: every listing
+    // (/c/all and /search). The same characters the ERP allows in a slug, so it is safe in a URL
+    category: z
+      .string()
+      .max(100)
+      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
+      .nullable(),
+    // The search words. Trimmed first, so "  " is no search at all and the page sends null
+    q: z.string().trim().min(1).max(SHOP_SEARCH_MAX_LENGTH).nullable(),
+    sort: z.enum(SHOP_SORTS),
+    // On the price the shopper pays (`price`), not the struck-out one
+    minPrice: shopPriceFilterSchema.nullable(),
+    maxPrice: shopPriceFilterSchema.nullable(),
+    inStock: z.boolean(),
+    // Only listings on sale: with a discount ribbon or a struck-out price (the "Offer" chip)
+    offer: z.boolean(),
+    // Where the previous answer stopped (pagination.ts: opaque, only the source reads it). null:
+    // the first page
+    cursor: z.string().min(1).max(512).nullable(),
+  })
+  // Compared as numbers: as strings "90" > "500". The page swaps a pair typed the wrong way round
+  // before it gets here, so this only stops a source call that skipped the page
+  .refine(
+    (query) =>
+      query.minPrice === null ||
+      query.maxPrice === null ||
+      Number(query.minPrice) <= Number(query.maxPrice),
+    { message: errorCode('invalid_value'), path: ['maxPrice'] },
+  );
+
+// One page of cards, the ERP's list shape (pagination.ts): items and the next page's cursor, null
+// on the last page. No total on purpose, as in the ERP: the pages never show a count
+export const shopListingPageSchema = pageOf(shopListingSchema).extend({
+  items: z.array(shopListingSchema).max(SHOP_PAGE_SIZE),
+});
+
+export type ShopSort = (typeof SHOP_SORTS)[number];
+export type ShopListingQuery = z.infer<typeof shopListingQuerySchema>;
+export type ShopListingPage = z.infer<typeof shopListingPageSchema>;
```

- `SHOP_SORTS` is a list, not four booleans, so the URL has one `sort` value and the words have one key each.
- `SHOP_PAGE_SIZE` is 20: the desktop grid has five columns, so every Load More adds four whole rows and never leaves
  a half-empty row in the middle of the grid.
- `shopPriceFilterSchema` refuses `0100` and `1e3` as well as paisa and a minus: they would all pass `Number()`, and
  `0100` and `100` would be two addresses for one page.
- The query has every field, with `null` for "not set". The address is the loose form (every value optional, a bad
  one dropped); the page turns it into this strict one (26d.3). A source then never has to guess what a missing field
  means.
- `category` uses the slug pattern the ERP uses, so a slug from the address (`../admin`, `Skin Care`) cannot reach
  the source.
- `q` is trimmed before `min(1)`, so a search of spaces only is refused. The page sends `null` instead, and the source
  never matches every listing against an empty word.
- The `refine` compares `Number(minPrice)` and `Number(maxPrice)`. Compared as strings, `"90" <= "500"` is false. The
  amounts are whole and at most nine digits, so `Number` is exact here (money elsewhere uses `decimal.js` because of
  paisa).
- `shopListingPageSchema` is the ERP's `pageOf()` shape with a cap on the items, so the shop's lists read like every
  other list, and a source that sent 21 cards would be caught by the test of the real API's answer.

### `packages/contracts/src/storefront.spec.ts`

```diff
@@ -8,6 +8,9 @@ import {
   shopCartQuoteRequestSchema,
   shopCartQuoteSchema,
   shopCheckoutSettingsSchema,
+  SHOP_PAGE_SIZE,
+  shopListingPageSchema,
+  shopListingQuerySchema,
   shopOrderPlacedSchema,
   shopOrderRequestSchema,
   shopOrderSchema,
@@ -408,3 +411,75 @@ describe('order', () => {
     expect(shopOrderSchema.parse(order)).toEqual(order);
   });
 });
+
+// Step 26d
+describe('listing query', () => {
+  // /c/cosmetics?sort=price_asc&min=100&max=500&stock=1, as the page sends it to the source
+  const QUERY = {
+    category: 'cosmetics',
+    q: null,
+    sort: 'price_asc',
+    minPrice: '100',
+    maxPrice: '500',
+    inStock: true,
+    offer: false,
+    cursor: null,
+  };
+
+  it('takes a category page with its filters', () => {
+    expect(shopListingQuerySchema.parse(QUERY)).toEqual(QUERY);
+  });
+
+  it('takes a Bangla search and trims it', () => {
+    const query = shopListingQuerySchema.parse({ ...QUERY, category: null, q: '  নিম ফেস ওয়াশ ' });
+    expect(query.q).toBe('নিম ফেস ওয়াশ');
+  });
+
+  // Spaces only is no search: the page must send null, so the source never matches every listing
+  // against an empty word
+  it('refuses a search of spaces only', () => {
+    expect(shopListingQuerySchema.safeParse({ ...QUERY, q: '   ' }).success).toBe(false);
+  });
+
+  // A slug goes into links and the source's lookup as it is
+  it('refuses a category that is not a slug', () => {
+    for (const category of ['Cosmetics', '../admin', 'skin care', '-tea']) {
+      expect(shopListingQuerySchema.safeParse({ ...QUERY, category }).success).toBe(false);
+    }
+  });
+
+  it('refuses paisa, a minus and a leading zero in a price filter', () => {
+    for (const minPrice of ['99.50', '-1', '0100', '1e3']) {
+      expect(shopListingQuerySchema.safeParse({ ...QUERY, minPrice }).success).toBe(false);
+    }
+  });
+
+  // As strings "90" sorts after "500"; the check must compare the amounts
+  it('compares the prices as numbers', () => {
+    expect(shopListingQuerySchema.safeParse({ ...QUERY, minPrice: '90' }).success).toBe(true);
+    const result = shopListingQuerySchema.safeParse({ ...QUERY, minPrice: '600' });
+    expect(result.success).toBe(false);
+    expect(result.error?.issues[0]).toMatchObject({ path: ['maxPrice'], message: 'invalid_value' });
+  });
+
+  it('refuses a sort the page has no words for', () => {
+    expect(shopListingQuerySchema.safeParse({ ...QUERY, sort: 'popular' }).success).toBe(false);
+  });
+});
+
+describe('listing page', () => {
+  const card = { ...NEEM_PRODUCT };
+
+  it('reads a page of cards and the next cursor', () => {
+    const page = { items: [card], nextCursor: 'eyJvIjoyMH0' };
+    expect(shopListingPageSchema.parse(page)).toMatchObject({ nextCursor: 'eyJvIjoyMH0' });
+  });
+
+  it('refuses more cards than one page holds', () => {
+    const page = {
+      items: Array.from({ length: SHOP_PAGE_SIZE + 1 }, () => card),
+      nextCursor: null,
+    };
+    expect(shopListingPageSchema.safeParse(page).success).toBe(false);
+  });
+});
```

The tests a reader would doubt: Bangla is trimmed and kept; spaces only is no search; a path or a name is not a slug;
`0100` is not a price; `"90"` is less than `"500"`; and a page never holds 21 cards.

### Check this part

```sh
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/i18n typecheck
pnpm --filter @omnivo/contracts typecheck
pnpm --filter @omnivo/contracts test        # 465 tests
pnpm --filter @omnivo/shop typecheck        # astro check: 0 errors
pnpm --filter @omnivo/shop test             # 113 tests
pnpm --filter @omnivo/app build && pnpm --filter @omnivo/app test:bundle-size
                                            # initial JS 231.7 KB gz (was 233.3)
pnpm exec eslint packages/i18n/src packages/contracts/src apps/shop/src eslint.config.js
```

Broken on purpose while this part was written, and caught:

- `t('shop.cart.title')` in a file of `apps/app`: a compile error (`TS2345`), because the ERP never imports
  `@omnivo/i18n/shop`.
- `t('shop.cart.titel')` in the shop: a compile error. The right key in the same file type-checks.
- The price check written as `query.minPrice <= query.maxPrice`: the test "compares the prices as numbers" fails.

Also checked by running it: after `setShopLanguage('bn')`, `shop.header.search` is "খুঁজুন",
`errors.shop_coupon_unknown` is Bangla, and `common.retry` is Bangla. That last one is the order `setShopLanguage()`
keeps.

## 26d.2 — `apps/shop/src/data` and `src/lib`: the shelves, the mock's search and the address

This part gives the shop's data a list it can page through: the source learns `listings(query)`, the mock grows to 62
listings and answers it, and `lib/listing-query.ts` turns an address into a query and a query back into a link. No
page uses them yet (26d.3), so nothing on the screen changes. The tests run the mock the way the pages will.

### `src/data/types.ts`

```diff
@@ -6,6 +6,8 @@ import type {
   ShopCheckoutSettings,
   ShopCodeResent,
   ShopHome,
+  ShopListingPage,
+  ShopListingQuery,
   ShopOrder,
   ShopOrderConfirmed,
   ShopOrderPlaced,
@@ -59,6 +61,11 @@ export interface ShopSource {
   // Step 26b: today's prices for a cart. The route checks the request first
   // (shopCartQuoteRequestSchema), so a source never sees a quantity of 0 or one listing twice
   quote(request: ShopCartQuoteRequest): Promise<ShopCartQuote>;
+  // Step 26d: one page of cards for /c/<slug> and /search. The page builds the query from the
+  // address (lib/listing-query.ts), so a source never sees a broken price or an unknown sort. null:
+  // the cursor is not one this source made (edited by hand, or left from an older source); the page
+  // then starts again from the first page. Not an error, like an unknown slug in product()
+  listings(query: ShopListingQuery): Promise<ShopListingPage | null>;
 
   // Step 26c: the checkout. The routes check every request with its schema first, as for quote()
   checkoutSettings(): Promise<ShopCheckoutSettings>;
```

`listings()` answers a whole page, the contract's `ShopListingPage`, not an array of cards: the page needs to know
whether there is a next page, and only the source knows. The answer is `null` for a cursor this source did not make
(decision 17). That is a normal answer and not a `throw`, because `throw` stays for a source that is down. A category
the shop does not have is not handled here: the page checks the slug against `categories()` first and answers 404,
the same way the product page does with `product()`.

### `src/data/mock/shop.ts`

```diff
@@ -25,4 +25,8 @@ export const mockCategories = [
   { id: 'cat-household', slug: 'household', name: 'Household', parentId: null },
   { id: 'cat-tea', slug: 'tea', name: 'Tea', parentId: 'cat-beverages' },
   { id: 'cat-diabetic', slug: 'diabetic-care', name: 'Diabetic care', parentId: 'cat-food' },
+  // Step 26d: two more under Cosmetics, so /c/cosmetics shows the listings of a category it holds
+  // and the category drawer has a top category with more than one child
+  { id: 'cat-skin-care', slug: 'skin-care', name: 'Skin care', parentId: 'cat-cosmetics' },
+  { id: 'cat-hair-care', slug: 'hair-care', name: 'Hair care', parentId: 'cat-cosmetics' },
 ] satisfies ShopCategory[];
```

Two sub-categories under Cosmetics (decision 21). Their slugs follow the ERP's slug rule, which the query's schema
checks (`skin-care`, never `Skin Care`).

### `src/data/mock/listings.ts`

```diff
@@ -12,6 +12,11 @@ interface MockProduct {
   // undefined: the design's "৳10 OFF" ribbon, which almost every card has; null: no ribbon
   discount?: ShopListing['discount'];
   inStock?: boolean;
+  // Step 26d: the price before the sale, struck through; undefined: no sale
+  compareAtPrice?: string;
+  // Step 26d: the slug whose photo the card shows. The mock has 22 photos for 62 listings, so another
+  // pack size of a product shows that product's photo; undefined: the listing's own slug
+  photo?: string;
 }
 
 // Exported in step 26b: products.ts makes the product page's listing with it, so that listing has
@@ -22,9 +27,9 @@ export function listing(product: MockProduct): ShopListing {
     slug: product.slug,
     name: product.name,
     packSize: product.packSize,
-    images: [{ url: `/mock/products/${product.slug}.png`, alt: product.name }],
+    images: [{ url: `/mock/products/${product.photo ?? product.slug}.png`, alt: product.name }],
     price: product.price,
-    compareAtPrice: null,
+    compareAtPrice: product.compareAtPrice ?? null,
     saleUntil: null,
     discount: product.discount === undefined ? { kind: 'amount', value: '10' } : product.discount,
     badges: product.badges ?? [],
@@ -56,7 +61,7 @@ export const featuredListings: ShopListing[] = [
     name: 'TRESemmé HD Hair Fall Defense Shampoo',
     packSize: '580ml',
     price: '850',
-    categoryId: 'cat-cosmetics',
+    categoryId: 'cat-hair-care',
     badges: PICKED,
   }),
   listing({
@@ -82,21 +87,21 @@ export const himalayaListings: ShopListing[] = [
     name: 'Himalaya Brightening Vitamin-C Orange Face Wash',
     packSize: '100ml',
     price: '159',
-    categoryId: 'cat-cosmetics',
+    categoryId: 'cat-skin-care',
   }),
   listing({
     slug: 'himalaya-anti-dandruff-shampoo-180ml',
     name: 'Himalaya Anti-Dandruff Soothing & Moisturizing Shampoo',
     packSize: '180(±)10ml',
     price: '229',
-    categoryId: 'cat-cosmetics',
+    categoryId: 'cat-hair-care',
   }),
   listing({
     slug: 'himalaya-anti-dandruff-twin-pack',
     name: 'Himalaya Anti-Dandruff Soothing & Moisturizing Shampoo, twin pack',
     packSize: '180(±)10ml',
     price: '270',
-    categoryId: 'cat-cosmetics',
+    categoryId: 'cat-hair-care',
     badges: ['new', 'buy_one_get_one'],
     discount: null,
   }),
@@ -105,14 +110,14 @@ export const himalayaListings: ShopListing[] = [
     name: 'Himalaya Oil Control Lemon Face Wash',
     packSize: '100ml',
     price: '200',
-    categoryId: 'cat-cosmetics',
+    categoryId: 'cat-skin-care',
   }),
   listing({
     slug: 'himalaya-anti-hair-fall-shampoo-180ml',
     name: 'Himalaya Anti Hair Fall Shampoo',
     packSize: '180(±)10ml',
     price: '270',
-    categoryId: 'cat-cosmetics',
+    categoryId: 'cat-hair-care',
   }),
 ];
 
@@ -203,3 +208,360 @@ export const diabeticListings: ShopListing[] = [
     badges: PICKED,
   }),
 ];
+
+// Step 26d: a listing on the shelves only (not on the home page). Most real listings have no sale,
+// so here undefined means no ribbon: with the design's "৳10 OFF" on every card, the Offer chip would
+// leave every card on the page and show nothing
+function shelf(product: MockProduct): ShopListing {
+  return listing({ ...product, discount: product.discount ?? null });
+}
+
+// Step 26d: the rest of the shop, so a category has more than one page (20 cards a page) and every
+// filter has something to drop: other pack sizes of the products above, with their photos. Some
+// have a sale, a percent ribbon, a price with paisa, no stock, or a Bangla name (the search must
+// find "নিম" as well as "neem")
+export const shelfListings: ShopListing[] = [
+  shelf({
+    slug: 'sprite-cold-drink-250ml',
+    name: 'Cold drinks (Sprite)',
+    packSize: '250ml',
+    price: '25',
+    categoryId: 'cat-beverages',
+    photo: 'sprite-cold-drink-500ml',
+  }),
+  shelf({
+    slug: 'sprite-cold-drink-1-25ltr',
+    name: 'Cold drinks (Sprite)',
+    packSize: '1.25ltr',
+    price: '90',
+    categoryId: 'cat-beverages',
+    photo: 'sprite-cold-drink-500ml',
+  }),
+  shelf({
+    slug: 'sprite-cold-drink-2-25ltr',
+    name: 'Cold drinks (Sprite)',
+    packSize: '2.25ltr',
+    price: '150',
+    categoryId: 'cat-beverages',
+    photo: 'sprite-cold-drink-500ml',
+    inStock: false,
+  }),
+  shelf({
+    slug: 'davidoff-rich-aroma-coffee-100gm',
+    name: 'Davidoff Rich Aroma Coffee',
+    packSize: '100gm',
+    price: '1250',
+    categoryId: 'cat-beverages',
+    photo: 'davidoff-espresso-coffee',
+  }),
+  shelf({
+    slug: 'davidoff-fine-aroma-coffee-100gm',
+    name: 'Davidoff Fine Aroma Coffee',
+    packSize: '100gm',
+    price: '1180',
+    categoryId: 'cat-beverages',
+    photo: 'davidoff-espresso-coffee',
+    compareAtPrice: '1350',
+    discount: { kind: 'amount', value: '170' },
+  }),
+  shelf({
+    slug: 'ispahani-mirzapore-bestleaf-100gm',
+    name: 'Ispahani Mirzapore Bestleaf',
+    packSize: '100gm',
+    price: '66',
+    categoryId: 'cat-tea',
+    photo: 'ispahani-mirzapore-bestleaf-200gm',
+  }),
+  shelf({
+    slug: 'ispahani-mirzapore-bestleaf-1kg',
+    name: 'Ispahani Mirzapore Bestleaf',
+    packSize: '1kg',
+    price: '610',
+    categoryId: 'cat-tea',
+    photo: 'ispahani-mirzapore-bestleaf-400gm',
+    discount: { kind: 'percent', value: 5 },
+  }),
+  shelf({
+    slug: 'seylon-family-blend-tea-200gm',
+    name: 'Seylon Family Blend Tea',
+    packSize: '200gm',
+    price: '108',
+    categoryId: 'cat-tea',
+    photo: 'seylon-family-blend-tea-400gm',
+  }),
+  shelf({
+    slug: 'seylon-family-blend-tea-1kg',
+    name: 'Seylon Family Blend Tea',
+    packSize: '1kg',
+    price: '495',
+    categoryId: 'cat-tea',
+    photo: 'seylon-family-blend-tea-400gm',
+  }),
+  shelf({
+    slug: 'seylon-family-blend-tea-bags-100',
+    name: 'Seylon Family Blend Tea Bags',
+    packSize: '100 bags',
+    price: '260',
+    categoryId: 'cat-tea',
+    photo: 'seylon-family-blend-tea-400gm',
+    badges: ['new'],
+  }),
+  shelf({
+    slug: 'aci-pure-turmeric-100gm',
+    name: 'ACI Pure Turmeric (Holud) Powder',
+    packSize: '100gm',
+    price: '70',
+    categoryId: 'cat-food',
+    photo: 'aci-pure-turmeric-200gm',
+  }),
+  shelf({
+    slug: 'aci-pure-turmeric-500gm',
+    name: 'ACI Pure Turmeric (Holud) Powder',
+    packSize: '500gm',
+    price: '300',
+    categoryId: 'cat-food',
+    photo: 'aci-pure-turmeric-200gm',
+  }),
+  shelf({
+    slug: 'aci-pure-turmeric-1kg',
+    name: 'ACI Pure Turmeric (Holud) Powder',
+    packSize: '1kg',
+    price: '580',
+    categoryId: 'cat-food',
+    photo: 'aci-pure-turmeric-200gm',
+    inStock: false,
+  }),
+  shelf({
+    slug: 'aci-pure-holud-gura-50gm',
+    name: 'এসিআই পিওর হলুদ গুঁড়া',
+    packSize: '50gm',
+    price: '38',
+    categoryId: 'cat-food',
+    photo: 'aci-pure-turmeric-200gm',
+  }),
+  shelf({
+    slug: 'pusti-plus-full-cream-milk-500gm',
+    name: 'Pusti Plus Instant Full Cream Milk Powder',
+    packSize: '500gm',
+    price: '490',
+    categoryId: 'cat-food',
+    photo: 'pusti-plus-full-cream-milk-1kg',
+  }),
+  shelf({
+    slug: 'pusti-plus-full-cream-milk-2-5kg',
+    name: 'Pusti Plus Instant Full Cream Milk Powder',
+    packSize: '2.5kg',
+    price: '2350',
+    categoryId: 'cat-food',
+    photo: 'pusti-plus-full-cream-milk-1kg',
+    compareAtPrice: '2450',
+    discount: { kind: 'amount', value: '100' },
+  }),
+  shelf({
+    slug: 'dano-daily-pushti-milk-500gm',
+    name: 'Dano Daily Pushti Milk',
+    packSize: '500gm',
+    price: '400',
+    categoryId: 'cat-food',
+    photo: 'dano-daily-pushti-milk-1kg',
+  }),
+  shelf({
+    slug: 'dano-daily-pushti-milk-2kg',
+    name: 'Dano Daily Pushti Milk',
+    packSize: '2kg',
+    price: '1540',
+    categoryId: 'cat-food',
+    photo: 'dano-daily-pushti-milk-1kg',
+    discount: { kind: 'percent', value: 5 },
+  }),
+  shelf({
+    slug: 'zero-cal-stevia-100-sachets',
+    name: 'Zero Cal Stevia 100 Sachets',
+    packSize: '100 sachets',
+    price: '339.50',
+    categoryId: 'cat-diabetic',
+    photo: 'zero-cal-stevia-30-sachets',
+  }),
+  shelf({
+    slug: 'zero-cal-stevia-200-sachets',
+    name: 'Zero Cal Stevia 200 Sachets',
+    packSize: '200 sachets',
+    price: '620',
+    categoryId: 'cat-diabetic',
+    photo: 'zero-cal-stevia-box',
+  }),
+  shelf({
+    slug: 'sis-low-gi-sugar-700gm',
+    name: 'SIS Low GI Sugar Singapore',
+    packSize: '700gm',
+    price: '1650',
+    categoryId: 'cat-diabetic',
+    photo: 'sis-low-gi-sugar-350gm',
+  }),
+  shelf({
+    slug: 'cyprina-apple-juice-250ml',
+    name: 'Cyprina Apple Juice',
+    packSize: '250ml',
+    price: '160',
+    categoryId: 'cat-diabetic',
+    photo: 'cyprina-apple-juice-1ltr',
+  }),
+  shelf({
+    slug: 'cyprina-mango-orange-apple-juice-250ml',
+    name: 'Cyprina Natural Mango Orange & Apple Juice',
+    packSize: '250ml',
+    price: '180',
+    categoryId: 'cat-diabetic',
+    photo: 'cyprina-mango-orange-apple-juice-1ltr',
+  }),
+  shelf({
+    slug: 'domex-lime-fresh-500ml',
+    name: 'Domex Lime Fresh Toilet Cleaner',
+    packSize: '500ml',
+    price: '75',
+    categoryId: 'cat-household',
+    photo: 'domex-lime-fresh-750ml',
+  }),
+  shelf({
+    slug: 'domex-lime-fresh-1ltr',
+    name: 'Domex Lime Fresh Toilet Cleaner',
+    packSize: '1ltr',
+    price: '128',
+    categoryId: 'cat-household',
+    photo: 'domex-lime-fresh-750ml',
+  }),
+  shelf({
+    slug: 'domex-lime-fresh-twin-pack',
+    name: 'Domex Lime Fresh Toilet Cleaner, twin pack',
+    packSize: '2 × 750ml',
+    price: '185',
+    categoryId: 'cat-household',
+    photo: 'domex-lime-fresh-750ml',
+    badges: ['buy_one_get_one'],
+  }),
+  shelf({
+    slug: 'domex-ocean-fresh-750ml',
+    name: 'Domex Ocean Fresh Toilet Cleaner',
+    packSize: '750ml',
+    price: '98',
+    categoryId: 'cat-household',
+    photo: 'domex-lime-fresh-750ml',
+  }),
+  shelf({
+    slug: 'tresemme-hair-fall-defense-340ml',
+    name: 'TRESemmé HD Hair Fall Defense Shampoo',
+    packSize: '340ml',
+    price: '520',
+    categoryId: 'cat-hair-care',
+    photo: 'tresemme-hair-fall-defense-580ml',
+  }),
+  shelf({
+    slug: 'tresemme-hair-fall-defense-1ltr',
+    name: 'TRESemmé HD Hair Fall Defense Shampoo',
+    packSize: '1ltr',
+    price: '1450',
+    categoryId: 'cat-hair-care',
+    photo: 'tresemme-hair-fall-defense-580ml',
+    compareAtPrice: '1650',
+    discount: { kind: 'amount', value: '200' },
+  }),
+  shelf({
+    slug: 'tresemme-keratin-smooth-shampoo-580ml',
+    name: 'TRESemmé Keratin Smooth Shampoo',
+    packSize: '580ml',
+    price: '850',
+    categoryId: 'cat-hair-care',
+    photo: 'tresemme-hair-fall-defense-580ml',
+  }),
+  shelf({
+    slug: 'himalaya-anti-dandruff-shampoo-80ml',
+    name: 'Himalaya Anti-Dandruff Soothing & Moisturizing Shampoo',
+    packSize: '80ml',
+    price: '110',
+    categoryId: 'cat-hair-care',
+    photo: 'himalaya-anti-dandruff-shampoo-180ml',
+  }),
+  shelf({
+    slug: 'himalaya-anti-dandruff-shampoo-400ml',
+    name: 'Himalaya Anti-Dandruff Soothing & Moisturizing Shampoo',
+    packSize: '400ml',
+    price: '460',
+    categoryId: 'cat-hair-care',
+    photo: 'himalaya-anti-dandruff-shampoo-180ml',
+  }),
+  shelf({
+    slug: 'himalaya-anti-hair-fall-shampoo-80ml',
+    name: 'Himalaya Anti Hair Fall Shampoo',
+    packSize: '80ml',
+    price: '125',
+    categoryId: 'cat-hair-care',
+    photo: 'himalaya-anti-hair-fall-shampoo-180ml',
+  }),
+  shelf({
+    slug: 'himalaya-anti-hair-fall-shampoo-400ml',
+    name: 'Himalaya Anti Hair Fall Shampoo',
+    packSize: '400ml',
+    price: '520',
+    categoryId: 'cat-hair-care',
+    photo: 'himalaya-anti-hair-fall-shampoo-180ml',
+    inStock: false,
+  }),
+  shelf({
+    slug: 'himalaya-vitamin-c-face-wash-50ml',
+    name: 'Himalaya Brightening Vitamin-C Orange Face Wash',
+    packSize: '50ml',
+    price: '85',
+    categoryId: 'cat-skin-care',
+    photo: 'himalaya-vitamin-c-face-wash-100ml',
+  }),
+  shelf({
+    slug: 'himalaya-vitamin-c-face-wash-150ml',
+    name: 'Himalaya Brightening Vitamin-C Orange Face Wash',
+    packSize: '150ml',
+    price: '229',
+    categoryId: 'cat-skin-care',
+    photo: 'himalaya-vitamin-c-face-wash-100ml',
+  }),
+  shelf({
+    slug: 'himalaya-oil-control-lemon-face-wash-50ml',
+    name: 'Himalaya Oil Control Lemon Face Wash',
+    packSize: '50ml',
+    price: '99',
+    categoryId: 'cat-skin-care',
+    photo: 'himalaya-oil-control-lemon-face-wash-100ml',
+  }),
+  shelf({
+    slug: 'himalaya-oil-control-lemon-face-wash-150ml',
+    name: 'Himalaya Oil Control Lemon Face Wash',
+    packSize: '150ml',
+    price: '270',
+    categoryId: 'cat-skin-care',
+    photo: 'himalaya-oil-control-lemon-face-wash-100ml',
+    discount: { kind: 'percent', value: 10 },
+  }),
+  shelf({
+    slug: 'himalaya-purifying-neem-face-wash-50ml',
+    name: 'Himalaya Purifying Neem Face Wash',
+    packSize: '50ml',
+    price: '99',
+    categoryId: 'cat-skin-care',
+    photo: 'himalaya-purifying-neem-face-wash-150ml',
+  }),
+  shelf({
+    slug: 'himalaya-purifying-neem-face-wash-100ml',
+    name: 'Himalaya Purifying Neem Face Wash',
+    packSize: '100ml',
+    price: '175',
+    categoryId: 'cat-skin-care',
+    photo: 'himalaya-purifying-neem-face-wash-150ml',
+  }),
+  shelf({
+    slug: 'himalaya-purifying-neem-face-wash-200ml',
+    name: 'হিমালয়া পিউরিফাইং নিম ফেসওয়াশ',
+    packSize: '200ml',
+    price: '330',
+    categoryId: 'cat-skin-care',
+    photo: 'himalaya-purifying-neem-face-wash-150ml',
+    badges: ['new'],
+  }),
+];
```

- The six Cosmetics listings move to Skin care or Hair care. Cosmetics itself now holds no listing directly, which
  is exactly the case decision 16 is for: without the sub-categories, its page would be empty.
- `compareAtPrice` lets a mock listing have a struck-out price. Until now only the design's product had one, and the
  Offer chip needs listings that are on sale without the ribbon being the only sign.
- `photo` is the slug whose picture a card shows. The mock has 22 photos and 62 listings, so another pack size of a
  product shows that product's photo. A typo here would only be a broken image, which no type check sees, so
  `mock.spec.ts` checks that every picture exists.
- `shelf()` is `listing()` with no ribbon by default. `listing()` gives every card the design's "৳10 OFF", because
  almost every card in Figma has it. On the shelves that would make every card an offer, and the Offer chip would
  filter nothing out.
- The 41 new listings are chosen so every filter and sort has something to show: three more out of stock, prices with
  paisa (`339.50`), percent and amount ribbons, struck-out prices, two prices that are equal (৳99), names that differ
  only in a number (30, 100 and 200 sachets), and two Bangla names, so the search can be tested with Bangla words.

### `src/data/mock/products.ts`

```diff
@@ -5,6 +5,7 @@ import {
   featuredListings,
   himalayaListings,
   listing,
+  shelfListings,
   trendingListings,
 } from './listings';
 
@@ -17,6 +18,7 @@ const SALE_LEFT_MS = (((1 * 24 + 12) * 60 + 10) * 60 + 32) * 1000;
 
 const NEEM_SLUG = 'himalaya-purifying-neem-face-wash-150ml';
 const NEEM_NAME = 'Himalaya Purifying Neem Face Wash';
+const NEEM_SKU = 'MD2346';
 
 const neemListing: ShopListing = {
   ...listing({
@@ -25,7 +27,7 @@ const neemListing: ShopListing = {
     name: `${NEEM_NAME} 150ml`,
     packSize: '150ml',
     price: '229',
-    categoryId: 'cat-cosmetics',
+    categoryId: 'cat-skin-care',
     badges: ['most_picked'],
     // ৳299 − ৳229: the ribbon says what the struck-out price says
     discount: { kind: 'amount', value: '70' },
@@ -104,21 +106,29 @@ const neemProduct: Omit<ShopProduct, 'saleUntil'> = {
     { url: `/mock/products/${NEEM_SLUG}.png`, alt: `${NEEM_NAME} 150ml, front` },
     { url: `/mock/products/${NEEM_SLUG}-2.png`, alt: `${NEEM_NAME}, tube tilted` },
   ],
-  sku: 'MD2346',
+  sku: NEEM_SKU,
   unitName: 'Piece',
   descriptionHtml: NEEM_DESCRIPTION,
 };
 
 // Every listing the mock shop sells: the home page's and the product page's. The quote looks a
-// cart's ids up here, so a listing added to the cart from any page can be priced
+// cart's ids up here, so a listing added to the cart from any page can be priced.
+// Step 26d: and the shelves' (62 in all), newest first: the order is when the shop published them,
+// which "Newest" sorts by. The home page's five come first, so its "All Category" grid is the
+// start of /c/all, where its Load More link goes
 export const mockCatalog: ShopListing[] = [
   ...featuredListings,
   ...himalayaListings,
   ...trendingListings,
   ...diabeticListings,
   neemListing,
+  ...shelfListings,
 ];
 
+// Step 26d: the SKUs the search looks in, by listing id. A card has no SKU (only the product page
+// shows it), so the mock keeps them beside the catalog; only the design's product has one
+export const mockSkus: ReadonlyMap<string, string> = new Map([[neemListing.id, NEEM_SKU]]);
+
 const RELATED_MAX = 12;
 
 // `now` is a parameter so a test can fix the clock. The mock's sale always ends 1 day 12 hours
```

- The design's product moves to Skin care with the other face washes. Its "Related Products" row is the Himalaya
  shelf first and then its category, so the row still starts the same way.
- `mockCatalog` now holds the shelves too, and its order means something: newest first. "Newest" sorts by the moment
  the shop published a listing. The mock has no such date, so the order of this array is that date. The home page's
  five cards come first, so the home page's "All Category" grid is the start of `/c/all`, where its Load More link
  goes, and a shopper who follows it sees the same five cards on top.
- `mockSkus` is beside the catalog, not in it: a card (`ShopListing`) has no SKU in the contract, only the product
  page has one. The real API searches the SKU in the database; the mock keeps the one SKU the design shows.
  `NEEM_SKU` is a constant because the product's own `sku` field has the type `string | null`, and a `Map` of
  `string` cannot take that.

### `src/data/mock/browse.ts`

```ts
import {
  compareMoney,
  SHOP_PAGE_SIZE,
  type ShopCategory,
  type ShopListing,
  type ShopListingPage,
  type ShopListingQuery,
  type ShopSort,
} from '@omnivo/contracts';

// Step 26d: the mock's category and search pages, worked out the way the real API will: filter,
// sort, then cut one page. What the mock reads, in one object like QuoteContext, so a test can give
// it a small catalog of its own
export interface BrowseContext {
  // Newest first (products.ts). "Newest" keeps this order
  catalog: ShopListing[];
  categories: ShopCategory[];
  // SKUs by listing id: a card has no SKU, but the search looks in it
  skus: ReadonlyMap<string, string>;
}

// The mock's cursor is the number of cards already shown, in base64url like the API's cursors. The
// prefix tells the mock's own cursors from anything else: a cursor is opaque (pagination.ts), so a
// page must never learn to read or make one, and an edited one must not land on a random offset
const CURSOR = /^mock:([1-9]\d{0,5})$/;

export function encodeCursor(offset: number): string {
  return btoa(`mock:${String(offset)}`)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// null: not a cursor this mock made (edited by hand, or from an older source)
export function decodeCursor(cursor: string): number | null {
  let text: string;
  try {
    text = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    // atob throws on characters that are not base64 ("%", "!")
    return null;
  }
  const match = CURSOR.exec(text);
  return match?.[1] === undefined ? null : Number(match[1]);
}

// The ids of a category and of every category under it, at any depth (decision 16): /c/cosmetics
// shows the face washes of Skin care too. An unknown slug gives no ids, so no cards; the page answers
// 404 before it asks (26d.3), so this only matters to a caller that skipped that
function categoryIds(slug: string, categories: ShopCategory[]): Set<string> {
  const top = categories.find((category) => category.slug === slug);
  const ids = new Set<string>(top === undefined ? [] : [top.id]);
  // Add children until a round adds none. A loop in the data (A under B under A) stops too, because
  // an id already in the set is never added again
  let grew = ids.size > 0;
  while (grew) {
    grew = false;
    for (const category of categories) {
      if (category.parentId !== null && ids.has(category.parentId) && !ids.has(category.id)) {
        ids.add(category.id);
        grew = true;
      }
    }
  }
  return ids;
}

// One form for the text and the words. NFC: a Bangla letter like য় can be typed as one code point
// or as two (য + ়), and both must match. Lower case for English; Bangla has no case, so it is
// unchanged. 'en' fixes the rules, so a server in Turkey would not turn "I" into "ı"
function fold(text: string): string {
  return text.normalize('NFC').toLocaleLowerCase('en');
}

// Each category's name with the names of every category above it ("Tea", "Beverages"), by id: a
// search for "beverages" finds the teas. Worked out once per call, not once per card. `seen` stops a
// loop in the data (A under B under A)
function categoryTrails(categories: ShopCategory[]): Map<string, string[]> {
  const byId = new Map(categories.map((category) => [category.id, category]));
  return new Map(
    categories.map((category) => {
      const names: string[] = [];
      const seen = new Set<string>();
      let current: ShopCategory | undefined = category;
      while (current !== undefined && !seen.has(current.id)) {
        seen.add(current.id);
        names.push(current.name);
        current = current.parentId === null ? undefined : byId.get(current.parentId);
      }
      return [category.id, names];
    }),
  );
}

// A search's words, folded. Every word must be found, in any field and any order: "face neem"
// finds "Neem Face Wash". null: no search
function searchWords(q: string | null): string[] | null {
  return q === null
    ? null
    : fold(q)
        .split(/\s+/u)
        .filter((word) => word !== '');
}

function matches(
  listing: ShopListing,
  query: ShopListingQuery,
  words: string[] | null,
  trails: Map<string, string[]>,
  skus: ReadonlyMap<string, string>,
): boolean {
  if (query.inStock && !listing.inStock) return false;
  // On sale: a ribbon, or a struck-out price. Either one is what the shopper sees as an offer
  if (query.offer && listing.discount === null && listing.compareAtPrice === null) return false;
  // compareMoney, never Number or a string compare: a price may have paisa ("339.50")
  if (query.minPrice !== null && compareMoney(listing.price, query.minPrice) < 0) return false;
  if (query.maxPrice !== null && compareMoney(listing.price, query.maxPrice) > 0) return false;
  if (words !== null) {
    // The name, the category trail and the SKU, joined with a line break: no word holds one after
    // the split, so a word never matches across two fields
    const text = fold(
      [listing.name, ...(trails.get(listing.categoryId) ?? []), skus.get(listing.id) ?? ''].join(
        '\n',
      ),
    );
    if (!words.every((word) => text.includes(word))) return false;
  }
  return true;
}

// numeric: "Zero Cal Stevia 30 Sachets" comes before "… 100 Sachets"
const NAME_ORDER = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

// A Record, not a switch: a sort added to SHOP_SORTS without an order here fails the type check.
// Equal prices or names keep the newest first: the matches come in catalog order and
// Array.prototype.sort is stable, so 'newest' needs no work at all
const ORDERS: Record<ShopSort, (a: ShopListing, b: ShopListing) => number> = {
  newest: () => 0,
  price_asc: (a, b) => compareMoney(a.price, b.price),
  price_desc: (a, b) => compareMoney(b.price, a.price),
  name: (a, b) => NAME_ORDER.compare(a.name, b.name),
};

// One page of cards. null: the cursor is not one this mock made, so the page sends the shopper to
// the first page (26d.3). A cursor past the end is a real cursor of a list that got shorter: an
// empty last page, not an error
export function listListings(
  query: ShopListingQuery,
  context: BrowseContext,
): ShopListingPage | null {
  const offset = query.cursor === null ? 0 : decodeCursor(query.cursor);
  if (offset === null) return null;

  const ids = query.category === null ? null : categoryIds(query.category, context.categories);
  const words = searchWords(query.q);
  const trails = categoryTrails(context.categories);
  // filter() makes a new array, so sort() never reorders the catalog itself
  const found = context.catalog
    .filter((listing) => ids === null || ids.has(listing.categoryId))
    .filter((listing) => matches(listing, query, words, trails, context.skus))
    .sort(ORDERS[query.sort]);

  const end = offset + SHOP_PAGE_SIZE;
  return {
    items: found.slice(offset, end),
    nextCursor: end < found.length ? encodeCursor(end) : null,
  };
}
```

- The order is filter, sort, then cut one page, as the real API will do it. Cutting first and sorting after would
  sort each page on its own, and the cheapest card could be on page three.
- **The cursor.** It is the number of cards already shown, written as `mock:20` in base64url. Base64url has no `+`,
  `/` or `=`, so it needs no escaping in an address. The `mock:` prefix and the pattern `[1-9]\d{0,5}` make an edited
  cursor `null` instead of a random offset: `0` is never written (the first page has no cursor) and a minus sign
  does not match. `atob` throws on characters that are not base64, so it is in a `try`. `btoa` and `atob` are in
  both Node and the browser, so the shop needs no Node types for this. The template literal uses
  `String(offset)` because the repo's ESLint refuses a number inside a template.
- **A cursor past the end** is an empty last page, not `null`. A real cursor can point past the end when listings
  were unpublished between two clicks; that is not the shopper's fault.
- **`categoryIds`** adds children round by round until a round adds none. It works at any depth, and a loop in the
  data (A under B under A) cannot make it run forever, because an id already in the set is never added again.
- **`fold`** puts text and words in one form. `normalize('NFC')`: a Bangla letter like য় can arrive as one code point
  (U+09DF) or two (য + ়), depending on the keyboard. NFC writes both the same way. (For য় that way is the two code
  points, because Unicode excludes U+09DF from composition; what matters is that both sides get the same form.)
  `toLocaleLowerCase('en')` fixes the rules, so a server set to Turkish would not lower "I" to "ı".
- **`categoryTrails`** is worked out once per call, not once per card. It gives each category its own name and the
  names above it, with the same loop guard.
- **`matches`** joins the fields with a line break. The words were split on white space, so no word holds a line
  break, and a word can never match the end of the name plus the start of the category name.
- **Prices are compared with `compareMoney`**, never as text and never with `Number`. As text, `"1199"` is between
  `"100"` and `"500"`, because it starts with `1`. A test covers exactly that case.
- **`ORDERS` is a `Record<ShopSort, …>`**, not a `switch`, so a sort added to `SHOP_SORTS` without an order here is a
  compile error. "Newest" returns `0` for every pair: the matches are already in catalog order, and
  `Array.prototype.sort` is stable, so it keeps that order. The same stability gives equal prices and equal names the
  newest first (decision 20) with no extra code. `filter()` makes a new array, so `sort()` never reorders
  `mockCatalog` itself.
- **`Intl.Collator('en', { numeric: true })`** sorts names the way people read them: "30 Sachets" before "100
  Sachets". As plain text, "100" comes before "30".

### `src/data/mock/mock-source.ts`

```diff
@@ -1,8 +1,9 @@
 import type { ShopSource } from '../types';
+import { listListings, type BrowseContext } from './browse';
 import { mockCheckoutSettings, mockCoupons } from './checkout';
 import { mockHome } from './home';
 import { createOrderBook, MOCK_CODE } from './orders';
-import { mockCatalog, mockProductPage } from './products';
+import { mockCatalog, mockProductPage, mockSkus } from './products';
 import { quoteCart, type QuoteContext } from './quote';
 import { mockCategories, mockShop } from './shop';
 
@@ -18,6 +19,13 @@ export function mockQuoteContext(now: Date): QuoteContext {
   };
 }
 
+// Step 26d: what the category and search pages read. Exported for the tests, like the quote's
+export const mockBrowseContext: BrowseContext = {
+  catalog: mockCatalog,
+  categories: mockCategories,
+  skus: mockSkus,
+};
+
 // Step 26c: a mock source with its own order book and clock. The shop uses one (mockSource below);
 // a test makes its own, so its orders and its time are its own and no test sees another's orders
 export function createMockSource(now: () => Date = () => new Date()): ShopSource {
@@ -32,6 +40,7 @@ export function createMockSource(now: () => Date = () => new Date()): ShopSource
     home: () => Promise.resolve(mockHome),
     product: (slug) => Promise.resolve(mockProductPage(slug, now())),
     quote: (request) => Promise.resolve(quoteCart(request, context())),
+    listings: (query) => Promise.resolve(listListings(query, mockBrowseContext)),
 
     checkoutSettings: () => Promise.resolve(mockCheckoutSettings),
     // The order is priced again here from its own lines, zone and coupon, never from anything the
```

`mockBrowseContext` is exported for the tests, like `mockQuoteContext`. The browse code takes the catalog as an
argument rather than importing it, so a test could give it a small catalog of its own.

### `src/lib/listing-query.ts`

```ts
import {
  SHOP_SEARCH_MAX_LENGTH,
  SHOP_SORTS,
  type ShopListingQuery,
  type ShopSort,
} from '@omnivo/contracts';

// Step 26d: the category and search pages keep the shopper's choices in the address (decision 2):
// /c/cosmetics?sort=price_asc&min=100&max=500&stock=1&offer=1, and /search?q=neem. This file reads
// that address into the source's query and writes the links that change one choice. Server only:
// the pages call it in their frontmatter, and no browser script imports it (it brings the
// contracts, and with them Zod)

// /c/all: every listing, the page the home page's Load More goes to. Reserved: a category with the
// slug "all" could not have a page of its own
export const ALL_SLUG = 'all';

// The address is typed by people and kept in old links, so it is read leniently: a value that
// makes no sense is dropped (or put right), never an error page. The query that comes out always
// passes shopListingQuerySchema. `category` is the slug from the path, already checked by the page
// against the shop's categories; null for /c/all and /search
export function readListingQuery(
  category: string | null,
  params: URLSearchParams,
): ShopListingQuery {
  let minPrice = readPrice(params.get('min'));
  let maxPrice = readPrice(params.get('max'));
  // "From 500 to 100" means between the two: swapped, not refused (decision 14)
  if (minPrice !== null && maxPrice !== null && Number(minPrice) > Number(maxPrice)) {
    [minPrice, maxPrice] = [maxPrice, minPrice];
  }
  return {
    category,
    q: readSearch(params.get('q')),
    sort: readSort(params.get('sort')),
    minPrice,
    maxPrice,
    // Only "1" switches a filter on, so stock=0 and stock=yes are off and the link builder below
    // has one way to write it
    inStock: params.get('stock') === '1',
    offer: params.get('offer') === '1',
    cursor: readCursor(params.get('cursor')),
  };
}

// An unknown sort ("popular", an old link) is the default, not an error
function readSort(value: string | null): ShopSort {
  return SHOP_SORTS.find((sort) => sort === value) ?? 'newest';
}

// A Bangla keyboard types ০–৯ (the same rule as the cart and the phone code), and a shopper may
// type the grouping they see on the cards ("1,000"). What is left must be whole taka, at most nine
// digits like the schema; then String(Number()) drops leading zeros, so "0500" and "500" are one
// address. "99.50", "-5" and "abc" are dropped: the filter is off, the page still shows
function readPrice(value: string | null): string | null {
  if (value === null) return null;
  const digits = value
    .trim()
    .replace(/[০-৯]/g, (digit) => String(digit.charCodeAt(0) - 0x09e6))
    .replace(/,/g, '');
  return /^\d{1,9}$/.test(digits) ? String(Number(digits)) : null;
}

// Spaces at the ends and runs of spaces inside are one search ("neem  face" is "neem face"), and
// NFC makes a Bangla word typed two ways one address. Too long a search is cut, not dropped: the
// first 100 characters still find what the shopper wanted. Cut by whole characters, so an emoji at
// the edge is never split in half (a broken half cannot be written in a URL)
function readSearch(value: string | null): string | null {
  const text = (value ?? '').normalize('NFC').trim().replace(/\s+/gu, ' ');
  let kept = '';
  for (const character of text) {
    if (kept.length + character.length > SHOP_SEARCH_MAX_LENGTH) break;
    kept += character;
  }
  kept = kept.trim();
  return kept === '' ? null : kept;
}

// The cursor stays opaque here: only its length is checked, like the schema. A cursor the source
// did not make is the source's to find (it answers null, and the page starts again)
function readCursor(value: string | null): string | null {
  return value !== null && value !== '' && value.length <= 512 ? value : null;
}

// The page of a category, of a search, or of everything. A search without a category is /search;
// with one it stays on the category's page (/c/skin-care?q=neem), so a chip keeps the search
export function listingPath(category: string | null, q: string | null): string {
  if (category !== null) return `/c/${category}`;
  return q === null ? `/c/${ALL_SLUG}` : '/search';
}

// A link to the same list with some choices changed (a chip, a sort, a filter). The cursor goes
// unless the change sets it (Load More): the next page of an old sort is not a page of the new one.
// Defaults are left out and the keys always come in one order, so one list has one address, which
// matters for the browser's history and for caches
export function listingHref(
  query: ShopListingQuery,
  change: Partial<ShopListingQuery> = {},
): string {
  const next: ShopListingQuery = { ...query, cursor: null, ...change };
  const params = new URLSearchParams();
  if (next.q !== null) params.set('q', next.q);
  if (next.sort !== 'newest') params.set('sort', next.sort);
  if (next.minPrice !== null) params.set('min', next.minPrice);
  if (next.maxPrice !== null) params.set('max', next.maxPrice);
  if (next.inStock) params.set('stock', '1');
  if (next.offer) params.set('offer', '1');
  if (next.cursor !== null) params.set('cursor', next.cursor);
  const search = params.toString();
  return `${listingPath(next.category, next.q)}${search === '' ? '' : `?${search}`}`;
}
```

The file has two more functions at its end, `listingMoreHref` and `hasPanelFilters`. 26d.3 adds them and explains
them there.

- **It runs only on the server.** It imports values from `@omnivo/contracts` (`SHOP_SORTS`), which would bring Zod
  into the browser. The Load More script (26d.3) follows the link the page wrote, so it never needs this file.
- **`readListingQuery`** never fails. The address is typed by people and kept in old links, so a broken value turns
  that filter off instead of showing an error page (decision 22). What comes out always passes
  `shopListingQuerySchema`; a test feeds it broken addresses to check that.
- **The swap** compares the prices with `Number`. They are at most nine digits here, so `Number` is exact; compared
  as text, `"90"` is more than `"500"` and nothing would be swapped.
- **`readSort`** uses `SHOP_SORTS.find()`, so the answer has the type `ShopSort` with no cast. An unknown sort is the
  default.
- **`readPrice`** converts Bangla digits (the same one line as the cart and the phone code), drops the grouping commas a
  shopper may copy from a card ("1,000"), and then `String(Number())` drops leading zeros, so `0500` and `500` are one
  address. Paisa, a minus and words are dropped: a price filter is whole taka (decision 14).
- **`readSearch`** trims, turns runs of white space into one space and normalizes to NFC, so one search has one
  address. A search longer than 100 characters is cut, not dropped: the first 100 characters still find what the
  shopper wanted. It is cut by whole characters, because `slice()` could cut an emoji in half, and half an emoji
  cannot be written in an address. `length` counts UTF-16 units, the same unit the schema's `max(100)` counts.
- **`readCursor`** checks only the length. The cursor stays opaque to the page; whether it is a real cursor is the
  source's question (decision 17).
- **`listingPath`** keeps a search on a category's page (`/c/skin-care?q=neem`), so clicking a chip on the search page
  narrows the search instead of losing it. A search without a category is `/search`, and no search and no category
  is `/c/all`.
- **`listingHref`** drops the cursor unless the change sets it. The next page of the old sort is not a page of the new
  one. Because of `exactOptionalPropertyTypes`, a caller cannot pass `{ cursor: undefined }` and wipe a field by
  accident. The defaults are left out and the keys always come in one order, so one list has one address; the
  browser's history and any cache then see one page, not six spellings of it.

### `src/lib/listing-query.spec.ts`

```ts
import { shopListingQuerySchema, type ShopListingQuery } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  hasPanelFilters,
  listingHref,
  listingMoreHref,
  listingPath,
  readListingQuery,
} from './listing-query';

function read(search: string, category: string | null = 'cosmetics'): ShopListingQuery {
  return readListingQuery(category, new URLSearchParams(search));
}

const PLAIN: ShopListingQuery = {
  category: 'cosmetics',
  q: null,
  sort: 'newest',
  minPrice: null,
  maxPrice: null,
  inStock: false,
  offer: false,
  cursor: null,
};

describe('readListingQuery', () => {
  it('reads a bare address as the defaults', () => {
    expect(read('')).toEqual(PLAIN);
  });

  it('reads every choice', () => {
    expect(read('q=neem&sort=price_asc&min=100&max=500&stock=1&offer=1&cursor=abc')).toEqual({
      category: 'cosmetics',
      q: 'neem',
      sort: 'price_asc',
      minPrice: '100',
      maxPrice: '500',
      inStock: true,
      offer: true,
      cursor: 'abc',
    });
  });

  it('drops what makes no sense instead of failing', () => {
    // An old link or a hand-edited address still shows the page, with that filter off
    expect(read('sort=popular&min=99.50&max=-5&stock=yes&offer=0&cursor=')).toEqual(PLAIN);
    expect(read('min=1234567890').minPrice).toBeNull();
  });

  it('takes Bangla digits, grouping and leading zeros', () => {
    const query = read('min=৫০০&max=1,000');
    expect(query.minPrice).toBe('500');
    expect(query.maxPrice).toBe('1000');
    expect(read('min=0500').minPrice).toBe('500');
    expect(read('min=0').minPrice).toBe('0');
  });

  it('swaps a price range typed the wrong way round', () => {
    // As numbers: as strings, "90" > "500" and nothing would be swapped
    const query = read('min=500&max=90');
    expect([query.minPrice, query.maxPrice]).toEqual(['90', '500']);
  });

  it('tidies the search words', () => {
    expect(read('q=%20%20neem%20%20%20face%20').q).toBe('neem face');
    expect(read('q=%20%20%20').q).toBeNull();
    // য় can come as one code point (U+09DF) or as two (য + ়), depending on the keyboard. Both
    // are one search, so one address
    const oneCodePoint = read(`q=${encodeURIComponent('ফেসওয়াশ')}`).q;
    const twoCodePoints = read(`q=${encodeURIComponent('ফেসওয়াশ')}`).q;
    expect(oneCodePoint).toBe(twoCodePoints);
  });

  it('cuts a long search at whole characters', () => {
    expect(read(`q=${'a'.repeat(150)}`).q).toHaveLength(100);
    // 99 letters and an emoji (two UTF-16 units) do not fit in 100: the emoji goes, not half of it
    const cut = read(`q=${'a'.repeat(99)}${encodeURIComponent('🧴')}`).q;
    expect(cut).toBe('a'.repeat(99));
  });

  it('always gives a query the contract accepts', () => {
    const addresses = [
      '',
      'q=neem&sort=name&min=500&max=90&stock=1&offer=1',
      `q=${'অ'.repeat(300)}&min=৯৯৯৯৯৯৯৯৯&cursor=${'x'.repeat(600)}`,
      'min=abc&max=&sort=&q=',
    ];
    for (const address of addresses) {
      expect(() => shopListingQuerySchema.parse(read(address))).not.toThrow();
      expect(() => shopListingQuerySchema.parse(read(address, null))).not.toThrow();
    }
  });
});

describe('listingPath', () => {
  it('names the page of a category, a search, or everything', () => {
    expect(listingPath('tea', null)).toBe('/c/tea');
    expect(listingPath('tea', 'bestleaf')).toBe('/c/tea');
    expect(listingPath(null, 'bestleaf')).toBe('/search');
    expect(listingPath(null, null)).toBe('/c/all');
  });
});

describe('listingHref', () => {
  it('leaves the defaults out', () => {
    expect(listingHref(PLAIN)).toBe('/c/cosmetics');
  });

  it('writes the keys in one order, whatever the address had', () => {
    const query = read('offer=1&max=500&sort=name&q=neem&stock=1&min=100');
    expect(listingHref(query)).toBe(
      '/c/cosmetics?q=neem&sort=name&min=100&max=500&stock=1&offer=1',
    );
  });

  it('drops the cursor when a choice changes, and keeps the search', () => {
    const query = read('q=neem&cursor=abc');
    expect(listingHref(query, { sort: 'price_desc' })).toBe('/c/cosmetics?q=neem&sort=price_desc');
    expect(listingHref(query, { category: 'skin-care' })).toBe('/c/skin-care?q=neem');
    expect(listingHref(query, { category: null })).toBe('/search?q=neem');
  });

  it('sets the cursor for Load More', () => {
    expect(listingHref(read('offer=1'), { cursor: 'bW9jazoyMA' })).toBe(
      '/c/cosmetics?offer=1&cursor=bW9jazoyMA',
    );
  });

  it('writes what it reads back the same', () => {
    // One list, one address: reading a link gives the query that made it
    const query = read('q=হলুদ গুঁড়া&sort=price_asc&min=10&stock=1');
    const href = listingHref(query);
    const url = new URL(href, 'https://shop.example');
    expect(readListingQuery('cosmetics', url.searchParams)).toEqual(query);
  });
});
```

The import list already names `listingMoreHref` and `hasPanelFilters`; their tests are at the end of the file and come
in 26d.3. Leave those two names out of the import until then, or the lint fails on an unused import.

The last test reads a link back: the query a link was made from is the query the link gives. That is the promise the
pages rely on when every chip, filter and sort writes its own link. The emoji test uses 99 letters and one emoji: the
emoji is two UTF-16 units, so it does not fit in 100 and must go whole.

### `src/data/mock/browse.spec.ts`

```ts
import {
  compareMoney,
  SHOP_PAGE_SIZE,
  shopListingPageSchema,
  type ShopListing,
  type ShopListingPage,
  type ShopListingQuery,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor, listListings } from './browse';
import { mockHome } from './home';
import { mockBrowseContext } from './mock-source';
import { mockCatalog } from './products';

const ALL: ShopListingQuery = {
  category: null,
  q: null,
  sort: 'newest',
  minPrice: null,
  maxPrice: null,
  inStock: false,
  offer: false,
  cursor: null,
};

function page(change: Partial<ShopListingQuery> = {}): ShopListingPage {
  const answer = listListings({ ...ALL, ...change }, mockBrowseContext);
  if (answer === null) throw new Error('the mock refused its own query');
  return answer;
}

// Every card of a list, page after page, as Load More would get them
function everything(change: Partial<ShopListingQuery> = {}): ShopListing[] {
  const cards: ShopListing[] = [];
  let cursor: string | null = null;
  do {
    const next = page({ ...change, cursor });
    expect(() => shopListingPageSchema.parse(next)).not.toThrow();
    cards.push(...next.items);
    cursor = next.nextCursor;
  } while (cursor !== null);
  return cards;
}

function slugs(listings: ShopListing[]): string[] {
  return listings.map((listing) => listing.slug);
}

describe('the mock shelves', () => {
  it('pages through every listing once, 20 at a time, newest first', () => {
    const first = page();
    expect(first.items).toHaveLength(SHOP_PAGE_SIZE);
    expect(first.nextCursor).not.toBeNull();
    // 62 listings: more than three pages, so Load More is on the page twice and then goes
    expect(everything()).toEqual(mockCatalog);
  });

  it('starts /c/all with the home page’s grid', () => {
    // The home page's Load More goes to /c/all: the shopper sees the same five cards first
    expect(page().items.slice(0, mockHome.featured.length)).toEqual(mockHome.featured);
    expect(mockHome.hasMoreFeatured).toBe(mockCatalog.length > mockHome.featured.length);
  });

  it('shows a category with every category under it', () => {
    const cosmetics = everything({ category: 'cosmetics' });
    const categories = new Set(cosmetics.map((listing) => listing.categoryId));
    expect(categories).toEqual(new Set(['cat-skin-care', 'cat-hair-care']));
    expect(slugs(everything({ category: 'beverages' }))).toContain('seylon-family-blend-tea-1kg');
    expect(everything({ category: 'tea' }).every((l) => l.categoryId === 'cat-tea')).toBe(true);
  });

  it('shows nothing for a slug no category has', () => {
    expect(page({ category: 'no-such-category' })).toEqual({ items: [], nextCursor: null });
  });
});

describe('the mock search', () => {
  it('finds a word in any case, in the name, the category or the SKU', () => {
    expect(slugs(everything({ q: 'NEEM' }))).toEqual([
      'himalaya-purifying-neem-face-wash-150ml',
      'himalaya-purifying-neem-face-wash-50ml',
      'himalaya-purifying-neem-face-wash-100ml',
    ]);
    // A category above the listing's own: the teas are beverages
    expect(slugs(everything({ q: 'beverages' }))).toContain('ispahani-mirzapore-bestleaf-400gm');
    expect(slugs(everything({ q: 'md2346' }))).toEqual(['himalaya-purifying-neem-face-wash-150ml']);
  });

  it('needs every word, in any order', () => {
    expect(everything({ q: 'wash neem' })).toHaveLength(3);
    expect(everything({ q: 'neem shampoo' })).toEqual([]);
  });

  it('finds Bangla, however য় was typed', () => {
    expect(slugs(everything({ q: 'নিম' }))).toEqual(['himalaya-purifying-neem-face-wash-200ml']);
    const found = slugs(everything({ q: 'ফেসওয়াশ' }));
    expect(slugs(everything({ q: 'ফেসওয়াশ' }))).toEqual(found);
    expect(found).toEqual(['himalaya-purifying-neem-face-wash-200ml']);
  });
});

describe('the mock filters', () => {
  it('leaves out what is not in stock', () => {
    const cards = everything({ inStock: true });
    expect(cards.every((listing) => listing.inStock)).toBe(true);
    expect(cards.length).toBeLessThan(mockCatalog.length);
  });

  it('keeps only offers: a ribbon or a struck-out price', () => {
    const cards = everything({ offer: true, category: 'hair-care' });
    expect(cards.every((l) => l.discount !== null || l.compareAtPrice !== null)).toBe(true);
    expect(slugs(cards)).toContain('tresemme-hair-fall-defense-1ltr');
    expect(slugs(cards)).not.toContain('tresemme-keratin-smooth-shampoo-580ml');
  });

  it('filters on the price paid, paisa and all', () => {
    // ৳339.50 is over ৳339 and under ৳340
    expect(slugs(everything({ minPrice: '339', maxPrice: '340' }))).toEqual([
      'zero-cal-stevia-100-sachets',
    ]);
    expect(everything({ minPrice: '340', maxPrice: '340' })).toEqual([]);
    // As numbers: as text, "1199" is between "100" and "500" (it starts with "1")
    const cards = everything({ minPrice: '100', maxPrice: '500' });
    expect(slugs(cards)).not.toContain('davidoff-espresso-coffee');
    expect(cards).toEqual(
      mockCatalog.filter(
        (l) => compareMoney(l.price, '100') >= 0 && compareMoney(l.price, '500') <= 0,
      ),
    );
    // Both ends count: ৳50 is between ৳50 and ৳50
    expect(slugs(everything({ minPrice: '50', maxPrice: '50' }))).toEqual([
      'sprite-cold-drink-500ml',
    ]);
  });
});

describe('the mock sorts', () => {
  it('sorts by price, the newest first among equal prices', () => {
    const up = everything({ sort: 'price_asc' });
    for (let i = 1; i < up.length; i += 1) {
      const [before, after] = [up[i - 1], up[i]];
      if (before === undefined || after === undefined) throw new Error('a hole in the list');
      expect(compareMoney(before.price, after.price)).toBeLessThanOrEqual(0);
    }
    // ৳99 twice: the Lemon 50ml is newer in the catalog than the Neem 50ml
    const at99 = slugs(up.filter((listing) => listing.price === '99'));
    expect(at99).toEqual(slugs(mockCatalog.filter((listing) => listing.price === '99')));
    expect(slugs(everything({ sort: 'price_desc' }))[0]).toBe('pusti-plus-full-cream-milk-2-5kg');
  });

  it('sorts names as people read them', () => {
    const names = everything({ sort: 'name', q: 'stevia' }).map((listing) => listing.name);
    // 30 before 100 before 200 (as text, "100" < "200" < "30")
    expect(names).toEqual([
      'Zero Cal Stevia 30 Sachets',
      'Zero Cal Stevia 30 Sachets, gift box',
      'Zero Cal Stevia 100 Sachets',
      'Zero Cal Stevia 200 Sachets',
    ]);
  });
});

describe('the mock cursor', () => {
  it('reads back what it wrote, and nothing else', () => {
    expect(decodeCursor(encodeCursor(20))).toBe(20);
    // base64url: no "+", "/" or "=" to escape in an address
    expect(encodeCursor(40)).toMatch(/^[\w-]+$/);
    for (const broken of ['abc', '%%%', btoa('mock:0'), btoa('mock:-20'), btoa('other:20')]) {
      expect(decodeCursor(broken)).toBeNull();
    }
  });

  it('answers null for a cursor it did not make, and an empty page past the end', () => {
    expect(listListings({ ...ALL, cursor: 'not-ours' }, mockBrowseContext)).toBeNull();
    expect(page({ cursor: encodeCursor(1000) })).toEqual({ items: [], nextCursor: null });
  });
});
```

- `everything()` follows the cursors the way Load More will, and checks every page against `shopListingPageSchema`.
  Walking the whole catalog proves three things at once: no card is shown twice, none is skipped, and the last page
  says there is no next one.
- The search tests list the exact slugs, not only a count, so a search that found the right number of wrong cards
  would fail.
- The price test with ৳100 to ৳500 is the one a text comparison passes in every other test.

### `src/data/mock/mock.spec.ts`

```diff
@@ -21,19 +21,39 @@ describe('the mock shop', () => {
   });
 
   it('gives every listing a unique id and slug', () => {
-    const listings = [
+    // Step 26d: the whole catalog, not only the home page: the shelves' listings are pages too
+    expect(new Set(mockCatalog.map((listing) => listing.id)).size).toBe(mockCatalog.length);
+    expect(new Set(mockCatalog.map((listing) => listing.slug)).size).toBe(mockCatalog.length);
+  });
+
+  it('puts every listing in a known category', () => {
+    const ids = new Set(mockCategories.map((category) => category.id));
+    for (const listing of mockCatalog) expect(ids.has(listing.categoryId)).toBe(true);
+  });
+
+  it('sells only what the catalog holds on the home page', () => {
+    // The quote prices a cart from the catalog: a card that is not in it could not be bought
+    const ids = new Set(mockCatalog.map((listing) => listing.id));
+    const onHome = [
       ...mockHome.featured,
       ...mockHome.blocks.flatMap((block) =>
         block.kind === 'collection' ? block.collection.listings : [],
       ),
     ];
-    expect(new Set(listings.map((listing) => listing.id)).size).toBe(listings.length);
-    expect(new Set(listings.map((listing) => listing.slug)).size).toBe(listings.length);
+    for (const listing of onHome) expect(ids.has(listing.id)).toBe(true);
   });
 
-  it('puts every listing in a known category', () => {
-    const ids = new Set(mockCategories.map((category) => category.id));
-    for (const listing of mockHome.featured) expect(ids.has(listing.categoryId)).toBe(true);
+  it('has a photo for every listing', () => {
+    // Step 26d: a shelf listing shows another pack size's photo (`photo` in listings.ts); a typo
+    // there would be a broken image on the card, which no type check sees
+    const photos = new Set(
+      Object.keys(import.meta.glob('../../../public/mock/products/*.png')).map((path) =>
+        path.replace('../../../public', ''),
+      ),
+    );
+    for (const listing of mockCatalog) {
+      for (const image of listing.images) expect(photos).toContain(image.url);
+    }
   });
 });
 
```

The id, slug and category checks now cover the whole catalog, not only the home page: every shelf listing is a
product page and a cart line too. The photo check uses `import.meta.glob` to list the files in
`public/mock/products/`, so a wrong `photo` in `listings.ts` fails here instead of showing a broken image.

### Check this part

```sh
pnpm --filter @omnivo/contracts build       # the shop reads the contracts from dist/
pnpm --filter @omnivo/shop typecheck        # astro check: 0 errors
pnpm --filter @omnivo/shop test             # 143 tests
pnpm exec eslint apps/shop/src
pnpm exec prettier --check apps/shop/src
```

Broken on purpose while this part was written, and caught:

- `categoryIds` with the children left out: "shows a category with every category under it" fails.
- The prices compared as text (`listing.price < query.minPrice`): "filters on the price paid" fails. Before the ৳100
  to ৳500 case was added, this break passed every test; that is why the case is there.
- `fold` without `normalize('NFC')`: "finds Bangla, however য় was typed" fails.
- `listingHref` keeping the cursor on a change: "drops the cursor when a choice changes" fails.
- The swap written as a text comparison (`minPrice > maxPrice`): three tests fail, the swap test, the contract test
  and the Bangla digits test (৳500 to ৳1,000 is swapped, because as text `"500"` is more than `"1000"`).

## 26d.3 — `apps/shop/src`: the category and search pages

This part draws the pages. `/c/<slug>`, `/c/all` and `/search` read the address with 26d.2's `readListingQuery`, ask
the source for one page of cards, and draw the home page's "All Category" block with a working filter row. Load More
adds the next cards in place. The work is in four layers:

- **`lib/`**: one loader the four routes share (`loadListing`), and two small helpers for the links.
- **Components**: the empty state, the grid with its Load More, the filter row with its menus, and the block that holds
  them (`ListingView`).
- **Pages**: two full pages and two partials, which are pieces of HTML that Load More's script asks for.
- **The frame**: the header's search box shows the search on screen, and `shop.css` places the menus.

### `src/lib/listing-query.ts` (the end of the file)

```ts
// Step 26d.3: where Load More's script asks for the next cards: the partial next to the page
// (/c/cosmetics/more, /search/more) with the same address. The page writes both links, so the
// script needs no URL rules of its own and never imports this file
export function listingMoreHref(query: ShopListingQuery, cursor: string): string {
  const href = listingHref(query, { cursor });
  const [path = '', search = ''] = href.split('?');
  return `${path}/more?${search}`;
}

// Step 26d.3: whether a filter of "All Filter" is on, for the chip's look and the empty state's
// "Clear filters". Offer is not one: it has its own chip
export function hasPanelFilters(query: ShopListingQuery): boolean {
  return query.minPrice !== null || query.maxPrice !== null || query.inStock;
}
```

- **`listingMoreHref`** is the partial's address: the page's own link with `/more` after the path
  (`/c/cosmetics/more?sort=name&cursor=…`). The page writes this link into the Load More button, so the browser script
  never builds a URL. It would need this file for that, and this file brings the contracts (and with them Zod) into the
  browser.
- `href.split('?')` always has a search part here, because `cursor` is set. The `= ''` defaults are there for the type
  checker: with `noUncheckedIndexedAccess`, an array item may be `undefined`.
- **`hasPanelFilters`** is the one rule for "is a filter of the panel on". The chip's look, its screen reader label and
  the empty state all ask it, so they can never disagree. Offer is left out on purpose: it has a chip of its own.

### `src/lib/listing-query.spec.ts` (the end of the file)

```ts

describe('listingMoreHref', () => {
  it('asks the partial next to the page, with the same address', () => {
    expect(listingMoreHref(read('sort=name'), 'bW9jazoyMA')).toBe(
      '/c/cosmetics/more?sort=name&cursor=bW9jazoyMA',
    );
    expect(listingMoreHref(read('q=neem', null), 'bW9jazoyMA')).toBe(
      '/search/more?q=neem&cursor=bW9jazoyMA',
    );
    expect(listingMoreHref(read('', null), 'bW9jazoyMA')).toBe('/c/all/more?cursor=bW9jazoyMA');
  });
});

describe('hasPanelFilters', () => {
  it('counts the price and the stock, not the sort or the offer', () => {
    expect(hasPanelFilters(read('sort=name&offer=1&q=neem'))).toBe(false);
    expect(hasPanelFilters(read('min=0'))).toBe(true);
    expect(hasPanelFilters(read('max=500'))).toBe(true);
    expect(hasPanelFilters(read('stock=1'))).toBe(true);
  });
});
```

Add `hasPanelFilters` and `listingMoreHref` to the import list at the top. The `listingMoreHref` test covers the three
paths a list can have (a category, `/search`, `/c/all`), because each needs its own partial file.

### `src/lib/listing-page.ts`

```ts
import type { ShopCategory, ShopListingPage, ShopListingQuery } from '@omnivo/contracts';

import { shopSource } from '../data/source';
import type { ShopSource } from '../data/types';
import { ALL_SLUG, listingHref, readListingQuery } from './listing-query';

// Step 26d.3: what the category page, the search page and their Load More partials do first, in
// one place, so the four agree. Server only, like listing-query.ts

// What the page does next. A union, so a page cannot draw a list it did not get
export type ListingLoad =
  // No category has this slug: the page answers 404, like an unknown product
  | { kind: 'missing' }
  // The address cannot be shown as it is; this one can (decision 17, and /search without words)
  | { kind: 'restart'; href: string }
  | {
      kind: 'found';
      query: ShopListingQuery;
      page: ShopListingPage;
      // null on /c/all and /search
      category: ShopCategory | null;
      // Every category, for the filter row's chips and menus
      categories: ShopCategory[];
    };

// `slug` is the path's: a category's slug, 'all' for every listing, or null on /search. The
// source is a parameter for the tests, which use a mock source of their own
export async function loadListing(
  slug: string | null,
  params: URLSearchParams,
  source: ShopSource = shopSource,
): Promise<ListingLoad> {
  const categories = await source.categories();
  let category: ShopCategory | null = null;
  if (slug !== null && slug !== ALL_SLUG) {
    category = categories.find((candidate) => candidate.slug === slug) ?? null;
    if (category === null) return { kind: 'missing' };
  }

  const query = readListingQuery(category?.slug ?? null, params);
  // /search with no words (an empty box, or "q=   "): every listing, with the other choices kept.
  // listingHref writes /c/all for a query with no category and no search
  if (slug === null && query.q === null) return { kind: 'restart', href: listingHref(query) };

  const page = await source.listings(query);
  // A cursor the source did not make: the same list from its first page. listingHref drops the
  // cursor, so the next request cannot land here again. An empty page after a cursor too: the
  // cards it pointed past were taken off the shop since, and "No products here yet" would be
  // wrong about the list
  if (page === null || (page.items.length === 0 && query.cursor !== null)) {
    return { kind: 'restart', href: listingHref(query) };
  }

  return { kind: 'found', query, page, category, categories };
}
```

- **One loader for four routes.** The category page, the search page and their two partials must agree on what an
  address means. If each did the lookup itself, a partial could answer cards for an address its page would redirect.
- **`ListingLoad` is a union.** A page must check `kind` before it can read `page`, so it cannot draw a list it did
  not get. A missing category and a restart are normal answers, not exceptions: an old link is normal traffic.
- **The slug is checked against `categories()` first.** `readListingQuery` trusts the slug it is given, and the source
  must never see a slug no category has. `all` is the reserved slug for every listing (decision 18).
- **`/search` with no words restarts at `listingHref(query)`.** That function writes `/c/all` for a query with no
  category and no search, and it keeps the sort and the filters. So `/search?q=&offer=1` becomes `/c/all?offer=1`.
- **A restart never loops.** `listingHref` drops the cursor unless asked, so the address it gives has no cursor, and a
  page with no cursor cannot be refused for its cursor. The same goes for the empty page after a cursor (decision 27).
- **`source` is a parameter** with the real one as its default. The pages call `loadListing(slug, params)`; the tests
  pass a mock source of their own, as the checkout's tests do.

### `src/lib/listing-page.spec.ts`

```ts
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
```

- The restart tests check the exact address, not only the kind: a restart that lost the sort (`/c/tea` instead of
  `/c/tea?sort=price_asc`) would still be a restart.
- "past the end" makes a real mock cursor with `encodeCursor(500)`. A made-up string would test the foreign-cursor
  rule again, not this one.
- The last test follows the first page's next link the way Load More does, and checks that no card comes twice.

### `src/styles/shop.css`

```diff
@@ -116,6 +116,22 @@
   }
 }
 
+/* Step 26d.3: the filter row's menus and panel (native popovers, decision 5), under their chip.
+   The chip and its menu share an anchor name (style attributes in CategoryFilters.astro), and
+   flip-inline moves a menu that would leave the screen (Sort By, at the right edge) to the chip's
+   other side. margin: auto first, because preflight's margin: 0 beats the browser's own centering:
+   a browser without anchor positioning then shows the menu in the middle of the screen, still
+   usable and still closed by Escape, instead of in the top-left corner */
+@utility chip-menu {
+  margin: auto;
+  @supports (position-area: bottom) {
+    inset: auto;
+    margin: 8px 0 0;
+    position-area: bottom span-right;
+    position-try-fallbacks: flip-inline;
+  }
+}
+
 /* Figma trims every text box to the cap height and the baseline (text-box-trim), and its spacing
    is measured between those edges. The same CSS property makes the browser match it; a browser
    without it (Firefox today) shows a few pixels more space, nothing breaks */
```

- **`chip-menu`** places a menu under its chip with CSS anchor positioning (decision 30). The chip has
  `anchor-name: --chip-1` and its menu `position-anchor: --chip-1`; `position-area: bottom span-right` puts the menu
  under the chip, starting at its left edge.
- **`position-try-fallbacks: flip-inline`** moves a menu that would leave the screen to the other side. "Sort By" sits
  at the right edge of the page; its menu then ends at the chip's right edge instead of running off the screen.
- **`margin: auto` comes first, outside `@supports`.** A browser centers a popover with its own `margin: auto`, but
  Tailwind's preflight sets `margin: 0` on every element, and the page's styles beat the browser's. Without this line,
  a browser with no anchor positioning would show the menu in the top-left corner of the screen.
- **`@supports (position-area: bottom)`** keeps `inset: auto` away from those browsers. Without the anchor, `inset:
  auto` would put the menu wherever the element happens to be in the page.

### `src/components/EmptyState.astro`

```
---
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';

// CLAUDE.md → Storefront screens not in Figma → Empty state: a card with a round cream tile, a
// title, a line that says what to do, and an optional button. Step 26d.3 uses it for a list with
// no cards; 26e for "page not found" and a closed shop. The cart drawer draws its own copy without
// the card, because the drawer is the card
interface Props {
  icon: IconSvgElement;
  title: string;
  text: string;
  // A link, never a button: every action here goes to another page
  action?: { href: string; label: string };
  // The title's level: h2 under a page's h1, h1 when the empty state is the whole page (26e)
  level?: 'h1' | 'h2';
}

const { icon, title, text, action, level = 'h2' } = Astro.props;
const Heading = level;
---

<div class="flex flex-col items-center gap-4 rounded-2xl bg-card px-4 py-12 text-center md:p-12">
  <span class="grid size-16 place-items-center rounded-full bg-cream">
    <HugeiconsIcon icon={icon} size={28} strokeWidth={1.5} aria-hidden="true" />
  </span>
  <Heading class="text-sf-title font-semibold">{title}</Heading>
  <p class="max-w-96 text-muted">{text}</p>
  {action && (
    <a
      href={action.href}
      class="mt-2 flex h-11 items-center rounded-sm bg-accent px-6 font-semibold transition-colors duration-150 hover:bg-brand hover:text-accent"
    >
      {action.label}
    </a>
  )}
</div>
```

- `CLAUDE.md` → Storefront screens not in Figma → Empty state, as a component, because three pages need it: this part
  for an empty list, and 26e for "page not found" and a closed shop.
- **The action is always a link.** Every way out of an empty state goes to another page ("Clear filters", "See all
  products"), so a button would need a script for nothing.
- **`level`** is `h2` under a page's `h1` (the list's title), and `h1` when the empty state is the whole page (26e).
  `const Heading = level` then `<Heading>` is how Astro draws a tag chosen at run time.
- `icon` has HugeIcons' own type, `IconSvgElement`, so any icon of the set fits and nothing else does.

### `src/components/LoadMore.astro`

```
---
import { Loading03Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { numberLocale } from '@omnivo/i18n';

import type { ShopLocale } from '../lib/locale';

// CLAUDE.md → Storefront → Load More, on the category and search pages (decision 3). It is a link
// to the next page, so it works without JavaScript. With JavaScript the script below asks the
// partial (`more`) for the next cards and adds them to the grid in place. The home page and the
// product page keep LoadMoreLink.astro: their Load More opens another page on purpose
interface Props {
  // The next page, for a shopper without JavaScript and for the script when the partial fails
  href: string;
  // The same cards from the partial (/c/<slug>/more): only the grid, no header or footer
  more: string;
  locale: ShopLocale;
}

const { href, more, locale } = Astro.props;
const { t } = locale;
// The words with a count go to the script with the count left as {{count}}, as in the cart drawer
const loaded = (count: number) =>
  t('shop.listing.loaded', { count, replace: { count: '{{count}}' } });
---

<div data-load-more-box class="mt-4 flex justify-center pt-2 pb-6 md:mt-12 md:p-0">
  {/* The two labels are both in the markup; the link's data-loading attribute shows one. So the
      script changes one attribute, and the words and the icon stay in this file */}
  <a
    href={href}
    data-load-more={more}
    data-number-locale={numberLocale(locale.language)}
    data-loaded-one={loaded(1)}
    data-loaded-other={loaded(2)}
    class="group/more flex h-[38px] items-center rounded-lg bg-card px-4 font-medium transition-colors duration-150 not-aria-disabled:hover:bg-cream"
  >
    <span class="group-data-loading/more:hidden">{t('shop.home.loadMore')}</span>
    <span class="hidden items-center gap-2.5 group-data-loading/more:flex">
      {t('shop.listing.loading')}
      <HugeiconsIcon
        icon={Loading03Icon}
        size={24}
        strokeWidth={1.5}
        className="animate-spin"
        aria-hidden="true"
      />
    </span>
  </a>
</div>

<script>
  // Load More (decision 3): ask the partial for the next cards and add them to the grid. Whatever
  // goes wrong (offline, a server error, a list that changed and a partial that says so), the
  // script follows the link instead, so the shopper still gets the next cards, on a new page

  // How long the live region stays empty before the words go in. A screen reader says a status
  // when its text changes, so two loads of "20 more products" need a change in between
  const ANNOUNCE_DELAY = 100;

  function announce(link: HTMLAnchorElement, count: number): void {
    const status = document.querySelector<HTMLElement>('[data-listing-status]');
    if (!status) return;
    const { loadedOne = '', loadedOther = '', numberLocale = 'en-IN' } = link.dataset;
    const one = new Intl.PluralRules(numberLocale).select(count) === 'one';
    const text = (one ? loadedOne : loadedOther).replace(
      '{{count}}',
      new Intl.NumberFormat(numberLocale).format(count),
    );
    status.textContent = '';
    window.setTimeout(() => {
      status.textContent = text;
    }, ANNOUNCE_DELAY);
  }

  function setLoading(link: HTMLAnchorElement, loading: boolean): void {
    link.toggleAttribute('data-loading', loading);
    // A link cannot be disabled; aria-disabled says it, and the click handler ignores it
    if (loading) link.setAttribute('aria-disabled', 'true');
    else link.removeAttribute('aria-disabled');
  }

  async function loadMore(link: HTMLAnchorElement, partial: string): Promise<void> {
    const grid = document.querySelector<HTMLUListElement>('[data-listing-grid]');
    if (!grid) {
      window.location.assign(link.href);
      return;
    }

    setLoading(link, true);
    let html: string;
    try {
      const response = await fetch(partial, { headers: { accept: 'text/html' } });
      if (!response.ok) throw new Error(`load more: ${String(response.status)}`);
      html = await response.text();
    } catch {
      // The page itself knows what to do: the next cards, or the first page of a changed list
      window.location.assign(link.href);
      return;
    }

    // A <template> parses the HTML without running it or loading its pictures: the cards' images
    // start loading when they join the page, lazily like the others
    const template = document.createElement('template');
    template.innerHTML = html;
    const cards = template.content.querySelector('[data-listing-grid]');
    if (!cards) {
      window.location.assign(link.href);
      return;
    }
    const items = [...cards.children];
    grid.append(...items);

    // The partial's own Load More: the page after these cards. getAttribute, not .href: a link in
    // a template belongs to a document with no address, so .href would not be this site's
    const next = template.content.querySelector<HTMLAnchorElement>('a[data-load-more]');
    const nextHref = next?.getAttribute('href');
    const nextPartial = next?.dataset.loadMore;
    if (nextHref && nextPartial) {
      link.setAttribute('href', nextHref);
      link.dataset.loadMore = nextPartial;
      setLoading(link, false);
    } else {
      // The last page. The focus was on the link that goes away, so it moves to the first new
      // card's name, where the shopper would read on
      link.closest('[data-load-more-box]')?.remove();
      items[0]?.querySelector<HTMLAnchorElement>('h3 a')?.focus();
    }
    announce(link, items.length);
  }

  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest<HTMLAnchorElement>('a[data-load-more]');
    const partial = link?.dataset.loadMore;
    if (!link || !partial) return;
    // Ctrl, ⌘ or Shift opens the next page in a new tab or window: the browser's job, not ours
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    // A second click while the cards are on their way would add them twice
    if (link.hasAttribute('data-loading')) return;
    void loadMore(link, partial);
  });
</script>
```

The markup:

- **A link, not a button.** Without JavaScript it opens the next page (`?cursor=…`), and the shopper still gets the
  next 20 cards, only on a new page (decision 3). The script makes it better; nothing depends on the script.
- **Two hrefs.** `href` is the next page; `data-load-more` is the partial with the same address. The page writes both,
  so the script needs no URL rules.
- **Both labels are in the markup.** The `data-loading` attribute on the link shows one of them
  (`group-data-loading/more:`). The script changes one attribute, and the words and the `Loading03` icon stay in this
  file, drawn on the server in the shop's language.
- **The counted words go to the script as templates** (`data-loaded-one`, `data-loaded-other`, with `{{count}}` left
  in), the same way as the cart drawer's. i18next is never loaded in the browser (the boundaries test checks that).
- `animate-spin` stops under reduced motion: the global rule in `shop.css` turns every animation off.

The script:

- **One click listener on the document**, not one on the link. The link's attributes change after each load, and a
  listener on the document always reads the current ones.
- **Ctrl, ⌘, Shift and Alt clicks are left to the browser.** The shopper asked for a new tab or window, and the link
  gives them the next page there.
- **`data-loading` blocks a second click.** Without it, a double click would ask for the same cards twice and add them
  twice. A link cannot be disabled, so `aria-disabled` tells a screen reader that it does nothing now.
- **Anything that fails follows the link**: no grid on the page, a network error, a status that is not 200 (decision
  26), an answer with no grid. The page itself then shows the next cards, or starts the list again.
- **A `<template>` reads the HTML.** Its content is parsed but not live: no script in it runs, and no picture starts
  loading until the cards join the page.
- **`getAttribute('href')`, not `.href`.** A link inside a template belongs to a document with no address of its own,
  so `.href` would not resolve against the shop's address.
- **The last page removes the box and moves the focus** to the first new card's name (decision 28). Otherwise the focus
  would be on an element that is gone, and the next Tab would start again at the top of the page.
- **`announce` empties the live region first.** A screen reader speaks a status when its text changes. Two loads in a
  row both say "20 more products", so without the empty step the second one would be silent. 100 ms is long enough
  for screen readers to see the change.
- **The plural uses `Intl.PluralRules`** with the shop's number locale, and the count uses `Intl.NumberFormat`, so a
  Bangla shop says "২০টি" with Bangla digits, as the cart drawer does.

### `src/components/ListingGrid.astro`

```
---
import type { ShopListingPage, ShopListingQuery } from '@omnivo/contracts';

import { listingHref, listingMoreHref } from '../lib/listing-query';
import type { ShopLocale } from '../lib/locale';
import LoadMore from './LoadMore.astro';
import ProductCard from './ProductCard.astro';

// Step 26d.3: one page of cards and the Load More after it. The page draws it, and so does the
// partial that Load More's script asks for (pages/c/[slug]/more.astro): the script moves the
// partial's <li> into the page's grid and takes the partial's Load More link. One component for
// both, so the cards it adds are the very markup the page drew (decision 3)
interface Props {
  query: ShopListingQuery;
  page: ShopListingPage;
  locale: ShopLocale;
}

const { query, page, locale } = Astro.props;
const cursor = page.nextCursor;
---

{/* The home page's "All Category" grid: one card a row on a phone, then 3, 4 and 5 columns */}
<ul data-listing-grid class="grid gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
  {page.items.map((listing) => (
    <li>
      <ProductCard listing={listing} locale={locale} />
    </li>
  ))}
</ul>
{cursor !== null && (
  <LoadMore
    href={listingHref(query, { cursor })}
    more={listingMoreHref(query, cursor)}
    locale={locale}
  />
)}
```

- **One component for the page and the partial** (decision 3). The script moves the partial's `<li>` elements into the
  page's grid, so the cards it adds are exactly the cards the page draws. There is no second card template in the
  browser that could drift from `ProductCard.astro`.
- **The partial's own Load More** is how the script learns the page after the next one. With no next cursor there is no
  link, and the script removes the button.
- `const cursor = page.nextCursor` before the markup: inside `{cursor !== null && …}` the type is then `string`, which
  `listingHref` and `listingMoreHref` need.
- The grid classes are the home page's "All Category" grid: one card a row on a phone, then 3, 4 and 5 columns.

### `src/components/CategoryFilters.astro`

```
---
import { ArrowDown01Icon, FilterHorizontalIcon, Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { SHOP_SORTS, type ShopCategory, type ShopListingQuery } from '@omnivo/contracts';

import { hasPanelFilters, listingHref, listingPath } from '../lib/listing-query';
import type { ShopLocale } from '../lib/locale';

// CLAUDE.md → Storefront → Filter row. Desktop (Figma 37:3131): square chips and "Sort By" on the
// right. Phone (Figma 138:799): round pills that wrap, categories only.
// Step 26d.3: the row works. Every chip is a link that changes one choice of the list on screen
// (`query`), or a button that opens a native popover (decision 5): a category's menu, the filter
// panel, the sort menu. No script opens or closes them: the browser does, with Escape and a click
// outside, and only one is open at a time. The home page passes the defaults, so there the row
// leads to /c/all
interface Props {
  categories: ShopCategory[];
  query: ShopListingQuery;
  locale: ShopLocale;
}

const { categories, query, locale } = Astro.props;
const { t } = locale;

// The categories under one, in the shop's order, each with its depth for the menu's indent. Every
// level, not only the first: a real shop may have Beverages → Tea → Green tea
interface Entry {
  category: ShopCategory;
  depth: number;
}
function below(parent: ShopCategory, depth = 0): Entry[] {
  return categories
    .filter((category) => category.parentId === parent.id)
    .flatMap((category) => [{ category, depth }, ...below(category, depth + 1)]);
}

const top = categories
  .filter((category) => category.parentId === null)
  .map((category) => {
    const children = below(category);
    return {
      category,
      children,
      // The chip of the list on screen: its own page or one under it (/c/skin-care lights Cosmetics)
      selected:
        query.category === category.slug ||
        children.some((entry) => entry.category.slug === query.category),
    };
  });

const panelOn = hasPanelFilters(query);
// "Clear" in the panel: the price and the stock go, the rest stays
const clearHref = listingHref(query, { minPrice: null, maxPrice: null, inStock: false });

const chip =
  'flex h-[38px] items-center gap-2 rounded-lg px-3 text-sf-body whitespace-nowrap transition-colors duration-150';
const chipOn = 'bg-brand font-medium text-accent';
const chipOff = 'bg-card hover:bg-cream';
// 36px like Figma's pills: the 1px border is inside that height, so 9px of padding, not 10
const pill =
  'block rounded-full border px-4 py-[9px] text-sf-small leading-4 transition-colors duration-150';
// Not in Figma: the menus are white cards with the rule line, no shadow (the storefront has none)
const menu =
  'chip-menu w-max max-w-80 min-w-56 rounded-lg border border-rule bg-card p-2 text-brand';
const item =
  'flex items-center justify-between gap-3 rounded-sm py-2.5 pr-3 transition-colors duration-150 hover:bg-cream aria-[current]:font-semibold';
const field =
  'h-12 w-full min-w-0 rounded-lg border border-field bg-card px-4 tabular-nums transition-colors duration-150 hover:border-muted-line focus:border-brand focus:outline-2 focus:outline-offset-0 focus:outline-brand';
const button =
  'flex h-11 flex-1 items-center justify-center rounded-sm font-semibold transition-colors duration-150';
---

<nav aria-label={t('shop.home.categoryFilters')}>
  {/* Desktop */}
  <div class="hidden items-start justify-between gap-4 md:flex">
    <ul class="flex flex-wrap items-center gap-4">
      {/* Every listing, with the search and the filters kept. A link with no menu, so no chevron:
          the menu Figma draws on it would only repeat the chips beside it (decision 23) */}
      <li>
        <a
          href={listingHref(query, { category: null })}
          aria-current={query.category === null ? 'true' : undefined}
          class:list={[chip, query.category === null ? chipOn : chipOff]}
        >
          {t('shop.home.allCategories')}
        </a>
      </li>

      {top.map(({ category, children, selected }, index) =>
        children.length === 0 ? (
          // Nothing under it: a menu with one line would be a click for nothing
          <li>
            <a
              href={listingHref(query, { category: category.slug })}
              aria-current={selected ? 'true' : undefined}
              class:list={[chip, selected ? chipOn : chipOff]}
            >
              {category.name}
            </a>
          </li>
        ) : (
          <li>
            {/* The chip and its menu share an anchor name, so CSS places the menu under the chip
                (the chip-menu utility in shop.css). By index: a category's id may hold characters
                a CSS name cannot */}
            <button
              type="button"
              popovertarget={`chip-menu-${String(index)}`}
              style={`anchor-name: --chip-${String(index)}`}
              class:list={[chip, selected ? chipOn : chipOff]}
            >
              {category.name}
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={14}
                strokeWidth={1.5}
                aria-hidden="true"
              />
            </button>
            <div
              id={`chip-menu-${String(index)}`}
              popover
              style={`position-anchor: --chip-${String(index)}`}
              class={menu}
            >
              <ul>
                {[{ category, depth: -1 }, ...children].map((entry) => {
                  const current = query.category === entry.category.slug;
                  return (
                    <li>
                      {/* 12px in, 16px more per level. A style, not a class: the depth has no end */}
                      <a
                        href={listingHref(query, { category: entry.category.slug })}
                        aria-current={current ? 'page' : undefined}
                        style={`padding-inline-start: ${String(12 + (entry.depth + 1) * 16)}px`}
                        class={item}
                      >
                        {entry.depth === -1
                          ? t('shop.listing.allOf', { category: category.name })
                          : entry.category.name}
                        {current && (
                          <HugeiconsIcon
                            icon={Tick02Icon}
                            size={16}
                            strokeWidth={1.5}
                            aria-hidden="true"
                          />
                        )}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          </li>
        ),
      )}

      {/* A switch, not a menu: no chevron (decision 6). The link turns it on or off; the label says
          its state, because a link cannot be aria-pressed */}
      <li>
        <a
          href={listingHref(query, { offer: !query.offer })}
          aria-label={
            query.offer ? t('shop.listing.on', { filter: t('shop.home.offer') }) : undefined
          }
          class:list={[chip, query.offer ? chipOn : chipOff]}
        >
          {t('shop.home.offer')}
        </a>
      </li>

      <li>
        <button
          type="button"
          popovertarget="filter-panel"
          style="anchor-name: --chip-filter"
          aria-label={
            panelOn ? t('shop.listing.on', { filter: t('shop.home.allFilter') }) : undefined
          }
          class:list={[chip, panelOn ? chipOn : chipOff]}
        >
          {t('shop.home.allFilter')}
          <HugeiconsIcon
            icon={FilterHorizontalIcon}
            size={14}
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </button>
        {/* A GET form (decision 7): Apply loads the same list with the new filters, with or
            without JavaScript. The choices the panel does not show ride along as hidden fields,
            in the order listingHref writes them, so Apply gives the address a link would */}
        <form
          id="filter-panel"
          popover
          method="get"
          action={listingPath(query.category, query.q)}
          aria-label={t('shop.listing.filter.title')}
          data-filter-form
          style="position-anchor: --chip-filter"
          class:list={[menu, 'w-80 p-5']}
        >
          {query.q !== null && <input type="hidden" name="q" value={query.q} />}
          {query.sort !== 'newest' && <input type="hidden" name="sort" value={query.sort} />}
          <fieldset>
            <legend class="font-semibold">{t('shop.listing.filter.price')}</legend>
            <div class="mt-3 grid grid-cols-2 gap-3">
              {/* Text, not type="number": a Bangla keyboard types ০–৯, which a number box refuses
                  (the page converts them, as the cart does) */}
              <label class="flex flex-col gap-2 text-sf-small font-medium">
                {t('shop.listing.filter.from')}
                <input
                  type="text"
                  name="min"
                  inputmode="numeric"
                  autocomplete="off"
                  value={query.minPrice ?? ''}
                  class={field}
                />
              </label>
              <label class="flex flex-col gap-2 text-sf-small font-medium">
                {t('shop.listing.filter.to')}
                <input
                  type="text"
                  name="max"
                  inputmode="numeric"
                  autocomplete="off"
                  value={query.maxPrice ?? ''}
                  class={field}
                />
              </label>
            </div>
          </fieldset>
          <label class="mt-5 flex items-center gap-3 font-semibold">
            <input
              type="checkbox"
              name="stock"
              value="1"
              checked={query.inStock}
              class="size-5 shrink-0 accent-brand"
            />
            {t('shop.listing.filter.inStock')}
          </label>
          {query.offer && <input type="hidden" name="offer" value="1" />}
          <div class="mt-6 flex gap-3">
            <a href={clearHref} class:list={[button, 'bg-cream hover:bg-accent']}>
              {t('shop.listing.filter.clear')}
            </a>
            <button
              type="submit"
              class:list={[button, 'bg-accent hover:bg-brand hover:text-accent']}
            >
              {t('shop.listing.filter.apply')}
            </button>
          </div>
        </form>
      </li>
    </ul>

    <button
      type="button"
      popovertarget="sort-menu"
      style="anchor-name: --chip-sort"
      class:list={[chip, 'border border-brand font-medium hover:bg-cream']}
    >
      {t('shop.home.sortBy')}
      <HugeiconsIcon icon={FilterHorizontalIcon} size={14} strokeWidth={1.5} aria-hidden="true" />
    </button>
    <div id="sort-menu" popover style="position-anchor: --chip-sort" class={menu}>
      <ul aria-label={t('shop.listing.sort.title')}>
        {SHOP_SORTS.map((sort) => (
          <li>
            <a
              href={listingHref(query, { sort })}
              aria-current={query.sort === sort ? 'true' : undefined}
              class:list={[item, 'pl-3']}
            >
              {t(`shop.listing.sort.${sort}`)}
              {query.sort === sort && (
                <HugeiconsIcon icon={Tick02Icon} size={16} strokeWidth={1.5} aria-hidden="true" />
              )}
            </a>
          </li>
        ))}
      </ul>
    </div>
  </div>

  {/* Phone: the categories only (CLAUDE.md), the top ones. A category under one is reached from
      the category drawer (26d.4); its top category's pill shows as chosen */}
  <ul class="flex flex-wrap gap-2 md:hidden">
    <li>
      <a
        href={listingHref(query, { category: null })}
        aria-current={query.category === null ? 'true' : undefined}
        class:list={[
          pill,
          query.category === null
            ? 'border-brand bg-brand font-semibold text-accent'
            : 'border-rule bg-card',
        ]}
      >
        {t('shop.home.all')}
      </a>
    </li>
    {top.map(({ category, selected }) => (
      <li>
        <a
          href={listingHref(query, { category: category.slug })}
          aria-current={selected ? 'true' : undefined}
          class:list={[
            pill,
            selected ? 'border-brand bg-brand font-semibold text-accent' : 'border-rule bg-card',
          ]}
        >
          {category.name}
        </a>
      </li>
    ))}
  </ul>
</nav>

<script>
  // The filter panel without its empty boxes: a native GET form sends "min=&max=" for two empty
  // boxes, two keys in the address that mean nothing, and one list would get a second address.
  // The script sends the same form without them. Without JavaScript the native form still works:
  // the page reads an empty value as "not set"
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-filter-form')) return;
    event.preventDefault();
    const params = new URLSearchParams();
    for (const [key, value] of new FormData(form)) {
      if (typeof value === 'string' && value.trim() !== '') params.append(key, value.trim());
    }
    const search = params.toString();
    window.location.assign(`${form.action}${search === '' ? '' : `?${search}`}`);
  });
</script>
```

This component is mostly new, so it is shown whole. It now takes the list's `query`: every chip, menu line, sort and
filter is a link (or a form) to the same list with one choice changed, and `listingHref` writes it.

- **`below()`** lists every category under a top one, at every depth, in the shop's order, with the depth for the indent.
  It cannot loop: the tree comes from the ERP, where every category has one parent, so a walk down from a top category
  never meets itself.
- **`selected`** is true for the chip of the list on screen and for the chip above it. On `/c/skin-care` the
  Cosmetics chip is filled, and its menu marks "Skin care" with the tick.
- **"All Categories" and a category with nothing under it are links** (decisions 23 and 24), so they have no chevron.
  `listingHref(query, { category: null })` keeps the search: on `/c/skin-care?q=neem` it leads to `/search?q=neem`.
- **A chip with children is a `<button popovertarget>`** (decision 5). The browser opens the `popover` element with
  that id, closes it on Escape or a click outside, keeps one menu open at a time, and gives the button
  `aria-expanded`. None of this needs a script.
- **The anchor names use the chip's index**, not its id: an id from the ERP may hold characters a CSS name cannot. They
  are set in `style` attributes because each chip needs its own name, and Tailwind classes are fixed when the CSS is
  built.
- **The menu's first line is "All of Cosmetics"**: the top category itself, with everything under it. The indent is a
  `style` too (12px, then 16px more per level), because the depth has no upper limit.
- **`aria-current="page"`** marks the menu line of the list on screen; the chips use `aria-current="true"`, as the home
  page did. The tick icon is `aria-hidden`: the attribute already tells a screen reader.
- **Offer is a link that flips `offer`** (decision 6). A link cannot be `aria-pressed`, so when the filter is on, its
  `aria-label` says so ("Offer, on").
- **The filter panel is a GET form** (decision 7). Its `action` is the list's own path, so Apply loads the same list.
  The choices the panel does not show (the search, the sort, Offer) ride along as hidden fields, placed in the order
  `listingHref` writes them, so Apply writes the same address a link would.
- **The price boxes are `type="text"` with `inputmode="numeric"`.** A number box refuses the Bangla digits ০–৯, which a
  Bangla keyboard types. The page converts them (26d.2).
- **Clear is a link** that drops the price and the stock and keeps the rest. It needs no form submit.
- **Sort By** lists `SHOP_SORTS`, so a sort added to the contract shows up here, and its word is checked by the type of
  `t()`: `shop.listing.sort.${sort}` must exist for every value.
- **On the phone only the categories show** (`CLAUDE.md`), and only the top ones. A category under one gets the
  category drawer in 26d.4; until then, its top category's pill is the one filled.
- **The script** sends the filter form without its empty boxes (decision 29). It uses `form.action`, which the browser
  has already made absolute, and keeps the field order of the form.

### `src/components/ListingView.astro`

```
---
import { FilterRemoveIcon, Search01Icon, ShoppingBasket01Icon } from '@hugeicons/core-free-icons';
import type { ShopCategory, ShopListingPage, ShopListingQuery } from '@omnivo/contracts';

import { ALL_SLUG, hasPanelFilters, listingHref } from '../lib/listing-query';
import type { ShopLocale } from '../lib/locale';
import CategoryFilters from './CategoryFilters.astro';
import EmptyState from './EmptyState.astro';
import ListingGrid from './ListingGrid.astro';

// CLAUDE.md → Storefront screens not in Figma → Category and search: the home page's "All
// Category" block alone. The title, the filter row, the grid and Load More, or an empty state.
// Shared by /c/<slug> and /search, which differ only in the title
interface Props {
  title: string;
  query: ShopListingQuery;
  page: ShopListingPage;
  categories: ShopCategory[];
  locale: ShopLocale;
}

const { title, query, page, categories, locale } = Astro.props;
const { t } = locale;

// Why the list is empty decides what the empty state says, and the way out it offers. Filters
// first: with a filter on, clearing it is the likeliest fix, even on a search
function emptyState() {
  if (hasPanelFilters(query) || query.offer) {
    return {
      icon: FilterRemoveIcon,
      title: t('shop.listing.noMatchTitle'),
      text: t('shop.listing.noMatchText'),
      action: {
        href: listingHref(query, { minPrice: null, maxPrice: null, inStock: false, offer: false }),
        label: t('shop.listing.clearFilters'),
      },
    };
  }
  if (query.q !== null) {
    return {
      icon: Search01Icon,
      title: t('shop.listing.noResultsTitle', { q: query.q }),
      text: t('shop.listing.noResultsText'),
      action: { href: `/c/${ALL_SLUG}`, label: t('shop.listing.seeAll') },
    };
  }
  // A category with nothing in it yet. On /c/all there is nowhere else to send the shopper
  return {
    icon: ShoppingBasket01Icon,
    title: t('shop.listing.emptyTitle'),
    text: t('shop.listing.emptyText'),
    ...(query.category === null
      ? {}
      : { action: { href: `/c/${ALL_SLUG}`, label: t('shop.listing.seeAll') } }),
  };
}
---

{/* The same sizes as the home page's block: 36px from the header on desktop (the checkout card's
    gap), 16px on a phone; the title, then the row and the grid 36px apart (12px and 16px) */}
<div class="mt-4 md:mt-9">
  <h1 class="text-sf-subtitle leading-[23px] font-bold md:trim-text md:text-sf-display md:font-semibold">
    {title}
  </h1>
  <div class="mt-3 md:mt-9">
    <CategoryFilters categories={categories} query={query} locale={locale} />
  </div>
  <div class="mt-4 md:mt-9">
    {page.items.length === 0 ? (
      <EmptyState {...emptyState()} />
    ) : (
      <ListingGrid query={query} page={page} locale={locale} />
    )}
  </div>
  {/* Load More's script says here how many cards it added. Outside the Load More box, which goes
      away with the last page, and with it anything said inside it */}
  <p data-listing-status role="status" class="sr-only"></p>
</div>
```

- **The block of the category and search pages**: the title, the filter row, and the grid or an empty state. The two
  pages differ only in the title, so they share this component.
- **`emptyState()` picks the words by why the list is empty.** Filters come first: with a filter on, clearing it is the
  likeliest fix, even on a search. Then a search with no results. Then a category with nothing in it yet, whose "See
  all products" button is left out on `/c/all`, where it would lead back to the same empty page.
- **The spacing** copies the home page's block: 36px from the header on desktop (the checkout card's gap), 16px on a
  phone, and the same gaps between the title, the row and the grid.
- **The live region is outside the Load More box.** The box goes away after the last page, and a screen reader would
  not say a status that was removed with it.

### `src/pages/c/[slug].astro`

```
---
import ListingView from '../../components/ListingView.astro';
import { shopSource } from '../../data/source';
import ShopLayout from '../../layouts/ShopLayout.astro';
import { loadListing } from '../../lib/listing-page';
import { shopLocale } from '../../lib/locale';

// Step 26d.3: a category's products, with those of the categories under it (/c/cosmetics), or
// every product (/c/all). The address holds the search, the filters, the sort and the page
// (decision 2); lib/listing-page.ts reads it
const [shop, load] = await Promise.all([
  shopSource.shop(),
  loadListing(Astro.params.slug ?? '', Astro.url.searchParams),
]);

// No category has this slug: Astro's 404 page, with the 404 status, like an unknown product
if (load.kind === 'missing') return Astro.rewrite('/404');
// The same list from its first page (decision 17)
if (load.kind === 'restart') return Astro.redirect(load.href);

const locale = await shopLocale(shop.language);
const { t } = locale;
const { query, page, category, categories } = load;

// A search inside a category (/c/skin-care?q=neem, after a chip on the search page) is still a
// search, so it says so
const title =
  query.q !== null
    ? t('shop.listing.searchTitle', { q: query.q })
    : (category?.name ?? t('shop.listing.all'));
---

<ShopLayout
  shop={shop}
  locale={locale}
  title={t('shop.listing.pageTitle', { title, shop: shop.name })}
  search={query.q}
>
  <ListingView title={title} query={query} page={page} categories={categories} locale={locale} />
</ShopLayout>
```

- `shop()` and `loadListing()` run together with `Promise.all`; neither needs the other.
- **A missing category is `Astro.rewrite('/404')`**, like the product page: the 404 status, so a search engine drops
  the address. 26e draws the shop's own "page not found".
- **A restart is `Astro.redirect`** (302): the address stays usable, and the shopper lands on the same list's first
  page.
- **The title is the search when there is one.** After a chip on the search page, `/c/skin-care?q=neem` is still a
  search, so it says "Results for “neem”"; the filled chip shows the category.
- `search={query.q}` gives the words back to the header's box.

### `src/pages/search.astro`

```
---
import ListingView from '../components/ListingView.astro';
import { shopSource } from '../data/source';
import ShopLayout from '../layouts/ShopLayout.astro';
import { loadListing } from '../lib/listing-page';
import { shopLocale } from '../lib/locale';

// Step 26d.3: the header's search (/search?q=neem), across every category (decision 8). The words
// go to the source; the page draws the answer like a category's
const [shop, load] = await Promise.all([
  shopSource.shop(),
  loadListing(null, Astro.url.searchParams),
]);

// No words (an empty box): /c/all. A cursor the source did not make: the first page. A search has
// no slug, so it is never 'missing'
if (load.kind !== 'found') return Astro.redirect(load.kind === 'restart' ? load.href : '/c/all');

const locale = await shopLocale(shop.language);
const { t } = locale;
const { query, page, categories } = load;
const title = t('shop.listing.searchTitle', { q: query.q ?? '' });
---

<ShopLayout
  shop={shop}
  locale={locale}
  title={t('shop.listing.pageTitle', { title, shop: shop.name })}
  search={query.q}
>
  <ListingView title={title} query={query} page={page} categories={categories} locale={locale} />
</ShopLayout>
```

`loadListing(null, …)` never answers `missing` for a search, because there is no slug to miss. The type still has that
case, so the page handles it with the same redirect to `/c/all` instead of a cast.

### `src/pages/c/[slug]/more.astro` and `src/pages/search/more.astro`

```
---
import ListingGrid from '../../../components/ListingGrid.astro';
import { shopSource } from '../../../data/source';
import { loadListing } from '../../../lib/listing-page';
import { shopLocale } from '../../../lib/locale';

// Step 26d.3: the cards Load More's script asks for (decision 3). A partial: only this component's
// HTML, no <html>, header or footer. The address is the page's own, so the cards are the ones the
// page's link would show
export const partial = true;

const [shop, load] = await Promise.all([
  shopSource.shop(),
  loadListing(Astro.params.slug ?? '', Astro.url.searchParams),
]);

// No redirect here: fetch() would follow it to the first page and the script would add those
// cards a second time. A status the script reads as "follow the link" instead, and the page itself
// redirects
if (load.kind === 'missing') return new Response(null, { status: 404 });
if (load.kind === 'restart') return new Response(null, { status: 409 });

// A piece of a page, not a page: search engines skip it
Astro.response.headers.set('X-Robots-Tag', 'noindex');
const locale = await shopLocale(shop.language);
---

<ListingGrid query={load.query} page={load.page} locale={locale} />
```

```
---
import ListingGrid from '../../components/ListingGrid.astro';
import { shopSource } from '../../data/source';
import { loadListing } from '../../lib/listing-page';
import { shopLocale } from '../../lib/locale';

// Step 26d.3: Load More's cards for the search page, like /c/<slug>/more
export const partial = true;

const [shop, load] = await Promise.all([
  shopSource.shop(),
  loadListing(null, Astro.url.searchParams),
]);

if (load.kind !== 'found') return new Response(null, { status: 409 });

Astro.response.headers.set('X-Robots-Tag', 'noindex');
const locale = await shopLocale(shop.language);
---

<ListingGrid query={load.query} page={load.page} locale={locale} />
```

- **`export const partial = true`** makes Astro send only this file's HTML: no `<!doctype>`, `<head>`, header or
  footer. One page of 20 cards is about 43 KB before compression, mostly the cards' SVG icons.
- **No redirect** (decision 26): 404 for an unknown category, 409 for "start again". The script follows the link on
  either, and the full page does the redirect.
- **`X-Robots-Tag: noindex`**: a piece of a page should not show up in search results on its own.
- They sit next to their pages (`/c/[slug].astro` and `/c/[slug]/more.astro`, `search.astro` and `search/more.astro`),
  which is why `listingMoreHref` only adds `/more` to the path.

### `src/layouts/ShopLayout.astro` and `src/components/Header.astro`

```diff
@@ -14,9 +14,11 @@ interface Props {
   shop: PublicShop;
   locale: ShopLocale;
   title: string;
+  // Step 26d.3: the words of the search on screen, which the header's box shows again
+  search?: string | null;
 }
 
-const { shop, locale, title } = Astro.props;
+const { shop, locale, title, search = null } = Astro.props;
 const { t } = locale;
 
 // The tenant's two theme colors win over the stylesheet's defaults. They are #rrggbb (the contract
@@ -40,7 +42,7 @@ const theme = `--brand: ${shop.theme.brand}; --accent: ${shop.theme.accent}`;
       {t('shop.skipToContent')}
     </a>
     <div class="shop-container">
-      <Header shop={shop} locale={locale} />
+      <Header shop={shop} locale={locale} search={search} />
       <main id="main">
         <slot />
       </main>
```

```diff
@@ -1,7 +1,7 @@
 ---
 import { Cancel01Icon, Menu01Icon, Search01Icon, User02Icon } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
-import type { PublicShop } from '@omnivo/contracts';
+import { SHOP_SEARCH_MAX_LENGTH, type PublicShop } from '@omnivo/contracts';
 
 import type { ShopLocale } from '../lib/locale';
 import CartButton from './CartButton.astro';
@@ -13,9 +13,12 @@ import Logo from './Logo.astro';
 interface Props {
   shop: PublicShop;
   locale: ShopLocale;
+  // Step 26d.3: the search on screen (/search?q=neem), so the shopper can change a word instead
+  // of typing it all again. null on every other page
+  search: string | null;
 }
 
-const { shop, locale } = Astro.props;
+const { shop, locale, search } = Astro.props;
 const { t } = locale;
 ---
 
@@ -56,6 +59,8 @@ const { t } = locale;
         type="search"
         name="q"
         required
+        maxlength={SHOP_SEARCH_MAX_LENGTH}
+        value={search}
         placeholder={t('shop.header.searchPlaceholder')}
         class="h-full w-full rounded-full bg-card pr-14 pl-5 text-sf-body font-medium text-brand placeholder:text-muted focus-visible:outline-accent"
       />
```

- **The search box shows the search on screen**, so the shopper can fix one word instead of typing it all again. On
  every other page `search` is `null`, and Astro leaves the `value` attribute out.
- `search` is optional in the layout (most pages have no search) and required in the header, so the layout must pass
  it on and cannot forget it.
- **`maxlength={SHOP_SEARCH_MAX_LENGTH}`**: the box stops at 100 characters, the same limit the page reads (26d.2).

### `src/pages/index.astro`

```diff
@@ -7,6 +7,7 @@ import ProductCard from '../components/ProductCard.astro';
 import ProductRow from '../components/ProductRow.astro';
 import { shopSource } from '../data/source';
 import ShopLayout from '../layouts/ShopLayout.astro';
+import { readListingQuery } from '../lib/listing-query';
 import { shopLocale } from '../lib/locale';
 
 // Step 26a: the home page (Figma 37:3083 on desktop, 138:234 on the phone)
@@ -17,6 +18,8 @@ const [locale, categories, home] = await Promise.all([
   shopSource.home(),
 ]);
 const { t } = locale;
+// Step 26d.3: the filter row works from the defaults here, so every chip leads to /c/all
+const query = readListingQuery(null, new URLSearchParams());
 ---
 
 <ShopLayout shop={shop} locale={locale} title={t('shop.home.title', { shop: shop.name })}>
@@ -34,7 +37,7 @@ const { t } = locale;
       <span class="hidden md:inline">{t('shop.home.allCategory')}</span>
     </h2>
     <div class="mt-3 md:mt-9">
-      <CategoryFilters categories={categories} locale={locale} />
+      <CategoryFilters categories={categories} query={query} locale={locale} />
     </div>
 
     <div class="mt-4 flex items-center justify-between md:hidden">
```

The home page passes the default query (`readListingQuery(null, new URLSearchParams())`) to the filter row, so every
chip, the filter panel and the sort lead to `/c/all` with that choice.

### Check this part

```sh
pnpm --filter @omnivo/shop typecheck        # astro check: 0 errors
pnpm --filter @omnivo/shop test             # 152 tests
pnpm exec eslint apps/shop/src
pnpm exec prettier --check apps/shop/src
pnpm --filter @omnivo/shop build
```

Then run the built shop (`HOST=127.0.0.1 PORT=4399 node apps/shop/dist/server/entry.mjs`) and check by hand:

- `/c/nope` is 404, `/search?q=` and `/c/all?cursor=junk` redirect to `/c/all`, `/c/all/more?cursor=junk` is 409.
- At 1440px: the Cosmetics chip opens its menu under the chip ("All of Cosmetics", then Skin care and Hair care,
  indented); Sort By's menu ends at the chip's right edge.
- On `/c/all?sort=price_asc`, All Filter with From `৫০০` and To `100` and "In stock only": the address keeps the sort,
  the cards cost ৳100 to ৳500 and are in stock, the chip is filled, and its label is "All Filter, on".
- On `/c/all`, Load More three times: 20, 40, 60, then 62 cards, none twice; the button goes, the focus is on the first
  new card, and the status says "2 more products".
- With JavaScript turned off, Load More opens `?cursor=…`, and the menus still open.
- At 390px: no sideways scroll, the pills only, and on `/c/skin-care` the Cosmetics pill is filled.

Broken on purpose while this part was written, and caught:

- The loader without the "no words" restart: "sends a search with no words to /c/all" fails.
- The loader without the empty-page rule: "starts again when a cursor points past the end" fails.
- `listingMoreHref` returning the page's own link: its test fails.
- `hasPanelFilters` without `inStock`: its test fails.

These are checked only by hand until 26e's Playwright tests: the popovers, the script's focus and live region, and the
pages without JavaScript.

## 26d.4 — `apps/shop/src`: the category drawer

The header's menu button opens a drawer from the left with every category as a tree (decision 9). It is the cart
drawer's frame on the other side: a native `<dialog>` in a small custom element, 420px wide on desktop and the whole
width on a phone, `overlay` behind it, no slide. Figma has no drawer, so the look follows the cart drawer and the chip
menus of 26d.3.

The work is in three layers:

- **`lib/category-tree.ts`**: turns the source's flat list into a tree, and finds the groups to open.
- **Components**: the drawer, and one level of the tree that draws the next level inside itself.
- **The frame**: the header's button works on every screen size, the layout draws the drawer, and every page passes
  the categories.

### `src/lib/category-tree.ts`

```ts
import type { ShopCategory } from '@omnivo/contracts';

// Step 26d.4: the shop's categories as a tree, for the category drawer. The source answers a flat
// list (each category names its parent); the drawer draws nested lists, so it needs each one's
// children in hand. A plain function with no imports but a type, so the tests need no source.

export interface CategoryNode {
  category: ShopCategory;
  children: CategoryNode[];
}

// Top categories first, each with the ones under it, at any depth (a real shop may have Beverages →
// Tea → Green tea). The list's own order is kept at every level: it is the shop's order.
// A category whose parent is not in the list is left out: the source answers only categories the
// shop shows, so its parent was hidden, and a hidden parent hides what is under it.
// The tree is built from the top down, so a loop in the data (A under B, B under A) can never be
// reached from a top category and cannot make this run forever
export function categoryTree(categories: ShopCategory[]): CategoryNode[] {
  const byParent = new Map<string | null, ShopCategory[]>();
  for (const category of categories) {
    const siblings = byParent.get(category.parentId);
    if (siblings) siblings.push(category);
    else byParent.set(category.parentId, [category]);
  }

  const build = (parentId: string | null): CategoryNode[] =>
    (byParent.get(parentId) ?? []).map((category) => ({
      category,
      children: build(category.id),
    }));

  return build(null);
}

// The ids of the categories above the one with this slug, top first, and its own id last. The
// drawer opens these groups, so the list on screen is in view when the drawer opens. Empty when no
// category has the slug (/c/all, /search, a page that is not a list)
export function categoryPath(categories: ShopCategory[], slug: string | null): string[] {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const path: string[] = [];
  let category = categories.find((candidate) => candidate.slug === slug);
  // A path is never longer than the list: in a loop in the data, the walk ends there instead of
  // spinning
  while (category && path.length < categories.length) {
    path.unshift(category.id);
    category = category.parentId === null ? undefined : byId.get(category.parentId);
  }
  return path;
}
```

- **`categoryTree` groups by parent first** (`byParent`), then builds from the top down. Each category is visited
  once, so a shop with 500 categories is 500 steps, not 500 × 500.
- **The list's order is kept at every level.** The source answers the categories in the shop's order, and the drawer
  should show them in that order, like the chips.
- **A category whose parent is missing is left out.** The source answers only the categories the shop shows, so a
  missing parent was hidden by the shop, and what is under it should be hidden too.
- **A loop in the data cannot hang the page.** In a loop (A under B, B under A) neither category has a parent of
  `null`, so the walk from the top never reaches them. The database should never hold a loop, but a page that hangs
  is a much worse failure than a missing category.
- **`categoryPath` walks up from the list on screen**, and stops after as many steps as there are categories. A real
  path is never longer than that, so the limit only ever stops a loop.
- **No source, no Astro, only a type import.** The tests need nothing but plain objects.

### `src/lib/category-tree.spec.ts`

```ts
import type { ShopCategory } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { categoryPath, categoryTree, type CategoryNode } from './category-tree';

function category(id: string, parentId: string | null = null): ShopCategory {
  return { id, slug: id, name: id, parentId };
}

// The tree as nested ids, so a failure shows its shape at a glance
type Shape = [string, Shape[]];
function shape(nodes: CategoryNode[]): Shape[] {
  return nodes.map((node) => [node.category.id, shape(node.children)]);
}

describe('categoryTree', () => {
  it('puts each category under its parent, in the list order', () => {
    const tree = categoryTree([
      category('food'),
      category('tea', 'drinks'),
      category('drinks'),
      category('green-tea', 'tea'),
      category('coffee', 'drinks'),
    ]);
    expect(shape(tree)).toEqual([
      ['food', []],
      [
        'drinks',
        [
          ['tea', [['green-tea', []]]],
          ['coffee', []],
        ],
      ],
    ]);
  });

  it('leaves out a category whose parent is not in the list', () => {
    expect(shape(categoryTree([category('food'), category('tea', 'drinks')]))).toEqual([
      ['food', []],
    ]);
  });

  it('ends on a loop in the data', () => {
    const tree = categoryTree([category('food'), category('a', 'b'), category('b', 'a')]);
    expect(shape(tree)).toEqual([['food', []]]);
  });

  it('answers an empty tree for no categories', () => {
    expect(categoryTree([])).toEqual([]);
  });
});

describe('categoryPath', () => {
  const categories = [
    category('drinks'),
    category('tea', 'drinks'),
    category('green-tea', 'tea'),
    category('food'),
  ];

  it('lists the categories above one, top first, and the one itself last', () => {
    expect(categoryPath(categories, 'green-tea')).toEqual(['drinks', 'tea', 'green-tea']);
  });

  it('is the category alone for a top category', () => {
    expect(categoryPath(categories, 'food')).toEqual(['food']);
  });

  it('is empty for no slug or one no category has', () => {
    expect(categoryPath(categories, null)).toEqual([]);
    expect(categoryPath(categories, 'all')).toEqual([]);
  });

  it('ends on a loop in the data', () => {
    expect(categoryPath([category('a', 'b'), category('b', 'a')], 'a')).toEqual(['b', 'a']);
  });
});
```

`shape()` turns a tree into nested ids, so a failing test prints the whole shape on one screen instead of a deep object.
The mock has only two levels, so these tests use their own three-level list (`drinks → tea → green-tea`).

### `src/components/CategoryTreeList.astro`

```
---
import { ArrowDown01Icon, ArrowRight01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

import type { CategoryNode } from '../lib/category-tree';
import { listingPath } from '../lib/listing-query';
import type { ShopLocale } from '../lib/locale';

// Step 26d.4: one level of the category drawer's tree, as <li> rows; the caller gives the <ul>. A
// category with children draws the next level inside its own <li> by calling this component again
// (Astro.self), so the tree can be as deep as the shop's.
// Each row is a link to the category's list and, when it has children, a separate button that
// shows or hides them. Two controls, not one: a tap on "Cosmetics" should open the Cosmetics list,
// and the shopper still needs a way to reach "Skin care" without leaving the page.
interface Props {
  nodes: CategoryNode[];
  locale: ShopLocale;
  // The slug of the list on screen, or null. Its row is marked
  current: string | null;
  // The ids of the groups that start open: the list on screen and the ones above it
  open: string[];
  // 0 for the top categories. Sets the weight: top categories are 600, the rest 400
  depth: number;
  // Makes the ids of the child lists unique on the page ("category-drawer-1-0")
  idPrefix: string;
}

const { nodes, locale, current, open, depth, idPrefix } = Astro.props;
const { t } = locale;

const row =
  'flex min-h-12 flex-1 items-center justify-between gap-3 rounded-lg px-3 py-3 transition-colors duration-150 hover:bg-cream aria-[current]:bg-cream';
---

{nodes.map(({ category, children }, index) => {
  const id = `${idPrefix}-${String(index)}`;
  const isCurrent = category.slug === current;
  const isOpen = open.includes(category.id);
  return (
    <li>
      <div class="flex items-center gap-1">
        <a
          href={listingPath(category.slug, null)}
          aria-current={isCurrent ? 'page' : undefined}
          class:list={[row, depth === 0 ? 'font-semibold' : 'aria-[current]:font-semibold']}
        >
          {category.name}
          {isCurrent && (
            <HugeiconsIcon icon={Tick02Icon} size={16} strokeWidth={1.5} aria-hidden="true" />
          )}
        </a>
        {children.length > 0 && (
          // The label stays the same open or shut: aria-expanded says which, and a screen
          // reader reads both ("Show the categories in Cosmetics, expanded")
          <button
            type="button"
            data-toggle
            aria-expanded={isOpen ? 'true' : 'false'}
            aria-controls={id}
            aria-label={t('shop.drawer.toggle', { category: category.name })}
            class="group/toggle grid size-12 shrink-0 place-items-center rounded-lg transition-colors duration-150 hover:bg-cream"
          >
            {/* Two icons, one shown: the storefront moves colors only, never turns a shape */}
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              size={20}
              strokeWidth={1.5}
              className="group-aria-expanded/toggle:hidden"
              aria-hidden="true"
            />
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={20}
              strokeWidth={1.5}
              className="hidden group-aria-expanded/toggle:block"
              aria-hidden="true"
            />
          </button>
        )}
      </div>
      {children.length > 0 && (
        // 16px in per level, under the parent's text. `hidden` is the state the script flips
        <ul id={id} hidden={!isOpen} class="pb-2 pl-4">
          <Astro.self
            nodes={children}
            locale={locale}
            current={current}
            open={open}
            depth={depth + 1}
            idPrefix={id}
          />
        </ul>
      )}
    </li>
  );
})}
```

- **It draws only `<li>` rows; the caller gives the `<ul>`.** The drawer puts "All Products" in the same top list, so
  the top rows and "All Products" share one list and one set of rules.
- **`Astro.self` draws the next level.** A component may call itself. Each call gets `depth + 1`, so the tree can be as
  deep as the shop's, like the chip menus (26d.3).
- **The links are `listingPath(slug, null)`, a fresh list.** The drawer is a way to move around the shop, not a filter
  on the list on screen. A search or a price filter from the old list would be a surprise on the new one.
- **The button's label never changes.** `aria-expanded` says open or shut, and a screen reader reads both ("Show the
  categories in Cosmetics, expanded"). A label that changed to "Hide…" would say the state twice.
- **`aria-controls` names the child list by its place** (`category-drawer-1-0`), not by the category's id. An id from
  the database may hold characters that are not safe in an HTML id, and two drawers would never share these.
- **Two icons, one shown by CSS.** `group-aria-expanded/toggle:` shows `ArrowDown01` when the group is open and
  `ArrowRight01` when it is shut. The storefront's transitions change colors only, so the arrow does not turn.
- **The current row is `cream` with a `Tick02` icon**, like the current line in a chip menu (decision 25). A top row
  is already bold, so a child row also gets bold when it is current.
- **`hidden={!isOpen}`** is the state the server starts with; the script flips the same attribute.

### `src/components/CategoryDrawer.astro`

```
---
import { Cancel01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ShopCategory } from '@omnivo/contracts';

import { categoryPath, categoryTree } from '../lib/category-tree';
import { ALL_SLUG, listingPath } from '../lib/listing-query';
import type { ShopLocale } from '../lib/locale';
import CategoryTreeList from './CategoryTreeList.astro';

// Step 26d.4 (decision 9): the category drawer, opened by the header's menu button. Not in Figma:
// it is the cart drawer's frame from the left (CLAUDE.md → Storefront screens not in Figma → Cart
// drawer): 420px wide, the whole width on a phone, `overlay` behind it, no slide.
// A native <dialog> in a small custom element, like the cart drawer: showModal() gives the focus
// trap, Escape, the inert page behind and the backdrop. The whole tree is drawn on the server; the
// script only opens, closes and shows or hides a group. One per page, in ShopLayout.
interface Props {
  categories: ShopCategory[];
  locale: ShopLocale;
  // The slug of the list on screen ('all' on /c/all), or null on a page that is not a list
  current: string | null;
}

const { categories, locale, current } = Astro.props;
const { t } = locale;

const tree = categoryTree(categories);
// The list on screen is in view when the drawer opens: its group and every one above it start open
const open = categoryPath(categories, current);
const allCurrent = current === ALL_SLUG;
---

<category-drawer>
  {/* The cart drawer's classes with the side swapped: `mr-auto` pins it to the left edge.
      `max-w-none max-h-none`: the browser's own style keeps a modal 2em off every edge */}
  <dialog
    aria-labelledby="category-drawer-title"
    class="m-0 mr-auto h-dvh max-h-none w-full max-w-none border-0 bg-card p-0 text-brand backdrop:bg-overlay md:w-[420px]"
  >
    <div class="flex h-full flex-col">
      <div class="flex items-center justify-between gap-4 border-b border-rule px-5 py-4 md:px-6 md:py-5">
        <h2 id="category-drawer-title" class="text-sf-title font-semibold">
          {t('shop.drawer.title')}
        </h2>
        <button
          type="button"
          data-close
          aria-label={t('shop.drawer.close')}
          class="-mr-2 grid size-10 place-items-center rounded-lg text-muted transition-colors duration-150 hover:bg-canvas hover:text-brand"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={24} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>

      {/* A <nav> named by the title: a screen reader's list of landmarks says "Categories".
          Only this part scrolls; the title and the close button stay */}
      <nav
        aria-labelledby="category-drawer-title"
        class="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] md:px-4"
      >
        {/* A rule between top categories only: the open group's children belong to the row
            above them, so no line cuts them off */}
        <ul class="divide-y divide-rule">
          <li>
            <a
              href={listingPath(null, null)}
              aria-current={allCurrent ? 'page' : undefined}
              class="flex min-h-12 items-center justify-between gap-3 rounded-lg px-3 py-3 font-semibold transition-colors duration-150 hover:bg-cream aria-[current]:bg-cream"
            >
              {t('shop.drawer.all')}
              {allCurrent && (
                <HugeiconsIcon icon={Tick02Icon} size={16} strokeWidth={1.5} aria-hidden="true" />
              )}
            </a>
          </li>
          <CategoryTreeList
            nodes={tree}
            locale={locale}
            current={current}
            open={open}
            depth={0}
            idPrefix="category-drawer"
          />
        </ul>
      </nav>
    </div>
  </dialog>
</category-drawer>

<script>
  class CategoryDrawer extends HTMLElement {
    // Any [data-open-categories] on the page opens the drawer: the header's menu button. One
    // listener on the document, like the cart drawer's
    private readonly onDocumentClick = (event: MouseEvent): void => {
      if (event.target instanceof Element && event.target.closest('[data-open-categories]')) {
        this.dialog?.showModal();
      }
    };

    // Leaving the page by one of its links: the browser may keep this page in its back/forward
    // cache with the drawer open, and Back would then land on an open drawer the shopper is done
    // with. Closing it as the page goes puts Back on the page itself
    private readonly onPageHide = (): void => {
      this.dialog?.close();
    };

    private get dialog(): HTMLDialogElement | null {
      return this.querySelector('dialog');
    }

    connectedCallback(): void {
      const dialog = this.dialog;
      if (!dialog) return;

      document.addEventListener('click', this.onDocumentClick);
      window.addEventListener('pagehide', this.onPageHide);
      for (const button of this.querySelectorAll('[data-close]')) {
        button.addEventListener('click', () => {
          dialog.close();
        });
      }
      dialog.addEventListener('click', (event) => {
        // A click on the dim backdrop lands on the <dialog> itself; a click inside lands on its
        // content, which fills the whole dialog. Escape closes it without a script
        if (event.target === dialog) {
          dialog.close();
          return;
        }
        // A group's show/hide button. The button's aria-expanded and the list's `hidden` change
        // together, so what a screen reader hears is what is on screen
        if (!(event.target instanceof Element)) return;
        const toggle = event.target.closest<HTMLButtonElement>('[data-toggle]');
        const list = document.getElementById(toggle?.getAttribute('aria-controls') ?? '');
        if (!toggle || !list) return;
        const expanded = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        list.hidden = expanded;
      });
    }

    disconnectedCallback(): void {
      document.removeEventListener('click', this.onDocumentClick);
      window.removeEventListener('pagehide', this.onPageHide);
    }
  }

  customElements.define('category-drawer', CategoryDrawer);
</script>
```

- **The dialog's classes are the cart drawer's, with `mr-auto` in place of `ml-auto`**, so it sits on the left edge.
  `max-w-none max-h-none` undo the browser's own style, which keeps a modal dialog 2em away from every edge.
- **The `<nav>` is named by the title**, so a screen reader's list of landmarks says "Categories". Only the `<nav>`
  scrolls; the title and the close button stay at the top of a long tree.
- **`pb-[max(12px,env(safe-area-inset-bottom))]`**: on a phone with a home bar, the last row is not under it.
- **The rules are on the top list only** (`divide-y`). An open group's children belong to the row above them, so no
  line cuts them off.
- **The whole tree is drawn on the server.** The script only opens, closes and shows or hides a group, so it is about
  1 KB. No words go to the script: every label is already in the HTML.
- **The script listens on the document for `[data-open-categories]`**, like the cart drawer for `[data-open-cart]`.
  The header does not need to know the drawer, and a second button later needs only the attribute.
- **`showModal()` gives the focus trap, Escape and the inert page.** The first focusable element, the close button,
  gets the focus, and when the drawer closes the browser puts the focus back on the menu button.
- **A click on the dialog itself is a click on the backdrop.** The content fills the whole dialog, so a click inside
  lands on the content. On a phone the drawer is the whole width and there is no backdrop; the close button, Escape
  and Android's back gesture still close it.
- **One click listener on the dialog for every show/hide button**, not one per button. The button's `aria-expanded`
  and the list's `hidden` change in the same click, so what a screen reader hears is what is on screen.
- **`pagehide` closes the drawer** (decision 34). Both listeners are removed in `disconnectedCallback`.

### `src/components/Header.astro`

```diff
@@ -27,16 +27,28 @@ const { t } = locale;
   data-shop-header
   class="group relative mt-4 grid h-16 grid-cols-[1fr_auto] items-center rounded-2xl bg-brand p-3 md:mt-5 md:h-18 md:grid-cols-[auto_minmax(0,1fr)_auto] md:gap-x-6 md:px-6 md:py-0 lg:grid-cols-[1fr_auto_1fr]"
 >
-  <div class="flex items-center gap-9">
-    {/* Opens the category drawer in step 26c. The phone has no menu (Figma 138:774) */}
+  {/* min-w-0: a long shop name gives way (the wordmark is cut with an ellipsis) instead of
+      pushing the buttons on the right out of the bar */}
+  <div class="flex min-w-0 items-center gap-2 md:gap-9">
+    {/* Step 26d.4: opens the category drawer (CategoryDrawer.astro listens for
+        data-open-categories). On the phone too, as a 40px white button like the ones on the
+        right: Figma's phone header has no menu, but a header button reaches the drawer from every
+        page (decision 31) */}
     <button
       type="button"
+      data-open-categories
+      aria-haspopup="dialog"
       aria-label={t('shop.header.categories')}
-      class="hidden text-white md:block"
+      class="grid size-10 shrink-0 place-items-center rounded-xl bg-card text-brand md:block md:size-auto md:rounded-none md:bg-transparent md:text-white"
     >
-      <HugeiconsIcon icon={Menu01Icon} size={30} strokeWidth={1.5} aria-hidden="true" />
+      <HugeiconsIcon
+        icon={Menu01Icon}
+        strokeWidth={1.5}
+        className="size-5 md:size-[30px]"
+        aria-hidden="true"
+      />
     </button>
-    <a href="/" aria-label={t('shop.header.home', { shop: shop.name })}>
+    <a href="/" aria-label={t('shop.header.home', { shop: shop.name })} class="min-w-0">
       <Logo shop={shop} place="header" />
     </a>
   </div>
```

- **The button shows on every screen size** (decision 31). On a phone it has the look of the three buttons on the
  right (40px, `card`, radius 12, a 20px `brand` icon). From `md` it goes back to Figma's 30px white icon with no box.
- **`data-open-categories`** is what the drawer's script looks for. **`aria-haspopup="dialog"`** tells a screen reader
  that the button opens a dialog, like the cart button.
- **`min-w-0` on the left side and on the logo's link.** A flex item does not shrink below its content by default, so
  a long shop name pushed the buttons on the right out of the bar. With `min-w-0` the name gives way instead.

### `src/components/Logo.astro`

```diff
@@ -13,7 +13,14 @@ const { shop, place } = Astro.props;
 const onBrand = place === 'header';
 ---
 
-<span class:list={['inline-flex items-center', onBrand ? 'gap-2 md:gap-1' : 'gap-2 md:gap-[5px]']}>
+{/* Step 26d.4: in the header the name is cut with an ellipsis when the bar runs out of room
+    (max-w-full + min-w-0 + truncate); the menu button took 48px of a phone's bar */}
+<span
+  class:list={[
+    'inline-flex max-w-full items-center',
+    onBrand ? 'gap-2 md:gap-1' : 'gap-2 md:gap-[5px]',
+  ]}
+>
   {shop.logo ? (
     <img
       src={shop.logo.url}
@@ -44,8 +51,10 @@ const onBrand = place === 'header';
   )}
   <span
     class:list={[
-      'font-bold whitespace-nowrap md:font-semibold',
-      onBrand ? 'text-[20px] text-white md:text-[24px]' : 'text-[24px] text-brand md:text-[32px]',
+      'font-bold md:font-semibold',
+      onBrand
+        ? 'min-w-0 truncate text-[20px] text-white md:text-[24px]'
+        : 'whitespace-nowrap text-[24px] text-brand md:text-[32px]',
     ]}
   >
     {shop.name}
```

In the header, the wordmark is cut with an ellipsis (`truncate`) when the bar runs out of room. The menu button took
48px of a phone's bar, and a tenant's shop name can be long ("Rahman Pharmacy and General Store"). In the footer the
name stays whole (`whitespace-nowrap`, as before): the footer has room, and a cut name there would look like a mistake.

### `src/layouts/ShopLayout.astro`

```diff
@@ -1,9 +1,10 @@
 ---
 import '../styles/shop.css';
 
-import type { PublicShop } from '@omnivo/contracts';
+import type { PublicShop, ShopCategory } from '@omnivo/contracts';
 
 import CartDrawer from '../components/CartDrawer.astro';
+import CategoryDrawer from '../components/CategoryDrawer.astro';
 import Footer from '../components/Footer.astro';
 import Header from '../components/Header.astro';
 import type { ShopLocale } from '../lib/locale';
@@ -16,9 +17,16 @@ interface Props {
   title: string;
   // Step 26d.3: the words of the search on screen, which the header's box shows again
   search?: string | null;
+  // Step 26d.4: every category, for the category drawer. Required, not fetched here: the layout
+  // stays free of the data source, and most pages have the list already (the filter row, the
+  // product's trail). A page that forgets it fails the type check instead of drawing an empty drawer
+  categories: ShopCategory[];
+  // The slug of the list on screen ('all' on /c/all), so the drawer marks it and opens its group.
+  // Left out on a page that is not a category's list
+  currentList?: string | null;
 }
 
-const { shop, locale, title, search = null } = Astro.props;
+const { shop, locale, title, search = null, categories, currentList = null } = Astro.props;
 const { t } = locale;
 
 // The tenant's two theme colors win over the stylesheet's defaults. They are #rrggbb (the contract
@@ -51,6 +59,8 @@ const theme = `--brand: ${shop.theme.brand}; --accent: ${shop.theme.accent}`;
     {/* Step 26b: one drawer for the whole page, outside the layout's box: as a modal dialog it is
         drawn above everything anyway, and the header's cart button opens it */}
     <CartDrawer locale={locale} />
+    {/* Step 26d.4: the same for the category drawer and the header's menu button */}
+    <CategoryDrawer categories={categories} locale={locale} current={currentList} />
 
     <script>
       import { addToCart } from '../lib/cart';
```

- **`categories` is required** (decision 32). **`currentList` is optional**: only a category's list has one.
- The drawer sits next to the cart drawer, outside the page's box. A modal dialog is drawn above everything anyway.

### The pages

```diff
@@ -22,7 +22,12 @@ const { t } = locale;
 const query = readListingQuery(null, new URLSearchParams());
 ---
 
-<ShopLayout shop={shop} locale={locale} title={t('shop.home.title', { shop: shop.name })}>
+<ShopLayout
+  shop={shop}
+  locale={locale}
+  title={t('shop.home.title', { shop: shop.name })}
+  categories={categories}
+>
   <h1 class="sr-only">{shop.name}</h1>
 
   <HeroBanner hero={home.hero} />
```

```diff
@@ -37,6 +37,7 @@ const category = categories.find((candidate) => candidate.id === product.categor
   shop={shop}
   locale={locale}
   title={t('shop.product.title', { name: product.name, shop: shop.name })}
+  categories={categories}
 >
   {/* Figma: 524px gallery + 16px + 740px info card. fr, not px, so the two keep their share
       between lg and xl; below lg they stack */}
```

```diff
@@ -3,6 +3,7 @@ import ListingView from '../../components/ListingView.astro';
 import { shopSource } from '../../data/source';
 import ShopLayout from '../../layouts/ShopLayout.astro';
 import { loadListing } from '../../lib/listing-page';
+import { ALL_SLUG } from '../../lib/listing-query';
 import { shopLocale } from '../../lib/locale';
 
 // Step 26d.3: a category's products, with those of the categories under it (/c/cosmetics), or
@@ -35,6 +36,8 @@ const title =
   locale={locale}
   title={t('shop.listing.pageTitle', { title, shop: shop.name })}
   search={query.q}
+  categories={categories}
+  currentList={query.category ?? ALL_SLUG}
 >
   <ListingView title={title} query={query} page={page} categories={categories} locale={locale} />
 </ShopLayout>
```

```diff
@@ -27,6 +27,7 @@ const title = t('shop.listing.searchTitle', { q: query.q ?? '' });
   locale={locale}
   title={t('shop.listing.pageTitle', { title, shop: shop.name })}
   search={query.q}
+  categories={categories}
 >
   <ListingView title={title} query={query} page={page} categories={categories} locale={locale} />
 </ShopLayout>
```

```diff
@@ -12,7 +12,12 @@ import { shopLocale } from '../lib/locale';
 // the words; the form is a React island (decision 1). The cart is in the shopper's browser, so the
 // server cannot know it: the island is drawn here with "Getting today's prices…" and takes over
 // in the browser (client:load: a checkout is useless until it can price the cart).
-const [shop, settings] = await Promise.all([shopSource.shop(), shopSource.checkoutSettings()]);
+// Step 26d.4: the categories for the header's drawer, asked with the rest
+const [shop, settings, categories] = await Promise.all([
+  shopSource.shop(),
+  shopSource.checkoutSettings(),
+  shopSource.categories(),
+]);
 const locale = await shopLocale(shop.language);
 const { t } = locale;
 const choices = checkoutChoices(locale, settings);
@@ -21,7 +26,12 @@ const choices = checkoutChoices(locale, settings);
 Astro.response.headers.set('Cache-Control', 'no-store');
 ---
 
-<ShopLayout shop={shop} locale={locale} title={t('shop.checkout.pageTitle', { shop: shop.name })}>
+<ShopLayout
+  shop={shop}
+  locale={locale}
+  title={t('shop.checkout.pageTitle', { shop: shop.name })}
+  categories={categories}
+>
   {/* Only what is serializable goes to an island: Astro writes these props into the HTML as
       JSON for the browser. Words, labels, amounts as strings; never a function like t() */}
   <CheckoutForm
```

```diff
@@ -21,7 +21,8 @@ const wait = token === null ? null : await shopSource.codeWait(token);
 // and their cart is still there (decision 23)
 if (wait === null) return Astro.redirect('/checkout');
 
-const shop = await shopSource.shop();
+// Step 26d.4: the categories for the header's drawer
+const [shop, categories] = await Promise.all([shopSource.shop(), shopSource.categories()]);
 const locale = await shopLocale(shop.language);
 const { t } = locale;
 const numbers = numberLocale(locale.language);
@@ -52,7 +53,12 @@ const textLink =
   'font-semibold text-brand underline-offset-3 transition-colors duration-150 not-aria-disabled:hover:underline aria-disabled:cursor-not-allowed aria-disabled:text-muted';
 ---
 
-<ShopLayout shop={shop} locale={locale} title={t('shop.verify.pageTitle', { shop: shop.name })}>
+<ShopLayout
+  shop={shop}
+  locale={locale}
+  title={t('shop.verify.pageTitle', { shop: shop.name })}
+  categories={categories}
+>
   <verify-code
     data-length={SHOP_CODE_LENGTH}
     data-number-locale={numbers}
```

```diff
@@ -20,7 +20,8 @@ const order = token === undefined ? null : await shopSource.order(orderNo, token
 // same "page not found" for each, so the page never tells a stranger that an order exists
 if (order === null) return Astro.rewrite('/404');
 
-const shop = await shopSource.shop();
+// Step 26d.4: the categories for the header's drawer
+const [shop, categories] = await Promise.all([shopSource.shop(), shopSource.categories()]);
 const locale = await shopLocale(shop.language);
 const { t, money } = locale;
 const when = (iso: string) => formatDateTime(new Date(iso), locale.language, shop.timeZone);
@@ -44,6 +45,7 @@ const heading = 'font-semibold';
   shop={shop}
   locale={locale}
   title={t('shop.order.pageTitle', { orderNo: order.orderNo, shop: shop.name })}
+  categories={categories}
 >
   {/* The checkout card at 848px, read-only (CLAUDE.md), 160px above the footer like the checkout */}
   <div class="mx-auto mt-4 max-w-[848px] rounded-2xl bg-card-glass p-1 md:mt-9 md:mb-40">
```

- **The home page, the product page and the two lists already had the categories**, so they only pass them on.
- **The checkout, the phone code and the order page ask for them** in the same `Promise.all` as the shop, so the page
  waits for one round trip, not two. The phone code and the order page ask only after their own check: a shopper with
  no order waiting is redirected before anything else is asked.
- **`currentList={query.category ?? ALL_SLUG}`** on `/c/<slug>`: `/c/all` has no category in its query, and `all` marks
  "All Products". The search page passes nothing: a search is not one of the drawer's rows.

### Check this part

```sh
pnpm --filter @omnivo/shop typecheck        # astro check: 0 errors
pnpm --filter @omnivo/shop test             # 160 tests
pnpm exec eslint apps/shop/src
pnpm exec prettier --check apps/shop/src
pnpm --filter @omnivo/shop build
```

Then run the built shop (`HOST=127.0.0.1 PORT=4399 node apps/shop/dist/server/entry.mjs`) and check at 1440, 900 and
390px:

- On `/c/skin-care`, the menu button opens the drawer: 420px on the left (the whole width at 390px), the focus on the
  close button, Cosmetics open, "Skin care" marked, the other groups shut.
- The Food arrow shows "Diabetic care" and turns down; its `aria-expanded` is `true`.
- Escape, the close button and (from 768px) a click on the dim page close it, and the focus goes back to the menu
  button.
- "Hair care" in the drawer opens `/c/hair-care`; Back shows `/c/skin-care` with the drawer shut.
- On `/checkout` nothing is marked and every group is shut; on `/c/all`, "All Products" is marked.
- At 390px, with the shop's name made long ("Rahman Pharmacy and General Store Uttara"), the name ends in "…", the
  account button stays inside the bar, and the page does not scroll sideways.

Broken on purpose while this part was written, and caught:

- `categories` left out on the checkout page: the type check fails ("Property 'categories' is missing").
- `categoryPath` with `<=` in place of `<`: "ends on a loop in the data" fails.
- The header without `min-w-0`: with the long name, the account button ends at 660px on a 390px screen, and the page
  scrolls sideways.

The drawer's script (open, close, show/hide, `pagehide`) is checked only by hand until 26e's Playwright tests.

## 26d.5 — Doc updates

After you implement this (ask me and I can do these). Only `CLAUDE.md` changes: the build plan's step 26 is ticked
only when step 26's API is done, and the system design already says that the shop's product and category pages are drawn on the server (§14.2).

**CLAUDE.md:**

1. In "App UI design system" → "Content and formatting" → **Language**, after "(the type check fails if `bn.ts` is
   missing a key).", add: "The storefront's words (`shop.*`) live apart, in `packages/i18n/src/locales/shop/en.ts`
   and `bn.ts`, behind the `@omnivo/i18n/shop` entry that only `apps/shop` imports: the ERP app never loads them, and
   `t('shop.…')` does not type-check there. `errors.shop_*` stay in `en.ts` and `bn.ts` with the other error codes."
2. In "Storefront design system", the first paragraph: replace "the cart icon, the logo," with "the cart icon, the
   logo, the menu button on the phone, the "All Categories" and "Offer" chips without a chevron,".
3. In "What still applies from the rest of this file", replace "`t()` (keys under `shop.*`)" with "`t()` (keys under
   `shop.*`, from `@omnivo/i18n/shop`)".
4. In **Header**, replace "radius 16, padding 12px, no menu button. Left the logo (24px mark, wordmark 20px/700 white,
   8px apart);" with "radius 16, padding 12px. Left a 40px `card` menu button (radius 12, 20px `brand` `Menu01`; not
   in Figma, it reaches the category drawer from every page), 8px later the logo (24px mark, wordmark 20px/700
   white, 8px apart; a long shop name ends in "…");".
5. In **Filter row**, replace "The chips are the shop's top categories (a chevron opens their sub-categories),
   "Offer" (listings on sale) and "All Filter" (price and in stock);" with: "The first chip, "All Categories", is a
   link to `/c/all` with no chevron (Figma draws one). Then the shop's top categories: one with sub-categories has a
   chevron and opens a menu ("All of Cosmetics", then its sub-categories, 16px more indent per level); one without is
   a link with no chevron. "Offer" (listings on sale) is a switch with no chevron (Figma draws one). "All Filter"
   opens a 320px panel (20px padding): "Price (৳)" with From and To side by side (48px inputs, whole taka), "In stock
   only", then Clear (`cream`) and Apply (`accent`), 44px, radius 4. "Sort By" opens a menu: Newest (the default),
   Price: low to high, Price: high to low, Name: A to Z. A chip whose filter is on is filled like the selected chip,
   and its name says "on" to a screen reader. The menus and the panel are native popovers under their chip (CSS
   anchor positioning; without it the browser centers them): `card`, 1px `rule`, radius 8, 8px padding, no shadow;
   a line is 16px `brand`, radius 4, hover `cream`, and the current one is 600 with a 16px `Tick02`. Every choice
   is in the address (`?sort=price_asc&min=100&max=500&stock=1&offer=1`), so a link keeps it;"
6. In **Load More**, after "…and the button is disabled.", add: "20 cards a page. Without JavaScript it is a link to
   the next page (`?cursor=…`). With it, a script fetches the next cards from the list's partial (`/c/<slug>/more`,
   `/search/more`) and adds them under the others; the focus stays on the button and a live region says "20 more
   products". On the last page the button goes and the focus moves to the first new card."
7. In "Storefront screens not in Figma", replace the **Category and search** bullet with: "**Category and search
   (`/c/[slug]`, `/search`):** the home page's "All Category" block alone, 36px under the header (16px on a phone):
   the title as the page's `h1` in the section title's style (the category's name, "All Products" on `/c/all`, or
   `Results for "neem"`), 36px down the filter row, 36px down the grid (3, 4 and 5 columns; one card a row on a
   phone), Load More. A category shows the listings of its sub-categories too. Search looks in the name, the SKU and
   the category names, in English or Bangla, in any case; an empty search goes to `/c/all`. An empty list shows the
   empty state for its reason: a filter is on (`FilterRemove`, "Clear the filters"), a search found nothing
   (`Search01`, "See all products"), or the category has nothing yet (`ShoppingBasket01`)."
8. In **Empty state**, replace "Used for empty cart (`ShoppingCart01`), no results (`Search01`)," with "Used for empty
   cart (`ShoppingCart01`), no results (`Search01`), no listing for the filters (`FilterRemove`), an empty category
   (`ShoppingBasket01`),".
9. After the **Cart drawer** bullet, add: "**Category drawer:** opens from the header's menu button, from the left,
   420px wide (full width on phones), `card`, with `overlay` behind it and no blur. A native `<dialog>` like the cart
   drawer: the focus stays inside, Escape and a click on the backdrop close it, the focus goes back to the menu
   button, and it closes when the page is left. The header: "Categories" `sf-title` `brand` and a close icon button,
   a 1px `rule` line under it. Then "All Products" and the top categories as rows at least 48px high (16px/600
   `brand`, radius 8, hover `cream`, 1px `rule` lines between the top rows); a category with sub-categories has a
   48px show/hide button (`ArrowRight01` shut, `ArrowDown01` open, `aria-expanded`), and its list is indented 16px.
   The name is a link, the button only shows and hides. The list on screen is marked (`cream` row, `Tick02`,
   `aria-current`), and its group starts open."

---

## 26d.6 — Run it and check it

```bash
pnpm install
pnpm --filter @omnivo/contracts build && pnpm --filter @omnivo/i18n build   # the shop reads their dist/
pnpm --filter @omnivo/shop typecheck      # astro check: 0 errors, 0 warnings, 0 hints
pnpm --filter @omnivo/shop test           # 160 tests in 16 files
pnpm --filter @omnivo/shop build
pnpm --filter @omnivo/shop start          # node dist/server/entry.mjs, http://localhost:4321
```

Then, for the whole repo (the step changed two shared packages and the ERP app's words):

```bash
pnpm dedupe --check
pnpm build
pnpm lint
pnpm format
pnpm typecheck
pnpm test                 # 1,156: contracts 465 + app 210 + shop 160 + api 156 + sync 118 + ui 22 + i18n 17 + auth 8
pnpm boundaries
pnpm test:bundle-size     # the ERP app's first load 231.7 KB gz (budget 235): the shop's words are gone from it
pnpm test:openapi         # up to date: the storefront schemas are not in the ERP's API
```

On a laptop with 8 GB, run them one at a time and add `--concurrency=2` to the turbo ones: `build`, `typecheck` and
`test` together ran out of memory here.

### What you should see

At 1440px wide:

- [ ] `/c/all`: "All Products" 36px under the header, the filter row, then 20 cards in four rows of five, the same
      sizes as the home page's "All Category" block (243×458 cards), and Load More 48px under them.
- [ ] Load More: "Loading" and the spinning icon for a moment, then 40 cards and the button stays. Twice more: 62
      cards, none twice, the button goes, and the focus is on the 61st card's name.
- [ ] The Cosmetics chip: a white menu under it, "All of Cosmetics", then Skin care and Hair care, indented. Escape
      shuts it. "Skin care" opens `/c/skin-care` (10 cards) with the Cosmetics chip filled and "Skin care" ticked.
- [ ] Sort By → "Price: low to high": the address gets `?sort=price_asc`, ৳85 comes first, and the menu ends at the
      chip's right edge.
- [ ] All Filter, To `300` (or `৩০০`), Apply: 9 cards, All Filter filled. "Offer" fills and shows only listings on
      sale; a second click turns it off.
- [ ] `/search?q=neem` (or `নিম`, or `NEEM`): "Results for "neem"" and the neem cards. `/search?q=zzzz`: "Nothing
      matches "zzzz"" and "See all products". `/search?q=` goes to `/c/all`; `/c/nope` is page not found.
- [ ] The header's menu button: the drawer from the left, the focus on its close button. On `/c/skin-care`,
      Cosmetics is open and "Skin care" is marked. Escape, the close button or a click on the dim page shuts it.
- [ ] Back after a link in the drawer or a menu shows the page before it, with the drawer shut.

At 390px wide: the menu button before the logo; "All Products", the category pills, one card a row; no All Filter
or Sort By; the drawer covers the screen; nothing scrolls sideways. With JavaScript turned off, the menus still open,
Load More opens the next page and the filter form still filters. With `language: 'bn'` in `src/data/mock/shop.ts`,
the pages and the drawer are Bangla.

### Known differences from Figma

- **"All Categories" and "Offer" have no chevron** (decisions 6 and 23): neither opens a menu. A top category with
  nothing under it has none either (decision 24).
- **The phone header has a menu button** before the logo (decision 31). Figma's has none.
- **The menus, the filter panel and the drawer are not in Figma.** They follow decisions 25 and 33 and the storefront's
  flat cards, and `CLAUDE.md` gets their look (26d.5).
- **The category and search pages are not in Figma.** They are the home page's "All Category" block, as `CLAUDE.md`
  says, and measure the same: 36px from the title to the row and from the row to the grid, 243×458 cards at 1440px.

## What comes next

- **26e — the rest of the shop:** `/track` (with the order page's timeline), the text pages (the checkout's terms
  link goes to `/pages/terms`), "page not found" and a closed shop, and the shop's first Playwright tests. The
  scripts this step checked by hand (the popovers, Load More's focus and live region, the drawer) get their tests
  there.
- **Step 26's real place in the plan:** the `storefront` module in the API and `/public/v1`, with `GET
  /public/v1/listings` answering the same `ShopListingQuery` with a keyset cursor; one `ShopSource` that calls the
  API in place of the mock. The pages and the addresses stay as they are now.
