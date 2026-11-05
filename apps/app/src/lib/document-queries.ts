import { type LanguageCode, type OutputDocument, routes } from '@omnivo/contracts';
import { queryOptions } from '@tanstack/react-query';

import { call } from './api';

// Step 16: the queries of the Send menu, the history cards and the email dialog. Here, not in
// queries.ts: that file is in nearly every page's chunk, and these are needed only by the two
// lazy chunks of document output.

// What a document was sent in. Under ['documents', tenantId, kind, id]: sending an email or making
// a link refreshes that one prefix.
export function documentEmailsQuery(tenantId: string, kind: OutputDocument, id: string) {
  return queryOptions({
    queryKey: ['documents', tenantId, kind, id, 'emails'],
    queryFn: () => call(routes.documentOutput.emails, { params: { kind, id } }),
    // An email is queued, not sent, when the dialog closes: the list asks again every few seconds
    // while one is still sending, so "Sending" turns into "Sent" (or "Failed") by itself
    refetchInterval: (query) =>
      query.state.data?.items.some((email) => email.status === 'pending') ? 3000 : false,
  });
}

export function documentSharesQuery(tenantId: string, kind: OutputDocument, id: string) {
  return queryOptions({
    queryKey: ['documents', tenantId, kind, id, 'shares'],
    queryFn: () => call(routes.documentOutput.shares, { params: { kind, id } }),
  });
}

// The email dialog's first subject and message, written by the server in a language (decision
// 12). One per language: switching back to the first language finds its draft at once.
export function emailDraftQuery(
  tenantId: string,
  kind: OutputDocument,
  id: string,
  language: LanguageCode,
) {
  return queryOptions({
    queryKey: ['documents', tenantId, kind, id, 'email-draft', language],
    queryFn: () =>
      call(routes.documentOutput.emailDraft, { params: { kind, id }, query: { language } }),
    // The draft names the document's current state: read again for each dialog
    gcTime: 0,
    retry: false,
  });
}
