import {
  type DocumentFile,
  type DocumentShare,
  LANGUAGE_CODES,
  type LanguageCode,
  type OutputDocument,
} from '@omnivo/contracts';
import { LANGUAGES } from '@omnivo/i18n';

// Step 16: what the document pages and the public page work out for themselves, without React,
// so the unit tests can run it.

// The document the Send menu, the history cards and the dialogs work on. Only a numbered one goes
// out (decision 11), so the page builds this only when the document has its number.
export interface OutputTarget {
  kind: OutputDocument;
  id: string;
  number: string;
  customerId: string;
}

// The language that is not this one: the second item of the Send menu ("Download PDF in বাংলা").
// With two languages there is always one; a third language would make this a list.
export function otherLanguage(language: LanguageCode): LanguageCode {
  return LANGUAGE_CODES.find((code) => code !== language) ?? language;
}

// A language by its own name, the way the language switch shows it (decision 32)
export function languageName(language: LanguageCode): string {
  return LANGUAGES.find((item) => item.code === language)?.label ?? language;
}

export type ShareState = 'active' | 'ended' | 'revoked';

// The API sends dates, not a state: "ended" depends on the clock, and a list that was loaded an
// hour ago must not keep calling a link active that ended since. Turned off wins over ended: the
// person did that on purpose, and the list should say so.
export function shareState(share: DocumentShare, now: Date): ShareState {
  if (share.revokedAt !== null) return 'revoked';
  return new Date(share.expiresAt).getTime() <= now.getTime() ? 'ended' : 'active';
}

export type PdfOutcome =
  | { status: 'ready'; file: DocumentFile }
  | { status: 'failed' }
  // Still pending when the page stopped waiting: the worker is busy, or down
  | { status: 'slow' };

export interface WaitOptions {
  intervalMs?: number;
  // How many times the page asks again before it gives up (with 1.5 s, about 20 s in all)
  attempts?: number;
  // Injected by the tests, so they need not wait for real time
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// The PDF from POST /documents/:kind/:id/files, asked for again until the worker is done with it.
// A file that already existed comes back ready at once, and the loop does not run. Counting
// attempts instead of reading the clock keeps the tests free of fake timers.
export async function waitForPdf(
  first: DocumentFile,
  poll: (fileId: string) => Promise<DocumentFile>,
  { intervalMs = 1500, attempts = 13, sleep = realSleep }: WaitOptions = {},
): Promise<PdfOutcome> {
  let file = first;
  for (let attempt = 0; file.status === 'pending' && attempt < attempts; attempt += 1) {
    await sleep(intervalMs);
    file = await poll(file.id);
  }
  if (file.status === 'ready') return { status: 'ready', file };
  return file.status === 'failed' ? { status: 'failed' } : { status: 'slow' };
}

// Saves the file under its own name. A click on a hidden <a download>, not a page change, like
// step 11's exports: the page stays where it is, and the person keeps reading the invoice.
export function saveFile(file: DocumentFile): void {
  if (file.download === null) return;
  const link = document.createElement('a');
  link.href = file.download.url;
  link.download = file.fileName ?? '';
  link.click();
}
