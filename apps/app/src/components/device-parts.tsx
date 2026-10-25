import {
  CheckmarkCircle02Icon,
  ComputerCheckIcon,
  ComputerPhoneSyncIcon,
  ComputerRemoveIcon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  Store01Icon,
  Time04Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { type DeviceListItem, syncAge } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  dataTableColumns,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  Pill,
} from '@omnivo/ui';
import { useMemo } from 'react';

import { daysBetween } from '../lib/sync-summary';
import { useTimeZone } from '../lib/workspace';

// Step 18c: what the two device lists share (My devices and Settings → Devices): the columns, the
// status pill and the menu of a row. The dialogs are in device-dialogs.tsx, loaded lazily: nothing
// there imports this file, or the dialogs' chunk would bring the data table with it.

// What a row's menu asks for; the page keeps it and opens the dialog
export interface DeviceAction {
  kind: 'rename' | 'move' | 'revoke';
  device: DeviceListItem;
}

// Active (good), Revoked (neutral), or, for an active device 24 hours after its last sync, "Not
// synced for 3 days" (warn) in Active's place (decision 12). syncAge, the same rule as the
// device's own warning, so the list and the device change at the same hour. `now` is the viewer's
// clock and lastSyncAt the server's: online, the two are close, and a list counts whole days.
// A device that never synced is Active: it has nothing to be late with yet.
export function DeviceStatusPill({ device, now }: { device: DeviceListItem; now: number }) {
  const { t, format } = useLocale();
  if (device.revokedAt !== null) {
    return (
      <Pill tone="neutral" icon={ComputerRemoveIcon}>
        {t('devices.statuses.revoked')}
      </Pill>
    );
  }
  const synced = device.lastSyncAt === null ? null : Date.parse(device.lastSyncAt);
  if (synced !== null && syncAge(now - synced) !== 'fresh') {
    const days = daysBetween(synced, now);
    return (
      <Pill tone="warn" icon={Time04Icon}>
        {t('devices.stale', { count: days, formatted: format.number(days) })}
      </Pill>
    );
  }
  return (
    <Pill tone="good" icon={CheckmarkCircle02Icon}>
      {t('devices.statuses.active')}
    </Pill>
  );
}

// Rename and Revoke for every active device the list shows (the API checks whose it is); Change
// branch only on the row of this device, with its copy open (decision 2). A revoked device has no
// menu: nothing about it can change (the database trigger of 18c.2).
function DeviceMenu({
  device,
  canMove,
  onAction,
}: {
  device: DeviceListItem;
  canMove: boolean;
  onAction: (action: DeviceAction) => void;
}) {
  const { t } = useLocale();
  if (device.revokedAt !== null) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          icon={MoreHorizontalIcon}
          label={t('devices.actionsFor', { name: device.name })}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          icon={PencilEdit02Icon}
          onSelect={() => {
            onAction({ kind: 'rename', device });
          }}
        >
          {t('devices.rename')}
        </DropdownMenuItem>
        {canMove && (
          <DropdownMenuItem
            icon={Store01Icon}
            onSelect={() => {
              onAction({ kind: 'move', device });
            }}
          >
            {t('devices.changeBranch')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          icon={ComputerRemoveIcon}
          onSelect={() => {
            onAction({ kind: 'revoke', device });
          }}
        >
          {t('devices.revoke')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const column = dataTableColumns<DeviceListItem>();

export function useDeviceColumns({
  withPerson,
  sortable,
  thisDeviceId,
  canMoveHere,
  now,
  onAction,
}: {
  // The workspace's list names the person; your own list does not need to
  withPerson: boolean;
  // The workspace's list sorts on the server by name and by the last sync (decision 8); your own
  // list keeps the server's order (active first, then by name)
  sortable: boolean;
  thisDeviceId: string | null;
  // This device has its copy open, so its outbox can be checked before a move
  canMoveHere: boolean;
  now: number;
  onAction: (action: DeviceAction) => void;
}) {
  const { t, format } = useLocale();
  const timeZone = useTimeZone();
  return useMemo(
    () =>
      column.columns([
        column.accessor('name', {
          header: t('devices.columns.device'),
          enableSorting: sortable,
          meta: { card: 'title' },
          // CLAUDE.md → Table: a 30px tile, the name and an ink-3 sub-line. The tile is an icon, not
          // initials: device names are often two words of a browser ("Chrome on Windows").
          cell: ({ row }) => {
            const device = row.original;
            return (
              <span className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-brand-soft text-brand"
                >
                  <HugeiconsIcon icon={ComputerPhoneSyncIcon} size={16} strokeWidth={1.5} />
                </span>
                <span className="grid min-w-0 justify-items-start gap-0.5">
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{device.name}</span>
                    {device.id === thisDeviceId && (
                      <Pill tone="brand" icon={ComputerCheckIcon}>
                        {t('devices.thisDevice')}
                      </Pill>
                    )}
                  </span>
                  {/* Who revoked it, the first question about a phone that stopped working. A
                      device revoked by hand before step 18c has no name: only the time. */}
                  {device.revokedAt !== null && (
                    <span className="text-caption text-ink-3 tabular-nums">
                      {device.revokedByName === null
                        ? format.dateTime(new Date(device.revokedAt), timeZone)
                        : t('devices.revokedBy', {
                            name: device.revokedByName,
                            time: format.dateTime(new Date(device.revokedAt), timeZone),
                          })}
                    </span>
                  )}
                </span>
              </span>
            );
          },
        }),
        ...(withPerson
          ? [
              column.accessor('userName', {
                header: t('devices.columns.person'),
                enableSorting: false,
                meta: { card: 'subtitle' },
              }),
            ]
          : []),
        column.accessor('branchName', {
          header: t('devices.columns.branch'),
          enableSorting: false,
          meta: { card: 'detail' },
        }),
        column.accessor('lastSyncAt', {
          header: t('devices.columns.lastSync'),
          enableSorting: sortable,
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const at = getValue();
            return (
              <span className="tabular-nums">
                {at === null ? t('devices.neverSynced') : format.dateTime(new Date(at), timeZone)}
              </span>
            );
          },
        }),
        column.display({
          id: 'status',
          header: t('devices.columns.status'),
          meta: { card: 'detail' },
          cell: ({ row }) => <DeviceStatusPill device={row.original} now={now} />,
        }),
        column.display({
          id: 'actions',
          // A header for screen readers: a column of buttons with no name reads as an empty cell
          header: () => <span className="sr-only">{t('devices.columns.actions')}</span>,
          meta: { align: 'end', card: 'trailing' },
          cell: ({ row }) => (
            <DeviceMenu
              device={row.original}
              canMove={canMoveHere && row.original.id === thisDeviceId}
              onAction={onAction}
            />
          ),
        }),
      ]),
    [t, format, timeZone, withPerson, sortable, thisDeviceId, canMoveHere, now, onAction],
  );
}
