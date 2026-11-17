import type { ShopImage, StorefrontImage } from '@omnivo/contracts';

// Step 26f: a photo's address. Step 26g's image job writes each uploaded photo as WebP files in
// the storage's public storefront/ folder, one per size, under the photo's id
// (storefront/<id>/<size>.webp). A new photo gets a new id, so a file's content never changes: a
// browser or a CDN may keep it for a year (decision 5).
//
// The sizes, by where they are drawn (CLAUDE.md → Storefront components), about twice the drawn
// width for sharp screens:
// - small: 480px wide. A card's photo (223px), the gallery's thumbnails, a cart line, the logo
// - large: 1200px. The product page's photo (524px) and the phone's banners (up to 393px, 2x–3x)
// - wide: 2560px. The desktop banners (1280px)
// Step 26g's job makes exactly these; a size added here needs it there too.
// Step 26g: the names as a list too, for the job's loop (Object.keys would type them as string).
// satisfies Record: a name in one and not the other does not compile
export const STOREFRONT_IMAGE_SIZE_NAMES = ['small', 'large', 'wide'] as const;
export type StorefrontImageSize = (typeof STOREFRONT_IMAGE_SIZE_NAMES)[number];

export const STOREFRONT_IMAGE_SIZES = {
  small: 480,
  large: 1200,
  wide: 2560,
} as const satisfies Record<StorefrontImageSize, number>;

// Step 26g: the file's key in the storage, which the image job writes and the address reads. The
// id is a uuid (storefrontImageSchema), so it needs no escaping in a path
export function shopImageKey(id: string, size: StorefrontImageSize): string {
  return `storefront/${id}/${size}.webp`;
}

// mediaUrl is the config's storefront.mediaUrl, with no "/" at its end
export function shopImage(
  mediaUrl: string,
  image: StorefrontImage,
  size: StorefrontImageSize,
): ShopImage {
  return { url: `${mediaUrl}/${shopImageKey(image.id, size)}`, alt: image.alt };
}
