import type { ShopTextPage, ShopTextPageSlug } from '@omnivo/contracts';

import { shopMoney } from '../../lib/money';
import { mockCheckoutSettings } from './checkout';
import { mockShop } from './shop';

// Step 26e: the footer's four pages, as the ERP will send them (shopTextPageSchema): a <section>
// per block, each with an <h2>, like a product description (products.ts), so the description's
// prose style (shop-prose) draws them. The words are a small Dhaka shop's, with the mock's own
// delivery charges and hotline, so the pages agree with the checkout.

// "+880 1786 120356" → "+8801786120356" for a tel: link, which must have no spaces
const hotlineDigits = mockShop.hotline.replace(/\s/g, '');

// "Inside Dhaka: 1 to 2 days, ৳80." from the checkout's own zones, so a charge changed there changes
// the terms too. In English, the mock shop's language (mockShop.language)
function zoneLine(id: string, days: string): string {
  const zone = mockCheckoutSettings.zones.find((candidate) => candidate.id === id);
  if (!zone) throw new Error(`no zone ${id}`);
  return `<li><strong>${zone.name}:</strong> ${days}, ${shopMoney(zone.charge, 'en')}.</li>`;
}
const freeFrom = shopMoney(mockCheckoutSettings.freeDeliveryFrom, 'en');

const PRIVACY = `<section>
<h2>What we keep</h2>
<p>When you order, we keep your name, your mobile number, your delivery address and what you bought. We need them to deliver the order and to call you if the rider cannot find the address.</p>
</section>
<section>
<h2>What we use it for</h2>
<ul>
<li>To deliver your order and to send you SMS about it: the code that confirms it, and the link that tracks it.</li>
<li>To give the courier the name, number and address the parcel needs. The courier gets nothing else.</li>
<li>To answer you when you call the hotline about an order.</li>
</ul>
<p>We do not sell your details, and we do not send you offers by SMS unless you ask for them.</p>
</section>
<section>
<h2>Cookies</h2>
<p>The shop keeps your cart in your browser. Two small cookies remember the order you are confirming and the orders this browser placed, so you can open them again. They hold no name, number or address.</p>
</section>
<section>
<h2>Tracking links</h2>
<p>The link in the SMS shows where your parcel is. Anyone you forward it to can see that page, so it shows no address and no phone number.</p>
</section>`;

const TERMS = `<section>
<h2>Orders</h2>
<p>An order is placed when you confirm it with the code we send to your mobile number, or when your online payment arrives. Prices are the ones on the checkout page when you confirm.</p>
</section>
<section>
<h2>Delivery</h2>
<ul>
${zoneLine('inside_dhaka', '1 to 2 days')}
${zoneLine('outside_dhaka', '2 to 4 days')}
<li>Delivery is free on orders over ${freeFrom}.</li>
</ul>
<p>With Cash on Delivery, please keep the amount ready for the rider. You may check the parcel before you pay.</p>
</section>
<section>
<h2>Returns</h2>
<p>If an item arrives damaged, expired or is not what you ordered, tell the rider or call us within 3 days. We replace it or give the money back. Opened food and personal care items cannot be returned for any other reason.</p>
</section>
<section>
<h2>Cancelling an order</h2>
<p>Call the hotline before the parcel leaves the shop. Once it is with the courier, you can refuse it at the door instead.</p>
</section>`;

const ABOUT = `<section>
<h2>About ${mockShop.name}</h2>
<p>${mockShop.name} is an online shop in Dhaka for everyday groceries, tea and coffee, personal care and diabetic food. We buy from the brands' own distributors, so every pack is genuine and inside its expiry date.</p>
</section>
<section>
<h2>How we work</h2>
<ul>
<li>Orders placed before 4 pm are packed the same day.</li>
<li>Every parcel goes with a courier that lets you follow it from our shop to your door.</li>
<li>Cash on Delivery everywhere in Bangladesh.</li>
</ul>
</section>`;

const CONTACT = `<section>
<h2>Call or visit us</h2>
<ul>
<li><strong>Hotline:</strong> <a href="tel:${hotlineDigits}">${mockShop.hotline}</a>, Saturday to Thursday, 10 am to 8 pm</li>
<li><strong>Address:</strong> ${mockShop.address}</li>
</ul>
</section>
<section>
<h2>About an order</h2>
<p>Keep the order number from the SMS ready (it starts with W-). To see where a parcel is, open the link in the SMS, or use Track Order with the number and your mobile number.</p>
</section>`;

// Partial: a real shop may not have written every page, and the source answers null for one it has
// not (ShopSource.textPage). The mock has all four, so every footer link opens a page
export const mockTextPages: Partial<Record<ShopTextPageSlug, ShopTextPage>> = {
  privacy: { slug: 'privacy', html: PRIVACY, updatedAt: '2026-11-01T10:00:00+06:00' },
  terms: { slug: 'terms', html: TERMS, updatedAt: '2026-11-01T10:00:00+06:00' },
  // No date: the page shows none (shopTextPageSchema → updatedAt)
  about: { slug: 'about', html: ABOUT, updatedAt: null },
  contact: { slug: 'contact', html: CONTACT, updatedAt: '2026-10-20T12:00:00+06:00' },
};
