import { UserIcon } from '@hugeicons/core-free-icons';
import type { PartyRef } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Combobox, type ComboboxOption } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { type Ref, useMemo, useState } from 'react';

import { partyLabel } from '../lib/customers';
import { customerSearchQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { useDebounced } from '../lib/use-debounced';

interface CustomerPickerProps {
  id: string;
  name?: string;
  // The chosen customer's id, or '' for none
  value: string;
  // The customer the line was saved with, so the box can name it before any search ran
  saved: PartyRef | null;
  onChange: (value: string) => void;
  onBlur?: () => void;
  ref?: Ref<HTMLButtonElement>;
  invalid?: boolean | undefined;
  disabled?: boolean | undefined;
  'aria-label'?: string | undefined;
  'aria-describedby'?: string | undefined;
}

// The customer box of a journal line and of the opening balances (step 15a): ui's Combobox with
// the search on the server. Active customers only, like the API takes them on a new line.
// `...box`: id, name, onBlur, ref and the aria props go to the Combobox as they came. Spread, not
// one by one: with exactOptionalPropertyTypes, `name={name}` would pass an explicit undefined.
export function CustomerPicker({ value, saved, onChange, ...box }: CustomerPickerProps) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim(), 250);
  const { data, isFetching } = useQuery(customerSearchQuery(tenantId, settled));
  // The label of what was picked here. A row keeps its own picker (React's key), so a removed row
  // never hands its label to the next one.
  const [picked, setPicked] = useState<{ value: string; label: string } | null>(null);

  const options = useMemo<ComboboxOption[]>(
    () =>
      (data ?? []).map((customer) => ({
        value: customer.id,
        label: customer.name,
        detail: [customer.code, customer.phone].filter((part) => part !== null).join(' · '),
      })),
    [data],
  );

  const selectedLabel =
    value === ''
      ? null
      : picked?.value === value
        ? picked.label
        : saved?.id === value
          ? partyLabel(saved)
          : null;

  return (
    <Combobox
      {...box}
      value={value}
      selectedLabel={selectedLabel}
      options={options}
      search={search}
      onSearchChange={setSearch}
      onChange={(next, option) => {
        const customer = data?.find((item) => item.id === next);
        setPicked({ value: next, label: customer ? partyLabel(customer) : option.label });
        onChange(next);
      }}
      // Searching for the next word: the old matches stay, marked busy
      loading={isFetching}
      icon={UserIcon}
      placeholder={t('journal.customerPlaceholder')}
      searchPlaceholder={t('customers.pickerSearch')}
      emptyText={t('customers.pickerEmpty')}
    />
  );
}
