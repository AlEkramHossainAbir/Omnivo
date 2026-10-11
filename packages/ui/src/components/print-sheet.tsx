import { Fragment, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// One row of the document's details, top right: "No." and "INV-2026-27-0001"
export interface PrintMeta {
  label: string;
  value: string;
}

interface PrintSheetProps {
  // The company's logo (an <img>), or nothing
  logo?: ReactNode;
  company: string;
  // Under the company's name: the address, the BIN, the phone
  companyLines?: readonly string[];
  // The document's name, like "Invoice"
  title: string;
  meta: readonly PrintMeta[];
  children: ReactNode;
  // The lines people sign at the foot, like "Received by" and "Authorised signature"
  signatures?: readonly string[];
  // A small line at the very bottom, like when it was printed
  footer?: string;
}

// A document as it goes on paper: the browser's Print (or Save as PDF) prints this and nothing
// else (styles.css → @media print). It is hidden on the screen, where the page itself shows the
// document. It is rendered straight into <body>, outside the app, so the print rule can hide
// everything around it by one selector.
export function PrintSheet({
  logo,
  company,
  companyLines = [],
  title,
  meta,
  children,
  signatures = [],
  footer,
}: PrintSheetProps) {
  return createPortal(
    <article data-print-sheet="" className="hidden bg-surface text-body-sm text-ink print:block">
      <header className="flex items-start justify-between gap-8 border-b border-ink pb-4">
        <div className="flex min-w-0 items-start gap-3">
          {logo}
          <div className="min-w-0">
            <p className="text-h3 font-semibold">{company}</p>
            {companyLines.map((line, index) => (
              // An address may repeat a line (two branches on one road); the index keeps keys unique
              <p key={`${String(index)}-${line}`} className="text-caption text-ink-2">
                {line}
              </p>
            ))}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <h1 className="text-h2">{title}</h1>
          <dl className="mt-2 grid grid-cols-[auto_auto] justify-end gap-x-3 gap-y-0.5 text-caption">
            {meta.map((item) => (
              <Fragment key={item.label}>
                <dt className="text-ink-3">{item.label}</dt>
                <dd className="font-medium tabular-nums">{item.value}</dd>
              </Fragment>
            ))}
          </dl>
        </div>
      </header>
      <div className="mt-5 grid gap-5">{children}</div>
      {signatures.length > 0 && (
        // break-inside-avoid: the signature lines never split over two pages
        <footer className="mt-16 grid break-inside-avoid auto-cols-fr grid-flow-col gap-8">
          {signatures.map((label) => (
            <p key={label} className="border-t border-ink pt-1.5 text-caption text-ink-2">
              {label}
            </p>
          ))}
        </footer>
      )}
      {footer && <p className="mt-6 text-caption text-ink-3">{footer}</p>}
    </article>,
    document.body,
  );
}

// A labelled part of the sheet: "Bill to" over the customer's name and address
export function PrintBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="break-inside-avoid">
      <p className="text-caption font-medium text-ink-3">{label}</p>
      <div className="mt-1">{children}</div>
    </section>
  );
}
