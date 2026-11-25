import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Copy01Icon,
  Csv01Icon,
  FileImportIcon,
  FileNotFoundIcon,
  HelpCircleIcon,
  HourglassIcon,
  InformationCircleIcon,
  TaskDone01Icon,
  Upload04Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import {
  MAX_PAYOUT_CSV_CHARS,
  PAYOUT_CSV_KEYS,
  type PayoutCsvKey,
  type PayoutCsvMap,
  type PayoutMatch,
  type PayoutMatchOutcome,
  type PayoutMatchRow,
  type PayoutParcel,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, DialogClose, DialogContent, FormAlert, Pill, SelectField } from '@omnivo/ui';
import { useRef, useState } from 'react';

import { ApiRequestError, call } from '../lib/api';
import { outcomeCounts, sortMatchRows, tickableCount } from '../lib/storefront-payouts';
import { DocumentNotice } from './document-notice';

// Step 28c: "Match a payout file" (decisions 10–12, mine 18 and 19, approved with the mockup, P5).
// Its own chunk. The browser reads the CSV and POSTs its text to the match route: no upload, no
// storage, nothing kept but the column map. Three steps in one dialog: choose the file, pick the
// columns (only when the saved map or the Steadfast preset names a column the file lacks, or there
// is no map at all), then the result, one line per row of the file.

// The outcome pills (approved with the mockup). Found is good; what the member must look at is
// warn (another amount, a number we don't know, a row that can't be read); what only says why
// nothing was ticked is neutral
const OUTCOME_PILLS = {
  matched: { tone: 'good', icon: CheckmarkCircle02Icon },
  different: { tone: 'warn', icon: Alert02Icon },
  unknown: { tone: 'warn', icon: HelpCircleIcon },
  invalid: { tone: 'warn', icon: FileNotFoundIcon },
  twice: { tone: 'neutral', icon: Copy01Icon },
  already_paid: { tone: 'neutral', icon: TaskDone01Icon },
  not_ready: { tone: 'neutral', icon: HourglassIcon },
} as const satisfies Record<
  PayoutMatchOutcome,
  { tone: 'good' | 'warn' | 'neutral'; icon: IconSvgElement }
>;

// The mapping step's values: '' = nothing picked yet for the parcel's column, or "Not in the file"
// for an amount column
interface MapValues {
  key: PayoutCsvKey;
  keyColumn: string;
  collectedColumn: string;
  chargeColumn: string;
}

type Step =
  | { kind: 'choose' }
  | {
      kind: 'map';
      csv: string;
      file: string;
      columns: string[];
      missing: string[];
      start: MapValues;
    }
  | { kind: 'result'; csv: string; file: string; match: PayoutMatch };

// The map the API used (saved or preset) as the mapping step's start: a column the file lacks
// starts empty, so the member picks the file's own
function startValues(map: PayoutCsvMap | null, columns: readonly string[]): MapValues {
  const has = (name: string | null | undefined): string =>
    name != null && columns.includes(name) ? name : '';
  return {
    key: map?.key ?? 'invoice',
    keyColumn: has(map?.keyColumn),
    collectedColumn: has(map?.collectedColumn),
    chargeColumn: has(map?.chargeColumn),
  };
}

export function PayoutFileDialog({
  accountId,
  accountName,
  parcels,
  onApply,
}: {
  accountId: string;
  accountName: string;
  // The parcels the page lists: what a row may tick, and the receipt's amount for "Other amount"
  parcels: readonly PayoutParcel[];
  onApply: (rows: readonly PayoutMatchRow[], fileNet: string | null) => void;
}) {
  const { t, format } = useLocale();
  const input = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  const [busy, setBusy] = useState<'reading' | 'matching' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const money = (value: string) => format.money(value, { decimals: 2 });

  // One POST for both the first try (map null: the saved map, else the preset) and the mapping
  // step's (the member's map, which the API keeps for the account's next file)
  const match = async (csv: string, file: string, map: PayoutCsvMap | null) => {
    setBusy('matching');
    setFailure(null);
    try {
      const answer = await call(routes.storefrontPayouts.match, {
        params: { id: accountId },
        body: { csv, map },
      });
      if (answer.map === null || answer.missing.length > 0) {
        setStep({
          kind: 'map',
          csv,
          file,
          columns: answer.columns,
          missing: answer.missing,
          start: startValues(answer.map, answer.columns),
        });
      } else {
        setStep({ kind: 'result', csv, file, match: answer });
      }
    } catch (error) {
      setFailure(error instanceof ApiRequestError ? error.code : 'unknown_error');
    } finally {
      setBusy(null);
    }
  };

  const choose = async (file: File | undefined) => {
    if (file === undefined) return;
    // Over 1 MB is refused here, before the browser reads it: the API refuses it too, but only
    // after the whole file went up
    if (file.size > MAX_PAYOUT_CSV_CHARS) {
      setFailure('payout_csv_too_big');
      return;
    }
    setBusy('reading');
    setFailure(null);
    // UTF-8, as Steadfast's panel and Excel's "CSV UTF-8" write it. The API drops a byte order
    // mark, so a file Excel saved reads the same
    const csv = await file.text();
    await match(csv, file.name, null);
  };

  const chooseAgain = () => {
    setStep({ kind: 'choose' });
    setFailure(null);
    // The same file picked again must fire onChange, so the input forgets the last one
    if (input.current) input.current.value = '';
  };

  const fileInput = (
    <input
      ref={input}
      type="file"
      accept=".csv,text/csv"
      className="sr-only"
      tabIndex={-1}
      aria-hidden="true"
      onChange={(event) => {
        void choose(event.target.files?.[0]);
      }}
    />
  );

  const title = t('storefront.payout.csv.title');
  const description = t('storefront.payout.csv.description', { name: accountName });
  const cancel = (
    <DialogClose asChild>
      <Button variant="secondary">{t('common.cancel')}</Button>
    </DialogClose>
  );

  if (step.kind === 'choose') {
    return (
      <DialogContent
        title={title}
        description={description}
        className="max-w-[560px]"
        footer={cancel}
      >
        {failure !== null && <FormAlert message={failure} />}
        <div className="grid justify-items-center gap-3 rounded-control border border-dashed border-line-strong px-6 py-6 text-center">
          <span className="grid size-10 place-items-center rounded-lg bg-brand-soft text-brand">
            <HugeiconsIcon icon={FileImportIcon} size={18} strokeWidth={1.5} />
          </span>
          {fileInput}
          <Button
            variant="secondary"
            disabled={busy !== null}
            onClick={() => {
              input.current?.click();
            }}
          >
            <HugeiconsIcon icon={Upload04Icon} size={17} strokeWidth={1.5} />
            {busy === 'reading'
              ? t('storefront.payout.csv.reading')
              : busy === 'matching'
                ? t('storefront.payout.csv.matching')
                : t('storefront.payout.csv.choose')}
          </Button>
          <p className="max-w-sm text-label text-ink-3">{t('storefront.payout.csv.fileHint')}</p>
        </div>
      </DialogContent>
    );
  }

  if (step.kind === 'map') {
    return (
      <MapStep
        title={title}
        description={description}
        accountName={accountName}
        file={step.file}
        columns={step.columns}
        missing={step.missing}
        start={step.start}
        busy={busy !== null}
        failure={failure}
        onBack={chooseAgain}
        onMatch={(map) => void match(step.csv, step.file, map)}
      />
    );
  }

  // The result
  const rows = sortMatchRows(step.match.rows);
  const counts = outcomeCounts(rows);
  const ticks = tickableCount(parcels, rows);
  const collectedOf = new Map(parcels.map((parcel) => [parcel.shipmentId, parcel.collected]));
  const lineOf = (row: PayoutMatchRow): string | null => {
    switch (row.outcome) {
      case 'matched':
        return null;
      case 'different':
        return t('storefront.payout.csv.different', {
          file: money(row.fileCollected ?? '0'),
          ours: money(
            (row.shipmentId === null ? undefined : collectedOf.get(row.shipmentId)) ?? '0',
          ),
        });
      case 'already_paid':
        return t('storefront.payout.csv.alreadyPaid', { payout: row.payout?.number ?? '—' });
      case 'not_ready':
        return t('storefront.payout.csv.notReady');
      case 'unknown':
        return t('storefront.payout.csv.unknown', { name: accountName });
      case 'twice':
        return t('storefront.payout.csv.twice');
      case 'invalid':
        return t('storefront.payout.csv.invalid');
    }
  };
  const map = step.match.map;

  return (
    <DialogContent
      title={title}
      description={description}
      className="max-w-[560px]"
      footer={
        <>
          {ticks > 0 && (
            <p className="mr-auto max-w-56 text-label text-ink-3">
              {t('storefront.payout.csv.applyHint')}
            </p>
          )}
          <Button variant="secondary" onClick={chooseAgain}>
            {t('storefront.payout.csv.otherFile')}
          </Button>
          {ticks > 0 ? (
            <Button
              onClick={() => {
                onApply(step.match.rows, step.match.fileNet);
              }}
            >
              {t('storefront.payout.csv.apply', {
                count: ticks,
                formatted: format.number(ticks),
              })}
            </Button>
          ) : (
            cancel
          )}
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2 text-body-sm text-ink-2">
        <HugeiconsIcon icon={Csv01Icon} size={17} strokeWidth={1.5} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{step.file}</span>
        {map !== null && (
          <button
            type="button"
            className="text-body-sm font-medium text-brand underline-offset-3 hover:underline"
            onClick={() => {
              setStep({
                kind: 'map',
                csv: step.csv,
                file: step.file,
                columns: step.match.columns,
                missing: [],
                start: startValues(map, step.match.columns),
              });
            }}
          >
            {t('storefront.payout.csv.changeColumns')}
          </button>
        )}
      </div>
      {counts.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={t('storefront.payout.csv.title')}>
          {counts.map(({ outcome, count }) => (
            <li key={outcome}>
              <Pill tone={OUTCOME_PILLS[outcome].tone} icon={OUTCOME_PILLS[outcome].icon}>
                {t('storefront.payout.csv.outcomeCount', {
                  label: t(`storefront.payout.csv.outcomes.${outcome}`),
                  formatted: format.number(count),
                })}
              </Pill>
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 && (
        // The rows scroll inside their box: a 300-parcel payout keeps the buttons in view
        <ol className="grid max-h-80 overflow-y-auto rounded-control border border-line">
          {rows.map((row) => {
            const line = lineOf(row);
            const pill = OUTCOME_PILLS[row.outcome];
            return (
              <li
                key={row.row}
                className="grid gap-1 border-t border-line px-3.5 py-2.5 first:border-t-0"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm">
                  <span className="text-caption text-ink-3 tabular-nums">
                    {t('storefront.payout.csv.row', { row: format.number(row.row) })}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono font-medium">
                    {row.key === '' ? '—' : row.key}
                  </span>
                  <Pill tone={pill.tone} icon={pill.icon}>
                    {t(`storefront.payout.csv.outcomes.${row.outcome}`)}
                  </Pill>
                </div>
                {line !== null && <p className="text-caption text-ink-3">{line}</p>}
              </li>
            );
          })}
        </ol>
      )}
      {ticks === 0 && (
        <p className="flex items-center gap-1.5 text-label text-crit">
          <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
          {t('storefront.payout.csv.noneToTick')}
        </p>
      )}
    </DialogContent>
  );
}

// The mapping step: the file's own columns in three selects and the kind of number that names a
// parcel. Plain state, not a form library: four selects, and the API checks the map again
function MapStep({
  title,
  description,
  accountName,
  file,
  columns,
  missing,
  start,
  busy,
  failure,
  onBack,
  onMatch,
}: {
  title: string;
  description: string;
  accountName: string;
  file: string;
  columns: readonly string[];
  // The saved map's or the preset's columns this file lacks; [] when there was no map at all
  missing: readonly string[];
  start: MapValues;
  busy: boolean;
  failure: string | null;
  onBack: () => void;
  onMatch: (map: PayoutCsvMap) => void;
}) {
  const { t } = useLocale();
  const [values, setValues] = useState(start);
  const set = (next: Partial<MapValues>) => {
    setValues((current) => ({ ...current, ...next }));
  };
  const columnOptions = columns.map((name) => ({ value: name, label: name }));
  const amountOptions = [
    { value: '', label: t('storefront.payout.csv.columnNone') },
    ...columnOptions,
  ];
  return (
    <DialogContent
      title={title}
      description={description}
      className="max-w-[560px]"
      footer={
        <>
          <Button variant="secondary" className="mr-auto" onClick={onBack}>
            {t('storefront.payout.csv.otherFile')}
          </Button>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button
            disabled={busy || values.keyColumn === ''}
            onClick={() => {
              onMatch({
                key: values.key,
                keyColumn: values.keyColumn,
                collectedColumn: values.collectedColumn === '' ? null : values.collectedColumn,
                chargeColumn: values.chargeColumn === '' ? null : values.chargeColumn,
              });
            }}
          >
            {busy ? t('storefront.payout.csv.matching') : t('storefront.payout.csv.match')}
          </Button>
        </>
      }
    >
      {failure !== null && <FormAlert message={failure} />}
      <div className="flex items-center gap-2 text-body-sm text-ink-2">
        <HugeiconsIcon icon={Csv01Icon} size={17} strokeWidth={1.5} className="shrink-0" />
        <span className="min-w-0 truncate">{file}</span>
      </div>
      <h4 className="text-h3">{t('storefront.payout.csv.mapTitle')}</h4>
      <DocumentNotice tone="neutral" icon={InformationCircleIcon}>
        {missing.length > 0
          ? t('storefront.payout.csv.mapMissing', {
              names: missing.map((name) => `“${name}”`).join(', '),
            })
          : t('storefront.payout.csv.mapFirst', { name: accountName })}
      </DocumentNotice>
      <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
        <SelectField
          label={t('storefront.payout.csv.key')}
          value={values.key}
          onChange={(event) => {
            const key = PAYOUT_CSV_KEYS.find((candidate) => candidate === event.target.value);
            if (key !== undefined) set({ key });
          }}
          options={PAYOUT_CSV_KEYS.map((key) => ({
            value: key,
            label: t(`storefront.payout.csv.keys.${key}`),
          }))}
        />
        <SelectField
          label={t('storefront.payout.csv.keyColumn')}
          value={values.keyColumn}
          onChange={(event) => {
            set({ keyColumn: event.target.value });
          }}
          options={[
            { value: '', label: t('storefront.payout.csv.columnPlaceholder') },
            ...columnOptions,
          ]}
        />
        <SelectField
          label={t('storefront.payout.csv.collectedColumn')}
          hint={t('storefront.payout.csv.collectedHint')}
          value={values.collectedColumn}
          onChange={(event) => {
            set({ collectedColumn: event.target.value });
          }}
          options={amountOptions}
        />
        <SelectField
          label={t('storefront.payout.csv.chargeColumn')}
          hint={t('storefront.payout.csv.chargeHint')}
          value={values.chargeColumn}
          onChange={(event) => {
            set({ chargeColumn: event.target.value });
          }}
          options={amountOptions}
        />
      </div>
    </DialogContent>
  );
}
