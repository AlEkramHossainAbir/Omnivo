import { Calendar03Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';
import { lazy, type Ref, Suspense, useState } from 'react';

import { cn } from '../lib/cn.js';
import { parseIsoDate, toIsoDate } from '../lib/iso-date.js';
import { controlBoxClass } from './field.js';
import { Popover, PopoverContent, PopoverTrigger } from './popover.js';

const Calendar = lazy(async () => ({ default: (await import('./calendar.js')).Calendar }));

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
  const { t, format } = useLocale();
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
        {/* The fallback has the calendar's size, so the popover does not jump when it arrives */}
        <Suspense fallback={<div className="h-[292px] w-[252px]" />}>
          <Calendar
            selected={selected}
            onSelect={(date) => {
              onChange(date ? toIsoDate(date) : '');
              setOpen(false);
            }}
          />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}
