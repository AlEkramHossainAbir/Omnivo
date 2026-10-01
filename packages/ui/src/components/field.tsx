import { Alert02Icon, ArrowDown01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';
import { type ComponentProps, type ReactNode, useId } from 'react';

import { cn } from '../lib/cn.js';

// control-এর aria-describedby: error থাকলে স্ক্রিন রিডার error পড়বে, নাহলে hint
export function describedBy(
  id: string,
  error: string | undefined,
  hint: string | undefined,
): string | undefined {
  if (error) return `${id}-error`;
  if (hint) return `${id}-hint`;
  return undefined;
}

export interface FieldProps {
  id: string;
  label: string;
  // `| undefined`: exactOptionalPropertyTypes-এ caller নিজের optional prop সরাসরি পাঠাতে পারে
  optional?: boolean | undefined;
  hint?: string | undefined;
  error?: string | undefined;
  children: ReactNode;
}

// সব ফর্ম-ফিল্ডের একই কাঠামো: উপরে label, মাঝে control, নিচে error (নয়তো hint)
export function Field({ id, label, optional = false, hint, error, children }: FieldProps) {
  const { t, errorText } = useLocale();
  return (
    // content-start: পাশের ফিল্ডে hint থাকলে grid-এর সারি উঁচু হয়; তখন এই ফিল্ডের ভেতরের
    // সারিগুলো টেনে লম্বা না করে উপরে জড়ো থাকে — ইনপুটের উচ্চতা সব জায়গায় ৪২px।
    // grid-cols-1 (minmax(0, 1fr)): without it the column is as wide as the <input>'s own default
    // width (about 20 characters), so a field in a narrow column (the 140px Code) ran under its
    // neighbour. Found in step 9; the branch form had it too.
    <div className="grid grid-cols-1 content-start gap-1.5">
      <label htmlFor={id} className="text-label font-medium text-ink">
        {label}
        {optional && <span className="font-normal text-ink-3"> {t('common.optional')}</span>}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="flex items-center gap-1.5 text-label text-crit">
          <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
          {/* ফর্মের error এখন code ('slug_taken') — বর্তমান ভাষায় লেখা এখানেই */}
          {errorText(error)}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="text-label text-ink-3">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

// input আর date picker-এর বাটন — দুটোই দেখতে একই বাক্স, তাই class এক জায়গায়
export function controlBoxClass(invalid: boolean): string {
  return cn(
    'flex min-h-[42px] items-center gap-2.5 rounded-control border bg-surface px-3 shadow-sm transition-[border-color,box-shadow] duration-150',
    invalid
      ? 'border-crit focus-within:shadow-ring-crit'
      : 'border-line-strong hover:border-ink-3 focus-within:border-brand focus-within:shadow-ring',
  );
}

// `prefix` HTML-এর নিজস্ব attribute (RDFa) — এখানে অন্য মানে, তাই Omit করে নতুন করে বলা
export interface InputProps extends Omit<ComponentProps<'input'>, 'className' | 'prefix'> {
  icon?: IconSvgElement | undefined;
  prefix?: string | undefined;
  suffix?: string | undefined;
  trailing?: ReactNode;
  invalid?: boolean | undefined;
  align?: 'start' | 'end';
}

export function Input({
  icon,
  prefix,
  suffix,
  trailing,
  invalid = false,
  align = 'start',
  ...input
}: InputProps) {
  return (
    <div className={controlBoxClass(invalid)}>
      {icon && (
        <HugeiconsIcon icon={icon} size={17} strokeWidth={1.5} className="shrink-0 text-ink-3" />
      )}
      {prefix && <span className="text-body text-ink-2">{prefix}</span>}
      <input
        aria-invalid={invalid || undefined}
        className={cn(
          'min-w-0 flex-1 bg-transparent py-2.5 text-body outline-none placeholder:text-ink-3',
          // টাকার মতো সংখ্যা ডানে মেলানো, আর প্রতিটা অঙ্ক সমান চওড়া — কলামে সারি মেলে
          align === 'end' && 'text-right tabular-nums',
        )}
        {...input}
      />
      {suffix && <span className="text-body-sm whitespace-nowrap text-ink-3">{suffix}</span>}
      {trailing}
    </div>
  );
}

export interface TextFieldProps extends Omit<InputProps, 'invalid' | 'id'> {
  label: string;
  id?: string;
  optional?: boolean | undefined;
  hint?: string | undefined;
  // exactOptionalPropertyTypes: caller `errors.email?.message` (string | undefined) সরাসরি দিতে পারে
  error?: string | undefined;
}

// react-hook-form-এর register('email') সরাসরি spread করা যায়: name, ref, onChange, onBlur
export function TextField({ id, label, optional, hint, error, ...input }: TextFieldProps) {
  const autoId = useId();
  // register() id দেয় না, name দেয় — label-এর htmlFor-এর জন্য সেটাই যথেষ্ট
  const fieldId = id ?? input.name ?? autoId;
  return (
    <Field id={fieldId} label={label} optional={optional} hint={hint} error={error}>
      <Input
        id={fieldId}
        invalid={Boolean(error)}
        aria-describedby={describedBy(fieldId, error, hint)}
        {...input}
      />
    </Field>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps extends Omit<ComponentProps<'select'>, 'className' | 'id'> {
  label: string;
  id?: string;
  options: readonly SelectOption[];
  icon?: IconSvgElement | undefined;
  optional?: boolean | undefined;
  hint?: string | undefined;
  error?: string | undefined;
}

// আসল <select>, Radix-এর বানানো না: ফোনে OS-এর নিজের চাকা/তালিকা খোলে (বড়, আঙুলে সহজ), কীবোর্ড আর
// স্ক্রিন রিডার বিনা খরচে, আর bundle-এ এক লাইনও JS যোগ হয় না। দেখতে Input-এর মতোই বাক্স।
// register('x', { valueAsNumber: true }) সরাসরি spread করা যায় — সংখ্যার ঘরে string আসে না
export function SelectField({
  id,
  label,
  options,
  icon,
  optional,
  hint,
  error,
  ...select
}: SelectFieldProps) {
  const autoId = useId();
  const fieldId = id ?? select.name ?? autoId;
  return (
    <Field id={fieldId} label={label} optional={optional} hint={hint} error={error}>
      <div className={controlBoxClass(Boolean(error))}>
        {icon && (
          <HugeiconsIcon icon={icon} size={17} strokeWidth={1.5} className="shrink-0 text-ink-3" />
        )}
        <select
          id={fieldId}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={describedBy(fieldId, error, hint)}
          // appearance-none: ব্রাউজারের নিজের তীর মুছে আমাদের আইকন; bg-transparent: dark mode-এ
          // Windows-এর সাদা বাক্স না
          className="min-w-0 flex-1 appearance-none bg-transparent py-2.5 text-body outline-none"
          {...select}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={16}
          strokeWidth={1.5}
          // pointer-events-none: তীরে ক্লিক করলেও নিচের select খোলে
          className="pointer-events-none shrink-0 text-ink-3"
        />
      </div>
    </Field>
  );
}

export interface TextAreaFieldProps extends Omit<ComponentProps<'textarea'>, 'className' | 'id'> {
  label: string;
  id?: string;
  optional?: boolean | undefined;
  hint?: string | undefined;
  error?: string | undefined;
}

// ঠিকানার মতো কয়েক লাইনের লেখা — Input-এর একই বাক্স, উচ্চতা ৩ লাইন, নিচে টেনে বড় করা যায়
export function TextAreaField({
  id,
  label,
  optional,
  hint,
  error,
  ...textarea
}: TextAreaFieldProps) {
  const autoId = useId();
  const fieldId = id ?? textarea.name ?? autoId;
  return (
    <Field id={fieldId} label={label} optional={optional} hint={hint} error={error}>
      <div className={cn(controlBoxClass(Boolean(error)), 'items-stretch')}>
        <textarea
          id={fieldId}
          rows={3}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={describedBy(fieldId, error, hint)}
          className="min-w-0 flex-1 resize-y bg-transparent py-2.5 text-body outline-none placeholder:text-ink-3"
          {...textarea}
        />
      </div>
    </Field>
  );
}
