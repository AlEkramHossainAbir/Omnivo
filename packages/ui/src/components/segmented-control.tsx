import { useId } from 'react';

import { cn } from '../lib/cn.js';

interface SegmentedControlProps<TValue extends string> {
  label: string;
  value: TValue;
  options: readonly { value: TValue; label: string }[];
  onChange: (value: TValue) => void;
}

// ভেতরে আসল radio input: তীর-কী দিয়ে বদলানো, স্ক্রিন রিডারে "২টার ১" — সব ব্রাউজার বিনা খরচে দেয়।
// TValue generic: options-এর মানই onChange-এ ফেরত আসে, string-এ চওড়া হয় না
export function SegmentedControl<TValue extends string>({
  label,
  value,
  options,
  onChange,
}: SegmentedControlProps<TValue>) {
  const name = useId();
  return (
    <fieldset className="inline-flex rounded-lg border border-line-strong bg-surface p-0.5">
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <label
          key={option.value}
          className={cn(
            'cursor-pointer rounded-md px-3 py-1.5 text-body-sm font-medium transition-colors duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand',
            // CLAUDE.md: বাছাই করা segment-এ subtle পটভূমি
            option.value === value ? 'bg-subtle text-ink' : 'text-ink-2 hover:text-ink',
          )}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === value}
            onChange={() => {
              onChange(option.value);
            }}
            className="sr-only"
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}
