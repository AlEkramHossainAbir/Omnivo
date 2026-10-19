import {
  Alert02Icon,
  PackageSearchIcon,
  PlusSignIcon,
  Search01Icon,
  Tick02Icon,
  Wrench01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { Product, ProductSummary } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, DialogContent, EmptyState, Input, Pill } from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { productQuery, productSearchQuery } from '../lib/queries';
import { useDebounced } from '../lib/use-debounced';
import { failureOf } from './journal-parts';
import { useTenantId } from './stock-parts';

// "Add items": search the products and services, then add one. The dialog stays open, so a long
// order is put together without closing it; each click adds the product's lines at once. Moved
// out of sales-line-editor.tsx in step 17a: the requisition's lines (purchase-lines-editor.tsx)
// add items the same way. `words` names the section the texts come from, so each document speaks
// its own language ("Each click adds a line in its selling unit" or "… its buying unit").
export function ProductPicker({
  words,
  description,
  onAdd,
  maxLines,
}: {
  words: 'salesLines' | 'purchaseLines';
  // Step 17b: a purchase order says its lines start at the last price paid, where the
  // requisition's picker says nothing of prices; both speak from purchaseLines
  description?: string | undefined;
  onAdd: (product: Product) => Promise<boolean>;
  maxLines: number;
}) {
  const { t, errorText } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim(), 250);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { data: products } = useQuery(productSearchQuery(tenantId, settled));

  // The list sends a summary; the variants, the packs and the selling unit come with the product
  const add = async (summary: ProductSummary) => {
    setLoading(summary.id);
    setProblem(null);
    try {
      const fits = await onAdd(await queryClient.query(productQuery(tenantId, summary.id)));
      if (fits) setAdded((before) => new Set(before).add(summary.id));
      else setProblem(t(`${words}.tooMany`, { max: maxLines }));
    } catch (error) {
      setProblem(errorText(failureOf(error instanceof Error ? error : null) ?? 'unknown_error'));
    } finally {
      setLoading(null);
    }
  };

  return (
    <DialogContent
      title={t(`${words}.pickerTitle`)}
      description={description ?? t(`${words}.pickerDescription`)}
    >
      <div className="grid grid-cols-1 gap-4">
        <Input
          type="search"
          icon={Search01Icon}
          aria-label={t(`${words}.pickerSearch`)}
          placeholder={t('products.searchPlaceholder')}
          autoFocus
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
        {problem !== null && (
          <p role="status" className="flex items-center gap-1.5 text-label text-crit">
            <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
            {problem}
          </p>
        )}
        {products?.length === 0 ? (
          <EmptyState
            icon={PackageSearchIcon}
            title={t(`${words}.pickerEmpty`)}
            description={t(`${words}.pickerDescription`)}
          />
        ) : (
          <ul className="grid max-h-[min(420px,55dvh)] grid-cols-1 gap-px overflow-y-auto">
            {products?.map((product) => (
              <li
                key={product.id}
                className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-subtle"
              >
                <span className="grid min-w-0 flex-1">
                  <span className="truncate text-body-sm font-medium">{product.name}</span>
                  <span className="truncate text-caption text-ink-3">
                    <span className="font-mono tabular-nums">{product.code}</span>
                    {product.hasVariants &&
                      ` · ${t('products.variantCount', { count: product.variantCount })}`}
                  </span>
                </span>
                {/* A service (a repair, a delivery charge) is bought or sold, never stocked */}
                {product.type === 'service' && (
                  <Pill tone="neutral" icon={Wrench01Icon}>
                    {t(`${words}.service`)}
                  </Pill>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={loading === product.id}
                  onClick={() => void add(product)}
                >
                  <HugeiconsIcon
                    icon={added.has(product.id) ? Tick02Icon : PlusSignIcon}
                    size={16}
                    strokeWidth={1.5}
                  />
                  {added.has(product.id) ? t(`${words}.added`) : t(`${words}.add`)}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </DialogContent>
  );
}
