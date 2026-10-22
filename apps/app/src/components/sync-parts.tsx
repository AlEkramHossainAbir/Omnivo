import { Alert02Icon, Clock01Icon, CloudUploadIcon } from '@hugeicons/core-free-icons';
import type { CustomerField } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import type { OutboxEntry, OutboxStatus } from '@omnivo/sync';
import { Pill } from '@omnivo/ui';
import { useCallback } from 'react';

// Step 18b: the outbox as the screens show it, on the Sync page and above the sales orders list.
// No Dexie here: the entries come through useLocalQuery.

// Three pills, not four (18b.5): a command that waits for another one is `waiting` too, with a
// line that says for which. Waiting and sending are work in progress (brand); a refused command
// needs the person (warn), CLAUDE.md → Sales document statuses.
const PILLS = {
  waiting: { tone: 'brand', icon: Clock01Icon },
  sending: { tone: 'brand', icon: CloudUploadIcon },
  failed: { tone: 'warn', icon: Alert02Icon },
} as const satisfies Record<OutboxStatus, { tone: string; icon: unknown }>;

export function OutboxStatusPill({ status }: { status: OutboxStatus }) {
  const { t } = useLocale();
  const pill = PILLS[status];
  return (
    <Pill tone={pill.tone} icon={pill.icon}>
      {t(`sync.statuses.${status}`)}
    </Pill>
  );
}

// "Not synced": a customer or an order that is only on this device so far
export function NotSyncedPill() {
  const { t } = useLocale();
  return (
    <Pill tone="neutral" icon={CloudUploadIcon}>
      {t('sync.notSynced')}
    </Pill>
  );
}

// The form's own labels for the fields of a change, so the Sync page says "Phone and Credit limit"
// in the words of the boxes the person filled in. satisfies: a new field in the contract does not
// compile until it has its label here.
const FIELD_LABELS = {
  code: 'customers.fields.code',
  name: 'customers.fields.name',
  groupId: 'customers.fields.group',
  contactPerson: 'customers.fields.contactPerson',
  phone: 'customers.fields.phone',
  email: 'customers.fields.email',
  documentLanguage: 'customers.fields.documentLanguage',
  bin: 'customers.fields.bin',
  paymentTermsDays: 'customers.fields.paymentTerms',
  creditLimit: 'customers.fields.creditLimit',
  priceListId: 'customers.fields.priceList',
  notes: 'customers.fields.notes',
} as const satisfies Record<CustomerField, string>;

function isCustomerField(field: string): field is CustomerField {
  return Object.hasOwn(FIELD_LABELS, field);
}

// Field names as one line in the page's language ("Phone and Credit limit" / "ফোন ও ক্রেডিট লিমিট")
export function useFieldList(): (fields: readonly string[]) => string {
  const { t, language } = useLocale();
  return useCallback(
    (fields) =>
      new Intl.ListFormat(language === 'bn' ? 'bn-BD' : 'en', { type: 'conjunction' }).format(
        fields.map((field) => (isCustomerField(field) ? t(FIELD_LABELS[field]) : field)),
      ),
    [t, language],
  );
}

// The two lines of an entry: what it is ("Changes to Rahman Traders") and how big ("Changed:
// Phone and Credit limit", "3 lines · ৳4,140")
export function useCommandText(): (entry: OutboxEntry) => { title: string; detail: string } {
  const { t, format } = useLocale();
  const fieldList = useFieldList();
  return useCallback(
    (entry) => {
      const { command } = entry;
      const title = t(`sync.commands.${command.type}`, { name: entry.name });
      switch (command.type) {
        case 'customer.create':
          return { title, detail: '' };
        case 'customer.update': {
          const { add, remove, change } = command.addresses;
          const fields: string[] = Object.keys(command.changes);
          if (add.length + remove.length + change.length > 0) {
            fields.push(t('customers.sections.addresses'));
          }
          return { title, detail: t('sync.changedFields', { fields: fieldList(fields) }) };
        }
        case 'sales_order.create_draft':
          return {
            title,
            detail: t('sync.orderLines', {
              count: entry.lines ?? 0,
              formatted: format.number(entry.lines ?? 0),
              total: format.money(entry.total ?? '0'),
            }),
          };
      }
    },
    [t, format, fieldList],
  );
}
