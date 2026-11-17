import {
  ArrowLeft01Icon,
  Delete02Icon,
  Files01Icon,
  MoreHorizontalIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  routes,
  saveStorefrontPageInputSchema,
  type SaveStorefrontPageInput,
  SHOP_TEXT_PAGES,
  type ShopTextPageSlug,
  type StorefrontPage,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  FormAlert,
  IconButton,
  PageHeader,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';

import { DocumentNotice } from '../components/document-notice';
import {
  PageStatusPill,
  SaveBar,
  ShopLine,
  StorefrontOffline,
  useStorefrontRefresh,
  ViewShopLink,
} from '../components/storefront-parts';
import { SectionsCard } from '../components/storefront-sections';
import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import { storefrontSetupQuery } from '../lib/storefront';
import { pageFormValues, storefrontPageQuery } from '../lib/storefront-appearance';
import { useOnline } from '../lib/use-online';
import { useTenantId } from '../lib/workspace';

// Step 26h: one text page's editor (decision 5): its sections in the listing's section editor, and
// one PUT that writes or changes it. Saving the first section puts the page in the footer; Delete
// takes it out, and the shop answers "page not found" for its address again.

const FORM_ID = 'storefront-page';

function PageEditor({ page }: { page: StorefrontPage }) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const refresh = useStorefrontRefresh();
  const [deleting, setDeleting] = useState(false);
  const name = t(`storefront.pages.names.${page.slug}`);
  const written = page.version !== null;

  const {
    control,
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm({
    resolver: zodResolver(saveStorefrontPageInputSchema, { error: contractErrorMap }),
    defaultValues: pageFormValues(page),
  });
  const sections = useFieldArray({ control, name: 'sections' });
  const values = useWatch({ control, name: 'sections' });

  const onSubmit = handleSubmit(async (body: SaveStorefrontPageInput) => {
    try {
      const next = await call(routes.storefrontAppearance.savePage, {
        params: { slug: page.slug },
        body,
      });
      queryClient.setQueryData(storefrontPageQuery(tenantId, page.slug).queryKey, next);
      reset(pageFormValues(next));
      toast(
        written ? t('storefront.page.saved', { name }) : t('storefront.page.created', { name }),
      );
      await refresh();
    } catch (error) {
      applyApiError(error, ['sections'], setError);
    }
  });

  const remove = useMutation({
    mutationFn: (version: number) =>
      call(routes.storefrontAppearance.deletePage, {
        params: { slug: page.slug },
        query: { version },
      }),
    onSuccess: async () => {
      toast(t('storefront.page.deleted', { name }));
      await refresh();
      void navigate({ to: '/storefront/pages' });
    },
  });

  return (
    <div className="grid max-w-[880px] grid-cols-1 gap-5">
      <div className="grid gap-2.5">
        <Link
          to="/storefront/pages"
          className="inline-flex items-center gap-1 justify-self-start text-body-sm font-medium text-brand underline-offset-3 hover:underline"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
          {t('storefront.page.back')}
        </Link>
        <PageHeader
          title={name}
          description={
            <>
              <span className="mb-1.5 flex">
                <PageStatusPill written={written} />
              </span>
              {t(`storefront.pages.hints.${page.slug}`)}
              {written && <ShopLine />}
            </>
          }
          actions={
            written && (
              <>
                <ViewShopLink href={page.shopUrl} label={t('storefront.page.viewPage')} />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton
                      icon={MoreHorizontalIcon}
                      label={t('storefront.listing.moreActions')}
                      className="size-[42px] rounded-control border border-line-strong bg-surface shadow-sm"
                    />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      icon={Delete02Icon}
                      onSelect={() => {
                        setDeleting(true);
                      }}
                    >
                      {t('storefront.page.delete')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )
          }
        />
      </div>
      {!written && (
        <DocumentNotice tone="neutral">{t('storefront.page.notWrittenNotice')}</DocumentNotice>
      )}

      <form
        id={FORM_ID}
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid min-w-0 gap-5"
      >
        {errors.root?.server?.message !== undefined && (
          <FormAlert message={errors.root.server.message} />
        )}
        <SectionsCard
          title={t('storefront.page.sectionsTitle')}
          subtitle={t('storefront.page.sectionsHint')}
          headingPlaceholder={t('storefront.page.headingPlaceholder')}
          bodyPlaceholder={t('storefront.page.bodyPlaceholder')}
          emptyText={t('storefront.page.noSections')}
          previewCaption={t('storefront.page.previewCaption')}
          rows={sections.fields.map((field, index) => ({
            key: field.id,
            heading: values[index]?.heading ?? '',
            body: values[index]?.body ?? '',
          }))}
          field={(index, part) => register(rowPath('sections', index, part))}
          error={(index, part) => errors.sections?.[index]?.[part]?.message}
          listError={errors.sections?.root?.message ?? errors.sections?.message}
          onAdd={() => {
            sections.append({ heading: '', body: '' });
          }}
          onRemove={sections.remove}
          onSwap={sections.swap}
        />
        {/* A page not written yet shows its buttons once it has a section to save */}
        {isDirty && (
          <SaveBar
            formId={FORM_ID}
            saving={isSubmitting}
            onDiscard={() => {
              reset();
            }}
          />
        )}
      </form>

      {page.version !== null && (
        <Dialog open={deleting} onOpenChange={setDeleting}>
          <DialogContent
            title={t('storefront.page.confirmDelete', { name })}
            footer={
              <>
                <DialogClose asChild>
                  <Button variant="secondary">{t('common.cancel')}</Button>
                </DialogClose>
                <Button
                  disabled={remove.isPending}
                  onClick={() => {
                    if (page.version !== null) remove.mutate(page.version);
                  }}
                >
                  {t('storefront.page.delete')}
                </Button>
              </>
            }
          >
            {remove.error && (
              <FormAlert
                message={
                  remove.error instanceof ApiRequestError ? remove.error.code : 'unknown_error'
                }
              />
            )}
            <p className="text-body-sm text-ink-2">{t('storefront.page.deleteBody')}</p>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function isPageSlug(value: string): value is ShopTextPageSlug {
  return SHOP_TEXT_PAGES.some((slug) => slug === value);
}

export function StorefrontPagePage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const online = useOnline();
  const navigate = useNavigate();
  const { slug = '' } = useParams({ strict: false });
  // Only the four pages have an editor: any other address is "not found", without a request
  const known = isPageSlug(slug) ? slug : null;
  const setup = useQuery({ ...storefrontSetupQuery(tenantId), enabled: online });
  const shop = setup.data?.shop ?? null;
  const page = useQuery({
    ...storefrontPageQuery(tenantId, known ?? 'privacy'),
    enabled: online && shop !== null && known !== null,
  });

  if (!online) return <StorefrontOffline />;
  if (known === null) {
    return <p className="text-body-sm text-crit">{t('errors.not_found')}</p>;
  }
  if (setup.isError || page.isError) {
    return <p className="text-body-sm text-crit">{t('storefront.page.loadFailed')}</p>;
  }
  if (setup.data && shop === null) {
    return (
      <EmptyState
        icon={Files01Icon}
        title={t('storefront.pages.notSetUpTitle')}
        description={t('storefront.pages.notSetUpBody')}
        action={
          <Button
            onClick={() => {
              void navigate({ to: '/storefront/settings' });
            }}
          >
            {t('storefront.pages.goToSettings')}
          </Button>
        }
      />
    );
  }
  if (!page.data) return null;
  // key: another page starts its own form. Not the version: a read in the background must never
  // wipe what the person is typing (the save's own answer resets the form)
  return <PageEditor key={page.data.slug} page={page.data} />;
}
