import { UserIcon } from '@hugeicons/core-free-icons';
import type { PartyRef, PartyRole } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { findCustomers, type SyncDatabase } from '@omnivo/sync';
import { Combobox, type ComboboxOption } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { type Ref, useCallback, useMemo, useState } from 'react';

import { partyLabel } from '../lib/customers';
import { useLocalData, useLocalQuery } from '../lib/local-data';
import { supplierSearchQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { useDebounced } from '../lib/use-debounced';
import { useLocalStateText } from './local-state';

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
// for both sides): ui's Combobox. Active parties only, like the API takes them on a new line.
// Step 18a: a customer is searched on the device (decision 5), online or not; a supplier is not on
// the device, so it is still searched on the server. A receivable line picks a customer, a payable line a supplier
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
  // Both reads, each for its side only: a hook cannot be called conditionally
  const { view } = useLocalData();
  const stateText = useLocalStateText();
  const find = useCallback((db: SyncDatabase) => findCustomers(db, settled), [settled]);
  const customers = useLocalQuery(role === 'customer' && view.kind === 'ready' ? find : null);
  const suppliers = useQuery({
    ...supplierSearchQuery(tenantId, settled),
    enabled: role === 'supplier',
  });
  const matches: PartyMatch[] | undefined = role === 'customer' ? customers : suppliers.data;
  // A customer box on a device without a copy says why it is empty ("This device is not set up
  // yet"), instead of "No active customer matches"
  const emptyText =
    role === 'customer' && view.kind !== 'ready'
      ? (stateText(view) ?? t(WORDS.customer.empty))
      : t(WORDS[role].empty);
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
      // Searching the server for the next word: the old matches stay, marked busy. The device
      // answers within a frame, so there is nothing to show for a customer.
      loading={role === 'supplier' && suppliers.isFetching}
      icon={UserIcon}
      placeholder={allLabel ?? t(WORDS[role].placeholder)}
      searchPlaceholder={t(WORDS[role].search)}
      emptyText={emptyText}
    />
  );
}
