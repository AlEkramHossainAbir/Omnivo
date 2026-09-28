import {
  CheckmarkCircle02Icon,
  Clock01Icon,
  InboxIcon,
  PauseCircleIcon,
  PlusSignIcon,
  ScissorIcon,
  Settings01Icon,
  TShirtIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { isLanguage, LANGUAGES, setLanguage, useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  Checkbox,
  DataTable,
  dataTableColumns,
  DatePicker,
  EmptyState,
  FormField,
  IconButton,
  MoneyInput,
  PageHeader,
  parseIsoDate,
  Pill,
  type PillTone,
  SectionHeader,
  SegmentedControl,
  TextField,
  toast,
  toIsoDate,
} from '@omnivo/ui';
import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

// শুধু dev-এ (router.tsx দেখুন) — তাই এই পেজের নিজের লেখা ইংরেজিতেই; ভাষা বদলালে
// component-এর নিজের লেখা, তারিখ, টাকা আর ক্যালেন্ডার কীভাবে বদলায় সেটা দেখাই উদ্দেশ্য

type Stage = 'cutting' | 'sewing' | 'shipped' | 'delayed' | 'on-hold';

// status রং শুধু অর্থের জন্য, আর প্রতিটার সাথে আইকন + লেখা (CLAUDE.md)
const STAGES = {
  cutting: { label: 'Cutting', tone: 'brand', icon: ScissorIcon },
  sewing: { label: 'Sewing', tone: 'brand', icon: TShirtIcon },
  shipped: { label: 'Shipped', tone: 'good', icon: CheckmarkCircle02Icon },
  delayed: { label: 'Delayed', tone: 'warn', icon: Clock01Icon },
  'on-hold': { label: 'On hold', tone: 'neutral', icon: PauseCircleIcon },
} satisfies Record<Stage, { label: string; tone: PillTone; icon: IconSvgElement }>;

interface BuyerPo {
  id: string;
  po: string;
  buyer: string;
  style: string;
  quantity: number;
  // টাকা string — API থেকে যেমন আসবে
  value: string;
  shipBy: string;
  stage: Stage;
}

const BUYERS = [
  'Nordwind Apparel GmbH',
  'Harbor & Pine Co.',
  'Maison Lune SA',
  'Kaito Retail KK',
  'Blue Anchor Ltd',
  'Stellar Kids Inc.',
] as const;
const STYLES = [
  'Knit polo',
  'Crew-neck tee',
  'Fleece hoodie',
  'Denim jacket',
  'Cargo trousers',
  "Ladies' blouse",
] as const;
const STAGE_KEYS = ['cutting', 'sewing', 'shipped', 'delayed', 'on-hold'] as const;

// seed-ওয়ালা ছোট random: প্রতিবার একই ১০,০০০ রো — reload-এ টেবিল বদলায় না, screenshot মেলে
function makePurchaseOrders(count: number): BuyerPo[] {
  let seed = 42;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  // [T, ...T[]]: অন্তত একটা উপাদান — তাই items[0] টাইপে T, undefined না
  const pick = <T,>(items: readonly [T, ...T[]]): T =>
    items[Math.floor(next() * items.length)] ?? items[0];

  return Array.from({ length: count }, (_, index) => {
    const quantity = 200 + Math.floor(next() * 48) * 100;
    const unitPrice = 180 + Math.floor(next() * 1270);
    return {
      id: String(index),
      po: `PO-${String(10000 + index)}`,
      buyer: pick(BUYERS),
      style: pick(STYLES),
      quantity,
      value: `${String(quantity * unitPrice)}.00`,
      shipBy: toIsoDate(new Date(2026, 9, 1 + Math.floor(next() * 120))),
      stage: pick(STAGE_KEYS),
    };
  });
}

// module-level: chunk লোড হওয়ার সময় একবার — DataTable-এর data রেফারেন্স স্থির থাকে
const PURCHASE_ORDERS = makePurchaseOrders(10_000);

const column = dataTableColumns<BuyerPo>();

function PurchaseOrderTable() {
  const { format } = useLocale();
  // format বদলায় শুধু ভাষা বদলালে — তখনই column নতুন করে
  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('po', {
          header: 'PO',
          meta: { card: 'title' },
          // ID তাই monospace (CLAUDE.md → Typography)
          cell: ({ getValue }) => <span className="font-mono font-medium">{getValue()}</span>,
        }),
        column.accessor('buyer', { header: 'Buyer', meta: { card: 'subtitle' } }),
        column.accessor('style', { header: 'Style', meta: { card: 'detail' } }),
        column.accessor('quantity', {
          header: 'Qty (pcs)',
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => format.number(getValue()),
        }),
        column.accessor('value', {
          header: 'Value',
          meta: { align: 'end', card: 'trailing' },
          cell: ({ getValue }) => format.money(getValue()),
        }),
        column.accessor('shipBy', {
          header: 'Ship by',
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const date = parseIsoDate(getValue());
            return date ? format.date(date) : '';
          },
        }),
        column.accessor('stage', {
          header: 'Status',
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const stage = STAGES[getValue()];
            return (
              <Pill tone={stage.tone} icon={stage.icon}>
                {stage.label}
              </Pill>
            );
          },
        }),
      ]),
    [format],
  );

  return (
    <DataTable
      label="Buyer purchase orders"
      data={PURCHASE_ORDERS}
      columns={columns}
      getRowId={(po) => po.id}
      showCount
      onRowClick={(po) => {
        toast(`${po.po} opened`);
      }}
    />
  );
}

const lcSchema = z.object({
  lcNumber: z.string().trim().min(3, 'Enter the LC number, like LC 0126-2409.'),
  // MoneyInput সবসময় "" অথবা ঠিক ২ ঘর দশমিক দেয়
  amount: z.string().regex(/^\d+\.\d{2}$/, 'Enter the LC amount.'),
  shipBy: z.string().min(1, 'Pick the latest shipment date.'),
  bank: z.string().trim(),
  partialShipment: z.boolean(),
});

function LetterOfCreditForm() {
  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(lcSchema),
    defaultValues: { lcNumber: '', amount: '', shipBy: '', bank: '', partialShipment: false },
  });

  const onSubmit = handleSubmit((values) => {
    toast(`${values.lcNumber} saved as draft`);
  });

  return (
    <form noValidate onSubmit={(event) => void onSubmit(event)} className="grid gap-5 p-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField
          label="LC number"
          placeholder="LC 0126-2409"
          {...register('lcNumber')}
          error={errors.lcNumber?.message}
        />
        <TextField
          label="Issuing bank"
          optional
          hint="Leave empty if the buyer has not named one yet."
          placeholder="Dutch-Bangla Bank"
          {...register('bank')}
          error={errors.bank?.message}
        />
        <FormField control={control} name="amount" label="LC amount">
          {(field) => <MoneyInput {...field} placeholder="0.00" />}
        </FormField>
        <FormField control={control} name="shipBy" label="Latest shipment date">
          {(field) => <DatePicker {...field} />}
        </FormField>
      </div>
      <Controller
        control={control}
        name="partialShipment"
        render={({ field }) => (
          <Checkbox
            id="partialShipment"
            label="Allow partial shipment"
            checked={field.value}
            onCheckedChange={(checked) => {
              field.onChange(checked === true);
            }}
          />
        )}
      />
      <div className="flex justify-end border-t border-line pt-5">
        <Button type="submit">Save draft</Button>
      </div>
    </form>
  );
}

type Theme = 'system' | 'light' | 'dark';

const THEMES = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const;

// CLAUDE.md: data-theme OS-এর পছন্দকে দুই দিকেই হারায়; না থাকলে prefers-color-scheme
function applyTheme(theme: Theme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = theme;
}

export function KitchenSinkPage() {
  const { language, format } = useLocale();
  const [theme, setTheme] = useState<Theme>('system');
  const today = new Date();

  return (
    <div className="grid max-w-6xl gap-5">
      <PageHeader
        title="Kitchen sink"
        description="Every shared component, in both themes and both languages."
        actions={
          <>
            <SegmentedControl
              label="Theme"
              value={theme}
              options={THEMES}
              onChange={(next) => {
                setTheme(next);
                applyTheme(next);
              }}
            />
            <SegmentedControl
              label="Language"
              value={language}
              options={LANGUAGES.map((option) => ({ value: option.code, label: option.label }))}
              onChange={(next) => {
                if (isLanguage(next)) void setLanguage(next);
              }}
            />
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Buttons and status" subtitle="One primary button per view" />
          <div className="grid gap-4 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => {
                  toast('Workspace created');
                }}
              >
                Show toast
              </Button>
              <Button variant="secondary">Export</Button>
              <Button variant="secondary" size="sm">
                Retry
              </Button>
              <Button disabled>Disabled</Button>
              <IconButton icon={Settings01Icon} label="Settings" />
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.values(STAGES).map((stage) => (
                <Pill key={stage.label} tone={stage.tone} icon={stage.icon}>
                  {stage.label}
                </Pill>
              ))}
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Formatting" subtitle="Follows the selected language" />
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 p-5 text-body-sm">
            <dt className="text-ink-3">Money</dt>
            <dd className="tabular-nums">{format.money('1842600')}</dd>
            <dt className="text-ink-3">Unit price</dt>
            <dd className="tabular-nums">{format.money('184.5', { decimals: 2 })}</dd>
            <dt className="text-ink-3">Quantity</dt>
            <dd className="tabular-nums">{format.number(4800)}</dd>
            <dt className="text-ink-3">Date</dt>
            <dd className="tabular-nums">{format.date(today)}</dd>
            <dt className="text-ink-3">Period</dt>
            <dd>{format.month(today)}</dd>
          </dl>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Form"
          subtitle="React Hook Form + Zod, with money, date and checkbox controls"
        />
        <LetterOfCreditForm />
      </Card>

      <Card>
        <CardHeader title="Empty state" />
        <EmptyState
          icon={InboxIcon}
          title="No buyer POs yet"
          description="Record a buyer PO to track cutting, sewing and shipment against the LC."
          action={
            <Button size="sm">
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              Add buyer PO
            </Button>
          }
        />
      </Card>

      <section className="grid gap-3">
        <SectionHeader
          title="Data table"
          subtitle="10,000 buyer POs, virtualized. Cards below 860px. Click a header to sort."
        />
        <PurchaseOrderTable />
      </section>
    </div>
  );
}
