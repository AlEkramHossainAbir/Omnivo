import {
  FolderTreeIcon,
  PlusSignIcon,
  Search01Icon,
  UnfoldLessIcon,
  UnfoldMoreIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  createProductCategoryInputSchema,
  type ProductCategory,
  routes,
  updateProductCategoryInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  cn,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  filterTree,
  FormAlert,
  IconButton,
  Input,
  PageHeader,
  SelectField,
  TextField,
  toast,
  TreeList,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';

import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { categoryOptions, categoryTree } from '../lib/products';
import { productCategoriesQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const FIELDS = updateProductCategoryInputSchema.keyof().options;

function useRefresh() {
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['products', tenantId] });
}

// One form for both: a new category (no `category`) or an existing one. The parent select leaves
// out the category itself and everything under it — it cannot go inside itself.
function CategoryForm({
  categories,
  category,
  parentId,
  onDone,
}: {
  categories: ProductCategory[];
  category: ProductCategory | null;
  parentId: string;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const refresh = useRefresh();
  const [confirming, setConfirming] = useState(false);
  const parents = useMemo(
    () => [
      { value: '', label: t('categories.topLevel') },
      ...categoryOptions(categories, category?.id),
    ],
    [categories, category, t],
  );
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateProductCategoryInputSchema, { error: contractErrorMap }),
    defaultValues: {
      parentId: category ? (category.parentId ?? '') : parentId,
      name: category?.name ?? '',
      // A new category has no version; 1 passes the schema, and the create route never reads it
      version: category?.version ?? 1,
    },
  });

  const remove = useMutation({
    mutationFn: (target: ProductCategory) =>
      call(routes.productCategories.remove, {
        params: { id: target.id },
        query: { version: target.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('categories.deleted', { name: category?.name ?? '' }));
      onDone();
    },
  });

  const onSubmit = handleSubmit(async ({ version, ...fields }) => {
    try {
      const saved = category
        ? await call(routes.productCategories.update, {
            params: { id: category.id },
            body: { ...fields, version },
          })
        : await call(routes.productCategories.create, {
            body: createProductCategoryInputSchema.parse(fields),
          });
      await refresh();
      toast(t(category ? 'categories.updated' : 'categories.created', { name: saved.name }));
      onDone();
    } catch (error) {
      applyApiError(error, FIELDS, setError);
    }
  });

  const failure =
    errors.root?.server?.message ??
    (remove.error instanceof ApiRequestError
      ? remove.error.code
      : remove.error
        ? 'unknown_error'
        : undefined);

  return (
    <DialogContent
      title={
        category ? t('categories.editTitle', { name: category.name }) : t('categories.newTitle')
      }
      footer={
        <>
          {category && (
            <div className="mr-auto flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={remove.isPending}
                onClick={() => {
                  if (confirming) remove.mutate(category);
                  else setConfirming(true);
                }}
              >
                {confirming
                  ? t('categories.confirmDelete', { name: category.name })
                  : t('categories.delete')}
              </Button>
            </div>
          )}
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="category-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : category ? t('common.save') : t('categories.add')}
          </Button>
        </>
      }
    >
      <form
        id="category-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {failure && <FormAlert message={failure} />}
        {confirming && <p className="text-body-sm text-ink-2">{t('categories.deleteWarning')}</p>}
        <SelectField
          label={t('categories.parent')}
          options={parents}
          {...register('parentId')}
          error={errors.parentId?.message}
        />
        <TextField
          label={t('categories.name')}
          placeholder={t('categories.namePlaceholder')}
          {...register('name')}
          error={errors.name?.message}
        />
      </form>
    </DialogContent>
  );
}

function CategoryRow({
  category,
  canManage,
  onOpen,
  onAdd,
}: {
  category: ProductCategory;
  canManage: boolean;
  onOpen: (category: ProductCategory) => void;
  onAdd: (parent: ProductCategory) => void;
}) {
  const { t, format } = useLocale();
  const nameClass = 'min-w-0 truncate text-left text-body-sm font-medium text-ink';
  return (
    <>
      {canManage ? (
        <button
          type="button"
          onClick={() => {
            onOpen(category);
          }}
          className={cn(nameClass, 'underline-offset-3 hover:underline')}
        >
          {category.name}
        </button>
      ) : (
        <span className={nameClass}>{category.name}</span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {category.productCount > 0 && (
          <span className="text-caption text-ink-3 tabular-nums">
            {t('categories.productCount', {
              count: category.productCount,
              formatted: format.number(category.productCount),
            })}
          </span>
        )}
        {canManage && (
          <IconButton
            icon={PlusSignIcon}
            label={t('categories.addTo', { name: category.name })}
            // CLAUDE.md → Tree list: shown on hover or focus with a mouse, always on touch screens
            className="-my-1 pointer-fine:opacity-0 pointer-fine:group-hover/row:opacity-100 pointer-fine:group-focus-within/row:opacity-100"
            onClick={() => {
              onAdd(category);
            }}
          />
        )}
      </span>
    </>
  );
}

type Editing =
  null | { kind: 'new'; parentId: string } | { kind: 'edit'; category: ProductCategory };

export function ProductCategoriesPage() {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canManage = useCan()('inventory.product.manage');
  const { data: categories, isError } = useQuery(productCategoriesQuery(tenantId));
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<Editing>(null);
  const query = search.trim().toLowerCase();

  const tree = useMemo(() => {
    const full = categoryTree(categories ?? []);
    return query === ''
      ? full
      : filterTree(full, (category) => category.name.toLowerCase().includes(query));
  }, [categories, query]);

  const isOpen = useCallback(
    (id: string) => query !== '' || !collapsed.has(id),
    [query, collapsed],
  );
  const toggle = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const open = useCallback((category: ProductCategory) => {
    setEditing({ kind: 'edit', category });
  }, []);
  const add = useCallback((parent: ProductCategory) => {
    setEditing({ kind: 'new', parentId: parent.id });
  }, []);

  return (
    <div className="grid max-w-4xl grid-cols-1 gap-5">
      <PageHeader
        title={t('categories.title')}
        description={t('categories.description')}
        actions={
          canManage && (
            <Button
              onClick={() => {
                setEditing({ kind: 'new', parentId: '' });
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('categories.add')}
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-60">
          <Input
            type="search"
            icon={Search01Icon}
            aria-label={t('categories.searchLabel')}
            placeholder={t('categories.searchPlaceholder')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={query !== ''}
            onClick={() => {
              setCollapsed(new Set());
            }}
          >
            <HugeiconsIcon icon={UnfoldMoreIcon} size={16} strokeWidth={1.5} />
            {t('categories.expandAll')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={query !== ''}
            onClick={() => {
              setCollapsed(new Set(categories?.map((category) => category.id)));
            }}
          >
            <HugeiconsIcon icon={UnfoldLessIcon} size={16} strokeWidth={1.5} />
            {t('categories.collapseAll')}
          </Button>
        </div>
      </div>
      {!canManage && <p className="text-body-sm text-ink-3">{t('categories.readOnly')}</p>}
      {isError && <p className="text-body-sm text-crit">{t('categories.loadFailed')}</p>}
      {categories?.length === 0 && (
        <EmptyState
          icon={FolderTreeIcon}
          title={t('categories.emptyTitle')}
          description={t('categories.emptyBody')}
        />
      )}
      {categories && categories.length > 0 && tree.length === 0 && (
        <EmptyState
          icon={Search01Icon}
          title={t('categories.noMatchTitle', { query: search.trim() })}
          description={t('categories.noMatchBody')}
        />
      )}
      {tree.length > 0 && (
        <TreeList
          label={t('categories.title')}
          nodes={tree}
          isOpen={isOpen}
          onToggle={toggle}
          toggleLabel={(category, shown) =>
            t(shown ? 'categories.collapse' : 'categories.expand', { name: category.name })
          }
          renderRow={(category) => (
            <CategoryRow category={category} canManage={canManage} onOpen={open} onAdd={add} />
          )}
        />
      )}
      <Dialog
        open={editing !== null}
        onOpenChange={(shown) => {
          if (!shown) setEditing(null);
        }}
      >
        {categories && editing !== null && (
          <CategoryForm
            key={editing.kind === 'edit' ? editing.category.id : `new-${editing.parentId}`}
            categories={categories}
            category={editing.kind === 'edit' ? editing.category : null}
            parentId={editing.kind === 'new' ? editing.parentId : ''}
            onDone={() => {
              setEditing(null);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
