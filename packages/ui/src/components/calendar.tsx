import { ArrowLeft01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';
import { type ChevronProps, DayPicker } from 'react-day-picker';
import { bn } from 'react-day-picker/locale/bn';
import { enUS } from 'react-day-picker/locale/en-US';

// The DatePicker's month grid. A module of its own, which date-picker.tsx imports lazily: the
// calendar (react-day-picker and its two locales, about 30 KB gz) loads when a date field is first
// opened, not with every page that has a date field. Found in step 10, when four journal pages
// with date fields came close to the 100 KB chunk budget.

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

interface CalendarProps {
  selected: Date | undefined;
  onSelect: (date: Date | undefined) => void;
}

export function Calendar({ selected, onSelect }: CalendarProps) {
  const { language } = useLocale();
  return (
    <DayPicker
      mode="single"
      selected={selected}
      // খুললে বাছাই করা মাস দেখায়, খালি থাকলে এই মাস। `?? new Date()`: exactOptionalPropertyTypes-এ
      // defaultMonth-এ undefined পাঠানো যায় না
      defaultMonth={selected ?? new Date()}
      onSelect={onSelect}
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
        selected: '[&>button]:bg-brand [&>button]:text-brand-ink [&>button]:hover:bg-brand-hover',
        outside: '[&>button]:text-ink-3',
        disabled: 'opacity-40',
      }}
    />
  );
}
