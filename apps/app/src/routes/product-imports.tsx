import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  Download04Icon,
  FileImportIcon,
  Upload04Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  createProductImportInputSchema,
  DEFAULT_SETTINGS,
  isErrorCode,
  PRODUCT_IMPORT_MAX_ERRORS,
  type ProductImport,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  DataTable,
  dataTableColumns,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  FormAlert,
  PageHeader,
  Pill,
  SectionHeader,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';

import { ApiRequestError, call } from '../lib/api';
import { useCan } from '../lib/permissions';
import { importTemplate } from '../lib/products';
import {
  productFieldsQuery,
  productImportQuery,
  productImportsQuery,
  settingsQuery,
} from '../lib/queries';
import { useSession } from '../lib/session-store';

const column = dataTableColumns<ProductImport>();

function StatusPill({ status }: { status: ProductImport['status'] }) {
  const { t } = useLocale();
  if (status === 'done') {
    return (
      <Pill tone="good" icon={CheckmarkCircle02Icon}>
        {t('imports.statuses.done')}
      </Pill>
    );
  }
  if (status === 'failed') {
    return (
      <Pill tone="crit" icon={Alert02Icon}>
        {t('imports.statuses.failed')}
      </Pill>
    );
  }
  return (
    <Pill tone="warn" icon={Clock01Icon}>
      {t(`imports.statuses.${status}`)}
    </Pill>
  );
}

// A file the browser makes itself (the template): a Blob, a hidden link, a click
function saveText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

// The problems of one failed import, row by row
function Problems({ importId, onClose }: { importId: string; onClose: () => void }) {
  const { t, errorText } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const detail = useQuery(productImportQuery(tenantId, importId)).data;
  if (!detail) return null;
  return (
    <DialogContent
      title={t('imports.problemsTitle', { file: detail.fileName })}
      description={t('imports.problemsDescription')}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      <div className="max-h-[60vh] overflow-auto rounded-control border border-line">
        <table className="w-full border-collapse text-body-sm">
          <thead className="sticky top-0 bg-subtle text-left text-caption text-ink-3">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                {t('imports.row')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t('imports.column')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t('imports.problem')}
              </th>
            </tr>
          </thead>
          <tbody>
            {detail.errors.map((problem, index) => (
              <tr key={index} className="border-t border-line align-top">
                <td className="px-3 py-2 tabular-nums">{problem.row ?? t('imports.wholeFile')}</td>
                <td className="px-3 py-2 font-mono text-caption text-ink-2">
                  {problem.column ?? '—'}
                </td>
                <td className="px-3 py-2 text-ink-2">
                  {isErrorCode(problem.code)
                    ? errorText(problem.code, problem.params)
                    : problem.code}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {detail.errorCount > detail.errors.length && (
        <p className="mt-3 text-label text-ink-3">
          {t('imports.moreProblems', {
            shown: Math.min(detail.errors.length, PRODUCT_IMPORT_MAX_ERRORS),
            count: detail.errorCount,
          })}
        </p>
      )}
    </DialogContent>
  );
}

export function ProductImportsPage() {
  const { t, format } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const canManage = useCan()('inventory.product.manage');
  const { data: imports, isError } = useQuery({
    ...productImportsQuery(tenantId),
    enabled: canManage,
  });
  const fields = useQuery(productFieldsQuery(tenantId)).data;
  const timeZone = useQuery(settingsQuery(tenantId)).data?.timezone ?? DEFAULT_SETTINGS.timezone;
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [showing, setShowing] = useState<string | null>(null);

  // Three steps, like a logo upload (step 6): the row and an address, the file straight to
  // storage, then "start" — the API checks the stored file before the worker is asked
  const upload = useMutation({
    mutationFn: async (picked: File) => {
      const ticket = await call(routes.productImports.create, {
        body: { fileName: picked.name, sizeBytes: picked.size },
      });
      const put = await fetch(ticket.upload.url, {
        method: ticket.upload.method,
        headers: ticket.upload.headers,
        body: picked,
      });
      if (!put.ok) throw new Error(`Upload failed with ${String(put.status)}`);
      return call(routes.productImports.start, { params: { id: ticket.import.id } });
    },
    onSuccess: async (started) => {
      await queryClient.invalidateQueries({ queryKey: productImportsQuery(tenantId).queryKey });
      toast(t('imports.started', { file: started.fileName }));
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
    },
  });

  const pick = (picked: File | null) => {
    setFile(picked);
    if (!picked) {
      setProblem(null);
      return;
    }
    // The same schema as the API: a .xlsx or a 6 MB file is refused before any upload
    const checked = createProductImportInputSchema.safeParse({
      fileName: picked.name,
      sizeBytes: picked.size,
    });
    const code = checked.error?.issues[0]?.message;
    setProblem(code !== undefined && isErrorCode(code) ? code : null);
  };

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('fileName', {
          header: t('imports.columns.file'),
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-medium">{row.original.fileName}</span>
              <span className="text-caption text-ink-3">
                {format.dateTime(new Date(row.original.createdAt), timeZone)}
              </span>
            </span>
          ),
        }),
        column.accessor((item) => item.requestedBy.fullName, {
          id: 'by',
          header: t('imports.columns.by'),
          meta: { card: 'subtitle' },
        }),
        column.accessor('status', {
          header: t('imports.columns.status'),
          meta: { card: 'trailing' },
          cell: ({ getValue }) => <StatusPill status={getValue()} />,
        }),
        column.accessor((item) => item.productCount ?? item.errorCount, {
          id: 'result',
          header: t('imports.columns.result'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ row }) => {
            const item = row.original;
            if (item.status === 'done') {
              const count = item.productCount ?? 0;
              return t('imports.products', { count, formatted: format.number(count) });
            }
            if (item.status !== 'failed') return '—';
            return (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setShowing(item.id);
                }}
              >
                {t('imports.showProblems')} · {t('imports.problems', { count: item.errorCount })}
              </Button>
            );
          },
        }),
      ]),
    [t, format, timeZone],
  );

  if (!canManage) {
    return (
      <div className="grid max-w-4xl grid-cols-1 gap-5">
        <PageHeader title={t('imports.title')} description={t('imports.description')} />
        <p className="text-body-sm text-ink-3">{t('imports.readOnly')}</p>
      </div>
    );
  }

  const failure =
    upload.error instanceof ApiRequestError
      ? upload.error.code
      : upload.error
        ? 'unknown_error'
        : undefined;

  return (
    <div className="grid max-w-4xl grid-cols-1 gap-5">
      <PageHeader
        title={t('imports.title')}
        description={t('imports.description')}
        actions={
          <Button
            variant="secondary"
            disabled={!fields}
            onClick={() => {
              saveText('omnivo-products-template.csv', importTemplate(fields ?? []));
            }}
          >
            <HugeiconsIcon icon={Download04Icon} size={17} strokeWidth={1.5} />
            {t('imports.template')}
          </Button>
        }
      />
      <Card>
        <CardHeader title={t('imports.howTitle')} />
        <div className="grid gap-5 p-5">
          <ol className="grid list-decimal gap-2 pl-5 text-body-sm text-ink-2">
            <li>{t('imports.how.template')}</li>
            <li>{t('imports.how.save')}</li>
            <li>{t('imports.how.upload')}</li>
          </ol>
          {failure && <FormAlert message={failure} />}
          <form
            noValidate
            className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
            onSubmit={(event) => {
              event.preventDefault();
              if (file && problem === null) upload.mutate(file);
            }}
          >
            <Field
              id="import-file"
              label={t('imports.file')}
              hint={t('imports.fileHint')}
              error={problem ?? undefined}
            >
              <input
                ref={fileInput}
                id="import-file"
                type="file"
                accept=".csv,text/csv"
                aria-describedby={problem ? 'import-file-error' : 'import-file-hint'}
                className="min-h-[42px] rounded-control border border-line-strong bg-surface px-3 py-2 text-body-sm shadow-sm file:mr-3 file:rounded-lg file:border-0 file:bg-subtle file:px-3 file:py-1 file:text-body-sm file:font-medium file:text-ink"
                onChange={(event) => {
                  pick(event.target.files?.[0] ?? null);
                }}
              />
            </Field>
            <Button
              type="submit"
              disabled={!file || problem !== null || upload.isPending}
              className="sm:mb-[26px]"
            >
              <HugeiconsIcon icon={Upload04Icon} size={17} strokeWidth={1.5} />
              {upload.isPending ? t('imports.uploading') : t('imports.submit')}
            </Button>
          </form>
        </div>
      </Card>
      <SectionHeader title={t('imports.history')} subtitle={t('imports.historySubtitle')} />
      {isError && <p className="text-body-sm text-crit">{t('imports.loadFailed')}</p>}
      {imports && (
        <DataTable
          label={t('imports.history')}
          data={imports}
          columns={columns}
          getRowId={(item) => item.id}
          empty={
            <EmptyState
              icon={FileImportIcon}
              title={t('imports.emptyTitle')}
              description={t('imports.emptyBody')}
            />
          }
        />
      )}
      <Dialog
        open={showing !== null}
        onOpenChange={(open) => {
          if (!open) setShowing(null);
        }}
      >
        {showing !== null && (
          <Problems
            importId={showing}
            onClose={() => {
              setShowing(null);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
