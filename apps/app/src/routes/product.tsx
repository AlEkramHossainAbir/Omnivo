import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { isIndustry, trackingDefault } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { lazy, Suspense, useMemo } from 'react';

import { useCan } from '../lib/permissions';
import {
  productCategoriesQuery,
  productFieldsQuery,
  productQuery,
  setupQuery,
  unitsQuery,
} from '../lib/queries';
import { useSession } from '../lib/session-store';

// The page loads the data; the form is a lazy chunk of its own (the form library, the money input
// and the date picker are only needed here)
const ProductForm = lazy(async () => ({
  default: (await import('../components/product-form')).ProductForm,
}));

// What both pages need: the units, the categories, the active custom fields, and the business
// type (a pharma company's new products start with batch tracking)
function useProductData() {
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const units = useQuery(unitsQuery(tenantId)).data;
  const categories = useQuery(productCategoriesQuery(tenantId)).data;
  const allFields = useQuery(productFieldsQuery(tenantId)).data;
  const industry = useQuery(setupQuery(tenantId)).data?.industry ?? null;
  const fields = useMemo(
    () => allFields?.filter((field) => field.archivedAt === null),
    [allFields],
  );
  return {
    tenantId,
    units,
    categories,
    fields,
    defaults: trackingDefault(industry !== null && isIndustry(industry) ? industry : null),
  };
}

export function NewProductPage() {
  const canManage = useCan()('inventory.product.manage');
  const { units, categories, fields, defaults } = useProductData();
  if (!units || !categories || !fields) return null;
  return (
    <Suspense fallback={null}>
      <ProductForm
        product={null}
        units={units}
        categories={categories}
        fields={fields}
        defaults={defaults}
        canManage={canManage}
      />
    </Suspense>
  );
}

export function ProductPage() {
  const { t } = useLocale();
  const { productId = '' } = useParams({ strict: false });
  const canManage = useCan()('inventory.product.manage');
  const { tenantId, units, categories, fields, defaults } = useProductData();
  const { data: product, isError } = useQuery({
    ...productQuery(tenantId, productId),
    enabled: productId !== '',
  });
  if (isError) {
    return (
      <div className="grid max-w-5xl grid-cols-1 gap-5">
        <Link
          to="/products"
          className="text-body-sm font-medium text-brand underline-offset-3 hover:underline"
        >
          ← {t('products.back')}
        </Link>
        <EmptyState
          icon={AlertCircleIcon}
          title={t('products.title')}
          description={t('products.notFound')}
        />
      </div>
    );
  }
  if (!product || !units || !categories || !fields) return null;
  return (
    <Suspense fallback={null}>
      {/* key: a saved product comes back with a new version, and the form starts from it again */}
      <ProductForm
        key={`${product.id}-${String(product.version)}`}
        product={product}
        units={units}
        categories={categories}
        fields={fields}
        defaults={defaults}
        canManage={canManage}
      />
    </Suspense>
  );
}
