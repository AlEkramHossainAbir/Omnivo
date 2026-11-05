import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  plainQuantity,
  reorderLevelInputSchema,
  routes,
  type StockCard,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, DialogClose, DialogContent, FormAlert, TextField, toast } from '@omnivo/ui';
import { useForm } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useStockRefresh, useWarehouses, warehouseLabel } from './stock-parts';

const LEVEL_FIELDS = reorderLevelInputSchema.keyof().options;

// When to order more of this variant in one warehouse. Both boxes empty = no level.
export function ReorderLevelForm({
  card,
  warehouseId,
  onDone,
}: {
  card: StockCard;
  warehouseId: string;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const refresh = useStockRefresh();
  const { byId } = useWarehouses();
  const place = card.warehouses.find((row) => row.warehouseId === warehouseId);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(reorderLevelInputSchema, { error: contractErrorMap }),
    defaultValues: {
      warehouseId,
      variantId: card.item.variantId,
      minQuantity: place?.minQuantity === null || !place ? '' : plainQuantity(place.minQuantity),
      reorderQuantity:
        place?.reorderQuantity === null || !place ? '' : plainQuantity(place.reorderQuantity),
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.stock.setReorderLevel, { body: values });
      await refresh();
      toast(t(saved.minQuantity === null ? 'stock.levelCleared' : 'stock.levelSaved'));
      onDone();
    } catch (error) {
      applyApiError(error, LEVEL_FIELDS, setError);
    }
  });

  const name = warehouseLabel(byId.get(warehouseId));
  return (
    <DialogContent
      title={t('stock.levelTitle', { warehouse: name })}
      description={t('stock.levelDescription')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="level-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <form
        id="level-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5 sm:grid-cols-2 sm:gap-x-4"
      >
        {errors.root?.server?.message && (
          <div className="sm:col-span-2">
            <FormAlert message={errors.root.server.message} />
          </div>
        )}
        <TextField
          label={t('stock.minQuantity')}
          inputMode="decimal"
          autoComplete="off"
          align="end"
          {...register('minQuantity')}
          error={errors.minQuantity?.message}
        />
        <TextField
          label={t('stock.reorderQuantity')}
          optional
          inputMode="decimal"
          autoComplete="off"
          align="end"
          {...register('reorderQuantity')}
          error={errors.reorderQuantity?.message}
        />
      </form>
    </DialogContent>
  );
}
