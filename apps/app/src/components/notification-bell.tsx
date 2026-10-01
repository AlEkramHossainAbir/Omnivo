import { Notification03Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  DEFAULT_SETTINGS,
  isExportFormat,
  isNotificationType,
  isReportKind,
  type Notification,
  type NotificationParams,
  type NotificationType,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { cn, EmptyState, Popover, PopoverContent, PopoverTrigger } from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { call } from '../lib/api';
import { notificationsQuery, settingsQuery, unreadCountQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

// Where a click on each kind of notification takes you. satisfies: a new type without a page does
// not compile, and the values are checked against the router's real paths by navigate() below.
const TARGET = {
  'workspace.ready': '/roles',
  'member.joined': '/team',
  'invitation.failed': '/team',
  'report.ready': '/reports/exports',
  'report.failed': '/reports/exports',
} as const satisfies Record<NotificationType, string>;

// The badge stops at 9+: a two-digit count would not fit the 18px circle, and past nine the exact
// number no longer changes what you do
function badgeText(count: number): string {
  return count > 9 ? '9+' : String(count);
}

// An export's report and format arrive as keys (trial_balance, xlsx): their words go into the text.
// A key this app does not know (a newer server) stays as it is.
function useWords() {
  const { t } = useLocale();
  return (params: NotificationParams): NotificationParams => {
    const { report, format } = params;
    return {
      ...params,
      ...(typeof report === 'string' &&
        isReportKind(report) && { report: t(`reports.kinds.${report}`) }),
      ...(typeof format === 'string' &&
        isExportFormat(format) && { format: t(`reports.formats.${format}`) }),
    };
  };
}

function Item({
  notification,
  timeZone,
  onOpen,
}: {
  notification: Notification & { type: NotificationType };
  timeZone: string;
  onOpen: () => void;
}) {
  const { t, format } = useLocale();
  const words = useWords();
  const unread = notification.readAt === null;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors duration-150 hover:bg-subtle"
      >
        {/* Unread = a brand dot, plus hidden text: the dot alone says nothing to a screen reader */}
        <span
          className={cn(
            'mt-1.5 size-2 shrink-0 rounded-full',
            unread ? 'bg-brand' : 'bg-transparent',
          )}
        />
        <span className="min-w-0">
          {unread && <span className="sr-only">{t('notifications.unread')}: </span>}
          <span className={cn('block text-body-sm', unread ? 'text-ink' : 'text-ink-2')}>
            {t(`notifications.types.${notification.type}`, words(notification.params))}
          </span>
          <span className="block text-caption text-ink-3 tabular-nums">
            {format.dateTime(new Date(notification.createdAt), timeZone)}
          </span>
        </span>
      </button>
    </li>
  );
}

// The bell next to the logo. The badge polls a tiny endpoint every 30 seconds (unreadCountQuery);
// the list itself is only fetched while the panel is open.
export function NotificationBell() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const [open, setOpen] = useState(false);

  const { data: unread = 0 } = useQuery(unreadCountQuery(tenantId));
  const list = useQuery({ ...notificationsQuery(tenantId), enabled: open });
  // Times in the workspace's time zone, like the audit log
  const { data: settings } = useQuery({ ...settingsQuery(tenantId), enabled: open });
  const timeZone = settings?.timezone ?? DEFAULT_SETTINGS.timezone;

  // One prefix for the count and the list, so a single invalidate refreshes both
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['notifications', tenantId] });
  const markRead = useMutation({
    mutationFn: (id: string) => call(routes.notifications.markRead, { params: { id } }),
    onSettled: refresh,
  });
  const markAllRead = useMutation({
    mutationFn: () => call(routes.notifications.markAllRead),
    onSettled: refresh,
  });

  // A newer server may send a type this app does not know yet: skip it instead of showing a key
  const items = (list.data ?? []).filter(
    (item): item is Notification & { type: NotificationType } => isNotificationType(item.type),
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            unread > 0
              ? t('shell.notificationsUnread', { count: unread })
              : t('shell.notifications')
          }
          className="relative grid place-items-center rounded-lg p-2 text-ink-3 transition-colors duration-150 hover:bg-subtle hover:text-ink"
        >
          <HugeiconsIcon icon={Notification03Icon} size={18} strokeWidth={1.5} />
          {unread > 0 && (
            <span
              aria-hidden="true"
              className="absolute -top-0.5 -right-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-brand px-1 text-caption leading-none font-medium text-brand-ink tabular-nums"
            >
              {badgeText(unread)}
            </span>
          )}
        </button>
      </PopoverTrigger>
      {/* 340px, but never wider than the screen minus the 16px gutters on a phone */}
      <PopoverContent align="end" className="w-[340px] max-w-[calc(100vw-32px)]">
        <div className="flex items-center justify-between gap-3 px-2 pb-2">
          <h2 className="text-h3">{t('notifications.title')}</h2>
          {unread > 0 && (
            <button
              type="button"
              onClick={() => {
                markAllRead.mutate();
              }}
              className="text-label font-medium text-brand underline-offset-[3px] hover:underline"
            >
              {t('notifications.markAllRead')}
            </button>
          )}
        </div>
        {list.isError ? (
          <p className="px-2 py-4 text-body-sm text-crit">{t('notifications.loadFailed')}</p>
        ) : list.data && items.length === 0 ? (
          <EmptyState
            icon={Notification03Icon}
            title={t('notifications.emptyTitle')}
            description={t('notifications.emptyBody')}
          />
        ) : (
          // Scrolls inside the panel: 20 items would run off a phone screen
          <ul className="grid max-h-[min(420px,60dvh)] gap-px overflow-y-auto">
            {items.map((notification) => (
              <Item
                key={notification.id}
                notification={notification}
                timeZone={timeZone}
                onOpen={() => {
                  if (notification.readAt === null) markRead.mutate(notification.id);
                  setOpen(false);
                  void navigate({ to: TARGET[notification.type] });
                }}
              />
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
