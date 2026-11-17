import type { ShopTextPageSlug, StorefrontSection } from '@omnivo/contracts';

import { mockCheckoutSettings } from '../src/data/mock/checkout';
import { mockShop } from '../src/data/mock/shop';
import { shopMoney } from '../src/lib/money';

// Step 26h: the words the seed types into the editors. They are the mock's (products.ts and
// pages.ts), written the way the tenant writes them: sections of a heading and a text box, with
// "- " lists, "1. " numbered lists, **bold** and [links](/track) (renderSections). The mock's own
// HTML cannot be sent: the API takes no HTML from a tenant (decision 6 of 26g), and makes it.
// Two small differences from the mock follow from that: the hotline is plain text, not a tel:
// link (a section's link is https:// or a path of the shop), and "&amp;" is typed as "&" (the API
// escapes what is typed).

const NEEM = 'Himalaya Purifying Neem Face Wash';

// By the listing's slug. Only the design product has a description; every other product page
// leaves out its Overview card, as in the mock
export const DESCRIPTIONS: Readonly<Record<string, StorefrontSection[]>> = {
  'himalaya-purifying-neem-face-wash-150ml': [
    {
      heading: NEEM,
      body: `Refresh and purify your skin every day with ${NEEM}. Enriched with the natural goodness of Neem & Turmeric, this soap-free face wash effectively removes impurities, controls excess oil, and helps prevent pimples while maintaining your skin's natural moisture.`,
    },
    {
      heading: 'Specifications',
      body: [
        '- **Product Type:** Face Wash',
        '- **Brand:** Himalaya',
        '- **Skin Type:** Suitable for all skin types (Best for Normal, Oily & Pimple-Prone Skin)',
        '- **Category:** Daily Facial Cleanser',
        '- **Formula:** Soap-Free Herbal Cleanser',
      ].join('\n'),
    },
    {
      heading: 'Key Benefits',
      body: [
        '- Deeply cleanses dirt, impurities, and excess oil',
        '- Helps prevent pimples and future breakouts',
        '- Controls excess oil without drying the skin',
        "- Maintains the skin's natural moisture balance",
        '- Removes dead skin cells for a fresh, healthy glow',
        '- Soothes irritated skin with the goodness of Turmeric',
        '- Leaves skin clean, refreshed, and soft after every wash',
      ].join('\n'),
    },
    {
      heading: 'Main Ingredients',
      body: [
        '- **Neem:** Naturally antibacterial and antifungal, helps purify skin, fight acne-causing bacteria, and reduce blemishes.',
        '- **Turmeric:** Known for its anti-inflammatory and antiseptic properties that soothe the skin and promote an even-looking complexion.',
      ].join('\n'),
    },
    {
      heading: `Why Choose ${NEEM}?`,
      body: [
        '- Soap-free formula for gentle daily cleansing',
        '- Dermatologically tested',
        '- Free from Parabens, SLS/SLES, Phthalates, Artificial Colors & Artificial Fragrances',
        '- 100% Cruelty-Free skincare',
        '- Suitable for daily morning and evening use',
      ].join('\n'),
    },
    {
      heading: 'How to Use',
      body: [
        '1. Moisten your face with water.',
        `2. Apply a small amount of ${NEEM}.`,
        '3. Gently massage using circular motions until it forms a rich lather.',
        '4. Rinse thoroughly with water.',
        '5. Pat your face dry with a clean towel.',
        '6. For best results, use twice daily.',
      ].join('\n'),
    },
    {
      heading: 'Product Details',
      body: `${NEEM} is a herbal, soap-free facial cleanser specially formulated to keep your skin clean, fresh, and healthy. Its unique blend of Neem and Turmeric effectively removes excess oil, dirt, and impurities while helping prevent acne and pimple breakouts. Unlike ordinary cleansers, it deeply purifies the skin without stripping away its essential moisture, making it ideal for everyday use. The gentle formula keeps your skin feeling refreshed, soft, and naturally healthy after every wash.`,
    },
  ],
};

// "Inside Dhaka: 1 to 2 days, ৳80." from the checkout's zones, like the mock's terms, so the
// terms say what the checkout charges. shopMoney, as the shop writes money ("৳1,000")
function zoneLine(name: string, days: string): string {
  const zone = mockCheckoutSettings.zones.find((candidate) => candidate.name === name);
  if (zone === undefined) throw new Error(`no zone ${name}`);
  return `- **${zone.name}:** ${days}, ${shopMoney(zone.charge, 'en')}.`;
}
const freeFrom = shopMoney(mockCheckoutSettings.freeDeliveryFrom, 'en');

// The footer's four pages, all written, in the footer's order
export const PAGES: Readonly<Record<ShopTextPageSlug, StorefrontSection[]>> = {
  privacy: [
    {
      heading: 'What we keep',
      body: 'When you order, we keep your name, your mobile number, your delivery address and what you bought. We need them to deliver the order and to call you if the rider cannot find the address.',
    },
    {
      heading: 'What we use it for',
      body: [
        '- To deliver your order and to send you SMS about it: the code that confirms it, and the link that tracks it.',
        '- To give the courier the name, number and address the parcel needs. The courier gets nothing else.',
        '- To answer you when you call the hotline about an order.',
        '',
        'We do not sell your details, and we do not send you offers by SMS unless you ask for them.',
      ].join('\n'),
    },
    {
      heading: 'Cookies',
      body: 'The shop keeps your cart in your browser. Two small cookies remember the order you are confirming and the orders this browser placed, so you can open them again. They hold no name, number or address.',
    },
    {
      heading: 'Tracking links',
      body: 'The link in the SMS shows where your parcel is. Anyone you forward it to can see that page, so it shows no address and no phone number.',
    },
  ],
  terms: [
    {
      heading: 'Orders',
      body: 'An order is placed when you confirm it with the code we send to your mobile number, or when you pay with Mobile Banking. Prices are the ones on the checkout page when you confirm.',
    },
    {
      heading: 'Delivery',
      body: [
        zoneLine('Inside Dhaka', '1 to 2 days'),
        zoneLine('Outside Dhaka', '2 to 4 days'),
        `- Delivery is free on orders over ${freeFrom}.`,
        '',
        'With Cash on Delivery, please keep the amount ready for the rider. You may check the parcel before you pay.',
      ].join('\n'),
    },
    {
      heading: 'Returns',
      body: 'If an item arrives damaged, expired or is not what you ordered, tell the rider or call us within 3 days. We replace it or give the money back. Opened food and personal care items cannot be returned for any other reason.',
    },
    {
      heading: 'Cancelling an order',
      body: 'Call the hotline before the parcel leaves the shop. Once it is with the courier, you can refuse it at the door instead.',
    },
  ],
  about: [
    {
      heading: `About ${mockShop.name}`,
      body: `${mockShop.name} is an online shop in Dhaka for everyday groceries, tea and coffee, personal care and diabetic food. We buy from the brands' own distributors, so every pack is genuine and inside its expiry date.`,
    },
    {
      heading: 'How we work',
      body: [
        '- Orders placed before 4 pm are packed the same day.',
        '- Every parcel goes with a courier that lets you follow it from our shop to your door.',
        '- Cash on Delivery everywhere in Bangladesh.',
      ].join('\n'),
    },
  ],
  contact: [
    {
      heading: 'Call or visit us',
      body: [
        `- **Hotline:** ${mockShop.hotline}, Saturday to Thursday, 10 am to 8 pm`,
        `- **Address:** ${mockShop.address}`,
      ].join('\n'),
    },
    {
      heading: 'About an order',
      body: 'Keep the order number from the SMS ready (it starts with W-). To see where a parcel is, open the link in the SMS, or use [Track Order](/track) with the number and your mobile number.',
    },
  ],
};
