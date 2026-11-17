import {
  Add01Icon,
  Image01Icon,
  Menu01Icon,
  Search01Icon,
  ShoppingCart01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';
import { type CSSProperties, type RefObject, useLayoutEffect, useRef, useState } from 'react';

import { useShopMoney } from './storefront-parts';

// Step 26h: small drawings of the shop, from what the form holds this moment: the header, a chip
// and two product cards for the logo and the colors, and the hero at its two sizes. They draw the
// shop, not the app, so they use the shop's own look (apps/shop, CLAUDE.md → Storefront design
// system): the tenant's colors come from the form, and the shop's fixed colors are copied below.
// Every drawing is aria-hidden: the form's boxes and the contrast lines say the same in words.

// The shop's fixed tokens (apps/shop/src/styles/shop.css) that the drawings need. Not the app's
// tokens on purpose: the preview must look like the shop in both of the app's themes
const SHOP = {
  canvas: '#f6f7f7',
  card: '#ffffff',
  muted: '#707070',
  price: '#a70b1e',
  onBrandLine: 'rgb(255 255 255 / .15)',
} as const;

// Figma's hero panel ("Rectangle 4"), the same path as apps/shop's HeroBanner.astro
const HERO_PANEL =
  'M0 0L438.603 0C456.754 0 473.93 8.21725 485.32 22.3505L571.108 128.801C588.994 150.994 593.72 181.028 583.515 207.643L555.769 280H0V0Z';

// The Omnivo mark in the shop's header: the accent color on the brand bar (CLAUDE.md → Logo)
function ShopMark({ color }: { color: string }) {
  return (
    <span className="relative size-6 shrink-0">
      <span
        className="absolute top-0 left-0 size-[15px] rounded-[4px]"
        style={{ background: color }}
      />
      <span
        className="absolute right-0 bottom-0 size-[15px] rounded-[4px] border-2"
        style={{ borderColor: color }}
      />
    </span>
  );
}

export interface PreviewProduct {
  id: string;
  name: string;
  packSize: string;
  price: string | null;
  imageUrl: string | null;
}

export function ThemePreview({
  brand,
  accent,
  logoUrl,
  name,
  products,
}: {
  brand: string;
  accent: string;
  logoUrl: string | null;
  name: string;
  // Up to two of the shop's own listings; with none the cards are shapes only
  products: readonly PreviewProduct[];
}) {
  const { t } = useLocale();
  const money = useShopMoney();
  const cards: (PreviewProduct | null)[] =
    products.length > 0 ? products.slice(0, 2) : [null, null];
  return (
    <div className="grid min-w-0 gap-2">
      <span className="text-caption text-ink-3">{t('storefront.appearance.theme.preview')}</span>
      <div
        aria-hidden="true"
        className="grid min-w-0 gap-3 rounded-control border border-line p-3 tracking-[-0.02em]"
        style={{ background: SHOP.canvas }}
      >
        <div
          className="flex h-12 min-w-0 items-center gap-2 rounded-control px-2.5 text-white"
          style={{ background: brand }}
        >
          <HugeiconsIcon icon={Menu01Icon} size={18} strokeWidth={1.5} className="shrink-0" />
          {logoUrl === null ? (
            <ShopMark color={accent} />
          ) : (
            <img src={logoUrl} alt="" className="size-6 shrink-0 rounded-md object-contain" />
          )}
          <span className="truncate text-body-sm font-semibold">{name}</span>
          <span
            className="ml-auto flex h-7 min-w-0 max-w-38 flex-1 items-center justify-between overflow-hidden rounded-full pl-2.5 text-[10.5px] whitespace-nowrap"
            style={{ background: SHOP.card, color: SHOP.muted }}
          >
            <span className="truncate">{t('storefront.appearance.theme.previewSearch')}</span>
            <span
              className="mr-[3px] grid h-[22px] w-[30px] shrink-0 place-items-center rounded-full"
              style={{ background: accent, color: brand }}
            >
              <HugeiconsIcon icon={Search01Icon} size={13} strokeWidth={1.5} />
            </span>
          </span>
          <span
            className="grid size-7 shrink-0 place-items-center rounded-lg border"
            style={{ borderColor: SHOP.onBrandLine }}
          >
            <HugeiconsIcon icon={ShoppingCart01Icon} size={15} strokeWidth={1.5} />
          </span>
        </div>
        <div className="flex gap-2">
          <span
            className="inline-flex h-6.5 items-center rounded-md px-2.5 text-caption"
            style={{ background: brand, color: accent }}
          >
            {t('storefront.appearance.theme.previewChip')}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          {cards.map((product, index) => (
            <div
              key={product?.id ?? index}
              className="grid content-start gap-1 rounded-lg p-2.5 text-center"
              style={{ background: SHOP.card }}
            >
              {product?.imageUrl ? (
                <img
                  src={product.imageUrl}
                  alt=""
                  className="h-24 w-full object-contain mix-blend-multiply"
                />
              ) : (
                <span
                  className="grid h-24 place-items-center rounded-md"
                  style={{ background: SHOP.canvas, color: SHOP.muted }}
                >
                  <HugeiconsIcon icon={Image01Icon} size={20} strokeWidth={1.5} />
                </span>
              )}
              {product ? (
                <>
                  <span
                    className="line-clamp-2 h-[31px] text-[12.5px] leading-tight font-semibold"
                    style={{ color: brand }}
                  >
                    {product.name}
                  </span>
                  <span className="text-[10.5px] font-semibold" style={{ color: SHOP.muted }}>
                    {product.packSize}
                  </span>
                  <span
                    className="mt-1 text-body font-semibold tabular-nums"
                    style={{ color: SHOP.price }}
                  >
                    {product.price === null ? '' : money(product.price)}
                  </span>
                </>
              ) : (
                // Shapes for a shop with nothing in it yet: the brand color of a name
                <span className="grid justify-items-center gap-1.5 py-1">
                  <span className="h-2 w-4/5 rounded-full" style={{ background: brand }} />
                  <span className="h-2 w-1/2 rounded-full" style={{ background: SHOP.canvas }} />
                </span>
              )}
              <span
                className="mt-1.5 flex h-8 items-center justify-center gap-1 rounded-[4px] text-caption font-semibold"
                style={{ background: accent, color: brand }}
              >
                <HugeiconsIcon icon={Add01Icon} size={15} strokeWidth={1.5} />
                {t('storefront.appearance.theme.previewAddToCart')}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// The box's own width, for a drawing made at the shop's size and scaled down to fit
function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  return [ref, width];
}

export interface HeroLook {
  headline: string;
  line: string;
  eyebrow: string;
  buttonLabel: string;
  backgroundColor: string;
  panelColor: string;
  buttonColor: string;
  buttonTextColor: string;
}

// The desktop hero: drawn at the shop's 1280 × 280 and scaled to the box, so the headline wraps
// where it will wrap in the shop
export function HeroDesktopPreview({
  hero,
  imageUrl,
}: {
  hero: HeroLook;
  imageUrl: string | null;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const scale = width / 1280;
  const inner: CSSProperties = {
    transform: `scale(${String(scale)})`,
    background: hero.backgroundColor,
  };
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="relative overflow-hidden rounded-control border border-line"
      style={{ height: Math.round(280 * scale) }}
    >
      <div
        className="absolute top-0 left-0 h-[280px] w-[1280px] origin-top-left overflow-hidden tracking-[-0.02em]"
        style={inner}
      >
        {imageUrl !== null && (
          <img
            src={imageUrl}
            alt=""
            className="absolute -top-6 right-[47px] h-[313px] w-[522px] object-contain"
          />
        )}
        <svg viewBox="0 0 588.819 280" className="absolute top-0 left-0 h-[280px] w-[589px]">
          <path d={HERO_PANEL} fill={hero.panelColor} />
        </svg>
        <div className="absolute top-1/2 left-[102px] flex w-[360px] -translate-y-1/2 flex-col items-start gap-9">
          <span className="text-[36px] leading-[1.2] font-semibold text-white">
            {hero.headline}
          </span>
          {hero.buttonLabel !== '' && (
            <span
              className="rounded-full px-6 py-4 text-[16px] font-semibold"
              style={{ background: hero.buttonColor, color: hero.buttonTextColor }}
            >
              {hero.buttonLabel}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// The phone hero at the shop's own size (361 × 220 on a 393px phone): the photo under the scrim,
// the tag at the top in the theme's colors, the headline and its line at the bottom
export function HeroPhonePreview({
  hero,
  imageUrl,
  brand,
  accent,
}: {
  hero: HeroLook;
  imageUrl: string | null;
  brand: string;
  accent: string;
}) {
  return (
    <div
      aria-hidden="true"
      className="relative mx-auto h-[220px] w-full max-w-[361px] overflow-hidden rounded-2xl tracking-[-0.02em]"
      style={{ background: hero.backgroundColor }}
    >
      {imageUrl !== null && (
        <img src={imageUrl} alt="" className="absolute inset-0 size-full object-cover" />
      )}
      {/* The shop's hero-scrim, so its white words read on any photo (not a decoration of the app) */}
      <span className="absolute inset-0 bg-linear-to-b from-black/0 to-black/80" />
      <span className="absolute inset-0 flex flex-col items-start justify-between p-5">
        {hero.eyebrow === '' ? (
          <span />
        ) : (
          <span
            className="rounded-full px-3 py-1.5 text-caption leading-none font-bold uppercase"
            style={{ background: accent, color: brand }}
          >
            {hero.eyebrow}
          </span>
        )}
        <span className="grid gap-2">
          <span className="text-[28px] leading-[1.15] font-bold text-white">{hero.headline}</span>
          {hero.line !== '' && <span className="text-body-sm text-white/80">{hero.line}</span>}
        </span>
      </span>
    </div>
  );
}
