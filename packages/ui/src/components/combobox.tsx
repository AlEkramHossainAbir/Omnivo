import { ArrowDown01Icon, Search01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';
import { type KeyboardEvent, type Ref, useId, useRef, useState } from 'react';

import { cn } from '../lib/cn.js';
import { controlBoxClass, Input } from './field.js';
import { Popover, PopoverContent, PopoverTrigger } from './popover.js';

export interface ComboboxOption {
  value: string;
  label: string;
  // A quieter second line: a customer's code and phone number
  detail?: string | undefined;
}

interface ComboboxProps {
  id?: string;
  name?: string;
  // The chosen option's value, or '' for none
  value: string;
  // What the button shows for the chosen value. The parent passes it because the options are only
  // what the last search found: a saved journal line's customer is rarely among them.
  selectedLabel: string | null;
  options: readonly ComboboxOption[];
  // The text in the search box. The parent searches with it (on the server, debounced) and passes
  // the matches back as `options`.
  search: string;
  onSearchChange: (search: string) => void;
  onChange: (value: string, option: ComboboxOption) => void;
  onBlur?: () => void;
  // FormField's field.ref: on an error, react-hook-form focuses this button
  ref?: Ref<HTMLButtonElement>;
  loading?: boolean | undefined;
  icon?: IconSvgElement | undefined;
  invalid?: boolean | undefined;
  disabled?: boolean | undefined;
  placeholder?: string | undefined;
  searchPlaceholder?: string | undefined;
  emptyText?: string | undefined;
  'aria-label'?: string | undefined;
  'aria-describedby'?: string | undefined;
}

// A select box for a long list that lives on the server (customers, later suppliers): the button
// looks like an input, and opens a popover with a search box and the matches. A native <select>
// would need every customer in the page; a distributor has thousands.
export function Combobox({
  id,
  name,
  value,
  selectedLabel,
  options,
  search,
  onSearchChange,
  onChange,
  onBlur,
  ref,
  loading = false,
  icon,
  invalid = false,
  disabled,
  placeholder,
  searchPlaceholder,
  emptyText,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
}: ComboboxProps) {
  const { t } = useLocale();
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const choose = (option: ComboboxOption) => {
    onChange(option.value, option);
    setOpen(false);
  };

  // Show the highlighted option without scrolling the page
  const highlight = (index: number) => {
    setActive(index);
    listRef.current?.children.item(index)?.scrollIntoView({ block: 'nearest' });
  };

  // The search box keeps the focus; the arrows move the highlight, Enter picks it
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (options.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      highlight((active + step + options.length) % options.length);
    } else if (event.key === 'Enter') {
      // Inside a form, Enter would also submit it
      event.preventDefault();
      const option = options[active];
      if (option) choose(option);
    }
  };

  const activeOption = options[active];

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          // Start on the chosen option when the matches hold it, otherwise on the first
          setActive(
            Math.max(
              0,
              options.findIndex((option) => option.value === value),
            ),
          );
        } else {
          // The next opening starts with an empty search, and closing = leaving the field
          onSearchChange('');
          onBlur?.();
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={ref}
          id={id}
          name={name}
          type="button"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-label={ariaLabel}
          aria-invalid={invalid || undefined}
          aria-describedby={ariaDescribedBy}
          className={cn(controlBoxClass(invalid), 'w-full py-2.5 text-left text-body')}
        >
          {icon && (
            <HugeiconsIcon
              icon={icon}
              size={17}
              strokeWidth={1.5}
              className="shrink-0 text-ink-3"
            />
          )}
          <span className={cn('min-w-0 flex-1 truncate', selectedLabel === null && 'text-ink-3')}>
            {selectedLabel ?? placeholder ?? t('ui.combobox.placeholder')}
          </span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={16}
            strokeWidth={1.5}
            className="shrink-0 text-ink-3"
          />
        </button>
      </PopoverTrigger>
      {/* As wide as the button, but never narrower than a name and a phone number. The popover
          moves the focus to its first focusable element: the search box. */}
      <PopoverContent className="grid w-(--radix-popover-trigger-width) min-w-72 gap-1 p-1">
        <Input
          type="search"
          icon={Search01Icon}
          role="combobox"
          aria-label={searchPlaceholder ?? t('ui.combobox.search')}
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeOption ? `${listId}-${String(active)}` : undefined}
          placeholder={searchPlaceholder ?? t('ui.combobox.search')}
          value={search}
          onChange={(event) => {
            onSearchChange(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        {options.length === 0 ? (
          <p className="px-2.5 py-2 text-body-sm text-ink-3" role="status">
            {loading ? t('ui.combobox.loading') : (emptyText ?? t('ui.combobox.empty'))}
          </p>
        ) : (
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            // The old matches stay while the new ones load (the parent keeps them)
            aria-busy={loading || undefined}
            className="max-h-72 overflow-y-auto"
          >
            {options.map((option, index) => (
              <li
                key={option.value}
                id={`${listId}-${String(index)}`}
                role="option"
                aria-selected={option.value === value}
                // A div-like element: the global cursor rule only covers buttons and links
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-body-sm text-ink-2 select-none',
                  index === active && 'bg-subtle text-ink',
                )}
                onMouseMove={() => {
                  if (index !== active) setActive(index);
                }}
                // Keep the focus in the search box, so the arrows still work after a click
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  choose(option);
                }}
              >
                <span className="grid min-w-0 flex-1">
                  <span className="truncate">{option.label}</span>
                  {option.detail && (
                    <span className="truncate text-caption font-normal text-ink-3 tabular-nums">
                      {option.detail}
                    </span>
                  )}
                </span>
                {option.value === value && (
                  <HugeiconsIcon
                    icon={Tick02Icon}
                    size={16}
                    strokeWidth={1.5}
                    className="shrink-0 text-brand"
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
