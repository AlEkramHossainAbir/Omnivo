import { Tag01Icon } from '@hugeicons/core-free-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { contractErrorMap, type PriceList, priceListInputSchema, routes } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DialogClose,
  DialogContent,
  FormAlert,
  TextAreaField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { priceListQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { failureOf } from './journal-parts';

const FIELD_NAMES = priceListInputSchema.keyof().options;

// The name and description of a price list: a new one from the list page, a change (with
// Archive or Restore) from the list's own page. Here, not in a route file: both pages use it, and
// a route file is a lazy chunk of its own.
export function PriceListForm({
  priceList,
  onDone,
}: {
  priceList: PriceList | null;
  onDone: (saved: PriceList) => void;
}) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(priceListInputSchema, { error: contractErrorMap }),
    defaultValues: { name: priceList?.name ?? '', description: priceList?.description ?? '' },
  });

  // The saved list straight into its page's cache, then every price list query refreshed (the
  // list page, and the customer form's select)
  const refresh = async (saved: PriceList) => {
    queryClient.setQueryData(priceListQuery(tenantId, saved.id).queryKey, saved);
    await queryClient.invalidateQueries({ queryKey: ['price-lists', tenantId] });
  };

  const toggle = useMutation({
    mutationFn: (current: PriceList) =>
      call(current.archivedAt === null ? routes.priceLists.archive : routes.priceLists.restore, {
        params: { id: current.id },
        body: { version: current.version },
      }),
    onSuccess: async (saved) => {
      await refresh(saved);
      toast(
        t(saved.archivedAt === null ? 'priceLists.restoredToast' : 'priceLists.archivedToast', {
          name: saved.name,
        }),
      );
      onDone(saved);
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = priceList
        ? await call(routes.priceLists.update, {
            params: { id: priceList.id },
            body: { ...values, version: priceList.version },
          })
        : await call(routes.priceLists.create, { body: values });
      await refresh(saved);
      toast(t(priceList ? 'priceLists.updated' : 'priceLists.created', { name: saved.name }));
      onDone(saved);
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  const failure = errors.root?.server?.message ?? failureOf(toggle.error);

  return (
    <DialogContent
      title={
        priceList ? t('priceLists.editTitle', { name: priceList.name }) : t('priceLists.newTitle')
      }
      footer={
        <>
          {priceList && (
            <Button
              variant="secondary"
              className="mr-auto"
              disabled={toggle.isPending}
              onClick={() => {
                toggle.mutate(priceList);
              }}
            >
              {priceList.archivedAt === null ? t('priceLists.archive') : t('priceLists.restore')}
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="price-list-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : priceList ? t('common.save') : t('priceLists.add')}
          </Button>
        </>
      }
    >
      <form
        id="price-list-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <TextField
          label={t('priceLists.name')}
          icon={Tag01Icon}
          placeholder={t('priceLists.namePlaceholder')}
          {...register('name')}
          error={errors.name?.message}
        />
        <TextAreaField
          label={t('priceLists.about')}
          optional
          placeholder={t('priceLists.aboutPlaceholder')}
          {...register('description')}
          error={errors.description?.message}
        />
      </form>
    </DialogContent>
  );
}
