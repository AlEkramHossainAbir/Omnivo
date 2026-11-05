# Step 18c: The sync engine, part 3 — the devices, and how long a device may stay offline

> The implementation guide for "Phase 6 → Step 18", the last of three parts, of [build-plan.bn.md](build-plan.bn.md):
> which file gets what code, and which command runs where. Step 18 (the sync engine, `packages/sync`) is split into
> three guides: 18a (pull: the server's data on the device), 18b (push: work done offline sent later) and this one
> (the device list, renaming, moving and revoking a device, and the 24 hour and 7 day limits).

> Every file in this guide was placed in a separate copy of the repo (on top of commit `9ff0b06`, your commit named
> "sync push added": 18b's code and its doc updates) and checked from 2026-10-22 to 2026-10-25: `pnpm dedupe
> --check`, `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test` (656 — 15 new), `pnpm test:integration`
> (553 — 20 new), `pnpm test:tenant-leak` (111 — 2 new), `pnpm build`, `pnpm test:bundle-size` (first load 209.9 KB gz,
> budget 210; the device pages 105.7 and 101.9 KB, budget 110), `pnpm gen:openapi` (215 paths), `pnpm
> test:openapi`, `pnpm boundaries` and `pnpm test:e2e` (Playwright, 290 — 14 new, desktop and 390px; one older bills test timed out on a loaded machine and passed when run again, see 18c.8) — with the turbo cache bypassed
> (`--force`).
>
> Also checked:
>
> - **The database rules on their own**, in a throwaway Postgres (18c.2): 23 checks of migrations 0047 and 0048 (a
>   revoke must say who did it, a revoked device never changes again except its last sync, a device revoked before
>   this step stays as it is, a sign-in deleted under a device, and another workspace changing none of it).
> - **The device routes against a real database** (18c.4): both lists with their paging, search and sorts, rename,
>   move and revoke by the owner, by a Depot manager and by someone without the permission, the sign-in a revoke
>   ends, a pull racing a revoke, removing a member, archiving a branch, and another workspace trying the ids of
>   this one.
> - **The app against the real API in a browser** (18c.8): two browsers of one person; rename, revoking the other
>   browser (signed out there with the notice and its copy deleted), signing in again as a new device, the
>   workspace's list, a branch change, the archive refused, and revoking this browser.

## Goal

📱 **Knowing which devices hold the company's data, and stopping one.** After 18a and 18b, every browser a person
signs in on keeps a copy of the products, the customers, the prices and the stock of its branch, and may hold work
that was never sent. Nobody can see those devices yet, and a laptop left in a bus keeps its copy for ever. This step
gives the devices a list, a name, a branch that can change, and a way to stop one. It also makes a device that has
not synced for a long time warn, and then stop taking new work.

After this step:

- **Everyone sees their own devices** (the account menu → "My devices"): the name, the branch, the last sync. They rename
  them and revoke the ones they no longer use.
- **The owner, and whoever has the new permission `core.device.manage`, sees every device of the workspace**
  (Workspace → Devices in the sidebar), and revokes any of them: the sales officer's phone that was stolen, the counter computer
  that was replaced.
- **A revoked device stops at once.** It cannot pull or push any more, its sign-in ends, and the next time it opens
  the app its copy and its outbox are deleted. It stays in the list as Revoked, with who revoked it. Signing in again
  on that browser makes a new device.
- **A device moves to another branch only from itself, after it synced.** "Change branch" on this device, online, with
  nothing waiting: the copy of the old branch is deleted, and the new branch is copied.
- **After 24 hours without a sync, the app warns:** the sidebar's sync line and the Sync page say "Last synced 2 days
  ago". **After 7 days, the device stops saving new work offline** until it syncs; online work does not change.
- **Removing a person from the workspace revokes their devices,** and a branch with active devices cannot be
  archived.

## The whole picture

```
packages/contracts   devices.ts: a device with the names (person, branch, who revoked it) · GET /me/devices ·
      │               GET /devices (core.device.manage, paged, search, branch, Active/Revoked, sorts) ·
      │               PATCH /devices/:id {name, version} · PUT /devices/:id/branch {branchId, version} ·
      │               POST /devices/:id/revoke · SYNC_WARN_AFTER_HOURS 24, SYNC_BLOCK_AFTER_DAYS 7, syncAge()
      │               permission core.device.manage · error branch_has_devices · audit device.renamed/moved/revoked
      ▼
packages/db          devices.session_id (the sign-in the device last used) · devices.revoked_by · a revoked
      │               device never changes again (a trigger)
      ▼
apps/api             DevicesService: mine, list, rename, move, revoke (own, or core.device.manage) · revoke ends
      │               the device's sign-in · removing a member revokes their devices · archiving a branch with
      │               active devices is refused · register and every pull keep the device's session up to date
      ▼
packages/sync        the time of the last sync on the device's own clock · the limits
      ▼
apps/app             account menu → My devices · Workspace → Devices · Rename, Change branch, Revoke dialogs · a
                      revoked device wipes itself and signs out · after a revoke a new device id · the sidebar's
                      sync line and the Sync page warn after 24 h · after 7 days the offline forms stop saving

the Chattogram depot, a Tuesday:
  the sales officer's phone is stolen on the way to a pharmacy
  the owner opens Workspace → Devices ──GET /devices?search=Tanvir──► "Tanvir's phone · Chattogram depot ·
     last synced 1 hour ago"
  Revoke ──POST /devices/:id/revoke──► revoked_at, revoked_by · the phone's sign-in deleted · audit device.revoked
  the phone, if anyone opens it:
     the next pull or push ──► 403 device_revoked ──► the copy and the outbox are deleted, signed out
     its access token (at most 15 minutes) ──► a refresh fails ──► signed out, and the copy is deleted at sign-in
  Tanvir signs in on a new phone ──► a new device id, "Which branch is this device in?" ──► a full pull

the head office laptop, back from 9 days in a village:
  offline: "Last synced 9 days ago" (warn) · the customer form says "This device last synced more than 7 days ago,
     so it can't save new work offline" and has no "Save on this device"; the 2 orders already waiting are still
     sent when the connection comes back
  online: the forms work as always, and the next pull puts it back to "Online"
```

## Not in this step, on purpose

| What | Why not now / when |
|---|---|
| A PIN to open the app, and encrypting the copy | Step 19, with the service worker (step 18 decision) |
| Moving someone else's device to another branch | The device must sync first, and only the device knows its outbox (decision 2) |
| Restoring a revoked device | A new sign-in makes a new device (decision 4). The old one is kept for the audit |
| A limit set by the server | The server cannot see a device that is offline. The limits are the device's own (decision 12) |
| Setting the 24 hour and 7 day limits per workspace | Constants for now (decision 12). A setting can come later if a customer asks |
| A notification to the person whose device was revoked | They find out at the next sign-in; the audit log keeps who did it |

## What changes in the code you already have

- **Contracts:** a new file `devices.ts`: the device as the lists show it, the five routes, the rename and move inputs,
  and the time limits with `syncAge()`. One new permission, `core.device.manage` (group Team), one error code
  (`branch_has_devices`) and three audit actions (`device.renamed`, `device.moved`, `device.revoked`). No new
  dependency, and `SYNC_PROTOCOL` stays 1.
- **Database:** two new columns on `devices`, `session_id` and `revoked_by`, one check, and one trigger that keeps a
  revoked device as it was revoked (migrations 0047 and 0048). The description of `core.device.manage`. No new table,
  no new index. Two API tests that revoke a device by hand now say who revoked it.
- **API:** a new controller and five routes for the devices; `DevicesService` gets the lists, rename, move and
  revoke; a small new file `device-revoke.ts` revokes devices for two callers. Registering, the push and the end of a
  pull keep the device's sign-in. Removing a member revokes their devices; archiving a branch with active devices is
  refused. The branch-manager role templates get `core.device.manage`. In `packages/auth`, the access token carries
  its session id (`sid`). Two unit tests of the token get the new claim.
- **API tests:** a new integration test file for the devices (`devices.int.spec.ts`), and a part for the new routes
  in the sync tenant-leak test.
- **i18n:** the words of the two device lists, the rename, branch and revoke dialogs, the sign-in notice after a
  revoke and the time limits, in English and Bangla; the text of `core.device.manage`, the three audit actions and
  `branch_has_devices`. No change in `packages/ui`.
- **`packages/sync`:** the pull state keeps the device's own clock at the end of a pull (`syncedAt`), with
  `syncedAtOf()` to read it, and `forgetDevice()` drops a revoked device's identity. Three new unit tests.
- **The screens:** two new pages, My devices (`/my-devices`, from the account menu) and Devices (`/devices`, in the
  Workspace group with `core.device.manage`), with the Rename, Change branch and Revoke dialogs. A revoked device
  deletes its copy and signs out, with a notice on the sign-in page; signing in again makes a new device. Changing
  this device's branch deletes the copy and copies the new branch; the other tabs follow. After 24 hours the
  sidebar's sync line and the Sync page warn; after 7 days the customer and order forms save nothing on the device.
  Two hooks and one component move into small files of their own, for the bundle budget.
- **Mock API and e2e tests:** the mock API gets the five device routes, four seeded devices, the device's sign-in
  and the branch archive rule; a new Playwright file covers both lists, rename, the branch change, both revokes, the
  archive rule and the two time limits. The branch dialog now shows the values inside an error ("Active devices in
  this branch: 4").
- **OpenAPI document:** 5 new paths (`/me/devices`, `/devices`, `/devices/{id}`, `/devices/{id}/branch`,
  `/devices/{id}/revoke`).

## The decisions behind this step

You made the first four on 2026-10-22 for this guide. Step 18's own decisions (2026-10-20) still hold: a device is one
browser profile of one person, in one branch; a revoked device stops syncing and deletes its data; after 24 hours
without a sync the app warns, and after 7 days it stops working offline. The others came up while building it;
please read them with care: they are mine.

1. **Two lists, and a new permission.** (You chose this.) Everyone sees and manages their own devices (Profile → "My
   devices": rename, revoke). Settings → Devices lists every device of the workspace; seeing it, and renaming or
   revoking someone else's device, needs the new permission `core.device.manage`.
2. **A device changes branch only from itself, after it synced.** (You chose this.) Only on that device, online, and
   only when its outbox has nothing waiting or refused ("Sync these 2 changes first"). Changing it deletes the copy and
   copies the new branch. Nobody moves another person's device.
3. **Revoking blocks the sync, deletes the data and ends the sign-in.** (You chose this.) The device is linked to its
   sign-in session, so a revoke also ends that browser's session; at its next contact the copy and the outbox are
   deleted. Changes that never synced on that device are lost, and the revoke dialog says so.
4. **After a revoke, signing in again makes a new device.** (You chose this.) The browser makes a new id, asks the
   branch again and becomes a new device. The old one stays in the list as Revoked. There is no "Restore".

**The contract (18c.1):**

5. **Five routes, one of them for the workspace.** `GET /me/devices` lists your own devices, `GET /devices` every
   device of the workspace with `core.device.manage`. Rename, move and revoke have no permission on the route: your
   own device needs none, and someone else's needs `core.device.manage`, which the service checks. Someone else's
   device without it answers `device_not_found`, like 18a's routes do. Moving someone else's device is refused even
   with the permission (decision 2).
6. **`core.device.manage` sits in the Team group,** next to `core.user.manage`: revoking a device is taking away
   someone's access, the same kind of decision as removing them. There is no "Admin" role template in the code: the
   Owner role holds every permission from the code, so every owner has it at once, with no migration. The role
   templates that manage a branch (Depot manager, Shop manager) get it for new workspaces (18c.3), because a lost
   phone is reported to the person in charge of that depot or shop first. In a workspace that exists already, the
   owner gives it to other roles in the role matrix, like every permission added after a workspace was made.
7. **A device in a list carries the names a person reads:** the person (also after they left the workspace), the
   branch, and who revoked it. A revoked device stays in the lists for good.
8. **The workspace list is paged, with a search, a branch and two tabs.** Active and Revoked, like the other lists.
   The search finds a device by its name or its person's name, so the list needs no person picker (which would need
   `core.user.read` to list the members). Two sorts: by name, and by the last sync, where "oldest first" puts the
   devices that never synced first: the order an owner wants when looking for the devices that fell behind. A
   person's own list is one answer, not pages: a person has a few devices.
9. **Rename and move carry the version the person saw;** revoke does not. Two people renaming the same device: the
   second one is told. A pull writes `last_sync_at` without raising the version (18a, decision 32), so a device that
   syncs every minute does not make its own rename fail. Revoking is final, and a rename a moment earlier does not
   change the decision, so it needs no version; revoking a revoked device answers it as it is.
10. **The server does not check the outbox before a move.** It cannot see it. The app checks that nothing is waiting
    before it asks (decision 2). A move to the branch the device is in answers the device unchanged, without an
    audit row. The next pull is a full pull of the new branch: 18a's pull already starts one when the device's
    branch is not the cursor's.
11. **A branch with active devices cannot be archived** (`branch_has_devices`). Their next pull would copy a branch
    that is gone, and their offline orders would be made in it. The person moves those devices (from the devices
    themselves) or revokes them first.
12. **The time limits are constants in the contract,** `SYNC_WARN_AFTER_HOURS = 24` and `SYNC_BLOCK_AFTER_DAYS = 7`,
    with one function, `syncAge()`, that turns the time since the last sync into `fresh`, `warn` or `blocked`. The
    device lists and the device itself use the same function, so "Not synced for 3 days" in Settings and the warning
    on that device change at the same hour.

**The database (18c.2):**

13. **A device remembers the sign-in it used last** (`devices.session_id`), so a revoke can end it (decision 3).
    Registering, and every pull and push, write it (18c.3), so it follows the browser through a sign-out and a new
    sign-in. It has no foreign key to `sessions`: that table belongs to every workspace and loses a row at every
    sign-out, and a foreign key would make each of those deletes reach into the devices of every workspace. A link
    left behind after a sign-out costs nothing: the revoke deletes a session that is already gone.
14. **Every revoke names who did it, and a revoked device never changes again.** `revoked_by` is set with
    `revoked_at`, and a trigger refuses a revoke without it, an "un-revoke", a rename, a move or a new sign-in on a
    revoked device (decision 4). Only `last_sync_at` may still change: a pull that started a moment before the revoke
    may finish after it. A device revoked before this step (only tests did that) keeps its empty `revoked_by`.
15. **No new index for the device list.** A workspace has tens of devices, a few hundred at most; the existing
    indexes on the workspace find them, and sorting a few hundred rows costs nothing. The search looks inside the
    names (`ILIKE '%…%'`), which no ordinary index helps with anyway.

**The API (18c.3):**

16. **The access token says which sign-in it belongs to** (a `sid` claim). The API needs it to write
    `devices.session_id`, and no request had it before: only the refresh token knew its session. The claim is
    required. A token signed before this step (one lives 15 minutes at most) is refused like an expired one, and the
    app refreshes it once, as it does every 15 minutes anyway. An optional claim would make every caller handle a
    session it does not know, for a quarter of an hour.
17. **A device's sign-in is written only when it changed,** and without the version. Registering (also an existing
    device, after a new sign-in), the push and the last page of a pull write it. Most requests compare it and write
    nothing. Like `last_sync_at` (18a, decision 32), it does not raise the version, so a new sign-in never makes the
    person's rename fail.
18. **The revoke ends the sign-in in the same transaction.** It deletes the device's session, and its refresh tokens
    go with it, so the browser cannot get a new access token. The one it holds works for its last minutes on online
    pages; the pull and the push stop at once. One sign-in is one browser, so another workspace open on the same
    browser is signed out too. Revoking the device you are on signs you out there (the app wipes it first, 18c.6).
19. **Removing a member revokes their devices** in the removal's own transaction, each with an audit row, revoked by
    the person who removed them. Their sign-ins end with them, as a refresh after a removal already did.
20. **The branch archive checks the devices before the warehouses,** and says how many (`params.count`). A branch
    with devices has warehouses too; archiving those first would leave the devices syncing a branch with no stock.
21. **The "last synced" sort counts in microseconds.** The cursor keeps the database's own time, as a whole number,
    because a JavaScript date has milliseconds only, and a cursor made from one would skip or repeat devices that
    synced in the same millisecond. A device that never synced counts as -1: first when the oldest come first, last
    when the newest do.

**The words (18c.5):**

22. **"My devices" is in the account menu, and "Devices" in the Workspace group of the sidebar.** The app has no
    Profile page: the account menu (language, theme, sign out) is where a person finds what is about themself, so
    "My devices" goes there, on the desktop and the phone. "Devices" sits after Branches, and shows only with
    `core.device.manage`, like the other workspace pages that need a permission.
23. **In Bangla, "revoke" stays an office word, রিভোক,** like সিঙ্ক and ভয়েড. Removing a member is already সরান,
    and the two must not read the same: a revoke stops one device, the person keeps working on the others.

**The screens (18c.6):**

24. **The limits count on the device's own clock.** The end of a pull saves the server's time (`lastSyncAt`, 18a)
    and now also the device's (`syncedAt`), and "how long ago" is the device's now minus `syncedAt`. Both ends then
    come from one clock, so a phone whose clock is three hours wrong still counts 24 hours right. Setting the clock
    back hides a few hours from the warning; the limit is there to protect the person from old prices, not to stop
    someone who wants to get around it. A copy made before this step has no `syncedAt` until its next pull, and the
    server's time stands in.
25. **A revoked device forgets its identity, and the next set-up makes a new id** (decision 4). The app removes the
    identity from `localStorage` instead of writing a new one at once: the other tabs see the removal (a `storage`
    event) and know the device was revoked, and no id is made for a browser that is about to sign out.
26. **One way to handle a revoke, and a refresh decides how it ends.** Four things can find out that a device is
    revoked: its pull or push (`device_revoked`), a registration that answers a revoked device, the person revoking
    this device from their own list, and another tab. All four delete the copy and the identity, then refresh the
    sign-in. The revoke ended the session (decision 18), so a refresh that fails means it happened during this
    sign-in: the person is signed out, and the sign-in page says why. A refresh that works means they signed in
    again after it, on a browser that still had the revoked id: the device is set up again, as a new one. A refresh
    that cannot reach the server signs out too: the data is gone already.
27. **A device that is closed keeps its copy until it opens again.** The server cannot reach a browser. A revoked
    laptop that is never opened again keeps its copy on its disk; one that opens is wiped at its first pull, or at the
    next sign-in on it. A sign-in that simply ran out (a refresh that fails, step 3) still keeps the copy, as before:
    it may hold changes that never synced, on a device nobody revoked. Step 19's PIN and encryption protect a copy
    left on a lost device.
28. **Changing this device's branch deletes the copy before it copies the new branch.** 18a's pull would start a
    full pull of the new branch by itself, but the lists would show the old branch's stock and warehouses until its
    last page. The outbox is checked again just before the move: the dialog's count may be a moment old.
29. **The other tabs of the same browser follow a move or a revoke.** A move or a revoke in one tab deletes the
    database that every tab of that person has open, and the other tabs would show "This browser can't keep the
    data" until a reload. Each tab listens to the `storage` event of its device's identity, and sets itself up again
    (a move) or runs the revoke steps (a revoke). The event never comes back to the tab that wrote, so two tabs
    cannot send it back and forth.
30. **The sign-in page's notice lives in the session store,** set by the sign-out that the revoke does, and cleared by
    the next sign-in. After a revoke, the requests still on their way get a 401 each and sign out again with no
    reason; a sign-out without a reason keeps the one already there, so the notice stays.
31. **Seven days blocks only what goes into the outbox.** Offline, or online for a customer whose changes still wait
    on the device (18b, decision 2), the customer and order forms open as always, with a `warn` notice in place of the
    usual one and no save button; Enter in a box does nothing either. Online saves through the API are never blocked,
    the Sync page works, and the changes already waiting are still sent. A refused draft opened from the Sync page is
    blocked too: saving it again is new work on the device.
32. **The device lists count "Not synced for 3 days" from the viewer's clock.** The list's `lastSyncAt` is the
    server's time, and the page is online, so the viewer's clock is close to it; whole days hide the rest. The same
    `syncAge()` gives the same hour as the device itself, except for a device whose own clock is far off.
33. **A row's actions are a menu, not a row click.** Elsewhere a click on a row opens its form. A device has no form,
    up to three actions, and one of them is final: a menu names each one, and "Change branch" shows only on this
    device's row. Revoked rows have no menu: nothing about them can change.
34. **Three small moves for the bundle budget** (110 KB gz per page). The two device pages were 130 KB at first: the
    dialogs (react-hook-form, the dialog) now load when a menu item is chosen, like the sign-out dialog of 18b;
    `useTenantId` and `useTimeZone` move from `stock-parts.tsx` to `lib/workspace.ts`, and `DocumentNotice` from
    `sales-parts.tsx` to `document-notice.tsx`. The old files re-export them, so no other import changes. The first
    load is now 209.9 KB of its 210: the words of 18c.5 are in it (the English locale loads with the first page).
    The next step that adds many English words has to make room first.

## 18c.1 — `packages/contracts`: the contract

The contract first, as always. A new file, `devices.ts`, holds the routes of the devices and the time limits. The
rest is one line each: the permission, an error code, three audit actions and the route list.

### `devices.ts` (new)

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { deviceNameSchema, deviceSchema } from './sync.js';

// Step 18c: the devices of a workspace. Step 18a registers one (sync.registerDevice); here people
// see them, rename them, move their own to another branch and revoke them.
//
//   GET  /me/devices              the signed-in person's own devices in this workspace
//   GET  /devices                 every device of the workspace (core.device.manage)
//   PATCH /devices/:id            rename (your own, or any with core.device.manage)
//   PUT  /devices/:id/branch      move it to another branch (your own only)
//   POST /devices/:id/revoke      stop it for good (your own, or any with core.device.manage)
//
// A revoked device stays in the list as Revoked, for the audit. It is never restored: the same
// browser signing in again makes a new device with a new id.

// A device as the lists show it: the row, plus the names a person reads instead of ids
export const deviceListItemSchema = deviceSchema.extend({
  // The person the device belongs to, also after they left the workspace
  userName: z.string(),
  branchName: z.string(),
  // Who revoked it: the person themself, someone with core.device.manage, or the person who
  // removed them from the workspace. null while it is active.
  revokedByName: z.string().nullable(),
});
export type DeviceListItem = z.infer<typeof deviceListItemSchema>;

// A person has a few devices (a browser at work, one at home, a phone), so their own list is one
// answer, not pages
export const myDeviceListSchema = z.object({ items: z.array(deviceListItemSchema) });
export type MyDeviceList = z.infer<typeof myDeviceListSchema>;

export const DEVICE_STATUSES = ['active', 'revoked'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

// 'lastSync' is the oldest sync first, with the devices that never synced before all others:
// the order an owner wants when looking for the devices that are behind
export const DEVICE_SORTS = ['name', '-name', 'lastSync', '-lastSync'] as const;
export type DeviceSort = (typeof DEVICE_SORTS)[number];

export const deviceListQuerySchema = pageQuerySchema.extend({
  // Part of the device's name or of its person's name
  search: z.string().trim().max(100).optional(),
  branchId: z.uuid().optional(),
  status: z.enum(DEVICE_STATUSES).default('active'),
  sort: z.enum(DEVICE_SORTS).default('name'),
});
export type DeviceListQuery = z.input<typeof deviceListQuerySchema>;

export const devicePageSchema = pageOf(deviceListItemSchema);
export type DevicePage = z.infer<typeof devicePageSchema>;

export const renameDeviceInputSchema = z.object({
  name: deviceNameSchema,
  version: versionSchema,
});
export type RenameDeviceInput = z.infer<typeof renameDeviceInputSchema>;
export type RenameDeviceFormValues = z.input<typeof renameDeviceInputSchema>;

export const moveDeviceInputSchema = z.object({
  // The form's empty select sends '' — "not chosen", with the same message as registering
  branchId: z.uuid(errorCode('device_branch_invalid')),
  version: versionSchema,
});
export type MoveDeviceInput = z.infer<typeof moveDeviceInputSchema>;
export type MoveDeviceFormValues = z.input<typeof moveDeviceInputSchema>;

// The time limits of working offline (step 18 decision 7). Constants, not a setting: they are a
// rule of the sync engine, like the 30 days the change log is kept.
//
// After 24 hours without a sync, the app warns. After 7 days, it stops saving new work on the
// device until it syncs again (work already waiting is still sent). A device that has been away
// that long has prices, stock and credit limits a week old, and the longer its outbox waits, the
// more of it the server may refuse.
export const SYNC_WARN_AFTER_HOURS = 24;
export const SYNC_BLOCK_AFTER_DAYS = 7;

const HOUR_MS = 60 * 60 * 1000;

export type SyncAge = 'fresh' | 'warn' | 'blocked';

// How long ago the last sync was, as the limits see it. The caller works out the time passed:
// the device from its own clock (it has no other offline), a list of devices from the server's.
// A time below zero (a clock set back) counts as fresh.
export function syncAge(msSinceLastSync: number): SyncAge {
  if (msSinceLastSync >= SYNC_BLOCK_AFTER_DAYS * 24 * HOUR_MS) return 'blocked';
  if (msSinceLastSync >= SYNC_WARN_AFTER_HOURS * HOUR_MS) return 'warn';
  return 'fresh';
}

const deviceParamsSchema = z.object({ id: z.uuid() });

// Rename, move and revoke have no permission on the route: your own device needs none, and
// someone else's needs core.device.manage. The service checks which one it is. Another person's
// device without the permission answers device_not_found, like in step 18a.
export const deviceRoutes = {
  mine: defineRoute({
    method: 'GET',
    path: '/me/devices',
    summary: "The signed-in person's devices in the active workspace, revoked ones too",
    auth: 'bearer',
    status: 200,
    response: myDeviceListSchema,
  }),
  list: defineRoute({
    method: 'GET',
    path: '/devices',
    summary: 'Every device of the active workspace, one page at a time',
    auth: 'bearer',
    permission: 'core.device.manage',
    status: 200,
    query: deviceListQuerySchema,
    response: devicePageSchema,
  }),
  rename: defineRoute({
    method: 'PATCH',
    path: '/devices/:id',
    summary: 'Rename a device',
    auth: 'bearer',
    status: 200,
    params: deviceParamsSchema,
    body: renameDeviceInputSchema,
    response: deviceListItemSchema,
  }),
  // Only from the device itself, after it synced (decision 2): the app checks that its outbox is
  // empty before it asks, because the server cannot see the outbox. The next pull is a full pull
  // of the new branch.
  move: defineRoute({
    method: 'PUT',
    path: '/devices/:id/branch',
    summary: 'Move your own device to another branch',
    auth: 'bearer',
    status: 200,
    params: deviceParamsSchema,
    body: moveDeviceInputSchema,
    response: deviceListItemSchema,
  }),
  // No version: revoking is final, and a rename a moment earlier does not change the decision.
  // Revoking a revoked device answers it as it is.
  revoke: defineRoute({
    method: 'POST',
    path: '/devices/:id/revoke',
    summary: 'Revoke a device: it stops syncing, and its data and sign-in are removed',
    auth: 'bearer',
    status: 200,
    params: deviceParamsSchema,
    response: deviceListItemSchema,
  }),
};
```

- **A file of its own, not more of `sync.ts`.** `sync.ts` is the protocol a device speaks (the pull, the push and
  registering); this file is what people do with the devices. It imports `deviceSchema` and `deviceNameSchema`
  from `sync.ts`, so a device and its name rules are written once. `sync.ts` never imports this file, so the two
  cannot import each other.
- **`deviceListItemSchema` extends `deviceSchema`** with three names. The ids are still there: the app compares
  `id` with the id it keeps in `localStorage` to mark "This device", and `branchId` with the branch select of the
  move dialog. Registering (18a) still answers a plain `deviceSchema`, so 18a's code does not change.
- **`revokedByName` is `nullable()`,** not optional: the key is always there, `null` while the device is active. The
  app then reads one shape and never has to tell "not sent" from "not revoked".
- **`myDeviceListSchema` is `{items}`,** the shape `branchListSchema` uses for a short list, not `pageOf()`: a person
  has a few devices, and one answer means the page needs no "load more".
- **`DEVICE_SORTS` lists only what the server can sort by an index:** the name and the last sync. A sort by person
  would need a join on every page. `'lastSync'` (oldest first) puts the devices that never synced before the others;
  the comment says so, because a `NULL` in a sort is the kind of detail that differs between Postgres and a guess.
- **`deviceListQuerySchema` extends `pageQuerySchema`,** so the limit (50, at most 100) and the cursor work like every
  paged list. `search` is trimmed and at most 100 letters, like the customers' search. `status` defaults to
  `active`, the tab the page opens on.
- **`renameDeviceInputSchema` reuses `deviceNameSchema`** (2 to 60 letters, trimmed, `device_name_required`), so a
  name typed in the rename dialog follows the same rule as the one the browser made when it registered.
- **`moveDeviceInputSchema` uses `errorCode('device_branch_invalid')`** for an empty branch. The select of the move
  dialog sends `''` when nothing is chosen, like the branch dialog of 18a, and both show the same message.
- **The `FormValues` types are `z.input`:** what the form holds before parsing. For these two they are the same as
  the parsed types today, but the forms of this codebase always use the input type, so a later `.default()` or
  `transform` in the schema does not break them.
- **`syncAge()` takes a number of milliseconds,** not two dates. The device measures the time on its own clock, the
  workspace list on the server's (decision 12 and 18c.6); the rule itself does not care where the number came from,
  and it stays a pure function that is easy to test. `>=` makes the boundaries exact: at 24 hours sharp the warning
  starts.
- **A negative time counts as fresh.** A clock set back after the last sync would give one; blocking a person
  because of their clock would stop real work, and a clock set back is not a reason to warn either.
- **Rename, move and revoke have no `permission` on the route** (decision 5). The API's permission guard reads the
  route's `permission` before the handler runs; a permission there would refuse a person who renames their own
  laptop. The comment above the routes says where the check is instead.
- **`mine` is `/me/devices`,** next to `/me/preferences`: everything under `/me` is about the signed-in person. A path
  like `/devices/mine` would also sit next to `/devices/:id`, and "mine" would look like an id.
- **`move` is a `PUT` on `/devices/:id/branch`:** it replaces one part of the device, like `PUT /members/:id/roles`.
  Its comment repeats decision 2, because the API alone does not show that the app must check the outbox first.
- **`revoke` is a `POST` with no body** and answers `200` with the device, so the list shows the Revoked row at once
  with who revoked it. Its comment explains why there is no version (decision 9).

```ts
import { describe, expect, it } from 'vitest';

import {
  deviceListItemSchema,
  deviceListQuerySchema,
  deviceRoutes,
  moveDeviceInputSchema,
  renameDeviceInputSchema,
  syncAge,
} from './devices.js';

const DEVICE = '0192f1c6-0000-7000-8000-000000000001';
const USER = '0192f1c6-0000-7000-8000-000000000002';
const BRANCH = '0192f1c6-0000-7000-8000-000000000003';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('device list', () => {
  it('starts with the active devices by name, 50 a page', () => {
    expect(deviceListQuerySchema.parse({})).toEqual({ limit: 50, status: 'active', sort: 'name' });
  });

  it('reads a search, a branch, the revoked tab and the oldest sync first', () => {
    expect(
      deviceListQuerySchema.parse({
        search: '  Counter ',
        branchId: BRANCH,
        status: 'revoked',
        sort: 'lastSync',
        limit: '20',
      }),
    ).toEqual({
      search: 'Counter',
      branchId: BRANCH,
      status: 'revoked',
      sort: 'lastSync',
      limit: 20,
    });
  });

  it('refuses a sort the server cannot do', () => {
    expect(deviceListQuerySchema.safeParse({ sort: 'person' }).success).toBe(false);
  });

  it('names the person, the branch and who revoked it', () => {
    // The counter computer of the Chattogram depot, revoked by the owner after it was replaced
    const counter = {
      id: DEVICE,
      name: 'Counter 2',
      branchId: BRANCH,
      userId: USER,
      lastSyncAt: '2026-10-20T04:30:00.000Z',
      revokedAt: '2026-10-22T09:00:00.000Z',
      createdAt: '2026-10-01T03:00:00.000Z',
      version: 3,
      userName: 'Tanvir Ahmed',
      branchName: 'Chattogram depot',
      revokedByName: 'Farhana Akter',
    };
    expect(deviceListItemSchema.parse(counter)).toEqual(counter);
  });
});

describe('rename and move', () => {
  it('trims the new name, and needs the version the person saw', () => {
    expect(renameDeviceInputSchema.parse({ name: ' Sales laptop ', version: 2 })).toEqual({
      name: 'Sales laptop',
      version: 2,
    });
    expect(renameDeviceInputSchema.safeParse({ name: 'Sales laptop' }).success).toBe(false);
  });

  it('refuses a one-letter name and an empty branch, each with its code', () => {
    expect(
      renameDeviceInputSchema.safeParse({ name: 'L', version: 1 }).error?.issues[0]?.message,
    ).toBe('device_name_required');
    expect(
      moveDeviceInputSchema.safeParse({ branchId: '', version: 1 }).error?.issues[0]?.message,
    ).toBe('device_branch_invalid');
  });
});

describe('routes', () => {
  it("needs core.device.manage for the workspace's list only", () => {
    expect(deviceRoutes.list.permission).toBe('core.device.manage');
    // Your own device needs no permission; the service checks someone else's
    expect('permission' in deviceRoutes.mine).toBe(false);
    expect('permission' in deviceRoutes.rename).toBe(false);
    expect('permission' in deviceRoutes.move).toBe(false);
    expect('permission' in deviceRoutes.revoke).toBe(false);
  });
});

describe('the offline time limits', () => {
  it('is fresh for a day, warns after 24 hours and blocks after 7 days', () => {
    expect(syncAge(0)).toBe('fresh');
    expect(syncAge(DAY - 1)).toBe('fresh');
    expect(syncAge(DAY)).toBe('warn');
    expect(syncAge(7 * DAY - 1)).toBe('warn');
    expect(syncAge(7 * DAY)).toBe('blocked');
    expect(syncAge(40 * DAY)).toBe('blocked');
  });

  it('counts a clock set back as fresh', () => {
    expect(syncAge(-3 * HOUR)).toBe('fresh');
  });
});
```

- **The fixture is the Chattogram depot's counter computer,** revoked by the owner after it was replaced: the case
  decision 7's names are for.
- **"Starts with the active devices by name"** pins the defaults the page relies on. If someone changed the default
  sort, the page's first sort arrow would point the wrong way, and this test says so first.
- **`limit: '20'`** is a string on purpose: a query string has no numbers, and `pageQuerySchema` coerces it.
- **The route test checks that `permission` is not on four routes.** Putting `permission: 'core.device.manage'` on
  `rename` would look like a safe change, and it would take renaming away from everyone who does not have it.
- **The time limit tests sit at the edges,** one millisecond before and at each limit, so a `>` written for `>=`
  fails here and not on someone's phone a week later.

### `permissions.ts`, `errors.ts`, `audit.ts`

```diff
@@ -5,6 +5,7 @@ export const PERMISSION_KEYS = [
   'core.user.read',
   'core.user.invite',
   'core.user.manage',
+  'core.device.manage',
   'core.role.manage',
   'core.settings.manage',
   'core.branch.manage',
@@ -69,6 +70,7 @@ export const PERMISSION_GROUP_OF = {
   'core.user.read': 'team',
   'core.user.invite': 'team',
   'core.user.manage': 'team',
+  'core.device.manage': 'team',
   'core.role.manage': 'team',
   'core.settings.manage': 'workspace',
   'core.branch.manage': 'workspace',
```

- **`core.device.manage` comes right after `core.user.manage`** in `PERMISSION_KEYS`, and in the Team group (decision
  6). The order of the list is the order of the rows in the role matrix, so it sits next to the permission it is most
  like. `PERMISSION_GROUP_OF` uses `satisfies Record<PermissionKey, PermissionGroup>`, so leaving the group out would
  fail the type check.
- **The new key will break two other places on purpose,** until their parts: `packages/db`'s description of each
  permission (18c.2) and the permission texts in `en.ts` and `bn.ts` (18c.5). Both are `satisfies` checks made for
  exactly this.

```diff
@@ -486,6 +486,9 @@ export const ERROR_CODES = [
   'sync_id_taken',
   'sync_command_invalid',
   'sync_customer_gone',
+  // Step 18c: a branch is archived only when no active device is in it. Move or revoke them
+  // first: a device's next pull would otherwise copy a branch that is gone.
+  'branch_has_devices',
   // HTTP ও সার্ভার
   'invalid_cursor',
   'version_conflict',
```

- **`branch_has_devices`** sits with the other step 18 codes, not with `branch_has_warehouses`, so the codes of one
  step stay together. Its comment says why the archive is refused (decision 11). No other new code: renaming or
  moving a revoked device answers 18a's `device_revoked`, and someone else's device `device_not_found`.

```diff
@@ -20,6 +20,9 @@ export const AUDIT_ACTIONS = [
   'branch.restored',
   'number_series.updated',
   'device.registered',
+  'device.renamed',
+  'device.moved',
+  'device.revoked',
   'member.invited',
   'member.invitation_resent',
   'member.invitation_revoked',
```

- **Three actions,** next to `device.registered`. The entity type `device` is there since 18a. A revoke done by
  removing a member is the same `device.revoked`, written by the person who removed them, so the audit log of a
  device reads the same whoever did it.

### `routes.ts`, `index.ts`, `sync.ts`

```diff
@@ -21,6 +21,7 @@ import { customFieldRoutes } from './custom-fields.js';
 import { customerGroupRoutes, customerRoutes } from './customers.js';
 import { debitNoteRoutes } from './debit-notes.js';
 import { deliveryRoutes } from './deliveries.js';
+import { deviceRoutes } from './devices.js';
 import { documentOutputRoutes, publicDocumentRoutes } from './document-output.js';
 import { goodsReceiptRoutes } from './goods-receipts.js';
 import { priceListRoutes } from './price-lists.js';
@@ -133,4 +134,5 @@ export const routes = {
   debitNotes: debitNoteRoutes,
   supplierRefunds: supplierRefundRoutes,
   sync: syncRoutes,
+  devices: deviceRoutes,
 };
```

- **`devices: deviceRoutes`** in the route list makes the API's route test (`apps/api/src/contract.spec.ts`) expect
  the five routes, and the OpenAPI document list them. The test fails until 18c.3 serves them; that is the reminder.

```diff
@@ -11,6 +11,7 @@ export * from './custom-fields.js';
 export * from './customers.js';
 export * from './debit-notes.js';
 export * from './deliveries.js';
+export * from './devices.js';
 export * from './document-output.js';
 export * from './errors.js';
 export * from './fields.js';
```

```diff
@@ -421,7 +421,7 @@ export type SyncPush = z.infer<typeof syncPushSchema>;
 
 // ---------------------------------------------------------------------------------------------
 // Devices. Step 18a registers one; step 18c lists them, renames them, moves them to another
-// branch and revokes them.
+// branch and revokes them (devices.ts).
 
 export const deviceSchema = z.object({
   id: z.uuid(),
```

- **Only the comment changes:** it points to the new file.

### Check this part

```bash
pnpm --filter @omnivo/contracts typecheck
pnpm --filter @omnivo/contracts test
```

Both pass (contracts 291 tests, 9 new). Do not run the whole `pnpm typecheck` yet: `packages/db`'s permission
descriptions miss `core.device.manage` until 18c.2, `en.ts` misses the permission, the error code and the audit
actions until 18c.5, and the API's route test fails until 18c.3 serves the five routes.

## 18c.2 — `packages/db`: who revoked it, and the sign-in to end

Two columns on `devices`: the sign-in session the device used last (decision 13) and the person who revoked it
(decision 14). Migration 0047 is generated from the schema as it is; 0048 is written by hand: the trigger that
keeps a revoked device as it was revoked. The permission's description is the one line the new key needs here.

### `schema/sync.ts`: two columns and a check

```diff
@@ -24,6 +24,7 @@ import { baseColumns } from '../base-columns.js';
 import { branches } from './branches.js';
 import { memberships } from './memberships.js';
 import { tenants } from './tenants.js';
+import { users } from './users.js';
 
 // Postgres's 64-bit transaction id (xid8). It never wraps around, unlike the old 32-bit xid, so
 // two of them always compare in the order the transactions started. A string in TypeScript: the
@@ -74,7 +75,8 @@ export const syncChanges = pgTable(
 // browser makes the id (a UUIDv7) and keeps it, so a registration whose answer was lost registers
 // the same device again. Step 18c lists, renames, moves and revokes them.
 // deleted_at (from baseColumns) is not used: a device is revoked, never deleted, because its
-// commands (step 18b) point at it.
+// commands (step 18b) point at it. A revoked device never changes again (migration 0048), and is
+// never restored: the same browser signing in again makes a new device (step 18c, decision 4).
 export const devices = pgTable(
   'devices',
   {
@@ -88,7 +90,16 @@ export const devices = pgTable(
     // When it last finished a pull, by the server's clock. The pull writes only this column, never
     // version or updated_at: a pull a minute must not make step 18c's rename fail on its version.
     lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
+    // The sign-in (Better Auth's session) the device used last: registering and every pull and
+    // push write it. A revoke deletes that session, so the browser is signed out (step 18c,
+    // decision 3). No foreign key: sessions is a table of every workspace, deleted at each
+    // sign-out, and an id left here after that only makes the revoke delete nothing.
+    sessionId: uuid('session_id'),
     revokedAt: timestamp('revoked_at', { withTimezone: true }),
+    // Who revoked it: the person themself, someone with core.device.manage, or the person who
+    // removed them from the workspace. Set with revoked_at; migration 0048 makes every revoke
+    // from step 18c on name someone.
+    revokedBy: uuid('revoked_by').references(() => users.id),
   },
   (table) => [
     // The target of the composite FKs from sync_commands and audit_logs: never another tenant's device
@@ -109,6 +120,12 @@ export const devices = pgTable(
       columns: [table.tenantId, table.branchId],
       foreignColumns: [branches.tenantId, branches.id],
     }),
+    // Nobody revokes an active device. Only one way: a device revoked before step 18c (by hand,
+    // in a test) has revoked_at without revoked_by.
+    check(
+      'devices_revoked_by_check',
+      sql`${table.revokedBy} IS NULL OR ${table.revokedAt} IS NOT NULL`,
+    ),
   ],
 );
 
```

- **The table's comment now says that a revoke is final,** and where that is enforced (migration 0048). Someone
  reading only the schema would otherwise think `revoked_at = NULL` brings a device back.
- **`session_id` is a plain `uuid`, with no `.references()`** (decision 13). Better Auth's `sessions` table holds
  every workspace's sign-ins and loses a row at every sign-out. With a foreign key, each of those deletes would check
  or change `devices` rows in every workspace (a foreign key's own check ignores row-level security), and a pull with
  an access token still valid after a sign-out (it lives up to 15 minutes) would fail on a session that no longer
  exists. Without one, an id left behind only makes a later revoke delete nothing.
- **No index on `session_id`.** Nothing looks a device up by its session: the revoke goes from the device to its
  session, and `sessions.id` is that table's primary key.
- **`revoked_by` references `users.id`,** like `approval_steps.decided_by` and `document_shares.created_by`: a
  person, not a membership, so the name still shows after the person who revoked it left the workspace (members are
  removed with `deleted_at`, so the user row stays). No index: nothing asks "what did this person revoke"; the audit
  log answers that.
- **`devices_revoked_by_check` goes one way only:** a revoker needs a revoke, but a revoke may have no revoker. A
  check that both are set together would fail the migration on a database where a device was revoked by hand
  before this step (the two API tests in this part did exactly that). Migration 0048 asks for the name on every
  revoke from now on, which a check cannot say.
- **`import { users }`** is the only new import; `sql` and `check` were already imported for the commands table.

### `permission-catalog.ts`

```diff
@@ -9,6 +9,7 @@ const DESCRIPTIONS = {
   'core.user.read': 'View people in the workspace',
   'core.user.invite': 'Invite people and manage open invitations',
   'core.user.manage': "Change members' roles and remove members",
+  'core.device.manage': "See every device of the workspace, and rename and revoke anyone's device",
   'core.role.manage': 'Create roles and choose their permissions',
   'core.settings.manage': 'Edit the company profile, regional settings and numbering',
   'core.branch.manage': 'Add, edit and archive branches',
```

- **The description says what the permission adds** to what everyone already has: their own devices need no
  permission (decision 5), so it is about "every device" and "anyone's". It fills the `permissions` table, which
  `psql` and Drizzle Studio show; the app's own text is in `en.ts` and `bn.ts` (18c.5).
- **No migration for it.** `pnpm db:migrate` runs `syncPermissions()` after the migrations, which inserts the new key.
  The `satisfies Record<PermissionKey, string>` made the type check fail since 18c.1 until this line was there.

### Migration 0047 (generated)

Run `pnpm --filter @omnivo/db generate --name devices-revoke`. The file is used as Drizzle writes it:

```sql
ALTER TABLE "devices" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "revoked_by" uuid;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_revoked_by_check" CHECK ("devices"."revoked_by" IS NULL OR "devices"."revoked_at" IS NOT NULL);
```

- **Both `ADD COLUMN`s are instant** on any size of table: a nullable column with no default changes only the catalog.
- **The foreign key and the check read the table once** to validate the rows, and every row passes: `revoked_by` is
  `NULL` everywhere. The devices table holds a few rows per person, so nothing waits.
- `meta/_journal.json` and `meta/0047_snapshot.json` change too. They are generated; commit them as they are.

### Migration 0048 (custom): a revoke is final

Run `pnpm --filter @omnivo/db generate --custom --name devices-revoke-rules`, then fill the file:

```sql
-- Custom SQL migration file, put your code below! --
-- A revoke is final (step 18c, decisions 3 and 4): the device is never restored, and the same
-- browser signing in again makes a new device. The API never changes a revoked device, but this
-- guard makes the rule hold for every code path, a script or a hand-written UPDATE too.
CREATE FUNCTION devices_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- 1) Every revoke from now on names who did it: the device list shows it, and the audit log
  --    alone is not enough once its rows are old. A CHECK cannot say "from now on" (0047's
  --    check goes one way only), so a device revoked before step 18c keeps its NULL.
  IF NEW.revoked_at IS NOT NULL AND NEW.revoked_by IS NULL
     AND (TG_OP = 'INSERT' OR OLD.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'device % is revoked without the person who revoked it', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'devices_revoked_by_required';
  END IF;

  -- 2) A revoked device stays as it was when it was revoked: no "un-revoke", no rename, no move,
  --    no new sign-in linked to it. last_sync_at may still change: a pull that started before
  --    the revoke may finish after it, and that harms nothing. version and updated_at are
  --    bookkeeping, not facts about the device.
  IF TG_OP = 'UPDATE' AND OLD.revoked_at IS NOT NULL
     AND (NEW.tenant_id, NEW.user_id, NEW.name, NEW.branch_id, NEW.session_id,
          NEW.revoked_at, NEW.revoked_by)
         IS DISTINCT FROM
         (OLD.tenant_id, OLD.user_id, OLD.name, OLD.branch_id, OLD.session_id,
          OLD.revoked_at, OLD.revoked_by) THEN
    RAISE EXCEPTION 'device % is revoked and cannot be changed', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'devices_revoked_immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER devices_guard
  BEFORE INSERT OR UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION devices_guard();
```

- **Why a trigger, when the API already refuses to rename or move a revoked device** (`device_revoked`, 18c.3)?
  Because "revoked" is the one state a device must never leave: a revoke is how an owner takes the company's data
  back from a stolen phone. A bug, a script or a hand-written `UPDATE` that cleared `revoked_at` would let that phone
  sync again, and nothing would show it. The posted documents of steps 15 to 17 are protected the same way.
- **Rule 1 is "from now on"**: it fires only when a row becomes revoked (an insert that is revoked, or an update whose
  old row was active). A device revoked before this step is not touched, which is why 0047's check can stay one-way.
  The error uses `check_violation` and a constraint name, like every guard in this codebase, so
  `isCheckViolation(error, 'devices_revoked_immutable')` (`apps/api/src/common/db/pg-errors.ts`) can catch it as it
  catches a real check, and a test can tell the two rules apart.
- **Rule 2 lists the columns that are facts about the device:** its workspace, person, name, branch, sign-in, and
  the revoke itself. `IS DISTINCT FROM` on two row values compares them all at once and treats `NULL` as a value, so
  `NULL` to a value is a change. `last_sync_at`, `version` and `updated_at` are left out on purpose (decision 14): a
  pull that passed its device check a moment before the revoke still writes `last_sync_at` at its end, and failing
  it with an error would turn a harmless race into a 500.
- **The same session id is not a change,** so the pull of 18c.3 may write `session_id` with `last_sync_at` in one
  `UPDATE` without failing in that race: the revoke does not clear the column, so the late pull writes the value it
  already has.
- **`BEFORE INSERT OR UPDATE`,** not `AFTER`: the row is refused before it is written, and no other trigger sees it.
  `DELETE` needs no rule: the API's role has had no `DELETE` on `devices` since 0044.
- **No `SECURITY DEFINER`.** The function reads only the row it is given, so it runs fine as `omnivo_app` under
  row-level security.

### Two API tests

```diff
@@ -543,8 +543,9 @@ describe('registering a device', () => {
 
   it('stops a revoked device, and checks the protocol before the device', async () => {
     const lost = await newDevice('Lost phone', narsingdi);
-    // Step 18c revokes from the device list; until then, the superuser
-    await sql`UPDATE devices SET revoked_at = now() WHERE id = ${lost.id}`;
+    // The superuser revokes it, as its own person: migration 0048 refuses a revoke that names
+    // nobody. 18c's revoke route has tests of its own (devices.int.spec.ts).
+    await sql`UPDATE devices SET revoked_at = now(), revoked_by = user_id WHERE id = ${lost.id}`;
     const pulled = await pullPage(lost.id, undefined, 10);
     expect(pulled.statusCode).toBe(403);
     expect(problemOf(pulled).code).toBe('device_revoked');
```

```diff
@@ -442,7 +442,8 @@ describe('the request', () => {
 
   it('refuses a revoked device, and runs none of its commands', async () => {
     const lost = await registerDevice(owner, 'Lost phone');
-    await sql`UPDATE devices SET revoked_at = now() WHERE id = ${lost.id}`;
+    // revoked_by: migration 0048 refuses a revoke that names nobody
+    await sql`UPDATE devices SET revoked_at = now(), revoked_by = user_id WHERE id = ${lost.id}`;
     const command = newCustomer('Lost Phone Store');
     const res = await pushRequest([command], { device: lost });
     expect(res.statusCode).toBe(403);
```

- **These tests revoke a device by hand** to check that a revoked device cannot pull or push (18a and 18b). With 0048
  that `UPDATE` fails with `devices_revoked_by_required`, so it now names the device's own person with `revoked_by =
  user_id`, a column of the same row. The revoke route of 18c.3 gets tests of its own in 18c.4.

> **What we checked.** On a throwaway database with every migration up to 0048, as `omnivo_app` (23 checks, in one
> transaction that rolls back). `pnpm db:migrate` put `core.device.manage` in the `permissions` table. A device with
> a session id whose session does not exist was saved. A revoke with no `revoked_by` failed on
> `devices_revoked_by_required`, both as an update and as an insert; `revoked_by` on an active device failed on the
> check; and a revoker who is not a user failed on the foreign key. The owner revoked the phone; revoking it again with
> `WHERE revoked_at IS NULL` changed nothing. On the revoked phone, changing the name, the branch, the person, the
> session, the revoker, or clearing the revoke all failed on `devices_revoked_immutable`; a late pull that wrote
> `last_sync_at` and the same session id passed; deleting it was refused. The other workspace saw none of these
> devices and changed none. A device revoked with the trigger off (as before this step) stayed without a revoker,
> could not be given one, and still took a `last_sync_at`. Deleting the session (a sign-out) left the device's
> `session_id` as it was.
>
> The API's sync suites (3 files, 62 tests) failed 2 tests with 0048 and before the change to those two tests: the
> two hand-written revokes. With it, all 62 pass, and so do
> all of the API's integration and tenant-leak suites (55 files, 642 tests).

### Check this part

```bash
pnpm --filter @omnivo/db typecheck
pnpm db:migrate
pnpm --filter @omnivo/db build
```

`pnpm db:migrate` applies 0047 and 0048 to your dev database and adds the new permission. The build lets the API
see the new columns in 18c.3. As in 18c.1, do not run the whole `pnpm typecheck` yet: `en.ts` still misses the
new keys until 18c.5, and the API's route test fails until 18c.3.

## 18c.3 — `apps/api`: the devices, and the revoke

The server half of this step. The access token learns its session, so the device can remember the sign-in it is used
with. A new controller serves the five routes, `DevicesService` grows the lists, rename, move and revoke, and the
revoke itself lives in a small file of its own, because removing a member revokes devices too. Last, archiving a
branch looks for devices, and the role templates that manage a branch get the new permission.

### `packages/auth`: the session in the access token

```diff
@@ -15,6 +15,9 @@ export interface AccessClaims {
   tenantId: string;
   membershipId: string;
   roles: readonly string[];
+  // Step 18c: the sign-in (Better Auth's session) this token belongs to. A device remembers the
+  // session it used last, so revoking the device can end that sign-in.
+  sessionId: string;
 }
 
 // যাচাই করা টোকেন থেকে যা বেরোয়
@@ -31,6 +34,10 @@ const payloadSchema = z.object({
   tenant_id: z.uuid(),
   membership_id: z.uuid(),
   roles: z.array(z.string()),
+  // Step 18c. Required: a token from before this claim (15 minutes at most) is refused like an
+  // expired one, and the app refreshes it once. An optional claim would make every caller handle
+  // a session it does not know.
+  sid: z.uuid(),
 });
 
 export function createAccessTokens(config: AccessTokenConfig) {
@@ -49,6 +56,8 @@ export function createAccessTokens(config: AccessTokenConfig) {
       tenant_id: claims.tenantId,
       membership_id: claims.membershipId,
       roles: [...claims.roles],
+      // "sid" is the usual JWT name for a session id (OpenID Connect)
+      sid: claims.sessionId,
     })
       .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
       .setSubject(claims.userId)
@@ -76,6 +85,7 @@ export function createAccessTokens(config: AccessTokenConfig) {
         tenantId: claims.data.tenant_id,
         membershipId: claims.data.membership_id,
         roles: claims.data.roles,
+        sessionId: claims.data.sid,
         tokenId: claims.data.jti,
         expiresAt: new Date(claims.data.exp * 1000),
       };
```

- **`sessionId` joins `AccessClaims`, and so `Principal`** (decision 16). Every service reads it through
  `currentPrincipal()`, like the user and the workspace; nothing else has to pass it on.
- **`sid` is required in `payloadSchema`.** A token without it fails `safeParse`, and `verify()` returns `null`: the
  same answer as an expired token, so the request is a 401 and the app refreshes it once. Making it `.optional()`
  would give `sessionId` the type `string | undefined` everywhere, for a case that lasts 15 minutes after the deploy.
- **The claim is called `sid`,** the name OpenID Connect gives a session id, next to the standard `sub` and `jti`.

```diff
@@ -107,14 +107,16 @@ export function createAuth(options: AuthOptions) {
     async issueTokens(input: {
       sessionId: string;
       sessionExpiresAt: Date;
-      claims: AccessClaims;
+      // The session id goes into the token from sessionId above: one source, so a token can
+      // never name another sign-in than the refresh token it comes with
+      claims: Omit<AccessClaims, 'sessionId'>;
     }): Promise<IssuedTokens> {
       const refreshToken = await createRefreshToken(db, {
         sessionId: input.sessionId,
         activeTenantId: input.claims.tenantId,
         expiresAt: input.sessionExpiresAt,
       });
-      const access = await accessTokens.sign(input.claims);
+      const access = await accessTokens.sign({ ...input.claims, sessionId: input.sessionId });
       return {
         accessToken: access.token,
         accessTokenExpiresAt: access.expiresAt,
```

- **`issueTokens()` takes the claims without `sessionId`, and adds it from its own `sessionId` field.** That field
  is what the refresh token is made for, two lines above. Taking the session id once means a token can never name
  another sign-in than the refresh token that comes with it, and no caller in `auth.service.ts` changes: they all
  pass `sessionId` next to the claims already.

```diff
@@ -15,6 +15,7 @@ const claims = {
   tenantId: '0192f0c4-7b6e-7c1a-9d2e-3f4a5b6c7d8f',
   membershipId: '0192f0c4-7b6e-7c1a-9d2e-3f4a5b6c7d90',
   roles: ['Owner'],
+  sessionId: '0192f0c4-7b6e-7c1a-9d2e-3f4a5b6c7d91',
 };
 
 describe('access tokens', () => {
@@ -71,6 +72,25 @@ describe('access tokens', () => {
     expect(await createAccessTokens(config).verify(token)).toBeNull();
   });
 
+  // Step 18c: a token signed before the sid claim existed. Refused like an expired one, so the app
+  // refreshes it and gets one that names its session.
+  it('rejects a token without a session id', async () => {
+    const key = new TextEncoder().encode(config.secret);
+    const token = await new SignJWT({
+      tenant_id: claims.tenantId,
+      membership_id: claims.membershipId,
+      roles: claims.roles,
+    })
+      .setProtectedHeader({ alg: 'HS256' })
+      .setSubject(claims.userId)
+      .setIssuer(config.issuer)
+      .setAudience(config.audience)
+      .setExpirationTime('5m')
+      .setJti('x')
+      .sign(key);
+    expect(await createAccessTokens(config).verify(token)).toBeNull();
+  });
+
   it('refuses a short secret at startup', () => {
     expect(() => createAccessTokens({ ...config, secret: 'short' })).toThrow(/at least 32 bytes/);
   });
```

- **The test claims get a `sessionId`,** so the round trip checks it comes back.
- **A new test signs a token by hand with every claim but `sid`:** the token of a moment before the deploy. It must
  be refused, or the API would run requests with no session to write.

```diff
@@ -24,6 +24,7 @@ const claims = {
   tenantId: '0192f0c4-7b6e-7c1a-9d2e-3f4a5b6c7d8f',
   membershipId: '0192f0c4-7b6e-7c1a-9d2e-3f4a5b6c7d90',
   roles: ['Owner'],
+  sessionId: '0192f0c4-7b6e-7c1a-9d2e-3f4a5b6c7d91',
 };
 
 @Controller('probe')
```

- **The middleware test signs its tokens with the same claims,** so they need the session too, or the type check
  fails on `sign()`.

### `sync/device-revoke.ts` (new): revoking, for two callers

```ts
import { devices, sessions } from '@omnivo/db';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { audit } from '../common/audit/audit.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';

// The same type as DevicesService's DeviceRow, written here so the two files do not import each
// other
type DeviceRow = typeof devices.$inferSelect;

// Step 18c, decision 3: revoking stops the sync, and ends the sign-in the device used last. Two
// callers, so it is a plain function and not a service: DevicesService.revoke (one device) and
// MembersService.remove (every device of the person removed), each in its own transaction.
//
// The rows must be locked FOR UPDATE by the caller, in the order of their ids.
export async function revokeDevices(tx: Transaction, rows: readonly DeviceRow[]): Promise<void> {
  const revokedBy = currentPrincipal().userId;
  const ended: string[] = [];
  for (const row of rows) {
    // revoked_at IS NULL: a device revoked already keeps who and when (migration 0048 refuses a
    // change anyway). A plain update, so version and updated_at move like any other change.
    const [after] = await tx
      .update(devices)
      .set({
        revokedAt: sql`now()`,
        revokedBy,
        version: sql`${devices.version} + 1`,
        updatedBy: revokedBy,
      })
      .where(
        and(eq(devices.tenantId, getTenantId()), eq(devices.id, row.id), isNull(devices.revokedAt)),
      )
      .returning({ revokedAt: devices.revokedAt });
    if (!after?.revokedAt) continue;
    if (row.sessionId !== null) ended.push(row.sessionId);
    await audit(tx, {
      action: 'device.revoked',
      entityType: 'device',
      entityId: row.id,
      changes: { revokedAt: { from: null, to: after.revokedAt.toISOString() } },
    });
  }
  // The sign-in of that browser ends with the revoke, in the same transaction: its refresh tokens
  // go with it (ON DELETE CASCADE), so the browser cannot get a new access token. The one it has
  // works for its last minutes on online pages; the pull and the push stop at once. sessions has
  // no RLS (it is every workspace's), and a session_id is only ever written by the device's own
  // person, so this never ends someone else's sign-in. The column keeps the id: it says which
  // sign-in the device had, and the trigger keeps a revoked row as it is.
  if (ended.length > 0) await tx.delete(sessions).where(inArray(sessions.id, ended));
}

// Every active device of one person in this workspace, locked in the order of their ids so two
// removals of the same person never wait for each other in a circle
export function activeDevicesOf(tx: Transaction, userId: string): Promise<DeviceRow[]> {
  return tx
    .select()
    .from(devices)
    .where(
      and(
        eq(devices.tenantId, getTenantId()),
        eq(devices.userId, userId),
        isNull(devices.revokedAt),
      ),
    )
    .orderBy(asc(devices.id))
    .for('update');
}
```

- **A plain function, not a service.** Two callers need it inside their own transaction: `DevicesService.revoke`
  (one device) and `MembersService.remove` (every device of the person removed). A service would make the members
  module import the sync module, which imports the sales module; a function needs no module at all.
- **`DeviceRow` is written again here** instead of imported from `devices.service.ts`: that file imports this one, and
  two files importing each other is a cycle the boundaries check (`no-circular`) refuses.
- **`isNull(devices.revokedAt)` in the update's `WHERE`.** The caller locked the rows, so a revoked device is not
  revoked again here, and nothing changes its revoker or its time. Migration 0048 would refuse that anyway; the
  condition means it never has to. `returning()` then tells whether this call revoked it: only those get an audit
  row and end a sign-in.
- **`revokedAt: sql\`now()\``** is the database's clock, like `last_sync_at`: the same clock everywhere in the sync.
  A plain Drizzle update, so `version` goes up and `updated_at` moves: a revoke is a real change of the row, and a
  rename form still open on it gets a version conflict.
- **The sessions are deleted after the loop, in one statement, in the same transaction** (decision 18). Its refresh
  tokens cascade with it. If the revoke rolls back, the sign-in stays. `session_id` is never cleared: it records
  which sign-in the device had, and the trigger keeps a revoked row as it was.
- **This never ends someone else's sign-in.** A device's `session_id` is written only by requests of the device's
  own person (registering checks the person, and the pull and the push go through `forSync`).
- **`activeDevicesOf()` locks in the order of the ids,** like the owner check in `members.service.ts`, so two
  transactions that lock the same devices take them in the same order and never wait for each other in a circle.

### `sync/devices.service.ts`: the lists, rename, move and revoke

The file changed almost everywhere, so here it is whole, in five pieces.

```ts
import { Inject, Injectable } from '@nestjs/common';
import type {
  Device,
  DeviceListItem,
  DevicePage,
  DeviceSort,
  DeviceStatus,
  MoveDeviceInput,
  MyDeviceList,
  RegisterDeviceInput,
  RenameDeviceInput,
} from '@omnivo/contracts';
import { branches, devices, users } from '@omnivo/db';
import { and, asc, desc, eq, isNotNull, isNull, or, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { containsPattern } from '../common/db/search.js';
import { AppError, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { type Access, PermissionService } from '../rbac/permission.service.js';
import { revokeDevices } from './device-revoke.js';

export type DeviceRow = typeof devices.$inferSelect;

function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    name: row.name,
    branchId: row.branchId,
    userId: row.userId,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

// Another person's device, an unknown id and (through RLS) another workspace's device all answer
// the same: nobody learns that an id exists somewhere else. The app registers the browser again.
function deviceNotFound(): AppError {
  return new AppError(404, 'device_not_found', 'This device is not registered. Register it again.');
}

function deviceRevoked(): AppError {
  return new AppError(403, 'device_revoked', 'This device was revoked. Its data is wiped.');
}

// Step 18c: the person who revoked a device, next to the person it belongs to (both in users)
const revoker = alias(users, 'revoker');

const listColumns = {
  device: devices,
  // users, not memberships: the name stays after the person left the workspace (decision 7)
  userName: users.fullName,
  branchName: branches.name,
  revokedByName: revoker.fullName,
};

interface ListRow {
  device: DeviceRow;
  userName: string;
  branchName: string;
  revokedByName: string | null;
}

function toListItem(row: ListRow): DeviceListItem {
  return {
    ...toDevice(row.device),
    userName: row.userName,
    branchName: row.branchName,
    revokedByName: row.revokedByName,
  };
}

// The sort key of 'lastSync': the time in microseconds, the database's own precision. A JS Date
// has milliseconds only, so a cursor made from one would skip or repeat devices that synced in
// the same millisecond. A device that never synced is -1, before every real time: first in
// 'lastSync' (decision 8), last in '-lastSync'. One expression in ORDER BY and in the cursor's
// comparison, so the two can never disagree.
const syncKey = sql`coalesce((extract(epoch from ${devices.lastSyncAt}) * 1000000)::bigint, -1)`;

function isSyncSort(sort: DeviceSort): boolean {
  return sort === 'lastSync' || sort === '-lastSync';
}
```

- **`deviceRevoked()` is a function now,** because rename and move answer it too, with the same text as the pull.
- **`revoker` is a second name for `users`** (`alias`): one query joins the device's person and the person who revoked
  it, and each needs its own name in SQL.
- **`userName` comes from `users`, not from the membership** (decision 7): a person removed from the workspace keeps
  their name in the list of revoked devices.
- **`syncKey`** is decision 21: `extract(epoch …) * 1000000` is the time in microseconds, `::bigint` makes it a whole
  number, and `coalesce(…, -1)` puts the devices that never synced before every real time. The same expression goes
  into `ORDER BY` and into the cursor's comparison below; written twice, the two could drift apart.

```ts
@Injectable()
export class DevicesService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly permissions: PermissionService,
  ) {}

  // Decision 20: the browser makes the id, so registering is safe to repeat. The same id by the
  // same person returns the device as it is, even when the name or the branch sent differ (a
  // retry of a lost answer sends the same ones; changing them is step 18c's rename and move).
  register(input: RegisterDeviceInput): Promise<Device> {
    return this.withTenant(async (tx) => {
      const known = await this.ownedOrNone(tx, input.id);
      if (known) {
        // Step 18c: signed in again on the same browser (a new session), the device follows it.
        // A revoked one is returned as it is: the app wipes it and makes a new id (decision 4).
        await this.keepSession(tx, known);
        return toDevice(known);
      }

      const branch = await this.activeBranchCode(tx, input.branchId);
      const { userId, sessionId } = currentPrincipal();
      const [row] = await tx
        .insert(devices)
        .values({
          id: input.id,
          tenantId: getTenantId(),
          userId,
          name: input.name,
          branchId: input.branchId,
          sessionId,
          createdBy: userId,
        })
        // Two registrations of the same id at once (the app retried while the first was still
        // running): the second waits for the first to commit, inserts nothing, and reads the row
        // below. Also an id taken in another workspace: the primary key is global, RLS is not.
        .onConflictDoNothing({ target: devices.id })
        .returning();
      if (!row) {
        const raced = await this.ownedOrNone(tx, input.id);
        if (raced) return toDevice(raced);
        throw new AppError(409, 'device_id_invalid', 'Make a new id for this device.');
      }
      await audit(tx, {
        action: 'device.registered',
        entityType: 'device',
        entityId: row.id,
        changes: created({ name: row.name, branch }),
      });
      return toDevice(row);
    });
  }

  // The pull's and the push's check, inside a transaction: the device is this person's, and not
  // revoked
  async forSync(tx: Transaction, id: string): Promise<DeviceRow> {
    const [row] = await tx
      .select()
      .from(devices)
      .where(and(eq(devices.tenantId, getTenantId()), eq(devices.id, id)));
    if (row?.userId !== currentPrincipal().userId) throw deviceNotFound();
    if (row.revokedAt !== null) throw deviceRevoked();
    return row;
  }

  // Step 18c (decision 13): the device remembers the sign-in it is used with, so a revoke can end
  // it. Written only when it changed (a new sign-in on the same browser), so most requests write
  // nothing. A raw statement, like the pull's last_sync_at: no version and no updated_at, or a
  // sign-in would make the person's rename fail on its version. revoked_at IS NULL: a revoke that
  // committed after the caller read the row wins, and the trigger never sees a revoked row change.
  async keepSession(tx: Transaction, row: DeviceRow): Promise<void> {
    const { sessionId } = currentPrincipal();
    if (row.revokedAt !== null || row.sessionId === sessionId) return;
    await tx.execute(
      sql`UPDATE devices SET session_id = ${sessionId}::uuid
           WHERE tenant_id = ${getTenantId()}::uuid AND id = ${row.id}::uuid
             AND revoked_at IS NULL`,
    );
  }
```

- **`PermissionService` is injected** for rename and revoke, which need to know whether the person has
  `core.device.manage`. The sync module imports the RBAC module already (18b).
- **Registering a known device calls `keepSession()`** before it answers. This is the case of a person who signed out
  and in again on the same browser: the device is the same, the sign-in is new, and the revoke must end the new one.
  A revoked device is answered as it is, and keeps its old session (decision 4: the app then makes a new id).
- **A new device is inserted with the session of the request.**
- **`keepSession()` compares before it writes** (decision 17). On almost every request the session is the same, and
  nothing is written. It is a raw statement for the same reason as the pull's `last_sync_at`: Drizzle's `update()`
  sets `updated_at` through `$onUpdate`, and a raised version would make a rename fail.
- **`AND revoked_at IS NULL` in `keepSession()`'s statement.** The caller read the row a moment ago; a revoke may have
  committed since. Under READ COMMITTED the `UPDATE` reads the row again, sees it revoked and changes nothing,
  instead of running into 0048's `devices_revoked_immutable` with a 500.

```ts
  // The signed-in person's devices here, active first, then by name. All of them in one answer:
  // a person has a few (decision 8).
  mine(): Promise<MyDeviceList> {
    return this.withTenant(async (tx) => {
      const rows = await this.selectList(tx)
        .where(
          and(eq(devices.tenantId, getTenantId()), eq(devices.userId, currentPrincipal().userId)),
        )
        .orderBy(sql`${devices.revokedAt} IS NOT NULL`, asc(devices.name), asc(devices.id));
      return { items: rows.map(toListItem) };
    });
  }

  // Every device of the workspace (core.device.manage, checked on the route), one page at a time
  list(query: {
    search?: string | undefined;
    branchId?: string | undefined;
    status: DeviceStatus;
    sort: DeviceSort;
    limit: number;
    cursor?: string | undefined;
  }): Promise<DevicePage> {
    // cursor = [sort, the last row's key, its id]. The sort is checked as a literal: a cursor made
    // for another sort would start the page at the wrong place, so it is a 400 instead. The key of
    // the sync sorts is a whole number (syncKey), anything else is refused before it reaches SQL.
    const bySync = isSyncSort(query.sort);
    const after = decodeCursor(
      query.cursor,
      z.tuple([
        z.literal(query.sort),
        bySync ? z.string().regex(/^-?\d{1,19}$/) : z.string(),
        z.uuid(),
      ]),
    );
    const descending = query.sort.startsWith('-');
    const direction = descending ? desc : asc;
    const key = bySync ? syncKey : sql`${devices.name}`;

    const conditions: (SQL | undefined)[] = [
      eq(devices.tenantId, getTenantId()),
      query.status === 'active' ? isNull(devices.revokedAt) : isNotNull(devices.revokedAt),
      query.branchId === undefined ? undefined : eq(devices.branchId, query.branchId),
    ];
    if (query.search) {
      // The device's name or its person's name (decision 8). No index helps a "contains"; a
      // workspace has a few hundred devices at most (decision 15).
      const pattern = containsPattern(query.search);
      conditions.push(
        or(
          sql`lower(${devices.name}) LIKE ${pattern}`,
          sql`lower(${users.fullName}) LIKE ${pattern}`,
        ),
      );
    }
    if (after) {
      // (key, id) pairs: the id (unique) breaks ties between two devices with the same name or the
      // same sync time. The key is cast back to what it is: text for a name, bigint for a time.
      const cursorKey = bySync ? sql`${after[1]}::bigint` : sql`${after[1]}`;
      conditions.push(
        descending
          ? sql`(${key}, ${devices.id}) < (${cursorKey}, ${after[2]}::uuid)`
          : sql`(${key}, ${devices.id}) > (${cursorKey}, ${after[2]}::uuid)`,
      );
    }

    return this.withTenant(async (tx) => {
      const rows = await tx
        // The key as text: a bigint comes back from the driver as a string anyway, and the cursor
        // keeps it as one
        .select({ ...listColumns, key: sql<string>`${key}::text` })
        .from(devices)
        .innerJoin(users, eq(users.id, devices.userId))
        .innerJoin(
          branches,
          and(eq(branches.tenantId, devices.tenantId), eq(branches.id, devices.branchId)),
        )
        .leftJoin(revoker, eq(revoker.id, devices.revokedBy))
        .where(and(...conditions))
        .orderBy(direction(key), direction(devices.id))
        .limit(query.limit + 1);
      const page = toPage(rows, query.limit, (last) => [query.sort, last.key, last.device.id]);
      return { items: page.items.map(toListItem), nextCursor: page.nextCursor };
    });
  }
```

- **`mine()` orders the active devices first** (`revoked_at IS NOT NULL` is false for them, and false sorts first),
  then by name. One answer, no pages (decision 8).
- **The cursor is `[sort, key, id]`, and the sort is checked as a literal,** like the members list: a cursor made for
  another sort is a 400, not a page that starts at the wrong place.
- **The key of the sync sorts must be a whole number** (`regex(/^-?\d{1,19}$/)`, at most 19 digits: a `bigint`). A
  cursor edited by hand is refused by the schema, before `::bigint` could fail in Postgres with a 500.
- **Search looks in the device's name and in the person's name** (decision 8), with `containsPattern()`, which makes
  `%` and `_` typed by the person mean themselves. No index helps a "contains"; the list is small (decision 15).
- **`(key, id) > (cursorKey, id)`** is the keyset comparison the other lists use. The id (unique) breaks ties: two
  devices called "Chrome on Windows", or several that never synced.
- **The key is selected as text** (`::text`), so the cursor holds the exact value the next page compares with. A
  `bigint` would come back from the driver as a string anyway; text says so in the type.
- **`innerJoin(branches)` with the tenant in the condition,** like every join on a composite key here: a branch is
  found by its workspace and its id.

```ts
  // Your own device, or anyone's with core.device.manage (decision 5)
  async rename(id: string, input: RenameDeviceInput): Promise<DeviceListItem> {
    const access = await this.permissions.ofCurrentUser();
    return this.withTenant(async (tx) => {
      const before = await this.lockVisible(tx, id, access);
      // Revoked first: a reload after a version conflict would only end in this anyway
      if (before.revokedAt !== null) throw deviceRevoked();
      if (before.version !== input.version) throw versionConflict();
      if (before.name !== input.name) {
        await tx
          .update(devices)
          .set({
            name: input.name,
            version: sql`${devices.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(devices.tenantId, getTenantId()), eq(devices.id, id)));
        await audit(tx, {
          action: 'device.renamed',
          entityType: 'device',
          entityId: id,
          changes: diff({ name: before.name }, { name: input.name }),
        });
      }
      return this.item(tx, id);
    });
  }

  // Your own device only, even with core.device.manage (decision 2): only the device knows that
  // its outbox is empty, and the app checks that before it asks (decision 10)
  move(id: string, input: MoveDeviceInput): Promise<DeviceListItem> {
    return this.withTenant(async (tx) => {
      const before = await this.lockOwn(tx, id);
      if (before.revokedAt !== null) throw deviceRevoked();
      if (before.version !== input.version) throw versionConflict();
      // The branch it is in already: nothing changes, no audit row (decision 10)
      if (before.branchId === input.branchId) return this.item(tx, id);

      // FOR SHARE on the new branch, like registering: an archive of it waits for this commit,
      // and then sees the device in it (branch_has_devices)
      const to = await this.activeBranchCode(tx, input.branchId);
      const [from] = await tx
        .select({ code: branches.code })
        .from(branches)
        .where(and(eq(branches.tenantId, getTenantId()), eq(branches.id, before.branchId)));
      await tx
        .update(devices)
        .set({
          branchId: input.branchId,
          version: sql`${devices.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(devices.tenantId, getTenantId()), eq(devices.id, id)));
      await audit(tx, {
        action: 'device.moved',
        entityType: 'device',
        entityId: id,
        changes: diff({ branch: from?.code ?? null }, { branch: to }),
      });
      // Nothing else: the device's next pull sees a cursor of the old branch and starts a full
      // pull of the new one (SyncService.restartsFull)
      return this.item(tx, id);
    });
  }

  // Your own device, or anyone's with core.device.manage. Final, and safe to repeat: a revoked
  // device is answered as it is (decision 9).
  async revoke(id: string): Promise<DeviceListItem> {
    const access = await this.permissions.ofCurrentUser();
    return this.withTenant(async (tx) => {
      const before = await this.lockVisible(tx, id, access);
      if (before.revokedAt === null) await revokeDevices(tx, [before]);
      return this.item(tx, id);
    });
  }
```

- **Rename reads the permissions before the transaction,** as `MembersService` does: `ofCurrentUser()` may read the
  cache or the database, and that read does not belong inside a transaction that holds a lock on the device.
- **The order of the checks in rename:** not found, then revoked, then the version. A revoked device with an old
  version would otherwise answer "reload and try again", and the reload would only end in "revoked".
- **The same name again changes nothing:** no new version, no audit row.
- **Move uses `lockOwn()`:** someone else's device is `device_not_found`, even with `core.device.manage`
  (decision 2). The server cannot see the outbox; the app checks it before it asks (decision 10).
- **The new branch is read with `activeBranchCode()`,** `FOR SHARE`, like registering. An archive of that branch at
  the same moment waits for this commit, and then its device count sees this device (decision 11).
- **The old branch's code is read without a lock,** only for the audit row; `from?.code ?? null` keeps the type
  honest, although the foreign key means the branch is always there.
- **Move writes only the branch.** The next pull of the device sees a cursor of the old branch, and
  `SyncService.restartsFull` starts a full pull of the new one (18a), which also drops what the old branch had.
- **Revoke locks the device with `lockVisible()` and calls `revokeDevices()` only when it is still active.** A second
  revoke answers the device as it is (decision 9): a double click, or two people at once, gets the same answer.

```ts
  // The list's select, without its WHERE: the person, the branch and who revoked it
  private selectList(tx: Transaction) {
    return tx
      .select(listColumns)
      .from(devices)
      .innerJoin(users, eq(users.id, devices.userId))
      .innerJoin(
        branches,
        and(eq(branches.tenantId, devices.tenantId), eq(branches.id, devices.branchId)),
      )
      .leftJoin(revoker, eq(revoker.id, devices.revokedBy));
  }

  // One device as the lists show it, read after a change in the same transaction
  private async item(tx: Transaction, id: string): Promise<DeviceListItem> {
    const [row] = await this.selectList(tx).where(
      and(eq(devices.tenantId, getTenantId()), eq(devices.id, id)),
    );
    if (!row) throw deviceNotFound();
    return toListItem(row);
  }

  // The device, locked until the commit: two renames, or a rename and a revoke, one after the
  // other. Someone else's device without core.device.manage is device_not_found, like an id that
  // does not exist (decision 5).
  private async lockVisible(tx: Transaction, id: string, access: Access): Promise<DeviceRow> {
    const row = await this.lock(tx, id);
    if (
      row.userId !== currentPrincipal().userId &&
      !access.permissions.includes('core.device.manage')
    ) {
      throw deviceNotFound();
    }
    return row;
  }

  private async lockOwn(tx: Transaction, id: string): Promise<DeviceRow> {
    const row = await this.lock(tx, id);
    if (row.userId !== currentPrincipal().userId) throw deviceNotFound();
    return row;
  }

  private async lock(tx: Transaction, id: string): Promise<DeviceRow> {
    const [row] = await tx
      .select()
      .from(devices)
      .where(and(eq(devices.tenantId, getTenantId()), eq(devices.id, id)))
      .for('update');
    if (!row) throw deviceNotFound();
    return row;
  }

  // An active branch of this workspace, by its code for the audit log. FOR SHARE: nobody archives
  // it before we commit.
  private async activeBranchCode(tx: Transaction, id: string): Promise<string> {
    const [branch] = await tx
      .select({ code: branches.code })
      .from(branches)
      .where(
        and(eq(branches.tenantId, getTenantId()), eq(branches.id, id), isNull(branches.archivedAt)),
      )
      .for('share');
    if (!branch) {
      throw new AppError(409, 'device_branch_invalid', 'Pick an active branch.', {
        fieldErrors: { branchId: ['device_branch_invalid'] },
      });
    }
    return branch.code;
  }

  // The device with this id, when it is the signed-in person's. Another person's id in this
  // workspace is device_id_invalid: their device keeps its id, and this browser makes a new one.
  private async ownedOrNone(tx: Transaction, id: string): Promise<DeviceRow | undefined> {
    const [row] = await tx
      .select()
      .from(devices)
      .where(and(eq(devices.tenantId, getTenantId()), eq(devices.id, id)));
    if (!row) return undefined;
    if (row.userId !== currentPrincipal().userId) {
      throw new AppError(409, 'device_id_invalid', 'Make a new id for this device.');
    }
    return row;
  }
}
```

- **`selectList()` is the one place the joins are written,** for `mine()`, for `item()`, and the same joins as
  `list()`, which adds its sort key to the columns.
- **Each change answers with `item()`, read in the same transaction,** so the answer has the new version and the
  names the lists show (`revokedByName` right after a revoke).
- **`lockVisible()` answers `device_not_found` for someone else's device without the permission** (decision 5): the
  person learns nothing about a device that is not theirs. It locks first and checks after; a refused request ends
  its transaction at once, so that lock lasts a moment.
- **`lock()` is `FOR UPDATE`:** a rename and a revoke of the same device run one after the other, and the second one
  sees the first one's version.

### `sync/devices.controller.ts` (new)

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { DevicesService } from './devices.service.js';

type Routes = typeof routes.devices;

// Step 18c. Only the workspace list has a permission on its route (core.device.manage). Rename,
// move and revoke check in the service whether the device is the person's own (decision 5).
@Controller()
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Endpoint(routes.devices.mine)
  mine(): Promise<RouteResponse<Routes['mine']>> {
    return this.devices.mine();
  }

  @Endpoint(routes.devices.list)
  list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return this.devices.list(query);
  }

  @Endpoint(routes.devices.rename)
  rename({ params, body }: RouteInput<Routes['rename']>): Promise<RouteResponse<Routes['rename']>> {
    return this.devices.rename(params.id, body);
  }

  @Endpoint(routes.devices.move)
  move({ params, body }: RouteInput<Routes['move']>): Promise<RouteResponse<Routes['move']>> {
    return this.devices.move(params.id, body);
  }

  @Endpoint(routes.devices.revoke)
  revoke({ params }: RouteInput<Routes['revoke']>): Promise<RouteResponse<Routes['revoke']>> {
    return this.devices.revoke(params.id);
  }
}
```

- **A second controller in the sync module,** not more routes in `SyncController`: those three are the device's own
  calls (register, pull, push); these five are the people's.
- **Only `list` has a permission, on its route** (`core.device.manage`, checked by the guard from the contract).
  The other four check in the service, because the answer depends on whose device it is.

### `sync/sync.module.ts`, `sync/sync.service.ts`, `sync/sync-push.service.ts`

```diff
@@ -2,6 +2,7 @@ import { Module } from '@nestjs/common';
 
 import { RbacModule } from '../rbac/rbac.module.js';
 import { SalesModule } from '../sales/sales.module.js';
+import { DevicesController } from './devices.controller.js';
 import { DevicesService } from './devices.service.js';
 import { SyncController } from './sync.controller.js';
 import { SyncService } from './sync.service.js';
@@ -10,10 +11,11 @@ import { SyncPushService } from './sync-push.service.js';
 // Step 18a: the read half of the sync engine (devices and the pull). SyncLogCleanup is not here:
 // it is the worker's (WorkerModule), on the worker's database role. Step 18b: the push, which
 // runs a device's commands with the sales services (SalesModule) and checks each command's
-// permission (RbacModule).
+// permission (RbacModule). Step 18c: the device lists, rename, move and revoke (DevicesController),
+// which also read the person's permissions.
 @Module({
   imports: [RbacModule, SalesModule],
-  controllers: [SyncController],
+  controllers: [SyncController, DevicesController],
   providers: [DevicesService, SyncService, SyncPushService],
 })
 export class SyncModule {}
```

- **The new controller is registered;** `DevicesService` is a provider of the module already.

```diff
@@ -12,7 +12,7 @@ import { and, asc, eq, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
 import { z } from 'zod';
 
 import { AppError } from '../common/http/app-error.js';
-import { getTenantId } from '../common/tenant/tenant-context.js';
+import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
 import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
 import { DevicesService } from './devices.service.js';
@@ -76,10 +76,16 @@ export class SyncService {
 
       // The device finished a pull: by the database's clock (decision 19), and without touching
       // version or updated_at (decision 32), so a raw statement: Drizzle's update() would set
-      // updated_at through $onUpdate
+      // updated_at through $onUpdate. Step 18c: with the sign-in it pulled with (decision 13),
+      // here and not on the first page, so the pages before still write nothing. The CASE: a
+      // revoke that committed while this waited keeps its session_id (migration 0048 refuses a
+      // change); its last_sync_at may still move.
       if (!page.hasMore) {
         await tx.execute(
-          sql`UPDATE devices SET last_sync_at = now()
+          sql`UPDATE devices SET last_sync_at = now(),
+                     session_id = CASE WHEN revoked_at IS NULL
+                                       THEN ${currentPrincipal().sessionId}::uuid
+                                       ELSE session_id END
                WHERE tenant_id = ${getTenantId()}::uuid AND id = ${device.id}::uuid`,
         );
       }
```

- **The session is written with `last_sync_at`, on the last page only.** The pages before write nothing, so the pull
  keeps having no transaction id of its own while it reads (its watermark, 18a decision 25).
- **The `CASE`:** a revoke that commits while this statement waits on the row makes `revoked_at` set when the
  `UPDATE` reads the row again. The `CASE` then keeps the old session, which 0048 requires; `last_sync_at` may still
  move (0048 allows that).

```diff
@@ -79,7 +79,12 @@ export class SyncPushService {
     if (input.protocol !== SYNC_PROTOCOL) {
       throw new AppError(409, 'sync_protocol_mismatch', 'Reload the app to sync again.');
     }
-    const device = await this.withTenant((tx) => this.devices.forSync(tx, input.deviceId));
+    // Step 18c: and the sign-in it pushes with (decision 13), in the same short transaction
+    const device = await this.withTenant(async (tx) => {
+      const row = await this.devices.forSync(tx, input.deviceId);
+      await this.devices.keepSession(tx, row);
+      return row;
+    });
     // The person's roles of now (decision 17), read once for the batch: one request is one moment
     const access = await this.permissions.ofCurrentUser();
     const results: SyncResult[] = [];
```

- **The push writes the session in its first, short transaction,** the one that checks the device. The commands run
  in transactions of their own after it, so this adds no lock to them.

### `members/members.service.ts`: a removed member's devices

```diff
@@ -12,6 +12,7 @@ import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
 import { assertCanGrant, loadRoles, type RoleGrant } from '../rbac/grants.js';
 import { PermissionService } from '../rbac/permission.service.js';
+import { activeDevicesOf, revokeDevices } from '../sync/device-revoke.js';
 
 interface MemberRow {
   membershipId: string;
@@ -193,6 +194,9 @@ export class MembersService {
           updatedBy: actor.userId,
         })
         .where(and(eq(memberships.tenantId, tenantId), eq(memberships.id, membershipId)));
+      // Step 18c: their devices stop with them, in the same transaction. Each one is revoked by
+      // the person removing them (an audit row each), and the sign-in each one used ends.
+      await revokeDevices(tx, await activeDevicesOf(tx, before.userId));
       await audit(tx, {
         action: 'member.removed',
         entityType: 'member',
```

- **In the removal's transaction, after the membership is closed** (decision 19): the devices are revoked if and only
  if the person is removed. The person removing them is the revoker (`currentPrincipal()`), and each device gets its
  own `device.revoked` row next to `member.removed`.
- **The order of the locks** is the membership, then the devices. Nothing locks a device first and the membership
  after, so the two cannot wait for each other in a circle.

### `branches/branches.service.ts`: a branch with devices stays

```diff
@@ -1,6 +1,6 @@
 import { Inject, Injectable } from '@nestjs/common';
 import type { Branch, BranchInput, BranchStatus } from '@omnivo/contracts';
-import { branches, warehouses } from '@omnivo/db';
+import { branches, devices, warehouses } from '@omnivo/db';
 import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
 
 import { audit, created, diff } from '../common/audit/audit.js';
@@ -131,6 +131,26 @@ export class BranchesService {
           'A workspace needs at least one active branch.',
         );
       }
+      // Step 18c, decision 11: a device keeps a copy of one branch, and makes its offline orders
+      // there. Move or revoke them first. Checked before the warehouses: a branch with devices has
+      // warehouses too, and archiving those first would leave the devices syncing a branch with no
+      // stock. A device registering or moving into this branch right now holds it FOR SHARE, so
+      // the lock above waited for it, and this count sees it.
+      const [inBranch] = await tx
+        .select({ count: sql<number>`count(*)::int` })
+        .from(devices)
+        .where(
+          and(eq(devices.tenantId, tenantId), eq(devices.branchId, id), isNull(devices.revokedAt)),
+        );
+      const deviceCount = inBranch?.count ?? 0;
+      if (deviceCount > 0) {
+        throw new AppError(
+          409,
+          'branch_has_devices',
+          `Move or revoke the ${String(deviceCount)} devices in this branch first.`,
+          { params: { count: deviceCount } },
+        );
+      }
       // Step 13: a warehouse lives in a branch. Archive (or move) its warehouses first, so no
       // stock is left in a branch nobody can pick any more. FOR UPDATE: a warehouse being created in
       // this branch right now holds the branch FOR SHARE, so one of the two waits for the other.
```

- **The count runs after the lock on every active branch,** at the top of `archive()`. A device that registers or
  moves into this branch holds it `FOR SHARE`, which waits for that lock or makes the archive wait; either way the
  count, a new statement, sees the device once the other transaction committed.
- **Before the warehouses** (decision 20), and with the number in `params`, so 18c.5's message can say "Move or revoke
  the 2 devices in this branch first."
- **`String(deviceCount)`** in the English detail: the lint rule `restrict-template-expressions` refuses a number in a
  template string, so that a value never turns into text by accident.
- **`inBranch?.count ?? 0`:** `count(*)` always returns one row, but Drizzle's array type does not know that.

### `setup/templates.ts`: who gets the new permission

```diff
@@ -500,6 +500,8 @@ export const INDUSTRY_TEMPLATES = {
         description: 'Stock by batch and expiry at a depot',
         permissions: [
           'core.branch.manage',
+          // Step 18c: a lost phone is reported to the person in charge of the depot or shop first
+          'core.device.manage',
           'inventory.product.manage',
           'inventory.warehouse.manage',
           ...STOCK_WORK,
@@ -575,6 +577,7 @@ export const INDUSTRY_TEMPLATES = {
         description: 'Stock and deliveries at a depot',
         permissions: [
           'core.branch.manage',
+          'core.device.manage',
           'inventory.product.manage',
           'inventory.warehouse.manage',
           ...STOCK_WORK,
@@ -685,6 +688,7 @@ export const INDUSTRY_TEMPLATES = {
         permissions: [
           'core.user.read',
           'core.branch.manage',
+          'core.device.manage',
           'inventory.product.manage',
           'inventory.warehouse.manage',
           ...STOCK_WORK,
```

- **The three roles that have `core.branch.manage` get `core.device.manage`:** the depot managers (pharmaceutical and
  distribution) and the shop manager (decision 6). A lost phone is reported to the person in charge of that depot or
  shop first. The templates are used when a new workspace is set up; in an existing workspace the owner adds the
  permission to a role in the role matrix.

### Check this part

```bash
pnpm --filter @omnivo/auth build
pnpm --filter @omnivo/api typecheck
pnpm exec eslint apps/api/src packages/auth/src
pnpm --filter @omnivo/api test
```

The auth package is built first: the API reads it from `dist/`, and its type check needs the new `sessionId`. The
packages have no `lint` script of their own (the root's `pnpm lint` builds every package and lints the whole repo),
so ESLint runs on the two folders this part touched. All four pass. The API's integration suites of sync, members, branches, auth, setup and roles pass too (185 tests); the
new routes get their own tests in 18c.4. The whole `pnpm typecheck` still fails until 18c.5, on the new keys `en.ts`
does not have yet.

## 18c.4 — `apps/api`: the tests

One new integration test file, and a new part in the sync tenant-leak test:

- `sync/devices.int.spec.ts` follows a distributor with a head office and a Chattogram depot, and four people who
  use devices: the owner, Rafiq (a salesperson with no role), Nasrin (the depot manager) and Tanvir (a sales
  officer who is removed from the workspace). It tests the two lists, rename, move and revoke, the sign-in a device
  follows, the removal of a member and the archive of a branch. 18c.2 pointed its comment in `sync.int.spec.ts` at
  this file name, so the name is fixed.
- `sync/sync.tenant-leak.int.spec.ts` gets a part for the new routes: the owner of workspace A, who has every
  permission, never sees, renames, moves or revokes a device of workspace B.

**They found no bug in the 18c.3 code.** Four "break it on purpose" checks made sure the tests would have noticed
the bugs that matter most here:

- Writing the new session in the pull's last `UPDATE` without the `CASE` fails the race test with a 500: the row was
  revoked while the pull waited, and migration 0048 refuses a new session on a revoked device.
- Counting the "last synced" sort key in milliseconds (`* 1000`, not `* 1000000`) fails the microsecond test: two
  devices that synced 100 µs apart get the same key, and their id decides their order instead of their time.
- Not deleting the device's session on a revoke fails four tests: the revoke itself, the revoke by a manager, the
  sign-in a device follows, and the member removal. The browser could still get new access tokens.
- Not calling `keepSession()` when a known device registers again fails "the sign-in a device follows": after a new
  sign-in on the same browser, a revoke would end the old sign-in and leave the new one working.

### `sync/devices.int.spec.ts` (new): the setup

```ts
import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  auditPageSchema,
  type Branch,
  branchSchema,
  type Device,
  type DeviceListItem,
  deviceListItemSchema,
  devicePageSchema,
  deviceSchema,
  memberPageSchema,
  myDeviceListSchema,
  problemSchema,
  roleListSchema,
  setupSchema,
  syncPullSchema,
  syncPushSchema,
  type Warehouse,
  warehouseSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createTestApp,
  createTestWorker,
  eventually,
  testConfig,
  testWorkerConfig,
} from '../testing/app.js';
import {
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { joinWithoutRoles } from '../testing/workspace.js';

// A distributor with a head office and a depot in Chattogram. Four people use devices: the owner,
// Rafiq (a salesperson with no role), Nasrin (the depot manager, whose role template has
// core.device.manage) and Tanvir (a sales officer who is removed from the workspace).
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
// The superuser, for what no route shows: a device's session, the time of its last sync
let sql: postgres.Sql;
let owner: SignedIn;
let rafiq: SignedIn;
let nasrin: SignedIn;
let tanvir: SignedIn;
let headOffice: Branch;
let chattogram: Branch;
let ctgDepot: Warehouse;

const WORKSPACE = 'meghna-distributors';

// Each person's sign-in details. A test signs in again for a second browser, or a new session.
const people = {
  owner: { email: 'shafiq@meghnadistributors.com', password: 'Narsingdi-depot-2026' },
  rafiq: { email: 'rafiq@meghnadistributors.com', password: 'Bhairab-route-2026' },
  nasrin: { email: 'nasrin@meghnadistributors.com', password: 'Agrabad-depot-2026' },
  tanvir: { email: 'tanvir@meghnadistributors.com', password: 'Sylhet-route-2026' },
};

function signIn(person: keyof typeof people): Promise<SignedIn> {
  return logIn(app, { workspace: WORKSPACE, ...people[person], keepSignedIn: false });
}

function v7(): string {
  const id = randomUUID();
  return `${id.slice(0, 14)}7${id.slice(15)}`;
}

function send(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
  as = owner,
) {
  return app.inject({
    method,
    url,
    headers: bearer(as.accessToken),
    ...(payload && { payload }),
  });
}

function problemOf(res: Awaited<ReturnType<typeof send>>) {
  return problemSchema.parse(res.json());
}

async function created<T>(schema: z.ZodType<T>, url: string, payload: object): Promise<T> {
  const res = await send('POST', url, payload);
  expect(res.statusCode, res.body).toBe(201);
  return schema.parse(res.json());
}

async function newDevice(name: string, branch: Branch, as = owner): Promise<Device> {
  const res = await send('POST', '/sync/devices', { id: v7(), name, branchId: branch.id }, as);
  expect(res.statusCode, res.body).toBe(201);
  return deviceSchema.parse(res.json());
}

async function mine(as = owner): Promise<DeviceListItem[]> {
  const res = await send('GET', '/me/devices', undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return myDeviceListSchema.parse(res.json()).items;
}

// Every page of the workspace's list, as the Settings page loads them: until nextCursor is null
async function allPages(query: Record<string, string>, as = owner): Promise<DeviceListItem[]> {
  const items: DeviceListItem[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const params = new URLSearchParams(query);
    if (cursor !== null) params.set('cursor', cursor);
    const res = await send('GET', `/devices?${params.toString()}`, undefined, as);
    expect(res.statusCode, res.body).toBe(200);
    const body = devicePageSchema.parse(res.json());
    items.push(...body.items);
    cursor = body.nextCursor;
    if (cursor === null) return items;
  }
  throw new Error('The list did not end in 100 pages');
}

function rename(device: { id: string; version: number }, name: string, as = owner) {
  return send('PATCH', `/devices/${device.id}`, { name, version: device.version }, as);
}

function move(device: { id: string; version: number }, branch: Branch, as = owner) {
  return send(
    'PUT',
    `/devices/${device.id}/branch`,
    { branchId: branch.id, version: device.version },
    as,
  );
}

function revoke(device: { id: string }, as = owner) {
  return send('POST', `/devices/${device.id}/revoke`, undefined, as);
}

function itemOf(res: Awaited<ReturnType<typeof send>>): DeviceListItem {
  expect(res.statusCode, res.body).toBe(200);
  return deviceListItemSchema.parse(res.json());
}

function pull(device: { id: string }, as = owner, cursor?: string) {
  const query = new URLSearchParams({ deviceId: device.id, protocol: '1', limit: '1000' });
  if (cursor !== undefined) query.set('cursor', cursor);
  return send('GET', `/sync/pull?${query.toString()}`, undefined, as);
}

// One page is the whole pull here: a new workspace has a few hundred rows at most
async function pulled(device: { id: string }, as = owner, cursor?: string) {
  const res = await pull(device, as, cursor);
  expect(res.statusCode, res.body).toBe(200);
  const body = syncPullSchema.parse(res.json());
  expect(body.hasMore).toBe(false);
  return body;
}

// A push of one new customer. Its answer does not matter here: only that the device may push.
function push(device: { id: string }, as = owner) {
  return send(
    'POST',
    '/sync/push',
    {
      deviceId: device.id,
      protocol: 1,
      commands: [
        {
          id: v7(),
          type: 'customer.create',
          customerId: v7(),
          input: {
            code: '',
            name: 'Sylhet Pharmacy',
            groupId: '',
            contactPerson: '',
            phone: '',
            email: '',
            documentLanguage: 'en',
            bin: '',
            paymentTermsDays: 30,
            creditLimit: '',
            priceListId: '',
            notes: '',
            addresses: [],
          },
        },
      ],
    },
    as,
  );
}

function refresh(who: SignedIn) {
  return app.inject({
    method: 'POST',
    url: '/auth/refresh',
    cookies: { omnivo_rt: who.refreshToken },
  });
}

// The session an access token belongs to: its `sid` claim (18c.3). The token is a JWT, so the
// claims are the base64url JSON between the two dots.
const claimsSchema = z.object({ sid: z.uuid() });
function sidOf(who: SignedIn): string {
  const [, payload = ''] = who.accessToken.split('.');
  return claimsSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))).sid;
}

async function sessionExists(id: string): Promise<boolean> {
  const rows = z
    .array(z.object({ n: z.number() }))
    .parse(await sql`SELECT count(*)::int AS n FROM sessions WHERE id = ${id}`);
  return rows[0]?.n === 1;
}

const deviceRowSchema = z.object({
  session_id: z.uuid().nullable(),
  version: z.number(),
  revoked_at: z.date().nullable(),
  last_sync_at: z.date().nullable(),
});
async function deviceRow(id: string) {
  const [row] = z
    .array(deviceRowSchema)
    .parse(
      await sql`SELECT session_id, version, revoked_at, last_sync_at FROM devices WHERE id = ${id}`,
    );
  if (!row) throw new Error(`no device ${id}`);
  return row;
}

async function auditOf(device: { id: string }) {
  const res = await send('GET', `/audit-logs?entityType=device&entityId=${device.id}&limit=100`);
  expect(res.statusCode, res.body).toBe(200);
  return auditPageSchema.parse(res.json()).items;
}

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
    }),
  );
  sql = postgres(pg.superuserUrl, { max: 2 });
  owner = await signUp(app, {
    companyName: 'Meghna Distributors',
    workspaceSlug: WORKSPACE,
    fullName: 'Shafiq Ahmed',
    ...people.owner,
  });
  // The distribution template makes the Depot manager role
  expect((await send('POST', '/setup', { industry: 'distribution' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });

  // Each of the three has a workspace of their own first (sign-up needs one), then joins this one
  const others = [
    ['rafiq', 'Rafiq Islam', 'rafiq-traders'],
    ['nasrin', 'Nasrin Akter', 'nasrin-traders'],
    ['tanvir', 'Tanvir Hasan', 'tanvir-traders'],
  ] as const;
  for (const [person, fullName, slug] of others) {
    await signUp(app, { companyName: fullName, workspaceSlug: slug, fullName, ...people[person] });
    await joinWithoutRoles(pg.superuserUrl, { email: people[person].email, workspace: WORKSPACE });
  }

  // Nasrin gets the template's role as it is: no permission added by the test
  const { items: roles } = roleListSchema.parse((await send('GET', '/roles')).json());
  const depotManager = roles.find((role) => role.name === 'Depot manager');
  if (!depotManager) throw new Error('no Depot manager role');
  expect(depotManager.permissions).toContain('core.device.manage');
  const { items: members } = memberPageSchema.parse((await send('GET', '/members')).json());
  const her = members.find((member) => member.email === people.nasrin.email);
  if (!her) throw new Error('Nasrin is not a member');
  const assigned = await send('PUT', `/members/${her.membershipId}/roles`, {
    roleIds: [depotManager.id],
    version: her.version,
  });
  expect(assigned.statusCode, assigned.body).toBe(200);

  [rafiq, nasrin, tanvir] = await Promise.all([
    signIn('rafiq'),
    signIn('nasrin'),
    signIn('tanvir'),
  ]);

  const [head] = z
    .object({ items: z.array(branchSchema) })
    .parse((await send('GET', '/branches')).json()).items;
  if (!head) throw new Error('no branch');
  headOffice = head;
  chattogram = await created(branchSchema, '/branches', {
    code: 'CTG',
    name: 'Chattogram depot',
    phone: '',
    address: 'Agrabad, Chattogram',
  });
  ctgDepot = await created(warehouseSchema, '/warehouses', {
    branchId: chattogram.id,
    code: 'CTG1',
    name: 'Chattogram depot',
    address: '',
  });
}, 180_000);

afterAll(async () => {
  await sql.end();
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});
```

- **The workspace is set up as a distributor** (`POST /setup`, then wait for `ready`), so the Depot manager role
  comes from the real template. Nasrin gets that role as it is, and the setup checks that it has
  `core.device.manage`: if 18c.3's template change is lost, the setup fails with a clear message instead of a 403
  somewhere later. The worker runs because the setup is a job in it.
- **`people` keeps each person's sign-in details,** so `signIn()` can make a second browser of the same person. A
  revoke ends one sign-in (decision 18); a test that revokes a device registers it on a sign-in of its own, so the
  sign-ins of `owner`, `rafiq` and `nasrin` the other tests use stay alive. Their access tokens would still work for
  15 minutes after a revoke, but a test should not depend on that.
- **`allPages()` walks every page until `nextCursor` is `null`,** like the Settings page does. The tests call it with
  `limit: '1'`, so every row starts a new page and every border between two rows goes through a cursor. A cursor bug
  then shows as a missing or repeated device.
- **`push()` sends one new customer.** Its answer does not matter for these tests (a person without the customer
  permission gets a refusal inside a 200); what matters is whether the device may push at all.
- **`sidOf()` reads the `sid` claim out of the access token** (18c.3). The token is a JWT: three base64url parts, the
  middle one is the claims as JSON. `claimsSchema` parses it, so a token without `sid` fails loudly.
- **`sessionExists()` and `deviceRow()` read as the superuser.** No route shows a device's session, and the tests must
  see that a revoke deleted it, or that a new sign-in moved it.
- **`auditOf()` reads one device's history** with the audit list's `entityId` filter, the way the audit page does.

### The lists

```ts
describe('the lists', () => {
  it('lists your own devices: the active ones first, then by name', async () => {
    const counter = await newDevice('Counter 2', headOffice);
    const laptop = await newDevice('Accounts laptop', headOffice);
    // An old computer, on a sign-in of its own: revoking it ends that sign-in, not the owner's
    const oldBrowser = await signIn('owner');
    const old = await newDevice('Back office PC', headOffice, oldBrowser);
    expect(itemOf(await revoke(old)).revokedAt).not.toBeNull();
    const his = await newDevice('Rafiq on Android', headOffice, rafiq);

    const items = await mine();
    expect(items.map((device) => device.name)).toEqual([
      'Accounts laptop',
      'Counter 2',
      'Back office PC',
    ]);
    expect(items[1]).toEqual({
      ...counter,
      userName: 'Shafiq Ahmed',
      branchName: 'Head office',
      revokedByName: null,
    });
    expect(items[2]).toMatchObject({ id: old.id, revokedByName: 'Shafiq Ahmed' });
    expect(items.map((device) => device.id)).toContain(laptop.id);
    // Rafiq sees his own only, without any permission
    expect((await mine(rafiq)).map((device) => device.id)).toEqual([his.id]);
  });

  it("needs core.device.manage for the workspace's list", async () => {
    const refused = await send('GET', '/devices', undefined, rafiq);
    expect(refused.statusCode).toBe(403);
    expect(problemOf(refused).code).toBe('permission_missing');
    // Nasrin has it from the Depot manager template, and sees everyone's devices
    const names = (await allPages({}, nasrin)).map((device) => device.name);
    expect(names).toEqual(expect.arrayContaining(['Counter 2', 'Rafiq on Android']));
  });

  it('pages by name both ways, two devices with the same name by their id', async () => {
    const phone = await newDevice('Route phone', headOffice);
    const tablets = [
      await newDevice('Route tablet', headOffice),
      await newDevice('Route tablet', headOffice, rafiq),
    ];
    const expected = [phone.id, ...tablets.map((tablet) => tablet.id).sort()];

    // limit 1: every row is the first of a page, so every boundary goes through a cursor
    const byName = await allPages({ search: 'route', sort: 'name', limit: '1' });
    expect(byName.map((device) => device.id)).toEqual(expected);
    const backwards = await allPages({ search: 'route', sort: '-name', limit: '1' });
    expect(backwards.map((device) => device.id)).toEqual([...expected].reverse());
  });

  it('puts the devices that never synced first, and keeps microseconds apart', async () => {
    const vans = [];
    for (const n of [1, 2, 3, 4, 5])
      vans.push(await newDevice(`Van tablet ${String(n)}`, headOffice));
    const [never, later, first, sameA, sameB] = vans;
    if (!never || !later || !first || !sameA || !sameB) throw new Error('five vans');
    // Two syncs in the same millisecond, 100 µs apart: a cursor that kept a JavaScript date would
    // see them as one time. Two more at the very same time: their ids break the tie.
    await sql`UPDATE devices SET last_sync_at = '2026-10-20 09:00:00.000200+06' WHERE id = ${later.id}`;
    await sql`UPDATE devices SET last_sync_at = '2026-10-20 09:00:00.000100+06' WHERE id = ${first.id}`;
    await sql`UPDATE devices SET last_sync_at = '2026-10-21 09:00:00+06'
               WHERE id IN (${sameA.id}, ${sameB.id})`;
    const tie = [sameA.id, sameB.id].sort();
    const expected = [never.id, first.id, later.id, ...tie];

    const oldest = await allPages({ search: 'van tablet', sort: 'lastSync', limit: '1' });
    expect(oldest.map((device) => device.id)).toEqual(expected);
    const newest = await allPages({ search: 'van tablet', sort: '-lastSync', limit: '1' });
    expect(newest.map((device) => device.id)).toEqual([...expected].reverse());
    expect(newest[0]?.lastSyncAt).toBe('2026-10-21T03:00:00.000Z');
  });

  it('refuses a cursor made for another sort, or edited by hand', async () => {
    const byName = devicePageSchema.parse((await send('GET', '/devices?limit=1&sort=name')).json());
    expect(byName.nextCursor).not.toBeNull();
    const other = await send(
      'GET',
      `/devices?limit=1&sort=lastSync&cursor=${byName.nextCursor ?? ''}`,
    );
    expect(other.statusCode).toBe(400);
    expect(problemOf(other).code).toBe('invalid_cursor');

    // A sync key that is not a whole number would fail in Postgres (::bigint) with a 500
    const edited = Buffer.from(JSON.stringify(['lastSync', 'yesterday', v7()])).toString(
      'base64url',
    );
    const res = await send('GET', `/devices?sort=lastSync&cursor=${edited}`);
    expect(res.statusCode).toBe(400);
    expect(problemOf(res).code).toBe('invalid_cursor');
  });

  it('finds a device by its name or its person, in a branch, in a tab', async () => {
    const counter = await newDevice('Agrabad counter', chattogram, rafiq);

    // The person's name, in any case
    const his = await allPages({ search: 'RAFIQ ISLAM' });
    expect(his.length).toBeGreaterThan(0);
    expect(his.every((device) => device.userName === 'Rafiq Islam')).toBe(true);
    // The device's name
    expect((await allPages({ search: 'agrabad' })).map((device) => device.id)).toEqual([
      counter.id,
    ]);
    // A % typed in the box means itself, not "anything"
    expect(await allPages({ search: '%' })).toEqual([]);

    const inCtg = await allPages({ branchId: chattogram.id });
    expect(inCtg.map((device) => device.id)).toEqual([counter.id]);
    expect(inCtg[0]?.branchName).toBe('Chattogram depot');

    // Active is the default tab; Revoked has only the revoked ones
    const active = await allPages({});
    expect(active.every((device) => device.revokedAt === null)).toBe(true);
    const revoked = await allPages({ status: 'revoked' });
    expect(revoked.map((device) => device.name)).toEqual(['Back office PC']);
  });
});
```

- **"Active first, then by name":** the names are picked so that the revoked "Back office PC" would sit between the
  two active ones by name alone. Only `revoked_at IS NOT NULL` in the `ORDER BY` puts it last.
- **The whole item is compared once** (`toEqual` with `userName`, `branchName` and `revokedByName: null`), so a list
  item with a field too many or a wrong name fails here.
- **Rafiq sees only his own devices, with no role at all:** the own list needs no permission (decision 5).
- **The workspace list without the permission is a 403 `permission_missing`,** from the route's guard. Nasrin passes
  only because of the template's role.
- **Two devices called "Route tablet",** of two people: the same name, so only the id can order them. The test sorts
  the expected ids as plain strings: Postgres compares uuids byte by byte, the same order as their lowercase hex
  text.
- **Five "Van tablet" devices for the sync sort.** One never synced, two synced in the same millisecond 100 µs apart,
  two synced at the very same time. The superuser writes `last_sync_at`: a real pull cannot choose its time. The
  expected order is the one decision 21 promises: never synced first, then by time, then by id; and `-lastSync` is
  exactly the reverse. The last line checks that the API still sends the time as an ISO string (to the
  millisecond), whatever the cursor keeps.
- **Two bad cursors:** one made for the name sort, and one edited by hand with a key that is not a number. Both are
  `invalid_cursor` (400). The second would reach `::bigint` and fail in Postgres with a 500 without the schema's
  regex.
- **The search finds a device by its person's name in capitals, and by its own name.** `%` finds nothing: it means
  itself, not "anything" (`containsPattern()`).
- **The branch filter and the Revoked tab** are checked against the devices the earlier tests made: Chattogram has
  only the new counter, and the only revoked device so far is "Back office PC".

### Renaming

```ts
describe('renaming', () => {
  it('renames your own device, with the version you saw', async () => {
    const device = await newDevice('Chrome on Windows', headOffice);
    const renamed = itemOf(await rename(device, 'Counter 1'));
    expect(renamed).toMatchObject({ name: 'Counter 1', version: device.version + 1 });

    // The form still open on the old version is told
    const stale = await rename(device, 'Counter one');
    expect(stale.statusCode).toBe(409);
    expect(problemOf(stale).code).toBe('version_conflict');

    // The same name again: nothing to write, no new version, no second audit row
    expect(itemOf(await rename(renamed, 'Counter 1')).version).toBe(renamed.version);
    const entries = await auditOf(device);
    const renames = entries.filter((entry) => entry.action === 'device.renamed');
    expect(renames.map((entry) => [entry.actor?.fullName, entry.changes])).toEqual([
      ['Shafiq Ahmed', { name: { from: 'Chrome on Windows', to: 'Counter 1' } }],
    ]);
  });

  it("renames someone else's device only with core.device.manage", async () => {
    const counter = await newDevice('Front counter', headOffice);
    const his = await newDevice('Chrome on Android', headOffice, rafiq);

    // Without the permission it does not exist, like an unknown id
    const refused = await rename(counter, 'Mine now', rafiq);
    expect(refused.statusCode).toBe(404);
    expect(problemOf(refused).code).toBe('device_not_found');
    const unknown = await rename({ id: v7(), version: 1 }, 'Nobody', rafiq);
    expect(problemOf(unknown).code).toBe('device_not_found');

    // Nasrin names it after its person; it stays Rafiq's
    expect(itemOf(await rename(his, 'Rafiq phone', nasrin))).toMatchObject({
      name: 'Rafiq phone',
      userName: 'Rafiq Islam',
    });
  });

  it('refuses to rename a revoked device, before it looks at the version', async () => {
    const browser = await signIn('owner');
    const device = await newDevice('Stolen phone', headOffice, browser);
    itemOf(await revoke(device));
    // device.version is the one before the revoke: still "revoked", not "reload"
    const res = await rename(device, 'Found phone');
    expect(res.statusCode).toBe(403);
    expect(problemOf(res).code).toBe('device_revoked');
  });
});
```

- **The version:** a rename with the version from before the first rename is a `version_conflict`, like every edit
  form in the app.
- **The same name again** gives the same version and no second audit row. The audit check maps each row to its actor
  and its changes, so the test also proves the diff has only the name.
- **Someone else's device without the permission is `device_not_found`,** the same answer as an id that does not
  exist (decision 5). Nasrin, with the permission, renames Rafiq's device, and it stays his (`userName`).
- **A revoked device is `device_revoked` even with an old version.** The device's version is the one from before the
  revoke, so this also checks the order of the checks in `rename()`: revoked before the version.

### Moving

```ts
describe('moving', () => {
  it('moves your own device, and its next pull copies the new branch', async () => {
    const browser = await signIn('rafiq');
    const device = await newDevice('Rafiq laptop', headOffice, browser);
    const { cursor } = await pulled(device, browser);

    const moved = itemOf(await move(device, chattogram, browser));
    expect(moved).toMatchObject({
      branchId: chattogram.id,
      branchName: 'Chattogram depot',
      version: device.version + 1,
    });
    const entries = await auditOf(device);
    expect(entries.find((entry) => entry.action === 'device.moved')).toMatchObject({
      actor: { fullName: 'Rafiq Islam' },
      changes: { branch: { from: 'HO', to: 'CTG' } },
    });

    // The cursor of the head office starts a full pull of Chattogram: its depot only
    const after = await pulled(device, browser, cursor);
    expect(after.full).toBe(true);
    const stores = after.changes.filter((change) => change.entity === 'warehouse');
    expect(stores.map((change) => change.key)).toEqual([ctgDepot.id]);
  });

  it('answers a move to the same branch with the device unchanged', async () => {
    const device = await newDevice('Shelf scanner', chattogram);
    const same = itemOf(await move(device, chattogram));
    expect(same.version).toBe(device.version);
    expect((await auditOf(device)).map((entry) => entry.action)).toEqual(['device.registered']);
  });

  it("never moves someone else's device, nor into a branch that is not active", async () => {
    const his = await newDevice('Rafiq tablet', headOffice, rafiq);
    // Even with core.device.manage: only the device knows that nothing waits in its outbox
    const refused = await move(his, chattogram, nasrin);
    expect(refused.statusCode).toBe(404);
    expect(problemOf(refused).code).toBe('device_not_found');

    let bogura = await created(branchSchema, '/branches', {
      code: 'BOG',
      name: 'Bogura depot',
      phone: '',
      address: '',
    });
    const archived = await send('POST', `/branches/${bogura.id}/archive`, {
      version: bogura.version,
    });
    bogura = branchSchema.parse(archived.json());
    const res = await move(his, bogura, rafiq);
    expect(res.statusCode).toBe(409);
    expect(problemOf(res)).toMatchObject({
      code: 'device_branch_invalid',
      fieldErrors: { branchId: ['device_branch_invalid'] },
    });

    // The form's empty select: the same message, from the contract
    const empty = await send(
      'PUT',
      `/devices/${his.id}/branch`,
      { branchId: '', version: his.version },
      rafiq,
    );
    expect(empty.statusCode).toBe(400);
    expect(problemOf(empty).fieldErrors).toEqual({ branchId: ['device_branch_invalid'] });
  });
});
```

- **The move, and then the pull with the old cursor.** This is how the device sees a move: its cursor belongs to the
  head office, so the next pull is a full pull (`full: true`) of Chattogram, and the only warehouse in it is the
  Chattogram depot. 18c.3 changed nothing in the pull for this; the test proves it is enough (decision 10).
- **The audit row says the branch codes** (`HO` → `CTG`), the way the other branch fields of the audit log are written.
- **The same branch:** the same version, and the device's history has only `device.registered`.
- **Nasrin cannot move Rafiq's device, although she can rename and revoke it** (decision 2): only the device knows
  that its outbox is empty.
- **An archived branch is refused with `device_branch_invalid` on `branchId`,** so the dialog shows it under the
  select. An empty select (`''`) is refused by the contract with the same code: the person sees one message for "no
  branch" and "a branch that is gone".

### Revoking

```ts
describe('revoking', () => {
  it('stops your own device and ends its sign-in, and only that one', async () => {
    // Rafiq on two browsers: the phone he lost, and the laptop he revokes it from
    const phoneBrowser = await signIn('rafiq');
    const laptopBrowser = await signIn('rafiq');
    const phone = await newDevice('Rafiq on iPhone', headOffice, phoneBrowser);
    const laptop = await newDevice('Rafiq on Chrome', headOffice, laptopBrowser);
    expect((await deviceRow(phone.id)).session_id).toBe(sidOf(phoneBrowser));

    const revoked = itemOf(await revoke(phone, laptopBrowser));
    expect(revoked).toMatchObject({
      id: phone.id,
      version: phone.version + 1,
      revokedByName: 'Rafiq Islam',
    });
    expect(revoked.revokedAt).not.toBeNull();

    // The phone's sign-in is gone: no new access token for it
    expect(await sessionExists(sidOf(phoneBrowser))).toBe(false);
    expect((await refresh(phoneBrowser)).statusCode).toBe(401);
    // Its sync stops at once
    expect(problemOf(await pull(phone, phoneBrowser)).code).toBe('device_revoked');
    const pushed = await push(phone, phoneBrowser);
    expect(pushed.statusCode).toBe(403);
    expect(problemOf(pushed).code).toBe('device_revoked');
    // Its last access token still reads online pages for its last minutes (decision 18)
    expect((await send('GET', '/me/devices', undefined, phoneBrowser)).statusCode).toBe(200);

    // The laptop is untouched: its sign-in refreshes, its device syncs
    expect(await sessionExists(sidOf(laptopBrowser))).toBe(true);
    expect((await refresh(laptopBrowser)).statusCode).toBe(200);
    expect((await pull(laptop, laptopBrowser)).statusCode).toBe(200);

    const entries = await auditOf(phone);
    const revokes = entries.filter((entry) => entry.action === 'device.revoked');
    expect(revokes.map((entry) => entry.actor?.fullName)).toEqual(['Rafiq Islam']);
  });

  it("revokes someone else's device only with core.device.manage", async () => {
    const browser = await signIn('rafiq');
    const his = await newDevice('Rafiq van tablet', headOffice, browser);
    const counter = await newDevice('Back counter', headOffice);

    const refused = await revoke(counter, rafiq);
    expect(refused.statusCode).toBe(404);
    expect(problemOf(refused).code).toBe('device_not_found');
    expect((await deviceRow(counter.id)).revoked_at).toBeNull();

    expect(itemOf(await revoke(his, nasrin))).toMatchObject({
      userName: 'Rafiq Islam',
      revokedByName: 'Nasrin Akter',
    });
    expect((await refresh(browser)).statusCode).toBe(401);
  });

  it('answers a revoked device as it is, with one audit row', async () => {
    const browser = await signIn('owner');
    const device = await newDevice('Old tablet', headOffice, browser);
    const first = itemOf(await revoke(device));
    // A double click, or someone else at the same moment: the same answer, nothing changed
    expect(itemOf(await revoke(device))).toEqual(first);
    expect(itemOf(await revoke(device, nasrin))).toEqual(first);
    const entries = await auditOf(device);
    expect(entries.filter((entry) => entry.action === 'device.revoked')).toHaveLength(1);
  });

  it('makes a new device when the browser signs in again', async () => {
    const before = await signIn('rafiq');
    const old = await newDevice('Rafiq on Firefox', headOffice, before);
    itemOf(await revoke(old, before));
    const row = await deviceRow(old.id);

    // The browser still holds the old id: registering it answers it revoked, and changes nothing
    const again = await signIn('rafiq');
    const res = await send(
      'POST',
      '/sync/devices',
      { id: old.id, name: 'Rafiq on Firefox', branchId: headOffice.id },
      again,
    );
    expect(res.statusCode, res.body).toBe(201);
    expect(deviceSchema.parse(res.json()).revokedAt).not.toBeNull();
    expect(await deviceRow(old.id)).toEqual(row);

    // So the app makes a new id (decision 4), and the new device syncs
    const fresh = await newDevice('Rafiq on Firefox', headOffice, again);
    expect((await pull(fresh, again)).statusCode).toBe(200);
    const names = (await mine(again)).filter((device) => device.name === 'Rafiq on Firefox');
    expect(names.map((device) => device.revokedAt === null)).toEqual([true, false]);
  });

  it('lets a pull that waited on a revoke finish, and keeps the old sign-in', async () => {
    const first = await signIn('owner');
    const device = await newDevice('Delivery van tablet', headOffice, first);
    // A new sign-in pulls: without the CASE in the pull's last UPDATE, it would write its own
    // session onto a row that is revoked by then, and migration 0048 would answer a 500
    const second = await signIn('owner');

    let pending: ReturnType<typeof pull> | undefined;
    await sql.begin(async (tx) => {
      await tx`UPDATE devices SET revoked_at = now(), revoked_by = user_id WHERE id = ${device.id}`;
      // The pull checks the device before the revoke commits, reads the data, and then waits on
      // this row for its last UPDATE
      pending = pull(device, second);
      await eventually(async () => {
        const waiting = z.array(z.object({ n: z.number() })).parse(
          await sql`SELECT count(*)::int AS n FROM pg_stat_activity
                       WHERE wait_event_type = 'Lock' AND query LIKE 'UPDATE devices SET last_sync_at%'`,
        );
        expect(waiting[0]?.n).toBe(1);
      });
    });
    const res = await pending;
    expect(res?.statusCode, res?.body).toBe(200);

    const row = await deviceRow(device.id);
    expect(row.revoked_at).not.toBeNull();
    expect(row.session_id).toBe(sidOf(first));
    expect(row.last_sync_at).not.toBeNull();
  });
});
```

- **Rafiq on two browsers.** He revokes the lost phone from his laptop. The test then checks everything decision 18
  promises: the phone's session row is gone and its refresh is a 401; its pull and its push are `device_revoked`; its
  last access token still reads an online page. And nothing more: the laptop's session is there, it refreshes, and its
  device pulls.
- **`revokedByName` is the person who clicked,** Rafiq for his own phone and Nasrin for the device she revokes. A
  refused revoke (Rafiq on the owner's device) leaves `revoked_at` empty in the database, not only in the answer.
- **A revoke repeated, also by someone else, answers the same JSON** (decision 9), and the history has one
  `device.revoked` row.
- **The old id after a new sign-in:** registering it answers it revoked, and the whole row stays the same (the
  session too: `keepSession()` never touches a revoked device). The new id with the same name is a second, active
  device; the person's own list shows both (decision 4).
- **The race of a pull and a revoke.** The superuser revokes the device in a transaction and keeps it open. The pull,
  made by a newer sign-in, checks the device (still active for it: the revoke has not committed), reads its data,
  and then waits on the device row for its last `UPDATE`. The test waits until Postgres shows that statement waiting
  on a lock (`pg_stat_activity`), and only then commits. Waiting for the lock, not for a fixed time, makes the race
  happen every time, on a slow machine too. The pull then answers 200; the device keeps its old session (the `CASE`),
  and `last_sync_at` is written (0048 allows it).

### The sign-in a device follows

```ts
describe('the sign-in a device follows', () => {
  it('moves the device to each new sign-in, without a new version', async () => {
    const first = await signIn('nasrin');
    const device = await newDevice('Depot desk', chattogram, first);
    expect((await deviceRow(device.id)).session_id).toBe(sidOf(first));

    // Signed out and in again on the same browser: registering the same id follows it
    const second = await signIn('nasrin');
    const res = await send(
      'POST',
      '/sync/devices',
      { id: device.id, name: 'Depot desk', branchId: chattogram.id },
      second,
    );
    expect(res.statusCode, res.body).toBe(201);
    expect(await deviceRow(device.id)).toMatchObject({
      session_id: sidOf(second),
      version: device.version,
    });

    // A pull follows it too, when it ends (and writes the time of the sync)
    const third = await signIn('nasrin');
    await pulled(device, third);
    expect(await deviceRow(device.id)).toMatchObject({
      session_id: sidOf(third),
      version: device.version,
    });

    // And a push, in its first transaction
    const fourth = await signIn('nasrin');
    const pushed = await push(device, fourth);
    expect(pushed.statusCode, pushed.body).toBe(200);
    syncPushSchema.parse(pushed.json());
    expect(await deviceRow(device.id)).toMatchObject({
      session_id: sidOf(fourth),
      version: device.version,
    });

    // So a revoke now ends the sign-in the device uses now, and leaves the old ones
    itemOf(await revoke(device, fourth));
    expect(await sessionExists(sidOf(fourth))).toBe(false);
    expect(await sessionExists(sidOf(third))).toBe(true);
  });
});
```

- **Four sign-ins of Nasrin, one after the other,** each followed by one kind of request: registering the same id, a
  pull, and a push. After each, the device's `session_id` is the newest sign-in, and its version has not changed
  (decision 17), so none of them would make a rename fail.
- **The end of the test is why this matters:** a revoke now ends the sign-in the device uses now, and an older one of
  the same person stays.

### Removing a member

```ts
describe('removing a member', () => {
  it('revokes all their active devices, in the name of the person who removed them', async () => {
    const phoneBrowser = await signIn('tanvir');
    const phone = await newDevice('Tanvir phone', headOffice, phoneBrowser);
    // The phone he revoked himself last week keeps its revoker
    const ownRevoke = itemOf(await revoke(phone, phoneBrowser));
    const laptop = await newDevice('Tanvir laptop', headOffice, tanvir);
    const tablet = await newDevice('Tanvir tablet', chattogram, tanvir);

    const { items: members } = memberPageSchema.parse((await send('GET', '/members')).json());
    const him = members.find((member) => member.email === people.tanvir.email);
    if (!him) throw new Error('Tanvir is not a member');
    const removed = await send(
      'DELETE',
      `/members/${him.membershipId}?version=${String(him.version)}`,
    );
    expect(removed.statusCode, removed.body).toBe(204);

    // His name stays on his devices after he left (decision 7)
    const his = await allPages({ search: 'tanvir', status: 'revoked' });
    expect(his.map((device) => [device.name, device.userName, device.revokedByName])).toEqual([
      ['Tanvir laptop', 'Tanvir Hasan', 'Shafiq Ahmed'],
      ['Tanvir phone', 'Tanvir Hasan', 'Tanvir Hasan'],
      ['Tanvir tablet', 'Tanvir Hasan', 'Shafiq Ahmed'],
    ]);
    expect(his.find((device) => device.id === phone.id)).toEqual(ownRevoke);
    expect(await allPages({ search: 'tanvir' })).toEqual([]);

    for (const device of [laptop, tablet]) {
      const entries = await auditOf(device);
      expect(entries.find((entry) => entry.action === 'device.revoked')).toMatchObject({
        actor: { fullName: 'Shafiq Ahmed' },
      });
    }
    expect(await sessionExists(sidOf(tanvir))).toBe(false);
  });
});
```

- **Tanvir has three devices:** a phone he revoked himself, and a laptop and a tablet that are active. The owner
  removes him. The two active ones are revoked by the owner (decision 19); the phone stays exactly as it was, with
  Tanvir as its revoker (`toEqual` on the whole item).
- **His name stays on his devices** after he left (decision 7), and the Active tab has none of them.
- **Each revoked device has its own `device.revoked` row,** by the owner, and his sign-in is gone.

### Archiving a branch

```ts
describe('archiving a branch', () => {
  it('waits until no active device is in it, and says how many there are', async () => {
    const sylhet = await created(branchSchema, '/branches', {
      code: 'SYL',
      name: 'Sylhet depot',
      phone: '',
      address: '',
    });
    const store = await created(warehouseSchema, '/warehouses', {
      branchId: sylhet.id,
      code: 'SYL1',
      name: 'Sylhet depot',
      address: '',
    });
    const browser = await signIn('owner');
    const counter = await newDevice('Sylhet counter', sylhet, browser);
    const his = await newDevice('Rafiq in Sylhet', sylhet, rafiq);

    const archive = () =>
      send('POST', `/branches/${sylhet.id}/archive`, { version: sylhet.version });
    // The devices come before the warehouses (decision 20)
    const two = await archive();
    expect(two.statusCode).toBe(409);
    expect(problemOf(two)).toMatchObject({ code: 'branch_has_devices', params: { count: 2 } });

    // A revoked device does not count; a moved one has left
    itemOf(await revoke(counter));
    expect(problemOf(await archive()).params).toEqual({ count: 1 });
    itemOf(await move(his, headOffice, rafiq));
    expect(problemOf(await archive()).code).toBe('branch_has_warehouses');

    const closed = await send('POST', `/warehouses/${store.id}/archive`, {
      version: store.version,
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect((await archive()).statusCode).toBe(200);
  });
});
```

- **A branch with two devices and a warehouse.** The first archive is `branch_has_devices` with `count: 2`, not
  `branch_has_warehouses`: the devices are checked first (decision 20).
- **A revoked device does not count, and a moved one has left:** the count goes to 1, and then the archive meets the
  warehouse. After the warehouse is archived, the branch is.

### `sync/sync.tenant-leak.int.spec.ts`: the devices of another workspace

```diff
@@ -7,7 +7,9 @@ import {
   customerBalancesSchema,
   customerSchema,
   type Device,
+  devicePageSchema,
   deviceSchema,
+  myDeviceListSchema,
   type Product,
   productSchema,
   problemSchema,
@@ -64,7 +66,12 @@ function v7(): string {
   return `${id.slice(0, 14)}7${id.slice(15)}`;
 }
 
-function as(who: SignedIn, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
+function as(
+  who: SignedIn,
+  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
+  url: string,
+  payload?: object,
+) {
   return app.inject({
     method,
     url,
@@ -409,6 +416,45 @@ describe('pushing over HTTP', () => {
   });
 });
 
+describe('managing devices over HTTP', () => {
+  it("never lists tenant B's devices", async () => {
+    const all = devicePageSchema.parse((await as(a.who, 'GET', '/devices?limit=100')).json());
+    expect(all.items.map((device) => device.id)).toContain(a.device.id);
+    expect(all.items.map((device) => device.id)).not.toContain(b.device.id);
+    // B's person, by name: nothing, not even an empty row
+    const search = devicePageSchema.parse((await as(a.who, 'GET', '/devices?search=karim')).json());
+    expect(search.items).toEqual([]);
+    const own = myDeviceListSchema.parse((await as(a.who, 'GET', '/me/devices')).json());
+    expect(own.items.map((device) => device.id)).not.toContain(b.device.id);
+  });
+
+  it("cannot rename, move or revoke tenant B's device", async () => {
+    const [branch] = branchListSchema.parse((await as(a.who, 'GET', '/branches')).json()).items;
+    if (!branch) throw new Error('no branch');
+    const path = `/devices/${b.device.id}`;
+    const tries = [
+      await as(a.who, 'PATCH', path, { name: 'Taken', version: b.device.version }),
+      await as(a.who, 'PUT', `${path}/branch`, { branchId: branch.id, version: b.device.version }),
+      await as(a.who, 'POST', `${path}/revoke`),
+    ];
+    // The owner of A has every permission, core.device.manage too: B's id is still unknown here
+    for (const res of tries) {
+      expect(res.statusCode).toBe(404);
+      expect(problemSchema.parse(res.json()).code).toBe('device_not_found');
+    }
+
+    // B's device is as it was, and still syncs
+    const [theirs] = myDeviceListSchema.parse((await as(b.who, 'GET', '/me/devices')).json()).items;
+    expect(theirs).toMatchObject({
+      id: b.device.id,
+      name: 'Chrome on Windows',
+      version: b.device.version,
+      revokedAt: null,
+    });
+    expect((await pull(b.who, b.device.id)).statusCode).toBe(200);
+  });
+});
+
 // Postgres error code of a statement run as the given role, or null when it worked
 async function errorCodeAs(url: string, run: (sql: postgres.Sql) => Promise<unknown>) {
   const sql = postgres(url, { max: 1 });
```

- **`as()` takes `PATCH` too,** for the rename.
- **The list and the own list never show B's device,** and a search for B's owner by name finds nothing.
- **The owner of A has every permission, `core.device.manage` too,** and still gets `device_not_found` for B's id on
  rename, move and revoke: row-level security hides B's device from every query, so to the service it does not exist.
- **B's device is checked afterwards** through B's own list (same name, same version, not revoked) and a pull: a
  refused request must not have changed anything on the way.

### Check this part

```bash
pnpm --filter @omnivo/api typecheck
pnpm exec eslint apps/api/src/sync
pnpm --filter @omnivo/api test:integration -- devices
pnpm --filter @omnivo/api test:tenant-leak -- sync
```

All pass: the devices file has 20 tests, the sync tenant-leak file 15. The whole API integration and tenant-leak
suites pass too: 56 files, 664 tests. On a busy machine a few mail and setup tests
of other steps can time out waiting for the worker; run those files again on their own before you look for a bug. The whole `pnpm typecheck` still fails until 18c.5, on the new keys `en.ts` does not
have yet.

## 18c.5 — `packages/i18n`: the words

The screens of 18c.6 need their words in English and Bangla, and the app cannot type-check without them, so they come
first. This part changes only the two locale files. The ui package needs nothing new: the two lists are data tables
(cards on a phone), the three actions are dialogs, and the limits use the document notice and the pills that exist.

When this part starts, `packages/i18n` has one error: the `errors` object is missing `branch_has_devices` (18c.1).
The app has two hidden ones: the role matrix and the audit log look up the words of every permission and every audit
action, so 18c.1's `core.device.manage` and its three audit actions need words too. When this part ends, the i18n
package, the ui package and the app all type-check, with no error left.

### `locales/en.ts`

```diff
@@ -31,6 +31,8 @@ export const en = {
     notifications: 'Notifications',
     notificationsUnread_one: 'Notifications, {{count}} unread',
     notificationsUnread_other: 'Notifications, {{count}} unread',
+    // Step 18c: the account menu's link to your own devices (decision 1)
+    myDevices: 'My devices',
   },
   nav: {
     overview: 'Overview',
@@ -39,6 +41,7 @@ export const en = {
     settings: 'Settings',
     numbering: 'Numbering',
     branches: 'Branches',
+    devices: 'Devices',
     auditLog: 'Audit log',
     team: 'Team',
     roles: 'Roles',
@@ -349,6 +352,86 @@ export const en = {
     useBranch: 'Use this branch',
     later: 'Not now',
     registered: 'This device is set up for {{branch}}',
+    // Step 18c: the two lists (decision 1). My devices = your own, in the account menu; Devices =
+    // every device of the workspace, with core.device.manage
+    mineTitle: 'My devices',
+    mineDescription:
+      'The browsers and phones you use this workspace on. Revoke the ones you no longer use.',
+    mineEmptyTitle: 'No devices yet',
+    mineEmptyBody: 'Choose the branch of this computer or phone to set it up. It then shows here.',
+    title: 'Devices',
+    description: "Every browser and phone that keeps a copy of this workspace's data",
+    readOnly: 'Ask a workspace owner for the core.device.manage permission to see every device.',
+    loadFailed: "Couldn't load the devices. Refresh the page to try again.",
+    // Step 18c.6: both lists are the server's, like the orders list offline
+    needsConnection: 'The device list is on the server. Connect to the internet to see it.',
+    show: 'Show',
+    statuses: {
+      active: 'Active',
+      revoked: 'Revoked',
+    },
+    // The warn pill of an active device after SYNC_WARN_AFTER_HOURS (syncAge), counted in whole
+    // days from the server's time; formatted = the number in the page's language
+    stale_one: 'Not synced for {{formatted}} day',
+    stale_other: 'Not synced for {{formatted}} days',
+    thisDevice: 'This device',
+    searchLabel: 'Search devices',
+    searchPlaceholder: 'Device or person, like Counter 1 or Tanvir',
+    allBranches: 'All branches',
+    columns: {
+      device: 'Device',
+      person: 'Person',
+      branch: 'Branch',
+      lastSync: 'Last synced',
+      status: 'Status',
+      // Step 18c.6: the header of the column with each row's menu, read by screen readers only
+      actions: 'Actions',
+    },
+    neverSynced: 'Never synced',
+    revokedBy: 'Revoked by {{name}} · {{time}}',
+    emptyTitle: 'No devices yet',
+    emptyBody:
+      'A device shows here once someone signs in on it and picks its branch, like the counter computer of the Chattogram depot.',
+    emptyRevokedTitle: 'No revoked devices',
+    emptyRevokedBody:
+      'A lost phone or a replaced counter computer shows here once it is revoked. Its history stays in the audit log.',
+    noMatchTitle: 'No device matches "{{query}}"',
+    noMatchBody: "Search by the device's name, like Counter 1, or by the person's name.",
+    actionsFor: 'Actions for {{name}}',
+    rename: 'Rename',
+    renameTitle: 'Rename {{name}}',
+    name: 'Name',
+    nameHint: "A name people know it by, like Counter 1 or Tanvir's phone.",
+    saveName: 'Save name',
+    renamed: 'Renamed to {{name}}',
+    // Only this device, online, with nothing waiting in its outbox (decision 2)
+    changeBranch: 'Change branch',
+    changeBranchTitle: 'Change the branch of this device',
+    changeBranchBody:
+      'Omnivo deletes the copy of {{branch}} on this device and copies the branch you pick. Orders saved here offline then use its warehouses.',
+    newBranch: 'New branch',
+    changeBranchConfirm: 'Change branch',
+    moved: 'This device is now set up for {{branch}}',
+    changeBranchOffline: 'Connect to the internet to change the branch.',
+    changeBranchSyncFirst_one:
+      'Sync the {{formatted}} change on this device first. Open Sync to send or discard it.',
+    changeBranchSyncFirst_other:
+      'Sync the {{formatted}} changes on this device first. Open Sync to send or discard them.',
+    // A revoke is final, and what never synced on that device is lost (decisions 3 and 4)
+    revoke: 'Revoke',
+    revokeTitle: 'Revoke {{name}}?',
+    revokeBody:
+      'It stops syncing and is signed out at once. The next time it opens Omnivo, its copy of the data is deleted, with any changes on it that have not synced.',
+    revokeHereBody: 'You are signed out here, and the copy of the data on this device is deleted.',
+    revokeHereWaiting_one: '{{formatted}} change on this device has not synced. It is lost.',
+    revokeHereWaiting_other: '{{formatted}} changes on this device have not synced. They are lost.',
+    revokeFinal:
+      'A revoked device cannot be restored. Signing in on it again sets it up as a new device.',
+    revokeConfirm: 'Revoke device',
+    revoked: '{{name}} revoked',
+    // The sign-in page, after this device found out it was revoked
+    revokedSignedOut:
+      'This device was revoked, so its data was deleted and you were signed out. Sign in to set it up again as a new device.',
   },
   sync: {
     notSetUpTitle: 'This device is not set up yet',
@@ -462,6 +545,17 @@ export const en = {
     orderOffline: 'This order is on the server. Connect to the internet to open it.',
     ordersOffline:
       'The orders on the server need a connection. Drafts saved on this device are listed above.',
+    // Step 18c: the time limits (syncAge). After SYNC_WARN_AFTER_HOURS the sidebar line and the
+    // Sync page warn; after SYNC_BLOCK_AFTER_DAYS the device saves no new work offline. Days are
+    // counted on the device's own clock; days = SYNC_BLOCK_AFTER_DAYS in the page's language
+    lastSyncedDays_one: 'Last synced {{formatted}} day ago',
+    lastSyncedDays_other: 'Last synced {{formatted}} days ago',
+    staleNotice:
+      'Prices, stock and credit limits on this device may be out of date. Connect to the internet to sync.',
+    blockedNotice:
+      "This device last synced more than {{days}} days ago, so it can't save new work offline. Changes already waiting are sent once the connection is back.",
+    blockedFormNotice:
+      "This device last synced more than {{days}} days ago, so it can't save new work offline. Connect to the internet to save this.",
   },
   accounts: {
     title: 'Chart of accounts',
@@ -4162,6 +4256,7 @@ export const en = {
         invite: 'Invite people',
         manage: "Change members' roles and remove members",
       },
+      device: { manage: 'See every device of the workspace, rename them and revoke them' },
       role: { manage: 'Create roles and choose their permissions' },
       settings: { manage: 'Edit company settings and numbering' },
       branch: { manage: 'Add, edit and archive branches' },
@@ -4333,7 +4428,12 @@ export const en = {
         restored: 'Restored a branch',
       },
       number_series: { updated: 'Changed a numbering format' },
-      device: { registered: 'Set up a device' },
+      device: {
+        registered: 'Set up a device',
+        renamed: 'Renamed a device',
+        moved: 'Moved a device to another branch',
+        revoked: 'Revoked a device',
+      },
       member: {
         invited: 'Invited someone',
         invitation_resent: 'Resent an invitation',
@@ -4699,6 +4799,7 @@ export const en = {
       supplierCreditNumber: 'Supplier’s credit note',
       priceDifference: 'Purchase price difference',
       services: 'Purchased services',
+      revokedAt: 'Revoked at',
     },
     loadFailed: "Couldn't load the audit log. Refresh the page to try again.",
   },
@@ -5376,6 +5477,9 @@ export const en = {
       "The server can't read this change. Reload the page, and discard the change if it is still refused.",
     sync_customer_gone:
       'This customer was deleted, or is no longer a customer. Discard the change.',
+    // params.count = the active devices in the branch (decision 20)
+    branch_has_devices:
+      'Active devices in this branch: {{count}}. Change their branch on each device, or revoke them, first.',
     invalid_cursor: 'This list has changed. Reload the page and try again.',
     version_conflict:
       'Someone else saved changes while you were editing. Reload to see them, then make your change again.',
```

- **New keys go into `en.ts` first** (CLAUDE.md → Language). `bn.ts` has the type `Messages`, taken from `en`, so a
  key missing in Bangla fails the type check. The `errors` object ends with `satisfies Record<ErrorCode, string>`,
  so `branch_has_devices` must be here, or the package does not compile.
- **`shell.myDevices` and `nav.devices` are the two ways in** (decision 22): the account menu's item and the
  sidebar's item.
- **Everything about the device lists goes into `devices`,** next to 18a's branch dialog, because both are about the
  device itself. `sync` keeps what is about the outbox and the pull, and gets the time limits.
- **Two titles for two pages.** `mineTitle` and `mineDescription` are your own list; `title` and `description` are
  the workspace's. The own list can be empty only when this browser was never set up (the person picked "Not now"
  in 18a's branch dialog), so `mineEmptyBody` says to choose the branch, and the page uses 18a's `sync.setUp` button.
  `readOnly` is what the Devices page says to someone who opens it without `core.device.manage`, like the other
  pages that need a permission.
- **Two statuses, and a third pill.** `statuses` are the two tabs and the two status pills, Active and Revoked
  (decision 8). An active device that has not synced for 24 hours gets the `warn` pill `stale_*` in place of
  Active: the list counts whole days from the server's time with `syncAge()` (decision 12). It starts at 1 day (24
  to 47 hours), so it needs the plural keys, with `formatted` for the number in the page's language like 18a's
  `firstPullCount`.
- **`thisDevice`** is the pill beside the name of the device the person is on. It is the only row where "Change
  branch" shows (decision 2), and the row where "Revoke" signs you out.
- **The search says what it finds** (decision 8): `searchPlaceholder` names the two things it looks in, with an
  example of each. `noMatchTitle` and `noMatchBody` follow the products and accounts lists.
- **`revokedBy`** is the line under a revoked device: who, and when. It answers the first question an owner asks
  about a phone that stopped working ("who revoked it?") without opening the audit log.
- **Rename.** `nameHint` gives two real names, because the default name ("Chrome on Windows", 18a) says nothing
  about which counter it is. The toast `renamed` names the new name, so a typo is seen at once.
- **Change branch** (decision 2). `changeBranchBody` says what happens (the old branch's copy is deleted, the new one
  is copied) and what changes for the work (offline orders use the new branch's warehouses). The dialog cannot open
  when it would fail: `changeBranchOffline` and `changeBranchSyncFirst_*` say why, and the second one points to the
  Sync page, where the waiting changes are sent or discarded.
- **Revoke** (decisions 3 and 4). `revokeBody` is for a device somewhere else: it stops at once, and its copy and its
  unsynced changes are deleted the next time it opens. `revokeHereBody` is for the device you are on: you are signed
  out here. When this device still has changes waiting, `revokeHereWaiting_*` adds how many are lost, as the
  sign-out dialog of 18b does. `revokeFinal` is under both: there is no "Restore", and signing in again makes a new
  device, so nobody revokes a device "for now". The button says `Revoke device`, what happens.
- **`revokedSignedOut`** is the notice on the sign-in page after a device found out it was revoked (at its next pull
  or push, or at sign-in): its data is gone, the person is signed out, and signing in sets it up again. Without it,
  a person signed out in the middle of the day would think the app broke.
- **The time limits** (decision 12) are in `sync`, because they are about the sync:
  - `lastSyncedDays_*` is the sidebar's line and the Sync page's line after 24 hours ("Last synced 2 days ago"). The
    Sync page's normal line (`lastSynced`, with the date and time) stays for a device that is up to date.
  - `staleNotice` is the `warn` notice on the Sync page after 24 hours: it says what may be old (prices, stock,
    credit limits) and what to do.
  - `blockedNotice` (the Sync page) and `blockedFormNotice` (the customer and order forms offline) are for the 7
    days. `days` is `SYNC_BLOCK_AFTER_DAYS` in the page's language, not a count of days passed: the rule is what the
    person must know, and it is always more than one, so no plural keys. The Sync page's notice also says that the
    changes already waiting still go: only new work stops.
- **`permissions.core.device.manage`** is the line in the role matrix (step 6). It names the three things it allows,
  so an owner knows what they give away: seeing every device, renaming them and revoking them.
- **`audit.actions.device`** gets the three actions of 18c.1, and `audit.fields.revokedAt` is the label of the one
  field a revoke changes. `name` and `branch` (the rename and the move) are labelled already.
- **`branch_has_devices`** says how many devices are in the way and the two ways out (decision 20). The count comes
  from the API's `params.count`, so it cannot use plural keys: the `errors` object has one key per error code (the
  `satisfies` above). It is written as "Active devices in this branch: 2", like `year_has_drafts` of step 11, so the
  sentence reads right for 1 and for many. "Change their branch on each device" is the hint that nobody can move
  them from here (decision 2).
- **Two keys came with the screens of 18c.6:** `devices.columns.actions`, the header of the column of row menus
  (screen readers only), and `devices.needsConnection`, what both lists say offline, like the orders list.

### `locales/bn.ts`

```diff
@@ -31,6 +31,7 @@ export const bn: Messages = {
     notifications: 'নোটিফিকেশন',
     notificationsUnread_one: 'নোটিফিকেশন, {{count}}টা পড়া হয়নি',
     notificationsUnread_other: 'নোটিফিকেশন, {{count}}টা পড়া হয়নি',
+    myDevices: 'আমার ডিভাইস',
   },
   nav: {
     overview: 'সারসংক্ষেপ',
@@ -39,6 +40,7 @@ export const bn: Messages = {
     settings: 'সেটিংস',
     numbering: 'নম্বরিং',
     branches: 'ব্রাঞ্চ',
+    devices: 'ডিভাইস',
     auditLog: 'অডিট লগ',
     team: 'টিম',
     roles: 'রোল',
@@ -343,6 +345,78 @@ export const bn: Messages = {
     useBranch: 'এই ব্রাঞ্চ রাখুন',
     later: 'এখন না',
     registered: 'এই ডিভাইস {{branch}}-এর জন্য সেট করা হয়েছে',
+    mineTitle: 'আমার ডিভাইস',
+    mineDescription:
+      'যেসব ব্রাউজার আর ফোনে আপনি এই ওয়ার্কস্পেস ব্যবহার করেন। যেগুলো আর ব্যবহার করেন না, সেগুলো রিভোক করুন।',
+    mineEmptyTitle: 'এখনো কোনো ডিভাইস নেই',
+    mineEmptyBody: 'এই কম্পিউটার বা ফোন সেট করতে এর ব্রাঞ্চ বাছুন। তারপর এটা এখানে দেখাবে।',
+    title: 'ডিভাইস',
+    description: 'যেসব ব্রাউজার আর ফোনে এই ওয়ার্কস্পেসের ডেটার কপি আছে',
+    readOnly: 'সব ডিভাইস দেখতে ওয়ার্কস্পেস মালিকের কাছে core.device.manage অনুমতি চান।',
+    loadFailed: 'ডিভাইসের তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    needsConnection: 'ডিভাইসের তালিকা সার্ভারে আছে। দেখতে ইন্টারনেটে যুক্ত হন।',
+    show: 'দেখান',
+    statuses: {
+      active: 'চালু',
+      revoked: 'রিভোক করা',
+    },
+    stale_one: '{{formatted}} দিন সিঙ্ক হয়নি',
+    stale_other: '{{formatted}} দিন সিঙ্ক হয়নি',
+    thisDevice: 'এই ডিভাইস',
+    searchLabel: 'ডিভাইস খুঁজুন',
+    searchPlaceholder: 'ডিভাইস বা মানুষ, যেমন Counter 1 বা তানভীর',
+    allBranches: 'সব ব্রাঞ্চ',
+    columns: {
+      device: 'ডিভাইস',
+      person: 'মানুষ',
+      branch: 'ব্রাঞ্চ',
+      lastSync: 'শেষ সিঙ্ক',
+      status: 'অবস্থা',
+      actions: 'কাজ',
+    },
+    neverSynced: 'কখনো সিঙ্ক হয়নি',
+    revokedBy: '{{name}} রিভোক করেছেন · {{time}}',
+    emptyTitle: 'এখনো কোনো ডিভাইস নেই',
+    emptyBody:
+      'কেউ কোনো ডিভাইসে সাইন ইন করে তার ব্রাঞ্চ বাছলে সেটা এখানে দেখায়, যেমন চট্টগ্রাম ডিপোর কাউন্টারের কম্পিউটার।',
+    emptyRevokedTitle: 'কোনো রিভোক করা ডিভাইস নেই',
+    emptyRevokedBody:
+      'হারানো ফোন বা বদলে ফেলা কাউন্টারের কম্পিউটার রিভোক করলে এখানে দেখায়। তার ইতিহাস অডিট লগে থেকে যায়।',
+    noMatchTitle: '"{{query}}"-এর সাথে কোনো ডিভাইস মেলেনি',
+    noMatchBody: 'ডিভাইসের নাম (যেমন Counter 1) বা মানুষের নাম দিয়ে খুঁজুন।',
+    actionsFor: '{{name}}-এর কাজ',
+    rename: 'নাম বদলান',
+    renameTitle: '{{name}}-এর নাম বদলান',
+    name: 'নাম',
+    nameHint: 'যে নামে সবাই এটা চেনে, যেমন Counter 1 বা তানভীরের ফোন।',
+    saveName: 'নাম সেভ করুন',
+    renamed: 'নাম বদলে {{name}} রাখা হয়েছে',
+    changeBranch: 'ব্রাঞ্চ বদলান',
+    changeBranchTitle: 'এই ডিভাইসের ব্রাঞ্চ বদলান',
+    changeBranchBody:
+      'Omnivo এই ডিভাইস থেকে {{branch}}-এর কপি মুছে দেয়, আর আপনার বাছা ব্রাঞ্চের কপি আনে। এরপর এখানে অফলাইনে সেভ করা অর্ডার সেই ব্রাঞ্চের গুদাম ব্যবহার করে।',
+    newBranch: 'নতুন ব্রাঞ্চ',
+    changeBranchConfirm: 'ব্রাঞ্চ বদলান',
+    moved: 'এই ডিভাইস এখন {{branch}}-এর জন্য সেট করা',
+    changeBranchOffline: 'ব্রাঞ্চ বদলাতে ইন্টারনেটে যুক্ত হন।',
+    changeBranchSyncFirst_one:
+      'আগে এই ডিভাইসের {{formatted}}টা পরিবর্তন সিঙ্ক করুন। পাঠাতে বা বাদ দিতে সিঙ্ক পেজ খুলুন।',
+    changeBranchSyncFirst_other:
+      'আগে এই ডিভাইসের {{formatted}}টা পরিবর্তন সিঙ্ক করুন। পাঠাতে বা বাদ দিতে সিঙ্ক পেজ খুলুন।',
+    revoke: 'রিভোক করুন',
+    revokeTitle: '{{name}} রিভোক করবেন?',
+    revokeBody:
+      'এটা সাথে সাথে সিঙ্ক বন্ধ করে, আর সাইন আউট হয়ে যায়। পরের বার Omnivo খুললে এর ডেটার কপি মুছে যায়, সাথে এর যেসব পরিবর্তন সিঙ্ক হয়নি সেগুলোও।',
+    revokeHereBody: 'এখানে আপনি সাইন আউট হবেন, আর এই ডিভাইসের ডেটার কপি মুছে যাবে।',
+    revokeHereWaiting_one: 'এই ডিভাইসের {{formatted}}টা পরিবর্তন সিঙ্ক হয়নি। সেটা হারিয়ে যাবে।',
+    revokeHereWaiting_other:
+      'এই ডিভাইসের {{formatted}}টা পরিবর্তন সিঙ্ক হয়নি। সেগুলো হারিয়ে যাবে।',
+    revokeFinal:
+      'রিভোক করা ডিভাইস আর ফেরানো যায় না। এতে আবার সাইন ইন করলে এটা নতুন ডিভাইস হিসেবে সেট হয়।',
+    revokeConfirm: 'ডিভাইস রিভোক করুন',
+    revoked: '{{name}} রিভোক করা হয়েছে',
+    revokedSignedOut:
+      'এই ডিভাইস রিভোক করা হয়েছে, তাই এর ডেটা মুছে আপনাকে সাইন আউট করা হয়েছে। নতুন ডিভাইস হিসেবে আবার সেট করতে সাইন ইন করুন।',
   },
   sync: {
     notSetUpTitle: 'এই ডিভাইস এখনো সেট করা হয়নি',
@@ -440,6 +514,14 @@ export const bn: Messages = {
     busy: 'এই পরিবর্তনটি এখন পাঠানো হচ্ছে। একটু পরে আবার চেষ্টা করুন।',
     orderOffline: 'এই অর্ডারটি সার্ভারে আছে। খুলতে ইন্টারনেটে যুক্ত হোন।',
     ordersOffline: 'সার্ভারের অর্ডার দেখতে সংযোগ লাগবে। এই ডিভাইসে সেভ করা খসড়াগুলো উপরে আছে।',
+    lastSyncedDays_one: 'শেষ সিঙ্ক {{formatted}} দিন আগে',
+    lastSyncedDays_other: 'শেষ সিঙ্ক {{formatted}} দিন আগে',
+    staleNotice:
+      'এই ডিভাইসের দাম, স্টক আর ক্রেডিট লিমিট পুরনো হতে পারে। সিঙ্ক করতে ইন্টারনেটে যুক্ত হন।',
+    blockedNotice:
+      'এই ডিভাইস শেষ সিঙ্ক হয়েছে {{days}} দিনেরও আগে, তাই অফলাইনে নতুন কাজ সেভ করা যাবে না। যে পরিবর্তনগুলো অপেক্ষায় আছে, সংযোগ ফিরলে সেগুলো পাঠানো হবে।',
+    blockedFormNotice:
+      'এই ডিভাইস শেষ সিঙ্ক হয়েছে {{days}} দিনেরও আগে, তাই অফলাইনে নতুন কাজ সেভ করা যাবে না। এটা সেভ করতে ইন্টারনেটে যুক্ত হন।',
   },
   accounts: {
     title: 'চার্ট অফ অ্যাকাউন্টস',
@@ -4000,6 +4082,7 @@ export const bn: Messages = {
         invite: 'আমন্ত্রণ পাঠানো',
         manage: 'সদস্যের রোল বদলানো আর সদস্য সরানো',
       },
+      device: { manage: 'ওয়ার্কস্পেসের সব ডিভাইস দেখা, নাম বদলানো আর রিভোক করা' },
       role: { manage: 'রোল তৈরি আর তার অনুমতি বাছা' },
       settings: { manage: 'কোম্পানির সেটিংস আর নম্বরিং বদলানো' },
       branch: { manage: 'ব্রাঞ্চ যোগ, বদল আর আর্কাইভ' },
@@ -4164,7 +4247,12 @@ export const bn: Messages = {
         restored: 'ব্রাঞ্চ ফিরিয়ে এনেছেন',
       },
       number_series: { updated: 'নম্বরিং বদলেছেন' },
-      device: { registered: 'একটা ডিভাইস সেট করেছেন' },
+      device: {
+        registered: 'একটা ডিভাইস সেট করেছেন',
+        renamed: 'একটা ডিভাইসের নাম বদলেছেন',
+        moved: 'একটা ডিভাইস অন্য ব্রাঞ্চে নিয়েছেন',
+        revoked: 'একটা ডিভাইস রিভোক করেছেন',
+      },
       member: {
         invited: 'আমন্ত্রণ পাঠিয়েছেন',
         invitation_resent: 'আমন্ত্রণ আবার পাঠিয়েছেন',
@@ -4529,6 +4617,7 @@ export const bn: Messages = {
       supplierCreditNumber: 'সাপ্লায়ারের ক্রেডিট নোট',
       priceDifference: 'ক্রয়মূল্যের পার্থক্য',
       services: 'কেনা সার্ভিস',
+      revokedAt: 'রিভোকের সময়',
     },
     loadFailed: 'অডিট লগ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
@@ -5182,6 +5271,8 @@ export const bn: Messages = {
     sync_command_invalid:
       'সার্ভার এই পরিবর্তনটা পড়তে পারছে না। পেজটা রিলোড করুন, তারপরও না নিলে পরিবর্তনটা বাদ দিন।',
     sync_customer_gone: 'এই গ্রাহক মুছে ফেলা হয়েছে, বা আর গ্রাহক নেই। পরিবর্তনটা বাদ দিন।',
+    branch_has_devices:
+      'এই ব্রাঞ্চে চালু ডিভাইস: {{count}}টা। আগে প্রতিটা ডিভাইস থেকে তার ব্রাঞ্চ বদলান, বা সেগুলো রিভোক করুন।',
     invalid_cursor: 'তালিকাটা বদলে গেছে। পেজটা রিলোড করে আবার চেষ্টা করুন।',
     version_conflict:
       'আপনি বদলানোর সময় আরেকজন পরিবর্তন সেভ করেছেন। রিলোড করে তাঁরটা দেখুন, তারপর আবার বদলান।',
```

- **The same keys, in the same places,** without the comments: they are in `en.ts`. Office words stay as the app
  already writes them: সিঙ্ক, ডিভাইস, ব্রাঞ্চ, core.device.manage (CLAUDE.md → Language).
- **Revoke is রিভোক** (decision 23): রিভোক করুন on the button, রিভোক করা for the status. 18a's `device_revoked` error
  and `sync.revokedTitle` say সরানো ("removed"); they stay as they are, because they tell the device itself what
  happened, where "removed from the workspace" is the plain meaning.
- **The `_one` and `_other` keys are the same text.** Bangla has one form for one and many, but i18next asks for
  both keys, because the English type has both.
- **`revokedBy` puts the person first** ("Shafiq রিভোক করেছেন · …"), the Bangla word order, so the app passes the
  name as it is and adds nothing around it.
- **The example names are Bangla where they are names of people** (তানভীর), and stay as typed where they are the
  device's own name (Counter 1): a device name is whatever the person typed, often in English.

### Check this part

```bash
pnpm --filter @omnivo/i18n typecheck
pnpm --filter @omnivo/i18n test
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/ui typecheck
pnpm --filter @omnivo/app typecheck
```

Build `@omnivo/i18n` before you type-check the ui package and the app: they read its built types. All five pass:
after this part the whole `pnpm typecheck` is clean again.

> **What we checked in this part.** `packages/i18n` type-checks, ESLint and Prettier are clean, its unit tests pass
> (11), and it builds. `packages/ui` and `apps/app` type-check against the new build, with no error. To be sure
> nothing can drift apart, we removed words on purpose, one at a time: the Bangla `devices.revokeConfirm` (the type
> check named it as missing in `bn.ts`), and the English and Bangla text of `core.device.manage` (the i18n package
> still compiled, but the app's role matrix failed its type check, on ``t(`permissions.${key}`)``). Both passed again
> after the words were put back.

## 18c.6 — `packages/sync` and `apps/app`: the screens

The device side of this step. `packages/sync` learns two small things: the device's own clock at the end of a pull,
and how to forget a revoked device. The app gets the two device lists with their three dialogs, the revoke flow
(wipe, sign out or set up again), the branch change, and the time limits on the sidebar, the Sync page and the two
offline forms. Every page that reads the device's copy keeps working as it did: none of them changes.

### `packages/sync`: the device's own clock, and forgetting a device

```diff
@@ -57,6 +57,9 @@ export interface PullState {
   // The server's clock at the end of the last pull that finished. null = no pull has finished,
   // so the device has no complete copy yet.
   lastSyncAt: string | null;
+  // Step 18c: this device's own clock at that moment (ms since 1970), for the time limits. A copy
+  // made before step 18c has no value here until its next pull ends (readPullState gives null).
+  syncedAt: number | null;
   // The rows the running (or the last) full pull wrote, for "1,250 items copied so far"
   copied: number;
 }
```

- **`syncedAt` is a new field of the pull state, not a new table or index** (decision 24). Dexie stores the object
  as it is, so a field that is not indexed needs no new database version, and nothing on the device has to be
  copied again.
- **It is `number | null`, a time in milliseconds,** because it is only ever compared with `Date.now()`. It is not
  optional: an optional field would make every reader handle `undefined` too. A row saved before this step lacks it,
  which `readPullState` handles in one place (below).

```diff
@@ -6,11 +6,23 @@ export const NO_PULL: PullState = {
   generation: 0,
   full: false,
   lastSyncAt: null,
+  syncedAt: null,
   copied: 0,
 };
 
 // Where the pull is. Type imports only: a page reads it (for "1,250 items copied so far") without
-// loading Dexie; the database object comes from the code that opened it.
+// loading Dexie; the database object comes from the code that opened it. Spread over NO_PULL: a
+// row saved by an older version of the app lacks the fields added since (syncedAt, step 18c).
 export async function readPullState(db: SyncDatabase): Promise<PullState> {
-  return (await db.meta.get('pull')) ?? NO_PULL;
+  const saved = await db.meta.get('pull');
+  return saved ? { ...NO_PULL, ...saved } : NO_PULL;
+}
+
+// Step 18c: when the last pull ended, on this device's clock, for the time limits (syncAge in the
+// contracts). Both ends of "how long ago" then come from the same clock, so a device whose clock is
+// three hours wrong still counts 24 hours right. A copy from before step 18c has only the server's
+// time, which stands in until its next pull ends. null = no pull has ended.
+export function syncedAtOf(state: PullState): number | null {
+  if (state.lastSyncAt === null) return null;
+  return state.syncedAt ?? Date.parse(state.lastSyncAt);
 }
```

- **`readPullState` spreads the saved row over `NO_PULL`.** A row an older app saved has no `syncedAt`; the spread
  gives it `NO_PULL`'s `null`, so the type tells the truth for every reader. Any field added later gets the same
  care for free.
- **`syncedAtOf()` is the one place that picks the time for the limits.** The device's own time when there is one;
  the server's (`lastSyncAt`) for a copy from before this step, until its next pull; `null` when no pull ever
  ended. The app never reads `syncedAt` itself, so the fallback cannot be forgotten on one screen.

```diff
@@ -110,7 +110,12 @@ function groupChanges(changes: readonly SyncChange[], gen: number) {
 // starts a new generation when the device was not in a full pull, or when it sent no cursor (the
 // server started from the beginning, so whatever an earlier full pull wrote does not count).
 // Every later page of that full pull writes the same generation.
-function nextState(state: PullState, page: SyncPull, sentCursor: string | null): PullState {
+function nextState(
+  state: PullState,
+  page: SyncPull,
+  sentCursor: string | null,
+  now: number,
+): PullState {
   const starts = page.full && (!state.full || sentCursor === null);
   const generation = starts ? state.generation + 1 : state.generation;
   const upserts = page.changes.filter((change) => change.op === 'upsert').length;
@@ -123,6 +128,7 @@ function nextState(state: PullState, page: SyncPull, sentCursor: string | null):
     // starts a new generation that sweeps whatever this one left.
     full: page.full && page.hasMore,
     lastSyncAt: page.hasMore ? state.lastSyncAt : page.serverTime,
+    syncedAt: page.hasMore ? state.syncedAt : now,
     copied: starts ? upserts : page.full ? state.copied + upserts : state.copied,
   };
 }
@@ -152,14 +158,16 @@ export async function writeChanges(
 
 // One page into the database, in one transaction: the rows, the deletes and the cursor are
 // saved together or not at all. A tab closed half way through a page leaves the old cursor, and
-// the same page comes again; its upserts and deletes give the same result twice.
+// the same page comes again; its upserts and deletes give the same result twice. `now` is the
+// device's clock (step 18c), a parameter so a test can set it.
 export async function applyPage(
   db: SyncDatabase,
   page: SyncPull,
   sentCursor: string | null,
+  now: number = Date.now(),
 ): Promise<PullState> {
   return db.transaction('rw', [...db.syncTables(), db.meta], async () => {
-    const state = nextState(await readPullState(db), page, sentCursor);
+    const state = nextState(await readPullState(db), page, sentCursor, now);
     await writeChanges(db, page.changes, state.generation);
     // The last page of a full pull: every row it did not send is older than its generation, and
     // goes (decision 17). Until now, the lists kept showing them.
```

- **`now` is a parameter with `Date.now()` as its default.** The engine calls `applyPage` as before; a test passes
  its own time and checks it, without faking the clock of the whole test.
- **`syncedAt` changes only on the last page,** exactly like `lastSyncAt`: a pull that stops half way (the tab closed,
  the connection dropped) did not sync, and must not reset the 24 hours.

```diff
@@ -21,7 +21,9 @@ const identitySchema = z.object({
   later: z.boolean(),
 });
 
-function storageKey(tenantId: string, userId: string): string {
+// Step 18c: exported for the app's `storage` listener, which follows a move or a revoke made in
+// another tab of the same browser
+export function deviceStorageKey(tenantId: string, userId: string): string {
   return `omnivo.device.${tenantId}.${userId}`;
 }
 
@@ -35,7 +37,7 @@ export function readDevice(
   userId: string,
 ): DeviceIdentity {
   try {
-    const saved = storage?.getItem(storageKey(tenantId, userId));
+    const saved = storage?.getItem(deviceStorageKey(tenantId, userId));
     if (saved !== null && saved !== undefined) {
       const parsed = identitySchema.safeParse(JSON.parse(saved));
       if (parsed.success) return parsed.data;
@@ -55,7 +57,25 @@ export function saveDevice(
   identity: DeviceIdentity,
 ): boolean {
   try {
-    storage?.setItem(storageKey(tenantId, userId), JSON.stringify(identity));
+    storage?.setItem(deviceStorageKey(tenantId, userId), JSON.stringify(identity));
+    return storage !== null;
+  } catch {
+    return false;
+  }
+}
+
+// Step 18c (decision 4): a revoked device is never used again. Without a saved identity, the next
+// readDevice makes a new id, so the next set-up registers a new device. false = the storage
+// refused; the revoked id then stays, and registering it again finds it revoked once more.
+// Its own storage type: reading and saving never remove, and a caller that only reads and saves
+// (a test's stand-in) need not write a removeItem
+export function forgetDevice(
+  storage: Pick<Storage, 'removeItem'> | null,
+  tenantId: string,
+  userId: string,
+): boolean {
+  try {
+    storage?.removeItem(deviceStorageKey(tenantId, userId));
     return storage !== null;
   } catch {
     return false;
```

- **`deviceStorageKey()` is exported** for the app's `storage` listener (decision 29): it must compare the event's
  key with the exact key this file writes, and a second copy of the string would drift.
- **`forgetDevice()` removes the identity** (decision 25). The next `readDevice()` finds nothing and makes a new id,
  so the next set-up registers a new device. Like `saveDevice()`, it returns `false` when the storage refuses
  (Safari in a private window can throw), and never throws itself: the revoke must go on and delete the copy.
- **It takes its own storage type, `Pick<Storage, 'removeItem'>`,** instead of adding `removeItem` to
  `IdentityStorage`. Reading and saving never remove, and the e2e helpers build an `IdentityStorage` by hand; a
  wider type would make them write a `removeItem` they never use.

```diff
@@ -22,6 +22,8 @@ export {
 export {
   type DeviceIdentity,
   deviceNameParts,
+  deviceStorageKey,
+  forgetDevice,
   type IdentityStorage,
   newDeviceId,
   readDevice,
@@ -78,4 +80,4 @@ export {
   syncNotices,
 } from './queries.js';
 export { customerRecord, productRecord, searchText } from './records.js';
-export { NO_PULL, readPullState } from './state.js';
+export { NO_PULL, readPullState, syncedAtOf } from './state.js';
```

- **The three new names are exported** from the package's one entry point, next to their neighbours.

```diff
@@ -3,7 +3,7 @@ import 'fake-indexeddb/auto';
 import { describe, expect, it } from 'vitest';
 
 import { applyPage } from './apply.js';
-import { readPullState } from './state.js';
+import { NO_PULL, readPullState, syncedAtOf } from './state.js';
 import { newDatabase, page, product, upsertProduct } from './test-fixtures.js';
 
 const shirt = product({ name: 'Polo shirt', code: 'FG-0001' });
@@ -121,6 +121,38 @@ describe('applyPage', () => {
     expect((await readPullState(db)).lastSyncAt).toBe('2026-10-21T04:00:05.000Z');
   });
 
+  it("keeps the device's own clock at the end of a pull, for the time limits (step 18c)", async () => {
+    const db = newDatabase();
+    // The device's clock is three hours behind the server's: the limits count on the device's
+    const deviceNow = Date.parse('2026-10-21T01:00:00.000Z');
+    const first = page({ full: true, hasMore: true, changes: [] });
+    await applyPage(db, first, null, deviceNow - 5000);
+    expect((await readPullState(db)).syncedAt).toBeNull();
+    await applyPage(
+      db,
+      page({ full: true, changes: [], serverTime: '2026-10-21T04:00:05.000Z' }),
+      first.cursor,
+      deviceNow,
+    );
+    const state = await readPullState(db);
+    expect(state.syncedAt).toBe(deviceNow);
+    expect(syncedAtOf(state)).toBe(deviceNow);
+  });
+
+  it('reads a pull state saved before step 18c, with the server time standing in', async () => {
+    const db = newDatabase();
+    await db.meta.put({ ...NO_PULL, cursor: 'c', lastSyncAt: '2026-10-21T04:00:05.000Z' });
+    // An older app saved the row without syncedAt: take the field off, as it was stored then
+    await db.meta.update('pull', (row) => {
+      Reflect.deleteProperty(row, 'syncedAt');
+    });
+    expect(await db.meta.get('pull')).not.toHaveProperty('syncedAt');
+    const state = await readPullState(db);
+    expect(state.syncedAt).toBeNull();
+    expect(syncedAtOf(state)).toBe(Date.parse('2026-10-21T04:00:05.000Z'));
+    expect(syncedAtOf(NO_PULL)).toBeNull();
+  });
+
   it('keeps the price and the stock keys the server sends', async () => {
     const db = newDatabase();
     const priceKey = `${shirt.id}:${shirt.variants[0]?.id ?? ''}:${shirt.baseUnitId}`;
```

- **The device's clock is set three hours behind the server's** in the first new test: the saved `syncedAt` is the
  device's time, not the server's, which is the whole point of decision 24.
- **The second test stores a row the way an older app did, without `syncedAt`.** `Reflect.deleteProperty` takes the
  field off inside Dexie's update, without a cast: `delete row.syncedAt` does not compile on a field that is not
  optional. The test then checks that the row really has no such field, so it cannot pass by accident.

```diff
@@ -1,12 +1,19 @@
 import { describe, expect, it } from 'vitest';
 
-import { deviceNameParts, type IdentityStorage, readDevice, saveDevice } from './device.js';
+import {
+  deviceNameParts,
+  forgetDevice,
+  type IdentityStorage,
+  readDevice,
+  saveDevice,
+} from './device.js';
 
 const TENANT = '01928c4e-2222-7000-8000-000000000001';
 const USER = '01928c4e-3333-7000-8000-000000000001';
 const BRANCH = '01928c4e-4444-7000-8000-000000000001';
 
-function memoryStorage(): IdentityStorage & { items: Map<string, string> } {
+function memoryStorage(): IdentityStorage &
+  Pick<Storage, 'removeItem'> & { items: Map<string, string> } {
   const items = new Map<string, string>();
   return {
     items,
@@ -14,6 +21,9 @@ function memoryStorage(): IdentityStorage & { items: Map<string, string> } {
     setItem: (key, value) => {
       items.set(key, value);
     },
+    removeItem: (key) => {
+      items.delete(key);
+    },
   };
 }
 
@@ -44,18 +54,40 @@ describe('readDevice / saveDevice', () => {
   });
 
   it('works without a storage, or with one that throws (Safari private window)', () => {
-    const refusing: IdentityStorage = {
+    const refusing: IdentityStorage & Pick<Storage, 'removeItem'> = {
       getItem: () => {
         throw new Error('SecurityError');
       },
       setItem: () => {
         throw new Error('QuotaExceededError');
       },
+      removeItem: () => {
+        throw new Error('SecurityError');
+      },
     };
     const identity = readDevice(refusing, TENANT, USER);
     expect(saveDevice(refusing, TENANT, USER, identity)).toBe(false);
     expect(saveDevice(null, TENANT, USER, identity)).toBe(false);
     expect(readDevice(null, TENANT, USER).branchId).toBeNull();
+    expect(forgetDevice(refusing, TENANT, USER)).toBe(false);
+    expect(forgetDevice(null, TENANT, USER)).toBe(false);
+  });
+});
+
+describe('forgetDevice', () => {
+  it('drops the saved identity, so the next read makes a new id (step 18c, decision 4)', () => {
+    const storage = memoryStorage();
+    const revoked = { ...readDevice(storage, TENANT, USER), branchId: BRANCH };
+    saveDevice(storage, TENANT, USER, revoked);
+    const other = { ...readDevice(storage, TENANT, BRANCH), branchId: BRANCH };
+    saveDevice(storage, TENANT, BRANCH, other);
+
+    expect(forgetDevice(storage, TENANT, USER)).toBe(true);
+    const next = readDevice(storage, TENANT, USER);
+    expect(next.id).not.toBe(revoked.id);
+    expect(next).toMatchObject({ branchId: null, later: false });
+    // Another person's identity on the same browser stays
+    expect(readDevice(storage, TENANT, BRANCH)).toEqual(other);
   });
 });
 
```

- **The test storage gets a `removeItem`, and the refusing one throws there too.** `forgetDevice` must answer
  `false` and not throw.
- **The new test keeps a second identity on the same browser** and checks it stays: forgetting one person's device
  must not sign another person's device out of its identity.

### The session store: why the sign-in page shows

```diff
@@ -2,17 +2,22 @@ import type { MeResponse } from '@omnivo/contracts';
 import { createStore } from 'zustand/vanilla';
 import { useStore } from 'zustand';
 
+// Step 18c: why the sign-in page is showing, when the person did not sign out themself. Only one
+// reason so far: this device was revoked (its data was deleted).
+export type SignOutNotice = 'device_revoked';
+
 interface SessionState {
   // unknown = অ্যাপ সবে খুলেছে, refresh cookie দিয়ে session ফেরানো এখনো শেষ হয়নি
   status: 'unknown' | 'signed-in' | 'signed-out';
   // শুধু memory-তে — localStorage-এ রাখলে যেকোনো XSS স্ক্রিপ্ট টোকেন পড়তে পারত
   accessToken: string | null;
   me: MeResponse | null;
+  notice: SignOutNotice | null;
   setAccessToken: (accessToken: string) => void;
   signIn: (me: MeResponse) => void;
   // লগইনের পরে me-র অংশ বদলালে (কোম্পানির নাম, পছন্দ) — status না ছুঁয়ে
   setMe: (me: MeResponse) => void;
-  signOut: () => void;
+  signOut: (notice?: SignOutNotice) => void;
 }
 
 // vanilla store: React-এর বাইরে (api.ts, router-এর beforeLoad) থেকেও getState() ডাকা যায়
@@ -20,17 +25,25 @@ export const sessionStore = createStore<SessionState>()((set) => ({
   status: 'unknown',
   accessToken: null,
   me: null,
+  notice: null,
   setAccessToken: (accessToken) => {
     set({ accessToken });
   },
   signIn: (me) => {
-    set({ status: 'signed-in', me });
+    set({ status: 'signed-in', me, notice: null });
   },
   setMe: (me) => {
     set({ me });
   },
-  signOut: () => {
-    set({ status: 'signed-out', accessToken: null, me: null });
+  // Step 18c: a sign-out without a reason keeps the one already there. After a revoke, the requests
+  // still on their way get a 401, and api.ts signs out again for each: the notice must stay.
+  signOut: (notice) => {
+    set((state) => ({
+      status: 'signed-out',
+      accessToken: null,
+      me: null,
+      notice: notice ?? (state.status === 'signed-out' ? state.notice : null),
+    }));
   },
 }));
 
```

- **`notice` is the reason for a sign-out the person did not ask for** (decision 30). One reason so far,
  `device_revoked`, as a union type: the sign-in page's `===` check fails to compile if the name is mistyped, and a
  second reason later is one more member.
- **`signIn` clears it,** so it is shown once, until the person signs in again.
- **`signOut()` without a reason keeps the one already there, but only while already signed out.** After a revoke,
  each request still on its way gets a 401, its refresh fails, and `api.ts` signs out again with no reason: without
  this rule, the last of them would erase the notice before the page drew it. A normal sign-out (from signed in)
  still clears it.

```ts
import { beforeEach, describe, expect, it } from 'vitest';

import { meIn, WORKSPACES } from '../mocks/fixtures';
import { sessionStore } from './session-store';

const [workspace] = WORKSPACES;

function signIn(): void {
  sessionStore
    .getState()
    .signIn(meIn(workspace, 'Rahman Garments Ltd.', { language: 'en', theme: 'system' }, 'ready'));
}

describe('the sign-out notice (step 18c)', () => {
  beforeEach(() => {
    // A sign-in clears whatever the last test left
    signIn();
    sessionStore.getState().signOut();
  });

  it('keeps the reason when the requests still on their way sign out again', () => {
    signIn();
    sessionStore.getState().signOut('device_revoked');
    // api.ts after a 401 whose refresh failed: no reason of its own
    sessionStore.getState().signOut();
    sessionStore.getState().signOut();
    expect(sessionStore.getState()).toMatchObject({
      status: 'signed-out',
      notice: 'device_revoked',
    });
  });

  it('has no reason after a sign-out the person asked for, and none after the next sign-in', () => {
    signIn();
    sessionStore.getState().signOut();
    expect(sessionStore.getState().notice).toBeNull();

    sessionStore.getState().signOut('device_revoked');
    signIn();
    expect(sessionStore.getState()).toMatchObject({ status: 'signed-in', notice: null });
  });
});
```

- **Two tests for the two halves of the rule:** the reason survives the later sign-outs without one, and a sign-out
  the person asked for, or the next sign-in, leaves no reason. `beforeEach` signs in and out once, so each test
  starts from a known state: the store is one object for the whole file.

### `lib/sync-summary.ts`: the time of the last sync, and a clock

```diff
@@ -1,7 +1,9 @@
+import { type SyncAge, syncAge } from '@omnivo/contracts';
+import { useEffect, useState } from 'react';
 import { useStore } from 'zustand';
 import { createStore } from 'zustand/vanilla';
 
-// Step 18b: the three numbers the sidebar shows of the sync (decision 1). The session writes them
+// Step 18b: what the sidebar shows of the sync (decision 1). The session writes them
 // (local-session.ts: the engine's status and a live count of the outbox), and the AppShell reads
 // them. A file of its own that imports nothing of @omnivo/sync: the shell is on every page's path,
 // and local-data.ts with the device's reads took it over its budget.
@@ -11,12 +13,55 @@ export interface SyncSummary {
   // Commands on the device, and the refused ones among them
   waiting: number;
   failed: number;
+  // Step 18c: when the last pull ended, on this device's clock (syncedAtOf in @omnivo/sync). null =
+  // no pull has ended, or no copy is open.
+  syncedAt: number | null;
 }
 
-export const NO_SUMMARY: SyncSummary = { syncing: false, waiting: 0, failed: 0 };
+export const NO_SUMMARY: SyncSummary = { syncing: false, waiting: 0, failed: 0, syncedAt: null };
 
 export const syncSummaryStore = createStore<SyncSummary>()(() => NO_SUMMARY);
 
 export function useSyncSummary(): SyncSummary {
   return useStore(syncSummaryStore);
 }
+
+const DAY_MS = 24 * 60 * 60 * 1000;
+
+// Step 18c: the clock, read again every minute. A page that shows "2 days ago" or a limit must change
+// by itself when an hour passes with the page open; one minute is close enough for a limit counted
+// in hours and days. Date.now() in a state, not in the render: a render must give the same answer
+// for the same state.
+export function useNow(intervalMs = 60_000): number {
+  const [now, setNow] = useState(Date.now);
+  useEffect(() => {
+    const timer = setInterval(() => {
+      setNow(Date.now());
+    }, intervalMs);
+    return () => {
+      clearInterval(timer);
+    };
+  }, [intervalMs]);
+  return now;
+}
+
+export interface SyncAgeInfo {
+  age: SyncAge;
+  // Whole days since the last sync, for "Last synced 2 days ago"; 1 or more once age is not fresh
+  days: number;
+}
+
+// Whole days between two times, never below 0
+export function daysBetween(from: number, to: number): number {
+  return Math.max(0, Math.floor((to - from) / DAY_MS));
+}
+
+// Step 18c (decision 12): how far this device is from its last sync, as the limits see it. null =
+// it never finished a pull: then there is no copy, and the screens already say so (LocalState).
+export function useSyncAge(): SyncAgeInfo | null {
+  const syncedAt = useStore(syncSummaryStore, (state) => state.syncedAt);
+  const now = useNow();
+  if (syncedAt === null) return null;
+  // A pull that ended after the last tick is a little "in the future": syncAge counts that as fresh
+  return { age: syncAge(now - syncedAt), days: daysBetween(syncedAt, now) };
+}
```

- **`syncedAt` joins the summary the session writes** (the outbox counts, the engine's status). The shell reads this
  store, not the database: it is in every page's path, and importing `@omnivo/sync` there would load Dexie with the
  first page.
- **`useNow()` keeps the clock in a state that ticks once a minute.** A page left open over night must turn to "Last
  synced 1 day ago" by itself. `Date.now()` in the render would give a different answer each render, and React expects the
  same answer for the same state; one minute is close enough for limits counted in hours and days.
- **`useSyncAge()` is `null` when no pull ever ended.** Then the device has no copy, and the pages already show the
  copy states (`LocalState`); a "Last synced" warning there would be a second message for the same thing.
- **`daysBetween()` rounds down and never goes below zero.** "1 day ago" starts at 24 hours, the same moment
  `syncAge()` turns to `warn`, so the warning never says "0 days". A pull that ended after the last tick is a moment
  "in the future": zero days, and `syncAge` counts a negative time as fresh.
- **`syncAge` comes from `@omnivo/contracts`**, the same function the device lists use (decision 12). The contracts
  package has no side effects, so the bundler takes only this function into the shell's chunk.

### `lib/local-data.ts`: the device id and two actions in the store

```diff
@@ -1,4 +1,4 @@
-import type { Branch } from '@omnivo/contracts';
+import type { Branch, DeviceListItem, MoveDeviceInput } from '@omnivo/contracts';
 import {
   customerCommands,
   readPullState,
@@ -31,20 +31,41 @@ export type DeviceState =
   | { kind: 'revoked' }
   | { kind: 'ready'; db: SyncDatabase; engine: SyncEngine; watch: Watch };
 
+// Step 18c: what moving this device answers. 'waiting' = its outbox is not empty (decision 2): the
+// dialog checked, but a save in another tab may have come in between.
+export type MoveResult = DeviceListItem | 'waiting';
+
 interface LocalDataState {
   device: DeviceState;
   // The branch dialog is open
   asking: boolean;
   // "Try again" on a first pull that failed; set by the session
   retry: () => void;
+  // Step 18c: this browser's device id for the person signed in now, for the "This device" pill
+  // and for the actions only this device has. null = no session.
+  deviceId: string | null;
+  // Step 18c: the two device actions that change the copy on this device, set by the session like
+  // `retry`. The pages call them through the store, so their chunks never load Dexie.
+  moveHere: (input: MoveDeviceInput) => Promise<MoveResult>;
+  // After this device was revoked from its own list: delete the copy, then sign out
+  revokedHere: () => Promise<void>;
 }
 
+const noSession = () => Promise.reject(new Error('No device session'));
+
 export const localDataStore = createStore<LocalDataState>()(() => ({
   device: { kind: 'starting' },
   asking: false,
   retry: () => undefined,
+  deviceId: null,
+  moveHere: noSession,
+  revokedHere: noSession,
 }));
 
+export function useThisDeviceId(): string | null {
+  return useStore(localDataStore, (state) => state.deviceId);
+}
+
 export function askForBranch(): void {
   localDataStore.setState({ asking: true });
 }
```

- **`deviceId` is this browser's device id for the person signed in now.** The lists compare each row with it, for
  the "This device" pill and for the actions only this device has (Change branch, and Revoke that signs you out).
  The session writes it whenever it saves the identity.
- **`moveHere` and `revokedHere` are functions in the store, set by the session,** like 18a's `retry`. The device
  pages call them through the store, so they never import `local-session.ts`, which brings Dexie: the device lists'
  chunks stay without it (18a's rule, "Dexie only in the host chunk").
- **`MoveResult` is the moved device or `'waiting'`.** A save in another tab may fill the outbox between the dialog's
  check and the move; that is not an error to show, the dialog's live count turns it into "Sync first" by itself.
- **The defaults reject** with an error: with no session there is no device to move, and the pages offer the actions
  only when the session set its device id.

### `lib/local-session.ts`: revoke, move, and the other tabs

```diff
@@ -1,4 +1,4 @@
-import { type Device, routes } from '@omnivo/contracts';
+import { type Device, type MoveDeviceInput, routes } from '@omnivo/contracts';
 import { formatNumber, i18n, isLanguage } from '@omnivo/i18n';
 import {
   allRows,
@@ -7,23 +7,28 @@ import {
   deleteLocalDatabase,
   type DeviceIdentity,
   deviceNameParts,
+  deviceStorageKey,
+  forgetDevice,
   localCustomer,
   lookUpPrices,
   newDeviceId,
   outboxCounts,
   type PushOutcome,
   readDevice,
+  readPullState,
   saveDevice,
   SyncDatabase,
   SyncEngine,
+  syncedAtOf,
   watch,
 } from '@omnivo/sync';
 import { toast } from '@omnivo/ui';
 
-import { ApiRequestError, call, onApiWrite } from './api';
+import { ApiRequestError, call, onApiWrite, refreshSession } from './api';
 import { setDeviceReads } from './device-reads';
-import { localDataStore } from './local-data';
+import { localDataStore, type MoveResult } from './local-data';
 import { queryClient } from './query-client';
+import { sessionStore } from './session-store';
 import { NO_SUMMARY, syncSummaryStore } from './sync-summary';
 
 // Step 18a: this browser as a device, and its copy of the data, for the person signed in now.
@@ -54,6 +59,8 @@ interface Session {
   stopped: boolean;
   // What the running copy needs undone: the engine, the database, the listeners
   cleanup: (() => void)[];
+  // Step 18c: stops following the other tabs; only when the session ends, not with the copy
+  unfollow: () => void;
 }
 
 let current: Session | null = null;
@@ -61,6 +68,16 @@ let current: Session | null = null;
 function remember(session: Session, identity: DeviceIdentity): void {
   session.identity = identity;
   saveDevice(storage(), session.tenantId, session.userId, identity);
+  set({ deviceId: identity.id });
+}
+
+const ended = () => Promise.reject(new Error('The device session ended'));
+
+// Step 18c: for a check after a second await. Another call may end the session during any await,
+// but TypeScript keeps `session.stopped` narrowed to false after the first check; a function call
+// is read again each time.
+function hasEnded(session: Session): boolean {
+  return session.stopped;
 }
 
 function runCleanup(session: Session): void {
@@ -74,8 +91,10 @@ export function startLocalData(input: { tenantId: string; userId: string }): ()
     identity: readDevice(storage(), input.tenantId, input.userId),
     stopped: false,
     cleanup: [],
+    unfollow: () => undefined,
   };
   current = session;
+  session.unfollow = followOtherTabs(session);
   // Saved before the first registration: if its answer is lost, the next try sends the same id
   // and the server returns the same device (decision 20)
   remember(session, session.identity);
@@ -85,6 +104,8 @@ export function startLocalData(input: { tenantId: string; userId: string }): ()
     retry: () => {
       retry(session);
     },
+    moveHere: (input) => moveHere(session, input),
+    revokedHere: () => revoke(session),
   });
   void setUp(session);
   return () => {
@@ -95,12 +116,47 @@ export function startLocalData(input: { tenantId: string; userId: string }): ()
 export function stopLocalData(): void {
   if (!current) return;
   current.stopped = true;
+  current.unfollow();
   runCleanup(current);
   current = null;
-  set({ device: { kind: 'starting' }, asking: false });
+  set({
+    device: { kind: 'starting' },
+    asking: false,
+    deviceId: null,
+    moveHere: ended,
+    revokedHere: ended,
+  });
   syncSummaryStore.setState(NO_SUMMARY);
 }
 
+// Step 18c: another tab of this browser moved this device or found it revoked. It changed the
+// identity in localStorage (a `storage` event reaches every other tab of the same site) and deleted
+// the copy, which closed this tab's database too. This tab follows, instead of showing a copy
+// that is gone until the page is reloaded. Its own writes do not come back to it: the browser
+// sends the event to the other tabs only.
+function followOtherTabs(session: Session): () => void {
+  const key = deviceStorageKey(session.tenantId, session.userId);
+  const changed = (event: StorageEvent) => {
+    if (event.key !== key || session.stopped) return;
+    // Removed: revoked there. The same steps here (forgetting it again changes nothing).
+    if (event.newValue === null) {
+      void revoke(session);
+      return;
+    }
+    const next = readDevice(storage(), session.tenantId, session.userId);
+    // "Not now" there, or the same identity saved again: nothing to follow
+    if (next.id === session.identity.id && next.branchId === session.identity.branchId) return;
+    session.identity = next;
+    runCleanup(session);
+    set({ device: { kind: 'starting' }, deviceId: next.id });
+    void setUp(session);
+  };
+  window.addEventListener('storage', changed);
+  return () => {
+    window.removeEventListener('storage', changed);
+  };
+}
+
 // The copy is the workspace's data: signing out deletes it (decision 41). The device's id stays
 // in localStorage, so the next sign-in is the same device, with a new full pull.
 export async function deleteLocalData(tenantId: string, userId: string): Promise<void> {
@@ -299,6 +355,18 @@ async function open(session: Session): Promise<void> {
     engine.subscribe(() => {
       syncSummaryStore.setState({ syncing: engine.getStatus().syncing });
     }),
+    // Step 18c: the time of the last sync, for the limits (sync-summary.ts: useSyncAge)
+    watch(
+      () => readPullState(db),
+      (state) => {
+        syncSummaryStore.setState({ syncedAt: syncedAtOf(state) });
+      },
+      () => undefined,
+    ),
+    // The copy closes (a move, a revoke, a retry from the start): its numbers go with it
+    () => {
+      syncSummaryStore.setState(NO_SUMMARY);
+    },
     () => {
       setDeviceReads(null);
     },
@@ -313,10 +381,57 @@ async function open(session: Session): Promise<void> {
   engine.start();
 }
 
-// A revoked device keeps nothing (decision 7). The identity stays: registering it again returns
-// the same revoked device, so it stays revoked until step 18c says otherwise.
+// A revoked device keeps nothing (decision 7), and step 18c (decisions 3 and 4) adds two things.
+// Its identity goes too, so the next set-up makes a new id and signing in again makes a new device.
+// And the sign-in: a revoke ends the device's session on the server, so a refresh tells whether it
+// happened during this sign-in. It fails: the person is signed out, with a notice on the sign-in
+// page. It works: they signed in again after the revoke on a browser that still had the revoked
+// id (the engine's first pull or the registration found it), so the device is set up again as a
+// new one, with the branch dialog. Four callers: the engine (device_revoked), a registration that
+// answers a revoked device, the device's own list (revokedHere) and another tab (followOtherTabs).
 async function revoke(session: Session): Promise<void> {
   runCleanup(session);
+  set({ device: { kind: 'revoked' }, asking: false });
+  // Before the delete: the other tabs hear of it and stop using the copy
+  forgetDevice(storage(), session.tenantId, session.userId);
+  await deleteLocalDatabase(session.tenantId, session.userId);
+  if (session.stopped) return;
+  // No answer from the server signs out too: the data is gone already, and signing in again sets
+  // the device up
+  const renewed = await refreshSession().catch(() => null);
+  if (hasEnded(session)) return;
+  if (!renewed) {
+    queryClient.clear();
+    sessionStore.getState().signOut('device_revoked');
+    return;
+  }
+  sessionStore.getState().setAccessToken(renewed.accessToken);
+  remember(session, readDevice(storage(), session.tenantId, session.userId));
+  set({ device: { kind: 'starting' } });
+  await setUp(session);
+}
+
+// Step 18c (decision 2): this device to another branch, from its own list. Only with an empty
+// outbox: its commands were made for the old branch's warehouses, and the server cannot see them
+// to check. The dialog checked it already; this checks again, because another tab may have saved
+// something since. Then the old branch's copy goes, and a full pull copies the new one: an empty
+// database has no cursor (18a's pull would start a full pull anyway, but the old rows would stay
+// on the lists until its last page).
+async function moveHere(session: Session, input: MoveDeviceInput): Promise<MoveResult> {
+  const { device } = localDataStore.getState();
+  // The page offers the move only with an open copy: without one, the outbox cannot be read
+  if (device.kind !== 'ready') throw new Error('No copy is open on this device');
+  if ((await outboxCounts(device.db)).total > 0) return 'waiting';
+  const moved = await call(routes.devices.move, {
+    params: { id: session.identity.id },
+    body: input,
+  });
+  if (session.stopped) return moved;
+  runCleanup(session);
+  set({ device: { kind: 'starting' } });
   await deleteLocalDatabase(session.tenantId, session.userId);
-  if (!session.stopped) set({ device: { kind: 'revoked' }, asking: false });
+  // Saved after the delete: another tab follows the new branch only once the old copy is gone
+  remember(session, { id: moved.id, branchId: moved.branchId, later: false });
+  if (!hasEnded(session)) await open(session);
+  return moved;
 }
```

- **`remember()` also writes `deviceId` into the store,** so the id the pages compare with is always the one saved.
- **`ended` replaces the two actions when the session stops,** so a page that is still open after a sign-out gets a
  rejected promise, not a call into a session that is gone.
- **`hasEnded()` reads `session.stopped` through a function.** Any `await` can let another call end the session.
  After the first `if (session.stopped) return;`, TypeScript keeps the field narrowed to `false` across later awaits,
  and the linter calls a second check useless; a function call is read again each time.
- **`unfollow` is a field of the session, not one of its `cleanup` steps.** `cleanup` runs whenever the copy closes
  (a retry, a move, a revoke that sets the device up again), and the session must keep following the other tabs
  through all of those. It stops only in `stopLocalData()`.
- **`followOtherTabs()`** (decision 29):
  - **The key must be this person's device in this workspace:** the `storage` event fires for every key the site
    writes, other people's identities included.
  - **A removed identity (`newValue === null`) means a revoke in the other tab.** This tab runs the same steps:
    forgetting again changes nothing, deleting a database that is gone does nothing, and its own refresh decides
    whether this tab signs out too.
  - **A new identity with the same id and branch is ignored.** The other tab's "Not now", or the same identity saved
    again at its start, changes nothing here; setting up again would flash the lists empty for nothing.
  - **Otherwise this tab takes the new identity as it is** (no `remember()`: saving it again would only send the
    event back) and sets itself up with it: the moved branch, or the new id after a revoke.
- **The engine's subscriptions get two more steps:** a live read of the pull state that writes `syncedAt` into the
  summary (with `syncedAtOf()`), and a reset of the whole summary when the copy closes. Without the reset, a move
  would show the old copy's counts and its last sync until the new copy's first answer.
- **`revoke()`** (decisions 25 to 27):
  - **`runCleanup` first:** the engine stops before the database is deleted under it.
  - **The device state turns `revoked` at once,** so the lists show "This device was removed" instead of rows of a
    copy being deleted.
  - **The identity goes before the database** (`forgetDevice`), so the other tabs hear of it and close their copy
    first. Then `deleteLocalDatabase`, which waits for every tab's connection to close.
  - **`refreshSession()` asks whether this sign-in still exists** (decision 26). It is the same function `api.ts`
    uses, with its Web Lock, so a refresh in another tab at the same moment does not send the old cookie twice.
    `.catch(() => null)`: no answer counts as gone.
  - **Gone: the query cache is cleared before `signOut('device_revoked')`,** like `logout()` does: nothing of the
    workspace stays in memory for the sign-in page. The AppShell's effect then opens the sign-in page.
  - **Still there: the new access token is set, a new identity is read** (`readDevice` makes a new id, since the old
    one was forgotten) **and saved, and the set-up starts again** with the branch dialog of a new device.
  - **The old comment said a revoked device "stays revoked until step 18c says otherwise";** this is that step.
- **`moveHere()`** (decision 28):
  - **No open copy, no move:** without the database the outbox cannot be read, and the page offers the move only
    with a copy open.
  - **The outbox is read again just before the call.** `total` counts waiting and refused changes alike: a refused
    change was made for the old branch too.
  - **The API call comes before anything on the device changes.** If it fails (offline, a version conflict, an
    archived branch), the device keeps its copy and its branch, and the dialog shows the error.
  - **Then the copy closes, the database is deleted, and the new identity is saved after the delete:** another tab
    that follows it must not reopen the old database. `open()` then starts the engine, and a database with no
    cursor starts with a full pull of the new branch.
  - **The device it returns is the server's,** with the new branch's name for the toast.

### Two small files for the bundle budget

The two device pages were 130 KB gz at first, over the budget of 110 (decision 34). Three moves, each with a
re-export so that no other file's import changes. The first, the dialogs loaded lazily, is in the pages below.

```tsx
import { HourglassIcon, InformationCircleIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import type { ReactNode } from 'react';

// A notice above a document: what its state means and what to do next. Icon plus words, never
// colour alone; warn for an offer that has ended (step 15c: or an invoice past its due date),
// neutral otherwise. Here since 15c, not in quotation-view.tsx: the invoice and receipt pages use it
// too, and importing it from there would pull the quotation page into their chunks. Step 17a: a
// notice may bring its own icon (a requisition sent back is not an hourglass). Step 18c: moved here
// from sales-parts.tsx, which reaches the route map through stock-parts.tsx: the sign-in page must
// not load every module's schemas to show one notice.
export function DocumentNotice({
  tone,
  icon,
  children,
}: {
  tone: 'warn' | 'neutral';
  icon?: IconSvgElement;
  children: ReactNode;
}) {
  return (
    <p
      className={
        tone === 'warn'
          ? 'flex items-start gap-2 rounded-control border border-warn/30 bg-warn-bg px-3 py-2.5 text-body-sm text-warn'
          : 'flex items-start gap-2 rounded-control border border-line bg-subtle px-3 py-2.5 text-body-sm text-ink-2'
      }
    >
      <HugeiconsIcon
        icon={icon ?? (tone === 'warn' ? HourglassIcon : InformationCircleIcon)}
        size={17}
        strokeWidth={1.5}
        className="mt-px shrink-0"
      />
      <span>{children}</span>
    </p>
  );
}
```

- **`DocumentNotice` as it was, in a file of its own.** The sign-in page and the Sync page need it, and
  `sales-parts.tsx` reaches the whole route map through `stock-parts.tsx` and `queries.ts`: the sign-in page would
  load every module's schemas to show one notice.

```diff
@@ -1,12 +1,5 @@
-import {
-  Alert02Icon,
-  ArrowLeft01Icon,
-  HourglassIcon,
-  InformationCircleIcon,
-  PlusSignIcon,
-  Tick02Icon,
-} from '@hugeicons/core-free-icons';
-import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
+import { Alert02Icon, ArrowLeft01Icon, PlusSignIcon, Tick02Icon } from '@hugeicons/core-free-icons';
+import { HugeiconsIcon } from '@hugeicons/react';
 import {
   type CustomerAddress,
   type DocumentTotals,
@@ -123,38 +116,9 @@ export function addressLabel(address: CustomerAddress): string {
   return address.label === null ? firstLine : `${address.label} — ${firstLine}`;
 }
 
-// A notice above a document: what its state means and what to do next. Icon plus words, never
-// colour alone; warn for an offer that has ended (step 15c: or an invoice past its due date),
-// neutral otherwise. Here since 15c, not in quotation-view.tsx: the invoice and receipt pages use it
-// too, and importing it from there would pull the quotation page into their chunks. Step 17a: a
-// notice may bring its own icon (a requisition sent back is not an hourglass).
-export function DocumentNotice({
-  tone,
-  icon,
-  children,
-}: {
-  tone: 'warn' | 'neutral';
-  icon?: IconSvgElement;
-  children: ReactNode;
-}) {
-  return (
-    <p
-      className={
-        tone === 'warn'
-          ? 'flex items-start gap-2 rounded-control border border-warn/30 bg-warn-bg px-3 py-2.5 text-body-sm text-warn'
-          : 'flex items-start gap-2 rounded-control border border-line bg-subtle px-3 py-2.5 text-body-sm text-ink-2'
-      }
-    >
-      <HugeiconsIcon
-        icon={icon ?? (tone === 'warn' ? HourglassIcon : InformationCircleIcon)}
-        size={17}
-        strokeWidth={1.5}
-        className="mt-px shrink-0"
-      />
-      <span>{children}</span>
-    </p>
-  );
-}
+// The notice above a document. Step 18c: in a file of its own, so the sign-in page and the Sync page
+// use it without this file's imports; the documents keep importing it from here.
+export { DocumentNotice } from './document-notice';
 
 // The totals under a quotation's or an order's lines, in the form and on the page. Line discounts
 // show only when something was given away. Paisa: an accounting document's totals must visibly
```

- **`sales-parts.tsx` re-exports it,** so the document pages that import it from there do not change. The two
  icons and the `IconSvgElement` type it no longer uses leave its imports.

```ts
import { DEFAULT_SETTINGS } from '@omnivo/contracts';
import { useQuery } from '@tanstack/react-query';

import { deviceSettingsQuery, settingsQuery } from './queries';
import { useSession } from './session-store';

// The workspace the person is signed in to, and its time zone. Moved here from
// components/stock-parts.tsx in step 18c (which re-exports them): the device lists need only these
// two, and stock-parts brought the stock pages' pills and helpers into their chunks.

export function useTenantId(): string {
  return useSession((state) => state.me?.tenant.id) ?? '';
}

// The company's time zone. Step 18b: offline, before the settings were ever loaded, the device's
// copy has it.
export function useTimeZone(): string {
  const tenantId = useTenantId();
  const server = useQuery(settingsQuery(tenantId)).data;
  const local = useQuery({ ...deviceSettingsQuery(tenantId), enabled: !server }).data;
  return server?.timezone ?? local?.timezone ?? DEFAULT_SETTINGS.timezone;
}
```

- **`useTenantId` and `useTimeZone`, moved from `stock-parts.tsx` as they were.** Every page needs the first, and
  many the second; `stock-parts.tsx` brought the stock pills, the expiry helpers and their icons with them, about 4
  KB gz for each device page.

```diff
@@ -9,7 +9,6 @@ import {
 } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
 import {
-  DEFAULT_SETTINGS,
   todayIn,
   type StockDocumentStatus,
   type TransferStatus,
@@ -22,16 +21,16 @@ import { useQuery, useQueryClient } from '@tanstack/react-query';
 import { Link } from '@tanstack/react-router';
 import { useCallback, useMemo } from 'react';
 
-import { deviceSettingsQuery, settingsQuery, unitsQuery, warehousesQuery } from '../lib/queries';
-import { useSession } from '../lib/session-store';
+import { unitsQuery, warehousesQuery } from '../lib/queries';
 import { daysUntil, expiryTone, variantName } from '../lib/stock';
+import { useTenantId, useTimeZone } from '../lib/workspace';
 
 // Shared by the stock pages and forms. Here, not in a route file: a route file is its own lazy
 // chunk, and importing from one would pull that whole page into the others.
 
-export function useTenantId(): string {
-  return useSession((state) => state.me?.tenant.id) ?? '';
-}
+// Step 18c: in lib/workspace.ts now, so a page that needs only these two (the device lists) does not
+// load the stock pages' parts; the stock pages keep importing them from here
+export { useTenantId, useTimeZone };
 
 // "72 pcs", "2.74 m": a quantity with its unit's decimals and code, in the reader's digits. The
 // units are a small list every product page already loaded.
@@ -79,15 +78,6 @@ export function warehouseLabel(place: Warehouse | undefined): string {
 }
 
 // "Today" in the company's time zone: the forms' default date, and the expiry countdown
-// The company's time zone. Step 18b: offline, before the settings were ever loaded, the device's
-// copy has it.
-export function useTimeZone(): string {
-  const tenantId = useTenantId();
-  const server = useQuery(settingsQuery(tenantId)).data;
-  const local = useQuery({ ...deviceSettingsQuery(tenantId), enabled: !server }).data;
-  return server?.timezone ?? local?.timezone ?? DEFAULT_SETTINGS.timezone;
-}
-
 export function useToday(): string {
   return todayIn(useTimeZone());
 }
```

- **`stock-parts.tsx` imports them back and re-exports them,** so the stock, sales and purchase pages keep their
  imports. Its own `useQuantity` and `useToday` use them as before.

### `lib/queries.ts`: the two device lists

```diff
@@ -10,6 +10,8 @@ import {
   type CustomerSort,
   type CustomerStatus,
   type DeliveryInvoiceFilter,
+  type DeviceSort,
+  type DeviceStatus,
   type InvoicePage,
   type InvoicePaymentFilter,
   type InvoiceStatus,
@@ -141,6 +143,43 @@ export function notificationsQuery(tenantId: string) {
   });
 }
 
+// Step 18c: both device lists start with ['devices', tenantId], so a rename, a move or a revoke
+// refreshes your own list and the workspace's with one invalidate
+export function myDevicesQuery(tenantId: string) {
+  return queryOptions({
+    queryKey: ['devices', tenantId, 'mine'],
+    queryFn: async () => (await call(routes.devices.mine)).items,
+  });
+}
+
+export interface DeviceFilter {
+  search: string;
+  // '' = every branch
+  branchId: string;
+  status: DeviceStatus;
+  sort: DeviceSort;
+}
+
+export function deviceListQuery(tenantId: string, filter: DeviceFilter) {
+  return infiniteQueryOptions({
+    queryKey: ['devices', tenantId, 'list', filter],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.devices.list, {
+        query: {
+          limit: 50,
+          status: filter.status,
+          sort: filter.sort,
+          ...(filter.search !== '' && { search: filter.search }),
+          ...(filter.branchId !== '' && { branchId: filter.branchId }),
+          ...(pageParam !== null && { cursor: pageParam }),
+        },
+      }),
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+    placeholderData: keepPreviousData,
+  });
+}
+
 // ধাপ ৫-এ ড্যাশবোর্ডে ছিল; এখন টিমের পেজে, আর সদস্য বদলালে এই key-র সব পাতা invalidate
 export function membersQuery(tenantId: string, sort: MemberSort) {
   return infiniteQueryOptions({
```

- **Both keys start with `['devices', tenantId]`,** so one invalidate after a rename, a move or a revoke refreshes
  your own list and the workspace's. The tenant is in the key like everywhere: another workspace's devices never
  answer from the cache.
- **Your own list is one query, not pages** (decision 8), and the query returns the items only.
- **The workspace's list is paged like the suppliers list:** the filter object is part of the key, an empty search
  and an empty branch are left out of the query (the API's own defaults), and `keepPreviousData` keeps the rows on
  screen while a new search or sort loads.

### `components/device-parts.tsx` (new): what the two lists share

```tsx
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
```

- **`DeviceAction` is what a row's menu asks for,** kept by the page, which opens the matching dialog.
- **`DeviceStatusPill`** (decisions 12 and 32):
  - **Revoked first:** a revoked device is never "late".
  - **An active device 24 hours after its last sync gets the `warn` pill in Active's place,** with the whole days.
    It is the one status a person must act on (find the device, or revoke it), so it does not sit beside a green
    Active that says the opposite.
  - **A device that never synced stays Active:** it was set up and its first pull has not ended; it has nothing to be
    late with. The "Last synced" column says "Never synced".
  - **Each pill has its icon** (CLAUDE.md → status colours): `CheckmarkCircle02`, `Time04` like the "Late" pills of
    the orders, `ComputerRemove`.
- **`DeviceMenu`** (decision 33): Rename and Revoke for every active row the person sees (the API checks again whose
  it is); Change branch only when the page says this row is this device and its copy is open. Revoked rows get no
  menu. The icon button's label names the device ("Actions for Counter 1"), since every row has the same button.
- **`useDeviceColumns()`** builds the columns of both lists:
  - **The device column** follows CLAUDE.md → Table: a 30px `brand-soft` tile, the name and an `ink-3` sub-line. The
    tile is an icon, not initials: a device's name is often a browser's ("Chrome on Windows").
  - **"This device"** is a `brand` pill beside the name: the row where Change branch shows, and where Revoke signs
    you out.
  - **The sub-line of a revoked device says who and when,** the first question about a phone that stopped working. A
    device revoked by hand before this step has no revoker (decision 14): then only the time.
  - **`withPerson`** adds the person column for the workspace's list. On a phone it is the card's subtitle, under the
    device's name.
  - **`sortable`:** the workspace's list sorts on the server by the name and the last sync (decision 8); your own
    list keeps the server's order, active first.
  - **The actions column has a header for screen readers only:** a column of buttons with no name reads as an empty
    cell. On a phone it is the card's trailing slot, top right.
  - **The dependency list is complete,** so the columns are rebuilt when the clock ticks or the language changes, and
    only then: the data table keeps its rows' state between renders.

### `components/device-dialogs.tsx` (new): Rename, Change branch, Revoke

```tsx
import { zodResolver } from '@hookform/resolvers/zod';
import { ComputerPhoneSyncIcon, Store01Icon } from '@hugeicons/core-free-icons';
import {
  contractErrorMap,
  type DeviceListItem,
  moveDeviceInputSchema,
  renameDeviceInputSchema,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  FormAlert,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { useStore } from 'zustand';

import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { localDataStore } from '../lib/local-data';
import { branchesQuery } from '../lib/queries';
import { useSyncSummary } from '../lib/sync-summary';
import { useOnline } from '../lib/use-online';
import type { DeviceAction } from './device-parts';
import { DocumentNotice } from './document-notice';
import { useTenantId } from '../lib/workspace';

// Step 18c: the three actions of a device row, each its own dialog content inside one Dialog.

// After a rename, a move or a revoke: both lists (queries.ts: ['devices', tenantId])
export function useDevicesRefresh(): () => Promise<void> {
  const queryClient = useQueryClient();
  const tenantId = useTenantId();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['devices', tenantId] }),
    [queryClient, tenantId],
  );
}

const RENAME_FIELDS = renameDeviceInputSchema.keyof().options;
const MOVE_FIELDS = moveDeviceInputSchema.keyof().options;

function RenameForm({ device, onDone }: { device: DeviceListItem; onDone: () => void }) {
  const { t } = useLocale();
  const refresh = useDevicesRefresh();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(renameDeviceInputSchema, { error: contractErrorMap }),
    // The version the person saw (decision 9): two people renaming the same device, the second is
    // told (version_conflict, at the top of the form)
    defaultValues: { name: device.name, version: device.version },
  });

  const onSubmit = handleSubmit(async (body) => {
    try {
      const saved = await call(routes.devices.rename, { params: { id: device.id }, body });
      await refresh();
      toast(t('devices.renamed', { name: saved.name }));
      onDone();
    } catch (error) {
      applyApiError(error, RENAME_FIELDS, setError);
    }
  });

  return (
    <DialogContent
      title={t('devices.renameTitle', { name: device.name })}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="rename-device-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('devices.saveName')}
          </Button>
        </>
      }
    >
      <form
        id="rename-device-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <TextField
          label={t('devices.name')}
          icon={ComputerPhoneSyncIcon}
          hint={t('devices.nameHint')}
          autoComplete="off"
          {...register('name')}
          error={errors.name?.message}
        />
      </form>
    </DialogContent>
  );
}

// Change branch, on this device only (decision 2). Online, and with nothing in the outbox: the
// dialog says why not instead of a form that would fail, and points to the Sync page, where the
// waiting changes are sent or discarded. The count is live (the sidebar's), so the form comes as
// soon as the last change is sent.
function MoveForm({ device, onDone }: { device: DeviceListItem; onDone: () => void }) {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const online = useOnline();
  const { waiting } = useSyncSummary();
  const moveHere = useStore(localDataStore, (state) => state.moveHere);
  const refresh = useDevicesRefresh();
  const branches = useQuery(branchesQuery(tenantId, 'active')).data ?? [];
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(moveDeviceInputSchema, { error: contractErrorMap }),
    // No branch chosen for the person, like the first branch dialog (18a)
    defaultValues: { branchId: '', version: device.version },
  });
  const ready = online && waiting === 0;

  const onSubmit = handleSubmit(async (body) => {
    try {
      const moved = await moveHere(body);
      // Something was saved since the dialog opened: the count above turns the form into the
      // "sync first" line by itself
      if (moved === 'waiting') return;
      await refresh();
      toast(t('devices.moved', { branch: moved.branchName }));
      onDone();
    } catch (error) {
      applyApiError(error, MOVE_FIELDS, setError);
    }
  });

  return (
    <DialogContent
      title={t('devices.changeBranchTitle')}
      description={t('devices.changeBranchBody', { branch: device.branchName })}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="move-device-form" disabled={!ready || isSubmitting}>
            {isSubmitting ? t('common.saving') : t('devices.changeBranchConfirm')}
          </Button>
        </>
      }
    >
      {!online ? (
        <DocumentNotice tone="neutral">{t('devices.changeBranchOffline')}</DocumentNotice>
      ) : waiting > 0 ? (
        <DocumentNotice tone="neutral">
          {t('devices.changeBranchSyncFirst', {
            count: waiting,
            formatted: format.number(waiting),
          })}{' '}
          <Link
            to="/sync"
            className="font-medium text-brand underline-offset-3 hover:underline"
            onClick={onDone}
          >
            {t('nav.sync')}
          </Link>
        </DocumentNotice>
      ) : (
        <form
          id="move-device-form"
          noValidate
          onSubmit={(event) => void onSubmit(event)}
          className="grid gap-5"
        >
          {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
          <SelectField
            label={t('devices.newBranch')}
            icon={Store01Icon}
            options={[
              { value: '', label: t('devices.branchPlaceholder') },
              // Its own branch is not a choice: moving there changes nothing
              ...branches
                .filter((branch) => branch.id !== device.branchId)
                .map((branch) => ({ value: branch.id, label: `${branch.code} · ${branch.name}` })),
            ]}
            {...register('branchId')}
            error={errors.branchId?.message}
          />
        </form>
      )}
    </DialogContent>
  );
}

// Revoke (decisions 3 and 4). Two texts: a device somewhere else stops at once and loses its copy
// the next time it opens; this device signs you out here, and says how many changes are lost. Both
// say it is final. No version (decision 9).
function RevokeContent({
  device,
  here,
  onDone,
}: {
  device: DeviceListItem;
  here: boolean;
  onDone: () => void;
}) {
  const { t, format, errorText } = useLocale();
  const { waiting } = useSyncSummary();
  const revokedHere = useStore(localDataStore, (state) => state.revokedHere);
  const refresh = useDevicesRefresh();
  const revoke = useMutation({
    mutationFn: () => call(routes.devices.revoke, { params: { id: device.id } }),
    onSuccess: async (saved) => {
      // This device: the copy goes, then the sign-out (local-session.ts); the page goes with it
      if (here) {
        await revokedHere();
        return;
      }
      await refresh();
      toast(t('devices.revoked', { name: saved.name }));
      onDone();
    },
  });
  const failure = revoke.error
    ? revoke.error instanceof ApiRequestError
      ? revoke.error.code
      : 'unknown_error'
    : null;

  return (
    <DialogContent
      title={t('devices.revokeTitle', { name: device.name })}
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
            {t('devices.revokeConfirm')}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 text-body-sm text-ink-2">
        {failure !== null && <p className="text-crit">{errorText(failure)}</p>}
        <p>
          {here ? t('devices.revokeHereBody') : t('devices.revokeBody')}
          {here &&
            waiting > 0 &&
            ` ${t('devices.revokeHereWaiting', {
              count: waiting,
              formatted: format.number(waiting),
            })}`}
        </p>
        <p>{t('devices.revokeFinal')}</p>
      </div>
    </DialogContent>
  );
}

// The page keeps what the menu asked for; null = no dialog. `key` per device and action: a new
// action opens a new form, never the last one's values.
export function DeviceDialogs({
  acting,
  thisDeviceId,
  onClose,
}: {
  acting: DeviceAction | null;
  thisDeviceId: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={acting !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {acting?.kind === 'rename' && (
        <RenameForm key={`rename-${acting.device.id}`} device={acting.device} onDone={onClose} />
      )}
      {acting?.kind === 'move' && (
        <MoveForm key={`move-${acting.device.id}`} device={acting.device} onDone={onClose} />
      )}
      {acting?.kind === 'revoke' && (
        <RevokeContent
          key={`revoke-${acting.device.id}`}
          device={acting.device}
          here={acting.device.id === thisDeviceId}
          onDone={onClose}
        />
      )}
    </Dialog>
  );
}
```

- **This file imports nothing from `device-parts.tsx` but a type.** It is loaded lazily, and a value import from
  there would bring the data table and the dropdown menu into the dialogs' chunk (it did: 122 KB gz). That is why
  `useDevicesRefresh` lives here, its only user.
- **`RenameForm`** uses the contract's own schema with `contractErrorMap`, like every form. The version is the one the
  list showed (decision 9): a second person renaming the same device gets `version_conflict` at the top of the form.
  A revoked device answers `device_revoked` the same way.
- **`MoveForm`** (decision 2):
  - **The dialog opens even when the move cannot happen,** and says why: offline, or changes waiting, with a link to
    the Sync page (the link closes the dialog first). The confirm button is disabled then.
  - **The waiting count is the sidebar's live count,** so the form appears as soon as the last change is sent, while
    the dialog stays open.
  - **The select starts empty** ("Pick a branch"), like 18a's branch dialog, and leaves out the device's own branch:
    moving there would change nothing.
  - **`'waiting'` from `moveHere` shows nothing:** the count above has already turned the form into the "Sync first"
    line.
  - **Errors go through `applyApiError`:** `device_branch_invalid` (an archived branch) under the select,
    `version_conflict` at the top.
- **`RevokeContent`** (decisions 3 and 4):
  - **Two texts.** Another device: it stops at once, and its copy goes the next time it opens. This device: you are
    signed out here, and the dialog adds how many changes on it are lost, from the same live count. Both end with
    `revokeFinal`: there is no Restore.
  - **No version** (decision 9): the mutation sends only the id.
  - **This device: `revokedHere()` runs the session's revoke,** which deletes the copy and signs out; the dialog and
    the page go with the sign-out, so nothing is refreshed or closed here.
  - **Another device: both lists are refreshed, then the toast,** then the dialog closes.
  - **An error shows as the error's text** at the top of the dialog, like the archive errors of the branches page.
- **`DeviceDialogs` keys each content by its action and device,** so opening another device's dialog starts a new
  form, never with the last one's values.

### The two pages, and their routes

```tsx
import { ComputerPhoneSyncIcon, WifiDisconnected02Icon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { Button, DataTable, EmptyState, PageHeader } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';

import { type DeviceAction, useDeviceColumns } from '../components/device-parts';
import { useTenantId } from '../lib/workspace';
import { askForBranch, useDeviceState, useThisDeviceId } from '../lib/local-data';
import { myDevicesQuery } from '../lib/queries';
import { useNow } from '../lib/sync-summary';
import { useOnline } from '../lib/use-online';

// Loaded when a row's menu asks for one: the three forms bring react-hook-form and the dialog,
// which took both pages over their budget, for dialogs most visits never open
const DeviceDialogs = lazy(async () => ({
  default: (await import('../components/device-dialogs')).DeviceDialogs,
}));

// Step 18c (decision 1): the signed-in person's own devices in this workspace, from the account
// menu. Everyone has it, with no permission: renaming and revoking your own device is yours. One
// answer, not pages: a person has a few devices.
export function MyDevicesPage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const online = useOnline();
  const device = useDeviceState();
  const thisDeviceId = useThisDeviceId();
  const now = useNow();
  const [acting, setActing] = useState<DeviceAction | null>(null);
  const { data, isError } = useQuery({ ...myDevicesQuery(tenantId), enabled: online });
  const columns = useDeviceColumns({
    withPerson: false,
    sortable: false,
    thisDeviceId,
    canMoveHere: device.kind === 'ready',
    now,
    onAction: setActing,
  });

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <PageHeader title={t('devices.mineTitle')} description={t('devices.mineDescription')} />
      {/* The list is the server's: offline it says so instead of an old answer or an error */}
      {!online ? (
        <EmptyState
          icon={WifiDisconnected02Icon}
          title={t('sync.needsConnectionTitle')}
          description={t('devices.needsConnection')}
        />
      ) : isError ? (
        <p className="text-body-sm text-crit">{t('devices.loadFailed')}</p>
      ) : (
        data && (
          <DataTable
            label={t('devices.mineTitle')}
            data={data}
            columns={columns}
            getRowId={(item) => item.id}
            // Empty only before this browser was set up ("Not now" in 18a's branch dialog): the
            // button opens that dialog again
            empty={
              <EmptyState
                icon={ComputerPhoneSyncIcon}
                title={t('devices.mineEmptyTitle')}
                description={t('devices.mineEmptyBody')}
                action={
                  device.kind === 'not-set-up' && (
                    <Button onClick={askForBranch}>{t('sync.setUp')}</Button>
                  )
                }
              />
            }
          />
        )
      )}
      {acting && (
        <Suspense fallback={null}>
          <DeviceDialogs
            acting={acting}
            thisDeviceId={thisDeviceId}
            onClose={() => {
              setActing(null);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
```

- **`DeviceDialogs` is lazy and rendered only while an action is chosen** (decision 34). A `Suspense` with no
  fallback: the menu closes, and the dialog appears a moment later, as 18b's sign-out dialog does.
- **No permission:** your own devices are yours (decision 1). The API answers only the person's own devices in this
  workspace.
- **The query runs only online.** Offline the page shows "Needs a connection" instead of an old answer or a network
  error, like the sales orders list.
- **The empty list happens only before this browser was set up** (someone chose "Not now" in the branch dialog):
  the button opens that dialog again, and shows only while the device is in that state.

```tsx
import {
  ComputerPhoneSyncIcon,
  ComputerRemoveIcon,
  Search01Icon,
  WifiDisconnected02Icon,
} from '@hugeicons/core-free-icons';
import { DEVICE_STATUSES, type DeviceSort, type DeviceStatus } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  DataTable,
  EmptyState,
  Input,
  PageHeader,
  SegmentedControl,
  Select,
  type SortingState,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useMemo, useState } from 'react';

import { type DeviceAction, useDeviceColumns } from '../components/device-parts';
import { useTenantId } from '../lib/workspace';
import { useDeviceState, useThisDeviceId } from '../lib/local-data';
import { useCan } from '../lib/permissions';
import { branchesQuery, deviceListQuery } from '../lib/queries';
import { useNow } from '../lib/sync-summary';
import { useDebounced } from '../lib/use-debounced';
import { useOnline } from '../lib/use-online';

// Loaded when a row's menu asks for one: the three forms bring react-hook-form and the dialog,
// which took both pages over their budget, for dialogs most visits never open
const DeviceDialogs = lazy(async () => ({
  default: (await import('../components/device-dialogs')).DeviceDialogs,
}));

// Step 18c (decision 1): every device of the workspace, for the people with core.device.manage.
// Paged and sorted on the server (decision 8), like the other long lists: a search by the device's
// or the person's name, a branch, and the Active and Revoked tabs.

// Two columns sort: the device's name, and the last sync ('lastSync' = the oldest first, the
// devices that never synced before them; the order of an owner looking for the ones behind)
function sortOf(state: SortingState): DeviceSort {
  const [first] = state;
  if (first?.id === 'lastSyncAt') return first.desc ? '-lastSync' : 'lastSync';
  return first?.desc ? '-name' : 'name';
}

export function DevicesPage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const online = useOnline();
  const canManage = useCan()('core.device.manage');
  const device = useDeviceState();
  const thisDeviceId = useThisDeviceId();
  const now = useNow();
  const [search, setSearch] = useState('');
  const [branchId, setBranchId] = useState('');
  const [status, setStatus] = useState<DeviceStatus>('active');
  const [sorting, setSorting] = useState<SortingState>([{ id: 'name', desc: false }]);
  const [acting, setActing] = useState<DeviceAction | null>(null);
  const settled = useDebounced(search.trim());
  const filter = { search: settled, branchId, status, sort: sortOf(sorting) };
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    ...deviceListQuery(tenantId, filter),
    // Without the permission the API answers 403: the page says why instead of asking
    enabled: canManage && online,
  });
  const branches = useQuery({ ...branchesQuery(tenantId, 'active'), enabled: canManage }).data;
  const devices = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const columns = useDeviceColumns({
    withPerson: true,
    sortable: true,
    thisDeviceId,
    canMoveHere: device.kind === 'ready',
    now,
    onAction: setActing,
  });

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const empty =
    settled !== '' ? (
      <EmptyState
        icon={Search01Icon}
        title={t('devices.noMatchTitle', { query: settled })}
        description={t('devices.noMatchBody')}
      />
    ) : status === 'revoked' ? (
      <EmptyState
        icon={ComputerRemoveIcon}
        title={t('devices.emptyRevokedTitle')}
        description={t('devices.emptyRevokedBody')}
      />
    ) : (
      <EmptyState
        icon={ComputerPhoneSyncIcon}
        title={t('devices.emptyTitle')}
        description={t('devices.emptyBody')}
      />
    );

  if (!canManage) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <PageHeader title={t('devices.title')} description={t('devices.description')} />
        <p className="text-body-sm text-ink-3">{t('devices.readOnly')}</p>
      </div>
    );
  }

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader title={t('devices.title')} description={t('devices.description')} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <Input
            type="search"
            icon={Search01Icon}
            aria-label={t('devices.searchLabel')}
            placeholder={t('devices.searchPlaceholder')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
        <div className="min-w-0 basis-56">
          <Select
            aria-label={t('devices.columns.branch')}
            options={[
              { value: '', label: t('devices.allBranches') },
              ...(branches ?? []).map((branch) => ({ value: branch.id, label: branch.name })),
            ]}
            value={branchId}
            onChange={(event) => {
              setBranchId(event.target.value);
            }}
          />
        </div>
        <SegmentedControl
          label={t('devices.show')}
          value={status}
          options={DEVICE_STATUSES.map((value) => ({
            value,
            label: t(`devices.statuses.${value}`),
          }))}
          onChange={setStatus}
        />
      </div>
      {!online ? (
        <EmptyState
          icon={WifiDisconnected02Icon}
          title={t('sync.needsConnectionTitle')}
          description={t('devices.needsConnection')}
        />
      ) : isError ? (
        <p className="text-body-sm text-crit">{t('devices.loadFailed')}</p>
      ) : (
        devices && (
          <DataTable
            label={t('devices.title')}
            data={devices}
            columns={columns}
            getRowId={(item) => item.id}
            sorting={{ state: sorting, onChange: setSorting }}
            onEndReached={loadMore}
            maxHeight={640}
            empty={empty}
            footer={
              isFetchingNextPage && (
                <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
              )
            }
          />
        )
      )}
      {acting && (
        <Suspense fallback={null}>
          <DeviceDialogs
            acting={acting}
            thisDeviceId={thisDeviceId}
            onClose={() => {
              setActing(null);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
```

- **`sortOf()` turns the table's sort into the API's.** Two columns sort; `lastSyncAt` ascending is `lastSync`, the
  oldest first with the devices that never synced before them (decision 8).
- **Without `core.device.manage` the page says so and asks nothing.** The sidebar hides the link (below), but a
  bookmark or a typed address still reaches the page; the query is disabled rather than sent for a 403.
- **The search waits for typing to stop** (`useDebounced`, like the other lists) and finds the device's name or the
  person's (decision 8).
- **The branch select lists the active branches.** Archived branches have no active devices (decision 11), and the
  Revoked tab with every branch finds the rest.
- **Three empty states,** in the order a person reads them: no match for the search, nothing revoked yet, no device
  at all.

```diff
@@ -648,6 +648,20 @@ const syncRoute = createRoute({
   component: lazyRouteComponent(() => import('./routes/sync'), 'SyncPage'),
 });
 
+// Step 18c: your own devices (the account menu) and every device of the workspace (the sidebar,
+// with core.device.manage)
+const myDevicesRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/my-devices',
+  component: lazyRouteComponent(() => import('./routes/my-devices'), 'MyDevicesPage'),
+});
+
+const devicesRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/devices',
+  component: lazyRouteComponent(() => import('./routes/devices'), 'DevicesPage'),
+});
+
 // Step 17b: purchase orders ("Make purchase order" on a requisition comes with ?requisitionId=) and
 // goods receipts ("Receive goods" on an order comes with ?orderId=). '/…/new' beats '/…/$id'.
 const purchaseOrdersRoute = createRoute({
@@ -949,6 +963,8 @@ const routeTree = rootRoute.addChildren([
     requisitionRoute,
     approvalsRoute,
     syncRoute,
+    myDevicesRoute,
+    devicesRoute,
     purchaseOrdersRoute,
     newPurchaseOrderRoute,
     purchaseOrderRoute,
```

- **Two routes under the app shell,** each its own lazy chunk like every page. `/my-devices`, not `/me/devices`: the
  API's path is not the app's, and `/my-…` reads as a page of the person.

### The shell: the two ways in, and the sync line

```diff
@@ -7,6 +7,7 @@ import {
   ChartIncreaseIcon,
   CheckmarkBadge01Icon,
   Coins01Icon,
+  ComputerPhoneSyncIcon,
   DashboardSquare01Icon,
   DeliveryReturn01Icon,
   DeliveryTruck01Icon,
@@ -88,7 +89,7 @@ import { logout, switchTenant } from '../lib/session';
 import { useCan } from '../lib/permissions';
 import { waitingCountQuery } from '../lib/queries';
 import { useSession } from '../lib/session-store';
-import { useSyncSummary } from '../lib/sync-summary';
+import { useSyncAge, useSyncSummary } from '../lib/sync-summary';
 import { isTheme } from '../lib/theme';
 import { useOnline } from '../lib/use-online';
 
@@ -207,10 +208,17 @@ function WorkspaceSwitcher() {
 // Step 18b (decision 1): the sidebar line. It says whether the device is online, and how many
 // changes wait (a refused one first, in crit, since the person must act on it). It links to the
 // Sync page. The screen reader hears the whole sentence, not "Offline 3".
+// Step 18c (decision 12): 24 hours after the last sync, the line says how long ago it was, in warn,
+// in place of Online or Offline (the icon still says which). "Syncing…" wins: it is the answer.
 function SyncNavItem() {
   const { t, format } = useLocale();
   const online = useOnline();
   const { syncing, waiting: total, failed } = useSyncSummary();
+  const age = useSyncAge();
+  const stale =
+    !syncing && age !== null && age.age !== 'fresh'
+      ? t('sync.lastSyncedDays', { count: age.days, formatted: format.number(age.days) })
+      : null;
   const state = !online ? t('sync.offline') : syncing ? t('sync.syncing') : t('sync.online');
   const count = failed > 0 ? failed : total;
   const counted =
@@ -225,9 +233,9 @@ function SyncNavItem() {
       icon={online ? Wifi01Icon : WifiDisconnected02Icon}
       count={count > 0 ? count : undefined}
       countTone={failed > 0 ? 'crit' : 'neutral'}
-      aria-label={`${t('nav.sync')}: ${state}, ${counted}`}
+      aria-label={`${t('nav.sync')}: ${stale === null ? state : `${state}, ${stale}`}, ${counted}`}
     >
-      {state}
+      {stale === null ? state : <span className="text-warn">{stale}</span>}
     </NavLink>
   );
 }
@@ -235,9 +243,19 @@ function SyncNavItem() {
 // ডেস্কটপের সাইডবার-তলা আর ফোনের টপ বার — দুই trigger, একই মেনু
 function UserMenuContent({ align, onSignOut }: { align: 'start' | 'end'; onSignOut: () => void }) {
   const { t, language } = useLocale();
+  const navigate = useNavigate();
   const theme = useSession((state) => state.me?.preferences.theme ?? 'system');
   return (
     <DropdownMenuContent align={align}>
+      {/* Step 18c (decision 22): what is about the person themself is in this menu; the app has
+          no profile page */}
+      <DropdownMenuItem
+        icon={ComputerPhoneSyncIcon}
+        onSelect={() => void navigate({ to: '/my-devices' })}
+      >
+        {t('shell.myDevices')}
+      </DropdownMenuItem>
+      <DropdownMenuSeparator />
       <DropdownMenuLabel>{t('common.language')}</DropdownMenuLabel>
       <DropdownMenuRadioGroup
         value={language}
@@ -530,6 +548,13 @@ export function AppShell() {
             <NavLink to="/branches" icon={Store01Icon}>
               {t('nav.branches')}
             </NavLink>
+            {/* Step 18c (decision 22): after the branches the devices are in, for the people who
+                may see them all */}
+            {can('core.device.manage') && (
+              <NavLink to="/devices" icon={ComputerPhoneSyncIcon}>
+                {t('nav.devices')}
+              </NavLink>
+            )}
             {can('core.settings.manage') && (
               <NavLink to="/numbering" icon={LeftToRightListNumberIcon}>
                 {t('nav.numbering')}
```

- **"My devices" is the first item of the account menu** (decision 22), above the language and the theme, on the
  desktop and the phone: the one item of the menu that opens a page.
- **"Devices" comes after Branches, only with `core.device.manage`,** like the other workspace pages that need a
  permission. It shares the `ComputerPhoneSync` icon with the account menu's item and the lists' tiles.
- **The sync line, after 24 hours** (decision 12): "Last synced 2 days ago" in `warn` takes the place of "Online" or
  "Offline", and the icon still says which. "Syncing…" wins: while a sync runs, that is the news. The screen reader
  hears both ("Sync: Offline, Last synced 2 days ago, 3 changes waiting"), so nothing is lost when the text changes.
- **The text colour is a `span` inside the item,** not a new prop of `NavItem`: the ui package stays as it is (18c.5),
  and the item's own colours (hover, active page) still apply around it.

### The sign-in page and the Sync page

```diff
@@ -19,9 +19,11 @@ import { useState } from 'react';
 import { Controller, useForm } from 'react-hook-form';
 
 import { AuthPreview } from '../components/auth-preview';
+import { DocumentNotice } from '../components/document-notice';
 import { LanguageSwitch } from '../components/language-switch';
 import { applyApiError } from '../lib/field-errors';
 import { login } from '../lib/session';
+import { useSession } from '../lib/session-store';
 
 // key-টা অনুবাদের, লেখা না — ভাষা বদলালে সাথে সাথে বদলায়
 const INDUSTRIES = [
@@ -35,6 +37,8 @@ export function LoginPage() {
   const { t } = useLocale();
   const navigate = useNavigate();
   const [showPassword, setShowPassword] = useState(false);
+  // Step 18c: why this page shows, when the app signed the person out (a revoked device)
+  const notice = useSession((state) => state.notice);
   // zodResolver: API যে schema দিয়ে যাচাই করে, ফর্মও ঠিক সেটা দিয়ে — একই নিয়ম, একই code।
   // contractErrorMap: schema যেখানে নিজে code দেয়নি সেখানে Zod-এর ইংরেজি মেসেজের বদলে code
   const {
@@ -73,6 +77,11 @@ export function LoginPage() {
               onSubmit={(event) => void onSubmit(event)}
               className="mt-8 grid gap-[18px]"
             >
+              {/* Step 18c: not an error of the form, so the neutral notice, not FormAlert. It stays
+                  until the next sign-in, which clears it (session-store.ts). */}
+              {notice === 'device_revoked' && (
+                <DocumentNotice tone="neutral">{t('devices.revokedSignedOut')}</DocumentNotice>
+              )}
               {/* message-এ code; FormAlert আর TextField নিজেরাই বর্তমান ভাষায় লেখে */}
               {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
               <TextField
```

- **The notice is the neutral document notice,** not the form's error box: nothing in the form is wrong. It sits
  where the form's errors go, so it is the first thing read, and it stays until the next sign-in clears it.
- **It imports `document-notice.tsx`, not `sales-parts.tsx`** (decision 34): the sign-in page is the first page many
  people load.

```diff
@@ -4,6 +4,7 @@ import {
   CloudSavingDone01Icon,
 } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
+import { SYNC_BLOCK_AFTER_DAYS } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
 import {
   dependentsOf,
@@ -31,6 +32,7 @@ import { useQueryClient } from '@tanstack/react-query';
 import { Link } from '@tanstack/react-router';
 import { useState } from 'react';
 
+import { DocumentNotice } from '../components/document-notice';
 import { LocalState } from '../components/local-state';
 import { useTenantId, useTimeZone } from '../components/stock-parts';
 import { OutboxStatusPill, useCommandText, useFieldList } from '../components/sync-parts';
@@ -41,6 +43,7 @@ import {
   useLocalQuery,
   useSyncStatus,
 } from '../lib/local-data';
+import { useSyncAge } from '../lib/sync-summary';
 import { useOnline } from '../lib/use-online';
 
 // Step 18b (decision 1): the work saved on this device, oldest first, as the push sends it; what
@@ -87,6 +90,8 @@ export function SyncPage() {
   const entries = useLocalQuery(db ? outboxEntries : null);
   const notices = useLocalQuery(db ? syncNotices : null);
   const pull = useLocalQuery(readPullState);
+  // Step 18c (decision 12): the limits, on this device's clock
+  const age = useSyncAge();
   const commandText = useCommandText();
   const fieldList = useFieldList();
   const [discarding, setDiscarding] = useState<OutboxEntry | null>(null);
@@ -133,9 +138,19 @@ export function SyncPage() {
       <p className="text-body-sm text-ink-2 tabular-nums">
         {lastSync === null
           ? t('sync.neverSynced')
-          : t('sync.lastSynced', { time: format.dateTime(new Date(lastSync), timeZone) })}
+          : age !== null && age.age !== 'fresh'
+            ? t('sync.lastSyncedDays', { count: age.days, formatted: format.number(age.days) })
+            : t('sync.lastSynced', { time: format.dateTime(new Date(lastSync), timeZone) })}
         {!online && ` · ${t('sync.syncNowOffline')}`}
       </p>
+      {/* Step 18c: after 24 hours what may be out of date; after 7 days what stops. The waiting
+          changes are not blocked, so the page says they still go. */}
+      {age?.age === 'warn' && <DocumentNotice tone="warn">{t('sync.staleNotice')}</DocumentNotice>}
+      {age?.age === 'blocked' && (
+        <DocumentNotice tone="warn">
+          {t('sync.blockedNotice', { days: format.number(SYNC_BLOCK_AFTER_DAYS) })}
+        </DocumentNotice>
+      )}
 
       {!db && view.kind !== 'ready' && <LocalState view={view} />}
 
```

- **The "Last synced" line says how long ago after 24 hours,** in place of the date and time: "2 days ago" is the
  news, and the date is one look at a calendar away.
- **Two `warn` notices under it:** after 24 hours what may be out of date (prices, stock, credit limits), after 7
  days what stops. The second also says that the changes already waiting still go: only new work stops
  (decision 31). The number of days is `SYNC_BLOCK_AFTER_DAYS` in the page's digits, so the text follows the
  constant.

### The two offline forms

```diff
@@ -15,6 +15,7 @@ import {
   MAX_CUSTOMER_ADDRESSES,
   MAX_PAYMENT_TERMS_DAYS,
   routes,
+  SYNC_BLOCK_AFTER_DAYS,
   type SyncCommandError,
   type SyncCustomerGroup,
   type SyncPriceList,
@@ -47,6 +48,7 @@ import type { z } from 'zod';
 import { applyApiError, applyCommandError } from '../lib/field-errors';
 import { call } from '../lib/api';
 import { requestSync, type SaveMode, useLocalDb } from '../lib/local-data';
+import { useSyncAge } from '../lib/sync-summary';
 import { rowPath } from '../lib/products';
 import { customerQuery } from '../lib/queries';
 import { useSession } from '../lib/session-store';
@@ -169,13 +171,17 @@ export function CustomerForm({
   // The error of the customer's refused command, shown under its boxes until the next save
   failed: SyncCommandError | null;
 }) {
-  const { t, errorText } = useLocale();
+  const { t, format, errorText } = useLocale();
   const navigate = useNavigate();
   const queryClient = useQueryClient();
   const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
   const online = useOnline();
   const db = useLocalDb();
   const onDevice = mode === 'device';
+  // Step 18c (decision 12): 7 days after the last sync the device saves no new work. The form
+  // still opens (the person sees what they wanted to change), with no button to save it.
+  const age = useSyncAge();
+  const blocked = onDevice && age?.age === 'blocked';
   const {
     register,
     control,
@@ -222,7 +228,8 @@ export function CustomerForm({
 
   const onSubmit = handleSubmit(async ({ version, ...values }) => {
     if (onDevice) {
-      if (!db) return;
+      // Enter in a box submits the form even with no submit button
+      if (!db || blocked) return;
       try {
         await saveCustomer(db, {
           base: customer,
@@ -289,11 +296,16 @@ export function CustomerForm({
         description={customer?.name}
       />
       {!canManage && <p className="text-body-sm text-ink-3">{t('customers.readOnly')}</p>}
-      {canManage && onDevice && (
+      {canManage && onDevice && !blocked && (
         <DocumentNotice tone="neutral">
           {online ? t('sync.waitingNotice') : t('sync.offlineNotice')}
         </DocumentNotice>
       )}
+      {canManage && blocked && (
+        <DocumentNotice tone="warn">
+          {t('sync.blockedFormNotice', { days: format.number(SYNC_BLOCK_AFTER_DAYS) })}
+        </DocumentNotice>
+      )}
       <form noValidate onSubmit={(event) => void onSubmit(event)}>
         {/* Without the permission the same page reads, every control disabled at once */}
         <fieldset disabled={!canManage} className="grid min-w-0 grid-cols-1 gap-5">
@@ -528,15 +540,17 @@ export function CustomerForm({
               >
                 {t('common.cancel')}
               </Button>
-              <Button type="submit" disabled={isSubmitting}>
-                {isSubmitting
-                  ? t('common.saving')
-                  : onDevice
-                    ? t('sync.saveOnDevice')
-                    : customer
-                      ? t('customers.save')
-                      : t('customers.create')}
-              </Button>
+              {!blocked && (
+                <Button type="submit" disabled={isSubmitting}>
+                  {isSubmitting
+                    ? t('common.saving')
+                    : onDevice
+                      ? t('sync.saveOnDevice')
+                      : customer
+                        ? t('customers.save')
+                        : t('customers.create')}
+                </Button>
+              )}
             </div>
           )}
         </fieldset>
```

- **`blocked` is `onDevice` and seven days** (decision 31): an online save through the API is never blocked.
- **The `warn` notice takes the place of the neutral one,** which would say "saved on this device" for a form that
  cannot save. Only for people who may change customers, like the neutral one.
- **The save button is not drawn,** and Cancel stays. Disabling the whole `fieldset` was not an option: it holds
  Cancel too.
- **`onSubmit` returns early when blocked:** Enter in a text box submits a form even with no submit button.

```diff
@@ -9,6 +9,7 @@ import {
   type SalesOrder,
   type SalesOrderDraftInput,
   type SalesOrderFormValues,
+  SYNC_BLOCK_AFTER_DAYS,
   type SyncCommandError,
   updateSalesOrderInputSchema,
 } from '@omnivo/contracts';
@@ -33,6 +34,7 @@ import { Controller, type Path, useForm, useWatch } from 'react-hook-form';
 import { call } from '../lib/api';
 import { applyApiError, applyCommandError } from '../lib/field-errors';
 import { requestSync, useLocalDb, useSaveMode } from '../lib/local-data';
+import { useSyncAge } from '../lib/sync-summary';
 import { rowPath } from '../lib/products';
 import { formTotals, type LineMeta, SALES_LINE_FIELDS, savedLines } from '../lib/sales';
 import { useCan } from '../lib/permissions';
@@ -116,7 +118,7 @@ export function SalesOrderForm({
   // workspace's now
   pricesIncludeVat: boolean;
 }) {
-  const { t } = useLocale();
+  const { t, format } = useLocale();
   const navigate = useNavigate();
   const tenantId = useTenantId();
   const queryClient = useQueryClient();
@@ -182,6 +184,10 @@ export function SalesOrderForm({
     order === null &&
     quotation === null &&
     (draft !== null || !online || customerMode === 'device');
+  // Step 18c (decision 12): 7 days after the last sync, no new draft on the device. A refused draft
+  // opened from the Sync page is blocked too: saving it again is new work on the device.
+  const age = useSyncAge();
+  const blocked = onDevice && age?.age === 'blocked';
   const rates = useQuery(taxRatesQuery(tenantId)).data;
 
   // Once, when the form opens a refused draft: its errors where the person fixes them
@@ -254,7 +260,8 @@ export function SalesOrderForm({
   // Into the outbox (decision 15): a draft only, so no confirm and no credit check. The name and
   // the total are kept with it for the Sync page and the unsynced orders.
   const saveOnDevice = handleSubmit(async (values) => {
-    if (!db) return;
+    // Enter in a box submits the form even with no submit button
+    if (!db || blocked) return;
     const input: SalesOrderDraftInput = {
       customerId: values.customerId,
       date: values.date,
@@ -325,11 +332,16 @@ export function SalesOrderForm({
         onSubmit={(event) => void (onDevice ? saveOnDevice(event) : save(false)(event))}
         className="grid grid-cols-1 gap-5"
       >
-        {onDevice && (
+        {onDevice && !blocked && (
           <DocumentNotice tone="neutral">
             {online ? t('sync.waitingNotice') : t('sync.orderOfflineNotice')}
           </DocumentNotice>
         )}
+        {blocked && (
+          <DocumentNotice tone="warn">
+            {t('sync.blockedFormNotice', { days: format.number(SYNC_BLOCK_AFTER_DAYS) })}
+          </DocumentNotice>
+        )}
         {failure && <FormAlert message={failure} />}
         {keptNumber !== null && (
           <p className="text-body-sm text-ink-2">
@@ -437,11 +449,13 @@ export function SalesOrderForm({
         />
 
         {onDevice ? (
-          <div className="flex flex-wrap items-center justify-end gap-2">
-            <Button type="submit" disabled={isSubmitting}>
-              {t('sync.saveOnDevice')}
-            </Button>
-          </div>
+          !blocked && (
+            <div className="flex flex-wrap items-center justify-end gap-2">
+              <Button type="submit" disabled={isSubmitting}>
+                {t('sync.saveOnDevice')}
+              </Button>
+            </div>
+          )
         ) : (
           <div className="flex flex-wrap items-center justify-end gap-2">
             {/* A reopened draft keeps its number and cannot be deleted (it says so above) */}
```

- **The same three changes on the order form.** Its device mode has only the one button, so the whole button row
  goes. A refused draft opened from the Sync page is blocked too: saving it again is new work on the device; it can
  still be discarded on the Sync page.

### Check this part

```bash
pnpm --filter @omnivo/sync typecheck
pnpm --filter @omnivo/sync test
pnpm --filter @omnivo/sync build
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/app test
pnpm exec eslint apps/app/src packages/sync/src packages/i18n/src
pnpm --filter @omnivo/app build
pnpm --filter @omnivo/app test:bundle-size
pnpm boundaries
```

Build `@omnivo/sync` and `@omnivo/i18n` first: the app reads both from `dist/`. All ten pass. The bundle check
prints the first load at 209.9 KB gz (budget 210), the workspace's device list at 105.7, your own at 101.9 and the
dialogs at 81.4 (budget 110 each).

> **What we checked in this part.** `packages/sync` type-checks, its unit tests pass (60, three of them new) and it
> builds. The app type-checks (with its `scripts` and `e2e` projects), ESLint and Prettier are clean, its unit tests
> pass (144, two new), it builds, the bundle check passes, and the boundaries check finds no violation. To be sure the
> new tests guard what they say, we broke three lines on purpose, one at a time: the end of a pull keeping the old
> `syncedAt` (the clock test failed), `forgetDevice` not removing anything (two tests failed), and a sign-out without
> a reason erasing the notice (the store test failed). Not run in this part: the screens in a browser, the
> revoke and move flows end to end, and the other tabs following. The mock API has no device routes yet; 18c.7 adds
> them, with Playwright tests for these flows.

---

## 18c.7 — `apps/app`: the mock API's devices and the end-to-end tests

`pnpm dev:mock` and the Playwright tests run the app on MSW, the fake API inside the browser (step 4). After 18c.6
the app calls five routes the mock did not have: both device lists stayed empty, and Rename, Change branch and Revoke
failed. This part gives the mock the devices, with the API's rules on its own arrays, and adds one test file for
everything 18c.6 promised: your own list, the workspace's list, the branch change, the revoke of another device and
of this one, the branch archive rule and the two time limits.

The new tests found one mistake, in a file from step 6 (fixed below): **the branch dialog lost the number in
`branch_has_devices`.** It showed "Active devices in this branch: {{count}}", because it passed only the error code
to the form's alert, and the alert translates a code without its values. Until now no branch error had a value in
it.

The files, in the order to write them: each one only uses files above it.

### The seed and the sign-in of a device: `mocks/sync-data.ts`

```diff
@@ -18,6 +18,7 @@ import {
   type SyncUpsert,
 } from '@omnivo/contracts';
 
+import { OWNER } from './fixtures';
 import { MockProblem } from './mock';
 // Type-only: workspace-data.ts imports this file for emptySync(), and a type import is erased
 // when the code is built, so it makes no circle
@@ -67,6 +68,10 @@ export interface MockSync {
   stamps: Map<string, { quantity: string; at: string }>;
   // A pushed command's id → its answer (push-data.ts)
   answers: Map<string, MockAnswer>;
+  // Step 18c (device-data.ts): a device's id → the sign-in it was last used with, and → the person
+  // who revoked it
+  sessions: Map<string, string>;
+  revokedBy: Map<string, string>;
 }
 
 export function emptySync(): MockSync {
@@ -76,6 +81,8 @@ export function emptySync(): MockSync {
     paging: new Map(),
     stamps: new Map(),
     answers: new Map(),
+    sessions: new Map(),
+    revokedBy: new Map(),
   };
 }
 
@@ -120,6 +127,58 @@ export function registerDevice(
   return { device, branchCode: branch.code };
 }
 
+const HOUR_MS = 60 * 60 * 1000;
+const DAY_MS = 24 * HOUR_MS;
+
+function ago(ms: number): string {
+  return new Date(Date.now() - ms).toISOString();
+}
+
+// Step 18c: the garments workspace's devices, so both lists have rows before this browser registers: the
+// owner's own laptop at home, a store computer three days behind (the warn pill), a phone that
+// never synced, and a depot computer revoked when it was replaced. All the active ones are in the
+// head office: an active device keeps its branch from being archived (branch_has_devices), and the
+// branch tests archive the Chattogram depot and the Gazipur factory.
+export function seedDevices(data: WorkspaceData): void {
+  const [headOffice] = data.branches;
+  const depot = data.branches.find((branch) => branch.code === 'CTG');
+  const person = (fullName: string) =>
+    data.people.members.find((member) => member.fullName === fullName)?.userId ?? OWNER.id;
+  if (!headOffice || !depot) return;
+  const device = (
+    name: string,
+    userId: string,
+    branchId: string,
+    lastSyncAt: string | null,
+    revokedAt: string | null = null,
+  ): Device => ({
+    id: crypto.randomUUID(),
+    name,
+    branchId,
+    userId,
+    lastSyncAt,
+    revokedAt,
+    createdAt: ago(90 * DAY_MS),
+    version: 1,
+  });
+  const revoked = device(
+    'Depot counter 1',
+    person('Nasrin Karim'),
+    depot.id,
+    ago(15 * DAY_MS),
+    ago(12 * DAY_MS),
+  );
+  data.sync.devices.push(
+    device('Home laptop', OWNER.id, headOffice.id, ago(2 * HOUR_MS)),
+    device('Store office PC', person('Abdul Karim'), headOffice.id, ago(3 * DAY_MS + HOUR_MS)),
+    device("Kamal's phone", person('Kamal Uddin'), headOffice.id, null),
+    revoked,
+  );
+  data.sync.revokedBy.set(revoked.id, OWNER.id);
+  // Signed in somewhere else: revoking them does not sign this browser out
+  for (const seeded of data.sync.devices) data.sync.sessions.set(seeded.id, crypto.randomUUID());
+}
+
 // The device a pull or a push names: the signed-in person's own, and not revoked
 export function deviceFor(data: WorkspaceData, userId: string, id: string): Device {
   const device = data.sync.devices.find((candidate) => candidate.id === id);
```

- **`sessions` and `revokedBy`** are what the API keeps on the `devices` row (18c.2's `session_id` and `revoked_by`).
  They are maps next to `devices`, not new fields on it: the mock's devices are the contract's `Device`, which the
  pull and the push return as they are, and a field the contract does not have would have to be stripped on every
  answer.
- **`seedDevices()` gives the garments workspace four devices,** so both lists have rows before this browser
  registers: the owner's Home laptop (synced 2 hours ago), Abdul Karim's Store office PC (3 days and an hour behind,
  so the list shows "Not synced for 3 days"), Kamal Uddin's phone (never synced) and Nasrin Karim's Depot counter 1
  (revoked 12 days ago by the owner). One of each state the list can show.
- **All active ones are in the head office.** An active device keeps its branch from being archived (decision 20),
  and step 6's branch test archives the Chattogram depot and the Gazipur factory. The revoked one is in the
  Chattogram depot: a revoked device does not count, and the Revoked tab's branch filter then has something to find.
- **A sign-in of its own for every seeded device:** they are used on other computers, so revoking one does not sign
  this browser out.
- **The seed is here, not in `device-data.ts`:** `workspace-data.ts` calls it, and `device-data.ts` imports
  `workspace-data.ts`. A seed there would be an import circle, which dependency-cruiser refuses. `sync-data.ts` only
  imports a type from `workspace-data.ts`, which is erased when the code is built.
- **`person()` falls back to the owner:** if a later step renames the generated people, the seed still makes four
  devices instead of throwing.

```diff
@@ -54,7 +54,7 @@ import {
 } from './sales-document-data';
 import { emptyStock, type MockStock, seedStock, warehouse } from './stock-data';
 import { emptySuppliers, type MockSuppliers, seedSuppliers } from './supplier-data';
-import { emptySync, type MockSync } from './sync-data';
+import { emptySync, type MockSync, seedDevices } from './sync-data';
 
 // mock সার্ভারের এক workspace-এর ডেটা — শুধু এই ট্যাবের memory-তে, reload করলে আবার শুরু থেকে।
 // নিয়মগুলো আসল API-র মতো (version, অনন্য কোড, শেষ চালু ব্রাঞ্চ) — UI-র error-পথ mock দিয়েও দেখা যায়
@@ -209,6 +209,8 @@ function seed(workspace: Workspace): WorkspaceData {
   seedPurchaseOrders(data, garments);
   // After the orders: the bill's round names the same levels and people
   seedBills(data, garments);
+  // Step 18c: after the team, whose people own them
+  if (garments) seedDevices(data);
   record(data, 'workspace.created', 'workspace', workspace.tenantId, {
     name: { from: null, to: workspace.name },
   });
@@ -274,6 +276,8 @@ export function startFresh(workspace: Workspace, companyName: string): void {
   data.sales = emptySales();
   data.suppliers = emptySuppliers();
   data.purchase = emptyPurchase();
+  // The seeded devices belong to the people and branches just removed
+  data.sync = emptySync();
   // Sign-up gives a new workspace its Main store, in its one branch (like auth.service.ts)
   data.stock = emptyStock();
   const [first] = data.branches;
```

- **`seedDevices` after the team,** whose people own the devices, and only for the garments workspace: the pharmacy
  has one branch and a dozen people, and the lists' tests run on the garments one.
- **`startFresh()` empties the sync state:** a signed-up workspace keeps only the owner and one branch, and the
  seeded devices would name people and branches that are gone.

### The lists, rename, move and revoke: `mocks/device-data.ts` (new)

```ts
import type {
  Device,
  DeviceListItem,
  deviceListQuerySchema,
  DevicePage,
  DeviceSort,
  MoveDeviceInput,
  RenameDeviceInput,
} from '@omnivo/contracts';
import type { z } from 'zod';

import { OWNER } from './fixtures';
import { MockProblem } from './mock';
import { checkVersion, diff, record, type WorkspaceData } from './workspace-data';

// The mock's step 18c (decisions 1–4): the two device lists, rename, move and revoke. The devices
// themselves are sync-data.ts's (registered by the branch dialog, used by pull and push); this file
// adds what the API keeps beside them: the sign-in a device was last used with, and who revoked it.
// The seed of the garments workspace's devices is sync-data.ts's seedDevices(): workspace-data.ts
// calls it, and this file imports workspace-data.ts, so a seed here would be an import circle.

function now(): string {
  return new Date().toISOString();
}

// --- The sign-in of a device (decision 3) -------------------------------------------------------

// The API's devices.session_id: register, a pull and a push write the sign-in they came with, and
// a revoke ends that sign-in. The mock has one sign-in at a time (handlers.ts), so a revoke of a
// device used with it signs this browser out, and a revoke of any other device does not.
export function keepSession(data: WorkspaceData, deviceId: string, sessionId: string): void {
  const device = data.sync.devices.find((candidate) => candidate.id === deviceId);
  // A revoked device keeps the sign-in it had (the 0048 trigger refuses a change)
  if (device?.revokedAt === null) data.sync.sessions.set(deviceId, sessionId);
}

// --- The lists ----------------------------------------------------------------------------------

function nameOf(data: WorkspaceData, userId: string): string {
  return data.people.members.find((member) => member.userId === userId)?.fullName ?? '';
}

function toListItem(data: WorkspaceData, device: Device): DeviceListItem {
  const revokedBy = data.sync.revokedBy.get(device.id);
  return {
    ...device,
    userName: nameOf(data, device.userId),
    branchName: data.branches.find((branch) => branch.id === device.branchId)?.name ?? '',
    revokedByName: revokedBy === undefined ? null : nameOf(data, revokedBy),
  };
}

// The API's mine(): active first, then by name
export function myDevices(data: WorkspaceData): DeviceListItem[] {
  return data.sync.devices
    .filter((device) => device.userId === OWNER.id)
    .toSorted(
      (a, b) =>
        Number(a.revokedAt !== null) - Number(b.revokedAt !== null) || a.name.localeCompare(b.name),
    )
    .map((device) => toListItem(data, device));
}

// 'lastSync': the oldest first, the devices that never synced before all of them; '-lastSync' the
// other way round. Times are ISO strings of one format, so comparing them as text is by time.
function compare(sort: DeviceSort): (a: DeviceListItem, b: DeviceListItem) => number {
  const byName = (a: DeviceListItem, b: DeviceListItem) => a.name.localeCompare(b.name);
  const bySync = (a: DeviceListItem, b: DeviceListItem) =>
    (a.lastSyncAt ?? '').localeCompare(b.lastSyncAt ?? '');
  if (sort === 'name') return byName;
  if (sort === '-name') return (a, b) => byName(b, a);
  if (sort === 'lastSync') return bySync;
  return (a, b) => bySync(b, a);
}

// The API pages with a keyset; the mock's cursor is an offset. The client never reads it.
export function deviceList(
  data: WorkspaceData,
  query: z.output<typeof deviceListQuerySchema>,
): DevicePage {
  const search = query.search?.toLowerCase() ?? '';
  const matches = data.sync.devices
    .map((device) => toListItem(data, device))
    .filter(
      (device) =>
        (query.status === 'active') === (device.revokedAt === null) &&
        (query.branchId === undefined || device.branchId === query.branchId) &&
        (search === '' ||
          device.name.toLowerCase().includes(search) ||
          device.userName.toLowerCase().includes(search)),
    )
    .toSorted(compare(query.sort));
  const start = query.cursor === undefined ? 0 : Number(query.cursor);
  const end = start + query.limit;
  return {
    items: matches.slice(start, end),
    nextCursor: end < matches.length ? String(end) : null,
  };
}

// --- Rename, move, revoke -----------------------------------------------------------------------

// The mock's person is the owner, who holds core.device.manage: every device is theirs to rename
// and revoke. Moving is for their own only (decision 2), like the API's lockOwn().
function findDevice(data: WorkspaceData, id: string): Device {
  const device = data.sync.devices.find((candidate) => candidate.id === id);
  if (!device) throw new MockProblem(404, 'device_not_found');
  return device;
}

function assertActive(device: Device): void {
  if (device.revokedAt !== null) throw new MockProblem(403, 'device_revoked');
}

export function renameDevice(
  data: WorkspaceData,
  id: string,
  input: RenameDeviceInput,
): DeviceListItem {
  const device = findDevice(data, id);
  assertActive(device);
  checkVersion(device.version, input.version);
  // The same name: no write and no audit row, like the API
  if (device.name !== input.name) {
    record(data, 'device.renamed', 'device', id, diff({ name: device.name }, { name: input.name }));
    Object.assign(device, { name: input.name, version: device.version + 1 });
  }
  return toListItem(data, device);
}

export function moveDevice(
  data: WorkspaceData,
  id: string,
  input: MoveDeviceInput,
): DeviceListItem {
  const device = findDevice(data, id);
  if (device.userId !== OWNER.id) throw new MockProblem(404, 'device_not_found');
  assertActive(device);
  checkVersion(device.version, input.version);
  const branch = data.branches.find(
    (candidate) => candidate.id === input.branchId && candidate.archivedAt === null,
  );
  if (!branch) {
    throw new MockProblem(409, 'device_branch_invalid', { branchId: ['device_branch_invalid'] });
  }
  if (device.branchId !== branch.id) {
    const before = data.branches.find((candidate) => candidate.id === device.branchId);
    record(
      data,
      'device.moved',
      'device',
      id,
      diff({ branch: before?.code ?? null }, { branch: branch.code }),
    );
    // The next pull is a full pull of the new branch: sync-data.ts's pull compares the branch its
    // cursor was made for
    Object.assign(device, { branchId: branch.id, version: device.version + 1 });
  }
  return toListItem(data, device);
}

// Revoking twice answers the device as it is. `endsSession` tells the handler whether the revoke
// ended the sign-in this browser uses (handlers.ts then answers its refresh with session_ended).
export function revokeDevice(
  data: WorkspaceData,
  id: string,
  sessionId: string,
): { device: DeviceListItem; endsSession: boolean } {
  const device = findDevice(data, id);
  if (device.revokedAt !== null) return { device: toListItem(data, device), endsSession: false };
  const revokedAt = now();
  Object.assign(device, { revokedAt, version: device.version + 1 });
  data.sync.revokedBy.set(id, OWNER.id);
  record(data, 'device.revoked', 'device', id, { revokedAt: { from: null, to: revokedAt } });
  return {
    device: toListItem(data, device),
    endsSession: data.sync.sessions.get(id) === sessionId,
  };
}

// Branch archive (decision 20): refused while active devices are in the branch, with how many
export function assertNoActiveDevices(data: WorkspaceData, branchId: string): void {
  const count = data.sync.devices.filter(
    (device) => device.branchId === branchId && device.revokedAt === null,
  ).length;
  if (count > 0) throw new MockProblem(409, 'branch_has_devices', undefined, { count });
}
```

- **`keepSession()` is the API's `keepSession`** (decision 17): register, a pull and a push write the sign-in they came
  with. A revoked device keeps the one it had, as 18c.2's trigger insists. The handlers call it after the pull and the
  push succeed, so `pull()` and `push()` stay as they were.
- **`toListItem()` adds the three names** of the contract's list item. The person's name comes from the team, also
  after they left; an unknown id gives an empty name instead of throwing, as a deleted user would in a real list.
- **`myDevices()`:** the owner's devices, active first, then by name, like the API's `mine()`.
- **`deviceList()` filters, sorts and pages** like the API's `list()`: the tab, the branch, the search in the device's
  or the person's name (lower case, part of the name), then the sort. The cursor is an offset, as in the mock's other
  lists; the client never reads it.
- **`compare()` sorts the last sync as text.** Every time in the mock is `toISOString()`, the same length and format,
  so text order is time order. A device that never synced has `''`, which sorts before every time: first on
  `lastSync`, last on `-lastSync`, as the API's `-1` key does (decision 21).
- **The mock's person is the owner, who has `core.device.manage`,** so every device is theirs to rename and revoke.
  Moving is still for their own device only: someone else's answers `device_not_found`, like the API's `lockOwn()`.
- **`renameDevice()`:** a revoked device is `device_revoked` (403), then the version check (decision 9). The same name
  writes nothing and adds no audit row.
- **`moveDevice()`:** an archived or unknown branch is `device_branch_invalid` under the select. The same branch
  changes nothing. A move changes `branchId`, and `pull()` in `sync-data.ts` already starts a full pull when the
  branch differs from the one the cursor was made for: the new branch's copy needs no code here.
- **`revokeDevice()`:** revoking twice answers the device as it is (the route has no version). `endsSession` says
  whether the revoked device was last used with this browser's sign-in; the handler then ends it.
- **`assertNoActiveDevices()`** is the API's `branch_has_devices`, with the count in `params` (decision 20).

### The routes: `mocks/handlers.ts`

```diff
@@ -303,6 +303,15 @@ import {
   toSupplier,
   toSupplierGroup,
 } from './supplier-data';
+import {
+  assertNoActiveDevices,
+  deviceList,
+  keepSession,
+  moveDevice,
+  myDevices,
+  renameDevice,
+  revokeDevice,
+} from './device-data';
 import { push } from './push-data';
 import { pull, registerDevice } from './sync-data';
 import {
@@ -320,6 +329,9 @@ import {
 
 // mock সার্ভারের অবস্থা — শুধু এই ট্যাবের memory-তে, reload করলে আবার শুরু থেকে
 let signedIn = true;
+// Step 18c: the sign-in this browser uses, like the API's session id. A new one at every sign-in; a
+// device remembers the one it was last used with (device-data.ts), so revoking it can end it.
+let sessionId = crypto.randomUUID();
 let workspace: Workspace = WORKSPACES[0];
 let preferences: Preferences = { language: null, theme: 'system' };
 
@@ -642,6 +654,7 @@ export const handlers = [
     await delay();
     if (body.password === 'wrong-password') return problem(401, 'invalid_credentials');
     signedIn = true;
+    sessionId = crypto.randomUUID();
     return reply(routes.auth.login, session());
   }),
 
@@ -655,6 +668,7 @@ export const handlers = [
     workspace = WORKSPACES[0];
     startFresh(workspace, body.companyName);
     signedIn = true;
+    sessionId = crypto.randomUUID();
     return reply(routes.auth.signUp, session());
   }),
 
@@ -1058,6 +1072,8 @@ export const handlers = [
       checkVersion(target.version, version);
       const othersActive = data.branches.some((b) => b.id !== id && b.archivedAt === null);
       if (!othersActive) throw new MockProblem(409, 'branch_last_active');
+      // Step 18c (decision 20): after the last-branch rule, like the API
+      assertNoActiveDevices(data, id);
       Object.assign(target, { archivedAt: new Date().toISOString(), version: version + 1 });
       record(data, 'branch.archived', 'branch', id);
       return reply(routes.branches.archive, target);
@@ -4970,6 +4986,7 @@ export const handlers = [
       const body = await readBody(routes.sync.registerDevice.body, request);
       const data = current();
       const { device, branchCode } = registerDevice(data, OWNER.id, body);
+      keepSession(data, device.id, sessionId);
       // The API's audit row, for a new device only
       if (branchCode !== null) {
         record(data, 'device.registered', 'device', device.id, {
@@ -4985,7 +5002,11 @@ export const handlers = [
     routes.sync.pull,
     guarded(({ request }) => {
       const query = readQuery(routes.sync.pull.query, request);
-      return reply(routes.sync.pull, pull(current(), workspace.tenantId, OWNER.id, query));
+      const data = current();
+      const page = pull(data, workspace.tenantId, OWNER.id, query);
+      // The API writes the sign-in at the end of a pull; any page is close enough for the mock
+      keepSession(data, query.deviceId, sessionId);
+      return reply(routes.sync.pull, page);
     }),
   ),
 
@@ -4994,9 +5015,53 @@ export const handlers = [
     routes.sync.push,
     guarded(async ({ request }) => {
       const body = await readBody(routes.sync.push.body, request);
-      const answer = push(current(), OWNER.id, body);
+      const data = current();
+      const answer = push(data, OWNER.id, body);
+      keepSession(data, body.deviceId, sessionId);
       await delay();
       return reply(routes.sync.push, answer);
     }),
   ),
+
+  // Step 18c: the device lists, rename, move and revoke (device-data.ts)
+  mock(routes.devices.mine, () => reply(routes.devices.mine, { items: myDevices(current()) })),
+
+  mock(routes.devices.list, async ({ request }) => {
+    const query = readQuery(routes.devices.list.query, request);
+    await delay();
+    return reply(routes.devices.list, deviceList(current(), query));
+  }),
+
+  mock(
+    routes.devices.rename,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.devices.rename.params.parse(params);
+      const body = await readBody(routes.devices.rename.body, request);
+      await delay();
+      return reply(routes.devices.rename, renameDevice(current(), id, body));
+    }),
+  ),
+
+  mock(
+    routes.devices.move,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.devices.move.params.parse(params);
+      const body = await readBody(routes.devices.move.body, request);
+      await delay();
+      return reply(routes.devices.move, moveDevice(current(), id, body));
+    }),
+  ),
+
+  // A revoke of the device this browser uses ends its sign-in: the app's refresh after the wipe
+  // then fails, and it signs out with the notice (local-session.ts's revoke())
+  mock(
+    routes.devices.revoke,
+    guarded(async ({ params }) => {
+      const { id } = routes.devices.revoke.params.parse(params);
+      const { device, endsSession } = revokeDevice(current(), id, sessionId);
+      if (endsSession) signedIn = false;
+      await delay();
+      return reply(routes.devices.revoke, device);
+    }),
+  ),
 ];
```

- **`sessionId` is the sign-in this browser uses,** like the API's session id. A new one at every sign-in and sign-up:
  a device registered before stays linked to the old one, as in the API.
- **The archive checks the devices after the last-branch rule,** in the API's order. Step 6's test archives the other
  branches and then the head office, and expects "Keep at least one branch active".
- **`keepSession` after register, the pull and the push.** The API writes it at the end of a pull; any page is close
  enough for the mock.
- **A revoke that ends this browser's sign-in sets `signedIn = false`.** The app then deletes its copy and asks for a
  new access token (18c.6's `revoke()`); the refresh answers `session_ended`, and the app signs out with the notice.
  This is how the mock plays decision 3: the API deletes the session row, and the next refresh fails.
- **`delay()` on the list and the three actions,** the mock's usual wait, so the buttons show their busy state.

### The branch dialog's error: `routes/branches.tsx`

```diff
@@ -48,7 +48,7 @@ const FIELD_NAMES = updateBranchInputSchema.keyof().options;
 // একটা ফর্ম দুই কাজে: নতুন (branch নেই) আর বদল। নতুনের version 1 — schema-র min(1) পার হয়,
 // আর তৈরির route version পড়েই না (branchInputSchema-তে ঘরটা নেই, z.object বাড়তি key ফেলে দেয়)
 function BranchForm({ branch, onDone }: { branch: Branch | null; onDone: () => void }) {
-  const { t } = useLocale();
+  const { t, errorText } = useLocale();
   const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
   const queryClient = useQueryClient();
   const {
@@ -104,7 +104,7 @@ function BranchForm({ branch, onDone }: { branch: Branch | null; onDone: () => v
     }
   });
 
-  const failure = errors.root?.server?.message ?? toggleFailure(toggle.error);
+  const failure = errors.root?.server?.message ?? toggleFailure(toggle.error, errorText);
 
   return (
     <DialogContent
@@ -180,9 +180,17 @@ function BranchForm({ branch, onDone }: { branch: Branch | null; onDone: () => v
 }
 
 // archive/restore-এর error (branch_last_active, version_conflict) ফর্মের ঘরের না — উপরে alert-এ
-function toggleFailure(error: Error | null): string | undefined {
+// Step 18c: the text, not the code. branch_has_devices has a value inside ("Active devices in this
+// branch: 4"), and FormAlert translates a code without its params; a text that is not a code it
+// shows as it is. Worked out on every render, so a change of language still changes it.
+function toggleFailure(
+  error: Error | null,
+  errorText: (code: string, params?: Record<string, string | number>) => string,
+): string | undefined {
   if (!error) return undefined;
-  return error instanceof ApiRequestError ? error.code : 'unknown_error';
+  return error instanceof ApiRequestError
+    ? errorText(error.code, error.problem.params)
+    : 'unknown_error';
 }
 
 // null = dialog বন্ধ, 'new' = নতুন ব্রাঞ্চ, Branch = সেটা বদলানো
```

- **The text, not the code.** `FormAlert` shows a code in the current language, without values; a string that is not
  a code it shows as it is. `errorText(code, params)` puts the count in, the way the year-end page does for
  `year_has_drafts`.
- **Worked out in the render,** not stored: switching to Bangla with the dialog open still changes the text.
- **The form's own errors (`errors.root.server`) are unchanged:** the save routes send no values.

### The tests: `e2e/devices.e2e.ts` (new)

```ts
import { syncPullSchema } from '@omnivo/contracts';
import type { Page } from '@playwright/test';

import { OWNER } from '../src/mocks/fixtures.js';
import {
  expect,
  expectNoSideScroll,
  listItem,
  openFromNav,
  readOnlyItem,
  test,
  toastShown,
  waitForCopy,
} from './helpers.js';

// Step 18c: the device lists, rename, branch change, revoke and the time limits. The garments
// workspace has four devices besides this browser (src/mocks/sync-data.ts → seedDevices): the
// owner's Home laptop, Abdul Karim's Store office PC (3 days behind), Kamal Uddin's phone (never
// synced), all in the head office, and Nasrin Karim's Depot counter 1, revoked. This browser is
// the head office's device of the fixture in helpers.ts; its name comes from the browser ("Chrome
// on Linux"), so the tests find its row by the "This device" pill. The device lists have no row
// click, so a row is a readOnlyItem: a table row on a desktop, a list item on a phone.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// The first pull registers this browser as a device: before that, it is in no list. A helper, not
// a beforeEach: the limits test installs Playwright's clock first, and timers made before the
// install would keep the real clock.
async function start(page: Page): Promise<void> {
  await page.goto('/');
  await waitForCopy(page);
}

async function openMyDevices(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: /Farhana Rahman/ })
    .or(page.getByRole('button', { name: 'Account' }))
    .filter({ visible: true })
    .click();
  await page.getByRole('menuitem', { name: 'My devices' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'My devices' })).toBeVisible();
}

// A row's menu, by the device's name ("Actions for Home laptop"), or this device's
async function openMenu(page: Page, name: string | null): Promise<void> {
  const row = readOnlyItem(page, name ?? /This device/);
  await row
    .getByRole('button', { name: name === null ? /^Actions for / : `Actions for ${name}` })
    .click();
}

// The sidebar line (desktop) or the top bar's (phone), as in outbox.e2e.ts
function syncLink(page: Page, name: string) {
  return page
    .getByRole('navigation')
    .getByRole('link', { name: `Sync: ${name}`, exact: true })
    .filter({ visible: true });
}

// The local databases of this browser profile, as in sync.e2e.ts
function localDatabases(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await indexedDB.databases())
      .map((database) => database.name ?? '')
      .filter((name) => name.startsWith('omnivo-')),
  );
}

// The last page of a full pull: the copy of a new branch is complete. Started before the click
// that causes it, so a fast answer is not missed.
function fullCopy(page: Page) {
  return page.waitForResponse(
    async (response) => {
      if (!response.url().includes('/sync/pull') || !response.ok()) return false;
      const parsed = syncPullSchema
        .pick({ full: true, hasMore: true })
        .safeParse(await response.json());
      return parsed.success && parsed.data.full && !parsed.data.hasMore;
    },
    { timeout: 25_000 },
  );
}

test('lists your own devices, renames this one and revokes another', async ({ page }) => {
  await start(page);
  await openMyDevices(page);
  const here = readOnlyItem(page, /This device/);
  await expect(here).toContainText('Head office');
  await expect(here).toContainText('Active');
  await expect(readOnlyItem(page, /Home laptop/)).toBeVisible();
  // Other people's devices are in Settings → Devices, not here
  await expect(readOnlyItem(page, /Store office PC/)).toHaveCount(0);

  await openMenu(page, null);
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const rename = page.getByRole('dialog', { name: /^Rename / });
  await rename.getByLabel('Name').fill('x');
  await rename.getByRole('button', { name: 'Save name' }).click();
  await expect(rename.getByText('Give this device a name, like Counter 1.')).toBeVisible();
  await rename.getByLabel('Name').fill('Cutting floor PC');
  await rename.getByRole('button', { name: 'Save name' }).click();
  await toastShown(page, 'Renamed to Cutting floor PC');
  await expect(here).toContainText('Cutting floor PC');

  await openMenu(page, 'Home laptop');
  // Only this device changes its branch, from itself (decision 2)
  await expect(page.getByRole('menuitem', { name: 'Change branch' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Revoke' }).click();
  const revoke = page.getByRole('dialog', { name: 'Revoke Home laptop?' });
  await expect(revoke).toContainText('It stops syncing and is signed out at once.');
  await expect(revoke).toContainText('A revoked device cannot be restored.');
  await revoke.getByRole('button', { name: 'Revoke device' }).click();
  await toastShown(page, 'Home laptop revoked');
  // It stays in the list for the audit, with who revoked it, and nothing left to do with it
  const laptop = readOnlyItem(page, /Home laptop/);
  await expect(laptop).toContainText('Revoked by Farhana Rahman');
  await expect(laptop.getByRole('button', { name: 'Actions for Home laptop' })).toHaveCount(0);
  // The laptop had a sign-in of its own: this browser is still signed in
  await expect(here).toContainText('Active');
  await expectNoSideScroll(page);

  await openFromNav(page, 'Audit log');
  await expect(readOnlyItem(page, /Revoked a device/).first()).toBeVisible();
  await expect(readOnlyItem(page, /Renamed a device/).first()).toBeVisible();
});

test('revoking this device signs you out, and the next sign-in makes a new device', async ({
  page,
}) => {
  await start(page);
  await openMyDevices(page);
  await openMenu(page, null);
  await page.getByRole('menuitem', { name: 'Revoke' }).click();
  const dialog = page.getByRole('dialog', { name: /^Revoke / });
  await expect(dialog).toContainText(
    'You are signed out here, and the copy of the data on this device is deleted.',
  );
  await dialog.getByRole('button', { name: 'Revoke device' }).click();

  // The revoke ended this browser's sign-in (decision 3): the copy goes, then the sign-in page
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(
    page.getByText('This device was revoked, so its data was deleted and you were signed out.'),
  ).toBeVisible();
  await expect.poll(() => localDatabases(page)).toEqual([]);

  await page.getByLabel('Workspace', { exact: true }).fill('rahman-garments');
  await page.getByLabel('Email', { exact: true }).fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill('Konabari-cut-2026');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // A new device, with a new id: the branch is asked again (decision 4)
  const branch = page.getByRole('dialog', { name: 'Which branch is this device in?' });
  await branch.getByLabel('Branch').selectOption({ label: 'GZP · Gazipur factory' });
  await branch.getByRole('button', { name: 'Use this branch' }).click();
  await toastShown(page, 'This device is set up for Gazipur factory');

  await openMyDevices(page);
  await expect(readOnlyItem(page, /This device/)).toContainText('Gazipur factory');
  // The old one stays as it was, revoked
  await expect(readOnlyItem(page, /Revoked by Farhana Rahman/)).toContainText('Head office');
  await expect(readOnlyItem(page, /Revoked by Farhana Rahman/)).not.toContainText('This device');
});

test("every device of the workspace: search, branch, tabs, and revoking someone else's", async ({
  page,
}) => {
  await start(page);
  await openFromNav(page, 'Devices');
  const store = readOnlyItem(page, /Store office PC/);
  await expect(store).toContainText('Abdul Karim');
  // Three days behind: the warn pill in Active's place (decision 12)
  await expect(store).toContainText('Not synced for 3 days');
  await expect(readOnlyItem(page, /Kamal's phone/)).toContainText('Never synced');
  await expect(readOnlyItem(page, /This device/)).toContainText('Farhana Rahman');
  // Revoked ones have their own tab
  await expect(readOnlyItem(page, /Depot counter 1/)).toHaveCount(0);

  // By the device's name or the person's
  const search = page.getByRole('searchbox', { name: 'Search devices' });
  await search.fill('abdul');
  await expect(store).toBeVisible();
  await expect(readOnlyItem(page, /Kamal's phone/)).toHaveCount(0);
  await search.fill('tablet');
  await expect(page.getByText('No device matches "tablet"')).toBeVisible();
  await search.fill('');

  await page.getByText('Revoked', { exact: true }).click();
  const depot = readOnlyItem(page, /Depot counter 1/);
  await expect(depot).toContainText('Nasrin Karim');
  await expect(depot).toContainText('Revoked by Farhana Rahman');
  const branch = page.getByLabel('Branch', { exact: true });
  await branch.selectOption({ label: 'Head office' });
  await expect(page.getByText('No revoked devices')).toBeVisible();
  await branch.selectOption({ label: 'Chattogram depot' });
  await expect(depot).toBeVisible();
  await branch.selectOption({ label: 'All branches' });
  await page.getByText('Active', { exact: true }).click();

  // Someone else's device, with core.device.manage (the mock's owner has every permission)
  await openMenu(page, 'Store office PC');
  await page.getByRole('menuitem', { name: 'Revoke' }).click();
  await page
    .getByRole('dialog', { name: 'Revoke Store office PC?' })
    .getByRole('button', { name: 'Revoke device' })
    .click();
  await toastShown(page, 'Store office PC revoked');
  await expect(store).toHaveCount(0);
  await page.getByText('Revoked', { exact: true }).click();
  await expect(store).toContainText('Revoked by Farhana Rahman');
  await expectNoSideScroll(page);
});

test('sorts by the last sync, the devices that never synced first', async ({ page, isMobile }) => {
  test.skip(isMobile, 'A phone shows the devices as cards, with no column to sort by');
  await start(page);
  await openFromNav(page, 'Devices');
  const sort = page.getByRole('button', { name: 'Sort by Last synced' });
  const rows = page.getByRole('row');
  await sort.click();
  // Row 0 is the header
  await expect(rows.nth(1)).toContainText("Kamal's phone");
  await expect(rows.nth(2)).toContainText('Store office PC');
  await expect(rows.nth(3)).toContainText('Home laptop');
  await expect(rows.nth(4)).toContainText('This device');
  await sort.click();
  await expect(rows.nth(1)).toContainText('This device');
  await expect(rows.nth(4)).toContainText("Kamal's phone");
});

test('a branch with active devices is not archived', async ({ page }) => {
  await start(page);
  await openFromNav(page, 'Branches');
  await listItem(page, /Head office/).click();
  const dialog = page.getByRole('dialog', { name: 'Edit HO' });
  await dialog.getByRole('button', { name: 'Archive' }).click();
  // This browser, the Home laptop, the Store office PC and Kamal's phone (decision 20)
  await expect(dialog.getByRole('alert')).toHaveText(/Active devices in this branch: 4\./);
});

test('changing the branch waits for the outbox, then copies the new branch', async ({
  page,
  context,
}) => {
  await start(page);
  // A change the server refused stays on the device until it is fixed or discarded: H&M's code
  await context.setOffline(true);
  await openFromNav(page, 'Customers');
  await page.getByRole('button', { name: 'Add customer' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Comilla Fabrics');
  await page.getByLabel(/^Code/).fill('C-00001');
  await page.getByRole('button', { name: 'Save on this device' }).click();
  await toastShown(page, 'Saved on this device. It syncs when the connection is back.');
  await context.setOffline(false);
  await toastShown(page, 'Some changes need attention. Open Sync to fix them.');

  await openMyDevices(page);
  await openMenu(page, null);
  await page.getByRole('menuitem', { name: 'Change branch' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change the branch of this device' });
  await expect(dialog).toContainText('Omnivo deletes the copy of Head office on this device');
  await expect(dialog).toContainText('Sync the 1 change on this device first.');
  await expect(dialog.getByRole('button', { name: 'Change branch' })).toBeDisabled();
  await dialog.getByRole('link', { name: 'Sync' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sync' })).toBeVisible();
  await page
    .getByRole('listitem')
    .filter({ hasText: 'New customer Comilla Fabrics' })
    .getByRole('button', { name: 'Discard' })
    .click();
  await page
    .getByRole('dialog', { name: 'Discard this change?' })
    .getByRole('button', { name: 'Discard change' })
    .click();
  await toastShown(page, 'Change discarded');

  await openMyDevices(page);
  await openMenu(page, null);
  await page.getByRole('menuitem', { name: 'Change branch' }).click();
  // The connection drops with the dialog open: the server must answer the move
  await context.setOffline(true);
  await expect(dialog).toContainText('Connect to the internet to change the branch.');
  await context.setOffline(false);
  // Its own branch is not a choice: moving there would change nothing
  const select = dialog.getByLabel('New branch');
  await expect(select.getByRole('option')).toHaveText([
    'Pick a branch',
    'CTG · Chattogram depot',
    'GZP · Gazipur factory',
  ]);
  await select.selectOption({ label: 'CTG · Chattogram depot' });
  const copied = fullCopy(page);
  await dialog.getByRole('button', { name: 'Change branch' }).click();
  await toastShown(page, 'This device is now set up for Chattogram depot');
  await expect(readOnlyItem(page, /This device/)).toContainText('Chattogram depot');
  await copied;

  // The copy is the depot's now: an order saved offline is sent from its warehouse only
  await context.setOffline(true);
  await openFromNav(page, 'Sales orders');
  await page.getByRole('button', { name: 'New order' }).click();
  await expect(page.getByLabel('Send from').getByRole('option')).toContainText([
    'CTG · Chattogram depot',
  ]);
  await expect(page.getByLabel('Send from').getByRole('option')).not.toContainText([
    'MAIN · Main store',
  ]);
});

test('warns a day after the last sync, and saves nothing new offline after seven', async ({
  page,
  context,
}) => {
  // Playwright's clock: the app's Date, timers and intervals move when the test says. Until then
  // it runs at the real pace, so the first copy is made as usual.
  await page.clock.install();
  await start(page);
  await expect(syncLink(page, 'Online, All changes synced')).toBeVisible();
  // Offline, the engine cannot pull, so the last sync stays where it was
  await context.setOffline(true);
  await page.clock.fastForward(25 * HOUR_MS);
  await expect(syncLink(page, 'Offline, Last synced 1 day ago, All changes synced')).toBeVisible();
  await openFromNav(page, 'Sync');
  await expect(
    page.getByText('Prices, stock and credit limits on this device may be out of date.'),
  ).toBeVisible();

  await page.clock.fastForward(6 * DAY_MS);
  await expect(syncLink(page, 'Offline, Last synced 7 days ago, All changes synced')).toBeVisible();
  await expect(
    page.getByText("This device last synced more than 7 days ago, so it can't save new work"),
  ).toBeVisible();
  // The two forms that save on the device say why, with no button to save
  const blocked = page.getByText('Connect to the internet to save this.');
  await openFromNav(page, 'Customers');
  await page.getByRole('button', { name: 'Add customer' }).click();
  await expect(blocked).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save on this device' })).toHaveCount(0);
  await openFromNav(page, 'Sales orders');
  await page.getByRole('button', { name: 'New order' }).click();
  await expect(blocked).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save on this device' })).toHaveCount(0);
  await expectNoSideScroll(page);

  // Back online: a pull, and the limits are gone
  await context.setOffline(false);
  await expect(syncLink(page, 'Online, All changes synced')).toBeVisible();
});
```

- **`start()` in every test, not a `beforeEach`.** The limits test installs Playwright's clock before the page loads.
  A timer made before `clock.install()` keeps the real clock, so the sync line's one-minute tick (18c.6's `useNow`)
  would not move when the test jumps ahead. `waitForCopy` waits for the first pull, which also registers this
  browser: before that it is in no list.
- **This device is found by its "This device" pill,** not by its name: the name comes from the browser ("Chrome on
  Linux" in CI, "Chrome on macOS" on a Mac).
- **`readOnlyItem()` for a row:** the device lists have no row click, so a phone shows plain list items, not buttons.
  The same tests run on the desktop and the phone.
- **Your own list:** this device and the Home laptop, not Abdul Karim's PC. A rename with a one-letter name shows the
  name error under the box; a good one shows the toast and the new name. The laptop's menu has no Change branch
  (decision 2). Its revoke dialog says it is final; after it, the row stays with "Revoked by Farhana Rahman" and no
  menu, and this browser is still signed in, because the laptop had its own sign-in. The audit log lists both
  actions.
- **Revoking this device:** the dialog's text for this device, then the sign-in page with the notice, and no local
  database left. Signing in again asks for the branch, because the identity was forgotten (decision 4); the new
  device is in the Gazipur factory, and the old one is still listed, revoked, in the head office.
- **The workspace's list:** the person column, the warn pill, "Never synced", the search by a person's name and a
  search with no match, the Revoked tab with the branch filter (an empty tab says so), and a revoke of someone else's
  device, which moves it from one tab to the other.
- **Sorting by the last sync runs on the desktop only:** a phone shows cards, with no column header to click. The
  devices that never synced come first, the opposite order puts this device (synced seconds ago) first.
- **The branch archive:** four active devices in the head office (this browser and three seeded ones). This is the
  test that found the `{{count}}` mistake.
- **The branch change:** a customer saved offline with H&M's code is refused when the connection is back and stays
  on the device. The dialog then says to sync first, with the button disabled, and its Sync link opens the Sync
  page, where the change is discarded. The second time, the connection drops with the dialog open (the dialog says
  why it cannot move), then comes back. The select leaves out the head office, this device's branch. After the move,
  `fullCopy()` waits for the last page of a full pull, and an order opened offline offers only the depot's
  warehouse: the copy is the depot's now. `fullCopy()` starts listening before the click, so a fast answer is not
  missed.
- **The limits, with Playwright's clock:** offline, 25 hours later, the sync line says "Last synced 1 day ago" and
  the Sync page warns; 6 more days and the Sync page says new work stops, and the customer and order forms show
  the notice with no "Save on this device". Back online, a pull brings everything back to normal. Offline, the
  engine cannot pull, so the last sync stays where it was while the clock moves.
- **What is not tested end to end:**
  - **A person without `core.device.manage`.** The mock's person is the owner, with every permission, as in every
    earlier step. The API's integration tests check the 403 (18c.4), and the page's read-only text is one `if`.
  - **The other tabs following a move or a revoke.** Each tab runs its own mock, with its own state: a second tab
    would not know the device the first one moved. The storage event is a few lines of 18c.6's `followOtherTabs`.

### Check this part

```bash
pnpm --filter @omnivo/app typecheck
pnpm exec eslint apps/app/src apps/app/e2e
pnpm --filter @omnivo/app test
pnpm --filter @omnivo/app build
pnpm --filter @omnivo/app test:bundle-size
pnpm boundaries
pnpm --filter @omnivo/app test:e2e
```

No package changed in this part, so nothing needs building first.

> **What we checked in this part.** The app type-checks (with its `scripts` and `e2e` projects), ESLint and Prettier
> are clean, its 144 unit tests pass, it builds, the bundle check passes (first load still 209.9 KB gz; the mock is
> not in the production build, and the branches page is 99.1 of 110), and dependency-cruiser finds no violation. The
> 13 new tests (7 on the desktop, 6 on the phone, where the sort test is skipped) passed 3 times in a row
> (`--repeat-each=3`). The full Playwright suite, 290 tests, ran once with 4 workers: 283 passed and 6 failed on
> timeouts in the credit note and customer tests on the phone, while the machine's load was near 36; the 6 passed
> with `--last-failed --workers=2`. Three lines of 18c.6 were broken on purpose, one at a time, and a test caught
> each: the customer form ignoring the 7-day limit (the limits test failed), the branch dialog ignoring the outbox
> (the branch change test found the button enabled), and a revoke keeping the device's identity (the next sign-in
> asked no branch, so the revoke test failed). Without the `branches.tsx` fix, the archive test fails, which is how
> the mistake was found. Not checked here: the device routes against the real API in a browser, which 18c.8 runs
> once.

---

## 18c.8 — The OpenAPI document, the real API, and every check once

### The role templates are already done

This step adds one permission, `core.device.manage`, and 18c.3 already gave it to the role templates that manage a
branch (the Depot manager of the pharmacy and distribution templates, the Shop manager of the retail one). The owner
has every permission from the code. No other template changes, and no migration adds it to existing workspaces'
roles: a workspace's owner gives it to a role in the permission matrix, like any other permission (decision 6).

### The OpenAPI document

No root file changes in this step: no new dependency, no new script, no new `.env` line, and the boundaries rules
already cover every folder this step touches. Generate the API document again and commit it:

```bash
pnpm gen:openapi      # packages/contracts/openapi.json — 215 paths (210 before)
```

The five new paths are `/me/devices` (GET), `/devices` (GET), `/devices/{id}` (PATCH), `/devices/{id}/branch` (PUT)
and `/devices/{id}/revoke` (POST). One older path changes a number: the permission matrix's `PUT
/permission-matrix` accepts up to 42 permissions per role, one more than before, because its schema's maximum is the
length of the permission list. `pnpm test:openapi` fails if the committed file and the routes disagree.

The Drizzle snapshot of 18c.2 (`migrations/meta/0047_snapshot.json` and `_journal.json`) is written by `drizzle-kit
generate`; commit it as it is.

### The app against the real API

18c.7 promised one run of the device screens against the real API, not the mock. It ran in a browser (Chromium,
driven by a Playwright script that is not part of the guide), with the API, the worker and the app built from this
guide's code, on a throwaway Postgres and Valkey on other ports. The script used two browsers of the same person,
A and B, as two computers:

- signed up a pharma workspace through the API and added a second branch, the Chattogram depot. Browser A opened
  the app: with two branches, "Which branch is this device in?" asked, and A chose the head office;
- on A, opened My devices from the account menu: one row, with the "This device" pill, the head office and Active.
  Renamed it to "Front desk PC";
- signed in on browser B through the sign-in page and chose the Chattogram depot;
- on A, reloaded My devices: B's row was there, Active, and its menu had no Change branch (decision 2). Revoked it:
  B's row said "Revoked by Nusrat Jahan", and A was still signed in;
- on B, pressed "Sync now" on the Sync page. The pull got `device_revoked`, the refresh failed because the revoke
  had deleted B's sign-in (decision 3), and B showed the sign-in page with "This device was revoked, so its data was
  deleted and you were signed out." B's browser had no local database left. Signing in again on B asked for the
  branch again: a new device (decision 4);
- on A, opened Workspace → Devices: the person column, a search ("front" found only Front desk PC), and the Revoked
  tab with B's old device;
- on A, changed this device's branch to the Chattogram depot: the toast, then the depot in its row;
- on A, tried to archive the Chattogram depot: refused with "Active devices in this branch: 2." (A, and B's new
  device; the revoked one does not count, decision 20);
- on A, revoked this device: the sign-in page with the notice, and no local database. Signing in again asked for
  the branch, and My devices then listed the new device as "This device" and Front desk PC as revoked;
- asked the API what it holds: two active devices, two revoked, and audit rows for `device.renamed`, `device.moved`
  and `device.revoked` (twice), next to the four `device.registered` rows of 18a.

No error was thrown in either page. The script ran four times in all. The first time, it failed after B was set up:
right after A reloaded My devices, the click on B's row menu did not show the menu's items within 30 seconds, while
the machine's load was near 20 and the script still waited only 5 seconds for each check. With a 20 second wait the
script then passed three times in a row, and the end-to-end tests open the same menu in every run (18c.7 ran them
three times over). We did not find
a cause in the code; if a row's menu ever does not open for you right after a page loads, tell me, and we look again.

The COMMANDS.md queries of 18c.9 ran on the database this run left behind.

### Every check once

Then run the whole checklist (at the end of this guide) once. Each part ran only its own package's checks; this is
the first time everything runs together.

Every check passed, with the turbo cache bypassed (`--force`): `pnpm dedupe --check`, `pnpm lint`, `pnpm format`,
`pnpm typecheck`, `pnpm test` (656 — 15 new: 9 in the contracts, 1 in `packages/auth`, 3 in `packages/sync`, 2 in
the app), `pnpm build`, `pnpm test:bundle-size` (first load 209.9 KB gz, budget 210; the largest lazy chunks the
debit note lines, 107.9 KB, the quotation form, 106.7, the AppShell, 106.3, and the Devices page, 105.7, budget
110), `pnpm test:openapi`, `pnpm boundaries`, `pnpm test:integration` (553 — 20 new) and `pnpm test:tenant-leak`
(111 — 2 new). The API suites ran with `--maxWorkers=3`, in 3 minutes and 81 seconds.

The end-to-end suite ran its 290 tests once on 4 workers, in 14 minutes, with the machine's load between 13 and 20:
288 passed, the sort test was skipped on the phone (as it should be), and one bills test (paying a bill, step 17c)
ran past the 30 second limit. Run again with `--last-failed --workers=2`, it passed in 23 seconds. None of the
device tests failed.

The console override in 18c.10's step 7 was tried in a browser too, against the mock API: two days ahead, the
sidebar said "Last synced 2 days ago"; eight days ahead, the customer form showed the notice and no "Save on this
device"; with the clock put back and the network on, the sidebar said "Online" again.

If a test times out on your machine, run
`pnpm --filter @omnivo/app exec playwright test -c e2e/playwright.config.ts --last-failed --workers=2` before
looking for a bug. For the API suites, run them with fewer workers:
`cd apps/api && npx vitest run .int.spec --maxWorkers=2`.

---

## 18c.9 — Doc updates

After you implement this (ask me and I can do these):

**CLAUDE.md** — in "Components", after "Device branch dialog", add these entries. The design system lists every
pattern, and a pattern that is not listed there does not exist for the next screen (step 20's POS registers will
show up in these lists):

> - **Device lists (My devices, Devices):** a data table (cards on a phone) with no row click; a row's actions are a
>   menu (`MoreHorizontal` icon button, "Actions for Front desk PC"): Rename, Change branch (only on this device's
>   row, with its copy ready) and Revoke; a revoked device has no menu. The first column is a 30px `brand-soft` tile
>   with a `ComputerPhoneSync` icon, the name, a `brand` "This device" pill (`ComputerCheck`) on this browser's row,
>   and for a revoked one "Revoked by Nusrat Jahan · " and the date and time in 12px `ink-3`. Columns: device, person
>   (workspace list only), branch, last synced ("Never synced"), status. My devices is in the account menu, for
>   everyone; Devices is in the Workspace group with `core.device.manage`, with a search (device or person), a
>   branch select and an Active / Revoked segmented control, sorted on the server by name or last sync.
> - **Device status pills:** Active (`good`, `CheckmarkCircle02`), "Not synced for 3 days" (`warn`, `Time04`, in
>   Active's place 24 hours after the last sync), Revoked (neutral, `ComputerRemove`).
> - **Device dialogs:** Rename (one name box), Change branch (only on this device: the copy of the old branch is
>   deleted and the new one copied; a neutral notice and a disabled button while offline, or while changes wait,
>   with a Sync link; the select leaves out the current branch), Revoke (says it stops syncing and signs out at
>   once, that changes not synced on it are lost, and that a revoked device cannot be restored; on this device it
>   says how many changes wait). Cancel (secondary) and "Revoke device" (primary).
> - **Revoked sign-out:** a device that finds out it was revoked deletes its copy and signs out; the sign-in page
>   then shows a neutral document notice, "This device was revoked, so its data was deleted and you were signed
>   out.", until the next sign-in, which asks the branch again (a new device).

In the same section, change the end of "Sync line (sidebar)" (after "...the refused ones in `crit`."):

> 24 hours after the last sync, "Last synced 2 days ago" in `warn` takes the place of the words (the icon still says
> online or offline), unless it is syncing. Its accessible name is the whole sentence ("Sync: Offline, Last synced 2
> days ago, 2 changes waiting").

In "Device mode on a form", add at the end:

> 7 days after the last sync, offline, the notice is `warn` and says the device can't save new work offline, and
> there is no save button. The changes already waiting still go when the connection is back.

In "Sync page (`/sync`)", after the "Last synced …" line, add:

> 24 hours after the last sync it says "Last synced 2 days ago", with a `warn` document notice under it (what may be
> out of date); after 7 days the notice says that new work stops until the device syncs.

In "Document notice", add the device to the `warn` list ("...or a bill whose prices differ from its orders, a device
that has not synced for 24 hours or 7 days, or an `ArrowTurnBackward` icon..."), and add a sentence at the end: "It
is `DocumentNotice` in `apps/app/src/components/document-notice.tsx` (since 18c; the sign-in page uses it, so it may
not import any module's code)."

These entries were checked against the code: every icon, tone and text above is what 18c.6 renders.

**system-design.bn.md** — in "৭.২ আর্কিটেকচার", under "২. **Pull**", replace the last sentence of the third bullet
("প্রতিটা ব্রাউজার একটা device, একটা ব্রাঞ্চে।") with:

> প্রতিটা ব্রাউজার একটা device, একটা ব্রাঞ্চে। ব্রাঞ্চ বদলানো যায় শুধু ওই ডিভাইস থেকেই, অনলাইনে, যখন কোনো পরিবর্তন
> পাঠানো বাকি নেই: পুরনো কপি মুছে নতুন ব্রাঞ্চ পুরোটা কপি হয়।

In "৭.৪ অফলাইনের বিশেষ সমস্যা ও সমাধান", the solutions of four rows change to what was built (decisions 3, 12,
24, 27 and 31):

| Row | New "সমাধান" |
|---|---|
| দাম বদলেছে | বিক্রির সময়ের দামই চূড়ান্ত (লাইন আইটেমে দাম সেভ হয়)। শেষ সিঙ্কের ২৪ ঘণ্টা পরে (ডিভাইসের নিজের ঘড়িতে) সাইডবার আর Sync পাতায় `warn` সতর্কবার্তা |
| অনেক দিন অফলাইন | ৭ দিন সিঙ্ক না হলে অফলাইনে নতুন কাজ সেভ হয় না (কাস্টমার, অর্ডার)। আগে জমা পরিবর্তনগুলো কানেকশন এলে যায়, অনলাইনের কাজ আগের মতো। সীমাটা ডিভাইসের: সার্ভার অফলাইন ডিভাইস দেখতে পায় না |
| ডিভাইস চুরি / হারানো | Workspace → Devices থেকে revoke (`core.device.manage`) বা নিজের My devices থেকে: সিঙ্ক বন্ধ, ওই ব্রাউজারের sign-in শেষ, পরের যোগাযোগে কপি আর outbox মুছে যায়। বন্ধ ব্রাউজার খোলা না পর্যন্ত কপি থাকে, তাই এনক্রিপশন (Web Crypto) আর লোকাল PIN লক ধাপ ১৯-এ |
| সময়ের গরমিল | ডিভাইসের ঘড়ি merge-এ দেখা হয় না: সার্ভারে যেটা পরে পৌঁছায় সেটা জেতে। ঘড়ি শুধু ২৪ ঘণ্টা / ৭ দিনের হিসাবে লাগে, আর সেটা ওই ডিভাইসের নিজের ঘড়িতে শুরু আর শেষ দুটোই মাপা |

**build-plan.bn.md** — in "ধাপ ১৮", the line "**তিনটা গাইডে:** ১৮a pull, ১৮b push, ১৮c conflict + device list + sync
status।" becomes "**তিনটা গাইডে:** ১৮a pull, ১৮b push + conflict + sync status, ১৮c device list + revoke + সময়ের
সীমা।" (conflicts and the sync status were built in 18b), and the "**১৮c:**" bullet becomes:

> - **Devices (১৮c):** My devices (account menu, সবার) আর Workspace → Devices (`core.device.manage`): নাম বদল,
>   revoke (সিঙ্ক বন্ধ + sign-in শেষ + কপি মুছে ফেলা; আবার sign-in = নতুন device), ব্রাঞ্চ বদল শুধু ওই ডিভাইস থেকে,
>   outbox খালি থাকলে। সদস্য সরালে তার device revoke; device থাকা ব্রাঞ্চ archive হয় না। ২৪ ঘণ্টা পরে সতর্কবার্তা,
>   ৭ দিন পরে অফলাইনে নতুন কাজ বন্ধ।

**COMMANDS.md** — in "Look at the data", after the devices query, add these three. They answer "who revoked this
phone", "which devices are falling behind" and "did a revoke really sign it out" (decisions 3, 12 and 14):

```bash
# the last 20 revoked devices: whose, who revoked them, and when
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, d.name, u.email AS person, r.email AS revoked_by, d.revoked_at FROM devices d JOIN users u ON u.id = d.user_id LEFT JOIN users r ON r.id = d.revoked_by JOIN tenants t ON t.id = d.tenant_id WHERE d.revoked_at IS NOT NULL ORDER BY d.revoked_at DESC LIMIT 20"
# active devices that have not finished a pull for 7 days, or never did (server time; the device's own block uses its clock)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, d.name, u.email, b.name AS branch, d.last_sync_at FROM devices d JOIN users u ON u.id = d.user_id JOIN branches b ON b.tenant_id = d.tenant_id AND b.id = d.branch_id JOIN tenants t ON t.id = d.tenant_id WHERE d.revoked_at IS NULL AND (d.last_sync_at IS NULL OR d.last_sync_at < now() - interval '7 days') ORDER BY t.slug, d.last_sync_at NULLS FIRST"
# revoked devices whose sign-in still exists (should print nothing; a revoke deletes it in the same transaction)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, d.name, d.revoked_at FROM devices d JOIN sessions s ON s.id = d.session_id JOIN tenants t ON t.id = d.tenant_id WHERE d.revoked_at IS NOT NULL"
```

The three queries were run on the database of 18c.8's run of the app: the first listed the revoked devices with the
owner as the one who revoked them, the third printed nothing, and the second printed nothing until one device's last
sync was set 8 days back by hand; then it listed that device.

---

## 18c.10 — Run it

```bash
pnpm install                                  # no new dependency; the workspace links stay the same
pnpm db:migrate                               # 0047 + 0048: devices.session_id, revoked_by, the revoke rules
pnpm gen:openapi                              # commit it
pnpm dev                                      # restart it: the new routes, and the access token's sid claim
```

The access token now must say its sign-in (`sid`, decision 16). A tab that was open before the restart holds a token
without it: its next call gets 401, the app refreshes once and carries on. Nobody is signed out.

In `pnpm db:psql`:

```sql
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'devices' AND column_name IN ('session_id', 'revoked_by');        -- 2 rows
SELECT tgname FROM pg_trigger WHERE tgname = 'devices_guard';                         -- devices_guard
SELECT key FROM permissions WHERE key = 'core.device.manage';                         -- core.device.manage
```

Devices registered before this step have no `session_id` until their next pull, and a device revoked by hand
before has no `revoked_by` (the list then shows only the time).

### What you will see

1. **My devices:** the account menu → "My devices". This browser is there with "This device", its branch and the
   last sync. Rename it ("Front desk PC"): the toast, and the new name in the list and in the audit log.
2. **A second browser:** sign in on another browser (or a private window) and choose a branch. In the first one,
   reload My devices: the second device is there. Its menu has Rename and Revoke, but no Change branch.
3. **Revoke the other one:** the dialog says what happens. After it, the row says "Revoked by …", and this browser
   is still signed in. In the second browser, open Sync and press "Sync now": it shows the sign-in page with "This
   device was revoked…", and DevTools → Application → IndexedDB has no `omnivo-` database left. Sign in there
   again: the branch is asked again, a new device.
4. **Workspace → Devices** (owner, or a role with `core.device.manage`): every device of the workspace, with the
   person. Search by a person's name, filter by branch, open the Revoked tab, sort by "Last synced" (the devices
   that never synced first). Without the permission the sidebar has no Devices, and `/devices` says you can't see
   them.
5. **Change branch:** on this device's row, while something waits in the Sync page, the dialog says to sync first.
   With nothing waiting: pick another branch, and the copy of the new branch is made; Products shows that branch's
   stock.
6. **A branch with devices:** Branches → that branch → Archive: "Active devices in this branch: 1." Revoke or move
   the device first.
7. **The limits:** the app reads the time only through `Date.now()`, so the quickest way is to move that. Turn
   the network off first (DevTools → Network → Offline), or the next pull would count as a fresh sync. Then, in
   the DevTools console:

   ```js
   // keep the real clock once, then run the app's clock 2 days ahead
   window.realNow ??= Date.now;
   Date.now = () => realNow() + 2 * 24 * 60 * 60 * 1000;
   ```

   Within a minute (the sync line's clock ticks once a minute) the sidebar says "Last synced 2 days ago" in amber,
   and the Sync page warns. Run it again with `8 *` instead of `2 *`: the customer and order forms say the device
   can't save new work offline, with no "Save on this device". Put the clock back with `Date.now = realNow`, turn
   the network on, and the next pull clears it.
8. **Revoke this device:** the dialog says the data here is deleted. You land on the sign-in page with the notice.
9. **Removing a member:** in Team, remove someone who has a device: their device is Revoked in Workspace → Devices,
   revoked by you.
10. **Bangla** and **390px:** both lists become cards, the menus and dialogs fit, and no page scrolls sideways.

---

## Checklist

```bash
pnpm dedupe --check
pnpm lint
pnpm format
pnpm typecheck
pnpm test                    # 656: contracts 291 + api 123 + app 144 + sync 60 + ui 19 + i18n 11 + auth 8
pnpm test:integration        # 553 — 20 new
pnpm test:tenant-leak        # 111 — 2 new
pnpm test:e2e                # 290: 145 flows × desktop and 390px (the sort test is skipped on the phone)
pnpm build
pnpm test:bundle-size        # first load 209.9 KB gz (budget 210); debit note lines 107.9, quotation form 106.7 (110)
pnpm test:openapi
pnpm boundaries
```

## What we found on the way

All of these are fixed in the guide — if you get stuck at the same place, you will recognise it:

- **Two older API tests revoked a device by hand** (18c.2): they set `revoked_at` alone, and 18c.2's trigger now
  wants to know who revoked it (`devices_revoked_by_required`). They set `revoked_by` too now.
- **The access token did not know its sign-in** (18c.3): a revoke must end the device's sign-in, and the API had no
  way to tell which sign-in a call came from. The token got a `sid` claim (decision 16).
- **No bug in the API's device code** (18c.4): the tests broke four of its rules on purpose (no `CASE` in the end of
  a pull, a key in milliseconds, no session delete, no `keepSession` on register), and tests failed each time.
- **The device pages were over the bundle budget** (18c.6): 130 KB at first, because `DocumentNotice`,
  `useTenantId` and `useTimeZone` lived in files that bring every module's schemas. They moved to small files of
  their own (decision 34), and the old files re-export them.
- **The branch dialog lost the number in an error** (18c.7): it showed "Active devices in this branch: {{count}}",
  because the alert translated the error code without its values. `routes/branches.tsx` now sends the translated
  text.

---

## Notes left for later steps

**Step 19 (PWA):**

- **A revoked device that never opens again keeps its copy** (decision 27). The server cannot reach a closed
  browser. Step 19's encryption and PIN lock are what protect that copy; the revoke then only has to make sure the
  key is never handed out again.
- **The first load is at 209.9 KB of 210.** The words of 18c.5 used the last of it. The next thing that goes into
  the first load needs room first: step 19, which adds the service worker's registration to the first load, is
  the time to look at what the first load carries.
- **The 7-day block trusts the device's clock and the app's code** (decision 24). A person who sets the computer's
  clock back gets more offline days. That is accepted: the server still checks every command at arrival with the
  roles of now. If it ever matters, the push could refuse commands saved more than 7 days after the device's last
  pull, by the server's own times.

**Step 20 (POS):**

- **A POS register is a device.** Its number series (`POS1-000123`, build plan) belongs to the device row. Revoking a
  register should end its series, and a new register gets a new one: never reuse a revoked device's numbers.
- **Who may revoke a register:** `core.device.manage` covers it now. If shop managers should revoke registers but not
  phones, step 20 needs a second permission, not a change of this one.

**Notes for any step:**

- **Every access token must carry `sid`** (decision 16). A new way to sign in (an API key, a single sign-on) must
  issue tokens through `issueTokens()`, or the API refuses them.
- **The 18b note on a revoked device's waiting changes is half done:** the revoke dialog says how many changes wait
  only for this device. For another device the server cannot know; `sync_commands` knows only what arrived.
- **A device row is final once revoked** (decision 14, the trigger). A later column on `devices` that must change
  after a revoke has to be added to the trigger's list of columns that may still change.
