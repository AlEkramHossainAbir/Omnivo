import { Alert02Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import { type ComponentProps, type ReactNode, useId } from 'react';

import { cn } from '../lib/cn.js';

interface CheckboxProps extends Omit<
  ComponentProps<typeof CheckboxPrimitive.Root>,
  'className' | 'children' | 'id'
> {
  id: string;
  label: ReactNode;
  // লেখা শুধু স্ক্রিন রিডারের জন্য — যেমন permission matrix-এর ঘর, যেখানে সারি আর কলামের শিরোনামই
  // চোখের লেবেল। label তবু বাধ্যতামূলক: লেখা ছাড়া চেকবক্স স্ক্রিন রিডারে শুধু "checkbox"
  hideLabel?: boolean | undefined;
}

// CLAUDE.md → Checkbox: ১৭px, ৫px কোণ, checked-এ brand ভরাট। native checkbox-এর রং আর
// কোণ সব ব্রাউজারে বদলানো যায় না, তাই Radix (ভেতরে button role="checkbox", কীবোর্ডে Space)
export function Checkbox({ id, label, hideLabel = false, ...props }: CheckboxProps) {
  return (
    // relative: লুকানো লেখা (sr-only = position: absolute) এই বাক্সের ভেতরেই থাকে। না থাকলে সেটা
    // সবচেয়ে কাছের positioned পূর্বপুরুষে — প্রায়ই পুরো পেজে — বসে, আড়াআড়ি scroll-এর বাক্স থেকে বেরিয়ে
    // পেজকেই চওড়া করত (permission matrix-এ ফোনে ৩৯০ → ৬৬১px, ধরা পড়েছে Playwright-এ)
    <div className="relative flex items-start gap-2.5">
      <CheckboxPrimitive.Root
        id={id}
        // disabled: ৬০% — বাটনের মতোই; cursor: not-allowed আসে global base layer থেকে
        className="mt-px grid size-[17px] shrink-0 place-items-center rounded-[5px] border border-line-strong bg-surface shadow-sm transition-colors duration-150 hover:border-ink-3 disabled:opacity-60 data-[state=checked]:border-brand data-[state=checked]:bg-brand"
        {...props}
      >
        <CheckboxPrimitive.Indicator className="text-brand-ink">
          <HugeiconsIcon icon={Tick02Icon} size={13} strokeWidth={1.5} />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <label htmlFor={id} className={cn('text-body-sm text-ink-2', hideLabel && 'sr-only')}>
        {label}
      </label>
    </div>
  );
}

export interface CheckboxOption {
  value: string;
  label: ReactNode;
  disabled?: boolean | undefined;
}

interface CheckboxGroupProps {
  legend: string;
  options: readonly CheckboxOption[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  hint?: string | undefined;
  // error code, Field-এর মতোই — বর্তমান ভাষায় লেখা এখানে
  error?: string | undefined;
}

// কয়েকটা থেকে একাধিক বাছা (invite-এর রোল, পরে onboarding-এর মডিউল)। fieldset + legend: স্ক্রিন
// রিডার প্রতিটা চেকবক্সের আগে দলের নাম পড়ে ("Roles, Accountant, checkbox")। দেখতে Field-এর মতো:
// উপরে লেবেল, নিচে hint বা error
export function CheckboxGroup({
  legend,
  options,
  value,
  onChange,
  hint,
  error,
}: CheckboxGroupProps) {
  const { errorText } = useLocale();
  const id = useId();
  return (
    <fieldset
      className="grid gap-1.5"
      aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
    >
      <legend className="mb-1.5 text-label font-medium text-ink">{legend}</legend>
      <div className="grid gap-2.5 rounded-control border border-line p-3">
        {options.map((option) => (
          <Checkbox
            key={option.value}
            id={`${id}-${option.value}`}
            label={option.label}
            disabled={option.disabled}
            checked={value.includes(option.value)}
            onCheckedChange={(checked) => {
              onChange(
                checked === true
                  ? [...value, option.value]
                  : value.filter((selected) => selected !== option.value),
              );
            }}
          />
        ))}
      </div>
      {error ? (
        <p id={`${id}-error`} className="flex items-center gap-1.5 text-label text-crit">
          <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
          {errorText(error)}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="text-label text-ink-3">
            {hint}
          </p>
        )
      )}
    </fieldset>
  );
}
