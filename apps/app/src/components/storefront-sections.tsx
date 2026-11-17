import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Delete02Icon,
  PlusSignIcon,
  ViewIcon,
  ViewOffSlashIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { renderSections, STOREFRONT_SECTIONS_MAX } from '@omnivo/contracts';
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
import type { UseFormRegisterReturn } from 'react-hook-form';

// Step 26g: the description, as sections of a heading and a text box (26f decision 6: the tenant
// never writes HTML). Each section has a preview made by the same renderSections the API uses, so
// what the box shows is what the product page will show, list markers and bold included.
//
// Step 26h: the text pages use the same editor (decision 5), so it no longer knows the listing's
// form. The page that owns the form passes the rows, the inputs and the errors; the words that
// differ (title, placeholders, the empty line, the preview's caption) are props too (decision 33).

// The product page's prose, at the app's sizes: headings like a card title, lists with markers
const PROSE =
  'grid gap-2 text-body-sm text-ink-2 [&_a]:font-medium [&_a]:text-brand [&_a]:underline [&_h2]:text-h3 [&_h2]:text-ink [&_ol]:list-decimal [&_ol]:pl-5 [&_strong]:font-semibold [&_strong]:text-ink [&_ul]:list-disc [&_ul]:pl-5';

function SectionPreview({
  heading,
  body,
  caption,
}: {
  heading: string;
  body: string;
  caption: string;
}) {
  // renderSections escapes every character the person typed before it adds its own few tags
  // (26f: the same function writes the shop's HTML), so this HTML carries no markup of theirs
  const html = renderSections([{ heading: heading.trim(), body: body.trim() }]);
  return (
    <div className="overflow-hidden rounded-control border border-line">
      <p className="flex items-center gap-1.5 bg-subtle px-3.5 py-2 text-caption text-ink-3">
        <HugeiconsIcon icon={ViewIcon} size={14} strokeWidth={1.5} />
        {caption}
      </p>
      <div className={`px-5 py-4 ${PROSE}`} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

export interface SectionRow {
  // The field array's own key (useFieldArray's `id`): it survives a move, an index does not
  key: string;
  // What the boxes hold now (useWatch), for the preview
  heading: string;
  body: string;
}

export interface SectionsCardProps {
  title: string;
  subtitle: string;
  headingPlaceholder: string;
  bodyPlaceholder: string;
  // Shown while there is no section
  emptyText: string;
  previewCaption: string;
  rows: readonly SectionRow[];
  // register() of the row's box. The page builds the path, so its form type stays its own: the
  // listing's list is `descriptionSections`, a text page's is `sections`
  field: (index: number, part: 'heading' | 'body') => UseFormRegisterReturn;
  error: (index: number, part: 'heading' | 'body') => string | undefined;
  // An error about the list itself (too many sections, a page with none)
  listError: string | undefined;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onSwap: (from: number, to: number) => void;
}

export function SectionsCard({
  title,
  subtitle,
  headingPlaceholder,
  bodyPlaceholder,
  emptyText,
  previewCaption,
  rows,
  field,
  error,
  listError,
  onAdd,
  onRemove,
  onSwap,
}: SectionsCardProps) {
  const { t } = useLocale();
  // Which sections show their preview, by the row's key
  const [previews, setPreviews] = useState<ReadonlySet<string>>(new Set());

  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} />
      <div className="grid gap-4 p-5">
        {listError !== undefined && <FormAlert message={listError} />}
        {rows.length === 0 && <p className="text-body-sm text-ink-2">{emptyText}</p>}
        {rows.map((row, index) => {
          const number = index + 1;
          const shown = previews.has(row.key);
          return (
            <div
              key={row.key}
              role="group"
              aria-label={t('storefront.sections.number', { number })}
              className="grid gap-4 rounded-control border border-line p-4"
            >
              <div className="flex items-center gap-0.5">
                <span className="mr-auto text-caption text-ink-2">
                  {t('storefront.sections.number', { number })}
                </span>
                <IconButton
                  icon={ArrowUp01Icon}
                  label={t('storefront.sections.moveUp', { number })}
                  disabled={index === 0}
                  onClick={() => {
                    onSwap(index, index - 1);
                  }}
                />
                <IconButton
                  icon={ArrowDown01Icon}
                  label={t('storefront.sections.moveDown', { number })}
                  disabled={index === rows.length - 1}
                  onClick={() => {
                    onSwap(index, index + 1);
                  }}
                />
                <IconButton
                  icon={Delete02Icon}
                  label={t('storefront.sections.remove', { number })}
                  onClick={() => {
                    onRemove(index);
                  }}
                />
              </div>
              <TextField
                label={t('storefront.sections.heading')}
                placeholder={headingPlaceholder}
                {...field(index, 'heading')}
                error={error(index, 'heading')}
              />
              <TextAreaField
                label={t('storefront.sections.body')}
                placeholder={bodyPlaceholder}
                rows={6}
                hint={index === 0 ? t('storefront.sections.bodyHint') : undefined}
                {...field(index, 'body')}
                error={error(index, 'body')}
              />
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-expanded={shown}
                  onClick={() => {
                    setPreviews((current) => {
                      const next = new Set(current);
                      if (!next.delete(row.key)) next.add(row.key);
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
                    ? t('storefront.sections.hidePreview')
                    : t('storefront.sections.showPreview')}
                </Button>
              </div>
              {shown && (
                <SectionPreview heading={row.heading} body={row.body} caption={previewCaption} />
              )}
            </div>
          );
        })}
        <div>
          <Button
            variant="secondary"
            size="sm"
            disabled={rows.length >= STOREFRONT_SECTIONS_MAX}
            onClick={onAdd}
          >
            <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
            {t('storefront.sections.add')}
          </Button>
        </div>
      </div>
    </Card>
  );
}
