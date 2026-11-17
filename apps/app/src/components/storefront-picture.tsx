import {
  Alert02Icon,
  Delete02Icon,
  Image01Icon,
  ImageAdd01Icon,
  ImageUploadIcon,
  Loading03Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { ATTACHMENT_RULES, type ErrorCode } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, cn, TextField } from '@omnivo/ui';
import { type ChangeEvent, type ReactNode, useId, useRef, useState } from 'react';
import type { UseFormRegisterReturn } from 'react-hook-form';

import { ApiRequestError } from '../lib/api';
import { checkPhotoFile, type PhotoState, uploadShopPhoto } from '../lib/storefront';
import { useJobState } from './storefront-photos';

// Step 26h: one picture of the logo, the hero or a picture banner (26h.5 decision 34: a banner has
// "pictures", a listing "photos"). The same upload as a listing's photo (26g: the upload address,
// the file straight to storage, "complete", then the image job), one file at a time. The form
// keeps the picture's id; the page keeps its state beside it, like the listing's photos, so Save
// can wait until every picture is ready (the API refuses one that is not).

// The hidden file input and what choosing a file does. `onPicked` gets the new picture's id as
// soon as there is one, so the box says "Uploading…" while the file travels
export function usePictureUpload({
  onPicked,
  onState,
}: {
  onPicked: (id: string) => void;
  onState: (id: string, next: PhotoState) => void;
}): { open: () => void; failure: ErrorCode | null; fileInput: ReactNode } {
  const input = useRef<HTMLInputElement>(null);
  const [failure, setFailure] = useState<ErrorCode | null>(null);

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Emptied, so choosing the same file again (after a failure) is a change again
    event.target.value = '';
    setFailure(null);
    if (file === undefined) return;
    // The storefront_image rule before anything is sent: a 30 MB file never starts uploading
    const problem = checkPhotoFile(file);
    if (problem !== null) {
      setFailure(problem);
      return;
    }
    uploadShopPhoto(file, (id) => {
      onState(id, { status: 'uploading' });
      onPicked(id);
    })
      .then(({ id, state }) => {
        onState(id, state);
      })
      .catch((error: unknown) => {
        setFailure(error instanceof ApiRequestError ? error.code : 'unknown_error');
      });
  };

  return {
    open: () => input.current?.click(),
    failure,
    fileInput: (
      <input
        ref={input}
        type="file"
        // Only the kinds the server takes; it checks the bytes again (26g.3)
        accept={ATTACHMENT_RULES.storefront_image.contentTypes.join(',')}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={choose}
      />
    ),
  };
}

// An error under a picture, in the look of a field's error
export function PictureError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="flex items-center gap-1.5 text-label text-crit">
      <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
      {children}
    </p>
  );
}

// What the box shows while the server works, or why it failed
function PictureState({ state }: { state: PhotoState }) {
  const { t, errorText } = useLocale();
  if (state.status === 'failed') {
    return (
      <span className="grid justify-items-center gap-2 px-4 text-center text-label text-crit">
        <HugeiconsIcon icon={Alert02Icon} size={20} strokeWidth={1.5} />
        {errorText(state.code)}
      </span>
    );
  }
  return (
    <span role="status" className="grid justify-items-center gap-2 text-body-sm text-ink-2">
      <HugeiconsIcon
        icon={state.status === 'uploading' ? Image01Icon : Loading03Icon}
        size={22}
        strokeWidth={1.5}
        className={state.status === 'processing' ? 'motion-safe:animate-spin' : undefined}
      />
      {state.status === 'uploading'
        ? t('storefront.picture.uploading')
        : t('storefront.picture.preparing')}
    </span>
  );
}

export interface PictureFieldProps {
  label: string;
  hint: string;
  // The picture's shape in the shop, as a whole Tailwind class written out by the caller
  // ("aspect-[1280/280]"): Tailwind finds only class names it can read in the source
  aspectClass: string;
  // A photo that fills its box (the phone hero, cut to fit) or one shown whole (a banner, whose
  // words are in the picture and must never be cut)
  cover?: boolean;
  // The picture's id in the form, '' = none
  value: string;
  state: PhotoState | undefined;
  onPicked: (id: string) => void;
  onState: (id: string, next: PhotoState) => void;
  // The alt text box: register() of `<picture>.alt`
  alt: UseFormRegisterReturn;
  altPlaceholder: string;
  altHint?: string | undefined;
  altError?: string | undefined;
  // The schema's error on `<picture>.id`: with no picture it means "upload one"
  idError?: string | undefined;
}

export function PictureField({
  label,
  hint,
  aspectClass,
  cover = false,
  value,
  state,
  onPicked,
  onState,
  alt,
  altPlaceholder,
  altHint,
  altError,
  idError,
}: PictureFieldProps) {
  const { t, errorText } = useLocale();
  const labelId = useId();
  const upload = usePictureUpload({ onPicked, onState });
  // The polling stops by itself for a picture that is ready (or for no picture)
  useJobState(value, state ?? { status: 'ready', url: '' }, onState);
  const empty = value === '';

  return (
    <div role="group" aria-labelledby={labelId} className="grid content-start gap-1.5">
      <span id={labelId} className="text-label font-medium text-ink">
        {label}
      </span>
      <div className="grid gap-3 rounded-control border border-line p-3">
        {empty ? (
          <button
            type="button"
            onClick={upload.open}
            className={cn(
              'grid max-h-45 w-full place-items-center content-center gap-2 rounded-lg border border-dashed border-line-strong bg-surface text-body-sm font-medium text-ink-2 transition-colors duration-150 hover:bg-subtle',
              aspectClass,
            )}
          >
            <span className="grid size-10 place-items-center rounded-lg bg-brand-soft text-brand">
              <HugeiconsIcon icon={ImageAdd01Icon} size={20} strokeWidth={1.5} />
            </span>
            {t('storefront.picture.upload')}
          </button>
        ) : (
          <>
            <div
              className={cn(
                'relative grid max-h-45 w-full place-items-center overflow-hidden rounded-lg bg-subtle',
                aspectClass,
              )}
            >
              {state?.status === 'ready' ? (
                <img
                  src={state.url}
                  alt=""
                  className={cn('size-full', cover ? 'object-cover' : 'object-contain')}
                />
              ) : (
                <PictureState state={state ?? { status: 'processing' }} />
              )}
            </div>
            {state?.status === 'failed' ? (
              <button
                type="button"
                onClick={() => {
                  onPicked('');
                }}
                className="justify-self-start text-body-sm font-medium text-brand underline-offset-3 hover:underline"
              >
                {t('storefront.picture.drop')}
              </button>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={upload.open}>
                  <HugeiconsIcon icon={ImageUploadIcon} size={17} strokeWidth={1.5} />
                  {t('storefront.picture.replace')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    onPicked('');
                  }}
                >
                  <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
                  {t('storefront.picture.remove')}
                </Button>
              </div>
            )}
          </>
        )}
        <TextField
          label={t('storefront.picture.alt')}
          placeholder={altPlaceholder}
          hint={altHint}
          {...alt}
          error={altError}
        />
      </div>
      {upload.failure !== null ? (
        <PictureError>{errorText(upload.failure)}</PictureError>
      ) : idError !== undefined ? (
        <PictureError>{empty ? t('storefront.picture.missing') : errorText(idError)}</PictureError>
      ) : (
        <p className="text-label text-ink-3">{hint}</p>
      )}
      {upload.fileInput}
    </div>
  );
}
