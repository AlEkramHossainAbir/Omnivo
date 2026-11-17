import { shopImageSchema } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { shopImage } from './media.js';

const PHOTO = { id: '0b6f8f6e-6a3c-4a49-9d4e-2f1c7b9a5e10', alt: 'Neem face wash, 150ml tube' };

describe('shopImage', () => {
  it('points at the size under the photo id in the public folder', () => {
    expect(shopImage('https://files.omnivosoft.com/omnivo', PHOTO, 'small')).toEqual({
      url: 'https://files.omnivosoft.com/omnivo/storefront/0b6f8f6e-6a3c-4a49-9d4e-2f1c7b9a5e10/small.webp',
      alt: 'Neem face wash, 150ml tube',
    });
  });

  it('makes addresses the contract takes, in dev and in production', () => {
    for (const base of ['http://localhost:9000/omnivo', 'https://media.omnivo.shop']) {
      expect(shopImageSchema.safeParse(shopImage(base, PHOTO, 'wide')).success).toBe(true);
    }
  });
});
