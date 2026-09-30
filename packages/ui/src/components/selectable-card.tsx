import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { useId } from 'react';

import { cn } from '../lib/cn.js';

export interface SelectableCardOption<TValue extends string> {
  value: TValue;
  icon: IconSvgElement;
  title: string;
  description: string;
}

interface SelectableCardGroupProps<TValue extends string> {
  // Read by screen readers before each card ("Business type, Garments & textiles, radio, 1 of 6").
  // Hidden on screen: the page title above already says what is being picked.
  legend: string;
  options: readonly SelectableCardOption<TValue>[];
  // null = nothing picked yet
  value: TValue | null;
  onChange: (value: TValue) => void;
}

// CLAUDE.md → Selectable card: pick one of a few big choices (the business type). Same idea as
// SegmentedControl: a real radio input inside each label, so arrow keys, form semantics and "1 of
// 6" come from the browser. TValue: the picked option's own type comes back, not a plain string.
export function SelectableCardGroup<TValue extends string>({
  legend,
  options,
  value,
  onChange,
}: SelectableCardGroupProps<TValue>) {
  const name = useId();
  return (
    <fieldset className="grid gap-3 sm:grid-cols-2">
      <legend className="sr-only">{legend}</legend>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <label
            key={option.value}
            className={cn(
              // relative: keeps the sr-only radio inside this box (see Checkbox for the phone bug
              // an escaped sr-only element once caused). cursor-pointer: a label without htmlFor
              // is not covered by the global pointer rule.
              'relative flex cursor-pointer items-start gap-3 rounded-control border p-3.5 shadow-sm transition-colors duration-150 has-[:focus-visible]:shadow-ring',
              selected
                ? 'border-brand bg-brand-soft'
                : 'border-line-strong bg-surface hover:bg-subtle',
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={selected}
              onChange={() => {
                onChange(option.value);
              }}
              className="sr-only"
            />
            <span
              className={cn(
                'grid size-9 shrink-0 place-items-center rounded-lg transition-colors duration-150',
                selected ? 'bg-brand text-brand-ink' : 'bg-subtle text-ink-3',
              )}
            >
              <HugeiconsIcon icon={option.icon} size={18} strokeWidth={1.5} />
            </span>
            <span className="min-w-0">
              <span className="block text-body-sm font-medium text-ink">{option.title}</span>
              <span className="block text-label text-ink-3">{option.description}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
