import { UserIcon } from '@hugeicons/core-free-icons';
import type { PartyRef, PartyRole } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Combobox, type ComboboxOption } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { type Ref, useMemo, useState } from 'react';

import { partyLabel } from '../lib/customers';
import { customerSearchQuery, supplierSearchQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { useDebounced } from '../lib/use-debounced';

export interface PartyPickerProps {
  id: string;
  name?: string;
  // The chosen party's id, or '' for none
  value: string;
  // The party the line was saved with, so the box can name it before any search ran
  saved: PartyRef | null;
  onChange: (value: string) => void;
  onBlur?: () => void;
  ref?: Ref<HTMLButtonElement>;
  invalid?: boolean | undefined;
  disabled?: boolean | undefined;
  'aria-label'?: string | undefined;
  'aria-describedby'?: string | undefined;
  // A list's filter (step 15b): the first option, '' = every party, and the empty box's text
  allLabel?: string | undefined;
}

// What the box needs from a search result: a customer and a supplier summary both have it
interface PartyMatch {
  id: string;
  code: string;
  name: string;
  phone: string | null;
}

// The words of each side
const WORDS = {
  customer: {
    placeholder: 'journal.customerPlaceholder',
    search: 'customers.pickerSearch',
    empty: 'customers.pickerEmpty',
  },
  supplier: {
    placeholder: 'journal.supplierPlaceholder',
    search: 'suppliers.pickerSearch',
    empty: 'suppliers.pickerEmpty',
  },
} as const satisfies Record<PartyRole, Record<string, string>>;

// The party box of a journal line and of the opening balances (step 15a's customer box, step 17a
// for both sides): ui's Combobox with the search on the server. Active parties only, like the API
// takes them on a new line. A receivable line picks a customer, a payable line a supplier
// (partyRoleOf in the contracts).
// `...box`: id, name, onBlur, ref and the aria props go to the Combobox as they came. Spread, not
// one by one: with exactOptionalPropertyTypes, `name={name}` would pass an explicit undefined.
export function PartyPicker({
  role,
  value,
  saved,
  onChange,
  allLabel,
  ...box
}: PartyPickerProps & { role: PartyRole }) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim(), 250);
  // Both hooks, each enabled for its side only: a hook cannot be called conditionally, and the two
  // queries return different types, so one useQuery over a choice of options would not type-check
  const customers = useQuery({
    ...customerSearchQuery(tenantId, settled),
    enabled: role === 'customer',
  });
  const suppliers = useQuery({
    ...supplierSearchQuery(tenantId, settled),
    enabled: role === 'supplier',
  });
  const found = role === 'customer' ? customers : suppliers;
  const matches: PartyMatch[] | undefined = found.data;
  // The label of what was picked here. A row keeps its own picker (React's key), so a removed row
  // never hands its label to the next one.
  const [picked, setPicked] = useState<{ value: string; label: string } | null>(null);

  const options = useMemo<ComboboxOption[]>(
    () => [
      // A filter can go back to "every customer"; a form's box cannot be emptied this way
      ...(allLabel === undefined ? [] : [{ value: '', label: allLabel }]),
      ...(matches ?? []).map((party) => ({
        value: party.id,
        label: party.name,
        detail: [party.code, party.phone].filter((part) => part !== null).join(' · '),
      })),
    ],
    [matches, allLabel],
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
        const party = matches?.find((item) => item.id === next);
        setPicked({ value: next, label: party ? partyLabel(party) : option.label });
        onChange(next);
      }}
      // Searching for the next word: the old matches stay, marked busy
      loading={found.isFetching}
      icon={UserIcon}
      placeholder={allLabel ?? t(WORDS[role].placeholder)}
      searchPlaceholder={t(WORDS[role].search)}
      emptyText={t(WORDS[role].empty)}
    />
  );
}
