import {
  ArrowDown01Icon,
  Mail01Icon,
  Pdf01Icon,
  SentIcon,
  WhatsappIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { type LanguageCode, routes, SEND_PERMISSIONS } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';

import { call } from '../lib/api';
import {
  languageName,
  otherLanguage,
  type OutputTarget,
  saveFile,
  waitForPdf,
} from '../lib/document-output';
import { useCan } from '../lib/permissions';
import { customerQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { failureOf } from './journal-parts';

// Step 16: the Send menu in the header of a quotation, an invoice, a money receipt and a credit
// note. A lazy chunk of its own, loaded by those four pages: it brings Radix's dropdown (with its
// positioning code), and inside the pages' chunks the menu and the history cards took the invoice
// page from 68 KB to 108 KB, over its 100 KB budget.
// The two dialogs are one more chunk (document-dialogs.tsx), loaded when one opens: they bring the
// form library. They share no module with this file that is not already shared with other pages:
// the bundler would fold such a module into this chunk, the dialogs' chunk would import this one,
// and the budget check would count the dropdown a second time for the dialogs.
const EmailForm = lazy(async () => ({
  default: (await import('./document-dialogs')).EmailForm,
}));
const ShareForm = lazy(async () => ({
  default: (await import('./document-dialogs')).ShareForm,
}));

function useTenant(): string {
  return useSession((state) => state.me?.tenant.id) ?? '';
}

// The customer's document language and phone (the document carries only the customer's name and
// code). null while the customer loads; English if it cannot be read, so Download still works.
function useCustomerOf(customerId: string): {
  language: LanguageCode;
  phone: string | null;
} | null {
  const customer = useQuery(customerQuery(useTenant(), customerId));
  if (customer.data) {
    return { language: customer.data.documentLanguage, phone: customer.data.phone };
  }
  return customer.isError ? { language: 'en', phone: null } : null;
}

// Download PDF: ask for the file, wait while the worker draws it, then save it. A second click
// while the first one waits does nothing: the button says "Making the PDF…" and is disabled.
function useDownload(target: OutputTarget) {
  const { t, errorText } = useLocale();
  const { kind, id } = target;
  return useMutation({
    mutationFn: async (language: LanguageCode) =>
      waitForPdf(
        await call(routes.documentOutput.file, { params: { kind, id }, body: { language } }),
        (fileId) => call(routes.documentOutput.getFile, { params: { kind, id, fileId } }),
      ),
    onSuccess: (outcome) => {
      if (outcome.status === 'ready') saveFile(outcome.file);
      else
        toast(
          t(outcome.status === 'failed' ? 'documentOutput.pdfFailed' : 'documentOutput.pdfSlow'),
        );
    },
    onError: (error) => {
      toast(errorText(failureOf(error) ?? 'unknown_error'));
    },
  });
}

// One "Send" menu next to Print (decision 29). Someone who may not send the document still may
// download it (decision 10): they get a single button instead of a menu with one item.
export function SendMenu({ target }: { target: OutputTarget }) {
  const { t } = useLocale();
  const canSend = useCan()(SEND_PERMISSIONS[target.kind]);
  const customer = useCustomerOf(target.customerId);
  const download = useDownload(target);
  const [dialog, setDialog] = useState<'email' | 'share' | null>(null);
  const busy = download.isPending || customer === null;

  if (!canSend || customer === null) {
    return (
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() => {
          if (customer) download.mutate(customer.language);
        }}
      >
        <HugeiconsIcon icon={Pdf01Icon} size={17} strokeWidth={1.5} />
        {download.isPending ? t('documentOutput.preparing') : t('documentOutput.downloadPdf')}
      </Button>
    );
  }

  const other = otherLanguage(customer.language);
  return (
    <>
      {/* modal={false}: the menu opens a dialog; a modal menu would leave the page's
          pointer-events off while the dialog takes over the focus */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" disabled={busy}>
            <HugeiconsIcon icon={SentIcon} size={17} strokeWidth={1.5} />
            {download.isPending ? t('documentOutput.preparing') : t('documentOutput.send')}
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={16}
              strokeWidth={1.5}
              className="text-ink-3"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            icon={Pdf01Icon}
            onSelect={() => {
              download.mutate(customer.language);
            }}
          >
            {t('documentOutput.downloadPdf')}
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={Pdf01Icon}
            onSelect={() => {
              download.mutate(other);
            }}
          >
            {t('documentOutput.downloadPdfIn', { language: languageName(other) })}
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={Mail01Icon}
            onSelect={() => {
              setDialog('email');
            }}
          >
            {t('documentOutput.email')}
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={WhatsappIcon}
            onSelect={() => {
              setDialog('share');
            }}
          >
            {t('documentOutput.share')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <Suspense fallback={null}>
          {dialog === 'email' && (
            <EmailForm
              target={target}
              language={customer.language}
              onDone={() => {
                setDialog(null);
              }}
            />
          )}
          {dialog === 'share' && (
            <ShareForm target={target} language={customer.language} phone={customer.phone} />
          )}
        </Suspense>
      </Dialog>
    </>
  );
}
