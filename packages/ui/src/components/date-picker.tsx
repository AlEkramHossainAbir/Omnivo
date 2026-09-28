import { ArrowLeft01Icon, ArrowRight01Icon, Calendar03Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';
import { type Ref, useState } from 'react';
import { type ChevronProps, DayPicker } from 'react-day-picker';
import { bn } from 'react-day-picker/locale/bn';
import { enUS } from 'react-day-picker/locale/en-US';

import { cn } from '../lib/cn.js';
import { parseIsoDate, toIsoDate } from '../lib/iso-date.js';
import { controlBoxClass } from './field.js';
import { Popover, PopoverContent, PopoverTrigger } from './popover.js';

// react-day-picker-এর নিজের SVG তীরের বদলে HugeIcons (CLAUDE.md rule ৪: আইকন একটাই লাইব্রেরি)
function Chevron({ orientation }: ChevronProps) {
  return (
    <HugeiconsIcon
      icon={orientation === 'left' ? ArrowLeft01Icon : ArrowRight01Icon}
      size={16}
      strokeWidth={1.5}
    />
  );
}

interface DatePickerProps {
  id?: string;
  name?: string;
  // "2026-09-23" অথবা "" (খালি)
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  // FormField-এর field.ref: error হলে react-hook-form এই বাটনে focus নেয়
  ref?: Ref<HTMLButtonElement>;
  invalid?: boolean;
  disabled?: boolean | undefined;
  placeholder?: string;
  'aria-describedby'?: string | undefined;
}

export function DatePicker({
  id,
  name,
  value,
  onChange,
  onBlur,
  ref,
  invalid = false,
  disabled,
  placeholder,
  'aria-describedby': ariaDescribedBy,
}: DatePickerProps) {
  const { t, language, format } = useLocale();
  const [open, setOpen] = useState(false);
  const selected = parseIsoDate(value);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // পপওভার বন্ধ হওয়া = ফিল্ড ছেড়ে যাওয়া; react-hook-form "touched" এখান থেকে জানে
        if (!next) onBlur?.();
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={ref}
          id={id}
          name={name}
          type="button"
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={ariaDescribedBy}
          className={cn(controlBoxClass(invalid), 'w-full py-2.5 text-left text-body')}
        >
          <HugeiconsIcon
            icon={Calendar03Icon}
            size={17}
            strokeWidth={1.5}
            className="shrink-0 text-ink-3"
          />
          {selected ? (
            <span className="tabular-nums">{format.date(selected)}</span>
          ) : (
            <span className="text-ink-3">{placeholder ?? t('ui.datePicker.placeholder')}</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent>
        <DayPicker
          mode="single"
          selected={selected}
          // খুললে বাছাই করা মাস দেখায়, খালি থাকলে এই মাস। `?? new Date()`: exactOptionalPropertyTypes-এ
          // defaultMonth-এ undefined পাঠানো যায় না
          defaultMonth={selected ?? new Date()}
          onSelect={(date) => {
            onChange(date ? toIsoDate(date) : '');
            setOpen(false);
          }}
          // মাস/দিনের নাম আর aria-label ভাষা অনুযায়ী; numerals='beng' দিনের সংখ্যা বাংলা অঙ্কে
          locale={language === 'bn' ? bn : enUS}
          numerals={language === 'bn' ? 'beng' : 'latn'}
          showOutsideDays
          autoFocus
          components={{ Chevron }}
          // react-day-picker-এর CSS import করা হয়নি — সব চেহারা token দিয়ে এখানে
          classNames={{
            root: 'text-body-sm',
            months: 'relative',
            month_caption: 'flex h-8 items-center justify-center font-medium text-ink',
            nav: 'absolute inset-x-0 top-0 flex h-8 items-center justify-between',
            button_previous:
              'grid size-8 place-items-center rounded-lg text-ink-3 transition-colors duration-150 hover:bg-subtle hover:text-ink',
            button_next:
              'grid size-8 place-items-center rounded-lg text-ink-3 transition-colors duration-150 hover:bg-subtle hover:text-ink',
            month_grid: 'mt-2 border-collapse',
            weekday: 'size-9 text-caption font-medium text-ink-3',
            day: 'p-0 text-center',
            day_button:
              'grid size-9 place-items-center rounded-lg tabular-nums text-ink transition-colors duration-150 hover:bg-subtle',
            // today/selected/outside বসে td-তে, রং দরকার ভেতরের বাটনে
            today: '[&>button]:font-semibold [&>button]:text-brand',
            selected:
              '[&>button]:bg-brand [&>button]:text-brand-ink [&>button]:hover:bg-brand-hover',
            outside: '[&>button]:text-ink-3',
            disabled: 'opacity-40',
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
