import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Delete02Icon,
  Edit02Icon,
  FolderAddIcon,
  FolderLibraryIcon,
  MoreHorizontalIcon,
  PlusSignIcon,
  Search01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  routes,
  slugFromName,
  type StorefrontCategory,
  updateStorefrontCategoryInputSchema,
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

import {
  ShopLine,
  StorefrontOffline,
  useStorefrontRefresh,
  ViewShopLink,
} from '../components/storefront-parts';
import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import {
  siblingPlace,
  storefrontCategoriesQuery,
  storefrontCategoryOptions,
  storefrontCategoryTree,
  storefrontSetupQuery,
} from '../lib/storefront';
import { useOnline } from '../lib/use-online';
import { useTenantId } from '../lib/workspace';

// Step 26g: the shop's categories, in the order the shop's menu shows them. Like the product
// categories page (TreeList, one dialog form for new and edit), plus what a shop needs: a link name
// (slug), Move up / Move down among the siblings (decision 15: buttons, so a keyboard can do it),
// and each category's listing count.

const FIELDS = updateStorefrontCategoryInputSchema.in.keyof().options;

function CategoryForm({
  categories,
  category,
  parentId,
  onDone,
}: {
  categories: StorefrontCategory[];
  category: StorefrontCategory | null;
  parentId: string;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const refresh = useStorefrontRefresh();
  const parents = useMemo(
    () => [
      { value: '', label: t('storefront.categories.topLevel') },
      ...storefrontCategoryOptions(categories, category?.id),
    ],
    [categories, category, t],
  );
  const {
    register,
    handleSubmit,
    setError,
    watch,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateStorefrontCategoryInputSchema, { error: contractErrorMap }),
    defaultValues: {
      parentId: category ? (category.parentId ?? '') : parentId,
      name: category?.name ?? '',
      slug: category?.slug ?? '',
      // A new category has no version; 1 passes the schema, and the create route never reads it
      version: category?.version ?? 1,
    },
  });
  // What an empty link name becomes, as the schema makes it (decision 12): shown as the box's
  // placeholder and in its hint, so the person sees the link before saving
  const name = watch('name');
  const slug = watch('slug');
  const madeSlug = slugFromName(name);
  const shownSlug = slug.trim() === '' ? madeSlug : slug.trim().toLowerCase();

  const onSubmit = handleSubmit(async ({ version, ...fields }) => {
    try {
      const saved = category
        ? await call(routes.storefront.updateCategory, {
            params: { id: category.id },
            body: { ...fields, version },
          })
        : await call(routes.storefront.createCategory, { body: fields });
      await refresh();
      toast(
        t(category ? 'storefront.categories.updated' : 'storefront.categories.created', {
          name: saved.name,
        }),
      );
      onDone();
    } catch (error) {
      applyApiError(error, FIELDS, setError);
    }
  });

  return (
    <DialogContent
      title={
        category
          ? t('storefront.categories.editTitle', { name: category.name })
          : t('storefront.categories.newTitle')
      }
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="shop-category-form" disabled={isSubmitting}>
            {isSubmitting
              ? t('common.saving')
              : category
                ? t('common.save')
                : t('storefront.categories.add')}
          </Button>
        </>
      }
    >
      <form
        id="shop-category-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message !== undefined && (
          <FormAlert message={errors.root.server.message} />
        )}
        <SelectField
          label={t('storefront.categories.parent')}
          icon={FolderLibraryIcon}
          options={parents}
          {...register('parentId')}
          error={errors.parentId?.message}
        />
        <TextField
          label={t('storefront.categories.name')}
          placeholder={t('storefront.categories.namePlaceholder')}
          {...register('name')}
          error={errors.name?.message}
        />
        <TextField
          label={t('storefront.categories.slug')}
          optional
          prefix="/c/"
          autoComplete="off"
          spellCheck={false}
          placeholder={madeSlug}
          hint={
            category && shownSlug !== category.slug
              ? t('storefront.categories.slugChangeHint')
              : t('storefront.categories.slugHint', { slug: shownSlug || '…' })
          }
          {...register('slug')}
          error={errors.slug?.message}
        />
      </form>
    </DialogContent>
  );
}

function DeleteDialog({ category, onDone }: { category: StorefrontCategory; onDone: () => void }) {
  const { t } = useLocale();
  const refresh = useStorefrontRefresh();
  const remove = useMutation({
    mutationFn: () =>
      call(routes.storefront.deleteCategory, {
        params: { id: category.id },
        query: { version: category.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('storefront.categories.deleted', { name: category.name }));
      onDone();
    },
  });
  return (
    <DialogContent
      title={t('storefront.categories.confirmDelete', { name: category.name })}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button
            disabled={remove.isPending}
            onClick={() => {
              remove.mutate();
            }}
          >
            {t('storefront.categories.delete')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {remove.error && (
          <FormAlert
            message={remove.error instanceof ApiRequestError ? remove.error.code : 'unknown_error'}
          />
        )}
        <p className="text-body-sm text-ink-2">{t('storefront.categories.deleteWarning')}</p>
      </div>
    </DialogContent>
  );
}

type Editing =
  | null
  | { kind: 'new'; parentId: string }
  | { kind: 'edit'; category: StorefrontCategory }
  | { kind: 'delete'; category: StorefrontCategory };

function CategoryRow({
  category,
  categories,
  canMove,
  moving,
  onMove,
  onEdit,
}: {
  category: StorefrontCategory;
  categories: readonly StorefrontCategory[];
  // Not while a search hides some siblings: "up" would jump over rows nobody can see
  canMove: boolean;
  moving: boolean;
  onMove: (category: StorefrontCategory, direction: 'up' | 'down') => void;
  onEdit: (editing: Editing) => void;
}) {
  const { t, format } = useLocale();
  const place = siblingPlace(categories, category);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          onEdit({ kind: 'edit', category });
        }}
        className={
          category.parentId === null
            ? 'min-w-0 truncate text-left text-body-sm font-medium text-ink underline-offset-3 hover:underline'
            : 'min-w-0 truncate text-left text-body-sm text-ink-2 underline-offset-3 hover:underline'
        }
      >
        {category.name}
      </button>
      <span className="hidden truncate font-mono text-caption text-ink-3 sm:inline">
        /c/{category.slug}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        <span className="mr-2 text-caption text-ink-3 tabular-nums">
          {t('storefront.categories.listingCount', {
            count: category.listingCount,
            formatted: format.number(category.listingCount),
          })}
        </span>
        <IconButton
          icon={FolderAddIcon}
          label={t('storefront.categories.addTo', { name: category.name })}
          // CLAUDE.md → Tree list: on hover or focus with a mouse, always on a touch screen
          className="-my-1 pointer-fine:opacity-0 pointer-fine:group-hover/row:opacity-100 pointer-fine:group-focus-within/row:opacity-100"
          onClick={() => {
            onEdit({ kind: 'new', parentId: category.id });
          }}
        />
        <IconButton
          icon={ArrowUp01Icon}
          label={t('storefront.categories.moveUpLabel', { name: category.name })}
          className="-my-1"
          disabled={!canMove || moving || place.first}
          onClick={() => {
            onMove(category, 'up');
          }}
        />
        <IconButton
          icon={ArrowDown01Icon}
          label={t('storefront.categories.moveDownLabel', { name: category.name })}
          className="-my-1"
          disabled={!canMove || moving || place.last}
          onClick={() => {
            onMove(category, 'down');
          }}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              icon={MoreHorizontalIcon}
              label={t('storefront.categories.actions', { name: category.name })}
              className="-my-1"
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              icon={Edit02Icon}
              onSelect={() => {
                onEdit({ kind: 'edit', category });
              }}
            >
              {t('storefront.categories.edit')}
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={Delete02Icon}
              onSelect={() => {
                onEdit({ kind: 'delete', category });
              }}
            >
              {t('storefront.categories.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </>
  );
}

export function StorefrontCategoriesPage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const online = useOnline();
  const queryClient = useQueryClient();
  const shop = useQuery({ ...storefrontSetupQuery(tenantId), enabled: online }).data?.shop;
  const { data: categories, isError } = useQuery({
    ...storefrontCategoriesQuery(tenantId),
    enabled: online,
  });
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<Editing>(null);
  const query = search.trim().toLowerCase();

  // The move answers the whole list (decision 15: both siblings changed), so the page takes it as
  // it is instead of asking again
  const move = useMutation({
    mutationFn: ({
      category,
      direction,
    }: {
      category: StorefrontCategory;
      direction: 'up' | 'down';
    }) =>
      call(routes.storefront.moveCategory, {
        params: { id: category.id },
        body: { direction, version: category.version },
      }),
    onSuccess: (list) => {
      queryClient.setQueryData(storefrontCategoriesQuery(tenantId).queryKey, list.items);
    },
  });

  const tree = useMemo(() => {
    const full = storefrontCategoryTree(categories ?? []);
    return query === ''
      ? full
      : filterTree(
          full,
          (category) =>
            category.name.toLowerCase().includes(query) || category.slug.includes(query),
        );
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
  const onMove = useCallback(
    (category: StorefrontCategory, direction: 'up' | 'down') => {
      move.mutate({ category, direction });
    },
    [move],
  );

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <PageHeader
        title={t('storefront.categories.title')}
        description={
          <>
            {t('storefront.categories.description')}
            <ShopLine />
          </>
        }
        actions={
          <>
            {shop && <ViewShopLink href={shop.shopUrl} />}
            <Button
              disabled={!online}
              onClick={() => {
                setEditing({ kind: 'new', parentId: '' });
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('storefront.categories.add')}
            </Button>
          </>
        }
      />
      {!online && <StorefrontOffline />}
      {online && isError && (
        <p className="text-body-sm text-crit">{t('storefront.categories.loadFailed')}</p>
      )}
      {online && categories && categories.length > 0 && (
        <div className="max-w-sm">
          <Input
            type="search"
            icon={Search01Icon}
            aria-label={t('storefront.categories.searchLabel')}
            placeholder={t('storefront.categories.searchPlaceholder')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
      )}
      {move.error && (
        <FormAlert
          message={move.error instanceof ApiRequestError ? move.error.code : 'unknown_error'}
        />
      )}
      {online && categories?.length === 0 && (
        <EmptyState
          icon={FolderLibraryIcon}
          title={t('storefront.categories.emptyTitle')}
          description={t('storefront.categories.emptyBody')}
        />
      )}
      {online && categories && categories.length > 0 && tree.length === 0 && (
        <EmptyState
          icon={Search01Icon}
          title={t('storefront.categories.noMatchTitle')}
          description={t('storefront.categories.noMatchBody')}
        />
      )}
      {online && categories && tree.length > 0 && (
        <TreeList
          label={t('storefront.categories.title')}
          nodes={tree}
          isOpen={isOpen}
          onToggle={toggle}
          toggleLabel={(category, shown) =>
            t(shown ? 'storefront.categories.collapse' : 'storefront.categories.expand', {
              name: category.name,
            })
          }
          renderRow={(category) => (
            <CategoryRow
              category={category}
              categories={categories}
              canMove={query === ''}
              moving={move.isPending}
              onMove={onMove}
              onEdit={setEditing}
            />
          )}
        />
      )}
      <Dialog
        open={editing !== null}
        onOpenChange={(shown) => {
          if (!shown) setEditing(null);
        }}
      >
        {categories && editing?.kind === 'delete' && (
          <DeleteDialog
            category={editing.category}
            onDone={() => {
              setEditing(null);
            }}
          />
        )}
        {categories && (editing?.kind === 'new' || editing?.kind === 'edit') && (
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
