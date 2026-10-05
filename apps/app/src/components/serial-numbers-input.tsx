import { controlBoxClass } from '@omnivo/ui';
import { type Ref, useState } from 'react';

import { parseSerials } from '../lib/stock';

interface SerialNumbersInputProps {
  id: string;
  name?: string;
  // The form keeps a list; the box shows one serial number per line
  value: readonly string[];
  onChange: (value: string[]) => void;
  onBlur?: () => void;
  ref?: Ref<HTMLTextAreaElement>;
  invalid?: boolean;
  'aria-describedby'?: string | undefined;
}

// The serial numbers of a line: a scanner types an IMEI and Enter, so one per line is how they
// arrive. While the box has focus it keeps exactly what was typed (a half-typed number, a trailing
// Enter); the form gets the cleaned list on every key, like MoneyInput does with amounts.
export function SerialNumbersInput({
  id,
  name,
  value,
  onChange,
  onBlur,
  ref,
  invalid = false,
  'aria-describedby': describedBy,
}: SerialNumbersInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className={`${controlBoxClass(invalid)} items-stretch`}>
      <textarea
        ref={ref}
        id={id}
        name={name}
        rows={3}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className="min-w-0 flex-1 resize-y bg-transparent py-2.5 font-mono text-body-sm outline-none"
        value={draft ?? value.join('\n')}
        onFocus={() => {
          setDraft(value.join('\n'));
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          onChange(parseSerials(event.target.value));
        }}
        onBlur={() => {
          setDraft(null);
          onBlur?.();
        }}
      />
    </div>
  );
}
