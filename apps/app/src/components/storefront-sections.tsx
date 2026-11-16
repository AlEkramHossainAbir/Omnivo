import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Delete02Icon,
  PlusSignIcon,
  ViewIcon,
  ViewOffSlashIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  renderSections,
  STOREFRONT_SECTIONS_MAX,
  type UpdateStorefrontListingInput,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  FormAlert,
  IconButton,
  TextAreaField,
  TextField,
} from '@omnivo/ui';
import { useState } from 'react';
import {
  type Control,
  type FieldErrors,
  useFieldArray,
  type UseFormRegister,
  useWatch,
} from 'react-hook-form';

import { rowPath } from '../lib/products';
import type { ListingFormValues } from '../lib/storefront';

// Step 26g: the description, as sections of a heading and a text box (26f decision 6: the tenant
// never writes HTML). Each section has a preview made by the same renderSections the API uses, so
// what the box shows is what the product page will show, list markers and bold included.

type ListingControl = Control<ListingFormValues, unknown, UpdateStorefrontListingInput>;

// The product page's prose, at the app's sizes: headings like a card title, lists with markers
const PROSE =
  'grid gap-2 text-body-sm text-ink-2 [&_a]:font-medium [&_a]:text-brand [&_a]:underline [&_h2]:text-h3 [&_h2]:text-ink [&_ol]:list-decimal [&_ol]:pl-5 [&_strong]:font-semibold [&_strong]:text-ink [&_ul]:list-disc [&_ul]:pl-5';

function SectionPreview({ control, index }: { control: ListingControl; index: number }) {
  const { t } = useLocale();
  const [heading, body] = useWatch({
    control,
    name: [
      rowPath('descriptionSections', index, 'heading'),
      rowPath('descriptionSections', index, 'body'),
    ],
  });
  // renderSections escapes every character the person typed before it adds its own few tags
  // (26f: the same function writes the shop's HTML), so this HTML carries no markup of theirs
  const html = renderSections([{ heading: heading.trim(), body: body.trim() }]);
  return (
    <div className="overflow-hidden rounded-control border border-line">
      <p className="flex items-center gap-1.5 bg-subtle px-3.5 py-2 text-caption text-ink-3">
        <HugeiconsIcon icon={ViewIcon} size={14} strokeWidth={1.5} />
        {t('storefront.listing.previewCaption')}
      </p>
      <div className={`px-5 py-4 ${PROSE}`} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

export function DescriptionCard({
  control,
  register,
  errors,
}: {
  control: ListingControl;
  register: UseFormRegister<ListingFormValues>;
  errors: FieldErrors<ListingFormValues>;
}) {
  const { t } = useLocale();
  const sections = useFieldArray({ control, name: 'descriptionSections' });
  // Which sections show their preview, by the field array's own key (it survives a move)
  const [previews, setPreviews] = useState<ReadonlySet<string>>(new Set());
  const listError =
    errors.descriptionSections?.root?.message ?? errors.descriptionSections?.message;

  return (
    <Card>
      <CardHeader
        title={t('storefront.listing.descriptionTitle')}
        subtitle={t('storefront.listing.descriptionHint')}
      />
      <div className="grid gap-4 p-5">
        {listError !== undefined && <FormAlert message={listError} />}
        {sections.fields.length === 0 && (
          <p className="text-body-sm text-ink-2">{t('storefront.listing.noSections')}</p>
        )}
        {sections.fields.map((section, index) => {
          const number = index + 1;
          const shown = previews.has(section.id);
          return (
            <div
              key={section.id}
              role="group"
              aria-label={t('storefront.listing.sectionNumber', { number })}
              className="grid gap-4 rounded-control border border-line p-4"
            >
              <div className="flex items-center gap-0.5">
                <span className="mr-auto text-caption text-ink-2">
                  {t('storefront.listing.sectionNumber', { number })}
                </span>
                <IconButton
                  icon={ArrowUp01Icon}
                  label={t('storefront.listing.moveSectionUp', { number })}
                  disabled={index === 0}
                  onClick={() => {
                    sections.swap(index, index - 1);
                  }}
                />
                <IconButton
                  icon={ArrowDown01Icon}
                  label={t('storefront.listing.moveSectionDown', { number })}
                  disabled={index === sections.fields.length - 1}
                  onClick={() => {
                    sections.swap(index, index + 1);
                  }}
                />
                <IconButton
                  icon={Delete02Icon}
                  label={t('storefront.listing.removeSection', { number })}
                  onClick={() => {
                    sections.remove(index);
                  }}
                />
              </div>
              <TextField
                label={t('storefront.listing.heading')}
                placeholder={t('storefront.listing.headingPlaceholder')}
                {...register(rowPath('descriptionSections', index, 'heading'))}
                error={errors.descriptionSections?.[index]?.heading?.message}
              />
              <TextAreaField
                label={t('storefront.listing.body')}
                placeholder={t('storefront.listing.bodyPlaceholder')}
                rows={6}
                hint={index === 0 ? t('storefront.listing.bodyHint') : undefined}
                {...register(rowPath('descriptionSections', index, 'body'))}
                error={errors.descriptionSections?.[index]?.body?.message}
              />
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-expanded={shown}
                  onClick={() => {
                    setPreviews((current) => {
                      const next = new Set(current);
                      if (!next.delete(section.id)) next.add(section.id);
                      return next;
                    });
                  }}
                >
                  <HugeiconsIcon
                    icon={shown ? ViewOffSlashIcon : ViewIcon}
                    size={17}
                    strokeWidth={1.5}
                  />
                  {shown
                    ? t('storefront.listing.hidePreview')
                    : t('storefront.listing.showPreview')}
                </Button>
              </div>
              {shown && <SectionPreview control={control} index={index} />}
            </div>
          );
        })}
        <div>
          <Button
            variant="secondary"
            size="sm"
            disabled={sections.fields.length >= STOREFRONT_SECTIONS_MAX}
            onClick={() => {
              sections.append({ heading: '', body: '' });
            }}
          >
            <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
            {t('storefront.listing.addSection')}
          </Button>
        </div>
      </div>
    </Card>
  );
}
