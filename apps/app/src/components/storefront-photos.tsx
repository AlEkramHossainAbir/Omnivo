import {
  Alert02Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Delete02Icon,
  Image01Icon,
  ImageAdd01Icon,
  Loading03Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ATTACHMENT_RULES,
  type ErrorCode,
  routes,
  STOREFRONT_IMAGES_MAX,
  type UpdateStorefrontListingInput,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Card, CardHeader, FormAlert, IconButton, Pill, TextField } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import {
  type Control,
  type FieldErrors,
  useFieldArray,
  type UseFormRegister,
} from 'react-hook-form';

import { ApiRequestError, call } from '../lib/api';
import { rowPath } from '../lib/products';
import {
  checkPhotoFile,
  type ListingFormValues,
  photoState,
  type PhotoState,
  uploadShopPhoto,
} from '../lib/storefront';
import { useTenantId } from '../lib/workspace';

// Step 26g: a listing's photos (decision 2). The form keeps {id, alt} per photo, in order; the page
// keeps each photo's state beside it (the upload, the server's job, the small file's address), so
// the slot can say "Uploading…" and "Preparing the photo…" while the job makes the shop's sizes.
// The page waits for every photo to be ready before it saves: the API refuses a photo it has not
// finished (storefront_image_not_ready).

type ListingControl = Control<ListingFormValues, unknown, UpdateStorefrontListingInput>;

// One photo the server is still working on: asks every 2 seconds until the job has finished, then
// hands the answer to the page. A query per slot, so a photo that is ready stops asking
function useJobState(
  id: string,
  state: PhotoState,
  onState: (id: string, next: PhotoState) => void,
) {
  const tenantId = useTenantId();
  const { data } = useQuery({
    queryKey: ['storefront', tenantId, 'upload', id],
    queryFn: () => call(routes.storefront.getUpload, { params: { id } }),
    enabled: state.status === 'processing',
    refetchInterval: 2000,
    // A fresh answer each time the slot asks: a cached "processing" must not stop the polling
    gcTime: 0,
  });
  useEffect(() => {
    if (state.status !== 'processing' || data === undefined) return;
    const next = photoState(data);
    if (next.status !== 'processing') onState(id, next);
  }, [data, id, state.status, onState]);
}

function PhotoSlot({
  index,
  count,
  id,
  state,
  register,
  error,
  onState,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  id: string;
  state: PhotoState;
  register: UseFormRegister<ListingFormValues>;
  error: string | undefined;
  onState: (id: string, next: PhotoState) => void;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
}) {
  const { t } = useLocale();
  const number = index + 1;
  useJobState(id, state, onState);

  return (
    <div
      role="group"
      aria-label={t('storefront.listing.photoNumber', { number })}
      className="grid content-start gap-3 rounded-control border border-line p-3"
    >
      <div className="flex items-center gap-0.5">
        <span className="mr-auto text-caption text-ink-2">
          {t('storefront.listing.photoNumber', { number })}
        </span>
        <IconButton
          icon={ArrowLeft01Icon}
          label={t('storefront.listing.movePhotoUp', { number })}
          disabled={index === 0}
          onClick={() => {
            onMove(index, index - 1);
          }}
        />
        <IconButton
          icon={ArrowRight01Icon}
          label={t('storefront.listing.movePhotoDown', { number })}
          disabled={index === count - 1}
          onClick={() => {
            onMove(index, index + 1);
          }}
        />
        <IconButton
          icon={Delete02Icon}
          label={t('storefront.listing.removePhoto', { number })}
          onClick={() => {
            onRemove(index);
          }}
        />
      </div>
      <div className="relative grid aspect-[4/3] place-items-center overflow-hidden rounded-lg bg-subtle">
        {state.status === 'ready' ? (
          // The small WebP the job made. multiply drops a packshot's white box onto the grey
          <img src={state.url} alt="" className="size-full object-contain mix-blend-multiply" />
        ) : state.status === 'failed' ? (
          <span className="grid justify-items-center gap-2 px-4 text-center text-label text-crit">
            <HugeiconsIcon icon={Alert02Icon} size={20} strokeWidth={1.5} />
            <ErrorWords code={state.code} />
          </span>
        ) : (
          <span role="status" className="grid justify-items-center gap-2 text-body-sm text-ink-2">
            <HugeiconsIcon
              icon={state.status === 'uploading' ? Image01Icon : Loading03Icon}
              size={22}
              strokeWidth={1.5}
              className={state.status === 'processing' ? 'motion-safe:animate-spin' : undefined}
            />
            {state.status === 'uploading'
              ? t('storefront.listing.uploading')
              : t('storefront.listing.preparing')}
          </span>
        )}
        {index === 0 && state.status === 'ready' && (
          <span className="absolute top-2 left-2">
            <Pill tone="brand" icon={Image01Icon}>
              {t('storefront.listing.firstPhoto')}
            </Pill>
          </span>
        )}
      </div>
      {state.status === 'failed' ? (
        <button
          type="button"
          onClick={() => {
            onRemove(index);
          }}
          className="justify-self-start text-body-sm font-medium text-brand underline-offset-3 hover:underline"
        >
          {t('storefront.listing.dropPhoto')}
        </button>
      ) : (
        <TextField
          label={t('storefront.listing.alt')}
          placeholder={t('storefront.listing.altPlaceholder')}
          hint={index === 0 ? t('storefront.listing.altHint') : undefined}
          {...register(rowPath('images', index, 'alt'))}
          error={error}
        />
      )}
    </div>
  );
}

function ErrorWords({ code }: { code: ErrorCode }) {
  const { errorText } = useLocale();
  return <>{errorText(code)}</>;
}

export function PhotosCard({
  control,
  register,
  errors,
  photos,
  onPhotoState,
}: {
  control: ListingControl;
  register: UseFormRegister<ListingFormValues>;
  errors: FieldErrors<ListingFormValues>;
  photos: ReadonlyMap<string, PhotoState>;
  onPhotoState: (id: string, next: PhotoState) => void;
}) {
  const { t, format } = useLocale();
  const images = useFieldArray({ control, name: 'images', keyName: 'key' });
  const fileInput = useRef<HTMLInputElement>(null);
  const [failure, setFailure] = useState<ErrorCode | null>(null);
  const left = STOREFRONT_IMAGES_MAX - images.fields.length;

  // Several files at once, up to the photos still free; each goes its own way (one failing does
  // not stop the others). The form gets the photo as soon as it has an id, with an empty alt
  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])].slice(0, Math.max(left, 0));
    // Emptied, so choosing the same file again (after a failure) is a change again
    event.target.value = '';
    setFailure(null);
    for (const file of files) {
      const problem = checkPhotoFile(file);
      if (problem !== null) {
        setFailure(problem);
        continue;
      }
      uploadShopPhoto(file, (id) => {
        onPhotoState(id, { status: 'uploading' });
        images.append({ id, alt: '' }, { shouldFocus: false });
      })
        .then(({ id, state }) => {
          onPhotoState(id, state);
        })
        .catch((error: unknown) => {
          setFailure(error instanceof ApiRequestError ? error.code : 'unknown_error');
        });
    }
  };

  const listError = errors.images?.root?.message ?? errors.images?.message;

  return (
    <Card>
      <CardHeader
        title={t('storefront.listing.photosTitle')}
        subtitle={t('storefront.listing.photosHint', { max: STOREFRONT_IMAGES_MAX })}
      />
      <div className="grid gap-4 p-5">
        {failure !== null && <FormAlert message={failure} />}
        {listError !== undefined && <FormAlert message={listError} />}
        {images.fields.length === 0 && (
          <p className="text-body-sm text-ink-2">{t('storefront.listing.noPhotos')}</p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {images.fields.map((image, index) => (
            <PhotoSlot
              key={image.key}
              index={index}
              count={images.fields.length}
              id={image.id}
              state={photos.get(image.id) ?? { status: 'processing' }}
              register={register}
              error={errors.images?.[index]?.alt?.message ?? errors.images?.[index]?.message}
              onState={onPhotoState}
              onMove={images.swap}
              onRemove={images.remove}
            />
          ))}
          {left > 0 && (
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="grid min-h-48 place-items-center content-center gap-2 rounded-control border border-dashed border-line-strong bg-surface p-4 text-body-sm font-medium text-ink-2 transition-colors duration-150 hover:bg-subtle"
            >
              <span className="grid size-10 place-items-center rounded-lg bg-brand-soft text-brand">
                <HugeiconsIcon icon={ImageAdd01Icon} size={20} strokeWidth={1.5} />
              </span>
              {t('storefront.listing.addPhoto')}
              <span className="text-caption font-normal text-ink-3">
                {t('storefront.listing.photosLeft', {
                  count: left,
                  formatted: format.number(left),
                })}
              </span>
            </button>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          // Only the kinds the server takes; it checks the bytes again (26g.3)
          accept={ATTACHMENT_RULES.storefront_image.contentTypes.join(',')}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={choose}
        />
      </div>
    </Card>
  );
}
