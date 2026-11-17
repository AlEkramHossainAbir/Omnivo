import {
  STOREFRONT_IMAGE_MAX_PIXELS,
  STOREFRONT_IMAGE_MIN_SIDE,
  type STOREFRONT_IMAGE_FAILURES,
} from '@omnivo/contracts';
import sharp, { type Metadata } from 'sharp';

import {
  STOREFRONT_IMAGE_SIZE_NAMES,
  STOREFRONT_IMAGE_SIZES,
  type StorefrontImageSize,
} from './media.js';

// Step 26g: the image job's work, without the queue, the database or the storage, so a unit test
// can feed it real pictures. One uploaded photo in, the shop's three WebP files out (26f's
// media.ts names them), or the reason the photo cannot be used.

export type StorefrontImageFailure = (typeof STOREFRONT_IMAGE_FAILURES)[number];

export interface ShopImageFile {
  size: StorefrontImageSize;
  body: Buffer;
}

export type MadeShopImages =
  | { ok: true; width: number; height: number; files: ShopImageFile[] }
  | { ok: false; code: StorefrontImageFailure };

// The formats the upload allows (ATTACHMENT_RULES.storefront_image). The browser's content type is
// only what it said: the bytes decide. libvips also reads SVG, HEIF, TIFF, GIF and PDF, and a file
// named photo.png can be any of them; anything but these three is refused as unreadable
const FORMATS: ReadonlySet<string> = new Set(['jpeg', 'png', 'webp']);

// WebP at 80 is about a third of a JPEG at the same look; effort 4 (sharp's default) is the
// balance of time and size, and a photo is made once
const WEBP = { quality: 80, effort: 4 } as const;

// The worker runs for days and makes photos now and then: libvips' cache would keep each
// decoded photo in memory for nothing
sharp.cache(false);

export async function makeShopImages(original: Uint8Array): Promise<MadeShopImages> {
  // The header only: metadata() does not decode the pixels, so a "decompression bomb" (a small
  // file that unpacks to gigapixels) is measured here before anything is unpacked
  let meta: Metadata;
  try {
    meta = await sharp(original).metadata();
  } catch {
    return { ok: false, code: 'storefront_image_unreadable' };
  }
  if (!FORMATS.has(meta.format)) {
    return { ok: false, code: 'storefront_image_unreadable' };
  }
  // autoOrient: the size after the EXIF turn. A phone's portrait photo is stored on its side
  // (4032 × 3024) with a "turn me" note; a shopper sees it 3024 × 4032
  const { width, height } = meta.autoOrient;
  if (width * height > STOREFRONT_IMAGE_MAX_PIXELS) {
    return { ok: false, code: 'storefront_image_too_many_pixels' };
  }
  if (Math.min(width, height) < STOREFRONT_IMAGE_MIN_SIDE) {
    return { ok: false, code: 'storefront_image_too_small' };
  }

  try {
    // limitInputPixels again, as a second lock: the check above read the header, and a file whose
    // pixels disagree with its header must still not unpack past the limit. rotate() with no
    // angle turns the photo the way its EXIF says; each size is a clone that keeps both settings
    const upright = sharp(original, { limitInputPixels: STOREFRONT_IMAGE_MAX_PIXELS }).rotate();
    const files = await Promise.all(
      STOREFRONT_IMAGE_SIZE_NAMES.map(async (size) => ({
        size,
        // withoutEnlargement: a 1,000px photo stays 1,000px in "large" and "wide". Blown up it
        // would only be blurred and heavier. No metadata call: sharp drops EXIF (the phone's GPS
        // position too), XMP and IPTC unless asked to keep them, and turns the colours into sRGB
        body: await upright
          .clone()
          .resize({ width: STOREFRONT_IMAGE_SIZES[size], withoutEnlargement: true })
          .webp(WEBP)
          .toBuffer(),
      })),
    );
    return { ok: true, width, height, files };
  } catch {
    // A header that reads but pixels that do not (a cut-off upload, a broken JPEG)
    return { ok: false, code: 'storefront_image_unreadable' };
  }
}
