import {
  Alert02Icon,
  FolderLibraryIcon,
  Link01Icon,
  Store04Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  STOREFRONT_LINK_KINDS,
  type StorefrontLinkKind,
  storefrontLinkHref,
  storefrontLinkTarget,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Combobox, type ComboboxOption, Field, SelectField, TextField } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { type RefCallback, useMemo, useState } from 'react';

import { storefrontListingSearchQuery } from '../lib/storefront-appearance';
import { storefrontCategoriesQuery } from '../lib/storefront';
import { useDebounced } from '../lib/use-debounced';
import { useTenantId } from '../lib/workspace';
import { useShopMoney } from './storefront-parts';

// Step 26h: "Links to" (decision 4). The table keeps one address (`href`); the picker turns a
// choice into it (storefrontLinkHref) and an address back into a choice (storefrontLinkTarget), so
// a banner a script made still opens here. A category or a product is picked by its slug, the part
// of the address the shop reads.

export interface LinkPickerProps {
  // The form's `href` and its setter (a Controller's field)
  value: string;
  onChange: (href: string) => void;
  error: string | undefined;
  // The Controller's field.ref: react-hook-form focuses the box it is on after a refused save.
  // A callback, so the select, the text box and the product button can each take it
  ref?: RefCallback<HTMLElement>;
}

// The product box: the catalog's search, and the saved product's name found by its slug
function ListingBox({
  slug,
  onChange,
  invalid,
  describedBy,
}: {
  slug: string;
  onChange: (slug: string) => void;
  invalid: boolean;
  describedBy: string | undefined;
}) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const money = useShopMoney();
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim(), 250);
  const matches = useQuery(storefrontListingSearchQuery(tenantId, settled));
  // The saved link's listing: the search matches the slug too, and only an exact slug counts
  const saved = useQuery({
    ...storefrontListingSearchQuery(tenantId, slug),
    enabled: slug !== '',
  });
  const listing = slug === '' ? undefined : saved.data?.find((item) => item.slug === slug);

  const options = useMemo<ComboboxOption[]>(
    () =>
      (matches.data ?? []).map((item) => ({
        value: item.slug,
        label: item.name,
        detail: [
          item.sku,
          item.price === null ? null : money(item.price),
          item.status === 'draft' ? t('storefront.statuses.draft') : null,
        ]
          .filter((part) => part !== null)
          .join(' · '),
      })),
    [matches.data, money, t],
  );

  return (
    <>
      <Combobox
        id="link-listing"
        value={slug}
        // Until the saved listing's name comes back, the slug stands in for it
        selectedLabel={slug === '' ? null : (listing?.name ?? slug)}
        options={options}
        search={search}
        onSearchChange={setSearch}
        onChange={(value) => {
          onChange(value);
        }}
        loading={matches.isFetching}
        icon={Store04Icon}
        invalid={invalid}
        aria-describedby={describedBy}
        placeholder={t('storefront.link.listingPlaceholder')}
        searchPlaceholder={t('storefront.link.searchLabel')}
        emptyText={t('storefront.link.noMatch')}
      />
      {slug !== '' && saved.isSuccess && listing === undefined && <GoneLine />}
      {listing?.status === 'draft' && (
        <p className="text-label text-ink-3">{t('storefront.link.draft')}</p>
      )}
    </>
  );
}

function GoneLine() {
  const { t } = useLocale();
  return (
    <p className="flex items-start gap-1.5 text-label text-warn">
      <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="mt-px shrink-0" />
      {t('storefront.link.gone')}
    </p>
  );
}

export function LinkPicker({ value, onChange, error, ref }: LinkPickerProps) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const categories = useQuery(storefrontCategoriesQuery(tenantId)).data;
  const target = storefrontLinkTarget(value);
  // The select's choice. Mostly what the address says; but "A shop category" with nothing picked
  // yet has no address, and "Another address" may hold "/c/all" while it is typed, so the choice
  // is kept here. It follows the address only when the form changes it (Discard, a reset): an
  // address this picker did not send. Adjusted while rendering, React's way for state that
  // follows a prop (no effect, so no second paint with the old choice)
  const [kind, setKind] = useState<StorefrontLinkKind>(value === '' ? 'category' : target.kind);
  const [sent, setSent] = useState(value);
  if (value !== sent) {
    setSent(value);
    if (value !== '') setKind(target.kind);
  }

  const send = (href: string) => {
    setSent(href);
    onChange(href);
  };

  const pick = (next: StorefrontLinkKind) => {
    setKind(next);
    // Offers and All products are one address each; the others wait for the second box
    if (next === 'offers' || next === 'all') send(storefrontLinkHref({ kind: next }));
    else if (next === 'other') send(target.kind === 'other' ? value : '');
    else send('');
  };

  const slug =
    (kind === 'category' || kind === 'listing') && target.kind === kind ? target.slug : '';
  const categoryOptions = useMemo(
    () => [
      { value: '', label: t('storefront.link.categoryPlaceholder') },
      ...(categories ?? []).map((category) => ({ value: category.slug, label: category.name })),
    ],
    [categories, t],
  );
  const categoryGone =
    kind === 'category' &&
    slug !== '' &&
    categories !== undefined &&
    !categories.some((category) => category.slug === slug);

  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-x-4">
        <SelectField
          id="link-kind"
          label={t('storefront.link.label')}
          icon={Link01Icon}
          options={STOREFRONT_LINK_KINDS.map((item) => ({
            value: item,
            label: t(`storefront.link.kinds.${item}`),
          }))}
          value={kind}
          onChange={(event) => {
            const next = STOREFRONT_LINK_KINDS.find((item) => item === event.target.value);
            if (next !== undefined) pick(next);
          }}
          // The kinds with one address have nowhere else to show an error
          error={kind === 'offers' || kind === 'all' ? error : undefined}
          {...((kind === 'offers' || kind === 'all') && { ref })}
        />
        {kind === 'category' && (
          <SelectField
            id="link-category"
            label={t('storefront.link.category')}
            icon={FolderLibraryIcon}
            // A saved category that is gone is still the select's value, so it is an option
            options={
              categoryGone
                ? [...categoryOptions, { value: slug, label: `/c/${slug}` }]
                : categoryOptions
            }
            value={slug}
            onChange={(event) => {
              send(
                event.target.value === ''
                  ? ''
                  : storefrontLinkHref({ kind: 'category', slug: event.target.value }),
              );
            }}
            error={error}
            ref={ref}
          />
        )}
        {kind === 'listing' && (
          <Field id="link-listing" label={t('storefront.link.listing')} error={error}>
            <ListingBox
              slug={slug}
              onChange={(next) => {
                send(storefrontLinkHref({ kind: 'listing', slug: next }));
              }}
              invalid={error !== undefined}
              // Field's own id for the error line under the box
              describedBy={error === undefined ? undefined : 'link-listing-error'}
            />
          </Field>
        )}
        {kind === 'other' && (
          <TextField
            id="link-href"
            label={t('storefront.link.href')}
            placeholder={t('storefront.link.hrefPlaceholder')}
            hint={t('storefront.link.hrefHint')}
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(event) => {
              send(event.target.value);
            }}
            error={error}
            ref={ref}
          />
        )}
      </div>
      {categoryGone && <GoneLine />}
      {kind !== 'other' && value !== '' && (
        // The whole sentence from t(): in Bangla the address comes before the verb
        <p className="text-label text-ink-3">{t('storefront.link.goesTo', { href: value })}</p>
      )}
    </div>
  );
}
