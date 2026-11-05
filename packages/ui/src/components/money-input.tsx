import { formatNumber } from '@omnivo/i18n';
import { useState } from 'react';

import { isMoneyDraft, normalizeMoneyInput, toCanonicalMoney } from '../lib/money.js';
import { Input, type InputProps } from './field.js';

export interface DecimalInputProps extends Omit<
  InputProps,
  'value' | 'defaultValue' | 'onChange' | 'type' | 'inputMode' | 'align'
> {
  // টাকা কখনো number না — string, যেমন DB-র NUMERIC(19,4) আর contracts-এর schema
  value: string;
  onChange: (value: string) => void;
  // দশমিকের ঘর: টাকা ২, unit price চাইলে ৪
  scale?: number;
}

// The money box's typing rules for any decimal: Bangla digits accepted, grouped when not focused,
// the form value always a canonical string. MoneyInput adds the ৳; DiscountInput adds its % / ৳
// select. Not exported from the package: a page uses one of those two.
export function DecimalInput({
  value,
  onChange,
  onFocus,
  onBlur,
  scale = 2,
  ...props
}: DecimalInputProps) {
  // null = এখন লেখা হচ্ছে না, তাই গোছানো রূপ দেখাও; string = ইউজার যা টাইপ করছে হুবহু
  const [draft, setDraft] = useState<string | null>(null);

  // টাইপের সময় কমা বসালে cursor লাফিয়ে যেত — তাই গ্রুপিং শুধু focus ছাড়লে।
  // ইনপুটে সবসময় ইংরেজি অঙ্ক (en): বাংলা অঙ্কে সম্পাদনা অনেক কীবোর্ডে ঝামেলার
  const display = draft ?? (value === '' ? '' : formatNumber(value, 'en', scale));

  return (
    <Input
      {...props}
      type="text"
      // ফোনে সংখ্যার কীবোর্ড, দশমিক বিন্দু সহ (system-design §৮.১)
      inputMode="decimal"
      autoComplete="off"
      align="end"
      value={display}
      onFocus={(event) => {
        // সার্ভারের "1842600.5000" (৪ ঘর) এলেও সম্পাদনা শুরু হয় scale-এর রূপে, নইলে
        // isMoneyDraft প্রতিটা কী চাপ আটকে দিত
        const plain = value === '' ? '' : toCanonicalMoney(value, scale);
        const input = event.currentTarget;
        // Swap the text now, in the focus event, and select all of it. Left to React's next render,
        // the new text would replace the old one after the browser selected it (Tab selects the whole
        // box), the caret would jump to the end, and typing would add to the old amount instead of
        // replacing it. React then finds the text it wants already there and leaves it. A click selects
        // it all too; a second click puts the caret where it lands, as the box already has the focus.
        if (input.value !== plain) {
          input.value = plain;
          input.select();
        }
        setDraft(plain);
        onFocus?.(event);
      }}
      onChange={(event) => {
        const next = normalizeMoneyInput(event.target.value);
        // অবৈধ কী চাপ (অক্ষর, দ্বিতীয় বিন্দু, তৃতীয় দশমিক) চুপচাপ উপেক্ষা — লেখা বদলায় না
        if (!isMoneyDraft(next, scale)) return;
        setDraft(next);
        // প্রতিটা কী চাপে canonical মান ফর্মে: focus-এ থেকেই Enter চাপলে blur হয় না,
        // তখনও "12." না, "12.00" জমা পড়বে
        onChange(toCanonicalMoney(next, scale));
      }}
      onBlur={(event) => {
        setDraft(null);
        onBlur?.(event);
      }}
    />
  );
}

type MoneyInputProps = Omit<DecimalInputProps, 'prefix'>;

export function MoneyInput(props: MoneyInputProps) {
  return <DecimalInput {...props} prefix="৳" />;
}
