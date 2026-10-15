import {
  Alert02Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  HourglassIcon,
  Link01Icon,
} from '@hugeicons/core-free-icons';
import {
  DEFAULT_SETTINGS,
  type DocumentEmail,
  type DocumentShare,
  routes,
  SEND_PERMISSIONS,
  SHARE_LINK_DAYS,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Dialog, DialogClose, DialogContent, Pill, toast } from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { call } from '../lib/api';
import { languageName, type OutputTarget, shareState } from '../lib/document-output';
import { documentEmailsQuery, documentSharesQuery } from '../lib/document-queries';
import { useCan } from '../lib/permissions';
import { settingsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { failureOf } from './journal-parts';
import { LinkList } from './sales-parts';

// Step 16: two cards under a quotation, an invoice, a money receipt and a credit note: the emails
// it went in and its share links. A lazy chunk of its own, like the Send menu (send-menu.tsx says
// why).

function useTenant(): string {
  return useSession((state) => state.me?.tenant.id) ?? '';
}

function EmailPill({ status }: { status: DocumentEmail['status'] }) {
  const { t } = useLocale();
  const label = t(`documentOutput.emails.statuses.${status}`);
  if (status === 'sent') {
    return (
      <Pill tone="good" icon={CheckmarkCircle02Icon}>
        {label}
      </Pill>
    );
  }
  if (status === 'failed') {
    return (
      <Pill tone="crit" icon={Alert02Icon}>
        {label}
      </Pill>
    );
  }
  // Work in progress is brand, not warn (CLAUDE.md → Sales document statuses)
  return (
    <Pill tone="brand" icon={Clock01Icon}>
      {label}
    </Pill>
  );
}

const SHARE_PILLS = {
  active: { tone: 'good', icon: Link01Icon },
  ended: { tone: 'neutral', icon: HourglassIcon },
  revoked: { tone: 'neutral', icon: CancelCircleIcon },
} as const;

// "23 Sep 2026, 16:05" in the workspace's time zone, like the bell and the audit log
function useMoment(): (iso: string) => string {
  const { format } = useLocale();
  const timeZone = useQuery(settingsQuery(useTenant())).data?.timezone ?? DEFAULT_SETTINGS.timezone;
  return (iso: string) => format.dateTime(new Date(iso), timeZone);
}

function EmailRow({ email }: { email: DocumentEmail }) {
  const { t } = useLocale();
  const moment = useMoment();
  return (
    <li className="grid gap-1 border-t border-line px-5 py-3 text-body-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {/* Addresses break anywhere: a long one must not push the card wider than a phone */}
        <span className="min-w-0 font-medium break-all text-ink">{email.to.join(', ')}</span>
        <span className="ml-auto">
          <EmailPill status={email.status} />
        </span>
      </div>
      <span className="text-ink-2">{email.subject}</span>
      {email.cc.length > 0 && (
        <span className="break-all text-ink-3">
          {t('documentOutput.emails.cc', { list: email.cc.join(', ') })}
        </span>
      )}
      <span className="text-caption text-ink-3 tabular-nums">
        {languageName(email.language)} ·{' '}
        {t('documentOutput.emails.sentBy', {
          name: email.sentBy.name,
          date: moment(email.sentAt ?? email.createdAt),
        })}
      </span>
      {email.status === 'failed' && (
        <span className="text-label text-crit">{t('documentOutput.emails.failedHint')}</span>
      )}
    </li>
  );
}

function ShareRow({
  share,
  canRevoke,
  onRevoke,
}: {
  share: DocumentShare;
  canRevoke: boolean;
  onRevoke: () => void;
}) {
  const { t } = useLocale();
  const moment = useMoment();
  const state = shareState(share, new Date());
  const pill = SHARE_PILLS[state];
  const ends =
    state === 'revoked' && share.revokedAt !== null
      ? t('documentOutput.shares.revokedOn', { date: moment(share.revokedAt) })
      : t(state === 'ended' ? 'documentOutput.shares.endedOn' : 'documentOutput.shares.until', {
          date: moment(share.expiresAt),
        });
  return (
    <li className="grid gap-1 border-t border-line px-5 py-3 text-body-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Pill tone={pill.tone} icon={pill.icon}>
          {t(`documentOutput.shares.states.${state}`)}
        </Pill>
        <span className="text-ink-2">{languageName(share.language)}</span>
        {canRevoke && state === 'active' && (
          <Button
            variant="secondary"
            size="sm"
            className="ml-auto"
            // Every row has this button: its label says which link it turns off
            aria-label={t('documentOutput.shares.revokeLabel', { date: moment(share.createdAt) })}
            onClick={onRevoke}
          >
            {t('documentOutput.shares.revoke')}
          </Button>
        )}
      </div>
      <span className="text-ink-2 tabular-nums">
        {share.firstOpenedAt === null || share.lastOpenedAt === null
          ? t('documentOutput.shares.notOpened')
          : [
              t('documentOutput.shares.firstOpened', { date: moment(share.firstOpenedAt) }),
              t('documentOutput.shares.lastOpened', { date: moment(share.lastOpenedAt) }),
            ].join(' · ')}
      </span>
      <span className="text-caption text-ink-3 tabular-nums">
        {t('documentOutput.shares.madeBy', {
          name: share.createdBy.name,
          date: moment(share.createdAt),
        })}{' '}
        · {ends}
      </span>
    </li>
  );
}

// Turning a link off asks first: it cannot be turned on again (decision 31)
function RevokeDialog({
  target,
  share,
  onDone,
}: {
  target: OutputTarget;
  share: DocumentShare;
  onDone: () => void;
}) {
  const { t, errorText } = useLocale();
  const tenantId = useTenant();
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () =>
      call(routes.documentOutput.revokeShare, {
        params: { kind: target.kind, id: target.id, shareId: share.id },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: documentSharesQuery(tenantId, target.kind, target.id).queryKey,
      });
      toast(t('documentOutput.shares.revoked'));
      onDone();
    },
  });
  const failure = failureOf(revoke.error);
  return (
    <DialogContent
      title={t('documentOutput.shares.confirmTitle')}
      description={t('documentOutput.shares.confirmBody')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button
            disabled={revoke.isPending}
            onClick={() => {
              revoke.mutate();
            }}
          >
            {t('documentOutput.shares.confirm')}
          </Button>
        </>
      }
    >
      {failure && <p className="text-label text-crit">{errorText(failure)}</p>}
    </DialogContent>
  );
}

// The two history cards: the emails it went in, and its share links. Everyone who can read the
// document sees them (the API asks no permission); only a sender sees "Turn off".
export function DocumentHistory({ target }: { target: OutputTarget }) {
  const { t } = useLocale();
  const tenantId = useTenant();
  const canSend = useCan()(SEND_PERMISSIONS[target.kind]);
  const emails = useQuery(documentEmailsQuery(tenantId, target.kind, target.id));
  const shares = useQuery(documentSharesQuery(tenantId, target.kind, target.id));
  const [revoking, setRevoking] = useState<DocumentShare | null>(null);

  const emailItems = emails.data?.items ?? [];
  const shareItems = shares.data?.items ?? [];
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <LinkList
        title={t('documentOutput.emails.title')}
        subtitle={t('documentOutput.emails.subtitle')}
        empty={
          emails.isError
            ? t('documentOutput.emails.loadFailed')
            : emails.data && emailItems.length === 0
              ? t('documentOutput.emails.empty')
              : undefined
        }
      >
        {emailItems.map((email) => (
          <EmailRow key={email.id} email={email} />
        ))}
      </LinkList>
      <LinkList
        title={t('documentOutput.shares.title')}
        subtitle={t('documentOutput.shares.subtitle', { days: SHARE_LINK_DAYS })}
        empty={
          shares.isError
            ? t('documentOutput.shares.loadFailed')
            : shares.data && shareItems.length === 0
              ? t('documentOutput.shares.empty')
              : undefined
        }
      >
        {shareItems.map((share) => (
          <ShareRow
            key={share.id}
            share={share}
            canRevoke={canSend}
            onRevoke={() => {
              setRevoking(share);
            }}
          />
        ))}
      </LinkList>
      <Dialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
      >
        {revoking && (
          <RevokeDialog
            target={target}
            share={revoking}
            onDone={() => {
              setRevoking(null);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
