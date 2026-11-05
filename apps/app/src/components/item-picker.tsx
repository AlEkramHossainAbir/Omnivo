import {
  PackageSearchIcon,
  PlusSignIcon,
  Search01Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { StockItem } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, DialogContent, EmptyState, Input, Pill } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { stockSearchQuery } from '../lib/queries';
import { useDebounced } from '../lib/use-debounced';
import { useQuantity, useTenantId, VariantCell } from './stock-parts';

// "Add items": search or scan, then one click per line. The dialog stays open, so a store keeper
// scans carton after carton without reaching for the mouse; Enter adds the only match (a scanner
// ends a barcode with Enter). The stock shown is the form's warehouse's.
export function ItemPicker({
  warehouseId,
  // A line that brings stock in cannot be an archived product (the API refuses it): those show,
  // but cannot be added
  allowArchived,
  onAdd,
}: {
  warehouseId: string;
  allowArchived: boolean;
  onAdd: (item: StockItem) => void;
}) {
  const { t } = useLocale();
  const quantity = useQuantity();
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim(), 250);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const { data: items, isFetching } = useQuery(
    stockSearchQuery(useTenantId(), settled, warehouseId),
  );

  const add = (item: StockItem) => {
    onAdd(item);
    setAdded((before) => new Set(before).add(item.variantId));
  };
  const usable = (item: StockItem) => allowArchived || !item.archived;

  return (
    <DialogContent
      title={t('stockLines.pickerTitle')}
      description={t('stockLines.pickerDescription')}
    >
      <div className="grid grid-cols-1 gap-4">
        <Input
          type="search"
          icon={Search01Icon}
          aria-label={t('stockLines.pickerSearch')}
          placeholder={t('stock.searchPlaceholder')}
          autoFocus
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            // Only when the list is the answer to what is in the box now, and it is one item
            const [only, ...rest] = items ?? [];
            if (
              settled === search.trim() &&
              !isFetching &&
              only &&
              rest.length === 0 &&
              usable(only)
            ) {
              add(only);
              setSearch('');
            }
          }}
        />
        {items?.length === 0 ? (
          <EmptyState
            icon={PackageSearchIcon}
            title={t('stockLines.pickerEmpty')}
            description={t('stock.noMatchBody')}
          />
        ) : (
          <ul className="grid max-h-[min(420px,55dvh)] grid-cols-1 gap-px overflow-y-auto">
            {items?.map((item) => (
              <li
                key={item.variantId}
                className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-subtle"
              >
                <span className="min-w-0 flex-1">
                  <VariantCell item={item} />
                  <span className="text-caption text-ink-3 tabular-nums">
                    {t('stockLines.inStock', { quantity: quantity(item.onHand, item.baseUnitId) })}
                  </span>
                </span>
                {item.archived && (
                  <Pill tone="neutral" icon={PackageSearchIcon}>
                    {t('stockLines.archived')}
                  </Pill>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!usable(item)}
                  onClick={() => {
                    add(item);
                  }}
                >
                  <HugeiconsIcon
                    icon={added.has(item.variantId) ? Tick02Icon : PlusSignIcon}
                    size={16}
                    strokeWidth={1.5}
                  />
                  {added.has(item.variantId) ? t('stockLines.added') : t('stockLines.add')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </DialogContent>
  );
}
