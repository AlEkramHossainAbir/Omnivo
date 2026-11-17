import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { makeShopImages } from './image-files.js';

// Real pictures made by sharp itself, so the test needs no fixture files
function photo(width: number, height: number, format: 'jpeg' | 'png' | 'webp' = 'jpeg') {
  return sharp({
    create: { width, height, channels: 3, background: { r: 0, g: 88, b: 89 } },
  }).toFormat(format);
}

describe('makeShopImages', () => {
  it('makes the three sizes as WebP, never wider than the photo', async () => {
    const made = await makeShopImages(await photo(1600, 1200).toBuffer());
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect({ width: made.width, height: made.height }).toEqual({ width: 1600, height: 1200 });
    const sizes = await Promise.all(
      made.files.map(async (file) => {
        const meta = await sharp(file.body).metadata();
        return [file.size, meta.format, meta.width, meta.height];
      }),
    );
    // small 480, large 1200, and "wide" stays 1600: never blown up
    expect(sizes).toEqual([
      ['small', 'webp', 480, 360],
      ['large', 'webp', 1200, 900],
      ['wide', 'webp', 1600, 1200],
    ]);
  });

  it('turns a phone photo upright from its EXIF note, and drops the EXIF', async () => {
    // Stored 800 × 400 with orientation 6 ("turn 90° clockwise"): a shopper sees 400 × 800
    const sideways = await photo(800, 400)
      .withMetadata({ orientation: 6, exif: { IFD0: { Make: 'Phone', Copyright: 'Rahim' } } })
      .toBuffer();
    const made = await makeShopImages(sideways);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect({ width: made.width, height: made.height }).toEqual({ width: 400, height: 800 });
    const small = made.files.find((file) => file.size === 'small');
    if (!small) throw new Error('no small file');
    const meta = await sharp(small.body).metadata();
    expect([meta.width, meta.height]).toEqual([400, 800]);
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });

  it('takes PNG and WebP too', async () => {
    for (const format of ['png', 'webp'] as const) {
      const made = await makeShopImages(await photo(300, 300, format).toBuffer());
      expect(made.ok, format).toBe(true);
    }
  });

  it('refuses a side under 200px, after the turn', async () => {
    expect(await makeShopImages(await photo(1000, 199).toBuffer())).toEqual({
      ok: false,
      code: 'storefront_image_too_small',
    });
    const edge = await makeShopImages(await photo(200, 200).toBuffer());
    expect(edge.ok).toBe(true);
  });

  it('refuses more than 40 megapixels from the header, before it decodes', async () => {
    // 8,000 × 5,001 = 40,008,000 pixels: one row over. PNG of one colour, so the file is small
    const big = await photo(8000, 5001, 'png').png({ compressionLevel: 9 }).toBuffer();
    expect(await makeShopImages(big)).toEqual({
      ok: false,
      code: 'storefront_image_too_many_pixels',
    });
  });

  it('refuses what is not a JPEG, PNG or WebP, whatever it was called', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400"/></svg>',
    );
    const gif = await photo(300, 300).gif().toBuffer();
    for (const file of [svg, gif, Buffer.from('%PDF-1.7 not a photo'), Buffer.alloc(0)]) {
      expect(await makeShopImages(file)).toEqual({
        ok: false,
        code: 'storefront_image_unreadable',
      });
    }
  });

  it('refuses a JPEG cut off halfway (the header reads, the pixels do not)', async () => {
    const whole = await photo(1200, 900).jpeg({ quality: 95 }).toBuffer();
    const made = await makeShopImages(whole.subarray(0, Math.floor(whole.length / 2)));
    expect(made).toEqual({ ok: false, code: 'storefront_image_unreadable' });
  });
});
