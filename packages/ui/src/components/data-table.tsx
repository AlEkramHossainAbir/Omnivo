import { ArrowDown01Icon, ArrowUp01Icon, ArrowUpDownIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';
import {
  type Column,
  createColumnHelper,
  createSortedRowModel,
  type Header,
  metaHelper,
  type ReactTable,
  type Row,
  type RowData,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_text,
  type TableOptions,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import { useVirtualizer, useWindowVirtualizer } from '@tanstack/react-virtual';
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react';

import { cn } from '../lib/cn.js';
import { DESKTOP_QUERY, useMediaQuery } from '../lib/use-media-query.js';

export interface DataTableColumnMeta {
  // CLAUDE.md: সংখ্যা ডানে
  align?: 'start' | 'end';
  // ফোনে কার্ডের কোন জায়গায় বসবে। না দিলে কার্ডে দেখাবে না — ফোনে ২–৩টা জরুরি তথ্যই যথেষ্ট
  card?: 'title' | 'subtitle' | 'trailing' | 'detail';
}

// v9-এ feature গুলো স্পষ্ট করে নিবন্ধন করতে হয় — যেটা নেই তার কোড bundle-এও যায় না।
// columnMeta: শুধু টাইপ (runtime-এ কিছু না), column-এর meta এখন DataTableColumnMeta
export const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  // sortFn: 'auto' এই তিনটার মধ্যে থেকে বাছে; পুরো registry নিলে সব comparator bundle-এ যেত
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic, text: sortFn_text },
  columnMeta: metaHelper<DataTableColumnMeta>(),
});

type Features = typeof dataTableFeatures;

// app-এ column লেখার helper: accessor-এর key আর মানের টাইপ TData থেকে আসে
export function dataTableColumns<TData extends RowData>() {
  return createColumnHelper<Features, TData>();
}

interface DataTableProps<TData extends RowData> {
  // স্ক্রিন রিডারের জন্য টেবিলের নাম (<caption>)
  label: string;
  // রেফারেন্স স্থির রাখুন (useMemo/state) — প্রতি render-এ নতুন array দিলে প্রতিবার আবার sort হয়
  data: TData[];
  // লাইব্রেরির নিজের option টাইপ — helper.columns([...]) যা ফেরত দেয় তা সরাসরি বসে
  columns: TableOptions<Features, TData>['columns'];
  // index না, আসল id: sort বা ডেটা বদলালেও একই রো একই key পায়
  getRowId: (row: TData) => string;
  // ডেটা খালি হলে (সাধারণত <EmptyState />)
  empty?: ReactNode;
  onRowClick?: ((row: TData) => void) | undefined;
  // ডেস্কটপে scroll বাক্সের সর্বোচ্চ উচ্চতা (px)
  maxHeight?: number;
  // নিচে "10,000 rows" — বড় তালিকায় কাজের, ৩ জনের টিমে শুধু গোলমাল
  showCount?: boolean;
}

// টেবিল নিজেই একটা কার্ড (border, কোণ, ছায়া) — তাই আরেকটা Card-এর ভেতরে না বসিয়ে
// section শিরোনামের নিচে সরাসরি বসান, নাহলে কার্ডের ভেতরে কার্ড হয় (CLAUDE.md: সব কিছু কার্ড না)
export function DataTable<TData extends RowData>({
  label,
  data,
  columns,
  getRowId,
  empty,
  onRowClick,
  maxHeight = 560,
  showCount = false,
}: DataTableProps<TData>) {
  const { t, format } = useLocale();
  const table = useTable({
    features: dataTableFeatures,
    data,
    columns,
    getRowId: (row) => getRowId(row),
  });
  // দুই রকম DOM (টেবিল আর কার্ড), কারণ virtualizer-কে মাপার জন্য আসল দৃশ্যমান element লাগে —
  // CSS দিয়ে একটা লুকালে লুকানোটার উচ্চতা ০, virtualizer ভুল হিসাব করত
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const rows = table.getRowModel().rows;

  if (rows.length === 0) return <>{empty}</>;

  return (
    <div className="grid gap-2">
      {isDesktop ? (
        <DesktopTable
          table={table}
          rows={rows}
          label={label}
          maxHeight={maxHeight}
          onRowClick={onRowClick}
        />
      ) : (
        <MobileCards rows={rows} table={table} label={label} onRowClick={onRowClick} />
      )}
      {showCount && (
        <p className="text-caption text-ink-3">
          {t('ui.dataTable.rowCount', {
            count: rows.length,
            formatted: format.number(rows.length),
          })}
        </p>
      )}
    </div>
  );
}

// ক্লিক করা যায় এমন রো/কার্ড কীবোর্ডেও খোলা যাবে: Enter বা Space
function activateOnKey(event: KeyboardEvent, activate: () => void): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    activate();
  }
}

// কলামের নাম লেখায়: header string হলে সেটাই, template (JSX) হলে column id।
// লাগে দুই জায়গায় — sort বাটনের aria-label আর ফোনের কার্ডে "লেবেল: মান"
function columnLabel<TData extends RowData>(column: Column<Features, TData>): string {
  const header = column.columnDef.header;
  return typeof header === 'string' ? header : column.id;
}

interface ViewProps<TData extends RowData> {
  table: ReactTable<Features, TData>;
  rows: Row<Features, TData>[];
  label: string;
  onRowClick: ((row: TData) => void) | undefined;
}

// টেবিলের প্রতিটা রো প্রায় এত উঁচু: 13.5px × 1.45 লাইন + 24px padding + 1px রেখা
const ROW_HEIGHT = 45;

function DesktopTable<TData extends RowData>({
  table,
  rows,
  label,
  maxHeight,
  onRowClick,
}: ViewProps<TData> & { maxHeight: number }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.id ?? index,
    // দৃশ্যমানের বাইরেও কয়েকটা রো আগে থেকে — দ্রুত scroll-এ ফাঁকা ঝলক দেখা যায় না
    overscan: 10,
  });
  const items = virtualizer.getVirtualItems();
  // শুধু দৃশ্যমান রো DOM-এ; উপরে-নিচে ফাঁকা রো দিয়ে মোট উচ্চতা ঠিক রাখা, তাই scrollbar সঠিক।
  // <table> রাখা হয়েছে (div-grid না): কলামের চওড়া ব্রাউজার নিজে মেলায়, স্ক্রিন রিডারও টেবিল চেনে
  const paddingTop = items[0]?.start ?? 0;
  const paddingBottom = virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0);
  const columnCount = table.getAllLeafColumns().length;

  return (
    // overflow-auto: চওড়া টেবিল নিজের বাক্সে আড়াআড়ি scroll করে, পুরো পেজ না (CLAUDE.md)
    <div
      ref={scrollRef}
      className="overflow-auto rounded-card border border-line bg-surface shadow-sm"
      style={{ maxHeight }}
    >
      <table className="w-full border-collapse text-body-sm">
        <caption className="sr-only">{label}</caption>
        {/* sticky thead-এর border scroll-এ সরে যায়, তাই নিচের রেখা inset shadow দিয়ে */}
        <thead className="sticky top-0 z-10 bg-subtle shadow-[inset_0_-1px_0_var(--color-line)]">
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => (
                <HeaderCell key={header.id} header={header} table={table} />
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {paddingTop > 0 && (
            <tr aria-hidden="true">
              <td colSpan={columnCount} style={{ height: paddingTop }} />
            </tr>
          )}
          {items.map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            const open = onRowClick
              ? () => {
                  onRowClick(row.original);
                }
              : undefined;
            return (
              <tr
                key={row.id}
                // measureElement আসল উচ্চতা মাপে (লম্বা নাম দুই লাইনে গেলেও ঠিক থাকে);
                // data-index না দিলে কোন রো মাপা হলো virtualizer বুঝত না
                data-index={item.index}
                ref={virtualizer.measureElement}
                tabIndex={open ? 0 : undefined}
                onClick={open}
                onKeyDown={
                  open
                    ? (event) => {
                        activateOnKey(event, open);
                      }
                    : undefined
                }
                className={cn(
                  'border-t border-line transition-colors duration-150 first:border-t-0 hover:bg-subtle',
                  open && 'cursor-pointer',
                )}
              >
                {row.getAllCells().map((cell) => (
                  <td
                    key={cell.id}
                    className={cn(
                      'px-5 py-3 whitespace-nowrap',
                      cell.column.columnDef.meta?.align === 'end' && 'text-right tabular-nums',
                    )}
                  >
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            );
          })}
          {paddingBottom > 0 && (
            <tr aria-hidden="true">
              <td colSpan={columnCount} style={{ height: paddingBottom }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function HeaderCell<TData extends RowData>({
  header,
  table,
}: {
  header: Header<Features, TData>;
  table: ReactTable<Features, TData>;
}) {
  const { t } = useLocale();
  const column = header.column;
  const end = column.columnDef.meta?.align === 'end';
  const sorted = column.getIsSorted();
  const toggle = column.getToggleSortingHandler();
  const content = header.isPlaceholder ? null : <table.FlexRender header={header} />;

  return (
    <th
      scope="col"
      // স্ক্রিন রিডার এখান থেকে জানে কোন কলামে কোন দিকে সাজানো
      aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
      className={cn(
        'px-5 py-2.5 text-caption font-medium whitespace-nowrap text-ink-3',
        end ? 'text-right' : 'text-left',
      )}
    >
      {column.getCanSort() && toggle ? (
        <button
          type="button"
          onClick={toggle}
          aria-label={t('ui.dataTable.sortBy', { column: columnLabel(column) })}
          className={cn('inline-flex items-center gap-1 hover:text-ink', end && 'flex-row-reverse')}
        >
          {content}
          <HugeiconsIcon
            icon={
              sorted === 'asc'
                ? ArrowUp01Icon
                : sorted === 'desc'
                  ? ArrowDown01Icon
                  : ArrowUpDownIcon
            }
            size={13}
            strokeWidth={1.5}
            className={sorted ? 'text-ink' : 'text-ink-3'}
          />
        </button>
      ) : (
        content
      )}
    </th>
  );
}

// ফোনের কার্ড-তালিকা পুরো পেজের scroll ব্যবহার করে (window virtualizer): ফোনে বাক্সের ভেতরে
// আলাদা scroll আঙুলে আটকে যায়, আর পেজের scroll-এর সাথে লড়াই করে
function MobileCards<TData extends RowData>({ table, rows, label, onRowClick }: ViewProps<TData>) {
  const listRef = useRef<HTMLUListElement>(null);
  // তালিকার শুরু পেজের উপর থেকে কত নিচে — window scroll থেকে এটা বাদ দিয়ে কোন কার্ড দেখা যাচ্ছে বোঝা যায়
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const top = listRef.current?.getBoundingClientRect().top ?? 0;
    setScrollMargin(top + window.scrollY);
  }, []);

  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => 96,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: 6,
    scrollMargin,
  });

  return (
    <ul
      ref={listRef}
      aria-label={label}
      className="relative"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((item) => {
        const row = rows[item.index];
        if (!row) return null;
        return (
          <li
            key={row.id}
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="absolute inset-x-0 top-0 pb-2"
            style={{ transform: `translateY(${String(item.start - scrollMargin)}px)` }}
          >
            <RowCard row={row} table={table} onRowClick={onRowClick} />
          </li>
        );
      })}
    </ul>
  );
}

function RowCard<TData extends RowData>({
  row,
  table,
  onRowClick,
}: {
  row: Row<Features, TData>;
  table: ReactTable<Features, TData>;
  onRowClick: ((row: TData) => void) | undefined;
}) {
  const cells = row.getAllCells();
  const slot = (name: DataTableColumnMeta['card']) =>
    cells.filter((cell) => cell.column.columnDef.meta?.card === name);
  const details = slot('detail');
  const open = onRowClick
    ? () => {
        onRowClick(row.original);
      }
    : undefined;

  return (
    <div
      // কার্ডের ভেতরে <dl> আছে, <button>-এর ভেতরে যা বসানো বৈধ না — তাই div + role="button"
      role={open ? 'button' : undefined}
      tabIndex={open ? 0 : undefined}
      onClick={open}
      onKeyDown={
        open
          ? (event) => {
              activateOnKey(event, open);
            }
          : undefined
      }
      className="rounded-card border border-line bg-surface p-4 shadow-sm transition-colors duration-150"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 text-body-sm">
          {slot('title').map((cell) => (
            <div key={cell.id} className="font-medium text-ink">
              <table.FlexRender cell={cell} />
            </div>
          ))}
          {slot('subtitle').map((cell) => (
            <div key={cell.id} className="text-caption text-ink-3">
              <table.FlexRender cell={cell} />
            </div>
          ))}
        </div>
        <div className="shrink-0 text-right text-body-sm tabular-nums">
          {slot('trailing').map((cell) => (
            <div key={cell.id}>
              <table.FlexRender cell={cell} />
            </div>
          ))}
        </div>
      </div>
      {details.length > 0 && (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line pt-3">
          {details.map((cell) => (
            <div key={cell.id} className="min-w-0">
              <dt className="text-caption text-ink-3">{columnLabel(cell.column)}</dt>
              <dd className="truncate text-body-sm">
                <table.FlexRender cell={cell} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
