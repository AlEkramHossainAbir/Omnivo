import type { PublicShop, ShopCategory } from '@omnivo/contracts';

// Step 26a: a made-up shop with the words and colors of the Figma design. Its name is the tenant's
// shop name; the Figma file shows "Omnivo" there, so the mock uses it too.
export const mockShop = {
  name: 'Omnivo',
  logo: null,
  language: 'en',
  theme: { brand: '#005859', accent: '#b8ef69' },
  hotline: '+880 1786 120356',
  timeZone: 'Asia/Dhaka',
  address: 'Amigo 14 Square, House No :59/C-61/C Suite No : B-2, Level-2, Asad Ave, Dhaka 1207.',
  social: {
    facebook: 'https://facebook.com/',
    instagram: 'https://instagram.com/',
    x: 'https://x.com/',
    linkedin: 'https://linkedin.com/',
  },
} satisfies PublicShop;

export const mockCategories = [
  { id: 'cat-food', slug: 'food', name: 'Food', parentId: null },
  { id: 'cat-cosmetics', slug: 'cosmetics', name: 'Cosmetics', parentId: null },
  { id: 'cat-beverages', slug: 'beverages', name: 'Beverages', parentId: null },
  { id: 'cat-household', slug: 'household', name: 'Household', parentId: null },
  { id: 'cat-tea', slug: 'tea', name: 'Tea', parentId: 'cat-beverages' },
  { id: 'cat-diabetic', slug: 'diabetic-care', name: 'Diabetic care', parentId: 'cat-food' },
] satisfies ShopCategory[];
