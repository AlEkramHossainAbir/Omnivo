import {
  Alert02Icon,
  Clock01Icon,
  Mail01Icon,
  MailSend01Icon,
  UserAdd01Icon,
  UserMultipleIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { type Invitation, type Member, type MemberSort, routes } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  CheckboxGroup,
  DataTable,
  dataTableColumns,
  Dialog,
  DialogClose,
  DialogContent,
  FormAlert,
  PageHeader,
  Pill,
  SectionHeader,
  type SortingState,
  toast,
} from '@omnivo/ui';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import { InviteForm, useRoleOptions } from '../components/invite-form';
import { ApiRequestError, call } from '../lib/api';
import { useCan } from '../lib/permissions';
import { invitationsQuery, membersQuery, rolesQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const memberColumn = dataTableColumns<Member>();
const invitationColumn = dataTableColumns<Invitation>();

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase();
}

// mutation-এর error (last_owner, cannot_grant, version_conflict) কোনো ঘরের না — ফর্মের উপরে alert-এ
function failureOf(error: Error | null): string | undefined {
  if (!error) return undefined;
  return error instanceof ApiRequestError ? error.code : 'unknown_error';
}

function InvitationPanel({ invitation, onDone }: { invitation: Invitation; onDone: () => void }) {
  const { t, format } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['invitations', tenantId] });

  const resend = useMutation({
    mutationFn: () =>
      call(routes.invitations.resend, {
        params: { id: invitation.id },
        body: { version: invitation.version },
      }),
    onSuccess: async (saved) => {
      await refresh();
      toast(t('team.resent', { email: saved.email }));
      onDone();
    },
  });
  const revoke = useMutation({
    mutationFn: () =>
      call(routes.invitations.revoke, {
        params: { id: invitation.id },
        query: { version: invitation.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('team.revoked', { email: invitation.email }));
      onDone();
    },
  });
  const failure = failureOf(resend.error) ?? failureOf(revoke.error);
  const busy = resend.isPending || revoke.isPending;

  return (
    <DialogContent
      title={invitation.email}
      description={
        invitation.invitedBy
          ? t('team.invitedBy', {
              name: invitation.invitedBy.fullName,
              date: format.date(new Date(invitation.createdAt)),
            })
          : undefined
      }
      footer={
        <>
          <Button
            variant="secondary"
            className="mr-auto"
            disabled={busy}
            onClick={() => {
              revoke.mutate();
            }}
          >
            {t('team.revoke')}
          </Button>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.close')}</Button>
          </DialogClose>
          <Button
            disabled={busy}
            onClick={() => {
              resend.mutate();
            }}
          >
            <HugeiconsIcon icon={MailSend01Icon} size={17} strokeWidth={1.5} />
            {t('team.resend')}
          </Button>
        </>
      }
    >
      {failure && <FormAlert message={failure} />}
      <InvitationStatus invitation={invitation} />
      <p className="text-body-sm text-ink-2">
        {invitation.roles.map((role) => role.name).join(', ')}
      </p>
    </DialogContent>
  );
}

// রং একা না — আইকন আর লেখা সহ (CLAUDE.md → Status colors)
function InvitationStatus({ invitation }: { invitation: Invitation }) {
  const { t } = useLocale();
  if (new Date(invitation.expiresAt) <= new Date()) {
    return (
      <Pill tone="neutral" icon={Clock01Icon}>
        {t('team.statuses.expired')}
      </Pill>
    );
  }
  // The worker's result: still being sent (or retried), gone out, or given up
  switch (invitation.delivery) {
    case 'sending':
      return (
        <Pill tone="neutral" icon={Mail01Icon}>
          {t('team.statuses.sending')}
        </Pill>
      );
    case 'failed':
      return (
        <Pill tone="warn" icon={Alert02Icon}>
          {t('team.statuses.notSent')}
        </Pill>
      );
    case 'sent':
      return (
        <Pill tone="brand" icon={MailSend01Icon}>
          {t('team.statuses.sent')}
        </Pill>
      );
  }
}

function MemberForm({ member, onDone }: { member: Member; onDone: () => void }) {
  const { t, format } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const { data: roles } = useQuery(rolesQuery(tenantId));
  const options = useRoleOptions(roles);
  const [roleIds, setRoleIds] = useState(() => member.roles.map((role) => role.id));
  const [confirming, setConfirming] = useState(false);

  // সদস্য বদলালে তালিকা আর রোলের সদস্য-সংখ্যা (matrix-এর কলামের নিচে) দুটোই পুরনো
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['members', tenantId] }),
      queryClient.invalidateQueries({ queryKey: ['roles', tenantId] }),
    ]);

  const save = useMutation({
    mutationFn: () =>
      call(routes.members.updateRoles, {
        params: { id: member.membershipId },
        body: { roleIds, version: member.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('team.rolesSaved', { name: member.fullName }));
      onDone();
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      call(routes.members.remove, {
        params: { id: member.membershipId },
        query: { version: member.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('team.removed', { name: member.fullName }));
      onDone();
    },
  });
  const failure = failureOf(save.error) ?? failureOf(remove.error);
  const busy = save.isPending || remove.isPending;

  return (
    <DialogContent
      title={member.fullName}
      description={t('team.memberDescription', {
        email: member.email,
        date: format.date(new Date(member.joinedAt)),
      })}
      footer={
        <>
          {/* বাঁয়ে, আর দুই ধাপে: প্রথম চাপে সতর্কবার্তা আর নাম সহ বাটন, দ্বিতীয় চাপে সত্যিই সরানো */}
          <Button
            variant="secondary"
            className="mr-auto"
            disabled={busy}
            onClick={() => {
              if (confirming) remove.mutate();
              else setConfirming(true);
            }}
          >
            {confirming ? t('team.confirmRemove', { name: member.fullName }) : t('team.remove')}
          </Button>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button
            disabled={busy}
            onClick={() => {
              save.mutate();
            }}
          >
            {save.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      {failure && <FormAlert message={failure} />}
      {confirming && <p className="text-body-sm text-ink-2">{t('team.removeWarning')}</p>}
      <CheckboxGroup
        legend={t('team.roles')}
        options={options}
        value={roleIds}
        onChange={setRoleIds}
      />
    </DialogContent>
  );
}

function MembersSection({ onOpen }: { onOpen: ((member: Member) => void) | undefined }) {
  const { t, format } = useLocale();
  const me = useSession((state) => state.me);
  const tenantId = me?.tenant.id ?? '';
  const [sort, setSort] = useState<MemberSort>('name');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    membersQuery(tenantId, sort),
  );
  const members = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);

  const loadMore = useCallback(() => {
    // চলতি request শেষ না হলে আবার না — নাহলে একই cursor দুবার চাওয়া হতো
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // টেবিলের sort অবস্থা ↔ API-র sort প্যারামিটার। শুধু নাম-কলাম সার্ভারে sort হয়
  const sorting = useMemo(
    () => ({
      state: [{ id: 'fullName', desc: sort === '-name' }],
      onChange: (next: SortingState) => {
        setSort(next[0]?.desc ? '-name' : 'name');
      },
    }),
    [sort],
  );

  const columns = useMemo(
    () =>
      memberColumn.columns([
        memberColumn.accessor('fullName', {
          header: t('team.columns.member'),
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="flex items-center gap-3">
              <span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-brand-soft text-caption font-semibold text-brand">
                {initials(row.original.fullName)}
              </span>
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  {row.original.fullName}
                  {row.original.userId === me?.user.id && (
                    <span className="font-normal text-ink-3"> · {t('team.you')}</span>
                  )}
                </span>
                <span className="block truncate text-caption text-ink-3">{row.original.email}</span>
              </span>
            </span>
          ),
        }),
        memberColumn.accessor((member) => member.roles.map((role) => role.name).join(', '), {
          id: 'roles',
          header: t('team.columns.roles'),
          // সার্ভার রোল দিয়ে সাজাতে পারে না (চুক্তিতে শুধু name) — তাই হেডারে sort বাটনই নেই
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) => getValue() || t('team.noRole'),
        }),
        memberColumn.accessor('joinedAt', {
          header: t('team.columns.joined'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => (
            <span className="tabular-nums">{format.date(new Date(getValue()))}</span>
          ),
        }),
      ]),
    [t, format, me?.user.id],
  );

  return (
    // DataTable নিজেই কার্ড — তাই Card-এ না মুড়ে শুধু শিরোনাম + টেবিল
    <section className="grid gap-3">
      <SectionHeader title={t('team.membersTitle')} subtitle={t('team.membersSubtitle')} />
      {isError ? (
        <p className="text-body-sm text-crit">{t('team.loadFailed')}</p>
      ) : (
        members && (
          <DataTable
            label={t('team.membersTitle')}
            data={members}
            columns={columns}
            getRowId={(member) => member.membershipId}
            sorting={sorting}
            onEndReached={loadMore}
            // নিজের রো খোলে না: নিজের রোল বদলানো API-তেও বন্ধ (own_membership) — খুলে "পারবেন না"
            // দেখানোর চেয়ে ক্লিকই না করা ভালো
            onRowClick={
              onOpen &&
              ((member) => {
                if (member.userId !== me?.user.id) onOpen(member);
              })
            }
            footer={
              isFetchingNextPage && (
                <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
              )
            }
          />
        )
      )}
    </section>
  );
}

function InvitationsSection({ onOpen }: { onOpen: (invitation: Invitation) => void }) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const { data } = useQuery(invitationsQuery(tenantId));

  const columns = useMemo(
    () =>
      invitationColumn.columns([
        invitationColumn.accessor('email', {
          header: t('team.invitationColumns.email'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="flex items-center gap-3">
              <span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-subtle text-ink-3">
                <HugeiconsIcon icon={Mail01Icon} size={16} strokeWidth={1.5} />
              </span>
              <span className="min-w-0 truncate font-medium">{row.original.email}</span>
            </span>
          ),
        }),
        invitationColumn.accessor((invitation) => invitation.roles.map((r) => r.name).join(', '), {
          id: 'roles',
          header: t('team.invitationColumns.roles'),
          enableSorting: false,
          meta: { card: 'detail' },
        }),
        invitationColumn.display({
          id: 'status',
          header: t('team.invitationColumns.status'),
          meta: { card: 'trailing' },
          cell: ({ row }) => <InvitationStatus invitation={row.original} />,
        }),
      ]),
    [t],
  );

  // খোলা invitation না থাকলে পুরো অংশটাই না — খালি টেবিল দেখিয়ে জায়গা নষ্ট করার কিছু নেই
  if (!data || data.length === 0) return null;
  return (
    <section className="grid gap-3">
      <SectionHeader title={t('team.invitationsTitle')} subtitle={t('team.invitationsSubtitle')} />
      <DataTable
        label={t('team.invitationsTitle')}
        data={data}
        columns={columns}
        getRowId={(invitation) => invitation.id}
        onRowClick={onOpen}
      />
    </section>
  );
}

// null = কিছু খোলা নেই; বাকিগুলো কোন dialog
type Open =
  | null
  | { kind: 'invite' }
  | { kind: 'member'; member: Member }
  | { kind: 'invitation'; invitation: Invitation };

export function TeamPage() {
  const { t } = useLocale();
  const can = useCan();
  const [open, setOpen] = useState<Open>(null);
  const close = () => {
    setOpen(null);
  };

  return (
    <div className="grid max-w-5xl gap-6">
      <PageHeader
        title={t('team.title')}
        description={t('team.description')}
        actions={
          can('core.user.invite') && (
            <Button
              onClick={() => {
                setOpen({ kind: 'invite' });
              }}
            >
              <HugeiconsIcon icon={UserAdd01Icon} size={17} strokeWidth={1.5} />
              {t('team.invite')}
            </Button>
          )
        }
      />
      {can('core.user.invite') && (
        <InvitationsSection
          onOpen={(invitation) => {
            setOpen({ kind: 'invitation', invitation });
          }}
        />
      )}
      {can('core.user.read') ? (
        <MembersSection
          onOpen={
            can('core.user.manage')
              ? (member) => {
                  setOpen({ kind: 'member', member });
                }
              : undefined
          }
        />
      ) : (
        <p className="flex items-center gap-2 text-body-sm text-ink-3">
          <HugeiconsIcon icon={UserMultipleIcon} size={16} strokeWidth={1.5} />
          {t('team.readOnly')}
        </p>
      )}
      <Dialog
        open={open !== null}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        {open?.kind === 'invite' && <InviteForm onDone={close} />}
        {open?.kind === 'member' && (
          <MemberForm key={open.member.membershipId} member={open.member} onDone={close} />
        )}
        {open?.kind === 'invitation' && (
          <InvitationPanel key={open.invitation.id} invitation={open.invitation} onDone={close} />
        )}
      </Dialog>
    </div>
  );
}
