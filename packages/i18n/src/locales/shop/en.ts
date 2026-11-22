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
    // Step 27c: a percent coupon with a most it takes off ("10%, up to ৳200")
    couponAppliedUpTo: '{{code}} applied: {{off}} off, up to {{upTo}}',
    payment: 'Payment Method',
    cod: 'Cash on Delivery',
    // Step 27d (decision 9): SSLCommerz's page takes cards and internet banking too
    online: 'Pay online',
    // Under the two cards while Pay online is picked
    onlineHint: 'You pay on SSLCommerz’s page with bKash, Nagad, a card or internet banking.',
    // Three parts, because the link sits inside the sentence and Bangla puts it first
    termsBefore: 'I agree with the ',
    termsLink: 'Terms and Conditions',
    termsAfter: '',
    confirm: 'Confirm Order',
    placing: 'Placing the order…',
    // Step 27d: the button's words while an online order goes to the payment page
    openingPayment: 'Opening the payment page…',
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
    // Step 27d: how a placed order was paid. An online order is confirmed only once it is paid
    paymentMethods: { cod: 'Cash on Delivery', online: 'Paid online' },
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
  // Step 27d: /checkout/paid, where the gateway sends the shopper back (found by the order's
  // cookie). Paid opens the "Order Confirmed" dialog (`confirmed`); these are the other states
  paid: {
    pageTitle: 'Payment | {{shop}}',
    checkingTitle: 'Checking your payment',
    checkingText:
      'SSLCommerz is telling us about your payment. This page looks again by itself in a few seconds.',
    // Without a script the page cannot look again by itself, so it has a link to itself
    checkAgain: 'Check again',
    // The unpaid state's title and line, by why the last try did not pay (SHOP_PAYMENT_PROBLEMS)
    titles: {
      failed: 'The payment did not go through',
      cancelled: 'The payment was cancelled',
      not_opened: 'The payment page did not open',
      not_finished: 'The payment is not finished',
    },
    texts: {
      failed: 'SSLCommerz says your bank or wallet refused the payment.',
      cancelled: 'You cancelled on the payment page, so nothing was paid.',
      not_opened: 'SSLCommerz did not answer just now, so nothing was paid.',
      not_finished:
        'SSLCommerz has no payment for this order yet. If its page is still open in another tab, finish there.',
    },
    // total = the order's total, which never changes on this page
    kept: 'Your order for {{total}} is still here, and its items are set aside for you.',
    triesLeft_one: 'You can try {{count}} more time.',
    triesLeft_other: 'You can try {{count}} more times.',
    noTriesLeft: 'You have used all three tries to pay online.',
    tryAgain: 'Try again',
    opening: 'Opening the payment page…',
    // Decision 3: the order becomes cash on delivery and gets its phone code
    payOnDelivery: 'Pay on delivery instead',
    payOnDeliveryHint: 'We send a code to your phone, and you pay the rider in cash.',
    sendingCode: 'Sending the code…',
    // Nothing left to press: no tries, and the shop does not take cash on delivery now
    startAgain: 'Back to checkout',
    // No answer from the server: the press may not have reached it
    failed: 'That did not reach the shop. Check the connection, then try again.',
  },
  // Step 27d: the fake gateway's page (SHOP_FAKE_GATEWAY_PATH) in development, CI and the demo
  // shop (decision 8). It stands where SSLCommerz's page stands, so it says plainly what it is
  fakeGateway: {
    pageTitle: 'Test payment | {{shop}}',
    title: 'Test payment',
    notice: 'This is a test page, not SSLCommerz. No money moves, whichever button you press.',
    amount: 'Amount',
    tranId: 'Transaction',
    pay: 'Pay {{amount}}',
    fail: 'Fail the payment',
    cancel: 'Cancel the payment',
  },
  // Step 26e: tracking. The /track form, and the view it shares with a tracking link (/t/<token>)
  track: {
    title: 'Track Order',
    pageTitle: 'Track order | {{shop}}',
    // The browser tab of a tracking link: the number, then the shop
    linkPageTitle: 'Order {{orderNo}} | {{shop}}',
    intro: 'Type the mobile number you ordered with and the order number from the SMS.',
    phone: 'Mobile Number',
    phonePlaceholder: '01786 120356',
    orderNo: 'Order Number',
    orderNoPlaceholder: 'W-000123',
    submit: 'Track Order',
    another: 'Track another order',
    // Only in the mock shop, which sends no SMS: its demo orders, to try the form and the links
    mockOrders: 'Test shop: no SMS is sent. Try one of these orders.',
    // "W-000123 with 01786 120356"
    mockOrder: '{{orderNo}} with {{phone}}',
    mockLink: 'Tracking link of {{orderNo}}',
    items_one: '{{count}} item',
    items_other: '{{count}} items',
    total: 'Total',
    // Cash on Delivery, until it is delivered: what to keep ready for the rider
    payOnDelivery: 'Keep {{amount}} ready in cash for the rider.',
    paidOnline: 'Paid online.',
    parcel: 'Parcel',
    // "Steadfast · SFR2611120042"
    courierLine: '{{courier}} · {{code}}',
    openCourier: 'See it on the {{courier}} site',
    noParcel:
      'The shop has not handed the parcel to a courier yet. Its way shows here once it has.',
    // The second parcel, when the shop booked the order again with another courier
    earlierParcel: 'Earlier parcel',
    // A tracking link is a key: anyone who has it sees this page
    linkPrivate:
      'Anyone with this link can see this page. It shows no address and no phone number.',
    linkGoneTitle: 'This tracking link does not work',
    linkGoneText:
      'Check that the whole link was copied, or track the order with its number and your phone.',
    linkGoneAction: 'Track with the number',
    shipmentStatuses: {
      booked: 'Booked with the courier',
      picked_up: 'Picked up',
      in_transit: 'Moving between hubs',
      out_for_delivery: 'Out for delivery',
      delivered: 'Delivered',
      partly_delivered: 'Partly delivered',
      on_hold: 'Could not deliver: they will try again',
      returning: 'Going back to the shop',
      returned: 'Back at the shop',
      cancelled: 'Booking cancelled',
    },
    couriers: {
      pathao: 'Pathao',
      steadfast: 'Steadfast',
      redx: 'RedX',
      ecourier: 'eCourier',
      paperfly: 'Paperfly',
    },
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
  // Step 26e: the footer's text pages (/pages/<slug>). Their titles are the footer's own words
  pages: {
    pageTitle: '{{title}} | {{shop}}',
    updatedOn: 'Last updated {{date}}',
  },
  // Step 26e: any address the shop has no page for
  notFound: {
    pageTitle: 'Page not found | {{shop}}',
    title: 'Page not found',
    text: 'The link may have a typo, or the page has moved. Start again from the home page.',
    action: 'Go to the home page',
  },
  // Step 26f.5: an address that is no launched shop (a typo in the subdomain, or a shop not open
  // yet). No shop's name, colors or menu: there is no shop to take them from
  noShop: {
    pageTitle: 'No shop here',
    title: 'No shop has this address',
    text: 'Check the address for a typo. A shop that is still being set up opens here once it is launched.',
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
