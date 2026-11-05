# Step 19b: The app on the device, part 2 — the encrypted copy and the device PIN

> The implementation guide for "Phase 6 → Step 19", the second of two parts, of [build-plan.bn.md](build-plan.bn.md):
> which file gets what code, and which command runs where. Step 19 (the PWA shell) is split into two guides:
> [19a](step-19a-pwa-shell.en.md) (the service worker, installing, updates, and opening the app offline) and this one
> (encrypting the copy on the device, and the PIN that opens it).

> Every file in this guide was placed in a separate copy of the repo (on top of commit `3bca857`, your commit named
> "offline support provided": 19a's code and its doc updates) and checked from 2026-10-26 to 2026-10-27: `pnpm
> dedupe --check`, `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test` (722 — 41 new), `pnpm
> test:integration` (559 — 6 new), `pnpm test:tenant-leak` (112 — 1 new), `pnpm build`, `pnpm test:bundle-size`
> (first load 213.8 KB gz, budget 215; the worker's list 389 files, 1335.4 KB gz, budget 2 MB), `pnpm test:openapi`,
> `pnpm boundaries`, `pnpm test:e2e` (Playwright on the mocks, 320 — 14 new) and `pnpm test:e2e:pwa` (the worker on
> a production build, 4 — 1 new) — with the turbo cache bypassed (`--force`).
>
> Also checked:
>
> - **The sealed copy on its own** (19b.1): a live read that follows a row across a Web Crypto call, the `marks`
>   counter, and a break of each on purpose.
> - **The server's key on Postgres** (19b.2): migration 0050 run again as `omnivo_migrator` on a database that had
>   0049 only, the check that pairs a key with an active device, and a revoke racing the key's read.
> - **The PIN in the mock app** (19b.5): the PIN's e2e file three times in a row, and the bugs it found put back on
>   purpose, one at a time.
> - **The app against the real API in a browser** (19b.6): the PIN at the set-up, nothing readable in IndexedDB, an
>   offline reload with a wrong and a right PIN, a sealed change sent when the connection came back, "Lock now"
>   across a reload, five wrong PINs, and a device revoked while offline.
> - **10,000 products and 10,000 customers in a browser** (19b.6): the first opening, a reload, a search, and an
>   offline reload with the PIN, timed.

## Goal

🔒 **A lost laptop does not give away the customer list.** After step 19a, a device keeps its branch's products,
customers, prices and stock, and the work saved offline, and it opens all of it after a reload with no connection.
That copy sits in the browser's IndexedDB in plain JSON. Anyone who has the computer for a minute can open the
browser's tools and read every customer's phone number, credit limit and address, or copy the whole database to a USB
stick. A shop computer that two people share, a sales officer's phone left in a rickshaw, a laptop taken home by
someone who left the company: each of them is a copy of the workspace's customer list.

After this step:

- **The copy is encrypted.** Every row the device keeps (products, prices, stock, customers, the changes waiting to
  be sent) is sealed with a key that is not on the disk in a usable form. The browser's tools show only bytes.
- **Online, nothing changes for the person.** After the sign-in, the server gives the device its own key, and that
  key opens the copy. No PIN is asked.
- **Offline, a six-digit device PIN opens it.** The sales officer in Sylhet who reloads the app at a pharmacy with no
  signal types their PIN, and sees their products and customers as before. Five wrong PINs and the PIN stops working
  until the next sign-in with the password.
- **"Lock now"** in the account menu hides the app behind the lock screen until the PIN is typed, also after a reload.
- **Revoking a device closes its copy for good.** The server deletes the device's key; the copy can then be opened
  only with the PIN, and only until the device next reaches the server, which deletes it.

## The whole picture

```
the server (19b.2)   devices.secret: 32 random bytes per active device, made by the database, NULL once revoked
      │              GET /sync/devices/:id/key → only the device's own person, only while it is active, no-store
      ▼
the data key         one random AES-GCM key per copy (19b.1), never on the disk in a usable form, wrapped twice:
      │                by the server's key   → every online opening, no PIN
      │                by the PIN's key      → PBKDF2, 600,000 rounds: an offline reload, after "Lock now"
      ▼
the copy (19b.1)     every row { key, gen, box } + the ids an index needs; box = AES-GCM of the row's JSON,
      │              bound to its table and key · LocalCopy: the open key + products and customers in memory
      ▼
the app (19b.4)      AppFrame: the lock screen or the shell · the PIN dialog after the set-up ·
                     the Sync page's "Device PIN" card · "Lock now" in the account menu

the Sylhet route, a Thursday:
  09:10  at the office: the sign-in; the server's key opens the copy; "Set a PIN for this device" → 480915
  11:40  at Sylhet Pharmacy, no signal, the browser reloads the tab: "Omnivo is locked" → 480915 →
           products, customers and prices as before; a new customer → the outbox, sealed
  13:00  lunch at a tea stall: "Lock now"; the laptop shows only the lock screen, also after a reload
  14:05  back on the network: the outbox is sent; nothing else changes for her
  18:20  the laptop is left in a rickshaw. The head office revokes it: the server deletes its key.
           Whoever finds it sees bytes in IndexedDB and a lock screen; 5 wrong PINs and the PIN stops.
           The first time it reaches the server, it deletes the copy.
```

## Not in this step, on purpose

- **Locking after some idle time.** "Lock now" and the lock on an offline reload are all for now; locking after 15
  minutes without use belongs to step 20 (POS), with the cashier's shift.
- **A PIN that cannot be guessed from a copied database.** The PIN guards the copy in the app. Someone who copies the
  whole database off the computer can try all one million PINs on their own machine, outside the app, where no count
  of wrong PINs stops them. Decision 14 says how long that takes and why the design still helps.
- **Encrypting the device's identity and the cursor.** The device's id (localStorage), the pull's cursor and the
  times of the last sync stay readable: they are not the workspace's data, and the app needs them before the key
  opens.

## What changes in the code you already have

- **The device's copy (19b.1):** `packages/sync` gets four new files: `crypto.ts` (sealing and opening with Web
  Crypto), `keys.ts` (the data key, wrapped by the server's key and by the PIN), `sealed.ts` (rows to and from their
  sealed form) and `copy.ts` (`LocalCopy`: the open copy, with its key and an in-memory copy of the products and the
  customers). The database moves to version 3: sealed rows, a `keys` table, a `marks` table, and two tables that hold
  the old outbox until the key opens. Every function that reads or writes the copy now takes a `LocalCopy` instead of
  the database. The app does not type-check again until 19b.4 changes it to match.
- **The server (19b.2):** a new column `devices.secret`, the device's own key (32 random bytes made by the database),
  and a new route, `GET /sync/devices/:id/key`, that gives it to the device's person while the device is active.
  Revoking a device deletes its key in the same update; a database check makes sure no revoked device keeps one. The
  device lists stop reading the key's column. No new permission and no new error code.
- **The words (19b.3):** `packages/i18n` gets a new `pin` section (the PIN dialog, the lock screen and the Sync
  page's PIN card), two items for the account menu, two notices for the sign-in page and one for the Sync page, in
  English and Bangla. `ERROR_CODES` in `packages/contracts` gets three codes for the PIN form. Nothing else changes.
- **The app (19b.4):** the copy opens with the server's key online and with the PIN on a new lock screen otherwise.
  A new route component, `AppFrame`, shows the lock screen or the `AppShell`, and runs the device's session beside
  them. The PIN dialog follows the set-up, the Sync page gets a "Device PIN" card, and the account menu gets "Lock
  now". The sign-in page's layout moves to `AuthLayout`, so the lock screen shares it. Every page that read the device
  takes the open copy (`LocalCopy`) instead of the database. `packages/sync`'s `keys.ts` gets `pinAsked`,
  `markPinAsked` and `forgetPin` (shown in 19b.1).
- **The tests (19b.5):** a mock of the key's route, an answer to the new PIN dialog in the e2e fixture (so the
  tests of earlier steps run unchanged), two unit test files (`pin.spec.ts`, new; `offline-session.spec.ts`, with a
  real copy and its PIN), a mock e2e file for the PIN (`device-pin.e2e.ts`), and the worker's offline test opening
  the app with the PIN. `fake-indexeddb` becomes a dev dependency of `apps/app`. Three fixes in 19b.4's code that
  these tests and checks found are shown in 19b.4 (they are marked "found by 19b.5").
- **The finish (19b.6):** one line of the root `package.json`: ESLint's heap goes from 4 GB to 6 GB, because the
  whole-repo lint ran out of memory with this step's code (decision 53). Then the app against the real API in a
  browser, the 10,000-row timing, and every check once.
- **Not touched:** the API's other routes, the database's other tables, the permissions and the role templates, the
  service worker (`apps/app/sw/`) and `packages/ui`.

## The decisions behind this step

You made the first seven: 1 to 4 on 2026-10-25 (step 19's decisions 5 to 8), and 5 to 7 on 2026-10-26. The others came
up while building it; please read them with care: they are mine.

1. **One random key encrypts the copy, kept twice.** (You chose this.) It is wrapped (encrypted) by a key the server
   gives only to an active device after the sign-in, and by a key made from the PIN. Online, the server's key opens
   it with no PIN; offline, the PIN does. Forgot the PIN: sign in with the password online, then set a new one.
   Revoking a device means the server stops giving its key.
2. **Every row's data is encrypted:** products, prices, stock, customers, the outbox and the notices. (You chose
   this.) Only the ids, the generation, the barcodes and the ids the device searches by stay readable. The customer
   name index goes; the device sorts in memory.
3. **Five wrong PINs turn the offline unlock off** until the next online sign-in. (You chose this.) The copy stays,
   encrypted. The guide states the limit: a copied database can be guessed outside the app.
4. **"Lock now" in the account menu, and a lock on every offline reload.** (You chose this.) Locking after idle time is
   step 20.
5. **The PIN is asked right after the device is set up, with "Not now".** (You chose this.) A device without a PIN
   opens only online; an offline reload there shows the sign-in page with a notice that the device has no PIN. A
   "Device PIN" card on the Sync page sets or changes it later.
6. **"Lock now" survives a reload.** (You chose this.) A `locked` flag in localStorage, so a reload (online too) shows
   the lock screen. "Forgot PIN?" signs in with the password (online), then asks for a new PIN.
7. **The lock screen uses the sign-in page's layout** (the side panel), "Omnivo is locked", the person's name and
   email, one PIN field, Unlock, "Forgot PIN? Sign in with your password", and Sign out. (You chose this.)

**The device's copy (19b.1):**

8. **Web Crypto's AES-GCM with a 256-bit key, and no library.** Decision 1 named Web Crypto. It is built into every
   browser, runs in native code (with the processor's AES instructions on almost every laptop and phone made in the
   last ten years), and adds nothing to the app's download. Measured on 2026-10-26 in Node on an M-series Mac with
   10,000 product rows of 1.4 KB: sealing all of them took about 100 ms, opening and parsing them about 150 ms.
   `@noble/ciphers` 2.4 (a well-known JavaScript library) took 350 ms and 380 ms for the same AES-GCM, and 130 ms and
   160 ms for XChaCha20: not faster than Web Crypto, and one more package to download and keep up to date.
9. **Sealed before a write, opened after a read — never inside a transaction.** Web Crypto's calls return promises.
   IndexedDB commits a transaction as soon as the code inside it waits for anything that is not IndexedDB, so a
   `crypto.subtle.encrypt` inside `db.transaction(…)` would end the transaction half way, and the next write would
   fail. Every write in `packages/sync` therefore seals its rows first and then starts the transaction; every read
   takes the rows out first and opens them after.
10. **A row is `{ key, gen, box }`, plus the few ids an index needs.** `box` holds the server's row, sealed. The
    additional data (a part of the input that AES-GCM checks but does not store) is the table's name and the row's
    key, so a box copied into another row or another table does not open. The product's name and code indexes go
    (an index stores its values in plain text); the barcodes and the variant ids stay, because a scanner and a sale
    line look products up by them.
11. **The outbox keeps its routing fields readable:** the command's id and type, its status, whether it was sent, the
    customer's id, the key of the thing it changes, and its size in bytes. The push picks a batch, marks it as being
    sent and counts the outbox from these alone, inside one transaction. Everything a person typed (the command, the
    customer as they saw it, the name, the lines and total, the error) is sealed. Someone reading the disk learns how
    many commands of which kind wait, and nothing of what is in them.
12. **An in-memory copy of the products and the customers.** A list sorts and searches every row on each key press.
    With 10,000 sealed products, opening them all each time would take 150 ms or more per key. So the app keeps the
    two big tables opened in memory (`Mirror` in `copy.ts`), filled once when the copy opens and kept up to date by a
    liveQuery. A write changes a row's random iv, so only the rows with a new iv are opened again. The small tables
    (units, tax rates, price lists) and single rows are opened on each read.
13. **A list waits until the in-memory copy has caught up.** A push's answer writes a new customer and removes its
    command from the outbox in one transaction, so a list never shows it twice or not at all. The in-memory copy hears
    of that write a moment after the outbox does. So every write to the products or the customers counts up a number
    in a `marks` table in the same transaction, and a list reads that number and waits until the in-memory copy has
    read at least that far.
14. **The key's record lives in the copy's own database** (the `keys` table, one row): the data key wrapped by the
    server's key, the PIN's wrap (its salt, its rounds and the wrapped key), the count of wrong PINs, and whether too
    many wrong PINs turned the PIN off. Deleting the database (sign-out, a revoke, a move to another branch) deletes
    the key with it. The fifth wrong PIN deletes the PIN's wrap, so the copy is closed to every PIN, not only to this
    screen. **The limit:** someone who copies the database can reset the count, or test PINs on their own machine. A
    PIN has a million values, and each guess costs 600,000 rounds of PBKDF2-SHA256; one gaming graphics card does
    roughly 9 billion rounds a second, so it tries them all in about a minute. So the PIN keeps out the person at the
    screen: the colleague, the finder of a lost phone. Against a thief with time and tools, what protects the data is
    revoking the device (decision 1) as soon as it is missed.
15. **The PIN's key: PBKDF2-SHA256 with 600,000 rounds** (OWASP's advice for 2023) and a 16-byte random salt. On a
    cheap phone one guess takes about half a second, which a person at the lock screen does not notice. The rounds
    are stored with the wrap, so a later version can raise them and still open a PIN set before.
16. **The data key cannot be read out of the page.** The copy runs on a non-extractable key: no script, not even our
    own, can export its bytes. To wrap it again (a new PIN, a new server key), the code unwraps a short-lived
    extractable copy with a key it already has, the current PIN or the server's key, and drops it at once. So changing
    the PIN needs the current PIN (or the connection), which is also what decision 6 asks of the screens.
17. **When the server's key no longer opens the copy** (`key-changed`): the server's database was restored from a
    backup made before this device registered, so it made a new key. The PIN can still open the copy, and
    `renewServerKey` wraps it again for the new key. A device without a PIN cannot open it, and its copy has to be
    made again (19b.4 decides what the screen says).
18. **Version 3 empties the synced tables and pulls again.** The upgrade cannot seal (it runs in one transaction,
    which cannot wait for Web Crypto), and leaving the old rows readable would defeat the step. So the synced tables
    are emptied and the cursor is deleted: the next pull is a full one, and writes everything back sealed. The outbox
    and its notices are the person's own work and cannot be pulled again: the upgrade moves them as they are into
    `legacyOutbox` and `legacyNotices`, and the copy seals them back into the outbox, with the same order, the first
    time its key opens. Until then they are readable, for the few seconds between the update and the next opening.
19. **The in-memory copy's reads stay live.** Dexie's liveQuery knows which rows a read used by following it through
    Dexie's own promises. A read that waits for Web Crypto's promise is no longer followed after that wait, so a later
    pull would not refresh what it reads next. `unseal` wraps that one call in `Promise.resolve(…)`, the way Dexie's
    documentation says, and a test pins it (`copy.spec.ts`).
20. **Locking drops the key and the in-memory copy.** `LocalCopy.close()` forgets the data key and empties both
    in-memory tables; a read that still runs fails with "The copy is locked" instead of opening a row.

**The server (19b.2):**

21. **The database makes the key.** The column's default is `gen_random_bytes(32)` from `pgcrypto` (an extension that
    ships with Postgres and uses the operating system's secure random source). So a registration sets nothing, and a
    key never passes through the API's memory on its way in. The devices registered before this step get theirs in
    the same migration, one call per row, so no two devices share a key.
22. **"Active" and "has a key" are one fact, checked by the database.** `devices_secret_check` says: the key is
    missing exactly when the device is revoked. A revoke that forgets to delete the key fails, instead of leaving a key
    the server could still give out; and a revoked device can never get a key back. A second check holds the length
    at 32 bytes.
23. **A route of its own, not a field of the registration's answer.** The app registers once, when the device is set
    up, but needs the key at every online opening, because it must never write the key to the disk (a key next to the
    copy opens the copy). The answer has `Cache-Control: no-store`, so the browser's cache does not write it either.
24. **The key goes to the device's own person, from any of their sign-ins.** Not only from the sign-in the device
    used last: registering the same id already moves a device to a new sign-in (step 18c), and a person who is signed
    in can read the same customers online anyway. So a check of the session would add a rule and no protection. The
    key's route follows the sign-in like a pull does, so a revoke ends the sign-in in use now.
25. **No key after a revoke has answered.** The key's read locks the row `FOR SHARE`. A revoke holds it `FOR UPDATE`
    until it commits, so a key request that comes at the same moment waits, reads the row again, and answers
    `device_revoked`.
26. **No audit row for giving the key.** The app asks for it at every online opening, so the log would fill with
    rows that say nothing new. Registering and revoking stay in the log as before.
27. **The device lists read only the columns they show.** `deviceColumns` names them one by one, so a page of 50
    devices does not carry 50 keys out of the database, and a column added later stays out of every list until
    someone adds it on purpose.
28. **The contract checks for exactly 32 bytes,** as 43 base64 characters and one `=`. A length of 44 alone would let
    31 or 33 bytes through, and a shorter key would still make a (weaker) AES key on the device without any error.

**The words (19b.3):**

29. **The PIN form's rules are error codes; what a typed PIN answers is a sentence.** "Not 6 digits", "too easy" and
    "the two PINs differ" are rules the form checks before anything runs, so they are codes in `ERROR_CODES`, in the
    group the client makes itself (next to `network_error`), and the field shows them through `errorText` like every
    other form. A wrong PIN must say how many tries are left (a plural), and a PIN that stopped working says after how
    many: `errors.*` has no plurals and is shared with the API, so these two are `pin.wrong_*` and `pin.blocked`. The
    screen passes them already translated: `errorText` shows a text that is not a code as it is.
30. **Easy PINs are refused:** six of the same digit (`000000`, `777777`) and straight runs up or down (`123456`,
    `987654`). The app allows five tries, and these are the first five anyone tries on a phone they picked up.
    Refusing them costs the person one more choice. A longer list (years, `123123`) would refuse PINs people pick on
    purpose and would still not stop someone with a copied database (decision 14). The rule itself is in the app's
    schema (19b.4).
31. **"Forgot PIN?" and a PIN that stopped working end at the same sign-in, with one notice.** Both sign the person
    out with the copy kept, like 19a's `session_ended`. The password opens the copy (through the server's key), and
    then the PIN dialog asks for a new PIN. The person only needs to know what to do next, so one sentence
    (`auth.login.pinNotice`) serves both.
32. **The lock screen says why it asks.** After "Lock now", it asks for the PIN. After an offline reload the person
    locked nothing, so it says the PIN is needed because there is no connection. When the server's key no longer opens
    the copy (decision 17), it asks for the PIN "once". One screen, three descriptions.
33. **The words never say "key" or "encryption".** People need to know what the PIN does (it opens the data on this
    device without a connection) and that it stays on the device ("never sent to the server", which is true: the PIN
    is used only by Web Crypto in the page). The one message about the server's key, `sync.copyRemade`, says what
    happened to the data instead.

**The app (19b.4):**

34. **The key's row remembers that the PIN was asked** (`pinAsked`). The dialog opens after an opening with the
    server's key when the device has no PIN and the question has not had its answer. "Not now", or closing the dialog
    any way, marks it, like the branch dialog's "Not now". The fifth wrong PIN and "Forgot PIN?" clear it, so the
    dialog asks again after the next sign-in. It is a field of the key's row and not a localStorage value because the
    question belongs to this copy: a sign-out deletes the copy and its PIN, and the next copy must ask again. Devices
    from before this step make their key's row at their first online opening, so they are asked once too.
35. **"Forgot PIN?" deletes the PIN, then ends the sign-in, also on the server.** The copy stays; the password opens
    it with the server's key, and the dialog asks for a new PIN. Ending the server's session matters: with its cookie
    still valid, a reload would sign in again without the password. Deleting the PIN matters too: a PIN that its owner
    forgot only helps someone who is guessing it. Someone at the screen who clicks the link can do no more harm than
    five wrong PINs would.
36. **"Lock now" is one localStorage value for the whole browser** (`omnivo.locked`), removed by only two things: the
    right PIN and a sign-in with the password. Both prove the person. A sign-out does not remove it: another tab that
    saw it go would open its copy again. It is not per person because whoever comes next must sign in with the
    password anyway, which removes it. The session also keeps a `locked` flag in memory, so the lock holds in this
    page when the browser refuses to write localStorage (a private window); only a reload then forgets it.
37. **A move to another branch keeps the key's row.** The move deletes the old copy and pulls the new branch's
    (18c). The key's row is read before the delete and put into the new database, so the PIN still works and nobody
    is asked to set it again for the same device.
38. **The lock screen takes the shell's place: the shell is not drawn at all.** A new route component, `AppFrame`,
    shows either the lock screen or the `AppShell`, and runs the device's session (`LocalDataHost`) beside both, so
    the session lives on while the screen changes. Hiding the shell with CSS would keep every page's data in the page
    and in React's memory, readable in the browser's tools: the lock is meant to stop exactly that. The cost: a form
    left half filled is gone after "Lock now", as after a reload. It also keeps the shell's chunk under its budget
    (110 KB): the shell does not import the device's code, and the frame passes it the menu item as a prop.
39. **Online, every opening asks the server for its key, and never keeps it.** With no answer (the API is down), a
    device with a PIN shows the lock screen as if offline; one without a PIN waits for the server, as a device not set
    up does (18a's "unreachable"). A revoked device gets 18c's steps; a device the server does not know registers again
    and asks once more.
40. **Other tabs follow a lock, and an unlock opens them again only as far as they can.** "Lock now" in one tab locks
    every tab (the storage event). The right PIN in one tab removes the value; a locked tab then opens again from the
    start: with the server's key when its sign-in was checked, or back to its own lock screen when it opened offline.
41. **After an offline reload, the connection coming back opens the copy.** 19a checks the sign-in when the server
    answers again. If the lock screen is still waiting for the PIN then, the copy opens with the server's key, as every
    online opening does (decision 1). Not after "Lock now": that one waits for the PIN or the password. It also
    means that a PIN that stopped working offline is not a dead end once the connection is back and the cookie is
    still valid: decision 3's "until the next online sign-in" includes that check. (You confirmed this one on
    2026-10-27; the other way was to keep the `offline` lock until a password sign-in.)
42. **When the server's key changed and there is no PIN, the copy is deleted and pulled again** (decision 17's last
    case), with the toast `sync.copyRemade`. Waiting would help nothing: no key on any computer opens it any more. The
    toast is the one place that reaches the person wherever they are; it shows for about 3 seconds, which is short
    for that sentence, and this happens only after the server's database is restored from a backup.
43. **An offline reload without a PIN shows the sign-in page with its own notice, and the remembered `me` stays.**
    `no_pin` is not a sign-out: the server still has the sign-in, and the next online reload opens the app as before.
    Keeping `me` means the next offline reload says the same thing, not the plain "you are offline". Checking for a PIN
    there needs the device's database, so 19a's offline-session chunk now brings Dexie; only an offline reload loads it.
44. **The card and the menu read the PIN's state from the store, filled by the session.** The session already watches
    the outbox and the pull for the sidebar; it watches the key's row the same way. A page that read the row itself
    would bring `keys.ts` into the chunk of every page that reads the device (products, customers, every sales form),
    which took the debit note's lines over the 110 KB budget.
45. **The PIN box is the ordinary input, masked, with a number pad,** and it keeps only what `pinDigits` lets in: ASCII
    digits, at most six, Bangla digits turned into ASCII ones. `autoComplete="off"`: a password manager must not offer
    to save the device PIN as the site's password. The lock screen checks only the format; the "too easy" rule
    (decision 30) is the dialog's, for a new PIN.
46. **A fifth wrong current PIN in the change dialog turns it into the new-PIN dialog.** The PIN is off by then
    (keys.ts), and the person is online and signed in, so the server's key can set a new one at once. The dialog says
    why ("The old PIN no longer works").
47. **The sign-in page's layout moved to `AuthLayout`,** shared by the lock screen (decision 7), so the two never drift
    apart. The lock screen shows the person's name and email in a plain bordered box, with no icon and no avatar: the
    screen says whose work is locked, and nothing more about the workspace.

48. **The e2e fixture answers the PIN dialog "Not now" by itself.** The first opening of every copy asks for a PIN
    (decision 5), so every e2e test of steps 18 and before would meet a dialog it never expected. Playwright's locator
    handler (`page.addLocatorHandler`) closes it whenever it shows, before the test's next action or assertion, so
    those tests stay as they were. The PIN's own tests turn it off (`answerPinDialog: false`). The other way, a seeded
    key row with `pinAsked`, would need the key's format in the fixture, and the row is in IndexedDB, which an init
    script cannot fill before the app opens it. The cost: the dialog opens at a moment the test does not choose, and
    it closes a menu or a panel that was open. The three tests that open one right after the first load wait for the
    copy first (the dialog has shown by then), and the branch test, where the dialog always follows the branch,
    answers it itself.
49. **The mock's key is worked out from the device's id** (SHA-256), not random like the API's. The mock's data
    starts again at every reload, so a random key would be a new one each time: the app would see `key-changed` at
    every reload, ask for the PIN or delete the copy, and no test could reload.
50. **The app's unit tests open real copies in `fake-indexeddb`**, made by `@omnivo/sync`'s own `openKey` and
    `setPin` with 1,000 rounds (the row keeps its count, so the code reads it like any other). A `vi.mock` of
    `keyStatus` would test less: whether a copy with a PIN opens, a blocked one too, and one without does not, is
    the point of decision 5.
51. **The worker's offline test puts a key row made in Node into the page's IndexedDB.** That build's API never
    answers (19a's decision 42), so no sign-in can set a PIN there. The row is made by `@omnivo/sync` itself (in
    `fake-indexeddb`), so its format is written in one place, and the built app opens it with the PIN as it would
    one it made.
52. **The PIN's e2e file has a 90-second timeout.** Each PIN typed or set costs up to a second on purpose (decision
    15), a test types up to seven, and the mock copies 10,000 styles meanwhile. With 30 seconds, the file failed 5
    times in 18 runs on a busy machine; with 90, none.

53. **ESLint gets a 6 GB heap.** With this step's code, the whole-repo lint ran out of its 4 GB heap (step 13's
    decision 16) every time; the code before this step still fits. 6 GB passes in about 90 seconds, and CI's runners
    have 16 GB. Linting each package on its own would need less, but it changes the command you and CI run; that is
    worth doing the next time the heap runs out (see the notes at the end).

## 19b.1 — `packages/sync`: the sealed copy

This part changes only `packages/sync`. It adds the encryption and the key, moves the database to version 3, and
changes every read and write of the copy to seal and open its rows. After it, every function that touches the copy
takes a `LocalCopy` (the open copy: the database plus its key) instead of the `SyncDatabase`.

**The app does not type-check after this part.** Twelve files in `apps/app` still pass the database where a
`LocalCopy` is now needed: `lib/local-session.ts`, `lib/local-data.ts`, six routes (`products.tsx`, `customers.tsx`,
`customer-edit.tsx`, `sales-order.tsx`, `sales-orders.tsx`, `sync.tsx`) and four components (`customer-form.tsx`,
`party-picker.tsx`, `product-picker.tsx`, `sales-order-form.tsx`). 19b.4 changes them. Run only the sync package's
checks until then (see "Check this part").

### `crypto.ts` (new): sealing, opening and wrapping

```ts
// Step 19b: the cryptography of the device's copy, on the browser's own Web Crypto (no library).
// A random data key seals every row (AES-GCM, 256 bits). The data key itself is kept only wrapped:
// once by a key the server gives an active device, once by a key made from the person's PIN
// (keys.ts). No Dexie here: the lock screen and the PIN dialog import this file.

const IV_BYTES = 12;

// PBKDF2-SHA256 rounds for a PIN (OWASP's 2023 advice). A PIN has only a million values, so the
// rounds make each guess slow: about half a second on a cheap phone, on purpose.
export const PIN_ITERATIONS = 600_000;
const SALT_BYTES = 16;
export const PIN_LENGTH = 6;

declare const sealedValue: unique symbol;

// Sealed bytes of a T: a 12-byte iv, then AES-GCM's ciphertext and tag. The type parameter is only
// for the reader (unseal gives back a T); the bytes do not carry it. The property is optional and
// never set, so plain bytes from IndexedDB fit the type.
export type Box<T> = Uint8Array<ArrayBuffer> & { readonly [sealedValue]?: T };

const DATA_KEY = { name: 'AES-GCM', length: 256 } as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function joined(iv: Uint8Array<ArrayBuffer>, body: ArrayBuffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(iv.length + body.byteLength);
  out.set(iv);
  out.set(new Uint8Array(body), iv.length);
  return out;
}

function newIv(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(IV_BYTES));
}

// The first 12 bytes of a box: a new random iv for every seal, so a row written again has a new
// one. The in-memory copy (copy.ts) tells a changed row by it without opening it.
export function ivOf(box: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  return box.slice(0, IV_BYTES);
}

// `label` is the additional data: where the row lives ("products\n<id>"). It is not stored, but
// the tag covers it, so a box copied to another row or another table no longer opens.
export async function seal<T>(key: CryptoKey, label: string, value: T): Promise<Box<T>> {
  const iv = newIv();
  const body = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(label) },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  return joined(iv, body);
}

// Throws when the key, the label or a single byte is wrong (AES-GCM checks the tag).
export async function unseal<T>(key: CryptoKey, label: string, box: Box<T>): Promise<T> {
  // Promise.resolve: Dexie's liveQuery follows the reads of a query through Dexie's own promises
  // only. A query that awaits Web Crypto's promise as it is stops being followed after it, so a
  // pull would no longer refresh what it reads next. Wrapped, the await stays inside Dexie's zone.
  // Every read of the copy opens its rows here, so this is the one place that needs it.
  const plain = await Promise.resolve(
    crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: box.subarray(0, IV_BYTES), additionalData: encoder.encode(label) },
      key,
      box.subarray(IV_BYTES),
    ),
  );
  const value: unknown = JSON.parse(decoder.decode(plain));
  // The one cast of the copy. The bytes are what seal() made from a T under this label: the tag
  // proves it, so a changed or moved box throws above instead of reaching here. Dexie's typed
  // tables trusted the stored rows the same way before step 19b.
  return value as T;
}

// A new data key. Extractable only so it can be wrapped right now; the copy runs on a
// non-extractable one, unwrapped again (keys.ts).
export function newDataKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(DATA_KEY, true, ['encrypt', 'decrypt']);
}

export async function wrapDataKey(
  dataKey: CryptoKey,
  wrapping: CryptoKey,
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = newIv();
  const body = await crypto.subtle.wrapKey('raw', dataKey, wrapping, { name: 'AES-GCM', iv });
  return joined(iv, body);
}

// null = this wrapping key does not open it (a wrong PIN, another server key). Any other error
// is a real failure, and goes up.
export async function unwrapDataKey(
  wrapped: Uint8Array<ArrayBuffer>,
  wrapping: CryptoKey,
  extractable: boolean,
): Promise<CryptoKey | null> {
  try {
    return await crypto.subtle.unwrapKey(
      'raw',
      wrapped.subarray(IV_BYTES),
      wrapping,
      { name: 'AES-GCM', iv: wrapped.subarray(0, IV_BYTES) },
      DATA_KEY,
      extractable,
      ['encrypt', 'decrypt'],
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === 'OperationError') return null;
    throw error;
  }
}

// The 32 bytes the server keeps for this device (step 19b.2), as a key that only wraps
export function serverWrappingKey(bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (bytes.length !== 32) throw new Error('A device key is 32 bytes');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['wrapKey', 'unwrapKey']);
}

export function newSalt(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

export async function pinWrappingKey(
  pin: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    DATA_KEY,
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

// PIN_LENGTH ASCII digits. The app turns Bangla digits into these first (the money input's rule).
export function isPin(value: string): boolean {
  return value.length === PIN_LENGTH && /^[0-9]+$/.test(value);
}
```

- **No Dexie in this file.** The lock screen and the PIN dialog (19b.4) import it, and they must stay small. The sync
  package's rule (see `index.ts`) is that a module a page imports never loads Dexie.
- **`PIN_ITERATIONS = 600_000`.** Decision 15. A PIN has only a million values, so its strength comes from making
  each guess slow; 600,000 rounds of PBKDF2-SHA256 is OWASP's number for 2023.
- **`Box<T>` is bytes with a type label.** A box is a plain `Uint8Array`: the 12-byte iv, then AES-GCM's output. The
  `[sealedValue]?: T` property is never set; it exists only so that `unseal` on a `Box<Product>` gives back a
  `Product`, with no type written at the call. It is optional, so the bytes IndexedDB gives back fit the type as they
  are. `declare const … unique symbol` makes the property's name one no other code can use.
- **`Uint8Array<ArrayBuffer>`, not plain `Uint8Array`.** In the TypeScript this repo uses (6.0), Web Crypto's functions
  take only arrays backed by an `ArrayBuffer` (not a `SharedArrayBuffer`). A plain `Uint8Array` might be either, and
  the type check refuses it. Every
  array this file makes is `new Uint8Array(n)`, which is the right kind.
- **`joined` puts the iv in front of the output.** AES-GCM needs the same iv to open what it sealed, and the iv is not
  secret, so it is stored with the box. One array per box keeps the rows small and their type simple.
- **A new random iv for every seal.** AES-GCM is broken if one key seals two values with the same iv. With 12 random
  bytes, NIST allows 2³² (about four billion) seals under one key; a device seals a few hundred thousand rows in a year
  of pulls, and every sign-out starts a new key. A new iv also means a row written again looks different on the disk, which `ivOf` uses: the
  in-memory copy tells a changed row by its iv, without opening it (decision 12).
- **`ivOf` copies with `slice`, not `subarray`.** `subarray` would keep a view of the whole box in memory for as long
  as the in-memory copy keeps the iv; `slice` keeps only the 12 bytes.
- **`seal` takes a `label`.** It goes in as `additionalData`: AES-GCM does not encrypt or store it, but its tag
  covers it. The label is the table and the row's key (`copy.ts`), so a box copied by hand from one customer to
  another, or from `customers` to `products`, fails to open instead of showing one customer's data under another's
  name.
- **The value is sealed as JSON.** Every row is the server's JSON (or the outbox's command, also JSON), so
  `JSON.stringify` and `JSON.parse` give back exactly what went in. The structured clone that IndexedDB uses cannot
  be encrypted directly: AES-GCM needs bytes.
- **`unseal` wraps Web Crypto's promise in `Promise.resolve`.** Decision 19. Inside a liveQuery, Dexie puts its own
  `Promise` in place of the global one, and follows a read through those promises. Web Crypto makes its promises in
  native code, not through the global `Promise`, so after `await crypto.subtle.decrypt(…)` Dexie would stop
  following the read: a later pull would not run it again. `Promise.resolve(…)` turns it into one of Dexie's
  promises. Every read of the copy opens its rows through `unseal`, so this is the only place that needs it.
- **`unseal` throws on a wrong key, a wrong label or one changed byte.** AES-GCM checks its 16-byte tag before it
  returns anything, so tampered data never reaches `JSON.parse`.
- **The one `as T` cast.** `JSON.parse` returns `any`; it goes into an `unknown` first (rule 3), and is then cast. The
  cast is safe for the reason in the comment: the tag proves these are the exact bytes `seal` made from a `T` under
  this label. Before step 19b, Dexie's typed tables trusted the stored rows in the same way, without checking them.
  Checking every product with Zod would cost more than opening it.
- **`newDataKey` makes an extractable key.** Only an extractable key can be wrapped (`wrapKey` exports its bytes,
  encrypted). It is wrapped right after it is made and then dropped; the copy runs on a non-extractable key unwrapped
  from the wrap (decision 16, `keys.ts`).
- **`wrapDataKey` uses AES-GCM too,** with its own random iv in front, like a box. Web Crypto also has AES-KW, made
  for wrapping keys, but it needs no iv only because it is deterministic; AES-GCM is already in use here, and one
  algorithm keeps the code smaller.
- **`unwrapDataKey` returns `null` for a key that does not fit.** A wrong PIN and an old server key both end in AES-GCM's
  tag check failing, which Web Crypto reports as a `DOMException` named `OperationError`. That is an expected answer
  (the person typed a wrong PIN), not a bug. Any other error is a real failure and goes up.
- **`serverWrappingKey` checks for 32 bytes.** AES accepts 16, 24 or 32. The server sends 32 (19b.2); a shorter key
  can only be a bug, and should fail loudly rather than quietly use a weaker key.
- **The server's and the PIN's keys only wrap** (`['wrapKey', 'unwrapKey']`). They cannot encrypt rows. A bug that
  used one of them by mistake fails instead of sealing data with the wrong key.
- **`isPin` checks the length and the digits only.** The app turns Bangla digits into ASCII before (the rule of the
  money input in CLAUDE.md); `keys.ts` refuses anything else, so a PIN from a bug never becomes the only way into a
  copy.

### `keys.ts` (new): the data key and the PIN

```ts
import {
  isPin,
  newDataKey,
  newSalt,
  PIN_ITERATIONS,
  pinWrappingKey,
  serverWrappingKey,
  unwrapDataKey,
  wrapDataKey,
} from './crypto.js';
import type { SyncDatabase } from './database.js';

// Step 19b: the device's data key, kept wrapped in the copy's own database (the `keys` table, one
// row). Deleting the database (sign-out, revoke, a move) deletes the key with it. No Dexie import:
// the lock screen opens the key through the database the session holds.

// After this many wrong PINs in a row the PIN is turned off (decision 7): only a sign-in with the
// password, online, opens the copy again, and then the person sets a new PIN.
export const MAX_WRONG_PINS = 5;

export interface PinWrap {
  salt: Uint8Array<ArrayBuffer>;
  // Kept with the wrap, so a later version of the app can raise PIN_ITERATIONS and still open a
  // PIN set before
  iterations: number;
  wrapped: Uint8Array<ArrayBuffer>;
}

export interface KeyRecord {
  key: 'data';
  // The data key wrapped by the server's key for this device
  server: Uint8Array<ArrayBuffer>;
  // The data key wrapped by the PIN's key. null = no PIN on this device.
  pin: PinWrap | null;
  // Wrong PINs since the last right one. Clear, like the rest of this row: someone who copies the
  // database can reset it, but they can also guess outside the app, which no count stops (the
  // limit the guide states). The count stops a person at the screen.
  wrongPins: number;
  // The PIN was turned off by too many wrong ones: the app asks for a new one after the sign-in
  pinBlocked: boolean;
  // The app asked for a PIN since the last one went (none yet, too many wrong, forgotten), and the
  // person answered: a PIN, or "Not now". Kept here, so a new copy (a sign-out, a revoke) asks again.
  pinAsked: boolean;
}

// What opens the data key: the server's 32 bytes (online, after sign-in), or the PIN (offline,
// and the lock screen)
export type Unlock = { serverKey: Uint8Array<ArrayBuffer> } | { pin: string };

export type KeyProblem =
  | { kind: 'wrong-pin'; left: number }
  // Too many wrong PINs: the PIN is off until a sign-in with the password
  | { kind: 'pin-blocked' }
  // No PIN on this device (never set, or "Not now"): only the server's key opens it
  | { kind: 'no-pin' }
  // The server's key does not open this copy: the server's database was restored to a time before
  // this device registered, and it got a new key. The PIN can still open it (renewServerKey).
  | { kind: 'key-changed' };

export type KeyResult = { kind: 'open'; key: CryptoKey } | KeyProblem;

// For the lock screen and the PIN card: what this device has, without opening anything
export interface KeyStatus {
  // A key was made: the copy was opened once at least
  exists: boolean;
  hasPin: boolean;
  pinBlocked: boolean;
  wrongPins: number;
  pinAsked: boolean;
}

export async function keyStatus(db: SyncDatabase): Promise<KeyStatus> {
  const record = await db.keys.get('data');
  return {
    exists: record !== undefined,
    hasPin: record?.pin != null,
    pinBlocked: record?.pinBlocked ?? false,
    wrongPins: record?.wrongPins ?? 0,
    pinAsked: record?.pinAsked ?? false,
  };
}

// The first opening with the server's key makes the data key. Two tabs may do it at once: the
// transaction keeps the first one's record, and the other tab opens that one, so both tabs end with
// the same key.
async function createRecord(db: SyncDatabase, serverKey: CryptoKey): Promise<KeyRecord> {
  const record: KeyRecord = {
    key: 'data',
    server: await wrapDataKey(await newDataKey(), serverKey),
    pin: null,
    wrongPins: 0,
    pinBlocked: false,
    pinAsked: false,
  };
  return db.transaction('rw', db.keys, async () => {
    const first = await db.keys.get('data');
    if (first) return first;
    await db.keys.add(record);
    return record;
  });
}

// One wrong PIN more, counted in a transaction, so two tabs guessing at once both count. The fifth
// deletes the PIN's wrap: the copy is then closed to every PIN, not only to this screen.
async function countWrongPin(db: SyncDatabase): Promise<KeyProblem> {
  return db.transaction('rw', db.keys, async () => {
    const record = await db.keys.get('data');
    if (!record) return { kind: 'no-pin' };
    const wrongPins = record.wrongPins + 1;
    if (wrongPins >= MAX_WRONG_PINS) {
      await db.keys.put({ ...record, pin: null, wrongPins: 0, pinBlocked: true, pinAsked: false });
      return { kind: 'pin-blocked' };
    }
    await db.keys.put({ ...record, wrongPins });
    return { kind: 'wrong-pin', left: MAX_WRONG_PINS - wrongPins };
  });
}

// `extractable` only for a moment, to wrap the key again (setPin, renewServerKey); the copy itself
// always runs on a key the page cannot read out
async function unwrapWith(
  db: SyncDatabase,
  unlock: Unlock,
  extractable: boolean,
): Promise<KeyResult> {
  let record = await db.keys.get('data');
  if ('serverKey' in unlock) {
    const wrapping = await serverWrappingKey(unlock.serverKey);
    record ??= await createRecord(db, wrapping);
    const key = await unwrapDataKey(record.server, wrapping, extractable);
    return key ? { kind: 'open', key } : { kind: 'key-changed' };
  }
  if (!record?.pin) return { kind: record?.pinBlocked ? 'pin-blocked' : 'no-pin' };
  const { salt, iterations, wrapped } = record.pin;
  const key = await unwrapDataKey(
    wrapped,
    await pinWrappingKey(unlock.pin, salt, iterations),
    extractable,
  );
  if (!key) return countWrongPin(db);
  if (record.wrongPins > 0) await db.keys.update('data', { wrongPins: 0 });
  return { kind: 'open', key };
}

export function openKey(db: SyncDatabase, unlock: Unlock): Promise<KeyResult> {
  return unwrapWith(db, unlock, false);
}

// A new PIN: at set-up and on the Sync page (with the server's key, online), after "Forgot PIN?"
// (the same), or a change (with the current PIN, which a wrong guess here counts like the lock
// screen's). `iterations` is a parameter for the specs only: 600,000 rounds per test would take
// minutes.
export async function setPin(
  db: SyncDatabase,
  unlock: Unlock,
  pin: string,
  iterations: number = PIN_ITERATIONS,
): Promise<{ kind: 'set' } | KeyProblem> {
  if (!isPin(pin)) throw new Error('A PIN is six digits');
  const opened = await unwrapWith(db, unlock, true);
  if (opened.kind !== 'open') return opened;
  const salt = newSalt();
  const wrapped = await wrapDataKey(opened.key, await pinWrappingKey(pin, salt, iterations));
  await db.keys.update('data', {
    pin: { salt, iterations, wrapped },
    wrongPins: 0,
    pinBlocked: false,
    pinAsked: true,
  });
  return { kind: 'set' };
}

// "Not now" in the PIN dialog: not asked again on this copy. The Sync page's card still sets one.
export async function markPinAsked(db: SyncDatabase): Promise<void> {
  await db.keys.update('data', { pinAsked: true });
}

// "Forgot PIN?" on the lock screen, before the sign-in with the password. A PIN nobody remembers
// opens nothing for its owner, but someone could still guess it: so it goes, and the dialog asks
// for a new one after the sign-in.
export async function forgetPin(db: SyncDatabase): Promise<void> {
  await db.keys.update('data', { pin: null, wrongPins: 0, pinAsked: false });
}

// After key-changed: the PIN opens the copy, and the data key is wrapped again with the server's
// new key, so the next online opening needs no PIN
export async function renewServerKey(
  db: SyncDatabase,
  pin: string,
  serverKey: Uint8Array<ArrayBuffer>,
): Promise<{ kind: 'set' } | KeyProblem> {
  const opened = await unwrapWith(db, { pin }, true);
  if (opened.kind !== 'open') return opened;
  const server = await wrapDataKey(opened.key, await serverWrappingKey(serverKey));
  await db.keys.update('data', { server });
  return { kind: 'set' };
}
```

- **One row, `key: 'data'`.** A device has one data key. Keeping it in the copy's database means every delete of the
  copy (sign-out, revoke, a move) also deletes the key, with no second place to forget.
- **`PinWrap.iterations` is stored.** Decision 15: a later version can raise `PIN_ITERATIONS` for new PINs and still
  open the ones set before.
- **`Unlock` is a union of the two ways in.** TypeScript narrows it with `'serverKey' in unlock`, so each branch of
  `unwrapWith` sees only its own field.
- **`KeyProblem` names every way an opening can fail,** and the app gets each as its own `kind`, not as an error:
  each needs a different screen (19b.4). `wrong-pin` carries how many tries are left, for the lock screen's message.
- **`keyStatus` reads without opening anything.** The lock screen and the Sync page's PIN card need to know whether
  the device has a PIN before they ask for one. `record?.pin != null` is true for a PinWrap and false for `null` and
  for no record; `!= null` covers both in one test.
- **`createRecord` wraps first, then decides in a transaction.** Two tabs may open a new copy at the same moment, and
  each makes its own data key. The transaction lets only the first one's record in; the second tab returns that
  record and unwraps the first tab's key. Without this, the second tab would overwrite the record, and the rows the
  first tab had already sealed could never be opened again. Wrapping happens before the transaction because a
  transaction cannot wait for Web Crypto (decision 9).
- **`countWrongPin` counts inside a transaction.** Two tabs at the lock screen could otherwise both read 3 and both
  write 4, and a person would get more tries than five.
- **The fifth wrong PIN deletes the wrap, not only the count.** Decision 14: with the wrap gone, the copy is closed to
  every PIN in this browser, even if someone resets the counter in the browser's tools. `pinBlocked: true` tells the
  app to ask for a new PIN after the next sign-in, and `pinAsked: false` makes it ask (decision 34).
- **`unwrapWith` with the server's key makes the record the first time** (`??=`). A device opens its copy online first
  (it is set up online), so the server's key is always the one that makes the data key.
- **The PIN branch reads `record?.pin` first.** With no record or no PIN there is nothing to try, and the answer says
  why: `pin-blocked` after five wrong ones, `no-pin` otherwise.
- **A right PIN starts the count again,** but writes only when the count is not already 0: an unlock should not write
  to the database every time.
- **`setPin` unwraps with `extractable: true`.** Decision 16: wrapping the data key again needs its bytes for a moment.
  The extractable key lives only inside `setPin`; `openKey` never returns one. The unlock may be the current PIN (a
  change) or the server's key (set-up, the Sync page, or after "Forgot PIN?"): a wrong current PIN counts like a wrong
  PIN at the lock screen.
- **`setPin` checks the PIN before anything else.** A bug that passed an empty string would otherwise make a PIN
  nobody can type.
- **`iterations` is a parameter only for the specs.** 600,000 rounds take about a quarter of a second in Node; the
  specs set many PINs and use 1,000. The app never passes it.
- **`renewServerKey` needs the PIN.** Decision 17: after the server's key changed, only the PIN still opens the data
  key. The new wrap replaces the old one, so the next online opening needs no PIN again.
- **`pinAsked` remembers that the PIN dialog had its answer** (decision 34). `setPin` sets it, and so does
  `markPinAsked`, which is the dialog's "Not now". It lives in the key's row, not in localStorage, so a new copy (after
  a sign-out or a revoke) starts with `false` and asks again.
- **`forgetPin` deletes the wrap and starts the question again** (decision 35). It keeps `pinBlocked` as it is: after a
  PIN that stopped working, the dialog still says why it asks.

### `database.ts`: version 3

```diff
@@ -16,33 +16,49 @@ import type {
 } from '@omnivo/contracts';
 import { Dexie, type Table } from 'dexie';
 
-// One row on the device: the row the server sent (`data`), under the key of its change, and the
-// generation of the pull that wrote it. The generation is how a full pull finds the rows it did
-// not send (apply.ts). `data` is never changed on the device: it is the server's row as it came.
-export interface Stored<T> {
+import type { Box } from './crypto.js';
+import type { KeyRecord } from './keys.js';
+
+// One row on the device (step 19b): the row the server sent, sealed (`box`), under the key of its
+// change, and the generation of the pull that wrote it. The generation is how a full pull finds the
+// rows it did not send (apply.ts). What is in the box is never changed on the device: it is the
+// server's row as it came. Only the key, the generation and a few ids an index needs stay clear.
+export interface SealedRow<T> {
   // The row's id, or priceListItemKey() / stockKey(); the settings' key is the workspace's id
   key: string;
   gen: number;
-  data: T;
+  box: Box<T>;
 }
 
-// A product with what its list needs to search and sort without opening every row: the server
-// sorts on lower(name) and lower(code), so the device does too.
-export interface ProductRecord extends Stored<Product> {
-  sortName: string;
-  sortCode: string;
-  // The name, the code and the SKUs in lower case, for "contains"
-  text: string;
-  // Every barcode of the product: its variants' and its packs'. A barcode is matched whole.
+// The barcodes are clear for a scanner (step 20), and the variant ids for a sale line (18b), which
+// finds its product by one of them. Names, codes and prices are only in the box: a list sorts and
+// searches them in memory (copy.ts).
+export interface ProductRow extends SealedRow<Product> {
   barcodes: string[];
-  // Its variants' ids (step 18b): the order form offline finds a line's product by its variant
   variantIds: string[];
 }
 
-export interface CustomerRecord extends Stored<SyncCustomer> {
-  sortName: string;
-  // The name, the code, the contact person and the phone in lower case, for "contains"
-  text: string;
+// A sale line looks up its price and its stock by these ids (step 18b). They were key paths into
+// the server's row before step 19b (`data.priceListId`); the row is sealed now, so they are copied
+// out of it.
+export interface PriceListItemRow extends SealedRow<SyncPriceListItem> {
+  priceListId: string;
+  variantId: string;
+}
+
+export interface StockRow extends SealedRow<SyncStock> {
+  warehouseId: string;
+  variantId: string;
+}
+
+// Step 19b: the two tables the app keeps opened in memory (copy.ts), and how many times each was
+// written. A write to one counts up its mark in the same transaction; a list waits until the
+// in-memory copy has caught up with the mark it reads, so it never shows a half-done write.
+export type MirroredTable = 'products' | 'customers';
+
+export interface TableMark {
+  table: MirroredTable;
+  version: number;
 }
 
 // Where a pull is: one row in `meta`, under the key 'pull'
@@ -68,6 +84,8 @@ export interface PullState {
 // the same database as the copy, so signing out deletes both (the app asks first).
 export type OutboxStatus = 'waiting' | 'sending' | 'failed';
 
+// An outbox entry as the code works with it: the row opened (sealed.ts). The rows themselves are
+// OutboxRow, below.
 export interface OutboxEntry {
   // The order the person did things in: the push sends the outbox by seq, oldest first.
   // Auto-increment, so it is missing until Dexie adds the row.
@@ -99,6 +117,27 @@ export interface OutboxEntry {
   savedAt: string;
 }
 
+// The part of an entry that is sealed: everything a person typed or read
+export type OutboxBody = Pick<
+  OutboxEntry,
+  'command' | 'error' | 'base' | 'name' | 'lines' | 'total' | 'savedAt'
+>;
+
+// Step 19b: an outbox row. What the push and the sidebar need without the key stays clear: ids,
+// the command's type, its state and its size. The push picks a batch, marks it and counts the
+// outbox from these alone, inside one transaction (a transaction cannot wait for Web Crypto).
+export interface OutboxRow extends Pick<
+  OutboxEntry,
+  'seq' | 'status' | 'sent' | 'customerId' | 'key'
+> {
+  // The command's id: the box is sealed under it, and an answer finds its row by it
+  commandId: string;
+  type: SyncCommand['type'];
+  // The command's size as JSON, for the 512 KB limit of a push (push.ts)
+  bytes: number;
+  box: Box<OutboxBody>;
+}
+
 // A head-office field the server kept (a kept_server_value notice), shown on the Sync page until
 // the person dismisses it. The command itself is gone: it was accepted.
 export interface SyncNoticeRecord {
@@ -110,6 +149,12 @@ export interface SyncNoticeRecord {
   at: string;
 }
 
+// Step 19b: a notice is sealed whole; its command's id is the row's key
+export interface NoticeRow {
+  commandId: string;
+  box: Box<SyncNoticeRecord>;
+}
+
 // The tables, by entity. The names are the ones the app reads (db.products, db.customers).
 export const TABLE_OF = {
   settings: 'settings',
@@ -141,20 +186,27 @@ export async function deleteLocalDatabase(tenantId: string, userId: string): Pro
 
 export class SyncDatabase extends Dexie {
   // `!`: Dexie makes these properties itself, from the stores() below
-  settings!: Table<Stored<SyncSettings>, string>;
-  units!: Table<Stored<Unit>, string>;
-  productCategories!: Table<Stored<SyncCategory>, string>;
-  taxRates!: Table<Stored<TaxRate>, string>;
-  warehouses!: Table<Stored<Warehouse>, string>;
-  priceLists!: Table<Stored<SyncPriceList>, string>;
-  customerGroups!: Table<Stored<SyncCustomerGroup>, string>;
-  products!: Table<ProductRecord, string>;
-  priceListItems!: Table<Stored<SyncPriceListItem>, string>;
-  customers!: Table<CustomerRecord, string>;
-  stock!: Table<Stored<SyncStock>, string>;
+  settings!: Table<SealedRow<SyncSettings>, string>;
+  units!: Table<SealedRow<Unit>, string>;
+  productCategories!: Table<SealedRow<SyncCategory>, string>;
+  taxRates!: Table<SealedRow<TaxRate>, string>;
+  warehouses!: Table<SealedRow<Warehouse>, string>;
+  priceLists!: Table<SealedRow<SyncPriceList>, string>;
+  customerGroups!: Table<SealedRow<SyncCustomerGroup>, string>;
+  products!: Table<ProductRow, string>;
+  priceListItems!: Table<PriceListItemRow, string>;
+  customers!: Table<SealedRow<SyncCustomer>, string>;
+  stock!: Table<StockRow, string>;
   meta!: Table<PullState, string>;
-  outbox!: Table<OutboxEntry, number>;
-  notices!: Table<SyncNoticeRecord, string>;
+  outbox!: Table<OutboxRow, number>;
+  notices!: Table<NoticeRow, string>;
+  // Step 19b: the data key, wrapped (keys.ts). One row.
+  keys!: Table<KeyRecord, string>;
+  marks!: Table<TableMark, string>;
+  // Step 19b: the outbox and the notices of version 2, still clear, until the key opens and
+  // copy.ts seals them (an upgrade cannot wait for Web Crypto). Empty after that.
+  legacyOutbox!: Table<OutboxEntry, number>;
+  legacyNotices!: Table<SyncNoticeRecord, string>;
 
   constructor(name: string) {
     super(name);
@@ -189,16 +241,50 @@ export class SyncDatabase extends Dexie {
       })
       .upgrade(async (tx) => {
         await tx
-          .table<ProductRecord, string>('products')
+          .table<{ data: Product; variantIds: string[] }, string>('products')
           .toCollection()
           .modify((record) => {
             record.variantIds = record.data.variants.map((variant) => variant.id);
           });
       });
+    // Step 19b: sealed rows. The synced tables are emptied and the pull starts again from nothing:
+    // a full pull writes them back sealed, so no clear copy stays on the disk. The outbox and its
+    // notices are the person's own work and must not be lost: they move to the legacy tables as
+    // they are, and copy.ts seals them back into the outbox once the key opens (an upgrade runs in
+    // one transaction, which cannot wait for Web Crypto). The ids an index needs are now copied
+    // out of the row (priceListId, warehouseId, variantId); the name and code indexes go, because
+    // a name in an index would be clear on the disk.
+    this.version(3)
+      .stores({
+        products: 'key, gen, *barcodes, *variantIds',
+        priceListItems: 'key, gen, priceListId, variantId',
+        customers: 'key, gen',
+        stock: 'key, gen, warehouseId, variantId',
+        keys: 'key',
+        marks: 'table',
+        legacyOutbox: 'seq',
+        legacyNotices: 'commandId',
+      })
+      .upgrade(async (tx) => {
+        for (const name of Object.values(TABLE_OF)) await tx.table(name).clear();
+        await tx.table('meta').delete('pull');
+        const outbox = tx.table<OutboxEntry, number>('outbox');
+        await tx.table<OutboxEntry, number>('legacyOutbox').bulkAdd(await outbox.toArray());
+        await outbox.clear();
+        const notices = tx.table<SyncNoticeRecord, string>('notices');
+        await tx.table<SyncNoticeRecord, string>('legacyNotices').bulkAdd(await notices.toArray());
+        await notices.clear();
+      });
   }
 
   // Every synced table, to sweep or clear them all. Not `this.tables`, which has `meta` too.
   syncTables() {
     return Object.values(TABLE_OF).map((name) => this[name]);
   }
+
+  // Step 19b: one write more to a mirrored table. Called inside the transaction that wrote it.
+  async markWritten(table: MirroredTable): Promise<void> {
+    const mark = await this.marks.get(table);
+    await this.marks.put({ table, version: (mark?.version ?? 0) + 1 });
+  }
 }
```

- **`SealedRow<T>` replaces `Stored<T>`.** `data: T` becomes `box: Box<T>`: the type still says what is inside, and
  `copy.open(…)` gives back a `T`.
- **`ProductRow`, `PriceListItemRow` and `StockRow` add the ids their indexes need.** IndexedDB can index only what it
  can read. Before step 19b, the indexes pointed into the row (`data.priceListId`); now `data` is sealed, so the ids
  are copied next to the box. They are ids (UUIDs) and barcodes, which name nothing a person typed. The product's
  `sortName`, `sortCode` and `text` are gone: they were the name and the code in plain text.
- **The customers table has no extra field at all.** Decision 2: the name index goes. The customer list sorts in
  memory (decision 12).
- **`MirroredTable` and `TableMark`.** Decision 13. One mark per table that the app keeps in memory; `version` counts
  the writes to it.
- **`OutboxEntry` keeps its shape, but is no longer a row.** The rest of the code (the overlay, the push, the app's
  Sync page) works with opened entries exactly as before. The row on the disk is `OutboxRow`.
- **`OutboxBody` is what gets sealed:** `Pick` of the fields a person typed or read. Written as a `Pick` of
  `OutboxEntry`, so a field added to the entry later must be placed in the body or in the row on purpose.
- **`OutboxRow` keeps `seq`, `status`, `sent`, `customerId` and `key` from the entry, and adds three.** Decision 11.
  `commandId`: the command's id, the label the box is sealed under (a new entry has no `seq` until Dexie adds it), and
  how an answer from the server finds its row. `type`: so the Sync page's Discard and the customer list can tell a
  new customer from a change or an order without opening anything. `bytes`: the push's 512 KB limit is counted from
  it.
- **`NoticeRow` seals the whole notice** under its command's id.
- **The new tables: `keys`, `marks`, `legacyOutbox` and `legacyNotices`.** `legacyOutbox` and `legacyNotices` keep the
  `OutboxEntry` and `SyncNoticeRecord` types: they hold version 2's clear rows, as they were.
- **Version 2's upgrade now names its own row type** (`{ data: Product; variantIds: string[] }`). It used
  `ProductRecord`, which is now the in-memory entry (`records.ts`) and no longer matches the old row. The upgrade still
  runs, for a device that jumps from version 1 straight to version 3; version 3's upgrade then empties the table it
  filled.
- **Version 3's stores.** Only the tables that change are named; Dexie keeps the others as version 2 had them.
  Products lose `sortName` and `sortCode`; the price items and the stock get the lifted ids; customers lose
  `sortName`; `marks` is keyed by `table`; `legacyOutbox` by `seq` (not `++seq`: the rows keep the numbers they had).
- **Version 3's upgrade, line by line.** Decision 18. It empties every synced table (`TABLE_OF`'s values) and deletes
  the `pull` row of `meta`, so the next pull is a full one from the start. It reads the outbox and writes the same rows
  into `legacyOutbox` with `bulkAdd`, then empties the outbox; the same for the notices. All of it runs in the upgrade's
  one transaction: if the browser stops half way, nothing changed, and the upgrade runs again at the next opening.
- **The outbox's numbering goes on.** Emptying a table does not reset IndexedDB's auto-increment, so a command saved
  after the upgrade gets a `seq` above every old one, and the old ones keep their place in the order when they come
  back (`sealed.ts`).
- **`markWritten` reads the mark and writes it plus one.** It must run inside the transaction that wrote the table;
  then the row and the mark change together or not at all, and two writers cannot both write the same number.

### `records.ts`: the in-memory entries

```diff
@@ -1,6 +1,30 @@
 import type { Product, SyncCustomer } from '@omnivo/contracts';
 
-import type { CustomerRecord, ProductRecord } from './database.js';
+// Step 19b: a product or a customer as the in-memory copy keeps it (copy.ts), opened, with what its
+// list needs to search and sort. These were the rows on the disk before step 19b; now the disk
+// keeps them sealed, and only this memory has the names.
+
+// The server sorts on lower(name) and lower(code), so the device does too
+export interface ProductRecord {
+  key: string;
+  data: Product;
+  sortName: string;
+  sortCode: string;
+  // The name, the code and the SKUs in lower case, for "contains"
+  text: string;
+  // Every barcode of the product: its variants' and its packs'. A barcode is matched whole.
+  barcodes: string[];
+  // Its variants' ids (step 18b): the order form offline finds a line's product by its variant
+  variantIds: string[];
+}
+
+export interface CustomerRecord {
+  key: string;
+  data: SyncCustomer;
+  sortName: string;
+  // The name, the code, the contact person and the phone in lower case, for "contains"
+  text: string;
+}
 
 // The text a search looks in, in lower case. The parts are joined with a line break, which no
 // search box can hold, so a search never matches across two parts ("Shirt" + "M" is not "tm").
@@ -22,31 +46,36 @@ export function needleOf(search: string): Needle | null {
   return typed === '' ? null : { text: typed.toLowerCase(), barcode: typed };
 }
 
-// The archived variants are searched too, their SKUs and their barcodes, like the server's search
+// What a product row keeps clear for its indexes (database.ts → ProductRow). The archived
+// variants count too, their SKUs and their barcodes, like the server's search
 // (products.service.ts): the products page finds the same products on the device as it did
 // from the server.
-export function productRecord(key: string, gen: number, data: Product): ProductRecord {
+export function productIndex(data: Product): { barcodes: string[]; variantIds: string[] } {
   const barcodes = [
     ...data.variants.map((variant) => variant.barcode),
     ...data.units.map((unit) => unit.barcode),
   ].filter((code) => code !== null);
+  return {
+    barcodes: [...new Set(barcodes)],
+    variantIds: data.variants.map((variant) => variant.id),
+  };
+}
+
+export function productRecord(key: string, data: Product): ProductRecord {
   return {
     key,
-    gen,
     data,
     sortName: data.name.toLowerCase(),
     sortCode: data.code.toLowerCase(),
     text: searchText([data.name, data.code, ...data.variants.map((variant) => variant.sku)]),
-    barcodes: [...new Set(barcodes)],
-    variantIds: data.variants.map((variant) => variant.id),
+    ...productIndex(data),
   };
 }
 
 // The server searches the phone as typed (digits have no case); lower case changes nothing in it
-export function customerRecord(key: string, gen: number, data: SyncCustomer): CustomerRecord {
+export function customerRecord(key: string, data: SyncCustomer): CustomerRecord {
   return {
     key,
-    gen,
     data,
     sortName: data.name.toLowerCase(),
     text: searchText([data.name, data.code, data.contactPerson, data.phone]),
```

- **`ProductRecord` and `CustomerRecord` move here and lose `gen`.** They are no longer rows on the disk but what the
  in-memory copy holds for each row, opened: the data plus what a list sorts and searches by. `gen` belongs to the row
  on the disk only.
- **`productIndex` is split out of `productRecord`.** The ids a product row keeps readable (`barcodes`, `variantIds`)
  are worked out in two places: when a pull writes the row (`apply.ts`), and when the in-memory copy opens it. One
  function keeps the two the same.

### `sealed.ts` (new): rows to and from their sealed form

```ts
import type { SyncCommand } from '@omnivo/contracts';

import type { LocalCopy } from './copy.js';
import type { NoticeRow, OutboxEntry, OutboxRow, SealedRow, SyncNoticeRecord } from './database.js';

// Step 19b: rows to and from their sealed form. Type imports only (the copy is a parameter), so the
// forms and pages that save or read the outbox still load no Dexie (see index.ts).

const encoder = new TextEncoder();

// A push stops at MAX_PUSH_BYTES of commands (push.ts). The size is counted when the command is
// saved and kept clear on its row, so a batch is picked without opening every command.
export function commandBytes(command: SyncCommand): number {
  return encoder.encode(JSON.stringify(command)).length;
}

// Every value of a small table, opened. The table's name is in the label each row was sealed
// under (apply.ts), so a row moved to another table does not open.
export function openRows<T>(
  copy: LocalCopy,
  table: string,
  rows: readonly SealedRow<T>[],
): Promise<T[]> {
  return Promise.all(rows.map((row) => copy.open(table, row.key, row.box)));
}

// Sealed under the command's id, not the seq: a new entry has no seq until Dexie adds it. The
// command's id is unique, and changes whenever the command is rewritten (outbox.ts).
export async function sealEntry(copy: LocalCopy, entry: OutboxEntry): Promise<OutboxRow> {
  const { seq, command, status, sent, customerId, key, error, base, name, lines, total, savedAt } =
    entry;
  return {
    // exactOptionalPropertyTypes: a missing seq must be left out, not set to undefined
    ...(seq !== undefined && { seq }),
    commandId: command.id,
    type: command.type,
    status,
    sent,
    customerId,
    key,
    bytes: commandBytes(command),
    box: await copy.seal('outbox', command.id, {
      command,
      error,
      base,
      name,
      lines,
      total,
      savedAt,
    }),
  };
}

export async function openEntry(copy: LocalCopy, row: OutboxRow): Promise<OutboxEntry> {
  const body = await copy.open('outbox', row.commandId, row.box);
  return {
    ...(row.seq !== undefined && { seq: row.seq }),
    status: row.status,
    sent: row.sent,
    customerId: row.customerId,
    key: row.key,
    ...body,
  };
}

export function openEntries(copy: LocalCopy, rows: readonly OutboxRow[]): Promise<OutboxEntry[]> {
  return Promise.all(rows.map((row) => openEntry(copy, row)));
}

export async function sealNotice(copy: LocalCopy, notice: SyncNoticeRecord): Promise<NoticeRow> {
  return {
    commandId: notice.commandId,
    box: await copy.seal('notices', notice.commandId, notice),
  };
}

export function openNotices(
  copy: LocalCopy,
  rows: readonly NoticeRow[],
): Promise<SyncNoticeRecord[]> {
  return Promise.all(rows.map((row) => copy.open('notices', row.commandId, row.box)));
}

// The outbox and the notices that version 3 moved aside (database.ts), sealed back into their
// tables with the same seq: the order of the person's work stays. Sealed first, then one
// transaction. Two tabs may open the copy at once: the transaction moves only the rows still
// waiting, so the second tab writes nothing the first already moved.
export async function sealLegacy(copy: LocalCopy): Promise<void> {
  const { db } = copy;
  const [entries, notices] = await Promise.all([
    db.legacyOutbox.toArray(),
    db.legacyNotices.toArray(),
  ]);
  if (entries.length === 0 && notices.length === 0) return;
  const rows = await Promise.all(entries.map((entry) => sealEntry(copy, entry)));
  const noticeRows = await Promise.all(notices.map((notice) => sealNotice(copy, notice)));
  await db.transaction(
    'rw',
    [db.outbox, db.notices, db.legacyOutbox, db.legacyNotices],
    async () => {
      const seqs = new Set(await db.legacyOutbox.toCollection().primaryKeys());
      const ids = new Set(await db.legacyNotices.toCollection().primaryKeys());
      const moving = rows.filter((row) => row.seq !== undefined && seqs.has(row.seq));
      const movingNotices = noticeRows.filter((row) => ids.has(row.commandId));
      await db.outbox.bulkPut(moving);
      await db.notices.bulkPut(movingNotices);
      await db.legacyOutbox.bulkDelete(moving.flatMap((row) => row.seq ?? []));
      await db.legacyNotices.bulkDelete(movingNotices.map((row) => row.commandId));
    },
  );
}
```

- **Type imports only.** The copy (`LocalCopy`) is a parameter, never imported at run time, so `outbox.ts` and
  `queries.ts`, which use these helpers and are imported by pages, still load no Dexie. `import type` is erased by
  the compiler.
- **`commandBytes` is the same count the push used before** (`push.ts` measured the JSON of the command in UTF-8). It
  now runs once, when the command is saved, and the number is kept on the row (decision 11).
- **`openRows` uses the table's name as the label.** `apply.ts` seals each row under its own table's name, so the two
  sides agree without a list of names to keep in step.
- **`sealEntry` seals under the command's id.** A new entry has no `seq` until Dexie adds it, and the label must be
  known before the box is made. The command's id is unique, and it changes whenever the command is rewritten (a fold,
  a retry), so a box stays tied to exactly one command.
- **`...(seq !== undefined && { seq })`.** The repo's TypeScript has `exactOptionalPropertyTypes`: an optional field
  may be missing but may not hold `undefined`. Spreading `false` adds nothing, so a new entry has no `seq` at all, and
  Dexie gives it the next number.
- **`openEntry` builds the entry from the row's routing fields and the opened body.** The order of the spread
  matters little here, because the two have no field in common.
- **`sealLegacy` moves version 2's outbox into the sealed one.** Decision 18. It seals everything first (no
  transaction can wait for Web Crypto), then one transaction writes the sealed rows and deletes the clear ones. Inside
  the transaction it reads which rows are still in `legacyOutbox`: if another tab opened the copy at the same moment
  and moved them first, this tab writes nothing twice. `bulkPut` with each row's old `seq` keeps the person's order.
- **`moving.flatMap((row) => row.seq ?? [])`.** `flatMap` with `[]` drops a missing `seq` and narrows the type to
  `number[]` in one step, with no cast.

### `copy.ts` (new): the open copy and its in-memory tables

```ts
import type { Product, SyncCustomer } from '@omnivo/contracts';
import { liveQuery } from 'dexie';

import { type Box, ivOf, seal, unseal } from './crypto.js';
import type { MirroredTable, SealedRow, SyncDatabase } from './database.js';
import {
  type CustomerRecord,
  customerRecord,
  type ProductRecord,
  productRecord,
} from './records.js';
import { sealLegacy } from './sealed.js';

// Step 19b: the device's copy, open. The database holds sealed rows; this object holds the data
// key that opens them, and an in-memory copy of the two big tables, products and customers. A list
// sorts and searches 10,000 products on every key press, and cannot open 10,000 rows each time.
// This module brings Dexie (liveQuery): the app loads it lazily, like database.ts.

interface Held<E> {
  // The row's iv: a row written again has a new one (crypto.ts → ivOf)
  iv: Uint8Array<ArrayBuffer>;
  entry: E;
}

interface Snapshot<T> {
  // The table's mark (database.ts → TableMark), read before the rows: the rows are then at least
  // as new as the mark says
  version: number;
  rows: SealedRow<T>[];
}

interface Waiter {
  version: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

// One table, opened, in memory. A liveQuery reads the sealed table whenever a write changes it (a
// pull in this tab or another, a push's answer), and only the rows with a new iv are opened again.
// The reads come one after another: a liveQuery answer that comes while one is being opened waits,
// and only the newest waiting one is opened (the ones before it are already out of date).
export class Mirror<T, E extends { key: string }> {
  private held = new Map<string, Held<E>>();
  // The mark of the rows in `held`; -1 = nothing yet
  private version = -1;
  // Sorted views, made on first use after each change
  private readonly orders = new Map<string, readonly E[]>();
  private waiters: Waiter[] = [];
  private waiting: Snapshot<T> | null = null;
  private opening = false;
  private problem: Error | null = null;
  private closed = false;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly db: SyncDatabase,
    private readonly table: MirroredTable,
    private readonly read: () => Promise<SealedRow<T>[]>,
    private readonly open: (key: string, box: Box<T>) => Promise<T>,
    private readonly toEntry: (key: string, data: T) => E,
  ) {}

  private async mark(): Promise<number> {
    return (await this.db.marks.get(this.table))?.version ?? 0;
  }

  // Resolves once the table is in memory; rejects when a row of it does not open
  start(): Promise<void> {
    const loaded = this.reach(0);
    const subscription = liveQuery(async (): Promise<Snapshot<T>> => ({
      version: await this.mark(),
      rows: await this.read(),
    })).subscribe({
      next: (snapshot) => {
        this.waiting = snapshot;
        void this.drain();
      },
      error: (error: unknown) => {
        this.fail(error);
      },
    });
    this.unsubscribe = () => {
      subscription.unsubscribe();
    };
    return loaded;
  }

  // A row that does not open (changed on the disk), or a read that fails: the waiting reads fail
  // with it, and so does every read after, until a later snapshot opens
  private fail(error: unknown): void {
    this.problem = new Error('The copy could not be opened', { cause: error });
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.problem);
  }

  private async drain(): Promise<void> {
    if (this.opening) return;
    this.opening = true;
    try {
      while (this.waiting && !this.closed) {
        const snapshot = this.waiting;
        this.waiting = null;
        await this.take(snapshot);
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.opening = false;
    }
  }

  private async take({ version, rows }: Snapshot<T>): Promise<void> {
    const next = new Map<string, Held<E>>();
    const opened = await Promise.all(
      rows.map(async (row) => {
        const iv = ivOf(row.box);
        const old = this.held.get(row.key);
        if (old && sameBytes(old.iv, iv)) {
          next.set(row.key, old);
          return false;
        }
        next.set(row.key, { iv, entry: this.toEntry(row.key, await this.open(row.key, row.box)) });
        return true;
      }),
    );
    if (this.closed) return;
    if (opened.includes(true) || next.size !== this.held.size) this.orders.clear();
    this.held = next;
    this.version = version;
    this.problem = null;
    const still: Waiter[] = [];
    for (const waiter of this.waiters) {
      if (waiter.version <= version) waiter.resolve();
      else still.push(waiter);
    }
    this.waiters = still;
  }

  private reach(version: number): Promise<void> {
    if (this.closed) return Promise.reject(new Error('The copy is locked'));
    if (this.problem) return Promise.reject(this.problem);
    if (this.version >= version) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.waiters.push({ version, resolve, reject });
    });
  }

  // The table as the last write left it. A read inside the copy's watch (liveQuery) reads the mark,
  // so it runs again after every write to the table, and then waits here until the liveQuery above
  // has opened that write too. A list therefore never shows a customer twice, or not at all, in
  // the moment between a push's answer and the in-memory copy catching up with it.
  async current(): Promise<this> {
    const version = await this.mark();
    // No wrap needed here, unlike unseal's Web Crypto call (crypto.ts): reach() makes its promise
    // while the read runs, inside Dexie's zone, so the caller stays followed (copy.spec.ts)
    await this.reach(version);
    return this;
  }

  get(key: string): E | undefined {
    return this.held.get(key)?.entry;
  }

  // Every entry in the order `compare` gives, kept until the next change under `name`
  ordered(name: string, compare: (a: E, b: E) => number): readonly E[] {
    let order = this.orders.get(name);
    if (!order) {
      order = [...this.held.values()].map((held) => held.entry).sort(compare);
      this.orders.set(name, order);
    }
    return order;
  }

  close(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.held.clear();
    this.orders.clear();
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('The copy is locked'));
  }
}

export class LocalCopy {
  readonly products: Mirror<Product, ProductRecord>;
  readonly customers: Mirror<SyncCustomer, CustomerRecord>;
  private key: CryptoKey | null;

  private constructor(
    readonly db: SyncDatabase,
    key: CryptoKey,
  ) {
    this.key = key;
    this.products = new Mirror(
      db,
      'products',
      () => db.products.toArray(),
      (rowKey, box) => this.open('products', rowKey, box),
      productRecord,
    );
    this.customers = new Mirror(
      db,
      'customers',
      () => db.customers.toArray(),
      (rowKey, box) => this.open('customers', rowKey, box),
      customerRecord,
    );
  }

  // The copy with its data key (keys.ts → openKey). What version 2 left clear is sealed first; then
  // the two big tables come into memory. Only then can a page read, so a list never shows a half
  // copy.
  static async open(db: SyncDatabase, key: CryptoKey): Promise<LocalCopy> {
    const copy = new LocalCopy(db, key);
    try {
      await sealLegacy(copy);
      await Promise.all([copy.products.start(), copy.customers.start()]);
    } catch (error) {
      copy.close();
      throw error;
    }
    return copy;
  }

  private dataKey(): CryptoKey {
    if (this.key === null) throw new Error('The copy is locked');
    return this.key;
  }

  // The label is the row's table and key (crypto.ts → seal)
  seal<T>(table: string, key: string, value: T): Promise<Box<T>> {
    return seal(this.dataKey(), `${table}\n${key}`, value);
  }

  open<T>(table: string, key: string, box: Box<T>): Promise<T> {
    return unseal(this.dataKey(), `${table}\n${key}`, box);
  }

  // Lock now, sign-out, a move: the key and the opened rows leave memory. The database stays open
  // for the caller to close; a read that still runs fails ("locked") instead of opening a row.
  close(): void {
    this.key = null;
    this.products.close();
    this.customers.close();
  }
}
```

The `Mirror` class (decision 12):

- **`held` maps each row's key to its iv and its opened entry.** The iv is how a changed row is found without opening
  it: every write seals with a new random iv.
- **`version` starts at -1.** A table that was never written has the mark 0, so even an empty table counts as read
  once the first snapshot arrives.
- **`orders` keeps each sorted view until the next change.** Sorting 10,000 entries takes a few milliseconds; a list
  that asks for the same order on every key press gets it from here. A change clears them all.
- **`mark()` reads the table's mark, or 0 when there is none yet** (a table never written since version 3).
- **`start()` subscribes a liveQuery to the mark and the rows,** and returns a promise that resolves after the first
  snapshot is opened. The mark is read before the rows: if a write lands between the two reads, the rows are newer
  than the mark says, which is safe (a list may wait for a version the copy already passed, never the other way
  round), and the write's own liveQuery answer comes next anyway.
- **`fail()` keeps the problem and rejects every read that waits.** A row that does not open means the disk was
  changed (or a bug sealed with another key). The lists then fail, and the app keeps showing the last good answer
  (18a's `useLocalQuery`), instead of a list with a row silently missing. A later snapshot that opens clears it.
- **`drain()` opens one snapshot at a time,** and only the newest one waiting. A full pull writes 20 pages in a few
  seconds; each sends a liveQuery answer, and opening each one would open the same rows many times over. The
  `opening` flag makes a second call return at once; the loop picks up whatever arrived meanwhile.
- **`take()` builds a new map,** keeping the entries whose iv did not change and opening the others, all at once
  (`Promise.all`). The sorted views are cleared only when something changed. Then the version moves on, and every
  read waiting for this version or an older one goes on.
- **`if (this.closed) return` after the openings.** A lock may come while rows are being opened; then nothing is kept.
- **`reach()` answers at once when it can,** and otherwise parks the read in `waiters` until `take()` gets that far. A
  locked copy or a failed one rejects at once.
- **`current()` is how a read gets the table** (decision 13). The read's liveQuery sees the mark, so it runs again
  after every write to the table, and the wait makes sure the in-memory copy has that write too. The comment says why
  this wait needs no `Promise.resolve`, unlike `unseal`: `reach()` makes its promise while the read runs, inside
  Dexie's zone, so the promise is already one of Dexie's. `copy.spec.ts` tests a read made after it.
- **`get` and `ordered` read memory only.** They come after `current()`, which already checked that the copy is open
  and up to date.
- **`close()` rejects the waiting reads.** A list waiting at the moment of a lock fails ("locked") rather than waiting
  forever.

The `LocalCopy` class:

- **The constructor is private; `LocalCopy.open` is the only way in.** A copy must seal version 2's outbox and fill its
  in-memory tables before a page reads anything, and an `async` step cannot run in a constructor. A half-made copy
  cannot exist this way.
- **If anything fails while opening, the copy closes itself.** Its liveQueries would otherwise keep running for a copy
  nobody holds.
- **`key: CryptoKey | null`, with `dataKey()` as the only reader.** After `close()` it is `null`, and every seal or
  open throws "The copy is locked". JavaScript cannot wipe a value from memory, but without a reference the key cannot
  be used and the garbage collector frees it.
- **`seal` and `open` build the label as the table, a line break, and the key.** No table name and no key holds a
  line break, so two different pairs can never make the same label.
- **`open` throws at once on a locked copy, rather than returning a rejected promise.** Every caller awaits it inside
  an `async` function, where a throw becomes a rejection anyway.

### `apply.ts`: sealing a page before writing it

The first hunk replaces `groupChanges` with `sealChanges`:

```diff
@@ -1,109 +1,144 @@
 import type {
   SyncCategory,
   SyncChange,
+  SyncCustomer,
   SyncCustomerGroup,
   SyncPriceList,
-  SyncPriceListItem,
   SyncPull,
   SyncSettings,
-  SyncStock,
   TaxRate,
   Unit,
   Warehouse,
 } from '@omnivo/contracts';
 
-import {
-  type CustomerRecord,
-  type ProductRecord,
-  type PullState,
-  type Stored,
-  type SyncDatabase,
-  type SyncTableName,
-  TABLE_OF,
+import type { LocalCopy } from './copy.js';
+import type {
+  PriceListItemRow,
+  ProductRow,
+  PullState,
+  SealedRow,
+  StockRow,
+  SyncDatabase,
+  SyncTableName,
 } from './database.js';
-import { customerRecord, productRecord } from './records.js';
+import { TABLE_OF } from './database.js';
+import { productIndex } from './records.js';
 import { readPullState } from './state.js';
 
-// The rows of one page, grouped by table. Typed per table, so a product can only go into
-// `products`: one `Record<string, unknown[]>` would need a cast to write them.
-interface Writes {
-  settings: Stored<SyncSettings>[];
-  units: Stored<Unit>[];
-  productCategories: Stored<SyncCategory>[];
-  taxRates: Stored<TaxRate>[];
-  warehouses: Stored<Warehouse>[];
-  priceLists: Stored<SyncPriceList>[];
-  customerGroups: Stored<SyncCustomerGroup>[];
-  products: ProductRecord[];
-  priceListItems: Stored<SyncPriceListItem>[];
-  customers: CustomerRecord[];
-  stock: Stored<SyncStock>[];
-}
+// A row before the transaction gives it its generation (step 19b): it is sealed first, and the
+// generation is only known inside the transaction, from the pull's state
+type Unstamped<R> = Omit<R, 'gen'>;
 
-function emptyWrites(): Writes {
-  return {
-    settings: [],
-    units: [],
-    productCategories: [],
-    taxRates: [],
-    warehouses: [],
-    priceLists: [],
-    customerGroups: [],
-    products: [],
-    priceListItems: [],
-    customers: [],
-    stock: [],
+// The rows of one page, sealed and grouped by table. Typed per table, so a product can only go
+// into `products`: one `Record<string, unknown[]>` would need a cast to write them.
+export interface SealedChanges {
+  puts: {
+    settings: Unstamped<SealedRow<SyncSettings>>[];
+    units: Unstamped<SealedRow<Unit>>[];
+    productCategories: Unstamped<SealedRow<SyncCategory>>[];
+    taxRates: Unstamped<SealedRow<TaxRate>>[];
+    warehouses: Unstamped<SealedRow<Warehouse>>[];
+    priceLists: Unstamped<SealedRow<SyncPriceList>>[];
+    customerGroups: Unstamped<SealedRow<SyncCustomerGroup>>[];
+    products: Unstamped<ProductRow>[];
+    priceListItems: Unstamped<PriceListItemRow>[];
+    customers: Unstamped<SealedRow<SyncCustomer>>[];
+    stock: Unstamped<StockRow>[];
   };
+  deletes: Map<SyncTableName, string[]>;
 }
 
-function groupChanges(changes: readonly SyncChange[], gen: number) {
-  const puts = emptyWrites();
-  const deletes = new Map<SyncTableName, string[]>();
-  for (const change of changes) {
-    if (change.op === 'delete') {
-      const table = TABLE_OF[change.entity];
-      deletes.set(table, [...(deletes.get(table) ?? []), change.key]);
-      continue;
-    }
-    // A switch on the entity narrows `data` to its own type in each case
-    const { key } = change;
-    switch (change.entity) {
-      case 'settings':
-        puts.settings.push({ key, gen, data: change.data });
-        break;
-      case 'unit':
-        puts.units.push({ key, gen, data: change.data });
-        break;
-      case 'product_category':
-        puts.productCategories.push({ key, gen, data: change.data });
-        break;
-      case 'tax_rate':
-        puts.taxRates.push({ key, gen, data: change.data });
-        break;
-      case 'warehouse':
-        puts.warehouses.push({ key, gen, data: change.data });
-        break;
-      case 'price_list':
-        puts.priceLists.push({ key, gen, data: change.data });
-        break;
-      case 'customer_group':
-        puts.customerGroups.push({ key, gen, data: change.data });
-        break;
-      case 'product':
-        puts.products.push(productRecord(key, gen, change.data));
-        break;
-      case 'price_list_item':
-        puts.priceListItems.push({ key, gen, data: change.data });
-        break;
-      case 'customer':
-        puts.customers.push(customerRecord(key, gen, change.data));
-        break;
-      case 'stock':
-        puts.stock.push({ key, gen, data: change.data });
-        break;
-    }
-  }
-  return { puts, deletes };
+async function boxed<T>(
+  copy: LocalCopy,
+  table: SyncTableName,
+  key: string,
+  data: T,
+): Promise<Unstamped<SealedRow<T>>> {
+  return { key, box: await copy.seal(table, key, data) };
+}
+
+// Every row of the changes sealed, at once (Promise.all): one seal is quick, but 500 one after
+// another would each wait for its own turn of the event loop. Done before the transaction:
+// IndexedDB commits a transaction that waits for anything else, and Web Crypto is something else.
+export async function sealChanges(
+  copy: LocalCopy,
+  changes: readonly SyncChange[],
+): Promise<SealedChanges> {
+  const sealed: SealedChanges = {
+    puts: {
+      settings: [],
+      units: [],
+      productCategories: [],
+      taxRates: [],
+      warehouses: [],
+      priceLists: [],
+      customerGroups: [],
+      products: [],
+      priceListItems: [],
+      customers: [],
+      stock: [],
+    },
+    deletes: new Map(),
+  };
+  const { puts, deletes } = sealed;
+  await Promise.all(
+    changes.map(async (change) => {
+      if (change.op === 'delete') {
+        const table = TABLE_OF[change.entity];
+        deletes.set(table, [...(deletes.get(table) ?? []), change.key]);
+        return;
+      }
+      // A switch on the entity narrows `data` to its own type in each case
+      const { key } = change;
+      switch (change.entity) {
+        case 'settings':
+          puts.settings.push(await boxed(copy, 'settings', key, change.data));
+          break;
+        case 'unit':
+          puts.units.push(await boxed(copy, 'units', key, change.data));
+          break;
+        case 'product_category':
+          puts.productCategories.push(await boxed(copy, 'productCategories', key, change.data));
+          break;
+        case 'tax_rate':
+          puts.taxRates.push(await boxed(copy, 'taxRates', key, change.data));
+          break;
+        case 'warehouse':
+          puts.warehouses.push(await boxed(copy, 'warehouses', key, change.data));
+          break;
+        case 'price_list':
+          puts.priceLists.push(await boxed(copy, 'priceLists', key, change.data));
+          break;
+        case 'customer_group':
+          puts.customerGroups.push(await boxed(copy, 'customerGroups', key, change.data));
+          break;
+        case 'product':
+          puts.products.push({
+            ...(await boxed(copy, 'products', key, change.data)),
+            ...productIndex(change.data),
+          });
+          break;
+        case 'price_list_item':
+          puts.priceListItems.push({
+            ...(await boxed(copy, 'priceListItems', key, change.data)),
+            priceListId: change.data.priceListId,
+            variantId: change.data.variantId,
+          });
+          break;
+        case 'customer':
+          puts.customers.push(await boxed(copy, 'customers', key, change.data));
+          break;
+        case 'stock':
+          puts.stock.push({
+            ...(await boxed(copy, 'stock', key, change.data)),
+            warehouseId: change.data.warehouseId,
+            variantId: change.data.variantId,
+          });
+          break;
+      }
+    }),
+  );
+  return sealed;
 }
 
 // Which generation this page's rows get, and whether it starts a new full pull. A full page
```

- **`Unstamped<R>` is a row without its generation.** Rows are sealed before the transaction, and the generation is
  known only inside it (`nextState` reads the pull's state there). So `sealChanges` makes rows without `gen`, and
  `writeSealed` adds it.
- **`SealedChanges` keeps one array per table, typed per table,** as `Writes` did: a product row can only go into
  `products`.
- **`boxed` seals one row under its table's name.** The name comes from the switch below, never from the data, so a
  `unit` change is always sealed as `units`.
- **`Promise.all` over the changes.** Each seal is quick, but awaiting 500 of them one after the other would wait 500
  turns of the event loop. Started together, Web Crypto works through them at once. Each case pushes its row after its
  own seal, so the arrays fill in no fixed order; that does not matter, because a key appears at most once in a page.
- **A product row gets `productIndex(change.data)`,** a price item its `priceListId` and `variantId`, a stock row its
  `warehouseId` and `variantId`: the readable ids of decision 10, taken from the server's row before it is sealed.

The second hunk: writing, the sweep and `applyPage`:

```diff
@@ -133,47 +168,61 @@ function nextState(
   };
 }
 
-// Rows into their tables, with the generation given. Called inside a transaction that holds every
-// synced table: a page of the pull (below), or the rows a push's answer sent back (push.ts).
-export async function writeChanges(
+function stamp<R>(rows: readonly R[], gen: number) {
+  return rows.map((row) => ({ ...row, gen }));
+}
+
+// Sealed rows into their tables, with the generation given. Called inside a transaction that holds
+// every synced table and the marks: a page of the pull (below), or the rows a push's answer sent
+// back (push.ts).
+export async function writeSealed(
   db: SyncDatabase,
-  changes: readonly SyncChange[],
+  { puts, deletes }: SealedChanges,
   gen: number,
 ): Promise<void> {
-  const { puts, deletes } = groupChanges(changes, gen);
   for (const [table, keys] of deletes) await db[table].bulkDelete(keys);
   // A key is in a page at most once (the contract), so no row is both put and deleted here
-  await db.settings.bulkPut(puts.settings);
-  await db.units.bulkPut(puts.units);
-  await db.productCategories.bulkPut(puts.productCategories);
-  await db.taxRates.bulkPut(puts.taxRates);
-  await db.warehouses.bulkPut(puts.warehouses);
-  await db.priceLists.bulkPut(puts.priceLists);
-  await db.customerGroups.bulkPut(puts.customerGroups);
-  await db.products.bulkPut(puts.products);
-  await db.priceListItems.bulkPut(puts.priceListItems);
-  await db.customers.bulkPut(puts.customers);
-  await db.stock.bulkPut(puts.stock);
+  await db.settings.bulkPut(stamp(puts.settings, gen));
+  await db.units.bulkPut(stamp(puts.units, gen));
+  await db.productCategories.bulkPut(stamp(puts.productCategories, gen));
+  await db.taxRates.bulkPut(stamp(puts.taxRates, gen));
+  await db.warehouses.bulkPut(stamp(puts.warehouses, gen));
+  await db.priceLists.bulkPut(stamp(puts.priceLists, gen));
+  await db.customerGroups.bulkPut(stamp(puts.customerGroups, gen));
+  await db.products.bulkPut(stamp(puts.products, gen));
+  await db.priceListItems.bulkPut(stamp(puts.priceListItems, gen));
+  await db.customers.bulkPut(stamp(puts.customers, gen));
+  await db.stock.bulkPut(stamp(puts.stock, gen));
+  // Step 19b: only a write that touched them, so a page of stock alone leaves the in-memory
+  // copies as they are
+  if (puts.products.length > 0 || deletes.has('products')) await db.markWritten('products');
+  if (puts.customers.length > 0 || deletes.has('customers')) await db.markWritten('customers');
 }
 
 // One page into the database, in one transaction: the rows, the deletes and the cursor are
 // saved together or not at all. A tab closed half way through a page leaves the old cursor, and
 // the same page comes again; its upserts and deletes give the same result twice. `now` is the
-// device's clock (step 18c), a parameter so a test can set it.
+// device's clock (step 18c), a parameter so a test can set it. Step 19b: the rows are sealed
+// before the transaction starts (sealChanges).
 export async function applyPage(
-  db: SyncDatabase,
+  copy: LocalCopy,
   page: SyncPull,
   sentCursor: string | null,
   now: number = Date.now(),
 ): Promise<PullState> {
-  return db.transaction('rw', [...db.syncTables(), db.meta], async () => {
+  const { db } = copy;
+  const sealed = await sealChanges(copy, page.changes);
+  return db.transaction('rw', [...db.syncTables(), db.meta, db.marks], async () => {
     const state = nextState(await readPullState(db), page, sentCursor, now);
-    await writeChanges(db, page.changes, state.generation);
+    await writeSealed(db, sealed, state.generation);
     // The last page of a full pull: every row it did not send is older than its generation, and
     // goes (decision 17). Until now, the lists kept showing them.
     if (page.full && !page.hasMore) {
-      for (const table of db.syncTables()) {
-        await table.where('gen').below(state.generation).delete();
+      for (const name of Object.values(TABLE_OF)) {
+        const swept = await db[name].where('gen').below(state.generation).delete();
+        if (swept > 0 && (name === 'products' || name === 'customers')) {
+          await db.markWritten(name);
+        }
       }
     }
     await db.meta.put(state);
```

- **`stamp` adds the generation.** It is generic, and each call site uses a concrete row type, so TypeScript can check
  that `{ ...row, gen }` is a full row of that table.
- **`writeSealed` marks the products and the customers only when it touched them.** Decision 13. A page of stock or
  prices leaves the in-memory copies alone, so they do not read 10,000 rows again for nothing.
- **`applyPage` seals the page before the transaction.** Decision 9.
- **The transaction now holds `db.marks`.** Dexie refuses a write to a table that is not part of the transaction, so
  forgetting it fails every test that pulls.
- **The sweep loops over the tables' names.** `swept` is how many rows `delete()` removed; when it removed any
  products or customers, the mark moves too. Looping over the names (not the table objects) gives a name TypeScript can
  narrow to `'products' | 'customers'` for `markWritten`.

### `push.ts`: the push on sealed rows

```diff
@@ -5,8 +5,10 @@ import {
   type SyncResult,
 } from '@omnivo/contracts';
 
-import { writeChanges } from './apply.js';
-import type { OutboxEntry, SyncDatabase } from './database.js';
+import { type SealedChanges, sealChanges, writeSealed } from './apply.js';
+import type { LocalCopy } from './copy.js';
+import type { NoticeRow, OutboxEntry, OutboxRow, SyncDatabase } from './database.js';
+import { openEntries, sealEntry, sealNotice } from './sealed.js';
 import { readPullState } from './state.js';
 
 // The two halves of one push round (step 18b): which commands go now, and what their answers
@@ -22,45 +24,47 @@ export interface PushOutcome {
 
 export const NO_PUSH: PushOutcome = { accepted: 0, rejected: 0, kept: 0 };
 
-const encoder = new TextEncoder();
-
 // The commands to send now, oldest first (decision 13). A command waits while an earlier command
 // on the same customer is still on the device: refused (it needs the person), or in this batch
 // (it needs its answer first). So the order for a new customer goes in the push after the
 // customer's, and two changes to one customer arrive in the order they were made. Commands on
 // other customers go on. The batch stops at 50 commands or 512 KB of JSON; the first command
-// always goes, so a big order is never stuck.
-export function pickBatch(entries: readonly OutboxEntry[]): OutboxEntry[] {
+// always goes, so a big order is never stuck. Step 19b: from the rows' clear fields only (the
+// command's size is counted when it is saved), so it runs inside takeBatch's transaction.
+export function pickBatch(rows: readonly OutboxRow[]): OutboxRow[] {
   const held = new Set<string>();
-  const batch: OutboxEntry[] = [];
+  const batch: OutboxRow[] = [];
   let bytes = 0;
-  for (const entry of entries) {
+  for (const row of rows) {
     if (batch.length === MAX_PUSH_COMMANDS) break;
-    const free = entry.status === 'waiting' && !held.has(entry.customerId);
-    held.add(entry.customerId);
+    const free = row.status === 'waiting' && !held.has(row.customerId);
+    held.add(row.customerId);
     if (!free) continue;
-    const size = encoder.encode(JSON.stringify(entry.command)).length;
-    if (batch.length > 0 && bytes + size > MAX_PUSH_BYTES) break;
-    bytes += size;
-    batch.push(entry);
+    if (batch.length > 0 && bytes + row.bytes > MAX_PUSH_BYTES) break;
+    bytes += row.bytes;
+    batch.push(row);
   }
   return batch;
 }
 
 // Takes the next batch and marks it as being sent, in one transaction: a form that opens one of
 // these commands now sees that it cannot rewrite it (outbox.ts → isOpen). `sent` stays true from
-// here on: the server may run it even if its answer never comes.
-export async function takeBatch(db: SyncDatabase): Promise<OutboxEntry[]> {
-  return db.transaction('rw', db.outbox, async () => {
+// here on: the server may run it even if its answer never comes. The batch is opened after the
+// transaction (the commands are what the push sends); status and sent are clear, so marking it
+// needs no key.
+export async function takeBatch(copy: LocalCopy): Promise<OutboxEntry[]> {
+  const { db } = copy;
+  const rows = await db.transaction('rw', db.outbox, async () => {
     const batch = pickBatch(await db.outbox.toArray());
-    const sending = batch.map((entry) => ({ ...entry, status: 'sending' as const, sent: true }));
+    const sending = batch.map((row) => ({ ...row, status: 'sending' as const, sent: true }));
     await db.outbox.bulkPut(sending);
     return sending;
   });
+  return openEntries(copy, rows);
 }
 
 // The push failed as a whole (no connection, a server error): its commands wait for the next
-// sync. They stay `sent`, so they go again as they are.
+// sync. They stay `sent`, so they go again as they are. Clear fields only: no key needed.
 export async function releaseBatch(db: SyncDatabase, batch: readonly OutboxEntry[]): Promise<void> {
   await db.transaction('rw', db.outbox, async () => {
     for (const entry of batch) {
@@ -75,47 +79,93 @@ export async function resetSending(db: SyncDatabase): Promise<void> {
   await db.outbox.filter((entry) => entry.status === 'sending').modify({ status: 'waiting' });
 }
 
+// What one answer changes, sealed before the transaction (a transaction cannot wait for Web
+// Crypto). A command being sent cannot change meanwhile: no form rewrites it (isOpen) and Discard
+// leaves it alone, so the row sealed here is still right when the transaction writes it.
+type Planned =
+  | { kind: 'unanswered'; seq: number }
+  | { kind: 'rejected'; row: OutboxRow }
+  | { kind: 'accepted'; seq: number; changes: SealedChanges; notice: NoticeRow | null };
+
+async function plan(
+  copy: LocalCopy,
+  entry: OutboxEntry & { seq: number },
+  result: SyncResult | undefined,
+  serverTime: string,
+): Promise<Planned> {
+  // Not answered: the server stopped part way (it never does; the contract answers every
+  // command). It is sent again.
+  if (!result) return { kind: 'unanswered', seq: entry.seq };
+  if (result.status === 'rejected') {
+    return {
+      kind: 'rejected',
+      row: await sealEntry(copy, { ...entry, status: 'failed', error: result.error }),
+    };
+  }
+  const kept = result.notices.filter((notice) => notice.code === 'kept_server_value');
+  return {
+    kind: 'accepted',
+    seq: entry.seq,
+    changes: await sealChanges(copy, result.changes),
+    notice:
+      kept.length === 0
+        ? null
+        : await sealNotice(copy, {
+            commandId: entry.command.id,
+            customerId: entry.customerId,
+            name: entry.name,
+            fields: kept.flatMap((notice) => notice.fields),
+            at: serverTime,
+          }),
+  };
+}
+
 // The answers, in one transaction with the rows they bring: an accepted command leaves the outbox
 // in the same moment its customer is written, so a list never shows it twice or not at all. A
 // refused one stays, with its error, until the person fixes or discards it (decision 7).
 export async function applyAnswers(
-  db: SyncDatabase,
+  copy: LocalCopy,
   batch: readonly OutboxEntry[],
   answer: SyncPush,
 ): Promise<PushOutcome> {
+  const { db } = copy;
   const results = new Map<string, SyncResult>(answer.results.map((result) => [result.id, result]));
-  return db.transaction('rw', [...db.syncTables(), db.meta, db.outbox, db.notices], async () => {
+  const planned = await Promise.all(
+    batch.flatMap((entry) =>
+      entry.seq === undefined
+        ? []
+        : [
+            plan(
+              copy,
+              { ...entry, seq: entry.seq },
+              results.get(entry.command.id),
+              answer.serverTime,
+            ),
+          ],
+    ),
+  );
+  const tables = [...db.syncTables(), db.meta, db.marks, db.outbox, db.notices];
+  return db.transaction('rw', tables, async () => {
     const { generation } = await readPullState(db);
     const outcome = { ...NO_PUSH };
-    for (const entry of batch) {
-      if (entry.seq === undefined) continue;
-      const result = results.get(entry.command.id);
-      if (!result) {
-        // Not answered: the server stopped part way (it never does; the contract answers every
-        // command). It is sent again.
-        await db.outbox.update(entry.seq, { status: 'waiting' });
+    for (const item of planned) {
+      if (item.kind === 'unanswered') {
+        await db.outbox.update(item.seq, { status: 'waiting' });
         continue;
       }
-      if (result.status === 'rejected') {
+      if (item.kind === 'rejected') {
         outcome.rejected += 1;
-        await db.outbox.update(entry.seq, { status: 'failed', error: result.error });
+        await db.outbox.put(item.row);
         continue;
       }
       outcome.accepted += 1;
       // The rows as they are on the server now, at the generation of the running pull: a full
       // pull that is half way keeps them (apply.ts)
-      await writeChanges(db, result.changes, generation);
-      await db.outbox.delete(entry.seq);
-      const kept = result.notices.filter((notice) => notice.code === 'kept_server_value');
-      if (kept.length > 0) {
+      await writeSealed(db, item.changes, generation);
+      await db.outbox.delete(item.seq);
+      if (item.notice) {
         outcome.kept += 1;
-        await db.notices.put({
-          commandId: entry.command.id,
-          customerId: entry.customerId,
-          name: entry.name,
-          fields: kept.flatMap((notice) => notice.fields),
-          at: answer.serverTime,
-        });
+        await db.notices.put(item.notice);
       }
     }
     return outcome;
```

- **`pickBatch` reads only the routing fields** (decision 11), so `takeBatch` still picks and marks a batch in one
  transaction. The size is the `bytes` counted at the save, not the command's JSON measured again.
- **`takeBatch` opens the batch after the transaction.** The engine sends the commands themselves, so it needs them
  opened; marking them `sending` needed only the clear `status` and `sent`.
- **`releaseBatch` and `resetSending` did not change.** They write only `status`, which is readable.
- **`plan` seals what each answer changes, before the transaction.** A refused command gets a new box with its error
  in it; an accepted one gets its rows sealed (`sealChanges`) and, if the server kept a head-office field, a sealed
  notice.
- **Why sealing a refused entry outside the transaction is safe:** a command being sent cannot change meanwhile. No
  form rewrites it (it is `sent`, so `isOpen` is false), Discard leaves a `sending` command alone, and only the tab that
  holds the sync lock pushes. The row sealed here is still the right one when the transaction writes it.
- **`entry.seq === undefined ? [] : […]`.** Entries from `takeBatch` always have a `seq`; `flatMap` narrows the type
  so `plan` gets `seq: number` without a cast.
- **The transaction holds `db.marks`** because an accepted customer's row is written through `writeSealed`.
- **`db.outbox.put(item.row)`** replaces the refused row whole: its status and its box (with the error) change
  together.

### `outbox.ts`: saving with sealed commands

```diff
@@ -10,11 +10,17 @@ import {
 } from '@omnivo/contracts';
 import { uuidv7 } from 'uuidv7';
 
-import type { OutboxEntry, SyncDatabase } from './database.js';
+import type { LocalCopy } from './copy.js';
+import type { OutboxEntry, OutboxRow } from './database.js';
+import { openEntries, openEntry, sealEntry } from './sealed.js';
 
 // Saving work done on the device as commands (step 18b), and the outbox's own changes: retry,
-// discard. No Dexie import: everything goes through the database the session opened, so the
-// forms that save here stay small (see index.ts).
+// discard. No Dexie import: everything goes through the copy the session opened, so the forms
+// that save here stay small (see index.ts).
+//
+// Step 19b: the commands are sealed, and a transaction cannot wait for Web Crypto. So a save opens
+// what it needs first, seals what it writes, and only then starts the transaction, which decides on
+// the clear fields (status, sent, the command's id) alone.
 
 // saved: in the outbox. unchanged: the form holds what the customer already has, so nothing is
 // sent. busy: the command is on its way to the server, or was sent without an answer, so it
@@ -24,7 +30,7 @@ export type SaveResult = 'saved' | 'unchanged' | 'busy';
 // A command the server certainly never ran: it was refused, or never sent. Only these may be
 // rewritten. A sent command without an answer may have run (the answer was lost), so it is sent
 // again as it is, and a change after it is a command of its own.
-export function isOpen(entry: OutboxEntry): boolean {
+export function isOpen(entry: Pick<OutboxEntry, 'status' | 'sent'>): boolean {
   return entry.status === 'failed' || (entry.status === 'waiting' && !entry.sent);
 }
 
```

- **`isOpen` takes only `status` and `sent`.** Both are on the opened entry and on the row, so the same rule decides
  for the Sync page (entries) and for the transactions below (rows).

```diff
@@ -158,71 +164,88 @@ function entryOf(
   };
 }
 
+// What saveCustomer writes, worked out from the customer's entries, opened
+interface CustomerWrites {
+  deletes: number[];
+  // With a seq: written in that entry's place. Without: added at the end.
+  put: OutboxEntry | null;
+  result: SaveResult;
+}
+
 // A new customer, or a change to one (decision 33). The customer's open commands (never sent, or
 // refused) are folded into the first of them, which keeps its place in the outbox: an order on
 // this device for a new customer stays behind that customer's create. The folded command gets a
 // new id: a refused id is answered from what the server kept (decision 10).
-export async function saveCustomer(db: SyncDatabase, save: CustomerSave): Promise<SaveResult> {
+function customerWrites(
+  entries: readonly OutboxEntry[],
+  save: CustomerSave,
+  customerId: string,
+): CustomerWrites {
+  const open = entries.filter(
+    (entry) => entry.command.type !== 'sales_order.create_draft' && isOpen(entry),
+  );
+  const [first, ...rest] = open;
+  const folded = rest.flatMap((entry) => entry.seq ?? []);
+  const fields = { customerId, key: customerId, name: save.input.name, savedAt: save.savedAt };
+  if (first?.seq !== undefined) {
+    // A create stays a create, with what the form holds now. A change is worked out again from
+    // the first change's base, so its `from` values stay the ones the person first saw.
+    const base = first.base ?? save.base;
+    const command =
+      first.command.type === 'customer.create'
+        ? createCommand(customerId, save.input)
+        : base && updateCommand(base, save.input);
+    // Changed back to what the customer has: nothing is left to send
+    if (command === null) return { deletes: [...folded, first.seq], put: null, result: 'saved' };
+    return {
+      deletes: folded,
+      put: { ...entryOf(command, { ...fields, base: first.base }), seq: first.seq },
+      result: 'saved',
+    };
+  }
+  if (save.base === null) {
+    return {
+      deletes: [],
+      put: entryOf(createCommand(customerId, save.input), { ...fields, base: null }),
+      result: 'saved',
+    };
+  }
+  const command = updateCommand(save.base, save.input);
+  if (command === null) return { deletes: [], put: null, result: 'unchanged' };
+  return { deletes: [], put: entryOf(command, { ...fields, base: save.base }), result: 'saved' };
+}
+
+// What a customer's commands are, in short: a save writes only if they are still the ones it
+// opened. Every rewrite gives a command a new id, and a push changes the status.
+function stateOf(rows: readonly OutboxRow[]): string {
+  return rows
+    .map((row) => `${String(row.seq)}:${row.commandId}:${row.status}:${String(row.sent)}`)
+    .join(',');
+}
+
+const SAVE_ATTEMPTS = 3;
+
+// Opened, worked out and sealed outside the transaction; written only if no one changed this
+// customer's commands in between (another tab saved, the push took them). Then it starts again
+// from what is there now. Three times in a row would take three saves racing on one customer.
+export async function saveCustomer(copy: LocalCopy, save: CustomerSave): Promise<SaveResult> {
+  const { db } = copy;
   const customerId = save.base?.id ?? uuidv7();
-  return db.transaction('rw', db.outbox, async () => {
-    const entries = await db.outbox.where('customerId').equals(customerId).sortBy('seq');
-    const open = entries.filter(
-      (entry) => entry.command.type !== 'sales_order.create_draft' && isOpen(entry),
-    );
-    const [first, ...rest] = open;
-    if (first?.seq !== undefined) {
-      // A create stays a create, with what the form holds now. A change is worked out again from
-      // the first change's base, so its `from` values stay the ones the person first saw.
-      const base = first.base ?? save.base;
-      const command =
-        first.command.type === 'customer.create'
-          ? createCommand(customerId, save.input)
-          : base && updateCommand(base, save.input);
-      await db.outbox.bulkDelete(
-        rest.flatMap((entry) => (entry.seq === undefined ? [] : [entry.seq])),
-      );
-      if (command === null) {
-        // Changed back to what the customer has: nothing is left to send
-        await db.outbox.delete(first.seq);
-        return 'saved';
-      }
-      await db.outbox.put({
-        ...entryOf(command, {
-          customerId,
-          key: customerId,
-          base: first.base,
-          name: save.input.name,
-          savedAt: save.savedAt,
-        }),
-        seq: first.seq,
-      });
-      return 'saved';
-    }
-    if (save.base === null) {
-      await db.outbox.add(
-        entryOf(createCommand(customerId, save.input), {
-          customerId,
-          key: customerId,
-          base: null,
-          name: save.input.name,
-          savedAt: save.savedAt,
-        }),
-      );
-      return 'saved';
-    }
-    const command = updateCommand(save.base, save.input);
-    if (command === null) return 'unchanged';
-    await db.outbox.add(
-      entryOf(command, {
-        customerId,
-        key: customerId,
-        base: save.base,
-        name: save.input.name,
-        savedAt: save.savedAt,
-      }),
-    );
-    return 'saved';
-  });
+  const rowsOf = () => db.outbox.where('customerId').equals(customerId).sortBy('seq');
+  for (let attempt = 1; ; attempt += 1) {
+    const rows = await rowsOf();
+    const writes = customerWrites(await openEntries(copy, rows), save, customerId);
+    const row = writes.put && (await sealEntry(copy, writes.put));
+    const written = await db.transaction('rw', db.outbox, async () => {
+      if (stateOf(await rowsOf()) !== stateOf(rows)) return false;
+      await db.outbox.bulkDelete(writes.deletes);
+      // put: in the first entry's place when it has a seq, else at the end (auto-increment)
+      if (row) await db.outbox.put(row);
+      return true;
+    });
+    if (written) return writes.result;
+    if (attempt === SAVE_ATTEMPTS) throw new Error('The outbox kept changing during the save');
+  }
 }
 
 export interface OrderSave {
```

- **`customerWrites` is 18b's folding logic, unchanged, as a pure function.** It returns what to delete and what to
  put instead of writing it, so the writing can wait until everything is sealed.
- **`stateOf` sums up a customer's rows** as their seq, command id, status and sent flag. Every rewrite gives a
  command a new id, and a push changes the status, so any change another tab or the sync could make in between
  changes this string.
- **`saveCustomer` opens, plans, seals, and only then writes** (decision 9). The transaction reads the customer's rows
  again and writes only if `stateOf` is the same as when they were opened. If not (the push took the waiting change
  while this save was sealing), it starts again from what is there now. Folding into a command the server may already
  run would be the bug of decision 33 in 18b.
- **Three attempts.** A second change in the few milliseconds of one attempt is already rare; three in a row would
  need a loop of saves racing on one customer, which is a bug, and the error says so instead of looping forever.
- **`db.outbox.put(row)`** writes in the first entry's place when the row has a `seq` (a fold), and adds at the end
  when it has none (`++seq` gives it the next number).

```diff
@@ -236,27 +259,32 @@ export interface OrderSave {
 }
 
 // A draft order (decision 15). Saved again, it goes to the end of the outbox: an order needs
-// nothing after it, and its customer may now be one added on this device after it.
-export async function saveOrderDraft(db: SyncDatabase, save: OrderSave): Promise<SaveResult> {
+// nothing after it, and its customer may now be one added on this device after it. The new entry
+// does not depend on the old one, so it is sealed first, and the transaction only checks the old
+// one's clear fields.
+export async function saveOrderDraft(copy: LocalCopy, save: OrderSave): Promise<SaveResult> {
+  const { db } = copy;
   const orderId = save.orderId ?? uuidv7();
+  const row = await sealEntry(
+    copy,
+    entryOf(
+      { id: uuidv7(), type: 'sales_order.create_draft', orderId, input: save.input },
+      {
+        customerId: save.input.customerId,
+        key: orderId,
+        base: null,
+        name: save.name,
+        savedAt: save.savedAt,
+        lines: save.input.lines.length,
+        total: save.total,
+      },
+    ),
+  );
   return db.transaction('rw', db.outbox, async () => {
-    const [entry] = await db.outbox.where('key').equals(orderId).toArray();
-    if (entry && !isOpen(entry)) return 'busy';
-    if (entry?.seq !== undefined) await db.outbox.delete(entry.seq);
-    await db.outbox.add(
-      entryOf(
-        { id: uuidv7(), type: 'sales_order.create_draft', orderId, input: save.input },
-        {
-          customerId: save.input.customerId,
-          key: orderId,
-          base: null,
-          name: save.name,
-          savedAt: save.savedAt,
-          lines: save.input.lines.length,
-          total: save.total,
-        },
-      ),
-    );
+    const [old] = await db.outbox.where('key').equals(orderId).toArray();
+    if (old && !isOpen(old)) return 'busy';
+    if (old?.seq !== undefined) await db.outbox.delete(old.seq);
+    await db.outbox.add(row);
     return 'saved';
   });
 }
@@ -264,48 +292,65 @@ export async function saveOrderDraft(db: SyncDatabase, save: OrderSave): Promise
 // ---------------------------------------------------------------------------------------------
 // The Sync page
 
+// The later commands on the same customer
+function later<E extends Pick<OutboxEntry, 'seq' | 'customerId'>>(
+  items: readonly E[],
+  item: E,
+): E[] {
+  const { seq } = item;
+  if (seq === undefined) return [];
+  return items.filter((other) => other.customerId === item.customerId && (other.seq ?? 0) > seq);
+}
+
 // What goes with an entry when it is discarded: a new customer takes every later command on that
 // customer (its changes and its orders), which the server could only refuse without it. A change
 // or an order goes alone.
 export function dependentsOf(entries: readonly OutboxEntry[], entry: OutboxEntry): OutboxEntry[] {
-  if (entry.command.type !== 'customer.create' || entry.seq === undefined) return [];
-  const { seq } = entry;
-  return entries.filter((other) => other.customerId === entry.customerId && (other.seq ?? 0) > seq);
+  return entry.command.type === 'customer.create' ? later(entries, entry) : [];
 }
 
 // Discard: the entry and its dependents leave the device and never reach the server. A command
-// being sent is left alone (busy); the page offers Discard again once it has its answer.
-export async function discardEntry(db: SyncDatabase, seq: number): Promise<SaveResult> {
+// being sent is left alone (busy); the page offers Discard again once it has its answer. The
+// clear fields say all of it: nothing is opened.
+export async function discardEntry(copy: LocalCopy, seq: number): Promise<SaveResult> {
+  const { db } = copy;
   return db.transaction('rw', db.outbox, async () => {
-    const entry = await db.outbox.get(seq);
-    if (!entry) return 'unchanged';
-    if (entry.status === 'sending') return 'busy';
-    const others = await db.outbox.where('customerId').equals(entry.customerId).toArray();
-    const gone = [entry, ...dependentsOf(others, entry)].filter(
+    const row = await db.outbox.get(seq);
+    if (!row) return 'unchanged';
+    if (row.status === 'sending') return 'busy';
+    const others = await db.outbox.where('customerId').equals(row.customerId).toArray();
+    const gone = [row, ...(row.type === 'customer.create' ? later(others, row) : [])].filter(
       (item) => item.status !== 'sending',
     );
-    await db.outbox.bulkDelete(gone.flatMap((item) => (item.seq === undefined ? [] : [item.seq])));
+    await db.outbox.bulkDelete(gone.flatMap((item) => item.seq ?? []));
     return 'saved';
   });
 }
 
 // Retry a refused command as it is, under a new id (the old id's refusal is kept on the server).
-// For a refusal that was not the command's fault: a permission given back, a code freed.
-export async function retryEntry(db: SyncDatabase, seq: number): Promise<SaveResult> {
+// For a refusal that was not the command's fault: a permission given back, a code freed. Opened
+// and sealed again first; written only if it is still the same refused command.
+export async function retryEntry(copy: LocalCopy, seq: number): Promise<SaveResult> {
+  const { db } = copy;
+  const row = await db.outbox.get(seq);
+  if (row?.status !== 'failed') return 'unchanged';
+  const entry = await openEntry(copy, row);
+  const next = await sealEntry(copy, {
+    ...entry,
+    command: { ...entry.command, id: uuidv7() },
+    status: 'waiting',
+    sent: false,
+    error: null,
+  });
   return db.transaction('rw', db.outbox, async () => {
-    const entry = await db.outbox.get(seq);
-    if (entry?.status !== 'failed') return 'unchanged';
-    await db.outbox.put({
-      ...entry,
-      command: { ...entry.command, id: uuidv7() },
-      status: 'waiting',
-      sent: false,
-      error: null,
-    });
+    const now = await db.outbox.get(seq);
+    // Discarded, edited or retried meanwhile (another tab): this retry is out of date
+    if (now?.status !== 'failed' || now.commandId !== row.commandId) return 'unchanged';
+    await db.outbox.put(next);
     return 'saved';
   });
 }
 
-export async function dismissNotice(db: SyncDatabase, commandId: string): Promise<void> {
-  await db.notices.delete(commandId);
+export async function dismissNotice(copy: LocalCopy, commandId: string): Promise<void> {
+  await copy.db.notices.delete(commandId);
 }
```

- **`saveOrderDraft` seals the new entry first** and needs no retry: the new command does not depend on the old one.
  The transaction only checks the old row's clear fields (`isOpen`) and replaces it.
- **`later` is the "same customer, later seq" rule,** generic over rows and entries. `dependentsOf` (the Sync page's
  count, on opened entries) and `discardEntry` (on rows, in a transaction) both use it.
- **`discardEntry` opens nothing:** the row's `type`, `customerId`, `seq` and `status` say everything it needs.
- **`retryEntry` opens and seals before the transaction,** then writes only if the row is still the same refused
  command (same `commandId`, still `failed`). Another tab may have retried or discarded it meanwhile; then this retry
  is out of date, and says `unchanged`.

### `queries.ts`: the reads

```diff
@@ -10,20 +10,26 @@ import {
 
 import type { Table } from 'dexie';
 
-import type {
-  CustomerRecord,
-  OutboxEntry,
-  ProductRecord,
-  Stored,
-  SyncDatabase,
-  SyncNoticeRecord,
-} from './database.js';
+import type { LocalCopy } from './copy.js';
+import type { OutboxEntry, SealedRow, SyncNoticeRecord } from './database.js';
 import { projectCustomer } from './overlay.js';
-import { customerMatches, customerRecord, needleOf, productMatches } from './records.js';
+import {
+  type CustomerRecord,
+  customerMatches,
+  customerRecord,
+  needleOf,
+  type ProductRecord,
+  productMatches,
+} from './records.js';
+import { openEntries, openNotices, openRows } from './sealed.js';
 
 // The reads of the products and customers pages and of the pickers. Each is a plain async
-// function of the database, so the app runs it inside Dexie's liveQuery (useLiveQuery), and it
-// runs again by itself when a pull writes to the tables it read.
+// function of the copy, so the app runs it inside the copy's watch (LocalCopy.watch), and it runs
+// again by itself when a pull writes to what it read.
+//
+// Step 19b: the rows are sealed. The lists of products and customers read the in-memory copy
+// (copy.ts → Mirror.current), which is already open and is sorted once per change. The other reads
+// take their few rows from IndexedDB and open them.
 
 // What a list shows: the first `limit` rows in order, and whether there are more. The page asks
 // for more as the person scrolls (the DataTable's onEndReached), like a server page.
@@ -44,25 +50,60 @@ export interface LocalProductFilter {
   limit: number;
 }
 
-// The index walks the rows in order and the filter stops once it has limit + 1 matches: the first
-// screen of a long list costs as much as one screen, not the whole table. Two rows with the same
-// name come in key (id) order, like the server's (lower(name), id).
+// The server's order: lower(name) (or lower(code)), then the id. Plain `<` compares strings by
+// code unit, the way the IndexedDB index did before step 19b.
+function byKey(a: { key: string }, b: { key: string }): number {
+  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
+}
+
+function byProductName(a: ProductRecord, b: ProductRecord): number {
+  if (a.sortName !== b.sortName) return a.sortName < b.sortName ? -1 : 1;
+  return byKey(a, b);
+}
+
+function byProductCode(a: ProductRecord, b: ProductRecord): number {
+  if (a.sortCode !== b.sortCode) return a.sortCode < b.sortCode ? -1 : 1;
+  return byKey(a, b);
+}
+
+// The first `limit` matches in `order` (backwards for a '-' sort), and whether there are more.
+// The walk stops at limit + 1 matches: a search that matches early costs little even in a long
+// list.
+function firstMatches<E>(
+  order: readonly E[],
+  backwards: boolean,
+  matches: (entry: E) => boolean,
+  limit: number,
+): E[] {
+  const found: E[] = [];
+  for (let step = 0; step < order.length && found.length <= limit; step += 1) {
+    const entry = order[backwards ? order.length - 1 - step : step];
+    if (entry !== undefined && matches(entry)) found.push(entry);
+  }
+  return found;
+}
+
+// Two rows with the same name come in key (id) order, like the server's (lower(name), id); a '-'
+// sort is the whole order backwards, as the index's reverse() was.
 export async function productPage(
-  db: SyncDatabase,
+  copy: LocalCopy,
   filter: LocalProductFilter,
 ): Promise<LocalPage<Product>> {
   const needle = needleOf(filter.search);
-  const index = filter.sort === 'code' || filter.sort === '-code' ? 'sortCode' : 'sortName';
-  const ordered = db.products.orderBy(index);
-  const found = await (filter.sort.startsWith('-') ? ordered.reverse() : ordered)
-    .filter(
-      (record: ProductRecord) =>
-        (filter.categoryIds === null ||
-          (record.data.categoryId !== null && filter.categoryIds.has(record.data.categoryId))) &&
-        productMatches(record, needle),
-    )
-    .limit(filter.limit + 1)
-    .toArray();
+  const products = await copy.products.current();
+  const byCode = filter.sort === 'code' || filter.sort === '-code';
+  const order = byCode
+    ? products.ordered('code', byProductCode)
+    : products.ordered('name', byProductName);
+  const found = firstMatches(
+    order,
+    filter.sort.startsWith('-'),
+    (record) =>
+      (filter.categoryIds === null ||
+        (record.data.categoryId !== null && filter.categoryIds.has(record.data.categoryId))) &&
+      productMatches(record, needle),
+    filter.limit,
+  );
   return {
     rows: found.slice(0, filter.limit).map((record) => record.data),
     more: found.length > filter.limit,
```

- **`byProductName` and `byProductCode` are the old index order.** IndexedDB sorted the `sortName` index by the value,
  then by the primary key, comparing strings by UTF-16 code unit. Plain `<` on strings compares the same way, so the
  products page shows the same order as in step 18.
- **`firstMatches` stops at `limit + 1`.** The `+ 1` is how the page knows there are more rows, as before. Walking
  backwards gives the `'-name'` order, as `reverse()` on the index did, ties included.
- **`productPage` waits for `copy.products.current()`** (decision 13) and then reads memory only.

```diff
@@ -80,27 +121,32 @@ export interface LocalCustomerFilter {
 // The customers the outbox changes (step 18b, decision 34), as the screens show them: the
 // server's row with the waiting commands on top, or a customer made on this device. null = the
 // device does not have it (a change to a customer archived meanwhile). A handful at most: the
-// outbox of one person.
-async function pendingCustomers(db: SyncDatabase): Promise<Map<string, SyncCustomer | null>> {
-  const entries = await db.outbox.toArray();
-  const ids = new Set(
-    entries.flatMap((entry) =>
-      entry.command.type === 'sales_order.create_draft' ? [] : [entry.customerId],
+// outbox of one person. The ids come from the rows' clear fields; the rows are opened after the
+// reads.
+async function pendingCustomers(copy: LocalCopy): Promise<Map<string, SyncCustomer | null>> {
+  const { db } = copy;
+  const rows = await db.outbox.toArray();
+  const ids = [
+    ...new Set(
+      rows.flatMap((row) => (row.type === 'sales_order.create_draft' ? [] : [row.customerId])),
     ),
-  );
+  ];
+  const customers = await db.customers.bulkGet(ids);
+  const entries = await openEntries(copy, rows);
   const pending = new Map<string, SyncCustomer | null>();
-  for (const id of ids) {
-    const row = await db.customers.get(id);
-    pending.set(id, projectCustomer(id, row?.data ?? null, entries));
-  }
+  await Promise.all(
+    ids.map(async (id, index) => {
+      const row = customers[index];
+      const data = row ? await copy.open('customers', row.key, row.box) : null;
+      pending.set(id, projectCustomer(id, data, entries));
+    }),
+  );
   return pending;
 }
 
-// The server's order: lower(name), then the id. Plain `<` compares strings by code unit, the
-// way IndexedDB orders its index.
-function byName(a: CustomerRecord, b: CustomerRecord): number {
+function byCustomerName(a: CustomerRecord, b: CustomerRecord): number {
   if (a.sortName !== b.sortName) return a.sortName < b.sortName ? -1 : 1;
-  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
+  return byKey(a, b);
 }
 
 // `pending`: the ids the outbox changes, for the "Not synced" pill
@@ -108,28 +154,30 @@ export interface LocalCustomerPage extends LocalPage<SyncCustomer> {
   pending: ReadonlySet<string>;
 }
 
-// The walk of the index skips the customers the outbox changes, and their projected rows are put
-// back in their place. There are only a few, so the first `limit` of the two lists merged are the
-// first `limit` of all: every row past the walk's limit + 1 comes after all of them.
+// The walk skips the customers the outbox changes, and their projected rows are put back in their
+// place. There are only a few, so the first `limit` of the two lists merged are the first `limit`
+// of all: every row past the walk's limit + 1 comes after all of them.
 export async function customerPage(
-  db: SyncDatabase,
+  copy: LocalCopy,
   filter: LocalCustomerFilter,
 ): Promise<LocalCustomerPage> {
   const needle = needleOf(filter.search);
-  const pending = await pendingCustomers(db);
+  const pending = await pendingCustomers(copy);
+  const customers = await copy.customers.current();
   const matches = (record: CustomerRecord) =>
     (filter.groupId === '' || record.data.groupId === filter.groupId) &&
     customerMatches(record, needle);
-  const ordered = db.customers.orderBy('sortName');
-  const walked = await (filter.sort === '-name' ? ordered.reverse() : ordered)
-    .filter((record: CustomerRecord) => !pending.has(record.key) && matches(record))
-    .limit(filter.limit + 1)
-    .toArray();
+  const walked = firstMatches(
+    customers.ordered('name', byCustomerName),
+    filter.sort === '-name',
+    (record) => !pending.has(record.key) && matches(record),
+    filter.limit,
+  );
   const projected = [...pending.values()]
-    .flatMap((row) => (row?.archivedAt !== null ? [] : [customerRecord(row.id, 0, row)]))
+    .flatMap((row) => (row?.archivedAt !== null ? [] : [customerRecord(row.id, row)]))
     .filter(matches);
   const direction = filter.sort === '-name' ? -1 : 1;
-  const found = [...walked, ...projected].sort((a, b) => direction * byName(a, b));
+  const found = [...walked, ...projected].sort((a, b) => direction * byCustomerName(a, b));
   return {
     rows: found.slice(0, filter.limit).map((record) => record.data),
     more: found.length > filter.limit,
@@ -138,23 +186,30 @@ export async function customerPage(
 }
 
 // One customer as the screens show it: the server's row with the outbox on top (step 18b). null =
-// not on this device.
+// not on this device. From IndexedDB, not the in-memory copy: the row and the outbox are then read
+// at the same moment, so a push's answer (which writes the one and deletes from the other in one
+// transaction) never shows the customer twice or not at all.
 export async function localCustomer(
-  db: SyncDatabase,
+  copy: LocalCopy,
   customerId: string,
 ): Promise<SyncCustomer | null> {
-  const [row, entries] = await Promise.all([
+  const { db } = copy;
+  const [row, rows] = await Promise.all([
     db.customers.get(customerId),
     db.outbox.where('customerId').equals(customerId).sortBy('seq'),
   ]);
-  return projectCustomer(customerId, row?.data ?? null, entries);
+  const [data, entries] = await Promise.all([
+    row ? copy.open('customers', row.key, row.box) : null,
+    openEntries(copy, rows),
+  ]);
+  return projectCustomer(customerId, data, entries);
 }
 
 // The pickers: the first 20 that match, by name, like the server's search
 export const PICKER_LIMIT = 20;
 
-export async function findProducts(db: SyncDatabase, search: string): Promise<Product[]> {
-  const page = await productPage(db, {
+export async function findProducts(copy: LocalCopy, search: string): Promise<Product[]> {
+  const page = await productPage(copy, {
     search,
     categoryIds: null,
     sort: 'name',
```

- **`pendingCustomers` reads first, opens after.** The customer ids come from the rows' clear fields, so the customers
  are fetched in one `bulkGet` before anything is opened.
- **`customerPage` reads the outbox before `copy.customers.current()`.** Both are in the same liveQuery, so a push's
  answer (which writes a customer and deletes its command together) runs the read again, and the read waits until the
  in-memory copy has the customer. It is never missing from the list for a moment.
- **`localCustomer` reads IndexedDB, not the in-memory copy.** One customer costs one open, and reading the row and
  its outbox in the same moment keeps 18b's rule: never shown twice or not at all.

```diff
@@ -163,14 +218,18 @@ export async function findProducts(db: SyncDatabase, search: string): Promise<Pr
   return page.rows;
 }
 
-export async function findCustomers(db: SyncDatabase, search: string): Promise<SyncCustomer[]> {
-  const page = await customerPage(db, { search, groupId: '', sort: 'name', limit: PICKER_LIMIT });
+export async function findCustomers(copy: LocalCopy, search: string): Promise<SyncCustomer[]> {
+  const page = await customerPage(copy, { search, groupId: '', sort: 'name', limit: PICKER_LIMIT });
   return page.rows;
 }
 
-// A small table whole, as the server's rows (units, categories, groups: tens of rows)
-export async function allRows<T>(table: Table<Stored<T>, string>): Promise<T[]> {
-  return (await table.toArray()).map((record) => record.data);
+// A small table whole, as the server's rows (units, categories, groups: tens of rows), opened.
+// The table's own name is the label its rows were sealed under (apply.ts).
+export async function allRows<T>(
+  copy: LocalCopy,
+  table: Table<SealedRow<T>, string>,
+): Promise<T[]> {
+  return openRows(copy, table.name, await table.toArray());
 }
 
 // The list's row from the whole product, the way the server's list works it out
@@ -219,30 +278,35 @@ export function customerSummaryOf(customer: SyncCustomer): CustomerSummary {
 // The outbox (step 18b)
 
 // Every waiting command, oldest first (the primary key is the seq)
-export function outboxEntries(db: SyncDatabase): Promise<OutboxEntry[]> {
-  return db.outbox.toArray();
+export async function outboxEntries(copy: LocalCopy): Promise<OutboxEntry[]> {
+  return openEntries(copy, await copy.db.outbox.toArray());
 }
 
 // The commands of one customer or one order: a form opens its waiting command by its key, and a
 // customer with commands is changed through the outbox, even online (decision 2)
-export function outboxOf(db: SyncDatabase, key: string): Promise<OutboxEntry[]> {
-  return db.outbox.where('key').equals(key).sortBy('seq');
+export async function outboxOf(copy: LocalCopy, key: string): Promise<OutboxEntry[]> {
+  return openEntries(copy, await copy.db.outbox.where('key').equals(key).sortBy('seq'));
 }
 
-export function customerCommands(db: SyncDatabase, customerId: string): Promise<OutboxEntry[]> {
-  return db.outbox.where('customerId').equals(customerId).sortBy('seq');
+export async function customerCommands(
+  copy: LocalCopy,
+  customerId: string,
+): Promise<OutboxEntry[]> {
+  return openEntries(
+    copy,
+    await copy.db.outbox.where('customerId').equals(customerId).sortBy('seq'),
+  );
 }
 
-// What the sidebar counts: every command on the device, and the refused ones among them
-export async function outboxCounts(db: SyncDatabase): Promise<{ total: number; failed: number }> {
-  const entries = await db.outbox.toArray();
-  return {
-    total: entries.length,
-    failed: entries.filter((entry) => entry.status === 'failed').length,
-  };
+// What the sidebar counts: every command on the device, and the refused ones among them. The
+// status is clear, so nothing is opened: the count runs on every outbox change, in every tab.
+export async function outboxCounts(copy: LocalCopy): Promise<{ total: number; failed: number }> {
+  const rows = await copy.db.outbox.toArray();
+  return { total: rows.length, failed: rows.filter((row) => row.status === 'failed').length };
 }
 
 // The kept-from-the-server notices, newest first
-export async function syncNotices(db: SyncDatabase): Promise<SyncNoticeRecord[]> {
-  return (await db.notices.toArray()).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
+export async function syncNotices(copy: LocalCopy): Promise<SyncNoticeRecord[]> {
+  const notices = await openNotices(copy, await copy.db.notices.toArray());
+  return notices.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
 }
```

- **`allRows` takes the copy and the table.** The table's `name` is the label its rows were sealed under.
- **`outboxCounts` opens nothing.** The sidebar's count runs after every outbox change in every tab; the status alone
  answers it.
- **`syncNotices` sorts after opening:** the time is inside the box.

### `prices.ts`: the price lookup

```diff
@@ -5,19 +5,25 @@ import {
   startingPrice,
 } from '@omnivo/contracts';
 
-import type { SyncDatabase } from './database.js';
+import type { LocalCopy } from './copy.js';
+import { openRows } from './sealed.js';
 
 // The sales price lookup on the device (step 18b, decision 19): the same answer as
-// POST /sales-prices/lookup, from the copy, for the order form without a connection.
+// POST /sales-prices/lookup, from the copy, for the order form without a connection. Step 19b:
+// the few rows it needs are read from IndexedDB by their clear ids, then opened.
 
 // The products of some variants, by variant, with one index read (`*variantIds`)
 export async function productsOfVariants(
-  db: SyncDatabase,
+  copy: LocalCopy,
   variantIds: readonly string[],
 ): Promise<Map<string, Product>> {
-  const records = await db.products.where('variantIds').anyOf(variantIds).distinct().toArray();
+  const rows = await copy.db.products.where('variantIds').anyOf(variantIds).distinct().toArray();
+  const products = await openRows(copy, 'products', rows);
   return new Map(
-    records.flatMap((record) => record.variantIds.map((id) => [id, record.data] as const)),
+    rows.flatMap((row, index) => {
+      const product = products[index];
+      return product ? row.variantIds.map((id) => [id, product] as const) : [];
+    }),
   );
 }
 
@@ -27,20 +33,29 @@ export async function productsOfVariants(
 // the product's own while it is active, else the workspace's default; no rate at all drops the
 // item (a workspace whose rates are not made yet).
 export async function lookUpPrices(
-  db: SyncDatabase,
+  copy: LocalCopy,
   priceListId: string | null,
   items: readonly { variantId: string; unitId: string }[],
 ): Promise<PriceLookupItem[]> {
-  const list = priceListId === null ? undefined : await db.priceLists.get(priceListId);
-  const activeList = list?.data.archivedAt === null ? list.data.id : null;
-  const rates = (await db.taxRates.toArray()).map((record) => record.data);
+  const { db } = copy;
+  const listRow = priceListId === null ? undefined : await db.priceLists.get(priceListId);
+  const list = listRow && (await copy.open('priceLists', listRow.key, listRow.box));
+  const activeList = list?.archivedAt === null ? list.id : null;
+  const rates = await openRows(copy, 'taxRates', await db.taxRates.toArray());
   const defaultRate = rates.find((rate) => rate.isDefault);
   const products = await productsOfVariants(
-    db,
+    copy,
     items.map((item) => item.variantId),
   );
+  // Every item's price at once, by its key; undefined where the list has none
+  const listItems =
+    activeList === null
+      ? []
+      : await db.priceListItems.bulkGet(
+          items.map((item) => priceListItemKey({ priceListId: activeList, ...item })),
+        );
   const found: PriceLookupItem[] = [];
-  for (const item of items) {
+  for (const [index, item] of items.entries()) {
     const product = products.get(item.variantId);
     const variant = product?.variants.find((one) => one.id === item.variantId);
     if (!product || !variant) continue;
@@ -52,14 +67,12 @@ export async function lookUpPrices(
     const own = rates.find((rate) => rate.id === product.taxRateId && rate.archivedAt === null);
     const taxRateId = own?.id ?? defaultRate?.id;
     if (taxRateId === undefined) continue;
-    const listItem =
-      activeList === null
-        ? undefined
-        : await db.priceListItems.get(priceListItemKey({ priceListId: activeList, ...item }));
+    const listRow = listItems[index];
+    const listItem = listRow && (await copy.open('priceListItems', listRow.key, listRow.box));
     found.push({
       ...item,
       ...startingPrice({
-        listPrice: listItem?.data.price ?? null,
+        listPrice: listItem?.price ?? null,
         salePrice: variant.salePrice,
         factor,
       }),
```

- **`productsOfVariants` still uses the `variantIds` index,** then opens only the products it found.
- **The price items are read in one `bulkGet`,** by the keys made from the readable ids, instead of one `get` per
  item: the lookup runs on every line of an order form.
- **`listRow && (await copy.open(…))`** gives `undefined` for a list or an item the device does not have, as the old
  `get` did.

### `engine.ts`: the copy instead of the database

```diff
@@ -8,7 +8,7 @@ import {
 import { Dexie } from 'dexie';
 
 import { applyPage } from './apply.js';
-import type { SyncDatabase } from './database.js';
+import type { LocalCopy } from './copy.js';
 import { STORAGE_FAILED } from './problems.js';
 import {
   applyAnswers,
@@ -48,7 +48,8 @@ const webLock: LockRunner = async (name, fn) => {
 };
 
 export interface SyncEngineOptions {
-  db: SyncDatabase;
+  // Step 19b: the open copy (its key seals what the pull writes)
+  copy: LocalCopy;
   deviceId: string;
   // The app's API call (routes.sync.pull). The engine knows nothing of tokens or the API's url.
   pull: (query: SyncPullQuery) => Promise<SyncPull>;
@@ -168,7 +169,7 @@ export class SyncEngine {
     let problem: string | null = null;
     try {
       const lock = this.options.lock ?? webLock;
-      await lock(`omnivo-sync:${this.options.db.name}`, async () => {
+      await lock(`omnivo-sync:${this.options.copy.db.name}`, async () => {
         // The outbox first: the pull after it then brings what the commands changed, and a full
         // pull's sweep never meets a customer that is only in the outbox
         const outcome = await this.withRegistration(() => this.pushAll());
@@ -202,12 +203,12 @@ export class SyncEngine {
   // (push.ts), and an accepted customer frees the order that waited for it in the next round. A
   // refused command is marked failed and is not taken again, so the loop always ends.
   private async pushAll(): Promise<PushOutcome> {
-    const { db, deviceId } = this.options;
-    await resetSending(db);
+    const { copy, deviceId } = this.options;
+    await resetSending(copy.db);
     const outcome = { ...NO_PUSH };
     for (;;) {
       if (this.ended) return outcome;
-      const batch = await takeBatch(db);
+      const batch = await takeBatch(copy);
       if (batch.length === 0) return outcome;
       let answer: SyncPush;
       try {
@@ -217,10 +218,10 @@ export class SyncEngine {
           commands: batch.map((entry) => entry.command),
         });
       } catch (error) {
-        await releaseBatch(db, batch);
+        await releaseBatch(copy.db, batch);
         throw error;
       }
-      const round = await applyAnswers(db, batch, answer);
+      const round = await applyAnswers(copy, batch, answer);
       outcome.accepted += round.accepted;
       outcome.rejected += round.rejected;
       outcome.kept += round.kept;
@@ -232,8 +233,8 @@ export class SyncEngine {
   // Pages until hasMore is false. The cursor is read from the database, not kept in memory:
   // another tab may have pulled since, and it saved its own cursor there.
   private async pullAll(): Promise<void> {
-    const { db, deviceId, pageSize = 500 } = this.options;
-    let cursor = (await readPullState(db)).cursor;
+    const { copy, deviceId, pageSize = 500 } = this.options;
+    let cursor = (await readPullState(copy.db)).cursor;
     for (;;) {
       if (this.ended) return;
       const page = await this.options.pull({
@@ -242,7 +243,7 @@ export class SyncEngine {
         limit: pageSize,
         ...(cursor !== null && { cursor }),
       });
-      await applyPage(db, page, cursor);
+      await applyPage(copy, page, cursor);
       if (!page.hasMore) return;
       cursor = page.cursor;
     }
```

- **`copy` replaces `db` in the options.** The engine pulls and pushes through the copy, so it seals with the copy's
  key. The lock's name still comes from the database's name, so two tabs of the same person still share one sync lock.
- **A pull or a push after a lock fails** with "The copy is locked". The app stops the engine before it locks (19b.4),
  so this only happens if a page was half way through.

### `index.ts`: the exports

```diff
@@ -1,23 +1,32 @@
 // Two kinds of module. The pages of the app import the reads (queries, records, state, problems),
-// the outbox's saves (outbox, overlay, prices; step 18b) and the types: none of them loads Dexie
-// at run time, so a page that searches customers or a form that saves offline stays small. The
-// code that opens the database and syncs (database, apply, push, engine, live, device) brings
-// Dexie, and the app loads it once, lazily, after sign-in. `sideEffects: false` in
-// package.json lets the bundler leave out the modules a chunk does not use.
-export { applyPage, writeChanges } from './apply.js';
+// the outbox's saves (outbox, overlay, prices; step 18b), the key's code (crypto, keys; step 19b)
+// and the types: none of them loads Dexie at run time, so a page that searches customers or a
+// form that saves offline stays small. The code that opens the database and syncs (database,
+// copy, apply, push, engine, live, device) brings Dexie, and the app loads it once, lazily, after
+// sign-in. `sideEffects: false` in package.json lets the bundler leave out the modules a chunk
+// does not use.
+export { applyPage, type SealedChanges, sealChanges, writeSealed } from './apply.js';
+export { LocalCopy, Mirror } from './copy.js';
+export { type Box, isPin, PIN_ITERATIONS, PIN_LENGTH } from './crypto.js';
 export {
-  type CustomerRecord,
   databaseName,
   deleteLocalDatabase,
+  type MirroredTable,
+  type NoticeRow,
+  type OutboxBody,
   type OutboxEntry,
+  type OutboxRow,
   type OutboxStatus,
-  type ProductRecord,
+  type PriceListItemRow,
+  type ProductRow,
   type PullState,
-  type Stored,
+  type SealedRow,
+  type StockRow,
   SyncDatabase,
   type SyncNoticeRecord,
   type SyncTableName,
   TABLE_OF,
+  type TableMark,
 } from './database.js';
 export {
   type DeviceIdentity,
@@ -30,6 +39,21 @@ export {
   saveDevice,
 } from './device.js';
 export { type LockRunner, SyncEngine, type SyncEngineOptions, type SyncStatus } from './engine.js';
+export {
+  type KeyProblem,
+  type KeyRecord,
+  type KeyResult,
+  type KeyStatus,
+  forgetPin,
+  keyStatus,
+  markPinAsked,
+  MAX_WRONG_PINS,
+  openKey,
+  type PinWrap,
+  renewServerKey,
+  setPin,
+  type Unlock,
+} from './keys.js';
 export { type Watch, watch } from './live.js';
 export {
   addressChangesOf,
@@ -79,5 +103,12 @@ export {
   productSummaryOf,
   syncNotices,
 } from './queries.js';
-export { customerRecord, productRecord, searchText } from './records.js';
+export {
+  type CustomerRecord,
+  customerRecord,
+  type ProductRecord,
+  productIndex,
+  productRecord,
+  searchText,
+} from './records.js';
 export { NO_PULL, readPullState, syncedAtOf } from './state.js';
```

- **The comment's two lists grow:** `crypto.ts` and `keys.ts` load no Dexie (the lock screen imports them), `copy.ts`
  does.
- **`writeChanges` is gone; `sealChanges` and `writeSealed` take its place.** Nothing in the app used it.
- **`Stored`, and the old `ProductRecord` / `CustomerRecord` exports of `database.ts`, are gone.** The record types are
  now exported from `records.ts`.

### The tests

The specs use a `LocalCopy` everywhere the database was used before. `test-fixtures.ts` makes one:

```diff
@@ -8,15 +8,32 @@ import type {
 } from '@omnivo/contracts';
 import { uuidv7 } from 'uuidv7';
 
+import { LocalCopy } from './copy.js';
 import { SyncDatabase } from './database.js';
+import { openKey } from './keys.js';
 
 // Rows and pages for the specs. Not built into dist (tsconfig.build.json leaves it out).
 
 const UPDATED = '2026-10-21T04:00:00.000Z';
 
-export function newDatabase(): SyncDatabase {
+export function newDatabase(name = `test-${uuidv7()}`): SyncDatabase {
   // A name of its own per test: fake-indexeddb keeps every database of the process in memory
-  return new SyncDatabase(`test-${uuidv7()}`);
+  return new SyncDatabase(name);
+}
+
+// Step 19b: the 32 bytes the server would give this device (19b.2), the same in every spec
+export const SERVER_KEY = new Uint8Array(32).fill(7);
+
+// A copy opened the way the app opens it online: the server's key makes the data key the first
+// time and opens it after. Close it at the end of the test (copy.close(), db.close()).
+export async function openCopy(db: SyncDatabase): Promise<LocalCopy> {
+  const opened = await openKey(db, { serverKey: SERVER_KEY });
+  if (opened.kind !== 'open') throw new Error(`The test key did not open: ${opened.kind}`);
+  return LocalCopy.open(db, opened.key);
+}
+
+export function newCopy(): Promise<LocalCopy> {
+  return openCopy(newDatabase());
 }
 
 export function product(fields: Partial<Product> & Pick<Product, 'name'>): Product {
```

- **`SERVER_KEY` is 32 bytes of 7s.** The real key comes from the server (19b.2); any 32 bytes work for the specs.
- **`openCopy` opens a copy the way the app opens it online:** the server's key makes the data key, then
  `LocalCopy.open`. Throwing on any other answer keeps every spec's first line short.
- **`newDatabase(name)` takes a name,** so two connections can open one database (two tabs, in `copy.spec.ts` and
  `database.spec.ts`).

```ts
import { describe, expect, it } from 'vitest';

import {
  isPin,
  newDataKey,
  pinWrappingKey,
  seal,
  serverWrappingKey,
  unseal,
  unwrapDataKey,
  wrapDataKey,
} from './crypto.js';

const LABEL = 'customers\n01928c4e-2222-7000-8000-000000000001';
const rahman = { name: 'Rahman Traders', phone: '01711-234567', creditLimit: '200000.0000' };

describe('seal and unseal', () => {
  it('gives back the value, and a new iv every time', async () => {
    const key = await newDataKey();
    const one = await seal(key, LABEL, rahman);
    const two = await seal(key, LABEL, rahman);
    expect(await unseal(key, LABEL, one)).toEqual(rahman);
    expect(one.slice(0, 12)).not.toEqual(two.slice(0, 12));
  });

  it('does not open under another label, with another key, or with one byte changed', async () => {
    const key = await newDataKey();
    const box = await seal(key, LABEL, rahman);
    // The same box under another customer's key: moved rows do not open
    await expect(
      unseal(key, 'customers\n01928c4e-2222-7000-8000-000000000002', box),
    ).rejects.toThrow();
    await expect(unseal(await newDataKey(), LABEL, box)).rejects.toThrow();
    const changed = box.slice();
    changed[20] = (changed[20] ?? 0) ^ 1;
    await expect(unseal(key, LABEL, changed)).rejects.toThrow();
  });
});

describe('wrapping the data key', () => {
  it('opens with the wrapping key only, and as a key the page cannot read out', async () => {
    const dataKey = await newDataKey();
    const server = await serverWrappingKey(new Uint8Array(32).fill(1));
    const wrapped = await wrapDataKey(dataKey, server);
    const opened = await unwrapDataKey(wrapped, server, false);
    if (!opened) throw new Error('not opened');
    expect(await unseal(opened, LABEL, await seal(dataKey, LABEL, rahman))).toEqual(rahman);
    await expect(crypto.subtle.exportKey('raw', opened)).rejects.toThrow();
    const other = await serverWrappingKey(new Uint8Array(32).fill(2));
    expect(await unwrapDataKey(wrapped, other, false)).toBeNull();
  });

  it('turns a PIN and its salt into the same key every time, and another PIN into another', async () => {
    const salt = new Uint8Array(16).fill(3);
    const dataKey = await newDataKey();
    const wrapped = await wrapDataKey(dataKey, await pinWrappingKey('482913', salt, 1000));
    expect(
      await unwrapDataKey(wrapped, await pinWrappingKey('482913', salt, 1000), false),
    ).not.toBeNull();
    expect(
      await unwrapDataKey(wrapped, await pinWrappingKey('482914', salt, 1000), false),
    ).toBeNull();
    // The rounds are part of the key: a PIN set with other rounds needs them to open
    expect(
      await unwrapDataKey(wrapped, await pinWrappingKey('482913', salt, 1001), false),
    ).toBeNull();
  });

  it('refuses a server key that is not 32 bytes', () => {
    expect(() => serverWrappingKey(new Uint8Array(16))).toThrow();
  });
});

describe('isPin', () => {
  it('takes six ASCII digits only', () => {
    expect(isPin('048213')).toBe(true);
    expect(isPin('48213')).toBe(false);
    expect(isPin('4821390')).toBe(false);
    // Bangla digits are turned into ASCII by the app before
    expect(isPin('৪৮২৯১৩')).toBe(false);
    expect(isPin('48 213')).toBe(false);
  });
});
```

- **A changed byte at position 20** is inside the ciphertext (after the 12-byte iv): the tag check must catch it.
- **`exportKey` must fail on the unwrapped key:** decision 16, the page cannot read the key out.
- **The rounds are part of the PIN's key,** so `iterations` must be stored with the wrap (decision 15).

```ts
import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import { seal, unseal } from './crypto.js';
import type { SyncDatabase } from './database.js';
import {
  forgetPin,
  keyStatus,
  markPinAsked,
  MAX_WRONG_PINS,
  openKey,
  renewServerKey,
  setPin,
} from './keys.js';
import { newDatabase, SERVER_KEY } from './test-fixtures.js';

// Few rounds: 600,000 per PIN would make this file take minutes
const ROUNDS = 1000;
const PIN = '482913';
const OTHER_SERVER_KEY = new Uint8Array(32).fill(9);

async function opened(db: SyncDatabase, unlock: Parameters<typeof openKey>[1]) {
  const result = await openKey(db, unlock);
  if (result.kind !== 'open') throw new Error(`not opened: ${result.kind}`);
  return result.key;
}

async function withPin(): Promise<SyncDatabase> {
  const db = newDatabase();
  expect(await setPin(db, { serverKey: SERVER_KEY }, PIN, ROUNDS)).toEqual({ kind: 'set' });
  return db;
}

describe('openKey', () => {
  it('makes the data key the first time, and opens the same one after', async () => {
    const db = newDatabase();
    expect(await keyStatus(db)).toMatchObject({ exists: false, hasPin: false });
    const first = await opened(db, { serverKey: SERVER_KEY });
    const box = await seal(first, 'units\nu1', { code: 'pcs' });
    const again = await opened(db, { serverKey: SERVER_KEY });
    expect(await unseal(again, 'units\nu1', box)).toEqual({ code: 'pcs' });
    expect(await keyStatus(db)).toMatchObject({ exists: true, hasPin: false });
  });

  it('says key-changed when another server key comes, and no-pin offline without a PIN', async () => {
    const db = newDatabase();
    await opened(db, { serverKey: SERVER_KEY });
    expect(await openKey(db, { serverKey: OTHER_SERVER_KEY })).toEqual({ kind: 'key-changed' });
    expect(await openKey(db, { pin: PIN })).toEqual({ kind: 'no-pin' });
    // A device never opened has no key at all: the PIN cannot open it either
    expect(await openKey(newDatabase(), { pin: PIN })).toEqual({ kind: 'no-pin' });
  });

  it('opens the same key with the PIN as with the server key', async () => {
    const db = await withPin();
    const online = await opened(db, { serverKey: SERVER_KEY });
    const box = await seal(online, 'units\nu1', { code: 'pcs' });
    expect(await unseal(await opened(db, { pin: PIN }), 'units\nu1', box)).toEqual({ code: 'pcs' });
    expect(await keyStatus(db)).toMatchObject({ hasPin: true, wrongPins: 0 });
    expect((await db.keys.get('data'))?.pin?.iterations).toBe(ROUNDS);
  });
});

describe('wrong PINs', () => {
  it('counts them, and the right one starts the count again', async () => {
    const db = await withPin();
    expect(await openKey(db, { pin: '000000' })).toEqual({ kind: 'wrong-pin', left: 4 });
    expect(await openKey(db, { pin: '000001' })).toEqual({ kind: 'wrong-pin', left: 3 });
    await opened(db, { pin: PIN });
    expect((await keyStatus(db)).wrongPins).toBe(0);
  });

  it('turns the PIN off at the fifth, until a new one is set online', async () => {
    const db = await withPin();
    for (let wrong = 1; wrong < MAX_WRONG_PINS; wrong += 1) {
      expect((await openKey(db, { pin: '000000' })).kind).toBe('wrong-pin');
    }
    expect(await openKey(db, { pin: '000000' })).toEqual({ kind: 'pin-blocked' });
    // The wrap is gone: the right PIN cannot open it any more either
    expect((await db.keys.get('data'))?.pin).toBeNull();
    expect(await openKey(db, { pin: PIN })).toEqual({ kind: 'pin-blocked' });
    expect(await keyStatus(db)).toMatchObject({ hasPin: false, pinBlocked: true });
    // Online, the server key still opens the copy; then a new PIN
    await opened(db, { serverKey: SERVER_KEY });
    expect(await setPin(db, { serverKey: SERVER_KEY }, '193746', ROUNDS)).toEqual({ kind: 'set' });
    expect(await keyStatus(db)).toMatchObject({ hasPin: true, pinBlocked: false });
    await opened(db, { pin: '193746' });
  });

  it('counts a wrong current PIN when the PIN is changed', async () => {
    const db = await withPin();
    expect(await setPin(db, { pin: '000000' }, '193746', ROUNDS)).toEqual({
      kind: 'wrong-pin',
      left: 4,
    });
    expect(await setPin(db, { pin: PIN }, '193746', ROUNDS)).toEqual({ kind: 'set' });
    expect((await openKey(db, { pin: PIN })).kind).toBe('wrong-pin');
    await opened(db, { pin: '193746' });
  });

  it('refuses a PIN that is not six digits', async () => {
    await expect(
      setPin(newDatabase(), { serverKey: SERVER_KEY }, '1234', ROUNDS),
    ).rejects.toThrow();
  });
});

describe('renewServerKey', () => {
  it('wraps the key again for a new server key, with the PIN', async () => {
    const db = await withPin();
    expect(await openKey(db, { serverKey: OTHER_SERVER_KEY })).toEqual({ kind: 'key-changed' });
    expect(await renewServerKey(db, PIN, OTHER_SERVER_KEY)).toEqual({ kind: 'set' });
    await opened(db, { serverKey: OTHER_SERVER_KEY });
    expect(await openKey(db, { serverKey: SERVER_KEY })).toEqual({ kind: 'key-changed' });
  });
});

describe('asking for a PIN', () => {
  it('asks until a PIN is set or the person says not now', async () => {
    const db = newDatabase();
    await opened(db, { serverKey: SERVER_KEY });
    expect((await keyStatus(db)).pinAsked).toBe(false);
    await markPinAsked(db);
    expect(await keyStatus(db)).toMatchObject({ hasPin: false, pinAsked: true });
  });

  it('asks again after a forgotten PIN and after the fifth wrong one', async () => {
    const db = await withPin();
    expect((await keyStatus(db)).pinAsked).toBe(true);
    await forgetPin(db);
    expect(await keyStatus(db)).toMatchObject({
      hasPin: false,
      pinBlocked: false,
      pinAsked: false,
    });
    expect(await openKey(db, { pin: PIN })).toEqual({ kind: 'no-pin' });
    expect(await setPin(db, { serverKey: SERVER_KEY }, PIN, ROUNDS)).toEqual({ kind: 'set' });
    for (let wrong = 0; wrong < MAX_WRONG_PINS; wrong += 1) await openKey(db, { pin: '000000' });
    expect(await keyStatus(db)).toMatchObject({ pinBlocked: true, pinAsked: false });
  });
});
```

- **`ROUNDS = 1000`.** The real 600,000 rounds would make this file take a minute; the logic is the same.
- **The fifth wrong PIN** is checked to delete the wrap (`pin` is `null`), not only to answer `pin-blocked`: the right
  PIN must fail too.
- **"Asks again after a forgotten PIN and after the fifth wrong one"** pins decision 34: both must turn `pinAsked`
  back to `false`, or the app would never ask for the new PIN.

```ts
import 'fake-indexeddb/auto';

import { uuidv7 } from 'uuidv7';
import { describe, expect, it, vi } from 'vitest';

import { applyPage } from './apply.js';
import { watch } from './live.js';
import { saveCustomer } from './outbox.js';
import { allRows, customerPage, productPage } from './queries.js';
import {
  customer,
  customerInput,
  newDatabase,
  openCopy,
  page,
  product,
  upsertCustomer,
  upsertProduct,
} from './test-fixtures.js';

const shirt = product({ name: 'Polo shirt', code: 'FG-0001' });
const trouser = product({ name: 'Chino trouser', code: 'FG-0002' });
const jacket = product({ name: 'Denim jacket', code: 'FG-0003' });
const ALL = { search: '', categoryIds: null, sort: 'name', limit: 10 } as const;

const names = (rows: readonly { name: string }[]) => rows.map((row) => row.name);

describe('LocalCopy', () => {
  it('follows a write made in another tab before a list reads it', async () => {
    const name = `test-${uuidv7()}`;
    // Two connections to one database: two tabs of the same browser
    const here = await openCopy(newDatabase(name));
    const there = await openCopy(newDatabase(name));
    await applyPage(there, page({ full: true, changes: [upsertProduct(shirt)] }), null);
    // No waiting in the test: the read waits for the in-memory copy to reach the write's mark
    expect(names((await productPage(here, ALL)).rows)).toEqual(['Polo shirt']);
    for (const copy of [here, there]) {
      copy.close();
      copy.db.close();
    }
  });

  it('opens again only the rows a write changed', async () => {
    const copy = await openCopy(newDatabase());
    const full = page({
      full: true,
      changes: [shirt, trouser, jacket].map(upsertProduct),
    });
    await applyPage(copy, full, null);
    await productPage(copy, ALL);
    const open = vi.spyOn(copy, 'open');
    await applyPage(
      copy,
      page({ changes: [upsertProduct({ ...shirt, name: 'Polo shirt (piqué)' })] }),
      full.cursor,
    );
    expect(names((await productPage(copy, ALL)).rows)).toEqual([
      'Chino trouser',
      'Denim jacket',
      'Polo shirt (piqué)',
    ]);
    expect(open.mock.calls.map(([table]) => table)).toEqual(['products']);
    copy.close();
  });

  it('runs a watched list again when a pull writes a customer, after opening the outbox', async () => {
    const copy = await openCopy(newDatabase());
    // One waiting command: the list opens it (Web Crypto) before it reads the customers' mark,
    // so the mark is read after an await that Dexie did not make (crypto.ts → unseal)
    await saveCustomer(copy, {
      base: null,
      input: customerInput({ name: 'Tasnim Pharmacy' }),
      savedAt: '2026-10-21T15:00:00.000Z',
    });
    const seen: string[][] = [];
    const stop = watch(
      () => customerPage(copy, { search: '', groupId: '', sort: 'name', limit: 10 }),
      (found) => seen.push(names(found.rows)),
      () => undefined,
    );
    await vi.waitFor(() => {
      expect(seen.at(-1)).toEqual(['Tasnim Pharmacy']);
    });
    await applyPage(
      copy,
      page({ full: true, changes: [upsertCustomer(customer({ name: 'Rahman Traders' }))] }),
      null,
    );
    await vi.waitFor(() => {
      expect(seen.at(-1)).toEqual(['Rahman Traders', 'Tasnim Pharmacy']);
    });
    stop();
    copy.close();
  });

  it('keeps following a read made after opening a row, or after current()', async () => {
    const copy = await openCopy(newDatabase());
    await applyPage(copy, page({ full: true, changes: [upsertProduct(shirt)] }), null);
    const { db } = copy;
    const counts: number[][] = [];
    // A read of IndexedDB after each kind of wait that Dexie did not make itself. Without the wrap
    // in crypto.ts → unseal, liveQuery would stop following after the open, and the unit added
    // below would never show.
    const stop = watch(
      async () => {
        const row = await db.products.get(shirt.id);
        if (row) await copy.open('products', row.key, row.box);
        const afterOpen = await db.units.count();
        await copy.products.current();
        const afterCurrent = await db.taxRates.count();
        return [afterOpen, afterCurrent];
      },
      (value) => counts.push(value),
      () => undefined,
    );
    await vi.waitFor(() => {
      expect(counts.at(-1)).toEqual([0, 0]);
    });
    // Rows of any content: only the counts are read
    await db.units.put({ key: 'u-pcs', gen: 1, box: new Uint8Array(0) });
    await vi.waitFor(() => {
      expect(counts.at(-1)).toEqual([1, 0]);
    });
    await db.taxRates.put({ key: 't-15', gen: 1, box: new Uint8Array(0) });
    await vi.waitFor(() => {
      expect(counts.at(-1)).toEqual([1, 1]);
    });
    // A product written: this run waits in current() until the in-memory copy has it, and the
    // read after that wait is still followed
    await applyPage(copy, page({ changes: [upsertProduct(trouser)] }), 'cursor');
    await db.taxRates.put({ key: 't-5', gen: 1, box: new Uint8Array(0) });
    await vi.waitFor(() => {
      expect(counts.at(-1)).toEqual([1, 2]);
    });
    stop();
    copy.close();
  });

  it('reads nothing once it is locked', async () => {
    const copy = await openCopy(newDatabase());
    await applyPage(copy, page({ full: true, changes: [upsertProduct(shirt)] }), null);
    copy.close();
    await expect(productPage(copy, ALL)).rejects.toThrow('locked');
    await expect(allRows(copy, copy.db.units)).resolves.toEqual([]);
    const [row] = await copy.db.products.toArray();
    if (!row) throw new Error('no row');
    // At once, not a rejected promise: every caller awaits it inside an async function
    expect(() => copy.open('products', row.key, row.box)).toThrow('locked');
  });

  it('does not open a row moved under another key', async () => {
    const copy = await openCopy(newDatabase());
    await applyPage(copy, page({ full: true, changes: [shirt, trouser].map(upsertProduct) }), null);
    const shirtRow = await copy.db.products.get(shirt.id);
    if (!shirtRow) throw new Error('no row');
    // The shirt's box put in the trouser's place, by someone with the browser's tools
    await copy.db.products.put({ ...shirtRow, key: trouser.id });
    await expect(allRows(copy, copy.db.products)).rejects.toThrow();
    copy.close();
  });
});
```

- **"Follows a write made in another tab"** opens two connections to one database. Dexie tells every connection in
  the same page about a write (and other tabs through a `BroadcastChannel`), so the second connection's in-memory copy
  hears of it. The list read waits by itself: the test needs no sleep.
- **"Opens again only the rows a write changed"** spies on `copy.open`: after a page that renames one product, exactly
  one row is opened.
- **"Runs a watched list again … after opening the outbox"** watches `customerPage` with one waiting command, so the
  read opens a box before it reads the customers' mark.
- **"Keeps following a read made after opening a row, or after current()"** is decision 19's test. Its read opens a
  row with a plain `await` (not inside `Promise.all`, which inside a liveQuery is Dexie's own and would hide the
  problem), then counts the units; then calls `current()` and counts the tax rates. Without the `Promise.resolve` in
  `unseal`, the unit written later never shows, and the test fails. The last step writes a product, so `current()`
  really waits once, and checks that the read after that wait is still followed.
- **"Does not open a row moved under another key"** puts the shirt's box in the trouser's place, the way someone with
  the browser's tools could. The label makes the open fail.

```diff
@@ -4,34 +4,155 @@ import { Dexie } from 'dexie';
 import { uuidv7 } from 'uuidv7';
 import { describe, expect, it } from 'vitest';
 
-import { SyncDatabase } from './database.js';
-import { productRecord } from './records.js';
-import { product } from './test-fixtures.js';
+import { LocalCopy } from './copy.js';
+import type { OutboxEntry, SyncNoticeRecord } from './database.js';
+import { openKey } from './keys.js';
+import { saveCustomer } from './outbox.js';
+import { outboxEntries, syncNotices } from './queries.js';
+import { readPullState } from './state.js';
+import {
+  customer,
+  customerInput,
+  newDatabase,
+  openCopy,
+  product,
+  SERVER_KEY,
+} from './test-fixtures.js';
 
-describe('SyncDatabase version 2', () => {
-  it('keeps the copy of version 1 and gives its products their variant ids', async () => {
+// A device on 18b's app: version 2, every row clear
+function versionTwo(name: string): Dexie {
+  const old = new Dexie(name);
+  old.version(1).stores({
+    settings: 'key, gen',
+    units: 'key, gen',
+    productCategories: 'key, gen',
+    taxRates: 'key, gen',
+    warehouses: 'key, gen',
+    priceLists: 'key, gen',
+    customerGroups: 'key, gen',
+    products: 'key, gen, sortName, sortCode, *barcodes',
+    priceListItems: 'key, gen, data.priceListId, data.variantId',
+    customers: 'key, gen, sortName',
+    stock: 'key, gen, data.warehouseId, data.variantId',
+    meta: 'key',
+  });
+  old.version(2).stores({
+    products: 'key, gen, sortName, sortCode, *barcodes, *variantIds',
+    outbox: '++seq, key, customerId',
+    notices: 'commandId',
+  });
+  return old;
+}
+
+const tasnim = customer({ name: 'Tasnim Pharmacy' });
+const SAVED = '2026-10-21T15:00:00.000Z';
+
+function waiting(seq: number): OutboxEntry {
+  return {
+    seq,
+    command: {
+      id: uuidv7(),
+      type: 'customer.create',
+      customerId: tasnim.id,
+      input: { ...customerInput({ name: 'Tasnim Pharmacy' }), addresses: [] },
+    },
+    status: 'waiting',
+    sent: true,
+    error: null,
+    customerId: tasnim.id,
+    key: tasnim.id,
+    base: null,
+    name: 'Tasnim Pharmacy',
+    lines: null,
+    total: null,
+    savedAt: SAVED,
+  };
+}
+
+const notice: SyncNoticeRecord = {
+  commandId: uuidv7(),
+  customerId: tasnim.id,
+  name: 'Tasnim Pharmacy',
+  fields: ['creditLimit'],
+  at: '2026-10-21T16:00:00.000Z',
+};
+
+async function oldCopy(name: string, entries: OutboxEntry[]): Promise<void> {
+  const old = versionTwo(name);
+  const shirt = product({ name: 'Polo shirt' });
+  await old.table('products').put({
+    key: shirt.id,
+    gen: 1,
+    data: shirt,
+    sortName: 'polo shirt',
+    sortCode: 'p-0001',
+    text: 'polo shirt',
+    barcodes: [],
+    variantIds: [],
+  });
+  await old
+    .table('customers')
+    .put({ key: tasnim.id, gen: 1, data: tasnim, sortName: '', text: '' });
+  await old.table('meta').put({ key: 'pull', cursor: 'c-41', generation: 1, full: false });
+  await old.table('outbox').bulkPut(entries);
+  await old.table('notices').put(notice);
+  old.close();
+}
+
+describe('SyncDatabase version 3 (step 19b)', () => {
+  it('empties the clear copy and keeps the outbox aside until the key opens', async () => {
     const name = `test-${uuidv7()}`;
-    const shirt = product({ name: 'Polo shirt' });
-    // A device on 18a's app: version 1, products without variantIds
-    const old = new Dexie(name);
-    old.version(1).stores({ products: 'key, gen, sortName, sortCode, *barcodes' });
-    const full = productRecord(shirt.id, 1, shirt);
-    await old.table('products').put({
-      key: full.key,
-      gen: full.gen,
-      data: full.data,
-      sortName: full.sortName,
-      sortCode: full.sortCode,
-      text: full.text,
-      barcodes: full.barcodes,
-    });
-    old.close();
+    // seq 4 and 9: the order survives with its gaps (an auto-increment never reuses a number)
+    const entries = [waiting(4), waiting(9)];
+    await oldCopy(name, entries);
 
-    const db = new SyncDatabase(name);
-    const variantId = shirt.variants[0]?.id ?? '';
-    expect((await db.products.get(shirt.id))?.variantIds).toEqual([variantId]);
-    expect(await db.products.where('variantIds').equals(variantId).count()).toBe(1);
+    const db = newDatabase(name);
+    expect(await db.products.count()).toBe(0);
+    expect(await db.customers.count()).toBe(0);
+    // No cursor: the next pull is a full one, and writes everything back sealed
+    expect((await readPullState(db)).cursor).toBeNull();
     expect(await db.outbox.count()).toBe(0);
+    expect(await db.legacyOutbox.count()).toBe(2);
+
+    const copy = await openCopy(db);
+    expect(await db.legacyOutbox.count()).toBe(0);
+    expect(await db.legacyNotices.count()).toBe(0);
+    expect(await outboxEntries(copy)).toEqual(entries);
+    expect(await syncNotices(copy)).toEqual([notice]);
+    // Sealed: the name is not on the disk any more
+    const [row] = await db.outbox.toArray();
+    expect(new TextDecoder('latin1').decode(row?.box)).not.toContain('Tasnim');
+    // A new save comes after them: the auto-increment did not start again
+    await saveCustomer(copy, {
+      base: null,
+      input: customerInput({ name: 'Rahman Traders' }),
+      savedAt: SAVED,
+    });
+    expect((await outboxEntries(copy)).map((entry) => entry.seq ?? 0)[2]).toBeGreaterThan(9);
+    copy.close();
     db.close();
   });
+
+  it('moves each waiting entry once when two tabs open the copy at the same time', async () => {
+    const name = `test-${uuidv7()}`;
+    const entries = [waiting(1)];
+    await oldCopy(name, entries);
+    const [first, second] = [newDatabase(name), newDatabase(name)];
+    // One key for both: the second tab opens the record the first one made
+    const [keyOne, keyTwo] = await Promise.all([
+      openKey(first, { serverKey: SERVER_KEY }),
+      openKey(second, { serverKey: SERVER_KEY }),
+    ]);
+    if (keyOne.kind !== 'open' || keyTwo.kind !== 'open') throw new Error('not opened');
+    const [one, two] = await Promise.all([
+      LocalCopy.open(first, keyOne.key),
+      LocalCopy.open(second, keyTwo.key),
+    ]);
+    expect(await outboxEntries(one)).toEqual(entries);
+    expect(await outboxEntries(two)).toEqual(entries);
+    for (const copy of [one, two]) {
+      copy.close();
+      copy.db.close();
+    }
+  });
 });
```

- **`versionTwo` declares version 1 and 2 as 18b's app had them,** so the database on the disk is exactly what a
  device has before this step.
- **seq 4 and 9:** the order comes back with its gaps, and a save after the upgrade gets a higher number.
- **"Moves each waiting entry once when two tabs open the copy at the same time"** opens both copies together: both
  must see the one entry, not two.

The other specs change only where they read or write the copy:

```diff
@@ -3,48 +3,51 @@ import 'fake-indexeddb/auto';
 import { describe, expect, it } from 'vitest';
 
 import { applyPage } from './apply.js';
+import { allRows } from './queries.js';
 import { NO_PULL, readPullState, syncedAtOf } from './state.js';
-import { newDatabase, page, product, upsertProduct } from './test-fixtures.js';
+import { newCopy, page, product, upsertProduct } from './test-fixtures.js';
 
 const shirt = product({ name: 'Polo shirt', code: 'FG-0001' });
 const trouser = product({ name: 'Chino trouser', code: 'FG-0002' });
 const jacket = product({ name: 'Denim jacket', code: 'FG-0003' });
 
-async function keys(db: ReturnType<typeof newDatabase>): Promise<string[]> {
-  return (await db.products.toArray()).map((record) => record.key).sort();
+async function keys(copy: Awaited<ReturnType<typeof newCopy>>): Promise<string[]> {
+  return (await copy.db.products.toArray()).map((row) => row.key).sort();
 }
 
 describe('applyPage', () => {
   it('keeps what the device had until the last page of a full pull, then drops what it did not send', async () => {
-    const db = newDatabase();
+    const copy = await newCopy();
+    const { db } = copy;
     await applyPage(
-      db,
+      copy,
       page({ full: true, changes: [upsertProduct(shirt), upsertProduct(trouser)] }),
       null,
     );
-    expect(await keys(db)).toEqual([shirt.id, trouser.id].sort());
+    expect(await keys(copy)).toEqual([shirt.id, trouser.id].sort());
 
     // A later full pull (a resync) that no longer has the trouser: two pages
     const first = page({ full: true, hasMore: true, changes: [upsertProduct(jacket)] });
-    await applyPage(db, first, null);
+    await applyPage(copy, first, null);
     // Half way: the trouser is still there, so the list does not shrink while the pull runs
-    expect(await keys(db)).toEqual([shirt.id, trouser.id, jacket.id].sort());
+    expect(await keys(copy)).toEqual([shirt.id, trouser.id, jacket.id].sort());
     expect((await readPullState(db)).full).toBe(true);
 
-    await applyPage(db, page({ full: true, changes: [upsertProduct(shirt)] }), first.cursor);
-    expect(await keys(db)).toEqual([shirt.id, jacket.id].sort());
+    await applyPage(copy, page({ full: true, changes: [upsertProduct(shirt)] }), first.cursor);
+    expect(await keys(copy)).toEqual([shirt.id, jacket.id].sort());
     const state = await readPullState(db);
     expect(state.full).toBe(false);
     expect(state.copied).toBe(2);
   });
 
   it('applies a delta: upserts replace, deletes remove, nothing else is touched', async () => {
-    const db = newDatabase();
+    const copy = await newCopy();
+    const { db } = copy;
     const full = page({ full: true, changes: [upsertProduct(shirt), upsertProduct(trouser)] });
-    await applyPage(db, full, null);
+    await applyPage(copy, full, null);
     const renamed = { ...shirt, name: 'Polo shirt (piqué)', version: 2 };
     await applyPage(
-      db,
+      copy,
       page({
         changes: [
           upsertProduct(renamed),
@@ -55,66 +58,70 @@ describe('applyPage', () => {
       }),
       full.cursor,
     );
-    const rows = await db.products.toArray();
-    expect(rows.map((record) => record.data)).toEqual([renamed]);
-    expect(rows[0]?.sortName).toBe('polo shirt (piqué)');
+    expect(await allRows(copy, db.products)).toEqual([renamed]);
   });
 
   it('a delta upsert keeps the generation, so the next full pull still sweeps it', async () => {
-    const db = newDatabase();
+    const copy = await newCopy();
     const full = page({ full: true, changes: [upsertProduct(shirt)] });
-    await applyPage(db, full, null);
-    await applyPage(db, page({ changes: [upsertProduct(trouser)] }), full.cursor);
+    await applyPage(copy, full, null);
+    await applyPage(copy, page({ changes: [upsertProduct(trouser)] }), full.cursor);
     // A resync without the trouser removes it, though a delta wrote it
-    await applyPage(db, page({ full: true, changes: [upsertProduct(shirt)] }), null);
-    expect(await keys(db)).toEqual([shirt.id]);
+    await applyPage(copy, page({ full: true, changes: [upsertProduct(shirt)] }), null);
+    expect(await keys(copy)).toEqual([shirt.id]);
   });
 
   it('a full pull resumed after a reload continues its generation', async () => {
-    const db = newDatabase();
-    await applyPage(db, page({ full: true, changes: [upsertProduct(trouser)] }), null);
+    const copy = await newCopy();
+    const { db } = copy;
+    await applyPage(copy, page({ full: true, changes: [upsertProduct(trouser)] }), null);
     const first = page({ full: true, hasMore: true, changes: [upsertProduct(shirt)] });
-    await applyPage(db, first, null);
+    await applyPage(copy, first, null);
     // The tab closed; the next start sends the saved cursor and the server goes on
     const { cursor } = await readPullState(db);
     expect(cursor).toBe(first.cursor);
-    await applyPage(db, page({ full: true, changes: [upsertProduct(jacket)] }), cursor);
+    await applyPage(copy, page({ full: true, changes: [upsertProduct(jacket)] }), cursor);
     // The shirt of the first page counts: it was sent by this full pull
-    expect(await keys(db)).toEqual([shirt.id, jacket.id].sort());
+    expect(await keys(copy)).toEqual([shirt.id, jacket.id].sort());
   });
 
   it('a pull sent without a cursor starts over, even in the middle of a full pull', async () => {
-    const db = newDatabase();
+    const copy = await newCopy();
     // A full pull stops half way (its first page had the shirt)
-    await applyPage(db, page({ full: true, hasMore: true, changes: [upsertProduct(shirt)] }), null);
+    await applyPage(
+      copy,
+      page({ full: true, hasMore: true, changes: [upsertProduct(shirt)] }),
+      null,
+    );
     // The device starts from the beginning (a cursor the server refused, 18c's "sync again");
     // the server no longer has the shirt, so the shirt of the old half must not count
-    await applyPage(db, page({ full: true, changes: [upsertProduct(jacket)] }), null);
-    expect(await keys(db)).toEqual([jacket.id]);
+    await applyPage(copy, page({ full: true, changes: [upsertProduct(jacket)] }), null);
+    expect(await keys(copy)).toEqual([jacket.id]);
   });
 
   it('a page applied twice gives the same result', async () => {
-    const db = newDatabase();
+    const copy = await newCopy();
     const full = page({ full: true, changes: [upsertProduct(shirt), upsertProduct(trouser)] });
-    await applyPage(db, full, null);
+    await applyPage(copy, full, null);
     const delta = page({ changes: [{ op: 'delete', entity: 'product', key: shirt.id }] });
-    await applyPage(db, delta, full.cursor);
-    await applyPage(db, delta, full.cursor);
-    expect(await keys(db)).toEqual([trouser.id]);
+    await applyPage(copy, delta, full.cursor);
+    await applyPage(copy, delta, full.cursor);
+    expect(await keys(copy)).toEqual([trouser.id]);
   });
 
   it('sets the last sync only when a pull ends, from the server clock', async () => {
-    const db = newDatabase();
+    const copy = await newCopy();
+    const { db } = copy;
     const first = page({
       full: true,
       hasMore: true,
       changes: [],
       serverTime: '2026-10-21T04:00:00.000Z',
     });
-    await applyPage(db, first, null);
+    await applyPage(copy, first, null);
     expect((await readPullState(db)).lastSyncAt).toBeNull();
     await applyPage(
-      db,
+      copy,
       page({ full: true, changes: [], serverTime: '2026-10-21T04:00:05.000Z' }),
       first.cursor,
     );
@@ -122,14 +129,15 @@ describe('applyPage', () => {
   });
 
   it("keeps the device's own clock at the end of a pull, for the time limits (step 18c)", async () => {
-    const db = newDatabase();
+    const copy = await newCopy();
+    const { db } = copy;
     // The device's clock is three hours behind the server's: the limits count on the device's
     const deviceNow = Date.parse('2026-10-21T01:00:00.000Z');
     const first = page({ full: true, hasMore: true, changes: [] });
-    await applyPage(db, first, null, deviceNow - 5000);
+    await applyPage(copy, first, null, deviceNow - 5000);
     expect((await readPullState(db)).syncedAt).toBeNull();
     await applyPage(
-      db,
+      copy,
       page({ full: true, changes: [], serverTime: '2026-10-21T04:00:05.000Z' }),
       first.cursor,
       deviceNow,
@@ -140,7 +148,8 @@ describe('applyPage', () => {
   });
 
   it('reads a pull state saved before step 18c, with the server time standing in', async () => {
-    const db = newDatabase();
+    const copy = await newCopy();
+    const { db } = copy;
     await db.meta.put({ ...NO_PULL, cursor: 'c', lastSyncAt: '2026-10-21T04:00:05.000Z' });
     // An older app saved the row without syncedAt: take the field off, as it was stored then
     await db.meta.update('pull', (row) => {
@@ -154,10 +163,11 @@ describe('applyPage', () => {
   });
 
   it('keeps the price and the stock keys the server sends', async () => {
-    const db = newDatabase();
+    const copy = await newCopy();
+    const { db } = copy;
     const priceKey = `${shirt.id}:${shirt.variants[0]?.id ?? ''}:${shirt.baseUnitId}`;
     await applyPage(
-      db,
+      copy,
       page({
         full: true,
         changes: [
@@ -178,6 +188,34 @@ describe('applyPage', () => {
       }),
       null,
     );
-    expect((await db.priceListItems.get(priceKey))?.data.price).toBe('450.0000');
+    const row = await db.priceListItems.get(priceKey);
+    // Clear for the sale line's lookups (prices.ts), sealed for the rest
+    expect(row?.priceListId).toBe(shirt.id);
+    expect(row?.variantId).toBe(shirt.variants[0]?.id);
+    expect((await allRows(copy, db.priceListItems))[0]?.price).toBe('450.0000');
+  });
+
+  it('writes nothing a person typed in clear: only keys, the generation and index ids (step 19b)', async () => {
+    const copy = await newCopy();
+    const coded = product({
+      name: 'Polo shirt',
+      code: 'FG-0001',
+      variants: [
+        {
+          id: shirt.variants[0]?.id ?? '',
+          sku: 'FG-0001-M',
+          optionValues: [],
+          barcode: '8901234567890',
+          salePrice: '450.0000',
+          archivedAt: null,
+        },
+      ],
+    });
+    await applyPage(copy, page({ full: true, changes: [upsertProduct(coded)] }), null);
+    const [row] = await copy.db.products.toArray();
+    expect(Object.keys(row ?? {}).sort()).toEqual(['barcodes', 'box', 'gen', 'key', 'variantIds']);
+    expect(row?.barcodes).toEqual(['8901234567890']);
+    const bytes = new TextDecoder('latin1').decode(row?.box);
+    for (const typed of ['Polo shirt', 'FG-0001', '450.0000']) expect(bytes).not.toContain(typed);
   });
 });
```

- **"Writes nothing a person typed in clear"** checks the product row's fields by name, and that the name, the code
  and the price are not in the box's bytes (`latin1` decodes any byte, so the search sees everything that is there).

```diff
@@ -3,15 +3,16 @@ import 'fake-indexeddb/auto';
 import type { SyncPush, SyncPushInput } from '@omnivo/contracts';
 import { describe, expect, it, vi } from 'vitest';
 
-import type { OutboxEntry } from './database.js';
+import type { OutboxRow } from './database.js';
 import { SyncEngine } from './engine.js';
 import { saveCustomer, saveOrderDraft } from './outbox.js';
 import { pickBatch } from './push.js';
+import { localCustomer, outboxEntries, syncNotices } from './queries.js';
 import {
   customer,
   customerInput,
   inputOf,
-  newDatabase,
+  newCopy,
   orderDraft,
   page,
   upsertCustomer,
@@ -28,26 +29,17 @@ class CodedError extends Error {
   }
 }
 
-function entry(customerId: string, fields: Partial<OutboxEntry> = {}): OutboxEntry {
+// A row as pickBatch sees it: the clear fields only (the box is never opened there)
+function row(customerId: string, fields: Partial<OutboxRow> = {}): OutboxRow {
   return {
-    command: {
-      id: crypto.randomUUID(),
-      type: 'customer.update',
-      customerId,
-      baseVersion: 1,
-      changes: {},
-      addresses: { add: [], remove: [], change: [] },
-    },
+    commandId: crypto.randomUUID(),
+    type: 'customer.update',
     status: 'waiting',
     sent: false,
-    error: null,
     customerId,
     key: customerId,
-    base: null,
-    name: 'Rahman Traders',
-    lines: null,
-    total: null,
-    savedAt: SAVED,
+    bytes: 200,
+    box: new Uint8Array(0),
     ...fields,
   };
 }
@@ -58,42 +50,32 @@ describe('pickBatch', () => {
       (letter) => `01928c4e-2222-7000-8000-00000000000${letter}`,
     );
     if (a === undefined || b === undefined || c === undefined) throw new Error('ids');
-    const refused = entry(a, { status: 'failed' });
-    const behindRefused = entry(a);
-    const first = entry(b);
-    const behindFirst = entry(b);
-    const other = entry(c);
+    const refused = row(a, { status: 'failed' });
+    const behindRefused = row(a);
+    const first = row(b);
+    const behindFirst = row(b);
+    const other = row(c);
     expect(pickBatch([refused, behindRefused, first, behindFirst, other])).toEqual([first, other]);
   });
 
   it('stops at 50 commands, and before a command that would pass 512 KB', () => {
     const many = Array.from({ length: 60 }, (_, index) =>
-      entry(`01928c4e-3333-7000-8000-${String(index).padStart(12, '0')}`),
+      row(`01928c4e-3333-7000-8000-${String(index).padStart(12, '0')}`),
     );
     expect(pickBatch(many)).toHaveLength(50);
-    const big = (id: string) =>
-      entry(id, {
-        command: {
-          id: crypto.randomUUID(),
-          type: 'customer.update',
-          customerId: id,
-          baseVersion: 1,
-          changes: { notes: { from: null, to: 'x'.repeat(300 * 1024) } },
-          addresses: { add: [], remove: [], change: [] },
-        },
-      });
-    const one = big('01928c4e-4444-7000-8000-000000000001');
-    const two = big('01928c4e-4444-7000-8000-000000000002');
+    // The size counted when the command was saved (step 19b), not the command itself
+    const one = row('01928c4e-4444-7000-8000-000000000001', { bytes: 300 * 1024 });
+    const two = row('01928c4e-4444-7000-8000-000000000002', { bytes: 300 * 1024 });
     // The first always goes, even alone
     expect(pickBatch([one, two])).toEqual([one]);
   });
 });
 
-function engineWith(push: (input: SyncPushInput) => Promise<SyncPush>) {
-  const db = newDatabase();
+async function engineWith(push: (input: SyncPushInput) => Promise<SyncPush>) {
+  const copy = await newCopy();
   const onPushed = vi.fn();
   const engine = new SyncEngine({
-    db,
+    copy,
     deviceId: DEVICE,
     pull: () => Promise.resolve(page({ changes: [] })),
     push,
@@ -102,13 +84,13 @@ function engineWith(push: (input: SyncPushInput) => Promise<SyncPush>) {
     registerAgain: () => Promise.resolve(),
     onRevoked: () => undefined,
   });
-  return { db, engine, onPushed };
+  return { copy, db: copy.db, engine, onPushed };
 }
 
 describe('SyncEngine push', () => {
   it('sends a new customer, writes its row, then sends its order in the next round', async () => {
     const sent: string[][] = [];
-    const { db, engine, onPushed } = engineWith((input) => {
+    const { copy, db, engine, onPushed } = await engineWith((input) => {
       sent.push(input.commands.map((command) => command.type));
       return Promise.resolve({
         serverTime: SERVER,
@@ -126,14 +108,14 @@ describe('SyncEngine push', () => {
         }),
       });
     });
-    await saveCustomer(db, {
+    await saveCustomer(copy, {
       base: null,
       input: customerInput({ name: 'Tasnim Pharmacy' }),
       savedAt: SAVED,
     });
     const [created] = await db.outbox.toArray();
     if (!created) throw new Error('no create');
-    await saveOrderDraft(db, {
+    await saveOrderDraft(copy, {
       orderId: null,
       input: orderDraft(created.customerId, VARIANT),
       name: 'Tasnim Pharmacy',
@@ -143,7 +125,7 @@ describe('SyncEngine push', () => {
     await engine.syncNow();
     expect(sent).toEqual([['customer.create'], ['sales_order.create_draft']]);
     expect(await db.outbox.count()).toBe(0);
-    expect((await db.customers.get(created.customerId))?.data.code).toBe('C-00043');
+    expect((await localCustomer(copy, created.customerId))?.code).toBe('C-00043');
     expect(onPushed).toHaveBeenCalledWith({ accepted: 2, rejected: 0, kept: 0 });
     expect(engine.getStatus()).toEqual({ syncing: false, problem: null, stopped: false });
   });
@@ -159,15 +141,15 @@ describe('SyncEngine push', () => {
         })),
       }),
     );
-    const { db, engine } = engineWith(pushed);
-    await saveCustomer(db, {
+    const { copy, db, engine } = await engineWith(pushed);
+    await saveCustomer(copy, {
       base: null,
       input: customerInput({ name: 'Tasnim Pharmacy', code: 'C-00042' }),
       savedAt: SAVED,
     });
     const [created] = await db.outbox.toArray();
     if (!created) throw new Error('no create');
-    await saveOrderDraft(db, {
+    await saveOrderDraft(copy, {
       orderId: null,
       input: orderDraft(created.customerId, VARIANT),
       name: 'Tasnim Pharmacy',
@@ -176,7 +158,7 @@ describe('SyncEngine push', () => {
     });
     await engine.syncNow();
     expect(pushed).toHaveBeenCalledTimes(1);
-    const [failed, order] = await db.outbox.toArray();
+    const [failed, order] = await outboxEntries(copy);
     expect(failed).toMatchObject({
       status: 'failed',
       sent: true,
@@ -186,22 +168,24 @@ describe('SyncEngine push', () => {
   });
 
   it('puts a batch back when the push fails, still marked as sent', async () => {
-    const { db, engine } = engineWith(() => Promise.reject(new CodedError('network_error')));
+    const { copy, engine } = await engineWith(() =>
+      Promise.reject(new CodedError('network_error')),
+    );
     const rahman = customer({ name: 'Rahman Traders' });
-    await saveCustomer(db, {
+    await saveCustomer(copy, {
       base: rahman,
       input: { ...inputOf(rahman), phone: '01819-000111' },
       savedAt: SAVED,
     });
     await engine.syncNow();
     expect(engine.getStatus().problem).toBe('network_error');
-    const [waiting] = await db.outbox.toArray();
+    const [waiting] = await outboxEntries(copy);
     expect(waiting).toMatchObject({ status: 'waiting', sent: true });
   });
 
   it('keeps the notice of a head-office field the server kept', async () => {
     const rahman = customer({ name: 'Rahman Traders', creditLimit: '200000.0000' });
-    const { db, engine, onPushed } = engineWith((input) =>
+    const { copy, engine, onPushed } = await engineWith((input) =>
       Promise.resolve({
         serverTime: SERVER,
         results: input.commands.map((command) => ({
@@ -212,13 +196,13 @@ describe('SyncEngine push', () => {
         })),
       }),
     );
-    await saveCustomer(db, {
+    await saveCustomer(copy, {
       base: rahman,
       input: { ...inputOf(rahman), creditLimit: '500000' },
       savedAt: SAVED,
     });
     await engine.syncNow();
-    expect(await db.notices.toArray()).toMatchObject([
+    expect(await syncNotices(copy)).toMatchObject([
       { name: 'Rahman Traders', fields: ['creditLimit'], at: SERVER },
     ]);
     expect(onPushed).toHaveBeenCalledWith({ accepted: 1, rejected: 0, kept: 1 });
@@ -236,9 +220,9 @@ describe('SyncEngine push', () => {
         })),
       }),
     );
-    const { db, engine } = engineWith(pushed);
+    const { copy, db, engine } = await engineWith(pushed);
     const rahman = customer({ name: 'Rahman Traders' });
-    await saveCustomer(db, {
+    await saveCustomer(copy, {
       base: rahman,
       input: { ...inputOf(rahman), phone: '01819-000111' },
       savedAt: SAVED,
```

- **`pickBatch` gets rows,** with `bytes` set by the test: the 512 KB rule is checked on the counted size.

```diff
@@ -1,11 +1,15 @@
 import 'fake-indexeddb/auto';
 
 import { syncCommandSchema } from '@omnivo/contracts';
-import { describe, expect, it } from 'vitest';
+import type { SyncCommandError } from '@omnivo/contracts';
+import { describe, expect, it, vi } from 'vitest';
 
-import type { SyncDatabase } from './database.js';
+import type { LocalCopy } from './copy.js';
+import type { OutboxEntry } from './database.js';
 import { discardEntry, retryEntry, saveCustomer, saveOrderDraft } from './outbox.js';
-import { customer, customerInput, inputOf, newDatabase, orderDraft } from './test-fixtures.js';
+import { outboxEntries } from './queries.js';
+import { sealEntry } from './sealed.js';
+import { customer, customerInput, inputOf, newCopy, orderDraft } from './test-fixtures.js';
 
 const SAVED = '2026-10-21T15:00:00.000Z';
 const VARIANT = '01928c4e-8888-7000-8000-000000000001';
@@ -26,28 +30,35 @@ const rahman = customer({
   ],
 });
 
-async function entries(db: SyncDatabase) {
-  return db.outbox.toArray();
+function entries(copy: LocalCopy) {
+  return outboxEntries(copy);
 }
 
-async function only(db: SyncDatabase) {
-  const [entry, ...more] = await entries(db);
+async function only(copy: LocalCopy) {
+  const [entry, ...more] = await entries(copy);
   expect(more).toEqual([]);
   if (!entry) throw new Error('the outbox is empty');
   return entry;
 }
 
+// What the push does to a refused command (push.ts): the error is sealed with the rest
+async function refuse(copy: LocalCopy, entry: OutboxEntry, error: SyncCommandError) {
+  await copy.db.outbox.put(
+    await sealEntry(copy, { ...entry, status: 'failed', sent: true, error }),
+  );
+}
+
 describe('saveCustomer', () => {
   it('saves a new customer as a create, with the device’s ids, that the server reads as it is', async () => {
-    const db = newDatabase();
+    const copy = await newCopy();
     const input = customerInput({
       name: 'Tasnim Pharmacy',
       addresses: [
         { id: null, kind: 'billing', label: null, address: 'Agrabad, Chattogram', phone: null },
       ],
     });
-    expect(await saveCustomer(db, { base: null, input, savedAt: SAVED })).toBe('saved');
-    const entry = await only(db);
+    expect(await saveCustomer(copy, { base: null, input, savedAt: SAVED })).toBe('saved');
+    const entry = await only(copy);
     expect(entry).toMatchObject({ status: 'waiting', sent: false, name: 'Tasnim Pharmacy' });
     if (entry.command.type !== 'customer.create') throw new Error('not a create');
     expect(entry.key).toBe(entry.command.customerId);
@@ -57,17 +68,19 @@ describe('saveCustomer', () => {
   });
 
   it('sends only what changed, and a credit limit typed without decimals is no change', async () => {
-    const db = newDatabase();
+    const copy = await newCopy();
     const same = { ...inputOf(rahman), creditLimit: '200000' };
-    expect(await saveCustomer(db, { base: rahman, input: same, savedAt: SAVED })).toBe('unchanged');
-    expect(await entries(db)).toEqual([]);
+    expect(await saveCustomer(copy, { base: rahman, input: same, savedAt: SAVED })).toBe(
+      'unchanged',
+    );
+    expect(await entries(copy)).toEqual([]);
 
-    await saveCustomer(db, {
+    await saveCustomer(copy, {
       base: rahman,
       input: { ...same, phone: '01819-000111' },
       savedAt: SAVED,
     });
-    const entry = await only(db);
+    const entry = await only(copy);
     if (entry.command.type !== 'customer.update') throw new Error('not an update');
     expect(entry.command.changes).toEqual({
       phone: { from: '01711-234567', to: '01819-000111' },
@@ -78,21 +91,21 @@ describe('saveCustomer', () => {
   });
 
   it('folds a second edit into the waiting change, with the first `from`, under a new id', async () => {
-    const db = newDatabase();
-    await saveCustomer(db, {
+    const copy = await newCopy();
+    await saveCustomer(copy, {
       base: rahman,
       input: { ...inputOf(rahman), phone: '01819-000111' },
       savedAt: SAVED,
     });
-    const first = await only(db);
+    const first = await only(copy);
     // The form opens on the customer with the change on it, and changes the limit too
     const shown = { ...rahman, phone: '01819-000111' };
-    await saveCustomer(db, {
+    await saveCustomer(copy, {
       base: shown,
       input: { ...inputOf(shown), creditLimit: '250000' },
       savedAt: SAVED,
     });
-    const second = await only(db);
+    const second = await only(copy);
     expect(second.seq).toBe(first.seq);
     expect(second.command.id).not.toBe(first.command.id);
     if (second.command.type !== 'customer.update') throw new Error('not an update');
@@ -102,28 +115,28 @@ describe('saveCustomer', () => {
     });
 
     // Changed back to what the server has: nothing is left to send
-    await saveCustomer(db, { base: shown, input: inputOf(rahman), savedAt: SAVED });
-    expect(await entries(db)).toEqual([]);
+    await saveCustomer(copy, { base: shown, input: inputOf(rahman), savedAt: SAVED });
+    expect(await entries(copy)).toEqual([]);
   });
 
   it('adds a new change after one that was sent without an answer', async () => {
-    const db = newDatabase();
-    await saveCustomer(db, {
+    const copy = await newCopy();
+    await saveCustomer(copy, {
       base: rahman,
       input: { ...inputOf(rahman), phone: '01819-000111' },
       savedAt: SAVED,
     });
-    const sent = await only(db);
+    const sent = await only(copy);
     if (sent.seq === undefined) throw new Error('no seq');
     // It may have run on the server: it is never rewritten
-    await db.outbox.update(sent.seq, { sent: true });
+    await copy.db.outbox.update(sent.seq, { sent: true });
     const shown = { ...rahman, phone: '01819-000111' };
-    await saveCustomer(db, {
+    await saveCustomer(copy, {
       base: shown,
       input: { ...inputOf(shown), name: 'Rahman Traders Ltd' },
       savedAt: SAVED,
     });
-    const [kept, added] = await entries(db);
+    const [kept, added] = await entries(copy);
     expect(kept?.command).toEqual(sent.command);
     if (added?.command.type !== 'customer.update') throw new Error('not an update');
     expect(added.command.changes).toEqual({
@@ -131,26 +144,60 @@ describe('saveCustomer', () => {
     });
   });
 
+  it('starts again when a push takes the command while the save seals its change (step 19b)', async () => {
+    const copy = await newCopy();
+    await saveCustomer(copy, {
+      base: rahman,
+      input: { ...inputOf(rahman), phone: '01819-000111' },
+      savedAt: SAVED,
+    });
+    const first = await only(copy);
+    if (first.seq === undefined) throw new Error('no seq');
+    const { seq } = first;
+    // The second save opens the waiting change and would fold into it. While it seals (outside
+    // any transaction), the push marks that change sent: folding into it now would rewrite a
+    // command the server may run.
+    const seal = copy.seal.bind(copy);
+    let raced = false;
+    vi.spyOn(copy, 'seal').mockImplementation(async (table, key, value) => {
+      if (!raced) {
+        raced = true;
+        await copy.db.outbox.update(seq, { status: 'sending', sent: true });
+      }
+      return seal(table, key, value);
+    });
+    const shown = { ...rahman, phone: '01819-000111' };
+    expect(
+      await saveCustomer(copy, {
+        base: shown,
+        input: { ...inputOf(shown), name: 'Rahman Traders Ltd' },
+        savedAt: SAVED,
+      }),
+    ).toBe('saved');
+    const [kept, added] = await entries(copy);
+    expect(kept?.command).toEqual(first.command);
+    if (added?.command.type !== 'customer.update') throw new Error('not an update');
+    expect(added.command.changes).toEqual({
+      name: { from: 'Rahman Traders', to: 'Rahman Traders Ltd' },
+    });
+  });
+
   it('turns a refused create, fixed, into a waiting create with a new id', async () => {
-    const db = newDatabase();
+    const copy = await newCopy();
     const input = customerInput({ name: 'Tasnim Pharmacy', code: 'C-00042' });
-    await saveCustomer(db, { base: null, input, savedAt: SAVED });
-    const refused = await only(db);
+    await saveCustomer(copy, { base: null, input, savedAt: SAVED });
+    const refused = await only(copy);
     if (refused.seq === undefined || refused.command.type !== 'customer.create') {
       throw new Error('not a create');
     }
-    await db.outbox.update(refused.seq, {
-      status: 'failed',
-      sent: true,
-      error: { code: 'customer_code_taken' },
-    });
+    await refuse(copy, refused, { code: 'customer_code_taken' });
     const shown = { ...customer({ name: 'Tasnim Pharmacy', code: 'C-00042' }), id: refused.key };
-    await saveCustomer(db, {
+    await saveCustomer(copy, {
       base: shown,
       input: { ...input, code: null },
       savedAt: SAVED,
     });
-    const fixed = await only(db);
+    const fixed = await only(copy);
     expect(fixed).toMatchObject({ status: 'waiting', sent: false, error: null, seq: refused.seq });
     if (fixed.command.type !== 'customer.create') throw new Error('not a create');
     expect(fixed.command.id).not.toBe(refused.command.id);
@@ -159,9 +206,9 @@ describe('saveCustomer', () => {
   });
 
   it('changes addresses one by one, by id', async () => {
-    const db = newDatabase();
+    const copy = await newCopy();
     const input = inputOf(rahman);
-    await saveCustomer(db, {
+    await saveCustomer(copy, {
       base: rahman,
       input: {
         ...input,
@@ -177,7 +224,7 @@ describe('saveCustomer', () => {
       },
       savedAt: SAVED,
     });
-    const entry = await only(db);
+    const entry = await only(copy);
     if (entry.command.type !== 'customer.update') throw new Error('not an update');
     expect(entry.command.addresses.remove).toEqual([rahman.addresses[0]?.id]);
     expect(entry.command.addresses.change).toEqual([]);
@@ -186,8 +233,8 @@ describe('saveCustomer', () => {
     ]);
     expect(entry.command.addresses.add[0]?.id).toMatch(/^[0-9a-f-]{14}7/);
 
-    await db.outbox.clear();
-    await saveCustomer(db, {
+    await copy.db.outbox.clear();
+    await saveCustomer(copy, {
       base: rahman,
       input: {
         ...input,
@@ -195,7 +242,7 @@ describe('saveCustomer', () => {
       },
       savedAt: SAVED,
     });
-    const changed = await only(db);
+    const changed = await only(copy);
     if (changed.command.type !== 'customer.update') throw new Error('not an update');
     expect(changed.command.addresses.change).toEqual([
       { id: rahman.addresses[0]?.id, label: 'Head office' },
@@ -205,52 +252,52 @@ describe('saveCustomer', () => {
 
 describe('saveOrderDraft', () => {
   it('saves a draft, and a second save moves it to the end of the outbox', async () => {
-    const db = newDatabase();
+    const copy = await newCopy();
     const draft = orderDraft(rahman.id, VARIANT);
-    await saveOrderDraft(db, {
+    await saveOrderDraft(copy, {
       orderId: null,
       input: draft,
       name: 'Rahman Traders',
       total: '690',
       savedAt: SAVED,
     });
-    await saveCustomer(db, {
+    await saveCustomer(copy, {
       base: null,
       input: customerInput({ name: 'Tasnim Pharmacy' }),
       savedAt: SAVED,
     });
-    const [order] = await entries(db);
+    const [order] = await entries(copy);
     expect(order).toMatchObject({ customerId: rahman.id, lines: 1, total: '690' });
     if (order?.command.type !== 'sales_order.create_draft') throw new Error('not an order');
     expect(syncCommandSchema.parse(order.command)).toEqual(order.command);
 
-    await saveOrderDraft(db, {
+    await saveOrderDraft(copy, {
       orderId: order.key,
       input: { ...draft, note: 'Deliver before Friday' },
       name: 'Rahman Traders',
       total: '690',
       savedAt: SAVED,
     });
-    const [, moved] = await entries(db);
+    const [, moved] = await entries(copy);
     expect(moved?.key).toBe(order.key);
     expect(moved?.command.id).not.toBe(order.command.id);
   });
 
   it('does not change an order that is being sent', async () => {
-    const db = newDatabase();
+    const copy = await newCopy();
     const draft = orderDraft(rahman.id, VARIANT);
-    await saveOrderDraft(db, {
+    await saveOrderDraft(copy, {
       orderId: null,
       input: draft,
       name: 'Rahman Traders',
       total: '690',
       savedAt: SAVED,
     });
-    const order = await only(db);
+    const order = await only(copy);
     if (order.seq === undefined) throw new Error('no seq');
-    await db.outbox.update(order.seq, { status: 'sending', sent: true });
+    await copy.db.outbox.update(order.seq, { status: 'sending', sent: true });
     expect(
-      await saveOrderDraft(db, {
+      await saveOrderDraft(copy, {
         orderId: order.key,
         input: draft,
         name: 'Rahman Traders',
@@ -263,48 +310,44 @@ describe('saveOrderDraft', () => {
 
 describe('discardEntry and retryEntry', () => {
   it('discards a new customer with the orders that need it, and a change alone', async () => {
-    const db = newDatabase();
-    await saveCustomer(db, {
+    const copy = await newCopy();
+    await saveCustomer(copy, {
       base: null,
       input: customerInput({ name: 'Tasnim Pharmacy' }),
       savedAt: SAVED,
     });
-    const created = await only(db);
-    await saveOrderDraft(db, {
+    const created = await only(copy);
+    await saveOrderDraft(copy, {
       orderId: null,
       input: orderDraft(created.customerId, VARIANT),
       name: 'Tasnim Pharmacy',
       total: '690',
       savedAt: SAVED,
     });
-    await saveCustomer(db, {
+    await saveCustomer(copy, {
       base: rahman,
       input: { ...inputOf(rahman), phone: null },
       savedAt: SAVED,
     });
     if (created.seq === undefined) throw new Error('no seq');
-    expect(await discardEntry(db, created.seq)).toBe('saved');
-    const left = await only(db);
+    expect(await discardEntry(copy, created.seq)).toBe('saved');
+    const left = await only(copy);
     expect(left.customerId).toBe(rahman.id);
   });
 
   it('retries a refused command under a new id', async () => {
-    const db = newDatabase();
-    await saveCustomer(db, {
+    const copy = await newCopy();
+    await saveCustomer(copy, {
       base: rahman,
       input: { ...inputOf(rahman), phone: null },
       savedAt: SAVED,
     });
-    const entry = await only(db);
+    const entry = await only(copy);
     if (entry.seq === undefined) throw new Error('no seq');
-    expect(await retryEntry(db, entry.seq)).toBe('unchanged');
-    await db.outbox.update(entry.seq, {
-      status: 'failed',
-      sent: true,
-      error: { code: 'permission_missing' },
-    });
-    expect(await retryEntry(db, entry.seq)).toBe('saved');
-    const again = await only(db);
+    expect(await retryEntry(copy, entry.seq)).toBe('unchanged');
+    await refuse(copy, entry, { code: 'permission_missing' });
+    expect(await retryEntry(copy, entry.seq)).toBe('saved');
+    const again = await only(copy);
     expect(again).toMatchObject({ status: 'waiting', sent: false, error: null });
     expect(again.command.id).not.toBe(entry.command.id);
   });
```

- **`refuse`** does what the push does to a refused command: the error goes inside the box, so a test cannot just
  `update` it any more.
- **"Starts again when a push takes the command while the save seals its change"** makes the race happen on purpose:
  the first `seal` call marks the waiting change as sent, as a push in another tab would. The save must not fold into
  it; it starts again and adds a new command after it.

```diff
@@ -17,7 +17,7 @@ import {
   customer,
   customerInput,
   inputOf,
-  newDatabase,
+  newCopy,
   page,
   product,
   upsertCustomer,
@@ -68,9 +68,9 @@ const polo = product({
 });
 
 async function loaded() {
-  const db = newDatabase();
+  const copy = await newCopy();
   await applyPage(
-    db,
+    copy,
     page({
       full: true,
       changes: [napa, ace, tusca, polo].map(upsertProduct).concat(
@@ -88,18 +88,28 @@ async function loaded() {
     }),
     null,
   );
-  return db;
+  return copy;
 }
 
 const names = (rows: readonly { name: string }[]) => rows.map((row) => row.name);
 
 describe('productPage', () => {
   it('sorts by name without case, like the server, and says when there is more', async () => {
-    const db = await loaded();
-    const first = await productPage(db, { search: '', categoryIds: null, sort: 'name', limit: 3 });
+    const copy = await loaded();
+    const first = await productPage(copy, {
+      search: '',
+      categoryIds: null,
+      sort: 'name',
+      limit: 3,
+    });
     expect(names(first.rows)).toEqual(['ace Plus tablet', 'Napa 500 mg tablet', 'Polo shirt']);
     expect(first.more).toBe(true);
-    const all = await productPage(db, { search: '', categoryIds: null, sort: '-name', limit: 10 });
+    const all = await productPage(copy, {
+      search: '',
+      categoryIds: null,
+      sort: '-name',
+      limit: 10,
+    });
     expect(names(all.rows)).toEqual([
       'Tusca syrup 100 ml',
       'Polo shirt',
@@ -110,31 +120,37 @@ describe('productPage', () => {
   });
 
   it('sorts by code', async () => {
-    const db = await loaded();
-    const rows = (await productPage(db, { search: '', categoryIds: null, sort: 'code', limit: 10 }))
-      .rows;
+    const copy = await loaded();
+    const rows = (
+      await productPage(copy, { search: '', categoryIds: null, sort: 'code', limit: 10 })
+    ).rows;
     expect(rows.map((row) => row.code)).toEqual(['FG-0001', 'MED-0001', 'MED-0002', 'MED-0003']);
   });
 
   it('finds by part of the name, the code or a SKU, and by a whole barcode', async () => {
-    const db = await loaded();
-    expect(names(await findProducts(db, 'TABLET'))).toEqual([
+    const copy = await loaded();
+    expect(names(await findProducts(copy, 'TABLET'))).toEqual([
       'ace Plus tablet',
       'Napa 500 mg tablet',
     ]);
-    expect(names(await findProducts(db, 'med-0003'))).toEqual(['Tusca syrup 100 ml']);
+    expect(names(await findProducts(copy, 'med-0003'))).toEqual(['Tusca syrup 100 ml']);
     // An archived variant's SKU still finds its product, like the server
-    expect(names(await findProducts(db, 'nvy-xxl'))).toEqual(['Polo shirt']);
+    expect(names(await findProducts(copy, 'nvy-xxl'))).toEqual(['Polo shirt']);
     // A pack's barcode and a variant's barcode, whole only
-    expect(names(await findProducts(db, '8941100500017'))).toEqual(['Napa 500 mg tablet']);
-    expect(names(await findProducts(db, '2000000000015'))).toEqual(['Polo shirt']);
-    expect(await findProducts(db, '89411005')).toEqual([]);
+    expect(names(await findProducts(copy, '8941100500017'))).toEqual(['Napa 500 mg tablet']);
+    expect(names(await findProducts(copy, '2000000000015'))).toEqual(['Polo shirt']);
+    expect(await findProducts(copy, '89411005')).toEqual([]);
   });
 
   it('filters by the categories it is given', async () => {
-    const db = await loaded();
+    const copy = await loaded();
     const rows = (
-      await productPage(db, { search: '', categoryIds: new Set([SYRUP]), sort: 'name', limit: 10 })
+      await productPage(copy, {
+        search: '',
+        categoryIds: new Set([SYRUP]),
+        sort: 'name',
+        limit: 10,
+      })
     ).rows;
     expect(names(rows)).toEqual(['Tusca syrup 100 ml']);
   });
@@ -158,24 +174,24 @@ describe('productSummaryOf', () => {
 
 describe('customerPage', () => {
   it('sorts by name, filters by group and searches the phone and contact person', async () => {
-    const db = await loaded();
-    const all = await customerPage(db, { search: '', groupId: '', sort: 'name', limit: 10 });
+    const copy = await loaded();
+    const all = await customerPage(copy, { search: '', groupId: '', sort: 'name', limit: 10 });
     expect(names(all.rows)).toEqual(['Anwar Pharmacy', 'Bismillah Store', 'Rahman Traders']);
-    const group = await customerPage(db, {
+    const group = await customerPage(copy, {
       search: '',
       groupId: MEDICINE,
       sort: '-name',
       limit: 10,
     });
     expect(names(group.rows)).toEqual(['Rahman Traders', 'Anwar Pharmacy']);
-    expect(names(await findCustomers(db, '1711'))).toEqual(['Rahman Traders']);
-    expect(names(await findCustomers(db, 'karim'))).toEqual(['Bismillah Store']);
-    expect(names(await findCustomers(db, 'c-0000'))).toHaveLength(3);
+    expect(names(await findCustomers(copy, '1711'))).toEqual(['Rahman Traders']);
+    expect(names(await findCustomers(copy, 'karim'))).toEqual(['Bismillah Store']);
+    expect(names(await findCustomers(copy, 'c-0000'))).toHaveLength(3);
   });
 
   it('has no balance on the device', async () => {
-    const db = await loaded();
-    const [first] = (await customerPage(db, { search: '', groupId: '', sort: 'name', limit: 1 }))
+    const copy = await loaded();
+    const [first] = (await customerPage(copy, { search: '', groupId: '', sort: 'name', limit: 1 }))
       .rows;
     expect(first && customerSummaryOf(first).balance).toBeNull();
   });
@@ -185,13 +201,13 @@ describe('the outbox on top of the copy', () => {
   const SAVED = '2026-10-21T15:00:00.000Z';
 
   it('shows a customer made on the device in its place, and a renamed one in its new place', async () => {
-    const db = await loaded();
-    await saveCustomer(db, {
+    const copy = await loaded();
+    await saveCustomer(copy, {
       base: null,
       input: customerInput({ name: 'Chowdhury Medicine Corner' }),
       savedAt: SAVED,
     });
-    const all = await customerPage(db, { search: '', groupId: '', sort: 'name', limit: 10 });
+    const all = await customerPage(copy, { search: '', groupId: '', sort: 'name', limit: 10 });
     expect(names(all.rows)).toEqual([
       'Anwar Pharmacy',
       'Bismillah Store',
@@ -201,33 +217,34 @@ describe('the outbox on top of the copy', () => {
     const made = all.rows.find((row) => row.name === 'Chowdhury Medicine Corner');
     expect(made).toMatchObject({ code: '', version: 0 });
     expect(made && all.pending.has(made.id)).toBe(true);
-    expect(names(await findCustomers(db, 'chowdhury'))).toEqual(['Chowdhury Medicine Corner']);
+    expect(names(await findCustomers(copy, 'chowdhury'))).toEqual(['Chowdhury Medicine Corner']);
 
     const anwar = all.rows.find((row) => row.name === 'Anwar Pharmacy');
     if (!anwar) throw new Error('no Anwar');
-    await saveCustomer(db, {
+    await saveCustomer(copy, {
       base: anwar,
       input: { ...inputOf(anwar), name: 'Zaman Pharmacy' },
       savedAt: SAVED,
     });
-    const after = await customerPage(db, { search: '', groupId: '', sort: 'name', limit: 10 });
+    const after = await customerPage(copy, { search: '', groupId: '', sort: 'name', limit: 10 });
     expect(names(after.rows).at(-1)).toBe('Zaman Pharmacy');
     // The server's row in the database is unchanged; only the screens see the change
-    expect((await db.customers.get(anwar.id))?.data.name).toBe('Anwar Pharmacy');
-    expect((await localCustomer(db, anwar.id))?.name).toBe('Zaman Pharmacy');
+    const row = await copy.db.customers.get(anwar.id);
+    expect(row && (await copy.open('customers', row.key, row.box)).name).toBe('Anwar Pharmacy');
+    expect((await localCustomer(copy, anwar.id))?.name).toBe('Zaman Pharmacy');
   });
 
   it('keeps the page size and says there is more with the outbox merged in', async () => {
-    const db = await loaded();
-    await saveCustomer(db, {
+    const copy = await loaded();
+    await saveCustomer(copy, {
       base: null,
       input: customerInput({ name: 'Aarong Dairy Depot' }),
       savedAt: SAVED,
     });
-    const first = await customerPage(db, { search: '', groupId: '', sort: 'name', limit: 2 });
+    const first = await customerPage(copy, { search: '', groupId: '', sort: 'name', limit: 2 });
     expect(names(first.rows)).toEqual(['Aarong Dairy Depot', 'Anwar Pharmacy']);
     expect(first.more).toBe(true);
-    const last = await customerPage(db, { search: '', groupId: '', sort: '-name', limit: 4 });
+    const last = await customerPage(copy, { search: '', groupId: '', sort: '-name', limit: 4 });
     expect(names(last.rows)).toEqual([
       'Rahman Traders',
       'Bismillah Store',
```

```diff
@@ -5,7 +5,7 @@ import { describe, expect, it } from 'vitest';
 
 import { applyPage } from './apply.js';
 import { lookUpPrices } from './prices.js';
-import { newDatabase, page, product, upsertProduct } from './test-fixtures.js';
+import { newCopy, page, product, upsertProduct } from './test-fixtures.js';
 
 const PCS = '01928c4e-0000-7000-8000-000000000001';
 const CASE = '01928c4e-0000-7000-8000-000000000002';
@@ -78,9 +78,9 @@ function item(priceListId: string, unitId: string, price: string): SyncChange {
 }
 
 async function loaded() {
-  const db = newDatabase();
+  const copy = await newCopy();
   await applyPage(
-    db,
+    copy,
     page({
       full: true,
       changes: [
@@ -95,15 +95,15 @@ async function loaded() {
     }),
     null,
   );
-  return db;
+  return copy;
 }
 
 describe('lookUpPrices', () => {
   it('starts a line like the server: the price list, else the product price in the unit', async () => {
-    const db = await loaded();
+    const copy = await loaded();
     const variantId = variant.id;
     expect(
-      await lookUpPrices(db, LIST, [
+      await lookUpPrices(copy, LIST, [
         { variantId, unitId: CASE },
         { variantId, unitId: PCS },
       ]),
@@ -112,21 +112,21 @@ describe('lookUpPrices', () => {
       { variantId, unitId: PCS, price: '21.0000', source: 'product', taxRateId: VAT_5 },
     ]);
     // An archived list counts for nothing: a case is 24 × ৳21
-    expect(await lookUpPrices(db, OLD_LIST, [{ variantId, unitId: CASE }])).toEqual([
+    expect(await lookUpPrices(copy, OLD_LIST, [{ variantId, unitId: CASE }])).toEqual([
       { variantId, unitId: CASE, price: '504.0000', source: 'product', taxRateId: VAT_5 },
     ]);
     // A unit the product does not have drops out, like on the server
-    expect(await lookUpPrices(db, null, [{ variantId, unitId: DOZEN }])).toEqual([]);
+    expect(await lookUpPrices(copy, null, [{ variantId, unitId: DOZEN }])).toEqual([]);
   });
 
   it('falls back to the default rate when the product’s own is archived', async () => {
-    const db = await loaded();
+    const copy = await loaded();
     await applyPage(
-      db,
+      copy,
       page({ changes: [rate(VAT_5, { archivedAt: '2026-10-01T00:00:00.000Z' })] }),
       'cursor',
     );
-    const [found] = await lookUpPrices(db, null, [{ variantId: variant.id, unitId: PCS }]);
+    const [found] = await lookUpPrices(copy, null, [{ variantId: variant.id, unitId: PCS }]);
     expect(found?.taxRateId).toBe(VAT_15);
   });
 });
```

```diff
@@ -5,7 +5,7 @@ import { describe, expect, it, vi } from 'vitest';
 
 import { readPullState } from './state.js';
 import { SyncEngine, type SyncEngineOptions } from './engine.js';
-import { newDatabase, page, product, upsertProduct } from './test-fixtures.js';
+import { newCopy, page, product, upsertProduct } from './test-fixtures.js';
 
 // An API error the way the app's ApiRequestError carries it
 class CodedError extends Error {
@@ -17,13 +17,14 @@ class CodedError extends Error {
 const codeOf = (error: unknown) => (error instanceof CodedError ? error.code : null);
 const DEVICE = '01928c4e-1111-7000-8000-000000000001';
 
-function engineWith(
+async function engineWith(
   pull: (query: SyncPullQuery) => Promise<SyncPull>,
   options: Partial<SyncEngineOptions> = {},
 ) {
-  const db = newDatabase();
+  const copy = await newCopy();
+  const { db } = copy;
   const engine = new SyncEngine({
-    db,
+    copy,
     deviceId: DEVICE,
     pull,
     // Nothing in the outbox: the 18a tests never push
@@ -55,7 +56,7 @@ describe('SyncEngine', () => {
     const pull = vi.fn<(query: SyncPullQuery) => Promise<SyncPull>>(() =>
       Promise.resolve(pages.shift() ?? page({ changes: [] })),
     );
-    const { db, engine } = engineWith(pull);
+    const { db, engine } = await engineWith(pull);
     await engine.syncNow();
     expect(pull.mock.calls.map(([query]) => query.cursor)).toEqual([undefined, 'a']);
     expect(pull.mock.calls[0]?.[0]).toMatchObject({ deviceId: DEVICE, protocol: 1, limit: 500 });
@@ -77,7 +78,7 @@ describe('SyncEngine', () => {
           };
         }),
     );
-    const { engine } = engineWith(pull);
+    const { engine } = await engineWith(pull);
     const first = engine.syncNow();
     const second = engine.syncNow();
     const third = engine.syncNow();
@@ -102,7 +103,7 @@ describe('SyncEngine', () => {
       .mockRejectedValueOnce(new CodedError('device_not_found'))
       .mockResolvedValueOnce(page({ changes: [] }));
     const registerAgain = vi.fn(() => Promise.resolve());
-    const { engine } = engineWith(pull, { registerAgain });
+    const { engine } = await engineWith(pull, { registerAgain });
     await engine.syncNow();
     expect(registerAgain).toHaveBeenCalledTimes(1);
     expect(pull).toHaveBeenCalledTimes(2);
@@ -112,7 +113,7 @@ describe('SyncEngine', () => {
   it('stops for good on device_revoked and tells the app', async () => {
     const pull = vi.fn(() => Promise.reject(new CodedError('device_revoked')));
     const onRevoked = vi.fn();
-    const { engine } = engineWith(pull, { onRevoked });
+    const { engine } = await engineWith(pull, { onRevoked });
     await engine.syncNow();
     expect(onRevoked).toHaveBeenCalledTimes(1);
     expect(engine.getStatus()).toEqual({
@@ -126,7 +127,7 @@ describe('SyncEngine', () => {
 
   it('stops on sync_protocol_mismatch: only a reload helps', async () => {
     const pull = vi.fn(() => Promise.reject(new CodedError('sync_protocol_mismatch')));
-    const { engine } = engineWith(pull);
+    const { engine } = await engineWith(pull);
     await engine.syncNow();
     expect(engine.getStatus()).toMatchObject({ problem: 'sync_protocol_mismatch', stopped: true });
   });
@@ -144,7 +145,7 @@ describe('SyncEngine', () => {
       )
       .mockRejectedValueOnce(new CodedError('network_error'))
       .mockResolvedValueOnce(page({ full: true, cursor: 'b', changes: [] }));
-    const { db, engine } = engineWith(pull);
+    const { db, engine } = await engineWith(pull);
     await engine.syncNow();
     expect(engine.getStatus()).toEqual({
       syncing: false,
@@ -159,21 +160,21 @@ describe('SyncEngine', () => {
   });
 
   it('an error that is not the API’s is unknown_error', async () => {
-    const { engine } = engineWith(() => Promise.reject(new TypeError('boom')));
+    const { engine } = await engineWith(() => Promise.reject(new TypeError('boom')));
     await engine.syncNow();
     expect(engine.getStatus().problem).toBe('unknown_error');
   });
 
   it('pulls no more after stop()', async () => {
     const pull = vi.fn(() => Promise.resolve(page({ changes: [] })));
-    const { engine } = engineWith(pull);
+    const { engine } = await engineWith(pull);
     engine.stop();
     await engine.syncNow();
     expect(pull).not.toHaveBeenCalled();
   });
 
   it('tells its listeners when the status changes', async () => {
-    const { engine } = engineWith(() => Promise.resolve(page({ changes: [] })));
+    const { engine } = await engineWith(() => Promise.resolve(page({ changes: [] })));
     const seen: boolean[] = [];
     const unsubscribe = engine.subscribe(() => {
       seen.push(engine.getStatus().syncing);
```

These three only change `db` to the copy, and read a row's data with `copy.open` where they read `data` before.

### Check this part

```bash
pnpm --filter @omnivo/sync typecheck
pnpm --filter @omnivo/sync test
pnpm exec eslint packages/sync/src
pnpm exec prettier --check packages/sync/src
```

All four pass: 85 tests in 11 files. Do not run the app's checks yet: they fail until 19b.4.

Also checked while writing this part:

- Removing the `Promise.resolve` around `crypto.subtle.decrypt` in `unseal` fails "keeps following a read made after
  opening a row". Before that test existed, the other specs passed without the wrap: every read opened its rows inside
  `Promise.all`, which inside a liveQuery is Dexie's own. That is why the test opens a row with a plain `await`.
- Removing the `stateOf` check in `saveCustomer` fails "starts again when a push takes the command".
- A liveQuery that waits on an ordinary promise after its reads (as `current()` does) still runs again after a write
  (tested on its own in Dexie 4.4.6 with fake-indexeddb).
- Built with `pnpm --filter @omnivo/sync build`, the app's type check fails in exactly the twelve files listed at the
  top of this part, and nowhere else.

## 19b.2 — the device's key on the server

This part changes `packages/contracts`, `packages/db` and `apps/api`. Every device gets a key of its own on the
server, and the app can ask for it. 19b.1 already uses it: `openKey(db, { serverKey })` takes these 32 bytes. The app
asks for them in 19b.4. The app still does not type-check after this part, in the same twelve files as after 19b.1.

### `packages/contracts/src/sync.ts`: the key's route

```diff
@@ -454,6 +454,18 @@ export const registerDeviceInputSchema = z.object({
 export type RegisterDeviceInput = z.infer<typeof registerDeviceInputSchema>;
 export type RegisterDeviceFormValues = z.input<typeof registerDeviceInputSchema>;
 
+// Step 19b: the device's own key. It opens the encrypted copy on the device without a PIN, so
+// the app asks for it after every online sign-in and reload, keeps it in memory only, and never
+// writes it to the disk: a key on the disk next to the copy would open it for anyone. 32 random
+// bytes in standard base64: 43 characters and one '='. A length of 44 alone is not enough: 31
+// bytes end in '==' and 33 bytes in no '=', and both are 44 characters too.
+export const deviceKeySchema = z.object({
+  key: z.base64().regex(/^[A-Za-z0-9+/]{43}=$/),
+});
+export type DeviceKey = z.infer<typeof deviceKeySchema>;
+
+const deviceKeyParamsSchema = z.object({ id: z.uuid() });
+
 // No permission: every member may work offline. What a device receives is what its person may
 // read anyway (products, customers, prices and stock need no permission to read).
 export const syncRoutes = {
@@ -466,6 +478,19 @@ export const syncRoutes = {
     body: registerDeviceInputSchema,
     response: deviceSchema,
   }),
+  // Only to the device's own person, while it is active: another person's device, an unknown id
+  // and another workspace's device are device_not_found, a revoked one device_revoked (and the
+  // app deletes its copy). The API answers it with Cache-Control: no-store, so no cache on the
+  // disk keeps it.
+  deviceKey: defineRoute({
+    method: 'GET',
+    path: '/sync/devices/:id/key',
+    summary: "The device's key, which opens its encrypted copy without a PIN",
+    auth: 'bearer',
+    status: 200,
+    params: deviceKeyParamsSchema,
+    response: deviceKeySchema,
+  }),
   pull: defineRoute({
     method: 'GET',
     path: '/sync/pull',
```

- **`key` is standard base64, not base64url.** It is never part of a URL, so base64url's `-` and `_` would buy
  nothing, and `atob` in the browser reads standard base64 (19b.4 turns it into bytes).
- **The regex says "43 characters and one `=`".** That is the only form 32 bytes can take (decision 28). `z.base64()`
  stays in front of it, so the OpenAPI document says `format: base64`.
- **The id in the path is `z.uuid()`, not `z.uuidv7()`.** Every device id is a UUIDv7, because registering checks
  that, but an id here is only looked up. Any other id answers `device_not_found`, like an unknown one, instead of a
  400 that would say something about the id.
- **`GET`, although the request writes the device's session.** Asking for the key twice gives the same answer and
  changes nothing a person can see (the session column is bookkeeping, like a pull's last sync time). No new
  permission: every member may work offline, like the pull and the push.

The OpenAPI document is generated from the routes. Run `pnpm --filter @omnivo/contracts gen:openapi`; it adds the new
path to `packages/contracts/openapi.json`. Commit it as it is.

```diff
@@ -3,6 +3,7 @@ import { describe, expect, it } from 'vitest';
 import { contractErrorMap } from './errors.js';
 import {
   customerUpdateCommandSchema,
+  deviceKeySchema,
   priceListItemKey,
   registerDeviceInputSchema,
   salesOrderDraftCommandSchema,
@@ -227,6 +228,29 @@ function newCustomer(extra: object = {}) {
   };
 }
 
+describe('device key', () => {
+  // Base64 by hand: 'A' is six 0 bits, so 43 of them and '=' are 32 zero bytes. The contracts
+  // run in the browser too, so there is no Buffer here.
+  it('is 32 bytes in standard base64', () => {
+    const key = `${'A'.repeat(43)}=`;
+    expect(deviceKeySchema.parse({ key })).toEqual({ key });
+  });
+
+  it('refuses any other size, and base64url', () => {
+    for (const key of [
+      // 16 bytes would still make an AES key, a weaker one: the app must never take it
+      `${'A'.repeat(22)}==`,
+      // 31 and 33 bytes: 44 characters too
+      `${'A'.repeat(42)}==`,
+      'A'.repeat(44),
+      // base64url drops the '=' and uses - and _
+      '_'.repeat(43),
+    ]) {
+      expect(deviceKeySchema.safeParse({ key }).success, key).toBe(false);
+    }
+  });
+});
+
 describe('sync commands', () => {
   it('adds a customer with the device ids, and leaves the code to the server', () => {
     const command = syncCommandSchema.parse({
```

- **No `Buffer` in this test.** The contracts are also built into the app, which runs in the browser, so the package
  has no Node types. Base64 written by hand does the same: `A` is six zero bits, so 43 of them and `=` are 32 zero
  bytes.
- **31 and 33 bytes are 44 characters too.** These two cases are why the schema has a regex instead of
  `.length(44)`: with `.length(44)`, this test fails.

### `packages/db/src/schema/sync.ts`: the `secret` column

```diff
@@ -33,6 +33,12 @@ const xid8 = customType<{ data: string; driverData: string }>({
   dataType: () => 'xid8',
 });
 
+// Raw bytes. Drizzle 0.45 has no bytea column; the postgres driver reads one as a Buffer and
+// writes a Buffer as one, so no conversion is needed.
+const bytea = customType<{ data: Buffer; driverData: Buffer }>({
+  dataType: () => 'bytea',
+});
+
 // The change log of step 18a: one row for every row of a synced table that was written, written
 // by migration 0044's triggers in the same transaction. Code never writes it. The pull reads the
 // keys a device has not seen yet and sends each one in its current state (or as a delete when it
@@ -100,6 +106,13 @@ export const devices = pgTable(
     // removed them from the workspace. Set with revoked_at; migration 0048 makes every revoke
     // from step 18c on name someone.
     revokedBy: uuid('revoked_by').references(() => users.id),
+    // Step 19b: the device's own key, 32 random bytes. It wraps the key that encrypts the copy on
+    // the device, so the copy opens online without a PIN. Only GET /sync/devices/:id/key sends it,
+    // to the device's person. A revoke sets it to NULL, and the key is gone for good. Migration
+    // 0050 gives it its default (gen_random_bytes, so the database makes it) and its checks: an
+    // active device always has one, a revoked one never. They live there, not here: drizzle-kit
+    // would add them before the extension exists, and before the old devices have a key.
+    secret: bytea('secret'),
   },
   (table) => [
     // The target of the composite FKs from sync_commands and audit_logs: never another tenant's device
```

- **A `customType` for `bytea`.** Drizzle 0.45 has no bytea column. The `postgres` driver already reads a bytea as a
  `Buffer` and writes a `Buffer` as one, so the type needs no `toDriver` / `fromDriver`. The `xid8` type above it is
  made the same way.
- **The column is nullable here, with no default and no check.** The comment says where they are: in migration 0050.
  drizzle-kit would put a `DEFAULT gen_random_bytes(32)` in the generated migration, before `pgcrypto` exists, and
  that default would also fill the column for every old row, the revoked devices too, before the check could run.
  Drizzle never sees them, so it never tries to drop them (like the trigram indexes of migration 0020).

### Migration 0049 (generated)

Run `pnpm --filter @omnivo/db generate --name devices-secret`. The file is used as Drizzle writes it:

```sql
ALTER TABLE "devices" ADD COLUMN "secret" "bytea";
```

- **Instant on any size of table:** a nullable column with no default changes only the catalog.
- `meta/_journal.json` and `meta/0049_snapshot.json` change too. They are generated; commit them as they are.

### Migration 0050 (custom): a key for every active device

Run `pnpm --filter @omnivo/db generate --custom --name devices-secret-rules`, then fill the file:

```sql
-- Custom SQL migration file, put your code below! --
-- Step 19b: every active device has a key of its own (devices.secret), and a revoked device has
-- none. The device's copy is encrypted with a random data key, and this key wraps it, so the copy
-- opens online without a PIN. Revoking a device deletes the key: from then on only the PIN opens
-- that copy, until the device reaches the server and deletes it.

-- 1) The database makes the key, with pgcrypto's gen_random_bytes (the operating system's secure
--    random source). pgcrypto ships with Postgres and is a "trusted" extension, like pg_trgm in
--    0020, so the database owner (omnivo_migrator) may create it. The default is set here and not
--    in the Drizzle schema: drizzle-kit would write it before the extension exists. Set after the
--    column was added (0049), it is only for new rows: every device registered from now on.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
ALTER TABLE devices ALTER COLUMN secret SET DEFAULT gen_random_bytes(32);

-- 2) The devices registered before this step, once per workspace: devices has FORCE ROW LEVEL
--    SECURITY (0044), so without app.tenant_id this UPDATE would see no row. Only the active ones:
--    a revoked device never gets a key again. Each row calls gen_random_bytes on its own, so no
--    two devices share a key. A raw UPDATE of one column: version and updated_at stay, so a rename
--    open on the Devices page does not fail on its version, and the 0048 trigger lets an active
--    row change.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    UPDATE devices
       SET secret = gen_random_bytes(32)
     WHERE tenant_id = t
       AND revoked_at IS NULL
       AND secret IS NULL;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- 3) The rules, for every code path (the API, a script, a hand-written UPDATE):
--    - an active device has a key, and a revoked one has none. So a revoke that forgets the key
--      fails, instead of leaving a key the server could still give out. A NOT NULL alone would
--      not do: a revoked device must have none.
--    - a key is exactly 32 bytes, an AES-256 key. The app refuses any other length too.
--    A CHECK sees every row, whatever the RLS, so both are checked for every workspace here.
ALTER TABLE devices
  ADD CONSTRAINT devices_secret_check CHECK ((secret IS NULL) = (revoked_at IS NOT NULL));
ALTER TABLE devices
  ADD CONSTRAINT devices_secret_length_check CHECK (secret IS NULL OR octet_length(secret) = 32);
```

- **`CREATE EXTENSION IF NOT EXISTS pgcrypto`.** `pgcrypto` is a "trusted" extension since Postgres 13, so the
  database owner, `omnivo_migrator`, may create it without being a superuser, like `pg_trgm` in 0020. Managed
  Postgres services (RDS, Cloud SQL, Supabase) all offer it.
- **`SET DEFAULT` after 0049's `ADD COLUMN`, not in it.** A default given in `ADD COLUMN` fills every existing row.
  Set afterwards, it is used only for new rows. So the revoked devices stay without a key.
- **The loop over the workspaces.** `devices` has `FORCE ROW LEVEL SECURITY` (migration 0044), which applies to the
  table's owner too. Without `app.tenant_id`, the `UPDATE` would see no row, change nothing, and the check after it
  would then fail for every active device. Migration 0032 fills `tenant_settings` the same way.
- **A raw `UPDATE` of one column.** `version` and `updated_at` stay as they were, so a rename open in someone's
  browser does not fail on its version after the deploy. The 0048 trigger lets an active row change.
- **The two checks at the end.** A check is tested on every row, whatever the row level security says, so adding
  them proves that the loop reached every workspace. `devices_secret_check` is decision 22. The length check catches a
  key copied in by hand as text or hex.

### `apps/api/src/sync/devices.service.ts`: giving the key

```diff
@@ -1,6 +1,7 @@
 import { Inject, Injectable } from '@nestjs/common';
 import type {
   Device,
+  DeviceKey,
   DeviceListItem,
   DevicePage,
   DeviceSort,
@@ -27,7 +28,13 @@ import { revokeDevices } from './device-revoke.js';
 
 export type DeviceRow = typeof devices.$inferSelect;
 
-function toDevice(row: DeviceRow): Device {
+// What an answer shows of a device. Step 19b: never its key.
+type DeviceFields = Pick<
+  DeviceRow,
+  'id' | 'name' | 'branchId' | 'userId' | 'lastSyncAt' | 'revokedAt' | 'createdAt' | 'version'
+>;
+
+function toDevice(row: DeviceFields): Device {
   return {
     id: row.id,
     name: row.name,
@@ -53,8 +60,22 @@ function deviceRevoked(): AppError {
 // Step 18c: the person who revoked a device, next to the person it belongs to (both in users)
 const revoker = alias(users, 'revoker');
 
+// Step 19b: a list reads only the columns it shows, never the key, so a page of 50 devices does
+// not carry 50 keys out of the database. Named one by one, so a column added later stays out of
+// the lists until someone adds it here.
+const deviceColumns = {
+  id: devices.id,
+  name: devices.name,
+  branchId: devices.branchId,
+  userId: devices.userId,
+  lastSyncAt: devices.lastSyncAt,
+  revokedAt: devices.revokedAt,
+  createdAt: devices.createdAt,
+  version: devices.version,
+} satisfies { [K in keyof DeviceFields]: (typeof devices)[K] };
+
 const listColumns = {
-  device: devices,
+  device: deviceColumns,
   // users, not memberships: the name stays after the person left the workspace (decision 7)
   userName: users.fullName,
   branchName: branches.name,
@@ -62,7 +83,7 @@ const listColumns = {
 };
 
 interface ListRow {
-  device: DeviceRow;
+  device: DeviceFields;
   userName: string;
   branchName: string;
   revokedByName: string | null;
```

- **`DeviceFields` is a `Pick`, not an `Omit<DeviceRow, 'secret'>`.** An `Omit` would let every column added later
  into the answers' input without anyone deciding it. `toDevice` now takes the fields it uses, so a full `DeviceRow`
  (registering, renaming) still fits it.
- **`deviceColumns` names the columns one by one** (decision 27). The `satisfies` line ties it to `DeviceFields`: a
  name in one and not the other fails the type check. A rest pattern (`const { secret, ...rest } =
  getTableColumns(devices)`) would be shorter, but the lint rule refuses the unused `secret`, and the list would again
  take every new column.

```diff
@@ -153,6 +174,27 @@ export class DevicesService {
     return row;
   }
 
+  // Step 19b: the device's key, to its own person while it is active (forSync's check). FOR
+  // SHARE: a revoke running now holds the row FOR UPDATE, so this waits for its commit, reads the
+  // row again and answers device_revoked. Once a revoke has answered, no key leaves the server.
+  // It follows the sign-in like a pull, so a revoke after a reload ends the session in use now.
+  // No audit row: the app asks at every online opening, and the row says nothing new.
+  key(id: string): Promise<DeviceKey> {
+    return this.withTenant(async (tx) => {
+      const [row] = await tx
+        .select()
+        .from(devices)
+        .where(and(eq(devices.tenantId, getTenantId()), eq(devices.id, id)))
+        .for('share');
+      if (row?.userId !== currentPrincipal().userId) throw deviceNotFound();
+      if (row.revokedAt !== null) throw deviceRevoked();
+      // devices_secret_check (migration 0050): an active device always has its key
+      if (row.secret === null) throw new Error(`device ${id} is active without a key`);
+      await this.keepSession(tx, row);
+      return { key: row.secret.toString('base64') };
+    });
+  }
+
   // Step 18c (decision 13): the device remembers the sign-in it is used with, so a revoke can end
   // it. Written only when it changed (a new sign-in on the same browser), so most requests write
   // nothing. A raw statement, like the pull's last_sync_at: no version and no updated_at, or a
```

- **The same checks as `forSync`, written out with `FOR SHARE`** (decision 25). `forSync` is shared with the pull,
  which must not lock the row for its whole run: a pull of 10,000 rows takes seconds. This read ends at the commit,
  a few milliseconds later.
- **Another person's device and an unknown id are both `device_not_found`.** `row?.userId !== …` is true for a
  missing row as well, so one line handles both, and nobody learns whether an id exists.
- **The `throw new Error` when an active device has no key.** The database check makes it impossible, so this is
  not a message for a person: it is a 500 with a clear log line if the rule is ever dropped by hand. It also narrows
  `row.secret` from `Buffer | null` to `Buffer` for the line below it.
- **`keepSession` after the checks.** It writes nothing for a revoked row anyway, but in this order a request
  that is refused never writes at all.
- **`toString('base64')`** gives the 44 characters the contract asks for.

### `apps/api/src/sync/device-revoke.ts`: the key goes with the revoke

```diff
@@ -20,11 +20,14 @@ export async function revokeDevices(tx: Transaction, rows: readonly DeviceRow[])
   for (const row of rows) {
     // revoked_at IS NULL: a device revoked already keeps who and when (migration 0048 refuses a
     // change anyway). A plain update, so version and updated_at move like any other change.
+    // Step 19b: the device's key goes in the same update, for good. The server can then never
+    // open that copy again; migration 0050's check refuses a revoke that keeps it.
     const [after] = await tx
       .update(devices)
       .set({
         revokedAt: sql`now()`,
         revokedBy,
+        secret: null,
         version: sql`${devices.version} + 1`,
         updatedBy: revokedBy,
       })
```

- **In the same `UPDATE` as `revoked_at`.** Two statements would break `devices_secret_check` between them. One
  function revokes for both callers, the Devices page and the removal of a member, so both delete the key.

### `apps/api/src/sync/sync.controller.ts`: the route

```diff
@@ -1,4 +1,4 @@
-import { Controller } from '@nestjs/common';
+import { Controller, Header } from '@nestjs/common';
 import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';
 
 import { Endpoint } from '../common/http/endpoint.js';
@@ -25,6 +25,16 @@ export class SyncController {
     return this.devices.register(body);
   }
 
+  // no-store, like a share link: the key must never be kept by the browser's cache on the disk,
+  // where it would sit next to the copy it opens
+  @Endpoint(routes.sync.deviceKey)
+  @Header('Cache-Control', 'no-store')
+  deviceKey({
+    params,
+  }: RouteInput<Routes['deviceKey']>): Promise<RouteResponse<Routes['deviceKey']>> {
+    return this.devices.key(params.id);
+  }
+
   @Endpoint(routes.sync.pull)
   pull({ query }: RouteInput<Routes['pull']>): Promise<RouteResponse<Routes['pull']>> {
     return this.sync.pull(query);
```

- **`@Header('Cache-Control', 'no-store')`** (decision 23). Without it, a browser may keep the answer of a `GET` in
  its disk cache, next to the copy. The share link (step 16) and the invitation lookup do the same.
- **In `SyncController`, next to registering:** the app's sync code calls it, and its path starts with `/sync`.

### The tests

Three specs revoke a device by hand with the superuser, to check that a revoked device cannot pull or push. With
0050, that `UPDATE` must delete the key too:

```diff
@@ -544,8 +544,10 @@ describe('registering a device', () => {
   it('stops a revoked device, and checks the protocol before the device', async () => {
     const lost = await newDevice('Lost phone', narsingdi);
     // The superuser revokes it, as its own person: migration 0048 refuses a revoke that names
-    // nobody. 18c's revoke route has tests of its own (devices.int.spec.ts).
-    await sql`UPDATE devices SET revoked_at = now(), revoked_by = user_id WHERE id = ${lost.id}`;
+    // nobody, and 0050 one that keeps the device's key. 18c's revoke route has tests of its own
+    // (devices.int.spec.ts).
+    await sql`UPDATE devices SET revoked_at = now(), revoked_by = user_id, secret = NULL
+               WHERE id = ${lost.id}`;
     const pulled = await pullPage(lost.id, undefined, 10);
     expect(pulled.statusCode).toBe(403);
     expect(problemOf(pulled).code).toBe('device_revoked');
```

```diff
@@ -442,8 +442,10 @@ describe('the request', () => {
 
   it('refuses a revoked device, and runs none of its commands', async () => {
     const lost = await registerDevice(owner, 'Lost phone');
-    // revoked_by: migration 0048 refuses a revoke that names nobody
-    await sql`UPDATE devices SET revoked_at = now(), revoked_by = user_id WHERE id = ${lost.id}`;
+    // revoked_by: migration 0048 refuses a revoke that names nobody; secret: 0050 refuses one
+    // that keeps the device's key
+    await sql`UPDATE devices SET revoked_at = now(), revoked_by = user_id, secret = NULL
+               WHERE id = ${lost.id}`;
     const command = newCustomer('Lost Phone Store');
     const res = await pushRequest([command], { device: lost });
     expect(res.statusCode).toBe(403);
```

`devices.int.spec.ts` gets the key's tests:

```diff
@@ -4,6 +4,7 @@ import type { NestFastifyApplication } from '@nestjs/platform-fastify';
 import {
   auditPageSchema,
   type Branch,
+  deviceKeySchema,
   branchSchema,
   type Device,
   type DeviceListItem,
@@ -229,17 +230,42 @@ const deviceRowSchema = z.object({
   version: z.number(),
   revoked_at: z.date().nullable(),
   last_sync_at: z.date().nullable(),
+  // Step 19b: the driver reads a bytea as a Buffer
+  secret: z.instanceof(Buffer).nullable(),
 });
 async function deviceRow(id: string) {
-  const [row] = z
-    .array(deviceRowSchema)
-    .parse(
-      await sql`SELECT session_id, version, revoked_at, last_sync_at FROM devices WHERE id = ${id}`,
-    );
+  const [row] = z.array(deviceRowSchema).parse(
+    await sql`SELECT session_id, version, revoked_at, last_sync_at, secret
+                  FROM devices WHERE id = ${id}`,
+  );
   if (!row) throw new Error(`no device ${id}`);
   return row;
 }
 
+// Step 19b: the device's key, as the app asks for it after a sign-in or a reload
+function key(device: { id: string }, as = owner) {
+  return send('GET', `/sync/devices/${device.id}/key`, undefined, as);
+}
+
+async function keyOf(device: { id: string }, as = owner): Promise<string> {
+  const res = await key(device, as);
+  expect(res.statusCode, res.body).toBe(200);
+  return deviceKeySchema.parse(res.json()).key;
+}
+
+// The Postgres error a statement of the superuser fails with: its code and the constraint
+async function refusal(run: () => Promise<unknown>) {
+  try {
+    await run();
+  } catch (error) {
+    if (error instanceof postgres.PostgresError) {
+      return { code: error.code, constraint: error.constraint_name };
+    }
+    throw error;
+  }
+  throw new Error('The statement worked');
+}
+
 async function auditOf(device: { id: string }) {
   const res = await send('GET', `/audit-logs?entityType=device&entityId=${device.id}&limit=100`);
   expect(res.statusCode, res.body).toBe(200);
@@ -662,7 +688,8 @@ describe('revoking', () => {
 
     let pending: ReturnType<typeof pull> | undefined;
     await sql.begin(async (tx) => {
-      await tx`UPDATE devices SET revoked_at = now(), revoked_by = user_id WHERE id = ${device.id}`;
+      await tx`UPDATE devices SET revoked_at = now(), revoked_by = user_id, secret = NULL
+                 WHERE id = ${device.id}`;
       // The pull checks the device before the revoke commits, reads the data, and then waits on
       // this row for its last UPDATE
       pending = pull(device, second);
```

- **`deviceRow` also reads `secret`,** as a `Buffer` (`z.instanceof(Buffer)`). The test "makes a new device when the
  browser signs in again" compares the whole row before and after: the key is part of what must not change.
- **`refusal`** returns the error code and the constraint's name, so a test says which rule refused a statement, not
  only that one did.

```diff
@@ -729,6 +756,137 @@ describe('the sign-in a device follows', () => {
   });
 });
 
+describe('the device key', () => {
+  it('gives the device its own key, the same each time, and no cache keeps it', async () => {
+    const browser = await signIn('rafiq');
+    const counter = await newDevice('Rafiq at the counter', headOffice, browser);
+    const van = await newDevice('Rafiq in the van', headOffice, browser);
+
+    const res = await key(counter, browser);
+    expect(res.statusCode, res.body).toBe(200);
+    expect(res.headers['cache-control']).toBe('no-store');
+    const first = deviceKeySchema.parse(res.json()).key;
+    // 32 bytes, and exactly the bytes the database holds
+    const bytes = Buffer.from(first, 'base64');
+    expect(bytes).toHaveLength(32);
+    expect((await deviceRow(counter.id)).secret?.equals(bytes)).toBe(true);
+    // The same key on every reload: the copy was wrapped with it
+    expect(await keyOf(counter, browser)).toBe(first);
+    // Each device has a key of its own
+    expect(await keyOf(van, browser)).not.toBe(first);
+
+    // No other answer carries it: not the registration, not the lists, not the audit log
+    const again = await send(
+      'POST',
+      '/sync/devices',
+      { id: counter.id, name: counter.name, branchId: headOffice.id },
+      browser,
+    );
+    const lists = [
+      again,
+      await send('GET', '/me/devices', undefined, browser),
+      await send('GET', '/devices?limit=100'),
+      await send('GET', `/audit-logs?entityType=device&entityId=${counter.id}&limit=100`),
+    ];
+    for (const list of lists) {
+      expect(list.statusCode, list.body).toBeLessThan(300);
+      expect(list.body).not.toContain(first);
+      expect(list.body).not.toContain('secret');
+    }
+  });
+
+  it("never gives another person's device key, even with core.device.manage", async () => {
+    const counter = await newDevice('Front desk PC', headOffice);
+    for (const someone of [rafiq, nasrin]) {
+      const res = await key(counter, someone);
+      expect(res.statusCode).toBe(404);
+      expect(problemOf(res).code).toBe('device_not_found');
+    }
+    // An id nobody registered answers the same
+    const unknown = await key({ id: v7() });
+    expect(unknown.statusCode).toBe(404);
+    expect(problemOf(unknown).code).toBe('device_not_found');
+  });
+
+  it('deletes the key with the revoke, for good', async () => {
+    const browser = await signIn('nasrin');
+    const device = await newDevice('Nasrin tablet', chattogram, browser);
+    await keyOf(device, browser);
+
+    itemOf(await revoke(device, browser));
+    expect((await deviceRow(device.id)).secret).toBeNull();
+    // Its last access token still works for a few minutes, but gets no key: the app deletes the
+    // copy on device_revoked
+    const res = await key(device, browser);
+    expect(res.statusCode).toBe(403);
+    expect(problemOf(res).code).toBe('device_revoked');
+  });
+
+  it('follows the sign-in, like a pull, without a new version', async () => {
+    const first = await signIn('owner');
+    const device = await newDevice('Accounts laptop', headOffice, first);
+    // A reload after a new sign-in asks for the key before anything else
+    const second = await signIn('owner');
+    await keyOf(device, second);
+    expect(await deviceRow(device.id)).toMatchObject({
+      session_id: sidOf(second),
+      version: device.version,
+    });
+  });
+
+  it('waits for a revoke that is running, then refuses', async () => {
+    const browser = await signIn('owner');
+    const device = await newDevice('Warehouse scanner', headOffice, browser);
+
+    let pending: ReturnType<typeof key> | undefined;
+    await sql.begin(async (tx) => {
+      await tx`UPDATE devices SET revoked_at = now(), revoked_by = user_id, secret = NULL
+                 WHERE id = ${device.id}`;
+      // Without FOR SHARE, the key request would read the row as it was before this revoke,
+      // and send the key after the revoke was done
+      pending = key(device, browser);
+      await eventually(async () => {
+        const waiting = z.array(z.object({ n: z.number() })).parse(
+          await sql`SELECT count(*)::int AS n FROM pg_stat_activity
+                       WHERE wait_event_type = 'Lock' AND query LIKE '%from "devices"%for share%'`,
+        );
+        expect(waiting[0]?.n).toBe(1);
+      });
+    });
+    const res = await pending;
+    expect(res?.statusCode).toBe(403);
+    expect(res && problemOf(res).code).toBe('device_revoked');
+  });
+
+  it('is in the database for every active device, and for no revoked one', async () => {
+    const device = await newDevice('Back office PC', headOffice);
+    // A revoke that keeps the key
+    expect(
+      await refusal(
+        () => sql`UPDATE devices SET revoked_at = now(), revoked_by = user_id
+                    WHERE id = ${device.id}`,
+      ),
+    ).toEqual({ code: '23514', constraint: 'devices_secret_check' });
+    // An active device without one
+    expect(
+      await refusal(() => sql`UPDATE devices SET secret = NULL WHERE id = ${device.id}`),
+    ).toEqual({ code: '23514', constraint: 'devices_secret_check' });
+    // A key that is not 32 bytes
+    expect(
+      await refusal(
+        () => sql`UPDATE devices SET secret = decode('0102', 'hex') WHERE id = ${device.id}`,
+      ),
+    ).toEqual({ code: '23514', constraint: 'devices_secret_length_check' });
+    // And a revoked device never gets one back
+    itemOf(await revoke(device));
+    expect(
+      await refusal(
+        () => sql`UPDATE devices SET secret = gen_random_bytes(32) WHERE id = ${device.id}`,
+      ),
+    ).toEqual({ code: '23514', constraint: 'devices_secret_check' });
+  });
+});
+
 describe('removing a member', () => {
   it('revokes all their active devices, in the name of the person who removed them', async () => {
     const phoneBrowser = await signIn('tanvir');
@@ -764,6 +922,8 @@ describe('removing a member', () => {
       });
     }
     expect(await sessionExists(sidOf(tanvir))).toBe(false);
+    // Step 19b: their keys went with the revoke
+    for (const device of [laptop, tablet]) expect((await deviceRow(device.id)).secret).toBeNull();
   });
 });
 
```

- **"Gives the device its own key …"** compares the answer with the bytes in the database, checks `no-store`, and
  then looks for the key in every other answer that shows the device: the registration, both lists and the audit
  log. It also looks for the word `secret`, so a column leaking under its own name fails too.
- **"Never gives another person's device key, even with `core.device.manage`".** Nasrin may rename and revoke
  Rafiq's devices, but the key opens his copy, so it is his alone.
- **"Waits for a revoke that is running, then refuses"** holds a revoke open in a transaction, starts a key request,
  waits until Postgres shows it waiting for the row's lock, and then commits. Without `FOR SHARE`, the request does
  not wait and the test fails at the lock count.
- **"Is in the database for every active device, and for no revoked one"** tries the three ways around the rule with
  the superuser (a revoke that keeps the key, an active device without one, a key of 2 bytes), and then gives a
  revoked device a new key: `devices_secret_check` refuses all of them except the length, which its own check refuses.
- **The member removal test** now also checks that the removed person's devices lost their keys.

```diff
@@ -453,6 +453,15 @@ describe('managing devices over HTTP', () => {
     });
     expect((await pull(b.who, b.device.id)).statusCode).toBe(200);
   });
+
+  it("never gives tenant B's device key", async () => {
+    // The owner of A, with every permission, asking for B's device by its id
+    const res = await as(a.who, 'GET', `/sync/devices/${b.device.id}/key`);
+    expect(res.statusCode).toBe(404);
+    expect(problemSchema.parse(res.json()).code).toBe('device_not_found');
+    // B's own person gets it: the 404 above is the tenant, not the route
+    expect((await as(b.who, 'GET', `/sync/devices/${b.device.id}/key`)).statusCode).toBe(200);
+  });
 });
 
 // Postgres error code of a statement run as the given role, or null when it worked
```

- **The owner of workspace A has every permission,** and B's device's id. The answer is still `device_not_found`,
  and B's own person gets the key, so the 404 comes from the tenant and not from a broken route.

### Check this part

```bash
pnpm --filter @omnivo/contracts typecheck
pnpm --filter @omnivo/contracts test
pnpm --filter @omnivo/contracts test:openapi
pnpm --filter @omnivo/db typecheck
pnpm db:migrate
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/db build
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api test
cd apps/api && npx vitest run src/sync/ src/members/ --maxWorkers=3
pnpm exec eslint packages/contracts/src packages/db/src apps/api/src/sync
pnpm exec prettier --check packages/contracts/src packages/db/src apps/api/src/sync
```

All pass: 293 contract tests, 123 API unit tests, and 103 integration tests in 7 files (the sync and members suites,
the tenant-leak one too). `pnpm db:migrate` applies 0049 and 0050 to your dev database and gives every active device
there a key. The two builds let the API see the new route and the new column. The app's type check still fails in the
twelve files listed in 19b.1, and nowhere else.

Also checked while writing this part:

- Migration 0050 run again as `omnivo_migrator` (not the superuser, so row level security applies) on a database
  put back to its state after 0049, with two workspaces, each with an active and a revoked device: both active devices
  got a different 32-byte key, both revoked devices kept none, `version` and `updated_at` did not move, and the
  column's default is `gen_random_bytes(32)`.
- Removing `.for('share')` in `key()` fails "waits for a revoke that is running, then refuses".
- Removing `secret: null` from `revokeDevices` makes every revoke a 500 (`devices_secret_check`): 13 tests of
  `devices.int.spec.ts` fail. Removing the `no-store` header fails "gives the device its own key …".
- With `.length(44)` instead of the regex, "refuses any other size, and base64url" fails on 33 bytes.

## 19b.3 — `packages/i18n`: the words

The screens of 19b.4 need their words in English and Bangla, so they come first. This part changes the two locale
files and adds three codes to `ERROR_CODES`. The ui package needs nothing new: the PIN field is built in the app in
19b.4 from the input that exists, and the card, the pills, the dialog and the notices are already there.

When this part starts, the app does not type-check (19b.1 changed `packages/sync` under it). When it ends, nothing
changes there: `packages/contracts`, `packages/i18n` and `packages/ui` type-check, and the app fails in the same
twelve files.

### `packages/contracts/src/errors.ts`: the PIN form's codes

```diff
@@ -502,6 +502,11 @@ export const ERROR_CODES = [
   'network_error',
   'unexpected_response',
   'unknown_error',
+  // Step 19b: the device PIN form's own rules. The PIN never leaves the device, so only the app's
+  // schema sends these
+  'pin_format',
+  'pin_too_easy',
+  'pin_mismatch',
 ] as const;
 
 export type ErrorCode = (typeof ERROR_CODES)[number];
```

- **In the group the client makes itself,** after `unknown_error`: the PIN never reaches the server, so no route
  sends these. The app's PIN schema (19b.4) writes them with `errorCode('pin_format')`, which takes only an
  `ErrorCode`, so a typo fails the type check (decision 29).
- **Three codes, one per thing to fix.** `pin_format` covers both "too short" and "not digits": the field shows a
  number pad and turns Bangla digits into ASCII ones, so anything else is a short PIN. `pin_too_easy` is decision 30.
  `pin_mismatch` is for the second box.
- **No code for a wrong PIN.** It is not a rule of the form, and its text needs the count of tries left (decision 29).

### `locales/en.ts`

```diff
@@ -57,6 +57,10 @@ export const en = {
       macStep2: 'Click Add.',
     },
     installed: 'Omnivo is installed',
+    // Step 19b: the account menu's lock (decision 4). A device without a PIN has nothing to unlock
+    // it with, so its item opens the PIN dialog instead
+    lockNow: 'Lock now',
+    setPinToLock: 'Set a PIN to lock',
   },
   nav: {
     overview: 'Overview',
@@ -144,6 +148,15 @@ export const en = {
       // was back. The copy stays on the device, so signing in again sends its changes
       sessionEnded:
         'You were signed out while offline. Sign in again: the changes saved on this device are sent after that.',
+      // Step 19b: "Forgot PIN?" and a PIN typed wrong too often sign the person out with the copy
+      // kept, like session_ended. The password opens the copy again; then the PIN dialog asks for a
+      // new PIN
+      pinNotice:
+        'Sign in with your password to open your work on this device. You then set a new PIN.',
+      // Step 19b: an offline reload on a device without a PIN (decision 5). Shown instead of
+      // offlineNotice, because it also says why the copy did not open
+      noPinNotice:
+        'This device has no PIN, so its data opens only with a connection. Connect to the internet to sign in.',
       panelLabel: 'What Omnivo does',
       panelTitle: 'Production, stock and accounts. One system.',
       panelBody:
```

- **New keys go into `en.ts` first** (CLAUDE.md → Language). `bn.ts` has the type `Messages`, taken from `en`, so a
  key missing in Bangla fails the type check.
- **`shell.lockNow` and `shell.setPinToLock`** are the account menu's item (decision 4). A device without a PIN has
  nothing to unlock with, so locking it would lock the person out until they are online. The item then says what it
  does instead: it opens the PIN dialog.
- **`auth.login.pinNotice`** is the sign-in page after "Forgot PIN?" and after a PIN that stopped working (decision
  31). It says the two things the person must do, in order: the password, then a new PIN.
- **`auth.login.noPinNotice`** is the sign-in page after an offline reload on a device without a PIN (decision 5).
  The page shows it instead of 19a's `offlineNotice`, not under it: both start with "no connection", and only this one
  says why the copy, which opened offline before this step, does not open now.

```diff
@@ -591,6 +604,10 @@ export const en = {
     // says so under its "Last synced" line
     openedOffline:
       'Omnivo opened without a connection. Your sign-in is checked once the connection is back.',
+    // Step 19b: the server's key no longer opens the copy, and the device has no PIN to open it
+    // with. The app deletes the copy and copies the branch again; what had not synced goes with it
+    copyRemade:
+      "The data on this device couldn't be opened without a PIN, so Omnivo copied it again from the server. Changes that had not synced were lost.",
     // Step 19a: the storage card on the Sync page. navigator.storage.persist() asks the browser to
     // keep the copy; without it, a browser low on space may delete a site's data
     storage: {
```

- **`sync.copyRemade`** is decision 17's last case: the server's key changed and there is no PIN, so nothing can
  open the copy. The app deletes it and copies the branch again (19b.4). The sentence says that changes not synced
  are lost, because they are, and a person who saved orders offline must know to enter them again.

```diff
@@ -608,6 +625,69 @@ export const en = {
       used: '{{used}} used. The browser allows up to {{quota}}.',
     },
   },
+  // Step 19b: the device PIN. It opens the encrypted copy without a connection and after Lock now,
+  // and it never leaves the device. count picks the plural; formatted = the number in the page's
+  // language; max = MAX_WRONG_PINS in the page's language
+  pin: {
+    // The dialog: after the device is set up, from the Sync page's card, and after the sign-in
+    // that "Forgot PIN?" started (new*)
+    setUpTitle: 'Set a PIN for this device',
+    setUpDescription:
+      'Type it to open your work on this device without a connection, or after you lock it. Without a PIN, the data on this device opens only online.',
+    newTitle: 'Set a new PIN',
+    newDescription: 'The old PIN no longer works. Pick a new one for this device.',
+    changeTitle: 'Change the PIN of this device',
+    current: 'Current PIN',
+    label: 'PIN',
+    newPin: 'New PIN',
+    repeat: 'Type the PIN again',
+    hint: '6 digits. It works only on this device and is never sent to the server.',
+    later: 'Not now',
+    save: 'Set PIN',
+    saveChange: 'Change PIN',
+    // Turning a PIN into a key takes up to a second on purpose (decision 15)
+    saving: 'Setting the PIN…',
+    set: 'Device PIN set',
+    changed: 'Device PIN changed',
+    // What typing a PIN can answer, on the lock screen and for the current PIN in the dialog
+    wrong_one: 'Wrong PIN. {{formatted}} try left, then the PIN stops working.',
+    wrong_other: 'Wrong PIN. {{formatted}} tries left, then the PIN stops working.',
+    blocked:
+      'The PIN was wrong {{max}} times, so it stopped working. Sign in with your password to open your work.',
+    // The lock screen (decision 7): the auth layout, with the person's name and email under the
+    // title
+    lock: {
+      title: 'Omnivo is locked',
+      description: 'Type the PIN of this device to open your work.',
+      // An offline reload: the person did not lock the app, so the page says why it asks
+      offlineDescription: "You're offline, so Omnivo needs this device's PIN to open your work.",
+      // The server's key no longer opens the copy (key-changed): the PIN opens it once, and the
+      // copy then follows the server's new key
+      keyChangedDescription: 'Omnivo needs the PIN once to open the work saved on this device.',
+      unlock: 'Unlock',
+      unlocking: 'Unlocking…',
+      forgot: 'Forgot PIN? Sign in with your password',
+      forgotOffline: 'Forgot your PIN? Connect to the internet, then sign in with your password.',
+      // The primary button once the PIN stopped working
+      signIn: 'Sign in with your password',
+      blockedOffline:
+        'The PIN was wrong {{max}} times, so it stopped working. Connect to the internet and sign in with your password. Your work stays on this device.',
+    },
+    // The Sync page's card (decision 5). Each state is a pill and a sentence
+    card: {
+      title: 'Device PIN',
+      subtitle: 'Opens the data on this device without a connection',
+      on: 'PIN set',
+      onBody: 'Omnivo asks for it when it opens offline, and after Lock now in the account menu.',
+      off: 'No PIN',
+      offBody:
+        'The data on this device opens only online. Set a PIN before you work without a connection.',
+      blocked: 'Stopped working',
+      blockedBody: 'The PIN was wrong {{max}} times. Set a new one to open the data offline again.',
+      set: 'Set a PIN',
+      change: 'Change PIN',
+    },
+  },
   accounts: {
     title: 'Chart of accounts',
     description: 'The groups and accounts your books are kept in',
```

- **One `pin` section for the dialog, the lock screen and the card,** next to `sync` and `devices`, because the
  three use the same words ("PIN", the tries left) and none of them belongs to one page: the dialog opens after the
  set-up, from the card, and after a sign-in. `pin.later` repeats `devices.later` ("Not now") on purpose: each dialog
  keeps its own words, so changing one button never changes the other.
- **The dialog has three titles.** `setUp*` is the first time, and its description says what "Not now" costs (the
  data opens only online). `new*` follows "Forgot PIN?" and a PIN that stopped working: the old PIN does not work, so
  the dialog does not ask for it. `changeTitle` is from the card while a PIN works; then the dialog also asks for the
  `current` PIN (decision 16: the data key can be wrapped again only with a key that opens it).
- **`hint` says the PIN stays on this device.** People reuse their bank card's PIN; knowing it is never sent anywhere
  matters to them, and so does knowing that another computer needs its own PIN.
- **`saving` exists because setting a PIN takes time.** 600,000 rounds of PBKDF2 take up to a second on a cheap phone
  (decision 15). Without a word on the button, a person taps it again.
- **`wrong_one` and `wrong_other`** say how many tries are left, and what happens after them. `formatted` is the
  count in the page's language; `count` picks the plural (both the same in Bangla, which has no plural here).
  `blocked` and the card's `blockedBody` take `max`, the limit (`MAX_WRONG_PINS`), as a parameter instead of a "5" in
  the text, so the number lives in one place.
- **`lock` is the lock screen** (decision 7). `title` is the same for every reason; the three descriptions are
  decision 32. `forgot` is a link that names what happens (the password sign-in), not only "Forgot PIN?". Offline,
  that sign-in cannot work, so `forgotOffline` is a sentence instead of a link. Once the PIN stopped working, the PIN
  field is gone and `signIn` is the screen's primary button; offline, `blockedOffline` replaces it and adds that the
  work stays on the device, because the person's first fear is that it is lost.
- **`card` is the Sync page's "Device PIN" card** (decision 5): one pill and one sentence per state, as CLAUDE.md asks
  of every status. `offBody` says what to do before it matters: set a PIN before going where there is no signal.
  `blocked` is a state of its own, not "No PIN": the person did not choose it, and the sentence says why it happened.

```diff
@@ -5544,6 +5624,10 @@ export const en = {
     unexpected_response:
       "The server sent a reply this version of the app can't read. Reload the page.",
     unknown_error: 'Something went wrong. Try again in a moment.',
+    // Step 19b: the PIN form (decision 29)
+    pin_format: 'Use exactly 6 digits.',
+    pin_too_easy: 'Pick a PIN that is harder to guess than 123456 or 000000.',
+    pin_mismatch: 'The two PINs are different. Type the same 6 digits in both boxes.',
   } satisfies Record<ErrorCode, string>,
   ui: {
     dataTable: {
```

- **The three codes' texts say how to fix the PIN** (CLAUDE.md → Copy). `pin_too_easy` names two examples of what
  is refused rather than the rule, which is easier to read at a counter.

### `locales/bn.ts`

```diff
@@ -50,6 +50,8 @@ export const bn: Messages = {
       macStep2: 'Add-এ ক্লিক করুন।',
     },
     installed: 'Omnivo ইনস্টল হয়েছে',
+    lockNow: 'এখনই লক করুন',
+    setPinToLock: 'লক করতে PIN সেট করুন',
   },
   nav: {
     overview: 'সারসংক্ষেপ',
@@ -133,6 +135,10 @@ export const bn: Messages = {
       offlineNotice: 'আপনি অফলাইনে। সাইন ইন করতে ইন্টারনেট সংযোগ লাগবে।',
       sessionEnded:
         'অফলাইনে থাকার সময় আপনি সাইন আউট হয়ে গেছেন। আবার সাইন ইন করুন: তারপর এই ডিভাইসে সেভ করা পরিবর্তনগুলো পাঠানো হবে।',
+      pinNotice:
+        'এই ডিভাইসে আপনার কাজ খুলতে পাসওয়ার্ড দিয়ে সাইন ইন করুন। তারপর নতুন PIN সেট করবেন।',
+      noPinNotice:
+        'এই ডিভাইসে কোনো PIN নেই, তাই এর ডেটা শুধু ইন্টারনেট সংযোগ থাকলে খোলে। সাইন ইন করতে ইন্টারনেটে যুক্ত হন।',
       panelLabel: 'Omnivo কী করে',
       panelTitle: 'উৎপাদন, স্টক আর হিসাব। এক সিস্টেমে।',
       panelBody:
@@ -544,6 +550,8 @@ export const bn: Messages = {
     blockedFormNotice:
       'এই ডিভাইস শেষ সিঙ্ক হয়েছে {{days}} দিনেরও আগে, তাই অফলাইনে নতুন কাজ সেভ করা যাবে না। এটা সেভ করতে ইন্টারনেটে যুক্ত হন।',
     openedOffline: 'Omnivo ইন্টারনেট সংযোগ ছাড়া খুলেছে। সংযোগ ফিরলে আপনার সাইন ইন যাচাই করা হবে।',
+    copyRemade:
+      'PIN ছাড়া এই ডিভাইসের ডেটা খোলা যায়নি, তাই Omnivo সার্ভার থেকে আবার কপি করেছে। যে পরিবর্তনগুলো সিঙ্ক হয়নি সেগুলো হারিয়ে গেছে।',
     storage: {
       title: 'এই ডিভাইসের স্টোরেজ',
       subtitle: 'ডেটার কপি, অপেক্ষায় থাকা পরিবর্তন আর অ্যাপটা নিজে',
@@ -559,6 +567,55 @@ export const bn: Messages = {
       used: '{{used}} ব্যবহার হয়েছে। ব্রাউজার {{quota}} পর্যন্ত দেয়।',
     },
   },
+  pin: {
+    setUpTitle: 'এই ডিভাইসের জন্য একটা PIN সেট করুন',
+    setUpDescription:
+      'ইন্টারনেট সংযোগ ছাড়া, বা লক করার পরে, এই ডিভাইসে আপনার কাজ খুলতে এটা লিখবেন। PIN না থাকলে এই ডিভাইসের ডেটা শুধু অনলাইনে খোলে।',
+    newTitle: 'নতুন PIN সেট করুন',
+    newDescription: 'আগের PIN আর কাজ করে না। এই ডিভাইসের জন্য নতুন একটা বাছুন।',
+    changeTitle: 'এই ডিভাইসের PIN বদলান',
+    current: 'বর্তমান PIN',
+    label: 'PIN',
+    newPin: 'নতুন PIN',
+    repeat: 'PIN-টা আবার লিখুন',
+    hint: '৬টা অঙ্ক। এটা শুধু এই ডিভাইসে কাজ করে, আর কখনো সার্ভারে পাঠানো হয় না।',
+    later: 'এখন না',
+    save: 'PIN সেট করুন',
+    saveChange: 'PIN বদলান',
+    saving: 'PIN সেট হচ্ছে…',
+    set: 'ডিভাইসের PIN সেট হয়েছে',
+    changed: 'ডিভাইসের PIN বদলানো হয়েছে',
+    wrong_one: 'PIN ভুল। আর {{formatted}} বার চেষ্টা করা যাবে, তারপর PIN আর কাজ করবে না।',
+    wrong_other: 'PIN ভুল। আর {{formatted}} বার চেষ্টা করা যাবে, তারপর PIN আর কাজ করবে না।',
+    blocked:
+      'PIN {{max}} বার ভুল হয়েছে, তাই এটা আর কাজ করে না। আপনার কাজ খুলতে পাসওয়ার্ড দিয়ে সাইন ইন করুন।',
+    lock: {
+      title: 'Omnivo লক করা আছে',
+      description: 'আপনার কাজ খুলতে এই ডিভাইসের PIN লিখুন।',
+      offlineDescription: 'আপনি অফলাইনে, তাই আপনার কাজ খুলতে এই ডিভাইসের PIN লাগবে।',
+      keyChangedDescription: 'এই ডিভাইসে সেভ করা কাজ খুলতে একবার PIN লাগবে।',
+      unlock: 'আনলক করুন',
+      unlocking: 'আনলক হচ্ছে…',
+      forgot: 'PIN ভুলে গেছেন? পাসওয়ার্ড দিয়ে সাইন ইন করুন',
+      forgotOffline: 'PIN ভুলে গেছেন? ইন্টারনেটে যুক্ত হয়ে পাসওয়ার্ড দিয়ে সাইন ইন করুন।',
+      signIn: 'পাসওয়ার্ড দিয়ে সাইন ইন করুন',
+      blockedOffline:
+        'PIN {{max}} বার ভুল হয়েছে, তাই এটা আর কাজ করে না। ইন্টারনেটে যুক্ত হয়ে পাসওয়ার্ড দিয়ে সাইন ইন করুন। আপনার কাজ এই ডিভাইসেই থাকবে।',
+    },
+    card: {
+      title: 'ডিভাইসের PIN',
+      subtitle: 'ইন্টারনেট সংযোগ ছাড়া এই ডিভাইসের ডেটা খোলে',
+      on: 'PIN সেট আছে',
+      onBody: 'অফলাইনে খোলার সময়, আর অ্যাকাউন্ট মেনু থেকে লক করার পরে, Omnivo এটা চায়।',
+      off: 'PIN নেই',
+      offBody:
+        'এই ডিভাইসের ডেটা শুধু অনলাইনে খোলে। ইন্টারনেট ছাড়া কাজ করার আগে একটা PIN সেট করুন।',
+      blocked: 'কাজ করছে না',
+      blockedBody: 'PIN {{max}} বার ভুল হয়েছে। অফলাইনে আবার ডেটা খুলতে নতুন একটা সেট করুন।',
+      set: 'PIN সেট করুন',
+      change: 'PIN বদলান',
+    },
+  },
   accounts: {
     title: 'চার্ট অফ অ্যাকাউন্টস',
     description: 'যে গ্রুপ আর অ্যাকাউন্টে আপনার হিসাবের খাতা রাখা হয়',
@@ -5321,6 +5378,9 @@ export const bn: Messages = {
     network_error: 'সার্ভারে পৌঁছানো যায়নি। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।',
     unexpected_response: 'সার্ভারের উত্তর অ্যাপের এই সংস্করণ পড়তে পারেনি। পেজটা রিলোড করুন।',
     unknown_error: 'কিছু একটা সমস্যা হয়েছে। একটু পরে আবার চেষ্টা করুন।',
+    pin_format: 'ঠিক ৬টা অঙ্ক লিখুন।',
+    pin_too_easy: '123456 বা 000000-এর মতো সহজে আন্দাজ করা যায়, এমন PIN না দিয়ে অন্য একটা বাছুন।',
+    pin_mismatch: 'দুটো PIN আলাদা হয়েছে। দুই ঘরেই একই ৬টা অঙ্ক লিখুন।',
   },
   ui: {
     dataTable: {
```

- **The same keys, in the same places,** without the comments: they are in `en.ts`. PIN stays PIN, and the app's
  usual words stay as they are: সিঙ্ক, সাইন ইন, আনলক, অফলাইন (CLAUDE.md → Language).
- **`pin_too_easy` keeps ASCII digits** (`123456`, `000000`): the PIN field always shows ASCII digits, like the money
  input, so the example matches what the person sees in the box. `hint` and `pin_format` write the count in Bangla
  digits (৬টা), because it is a number in a sentence, not something to type.
- **`wrong_one` and `wrong_other` are the same sentence:** Bangla has no plural form here, but i18next still looks
  for both keys, so both are there.

### Check this part

```bash
pnpm --filter @omnivo/contracts typecheck
pnpm --filter @omnivo/contracts test
pnpm --filter @omnivo/contracts test:openapi
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/i18n typecheck
pnpm --filter @omnivo/i18n test
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/ui typecheck
pnpm exec eslint packages/contracts/src/errors.ts packages/i18n/src
pnpm exec prettier --check packages/contracts/src/errors.ts packages/i18n/src/locales
```

Build `@omnivo/contracts` before `@omnivo/i18n`: the locale files read `ErrorCode` from its build. All pass: 293
contract tests and 15 i18n tests (none new: this part adds words, and the type check is their test). The OpenAPI
document does not change, because the error codes are not in it. The app's type check still fails in the twelve files
listed in 19b.1, and nowhere else.

Also checked while writing this part:

- Removing the Bangla `pin.lock.signIn` and `errors.pin_mismatch` fails the i18n type check, naming both as missing
  in `bn.ts`. Removing the English `errors.pin_too_easy` fails it too: `en.ts` no longer covers every `ErrorCode`, and
  `bn.ts` now has a key that `Messages` does not know. All pass again once the lines are back.

## 19b.4 — the app: opening the copy, the lock screen and the PIN

This part makes the app type-check again, on top of the sealed copy of 19b.1, the key's route of 19b.2 and the words
of 19b.3. After it, the copy opens in one of three ways:

- **Online, with a checked sign-in:** the app asks the server for the device's key (`GET /sync/devices/:id/key`),
  opens the data key with it, and the person sees nothing new. Right after the set-up, the PIN dialog asks for a PIN,
  with "Not now".
- **After "Lock now", or after a reload with no connection:** the lock screen takes the place of the whole app and
  asks for the PIN. Five wrong PINs turn it off; "Forgot PIN?" sends the person to sign in with the password.
- **Offline, on a device without a PIN:** the copy does not open, and the sign-in page says why.

The tests for all of this (app unit tests, the MSW handler for the key's route, Playwright) are 19b.5. This part is
checked by the type checker, the linter, the build and the bundle budgets.

### `lib/remembered-session.ts`: "Lock now" survives a reload

```diff
@@ -76,3 +76,34 @@ export function clearSignOutPending(): void {
     // Nothing to clear in a storage that cannot be read
   }
 }
+
+// Step 19b (decision 6): "Lock now" is kept here, so a reload (online too) opens the lock screen.
+// One value for the whole browser: whoever signs in next does it with the password, which ends
+// the lock anyway. Only two things remove it: the right PIN (local-session.ts) and a sign-in with
+// the password (session.ts). A sign-out keeps it: another tab that sees it go would open its copy.
+export const LOCKED_KEY = 'omnivo.locked';
+
+export function markLocked(): void {
+  try {
+    storage()?.setItem(LOCKED_KEY, '1');
+  } catch {
+    // The storage refused: the lock still holds in this page, but not after a reload
+  }
+}
+
+export function clearLocked(): void {
+  try {
+    storage()?.removeItem(LOCKED_KEY);
+  } catch {
+    // Nothing to clear in a storage that cannot be read
+  }
+}
+
+export function isLocked(): boolean {
+  try {
+    const saved = storage()?.getItem(LOCKED_KEY);
+    return saved !== null && saved !== undefined;
+  } catch {
+    return false;
+  }
+}
```

- **localStorage, next to the remembered `me`,** because the first page load must know about the lock before the
  device's database (Dexie) is loaded: the frame draws the lock screen at once instead of the shell (decision 38).
- **One key for the whole browser, removed only by the right PIN or the password** (decision 36). The comment says
  why a sign-out keeps it: other tabs listen for its removal and open their copies again.
- **Every call is wrapped in `try`,** like the rest of the file: localStorage can throw in a sandboxed frame or with
  storage turned off. `isLocked()` answers `false` then, and the session's own `locked` flag holds the lock for the
  page (local-session.ts).

### `lib/session-store.ts`: two more reasons for the sign-in page

```diff
@@ -7,7 +7,10 @@ import { forgetMe, rememberMe } from './remembered-session';
 // Step 18c: why the sign-in page is showing, when the person did not sign out themself: this
 // device was revoked (its data was deleted), or (step 19a) the server refused the sign-in once the
 // connection was back after an offline opening (the data stays).
-export type SignOutNotice = 'device_revoked' | 'session_ended';
+// Step 19b: 'pin_reset' = "Forgot PIN?", or a PIN that stopped working, on the lock screen: the
+// password opens the copy again (the data stays). 'no_pin' = a reload with no connection on a
+// device without a PIN: its copy opens only online (decision 5).
+export type SignOutNotice = 'device_revoked' | 'session_ended' | 'pin_reset' | 'no_pin';
 
 interface SessionState {
   // unknown = অ্যাপ সবে খুলেছে, refresh cookie দিয়ে session ফেরানো এখনো শেষ হয়নি
@@ -53,8 +56,10 @@ export const sessionStore = createStore<SessionState>()((set) => ({
   // still on their way get a 401, and api.ts signs out again for each: the notice must stay.
   // Step 19a: every sign-out forgets the remembered `me`: a sign-in the server refused, or one the
   // person ended, never opens offline again.
+  // Step 19b: except 'no_pin', which is no sign-out: the server still has the sign-in. Keeping `me`
+  // keeps the notice at the next reload with no connection too, instead of the plain one.
   signOut: (notice) => {
-    forgetMe();
+    if (notice !== 'no_pin') forgetMe();
     set((state) => ({
       status: 'signed-out',
       accessToken: null,
```

- **`pin_reset`** is "Forgot PIN?" and a PIN that stopped working: the sign-in page shows `auth.login.pinNotice`
  (decision 31). **`no_pin`** is an offline reload on a device without a PIN (decision 43).
- **`no_pin` keeps the remembered `me`.** It is the one notice that is not a sign-out: the server still has the
  sign-in, and the next offline reload should say the same thing. Every other sign-out forgets `me`, as in 19a.

### `lib/session.ts`: the password ends the lock, and "Forgot PIN?" ends the sign-in

```diff
@@ -12,8 +12,13 @@ import {
 import { call, isNoAnswer, refreshSession } from './api';
 import { applyPreferences } from './preferences';
 import { queryClient } from './query-client';
-import { clearSignOutPending, markSignOutPending, signOutPending } from './remembered-session';
-import { sessionStore } from './session-store';
+import {
+  clearLocked,
+  clearSignOutPending,
+  markSignOutPending,
+  signOutPending,
+} from './remembered-session';
+import { type SignOutNotice, sessionStore } from './session-store';
 
 async function startSession(session: AuthSession): Promise<void> {
   sessionStore.getState().setAccessToken(session.accessToken);
@@ -55,7 +60,15 @@ export function restoreSession(): Promise<void> {
       // সেখানে চেষ্টা করলে network_error-এর লেখা দেখাবে।
       // Step 19a (decision 2): no answer, and this browser remembers the last person and their copy:
       // the app opens as that person. import(): only such a reload loads the code.
-      if (isNoAnswer(error) && (await openOffline())) return;
+      // Step 19b: a copy without a PIN does not open (decision 5); the sign-in page says why.
+      if (isNoAnswer(error)) {
+        const opened = await openOffline();
+        if (opened === 'opened') return;
+        if (opened === 'no-pin') {
+          sessionStore.getState().signOut('no_pin');
+          return;
+        }
+      }
     }
     sessionStore.getState().signOut();
   })();
@@ -63,12 +76,12 @@ export function restoreSession(): Promise<void> {
 }
 
 // A failure to load the chunk (no worker yet, and no connection) is the sign-in page, as before
-async function openOffline(): Promise<boolean> {
+async function openOffline(): Promise<'opened' | 'no-pin' | 'none'> {
   try {
     const offline = await import('./offline-session');
     return await offline.openOffline();
   } catch {
-    return false;
+    return 'none';
   }
 }
 
@@ -85,9 +98,13 @@ async function sendPendingSignOut(): Promise<void> {
 
 // Step 19a: a sign-out still waiting goes before the new sign-in. After it, the new cookie takes
 // the old one's place in the browser, and the old session could not be ended from here any more.
+// Step 19b: the password proves the person as well as the PIN does, so it ends "Lock now". Not in
+// startSession: a reload's refresh proves nothing, and must keep the lock screen.
 async function signInWith(request: () => Promise<AuthSession>): Promise<void> {
   if (signOutPending()) await sendPendingSignOut();
-  await startSession(await request());
+  const session = await request();
+  clearLocked();
+  await startSession(session);
 }
 
 export function login(input: LoginInput): Promise<void> {
@@ -108,19 +125,33 @@ export async function switchTenant(tenantId: string): Promise<void> {
   await startSession(await call(authRoutes.switchTenant, { body: { tenantId } }));
 }
 
-export async function logout(): Promise<void> {
-  const me = sessionStore.getState().me;
+// Step 19a: no connection. The person is signed out here at once; the server hears of it at the
+// next reload or sign-in, and until then the cookie is never refreshed. A refusal is an answer:
+// there was no session left to end.
+async function endSession(notice?: SignOutNotice): Promise<void> {
   try {
     await call(authRoutes.logout);
   } catch (error) {
-    // Step 19a: no connection. The person is signed out here at once (below); the server hears of
-    // it at the next reload or sign-in, and until then the cookie is never refreshed. A refusal
-    // is an answer: there was no session left to end.
     if (isNoAnswer(error)) markSignOutPending();
   } finally {
     // নেটওয়ার্ক ব্যর্থ হলেও এই ট্যাবে লগআউট দেখাতে হবে, আর আগের ইউজারের ক্যাশ মুছতে হবে
     queryClient.clear();
-    sessionStore.getState().signOut();
+    sessionStore.getState().signOut(notice);
+  }
+}
+
+// Step 19b (decision 31): "Forgot PIN?" and a PIN that stopped working. The person is sent to prove
+// themself with the password, so the sign-in ends on the server too: a cookie still valid would
+// let the next reload in without it. The copy stays: the password opens it with the server's key.
+export function signInAgain(): Promise<void> {
+  return endSession('pin_reset');
+}
+
+export async function logout(): Promise<void> {
+  const me = sessionStore.getState().me;
+  try {
+    await endSession();
+  } finally {
     // Step 18a: the copy of the workspace's data on this device goes too (decision 41). import():
     // local-session brings Dexie, which the first page load must not carry. A browser that refuses
     // to delete it changes nothing for the sign-out.
```

- **`openOffline` now has three answers.** `'no-pin'` signs out with the `no_pin` notice; `'none'` (no remembered
  person, no copy, or the chunk did not load) is the plain sign-in page, as in 19a.
- **`clearLocked()` in `signInWith`, after the request answered,** not before: a wrong password must not unlock
  anything. Not in `startSession` either, which a reload's cookie refresh also runs: a refresh proves nothing about
  who is at the screen, so "Lock now" must survive it (decision 6).
- **`endSession`** is the old body of `logout` without deleting the copy, so `logout` and `signInAgain` share it.
  `logout` still deletes the copy in its `finally`, as before.
- **`signInAgain` ends the sign-in on the server too** (decision 35). The person was sent to prove themself with the
  password; a cookie left valid would let the next reload in without it. With no connection, `markSignOutPending`
  makes sure the server hears of it later, as for any sign-out offline (19a). The lock screen offers it online only.

### `lib/offline-session.ts`: only a copy the PIN can open

```diff
@@ -1,5 +1,5 @@
 import { authRoutes, type MeResponse } from '@omnivo/contracts';
-import { readDevice } from '@omnivo/sync';
+import { databaseName, keyStatus, readDevice, SyncDatabase } from '@omnivo/sync';
 
 import { call, refreshSession, setOfflineCheck } from './api';
 import { applyPreferences } from './preferences';
@@ -19,15 +19,32 @@ function hasCopy(me: MeResponse): boolean {
   return readDevice(storage(), me.tenant.id, me.user.id).branchId !== null;
 }
 
-export async function openOffline(): Promise<boolean> {
+// Step 19b (decision 5): and only a copy the PIN can open, or one whose PIN stopped working (the
+// lock screen then says to sign in when online). With no PIN, nothing here could open it. This
+// brings Dexie into this chunk, which only an offline reload loads. A database the browser
+// refuses is no copy.
+async function hasPin(me: MeResponse): Promise<boolean> {
+  const db = new SyncDatabase(databaseName(me.tenant.id, me.user.id));
+  try {
+    const status = await keyStatus(db);
+    return status.hasPin || status.pinBlocked;
+  } catch {
+    return false;
+  } finally {
+    db.close();
+  }
+}
+
+export async function openOffline(): Promise<'opened' | 'no-pin' | 'none'> {
   const me = rememberedMe();
-  if (!me || !hasCopy(me)) return false;
+  if (!me || !hasCopy(me)) return 'none';
+  if (!(await hasPin(me))) return 'no-pin';
   // The person's theme and language, as after an online sign-in. The Bangla words are a chunk of
   // their own; the worker keeps it. Failing to load them only leaves the page in English.
   await applyPreferences(me.preferences).catch(() => undefined);
   sessionStore.getState().openOffline(me);
   watchForServer();
-  return true;
+  return 'opened';
 }
 
 // Read again after each await: a sign-out may end the offline opening at any of them
```

- **`hasPin` opens the device's database for one read and closes it.** The answer is in the key's row, and nothing
  outside the database knows it. Opening it there also runs 19b.1's version 3 upgrade on a device updated while
  offline, which would happen at the next opening anyway.
- **A PIN that stopped working still opens to the lock screen.** It says what to do (decision 3: sign in when the
  connection is back) and that the work stays on the device. The sign-in page could say neither offline.
- **Any error is "no PIN".** A browser that refuses IndexedDB has no copy to open.
- **This brings Dexie into this chunk.** The chunk loads only after an offline reload, from the worker's cache, so
  the first page load of every other visit does not change.

### `lib/pin.ts` (new): the PIN's rules

```ts
import { errorCode } from '@omnivo/contracts';
import { isPin, PIN_LENGTH } from '@omnivo/sync';
import { z } from 'zod';

// Step 19b: the device PIN's rules, for the lock screen and the PIN dialog. The PIN never leaves
// the device, so no contract has a schema for it: the rules live here, and their messages are the
// codes 19b.3 added to ERROR_CODES.

const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';

// What a PIN box keeps of what was typed: ASCII digits, at most six. A Bangla keyboard types
// Bangla digits, which become ASCII ones (the money input's rule); anything else (a space, a
// letter typed by mistake) is dropped as it is typed, so the box never holds what isPin refuses.
export function pinDigits(raw: string): string {
  return raw
    .replace(/[০-৯]/g, (digit) => String(BANGLA_DIGITS.indexOf(digit)))
    .replace(/[^0-9]/g, '')
    .slice(0, PIN_LENGTH);
}

// Decision 30: six of the same digit (000000), or a straight run up or down (123456, 987654).
// A run that wraps (890123) is not refused: nobody guesses it first.
export function isEasyPin(pin: string): boolean {
  // Six ASCII digits (isPin ran first), so the characters are the digits
  const digits = Array.from({ length: pin.length }, (_, index) => Number(pin.charAt(index)));
  const steps = digits.slice(1).map((digit, index) => digit - (digits[index] ?? digit));
  const [first = 0] = steps;
  return Math.abs(first) <= 1 && steps.every((step) => step === first);
}

const pinSchema = z.string().refine(isPin, errorCode('pin_format'));

// The lock screen checks the format only: a PIN set before is never "too easy" to type
export const unlockFormSchema = z.object({ pin: pinSchema });

const newPinSchema = pinSchema.refine((pin) => !isEasyPin(pin), errorCode('pin_too_easy'));

// The dialog. A new PIN on a device without one (or after "Forgot PIN?") is set with the server's
// key, online; a change needs the current PIN (decision 16), checked by the device, not here.
export function pinFormSchema(change: boolean) {
  return z
    .object({
      current: change ? pinSchema : z.literal(''),
      pin: newPinSchema,
      repeat: z.string(),
    })
    .refine((values) => values.pin === values.repeat, {
      error: errorCode('pin_mismatch'),
      path: ['repeat'],
    });
}
```

- **`pinDigits` runs on every key press** (pin-field.tsx), so the box never holds anything but ASCII digits. Bangla
  digits are turned into ASCII ones with the same table as the money input. The box is masked, so the person never
  sees the change; they only see that a Bangla keyboard works.
- **`isEasyPin` compares each digit with the one before it.** All the steps equal and between -1 and 1 means six of
  the same digit (step 0) or a straight run up or down (step 1 or -1). `Array.from` with `charAt` instead of
  `[...pin]`: the linter refuses spreading a string (it splits some characters wrongly), and a PIN is six ASCII digits
  by now.
- **`unlockFormSchema` checks only the format.** A PIN set before this rule existed, or by another version, must
  still unlock.
- **`pinFormSchema(change)`** is one schema with the same fields for the three dialogs, so `useForm` has one type.
  `current` must be a PIN only for a change; for a new PIN the dialog sends `''`, which tells the session to use the
  server's key. The mismatch is checked on the whole object and reported on `repeat`, the box to fix.

### `lib/local-data.ts`: the open copy, the locked state and the PIN dialog

```diff
@@ -1,9 +1,12 @@
 import type { Branch, DeviceListItem, MoveDeviceInput } from '@omnivo/contracts';
 import {
   customerCommands,
+  type KeyProblem,
+  type KeyStatus,
+  type LocalCopy,
+  type PullState,
   readPullState,
   STORAGE_FAILED,
-  type SyncDatabase,
   type SyncEngine,
   type SyncStatus,
   type Watch,
@@ -19,6 +22,25 @@ import { useOnline } from './use-online';
 // every sales form, and Dexie is 30 KB gz. The code that opens the database (local-session.ts)
 // is loaded once, lazily, by the AppShell, and puts the database, the engine and Dexie's
 // liveQuery (`watch`) into this store.
+// Step 19b: the open copy (LocalCopy: the database and its key) instead of the database.
+
+// Why the lock screen shows (decision 32): "Lock now"; a reload with no checked sign-in (offline);
+// or the server's key no longer opens the copy, and the PIN must open it once.
+export type LockReason = 'locked' | 'offline' | 'key-changed';
+
+// What typing a PIN on the lock screen answers. The problems are the key's own (keys.ts).
+export type UnlockAnswer = { kind: 'open' } | KeyProblem;
+
+// What the PIN dialog saves: `current` = '' sets a PIN with the server's key (online), else it is
+// the current PIN, for a change
+export interface PinSave {
+  current: string;
+  pin: string;
+}
+
+// set-up = after the device is set up (or a forgotten PIN); new = the PIN stopped working;
+// change = the Sync page's card or the account menu, with a PIN set
+export type PinDialogKind = 'set-up' | 'new' | 'change';
 
 export type DeviceState =
   | { kind: 'starting' }
@@ -29,7 +51,18 @@ export type DeviceState =
   | { kind: 'unreachable' }
   | { kind: 'storage-failed' }
   | { kind: 'revoked' }
-  | { kind: 'ready'; db: SyncDatabase; engine: SyncEngine; watch: Watch };
+  // Step 19b: the copy is there but closed: the lock screen asks for the PIN. `waiting` = the
+  // changes on the device, for the sign-out question; `forgetPin` = the first step of "Forgot PIN?"
+  // and of a PIN that stopped working (the lock screen then ends the sign-in, session.ts).
+  | {
+      kind: 'locked';
+      reason: LockReason;
+      status: KeyStatus;
+      waiting: number;
+      unlock: (pin: string) => Promise<UnlockAnswer>;
+      forgetPin: () => Promise<void>;
+    }
+  | { kind: 'ready'; copy: LocalCopy; engine: SyncEngine; watch: Watch };
 
 // Step 18c: what moving this device answers. 'waiting' = its outbox is not empty (decision 2): the
 // dialog checked, but a save in another tab may have come in between.
```

- **No Dexie, as before** (18a): every import from `@omnivo/sync` here is a type, or a function that does not load
  Dexie. `KeyStatus` and `KeyProblem` are types only, so `keys.ts` is not in this module's chunk (decision 44).
- **`LockReason`** is decision 32's three descriptions. **`UnlockAnswer`** is what the lock screen's Unlock returns:
  `open`, or the key's own problem, so the screen can say how many tries are left.
- **`PinSave.current` is `''` for a new PIN.** One function for the three dialogs; the session reads the empty string
  as "use the server's key" (local-session.ts → `savePin`).
- **The `locked` state carries its own `unlock` and `forgetPin`,** like 18c's `moveHere`: the functions belong to
  this one lock (its database, its reason, its server key for `key-changed`), and a new lock replaces them.
- **`ready` holds the `LocalCopy`** instead of the database: every read of a sealed row needs its key (19b.1).

```diff
@@ -49,6 +82,17 @@ interface LocalDataState {
   moveHere: (input: MoveDeviceInput) => Promise<MoveResult>;
   // After this device was revoked from its own list: delete the copy, then sign out
   revokedHere: () => Promise<void>;
+  // Step 19b: the PIN dialog that is open, if any; the session opens it after set-up
+  pinDialog: PinDialogKind | null;
+  // Step 19b: the open copy's PIN, for the Sync page's card and the account menu. Set by the
+  // session from a live read of the key's row, like the sidebar's numbers (sync-summary.ts): a page
+  // that read it itself would bring keys.ts and Web Crypto's wrapping into every page's chunk.
+  // null while no copy is open.
+  keys: KeyStatus | null;
+  savePin: (save: PinSave) => Promise<{ kind: 'set' } | KeyProblem>;
+  // Closing the dialog. After set-up, any way of closing it is "Not now", like the branch dialog.
+  closePin: () => void;
+  lockNow: () => void;
 }
 
 const noSession = () => Promise.reject(new Error('No device session'));
@@ -60,6 +104,11 @@ export const localDataStore = createStore<LocalDataState>()(() => ({
   deviceId: null,
   moveHere: noSession,
   revokedHere: noSession,
+  pinDialog: null,
+  keys: null,
+  savePin: noSession,
+  closePin: () => undefined,
+  lockNow: () => undefined,
 }));
 
 export function useThisDeviceId(): string | null {
@@ -74,6 +123,15 @@ export function retryLocalData(): void {
   localDataStore.getState().retry();
 }
 
+// Step 19b: the Sync page's card and the account menu
+export function askForPin(kind: PinDialogKind): void {
+  localDataStore.setState({ pinDialog: kind });
+}
+
+export function lockNow(): void {
+  localDataStore.getState().lockNow();
+}
+
 export function useDeviceState(): DeviceState {
   return useStore(localDataStore, (state) => state.device);
 }
```

- **`pinDialog`, `keys`, `savePin`, `closePin` and `lockNow`** are set by the session like `retry` and `moveHere`, so
  the pages and the frame never import the code that loads Dexie. Before a session starts they do nothing (`noSession`
  rejects, the others do nothing).
- **`keys` is filled by the session's watch** (decision 44), the way 18b's sidebar numbers are.
- **`askForPin` and `lockNow`** are what the Sync page's card and the account menu call.

```diff
@@ -84,17 +142,17 @@ export function requestSync(): void {
   if (device.kind === 'ready') device.engine.request();
 }
 
-// The device's database, when it has one open: the outbox is in it
-export function useLocalDb(): SyncDatabase | null {
+// The device's copy, when it has one open: the outbox is in it
+export function useLocalCopy(): LocalCopy | null {
   const device = useDeviceState();
-  return device.kind === 'ready' ? device.db : null;
+  return device.kind === 'ready' ? device.copy : null;
 }
 
 // A read of the copy that runs again by itself when a pull changes what it read. `query` must be
 // stable (useCallback): a new function is a new read. null = nothing to read (the archived tab).
 // While a new read runs, the last answer stays, so a list does not flash empty on each key press.
 // undefined until the first answer, and while the device has no open copy.
-export function useLocalQuery<T>(query: ((db: SyncDatabase) => Promise<T>) | null): T | undefined {
+export function useLocalQuery<T>(query: ((copy: LocalCopy) => Promise<T>) | null): T | undefined {
   const device = useDeviceState();
   const ready = device.kind === 'ready' ? device : null;
   // The answer keeps the device it came from: another workspace's copy is never shown
@@ -102,7 +160,7 @@ export function useLocalQuery<T>(query: ((db: SyncDatabase) => Promise<T>) | nul
   useEffect(() => {
     if (!ready || !query) return;
     return ready.watch(
-      () => query(ready.db),
+      () => query(ready.copy),
       (value) => {
         setAnswer({ from: ready, value });
       },
@@ -113,10 +171,20 @@ export function useLocalQuery<T>(query: ((db: SyncDatabase) => Promise<T>) | nul
   return ready && query && answer?.from === ready ? answer.value : undefined;
 }
 
+// Step 19b: the pull's state is not sealed, but useLocalQuery reads the copy. Module-level, so it is
+// stable.
+export function readPull(copy: LocalCopy): Promise<PullState> {
+  return readPullState(copy.db);
+}
+
+export function useKeyStatus(): KeyStatus | null {
+  return useStore(localDataStore, (state) => state.keys);
+}
+
 export type LocalView =
   | { kind: 'loading' }
   // The device has a complete copy (one pull finished), so lists read it, online or not
-  | { kind: 'ready'; db: SyncDatabase }
+  | { kind: 'ready'; copy: LocalCopy }
   | { kind: 'not-set-up' }
   | { kind: 'first-pull'; copied: number }
   | { kind: 'first-pull-failed' }
@@ -149,7 +217,7 @@ export function useLocalData(): { view: LocalView; notice: string | null } {
   const online = useOnline();
   const status = useSyncStatus();
   // Live: the first pull's count and its end show here as the pages arrive
-  const pull = useLocalQuery(readPullState);
+  const pull = useLocalQuery(readPull);
   const notice = status.problem !== null && NOTICES.has(status.problem) ? status.problem : null;
   return { view: viewOf(device, status, pull?.lastSyncAt, pull?.copied ?? 0, online), notice };
 }
@@ -169,11 +237,14 @@ function viewOf(
     case 'storage-failed':
     case 'revoked':
       return { kind: device.kind };
+    // Step 19b: the AppShell shows the lock screen instead of the pages, so this is for a moment
+    case 'locked':
+      return { kind: 'loading' };
     case 'unreachable':
       return online ? { kind: 'first-pull-failed' } : { kind: 'offline-empty' };
     case 'ready':
       if (lastSyncAt === undefined) return { kind: 'loading' };
-      if (lastSyncAt !== null) return { kind: 'ready', db: device.db };
+      if (lastSyncAt !== null) return { kind: 'ready', copy: device.copy };
       if (status.problem === STORAGE_FAILED) return { kind: 'storage-failed' };
       if (status.problem === null) return { kind: 'first-pull', copied };
       return online ? { kind: 'first-pull-failed' } : { kind: 'offline-empty' };
@@ -188,15 +259,15 @@ export type SaveMode = 'api' | 'device';
 
 export function useSaveMode(customerId: string): SaveMode | undefined {
   const online = useOnline();
-  const db = useLocalDb();
+  const copy = useLocalCopy();
   const read = useCallback(
-    (database: SyncDatabase) =>
-      customerId === '' ? Promise.resolve([]) : customerCommands(database, customerId),
+    (open: LocalCopy) =>
+      customerId === '' ? Promise.resolve([]) : customerCommands(open, customerId),
     [customerId],
   );
-  const commands = useLocalQuery(db ? read : null);
+  const commands = useLocalQuery(copy ? read : null);
   if (!online) return 'device';
-  if (!db) return 'api';
+  if (!copy) return 'api';
   if (commands === undefined) return undefined;
   return commands.length > 0 ? 'device' : 'api';
 }
```

- **`useLocalCopy` replaces `useLocalDb`,** and `useLocalQuery`'s read takes the copy. The pages change only their
  parameter's type and name (below).
- **`readPull` wraps `readPullState`:** the pull's state is not sealed and takes the database, but `useLocalQuery` now
  hands its reads the copy. It is a module-level function, so it is the same function on every render, as
  `useLocalQuery` needs.
- **`locked` shows as `loading` in a page's view.** The frame draws the lock screen instead of the pages, so a page
  never sees it for more than a moment.

### `lib/local-session.ts`: how the copy opens

This file is the device's session (18a). The first changes are the new imports, the session's `locked` flag, and the
lock and sign-in followers:

```diff
@@ -1,4 +1,4 @@
-import { type Device, type MoveDeviceInput, routes } from '@omnivo/contracts';
+import { type Device, type DeviceKey, type MoveDeviceInput, routes } from '@omnivo/contracts';
 import { formatNumber, i18n, isLanguage } from '@omnivo/i18n';
 import {
   allRows,
@@ -9,25 +9,42 @@ import {
   deviceNameParts,
   deviceStorageKey,
   forgetDevice,
+  forgetPin,
+  type KeyProblem,
+  type KeyRecord,
+  keyStatus,
+  LocalCopy,
   localCustomer,
   lookUpPrices,
+  markPinAsked,
   newDeviceId,
+  openKey,
   outboxCounts,
   type PushOutcome,
   readDevice,
   readPullState,
+  renewServerKey,
   saveDevice,
+  setPin,
   SyncDatabase,
   SyncEngine,
   syncedAtOf,
+  type Unlock,
   watch,
 } from '@omnivo/sync';
 import { toast } from '@omnivo/ui';
 
 import { ApiRequestError, call, onApiWrite, refreshSession } from './api';
 import { setDeviceReads } from './device-reads';
-import { localDataStore, type MoveResult } from './local-data';
+import {
+  type LockReason,
+  localDataStore,
+  type MoveResult,
+  type PinSave,
+  type UnlockAnswer,
+} from './local-data';
 import { queryClient } from './query-client';
+import { clearLocked, isLocked, LOCKED_KEY, markLocked } from './remembered-session';
 import { sessionStore } from './session-store';
 import { askToKeep } from './storage';
 import { NO_SUMMARY, syncSummaryStore } from './sync-summary';
@@ -62,6 +79,16 @@ interface Session {
   cleanup: (() => void)[];
   // Step 18c: stops following the other tabs; only when the session ends, not with the copy
   unfollow: () => void;
+  // Step 19b: "Lock now" in this tab. The flag in localStorage says the same for the next reload and
+  // the other tabs, but a storage that refuses must not leave the copy open here.
+  locked: boolean;
+}
+
+// Step 19b: one opening of the database. runCleanup ends it (a lock, a move, a retry, the end of the
+// session), and every step after an await checks it, so an ended opening never changes the screen.
+interface Opening {
+  db: SyncDatabase;
+  live: boolean;
 }
 
 let current: Session | null = null;
@@ -81,6 +108,11 @@ function hasEnded(session: Session): boolean {
   return session.stopped;
 }
 
+// Step 19b: the same for an opening, read again after each await
+function closed(opening: Opening): boolean {
+  return !opening.live;
+}
+
 function runCleanup(session: Session): void {
   for (const undo of session.cleanup.splice(0)) undo();
 }
@@ -93,9 +125,15 @@ export function startLocalData(input: { tenantId: string; userId: string }): ()
     stopped: false,
     cleanup: [],
     unfollow: () => undefined,
+    locked: false,
   };
   current = session;
-  session.unfollow = followOtherTabs(session);
+  const unfollowTabs = followOtherTabs(session);
+  const unfollowSignIn = followSignIn(session);
+  session.unfollow = () => {
+    unfollowTabs();
+    unfollowSignIn();
+  };
   // Saved before the first registration: if its answer is lost, the next try sends the same id
   // and the server returns the same device (decision 20)
   remember(session, session.identity);
@@ -107,6 +145,12 @@ export function startLocalData(input: { tenantId: string; userId: string }): ()
     },
     moveHere: (input) => moveHere(session, input),
     revokedHere: () => revoke(session),
+    pinDialog: null,
+    savePin: (save) => savePin(session, save),
+    closePin,
+    lockNow: () => {
+      lockNow(session);
+    },
   });
   void setUp(session);
   return () => {
@@ -126,6 +170,11 @@ export function stopLocalData(): void {
     deviceId: null,
     moveHere: ended,
     revokedHere: ended,
+    pinDialog: null,
+    keys: null,
+    savePin: ended,
+    closePin: () => undefined,
+    lockNow: () => undefined,
   });
   syncSummaryStore.setState(NO_SUMMARY);
 }
@@ -138,7 +187,12 @@ export function stopLocalData(): void {
 function followOtherTabs(session: Session): () => void {
   const key = deviceStorageKey(session.tenantId, session.userId);
   const changed = (event: StorageEvent) => {
-    if (event.key !== key || session.stopped) return;
+    if (session.stopped) return;
+    if (event.key === LOCKED_KEY) {
+      followLock(session, event.newValue !== null);
+      return;
+    }
+    if (event.key !== key) return;
     // Removed: revoked there. The same steps here (forgetting it again changes nothing).
     if (event.newValue === null) {
       void revoke(session);
@@ -158,6 +212,32 @@ function followOtherTabs(session: Session): () => void {
   };
 }
 
+// Step 19b: "Lock now" in another tab locks this one too. The right PIN there, or a sign-in with the
+// password, opens this one again: with the server's key when this tab's sign-in was checked, else
+// with the PIN typed here.
+function followLock(session: Session, locked: boolean): void {
+  const { device } = localDataStore.getState();
+  if (locked) {
+    if (device.kind === 'ready') reopen(session);
+    return;
+  }
+  session.locked = false;
+  if (device.kind === 'locked' && device.reason === 'locked') reopen(session);
+}
+
+// Step 19b: the connection came back after an offline reload, and the server checked the sign-in
+// (offline-session.ts). A copy still waiting for its PIN then opens with the server's key, as any
+// online opening does (decision 1). Not one the person locked: that one waits for the PIN.
+function followSignIn(session: Session): () => void {
+  return sessionStore.subscribe((state, previous) => {
+    if (!previous.openedOffline || state.openedOffline || state.status !== 'signed-in') return;
+    // Another person signed in meanwhile: the host stops this session and starts theirs
+    if (state.me?.user.id !== session.userId || state.me.tenant.id !== session.tenantId) return;
+    const { device } = localDataStore.getState();
+    if (device.kind === 'locked' && device.reason === 'offline') reopen(session);
+  });
+}
+
 // The copy is the workspace's data: signing out deletes it (decision 41). The device's id stays
 // in localStorage, so the next sign-in is the same device, with a new full pull.
 export async function deleteLocalData(tenantId: string, userId: string): Promise<void> {
```

- **`Opening`** is one opening of the database. Before this step, `open` had one `await` before it registered its
  cleanup, and checked `session.stopped` once. Now an opening waits for the server's key, the PIN and the in-memory
  tables, and a lock, a move or a retry can end it during any of them without ending the session. `closed(opening)`
  is read again after each `await` (a function call, for the same TypeScript reason as 18c's `hasEnded`).
- **`startLocalData` follows two more things:** the lock in other tabs (`followLock`, through the storage event the
  device's identity already uses) and the sign-in check after an offline reload (`followSignIn`). Both stop with the
  session.
- **`followLock`** is decision 40. A lock elsewhere closes a ready copy here; an unlock elsewhere opens a copy that
  this tab locked with "Lock now" again, from the start, which decides how (`openCopy`). It also clears this tab's own
  `locked` flag, or `openCopy` would still see it.
- **`followSignIn`** is decision 41. zustand's `subscribe` gives the state before and after, so it reacts only to
  the moment `openedOffline` turns false with the person signed in. When 19a's check found another person's cookie,
  it does nothing: the host stops this session and starts that person's.

The middle of the file is new: `open`, and everything an opening calls.

```ts
// Step 19b: `keep` = the key's row of the copy a move deleted (moveHere)
async function open(session: Session, keep?: KeyRecord): Promise<void> {
  const db = new SyncDatabase(databaseName(session.tenantId, session.userId));
  try {
    await db.open();
    if (keep) await db.keys.put(keep);
  } catch {
    // A private window that refuses IndexedDB, a full disk
    if (!session.stopped) set({ device: { kind: 'storage-failed' } });
    return;
  }
  if (session.stopped) {
    db.close();
    return;
  }
  // First on the list, so it runs last: what start() adds goes in front of it (unshift)
  const opening: Opening = { db, live: true };
  session.cleanup.push(() => {
    opening.live = false;
    db.close();
  });
  await openCopy(session, opening);
}

// Step 19b: what opens the copy (decision 1). A checked sign-in, not locked: the server's key, and
// no PIN. "Lock now" (decision 6), or an opening with no checked sign-in (an offline reload,
// decision 2): the PIN, on the lock screen.
async function openCopy(session: Session, opening: Opening): Promise<void> {
  const { db } = opening;
  const locked = session.locked || isLocked();
  if (locked || sessionStore.getState().openedOffline) {
    await showLock(session, opening, locked ? 'locked' : 'offline', null);
    return;
  }
  let serverKey: Uint8Array<ArrayBuffer>;
  try {
    serverKey = await fetchServerKey(session);
  } catch (error) {
    if (closed(opening)) return;
    const code = codeOf(error);
    // A revoked device: the 18c steps (the copy goes, then a sign-in check)
    if (code === 'device_revoked') {
      void revoke(session);
      return;
    }
    // registerAgain found the branch archived, and starts the set-up again
    if (code === 'device_branch_invalid') return;
    // No answer (the API is down): the PIN opens it, as offline. Without one, it tries again later.
    const { hasPin } = await keyStatus(db);
    if (hasPin) await showLock(session, opening, 'offline', null);
    else if (!closed(opening)) waitForServer(session);
    return;
  }
  if (closed(opening)) return;
  const opened = await openKey(db, { serverKey });
  if (closed(opening)) return;
  if (opened.kind === 'open') {
    await start(session, opening, opened.key, true);
    return;
  }
  // key-changed, the one problem a server key answers (decision 17): the PIN opens the copy once,
  // and wraps its key for the server's new one. Without a PIN nothing can open it.
  const { hasPin } = await keyStatus(db);
  if (hasPin) await showLock(session, opening, 'key-changed', serverKey);
  else if (!closed(opening)) await remake(session);
}

// Step 19b (19b.2): the device's own key, asked at every online opening and never written anywhere
// (decision 23). A device the server does not know (its database restored to a time before this
// device) registers again, as the engine's pull does, and asks once more.
async function fetchServerKey(session: Session): Promise<Uint8Array<ArrayBuffer>> {
  const request = () => call(routes.sync.deviceKey, { params: { id: session.identity.id } });
  let answer: DeviceKey;
  try {
    answer = await request();
  } catch (error) {
    if (codeOf(error) !== 'device_not_found') throw error;
    await registerAgain(session);
    answer = await request();
  }
  // The contract checked it: 43 base64 characters and one '=', so 32 bytes
  return Uint8Array.from(atob(answer.key), (char) => char.charCodeAt(0));
}

// Step 19b: the lock screen (decision 7). The changes waiting are counted from the fields the
// outbox keeps readable, the legacy outbox too (a device not opened since version 3), so Sign out
// can ask first. Showing it again after a wrong PIN reads the new count of wrong ones.
async function showLock(
  session: Session,
  opening: Opening,
  reason: LockReason,
  serverKey: Uint8Array<ArrayBuffer> | null,
): Promise<void> {
  const { db } = opening;
  const [status, waiting, legacy] = await Promise.all([
    keyStatus(db),
    db.outbox.count(),
    db.legacyOutbox.count(),
  ]);
  if (closed(opening)) return;
  set({
    device: {
      kind: 'locked',
      reason,
      status,
      waiting: waiting + legacy,
      unlock: (pin) => unlock(session, opening, reason, serverKey, pin),
      // Decision 35: the PIN goes (a PIN nobody remembers only helps someone guessing it). The
      // lock screen then ends the sign-in: session.ts imports this module (logout), so this one
      // does not import it back (found by the 19b.5 boundaries check).
      forgetPin: () => forgetPin(db),
    },
    asking: false,
    pinDialog: null,
  });
}

// The lock screen's Unlock. A problem shows the screen again (fewer tries left, or the PIN off)
// and goes back to the field.
async function unlock(
  session: Session,
  opening: Opening,
  reason: LockReason,
  serverKey: Uint8Array<ArrayBuffer> | null,
  pin: string,
): Promise<UnlockAnswer> {
  const { db } = opening;
  const failed = async (problem: KeyProblem): Promise<UnlockAnswer> => {
    await showLock(session, opening, reason, serverKey);
    return problem;
  };
  if (serverKey) {
    // key-changed: the PIN wraps the key for the new server key first, and the server key then
    // opens it (no second PBKDF2, which takes up to a second on a cheap phone)
    const renewed = await renewServerKey(db, pin, serverKey);
    if (renewed.kind !== 'set') return failed(renewed);
  }
  const opened = await openKey(db, serverKey ? { serverKey } : { pin });
  if (opened.kind !== 'open') return failed(opened);
  if (closed(opening)) return { kind: 'open' };
  // The right PIN ends "Lock now", here and (the storage event) in the other tabs
  if (reason === 'locked') {
    session.locked = false;
    clearLocked();
  }
  await start(session, opening, opened.key, false);
  return { kind: 'open' };
}

// Step 19b: the open copy, its engine and the reads the queries use offline. `ask` = opened with
// the server's key, so the PIN dialog may follow (decision 5): no PIN yet, and not asked since the
// last one went. Opened with the PIN, there is one.
async function start(
  session: Session,
  opening: Opening,
  key: CryptoKey,
  ask: boolean,
): Promise<void> {
  const { db } = opening;
  let copy: LocalCopy;
  try {
    copy = await LocalCopy.open(db, key);
  } catch {
    // A row that does not open (changed on the disk), or a read the browser refused
    if (!closed(opening)) set({ device: { kind: 'storage-failed' } });
    return;
  }
  const status = ask ? await keyStatus(db) : null;
  if (closed(opening)) {
    copy.close();
    return;
  }
  // "Lock now" in another tab while this copy was opening: followLock found no open copy to close.
  // No await from here to the 'ready' state, so a later lock finds it open (found by the 19b.5 e2e).
  if (session.locked || isLocked()) {
    copy.close();
    await showLock(session, opening, 'locked', null);
    return;
  }
  const engine = new SyncEngine({
    copy,
    deviceId: session.identity.id,
    pull: (query) => call(routes.sync.pull, { query }),
    push: (body) => call(routes.sync.push, { body }),
    onPushed: (outcome) => {
      if (!session.stopped) pushed(session, outcome);
    },
    codeOf,
    registerAgain: () => registerAgain(session),
    onRevoked: () => {
      void revoke(session);
    },
  });
  // Step 18b: the queries read the copy offline through these (device-reads.ts). The balance is the
  // server's only, so a customer from the device has none.
  setDeviceReads({
    units: () => allRows(copy, db.units),
    taxRates: () => allRows(copy, db.taxRates),
    warehouses: () => allRows(copy, db.warehouses),
    customer: async (customerId) => {
      const local = await localCustomer(copy, customerId);
      return local && { ...local, balance: null };
    },
    hasCommands: async (customerId) => (await customerCommands(copy, customerId)).length > 0,
    settings: async () => (await allRows(copy, db.settings))[0] ?? null,
    prices: async (customerId, items) => {
      const customer = customerId === '' ? null : await localCustomer(copy, customerId);
      return lookUpPrices(copy, customer?.priceListId ?? null, items);
    },
  });
  // In front of the database's close, which open() put on the list
  session.cleanup.unshift(
    // A save on this device: pull its change now (api.ts)
    onApiWrite(() => {
      engine.request();
    }),
    // Step 18b: the sidebar's numbers (sync-summary.ts), live: a save, a push or another tab
    // changes the outbox, and the count follows
    watch(
      () => outboxCounts(copy),
      (counts) => {
        syncSummaryStore.setState({ waiting: counts.total, failed: counts.failed });
      },
      () => undefined,
    ),
    engine.subscribe(() => {
      syncSummaryStore.setState({ syncing: engine.getStatus().syncing });
    }),
    // Step 18c: the time of the last sync, for the limits (sync-summary.ts: useSyncAge)
    watch(
      () => readPullState(db),
      (state) => {
        syncSummaryStore.setState({ syncedAt: syncedAtOf(state) });
      },
      () => undefined,
    ),
    // Step 19b: the PIN, live: a new one or a wrong one, here or in another tab
    watch(
      () => keyStatus(db),
      (keys) => {
        set({ keys });
      },
      () => undefined,
    ),
    // The copy closes (a move, a revoke, a retry from the start): its numbers go with it
    () => {
      syncSummaryStore.setState(NO_SUMMARY);
    },
    () => {
      setDeviceReads(null);
      set({ keys: null });
    },
    () => {
      engine.stop();
    },
    // Step 19b: the key and the opened rows leave memory (decision 20)
    () => {
      copy.close();
    },
  );
  const pinDialog =
    status && !status.hasPin && !status.pinAsked ? (status.pinBlocked ? 'new' : 'set-up') : null;
  set({ device: { kind: 'ready', copy, engine, watch }, asking: false, pinDialog });
  engine.start();
}

// The server does not know this device (its database was restored): the same id and branch again.
// For the engine's pull and for the key's request.
async function registerAgain(session: Session): Promise<void> {
  const { branchId } = session.identity;
  if (branchId === null) return;
  try {
    await registerDevice(session, branchId);
  } catch (error) {
    // The branch was archived while the server did not know the device: forget it and ask
    // again, like a new device
    if (codeOf(error) === 'device_branch_invalid') {
      remember(session, { ...session.identity, branchId: null });
      queueMicrotask(() => {
        runCleanup(session);
        set({ device: { kind: 'starting' } });
        void setUp(session);
      });
    }
    throw error;
  }
}

// Step 19b (decision 17, no PIN): the server's key does not open the copy, and nothing else can. It
// is deleted and pulled again; what had not synced cannot be read any more, and goes with it.
async function remake(session: Session): Promise<void> {
  runCleanup(session);
  await deleteLocalDatabase(session.tenantId, session.userId);
  if (hasEnded(session)) return;
  toast(i18n.t('sync.copyRemade'));
  await open(session);
}

// Step 19b: the copy closes and opens again, which decides afresh how (openCopy)
function reopen(session: Session): void {
  runCleanup(session);
  set({ device: { kind: 'starting' } });
  void open(session);
}

// Step 19b (decision 4): "Lock now". The flag first, so a reload from here on shows the lock screen
// too, and the other tabs lock (followLock). Closing the copy drops its key and its in-memory
// tables; it then opens again only as far as the lock screen.
function lockNow(session: Session): void {
  session.locked = true;
  markLocked();
  reopen(session);
}

// Step 19b: the PIN dialog's save (decision 5). A new PIN is wrapped with the server's key, so it
// needs the connection; a change opens the key with the current PIN, and a wrong one counts as on
// the lock screen (keys.ts). The API's errors (no connection) go to the dialog.
async function savePin(session: Session, save: PinSave): Promise<{ kind: 'set' } | KeyProblem> {
  const { device } = localDataStore.getState();
  if (device.kind !== 'ready') throw new Error('No copy is open on this device');
  const unlock: Unlock =
    save.current === '' ? { serverKey: await fetchServerKey(session) } : { pin: save.current };
  return setPin(device.copy.db, unlock, save.pin);
}

// After set-up, closing the dialog any way is "Not now": not asked again on this copy. The Sync
// page's card still sets one. The dialog closes once the answer is saved: a reload right after the
// click would otherwise cut the write off, and ask again (found by the 19b.5 e2e test). Only this
// dialog: the fifth wrong current PIN may have put the "new PIN" dialog in its place meanwhile.
function closePin(): void {
  const { device, pinDialog } = localDataStore.getState();
  const close = () => {
    if (localDataStore.getState().pinDialog === pinDialog) set({ pinDialog: null });
  };
  if (pinDialog === 'change' || device.kind !== 'ready') {
    close();
    return;
  }
  void markPinAsked(device.copy.db).finally(close);
}
```

- **`open` registers the database's close first, then runs the opening.** Its cleanup also marks the opening as
  ended. `start` later puts the copy's own cleanups in front of it (`unshift`), so the engine stops and the copy
  closes before the database does, as before this step.
- **`keep`** is the key's row of the copy a move deleted (decision 37). It is written right after the database opens,
  before anything reads the key.
- **`openCopy` decides between the PIN and the server's key** (decision 1). `session.locked || isLocked()`: the
  in-memory flag covers a browser that refused to write localStorage. With no checked sign-in (`openedOffline`) there
  is no token to ask the server with, so the PIN is the only way.
- **The server's key request can fail in four ways** (decision 39). `device_revoked` runs 18c's revoke.
  `device_branch_invalid` comes from `registerAgain`, which has already started the set-up again, so this opening
  stops. Anything else (no answer, a server error): the PIN if there is one, else 18a's "unreachable", which tries
  again when the connection comes back and every minute.
- **`openKey` with the server's key answers `open` or `key-changed`,** nothing else. `key-changed` with a PIN shows the
  lock screen with that reason; without one, `remake` deletes the copy and pulls it again (decision 42).
- **`fetchServerKey`** is decision 23: asked at every online opening, kept only in the function's memory. A
  `device_not_found` registers the device again, as the engine's pull does after the server's database was restored,
  and asks once more. `atob` and `charCodeAt` turn the contract's base64 into the 32 bytes `openKey` takes;
  `Uint8Array.from` gives the `Uint8Array<ArrayBuffer>` type that Web Crypto's functions accept.
- **`showLock` counts the waiting changes from what is readable:** the outbox's rows (their status is clear, decision
  11) and the legacy outbox (a device updated to version 3 that has not opened since). `outboxCounts` takes an open
  copy, which a locked device does not have. The count is for the lock screen's Sign out, which asks first when work
  would be lost.
- **`forgetPin` in the locked state** deletes the PIN; the lock screen then ends the sign-in with session.ts's
  `signInAgain` (decision 35). The order matters: if the sign-out ran first, the session would stop and close the
  database before the PIN was deleted. The sign-out is the screen's, not this module's: session.ts imports this
  module (lazily, for 18a's sign-out), and an import back would be a circle, which `pnpm boundaries` refuses. (The
  first version of this part imported it here; 19b.5's checks found it.)
- **`unlock` shows the screen again after a problem** (`failed`), so the screen reads the new count of wrong PINs and,
  after the fifth, shows the blocked state. With `key-changed`, the PIN first wraps the key for the new server key
  (`renewServerKey`), and the server's key then opens it: a second PBKDF2 would cost up to another second on a cheap
  phone.
- **The right PIN removes the lock value** only when the reason was "Lock now". For an offline reload there is no
  value to remove.
- **`start` is 18a's old `open` from the engine on,** with the copy in place of the database. `LocalCopy.open` seals
  the legacy outbox and fills the in-memory tables; a failure there (a row changed on the disk, a read the browser
  refused) shows the storage state, the closest one the pages have.
- **The lock is read again at the end of `start`,** after the last `await`. "Lock now" in another tab while this copy
  was still opening reaches `followLock` when there is no open copy to close, and the opening would then finish
  unlocked. From this check to the `ready` state nothing awaits, so a lock after it finds the copy open and closes
  it. (19b.5's two-tab e2e test found this, in one run of three.)
- **`ask` is true only for an opening with the server's key.** Opened with the PIN, the device has one. The dialog's
  kind comes from the key's row: `new` after the PIN stopped working, `set-up` otherwise (decision 34).
- **The key's row is watched like the outbox** (decision 44), and the cleanup sets `keys` back to `null`, so the card
  and the menu never show a closed copy's PIN.
- **`copy.close()` is the last of the copy's cleanups,** after the engine stops: decision 20, the key and the opened
  rows leave memory.
- **`registerAgain` moved out of the engine's options,** unchanged, because `fetchServerKey` needs it too.
- **`reopen` and `lockNow`.** "Lock now" sets both flags, then closes the copy and opens it again from the start:
  `openCopy` then sees the lock and shows the lock screen. The same `reopen` serves the other tabs and the sign-in
  check, so there is one way in, not three.
- **`savePin` asks the server for its key only for a new PIN** (`current` is `''`). A change unwraps with the current
  PIN, so it works offline, and a wrong one counts as at the lock screen. The API's errors (no connection) go to the
  dialog, which shows them.
- **`closePin` marks the question as answered** unless the dialog was a change: after set-up, closing it any way is
  "Not now" (decision 34). **The dialog closes once that is saved** (`.finally(close)`): a reload right after the
  click would otherwise cut the write off, and the next opening would ask again (19b.5's e2e test found it). `close`
  checks that the dialog is still this one, because the fifth wrong current PIN can put the "new PIN" dialog in its
  place meanwhile.

The end of the file: a move keeps the key's row.

```diff
@@ -426,7 +742,9 @@ async function moveHere(session: Session, input: MoveDeviceInput): Promise<MoveR
   const { device } = localDataStore.getState();
   // The page offers the move only with an open copy: without one, the outbox cannot be read
   if (device.kind !== 'ready') throw new Error('No copy is open on this device');
-  if ((await outboxCounts(device.db)).total > 0) return 'waiting';
+  if ((await outboxCounts(device.copy)).total > 0) return 'waiting';
+  // Step 19b (decision 37): the key's row goes into the new copy, so the PIN still opens it
+  const keep = await device.copy.db.keys.get('data');
   const moved = await call(routes.devices.move, {
     params: { id: session.identity.id },
     body: input,
@@ -437,6 +755,6 @@ async function moveHere(session: Session, input: MoveDeviceInput): Promise<MoveR
   await deleteLocalDatabase(session.tenantId, session.userId);
   // Saved after the delete: another tab follows the new branch only once the old copy is gone
   remember(session, { id: moved.id, branchId: moved.branchId, later: false });
-  if (!hasEnded(session)) await open(session);
+  if (!hasEnded(session)) await open(session, keep);
   return moved;
 }
```

- **The row is read before the move's request,** while the copy is open. After the delete there is nothing to read.

### `components/auth-layout.tsx` (new) and `routes/login.tsx`: one layout for both screens

```tsx
import {
  DeliveryTruck01Icon,
  FactoryIcon,
  Medicine02Icon,
  TShirtIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';
import { Logo } from '@omnivo/ui';
import type { ReactNode } from 'react';

import { AuthPreview } from './auth-preview';
import { LanguageSwitch } from './language-switch';

// key-টা অনুবাদের, লেখা না — ভাষা বদলালে সাথে সাথে বদলায়
const INDUSTRIES = [
  { icon: TShirtIcon, key: 'garments' },
  { icon: Medicine02Icon, key: 'pharma' },
  { icon: DeliveryTruck01Icon, key: 'distribution' },
  { icon: FactoryIcon, key: 'manufacturing' },
] as const;

// Step 19b: the sign-in page's layout, moved here from login.tsx so the lock screen (decision 7)
// uses the same one: the form on the left, in a 380px column, and the side panel on wide screens.
export function AuthLayout({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  return (
    <div className="grid min-h-dvh bg-surface min-[1040px]:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <section className="flex flex-col px-4 py-8 sm:px-16">
        <Logo />
        <div className="grid flex-1 place-items-center py-10">
          <div className="w-full max-w-[380px]">{children}</div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[12.5px] text-ink-3">© 2026 Omnivo Technologies</p>
          <LanguageSwitch />
        </div>
      </section>

      <aside
        aria-label={t('auth.login.panelLabel')}
        className="relative m-3 ml-0 hidden flex-col justify-center gap-10 overflow-hidden rounded-panel border border-brand-line bg-brand-soft px-[clamp(24px,5vw,72px)] py-14 min-[1040px]:flex"
      >
        <div aria-hidden="true" className="auth-grid pointer-events-none absolute inset-0" />
        {/* গ্রিড absolute, তাই লেখাকেও relative না দিলে লাইন লেখার উপরে আঁকা হতো */}
        <div className="relative max-w-lg">
          <h2 className="text-display tracking-[-0.03em]">{t('auth.login.panelTitle')}</h2>
          <p className="mt-3 max-w-md text-[15px] text-ink-2">{t('auth.login.panelBody')}</p>
          <ul className="mt-[18px] flex flex-wrap gap-2">
            {INDUSTRIES.map((industry) => (
              <li
                key={industry.key}
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface py-1 pr-2.5 pl-2 text-[12.5px] font-medium text-ink-2"
              >
                <HugeiconsIcon
                  icon={industry.icon}
                  size={14}
                  strokeWidth={1.5}
                  className="text-brand"
                />
                {t(`auth.login.industries.${industry.key}`)}
              </li>
            ))}
          </ul>
        </div>
        <AuthPreview />
      </aside>
    </div>
  );
}
```

- **The sign-in page's markup, moved as it was** (decision 47): the logo, the form column at most 380px wide, the
  footer with the language switch, and the side panel with the preview from 1040px up. Its Bangla comments came with
  it.

```tsx
import {
  Building03Icon,
  LockPasswordIcon,
  Mail01Icon,
  ViewIcon,
  ViewOffIcon,
  WifiDisconnected02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { contractErrorMap, loginInputSchema } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Checkbox, FormAlert, TextField } from '@omnivo/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';

import { AuthLayout } from '../components/auth-layout';
import { DocumentNotice } from '../components/document-notice';
import { applyApiError } from '../lib/field-errors';
import { login } from '../lib/session';
import { useSession } from '../lib/session-store';
import { useOnline } from '../lib/use-online';

export function LoginPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const [showPassword, setShowPassword] = useState(false);
  // Step 18c: why this page shows, when the app signed the person out (a revoked device)
  const notice = useSession((state) => state.notice);
  // Step 19a: signing in needs the server; saying so first saves typing a password for nothing
  const online = useOnline();
  // zodResolver: API যে schema দিয়ে যাচাই করে, ফর্মও ঠিক সেটা দিয়ে — একই নিয়ম, একই code।
  // contractErrorMap: schema যেখানে নিজে code দেয়নি সেখানে Zod-এর ইংরেজি মেসেজের বদলে code
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(loginInputSchema, { error: contractErrorMap }),
    defaultValues: { workspace: '', email: '', password: '', keepSignedIn: true },
  });

  // handleSubmit: আগে Zod যাচাই, পাস করলে তবেই এই ফাংশন — values-এর টাইপ LoginInput
  // (trim/lowercase হয়ে গেছে)। চলার সময় isSubmitting নিজে থেকেই true
  const onSubmit = handleSubmit(async (values) => {
    try {
      await login(values);
      await navigate({ to: '/' });
    } catch (error) {
      applyApiError(error, loginInputSchema.keyof().options, setError);
    }
  });

  return (
    <AuthLayout>
      <h1 className="text-[28px] leading-[1.2]">{t('auth.login.title')}</h1>
      <p className="mt-2 text-ink-2">{t('auth.login.subtitle')}</p>

      <form noValidate onSubmit={(event) => void onSubmit(event)} className="mt-8 grid gap-[18px]">
        {/* Step 18c: not an error of the form, so the neutral notice, not FormAlert. It stays
            until the next sign-in, which clears it (session-store.ts). */}
        {notice === 'device_revoked' && (
          <DocumentNotice tone="neutral">{t('devices.revokedSignedOut')}</DocumentNotice>
        )}
        {/* Step 19a (decision 19): signed out after an offline opening; the copy stays */}
        {notice === 'session_ended' && (
          <DocumentNotice tone="neutral">{t('auth.login.sessionEnded')}</DocumentNotice>
        )}
        {/* Step 19b (decision 31): "Forgot PIN?", or a PIN that stopped working; the copy stays */}
        {notice === 'pin_reset' && (
          <DocumentNotice tone="neutral">{t('auth.login.pinNotice')}</DocumentNotice>
        )}
        {/* Step 19b (decision 5): a device without a PIN says why its copy did not open offline,
            in the offline notice's place (it says to connect too) */}
        {!online && (
          <DocumentNotice tone="neutral" icon={WifiDisconnected02Icon}>
            {notice === 'no_pin' ? t('auth.login.noPinNotice') : t('auth.login.offlineNotice')}
          </DocumentNotice>
        )}
        {/* message-এ code; FormAlert আর TextField নিজেরাই বর্তমান ভাষায় লেখে */}
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <TextField
          label={t('auth.workspace')}
          icon={Building03Icon}
          suffix=".omnivo.app"
          autoComplete="organization"
          autoCapitalize="none"
          spellCheck={false}
          // উদাহরণ ঠিকানা — ঠিকানা সবসময় ইংরেজি অক্ষরে, তাই অনুবাদ নেই
          placeholder="rahman-garments"
          {...register('workspace')}
          error={errors.workspace?.message}
        />
        <TextField
          label={t('auth.email')}
          icon={Mail01Icon}
          type="email"
          autoComplete="email"
          placeholder="name@company.com"
          {...register('email')}
          error={errors.email?.message}
        />
        <TextField
          label={t('auth.password')}
          icon={LockPasswordIcon}
          type={showPassword ? 'text' : 'password'}
          autoComplete="current-password"
          placeholder={t('auth.login.passwordPlaceholder')}
          {...register('password')}
          error={errors.password?.message}
          trailing={
            <button
              type="button"
              aria-label={
                showPassword ? t('auth.login.hidePassword') : t('auth.login.showPassword')
              }
              onClick={() => {
                setShowPassword(!showPassword);
              }}
              className="-mr-1.5 grid place-items-center rounded-md p-1.5 text-ink-3 transition-colors duration-150 hover:bg-subtle hover:text-ink"
            >
              <HugeiconsIcon
                icon={showPassword ? ViewOffIcon : ViewIcon}
                size={17}
                strokeWidth={1.5}
              />
            </button>
          }
        />
        {/* Radix Checkbox আসল <input> না, তাই register চলে না — Controller মান আর onChange জোড়ে */}
        <Controller
          control={control}
          name="keepSignedIn"
          render={({ field }) => (
            <Checkbox
              id="keepSignedIn"
              label={t('auth.login.keepSignedIn')}
              checked={field.value}
              // Radix-এর মান true | false | 'indeterminate' — আমাদের schema শুধু boolean
              onCheckedChange={(checked) => {
                field.onChange(checked === true);
              }}
            />
          )}
        />
        <Button type="submit" disabled={isSubmitting} className="w-full">
          {isSubmitting ? t('auth.login.submitting') : t('auth.login.submit')}
        </Button>
      </form>

      <p className="mt-7 text-center text-body-sm text-ink-2">
        {t('auth.login.newHere')}{' '}
        <Link
          to="/sign-up"
          className="font-medium text-brand underline-offset-[3px] hover:underline"
        >
          {t('auth.login.createWorkspace')}
        </Link>
      </p>
    </AuthLayout>
  );
}
```

- **The page keeps only its form.** The diff of this file is mostly the form moving six spaces to the left, so the
  guide shows the whole file.
- **`pin_reset` shows `pinNotice`.** **`no_pin` replaces the offline notice's text** instead of adding a second
  notice: both say there is no connection, and only this one says why the copy did not open (19b.3).

### `components/pin-field.tsx` (new): the PIN box

```tsx
import { LockKeyholeIcon } from '@hugeicons/core-free-icons';
import { TextField, type TextFieldProps } from '@omnivo/ui';

import { pinDigits } from '../lib/pin';

// Step 19b: a PIN box (decision 7): the input's look, masked, with the phone's number pad. What is
// typed goes through pinDigits, so a Bangla keyboard works and the value is always ASCII digits.
// Controlled (react-hook-form's Controller): register() would keep what was typed, not the digits.
export function PinField({
  value,
  onChange,
  ...field
}: Omit<TextFieldProps, 'value' | 'onChange' | 'type'> & {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <TextField
      icon={LockKeyholeIcon}
      type="password"
      inputMode="numeric"
      // A password manager must not offer to save the device PIN as the site's password
      autoComplete="off"
      {...field}
      value={value}
      onChange={(event) => {
        onChange(pinDigits(event.target.value));
      }}
    />
  );
}
```

- **The ordinary text field** (decision 45), so the label, the hint, the error and the 42px box are the same as
  everywhere. `type="password"` masks it; `inputMode="numeric"` opens the number pad on a phone.
- **Controlled, not `register`ed.** `register` would keep what the browser typed; this keeps what `pinDigits` lets
  through. `{...field}` comes before `value` and `onChange`, so a caller cannot replace them by mistake.

### `components/lock-screen.tsx` (new): the lock screen

```tsx
import { Alert02Icon, WifiDisconnected02Icon } from '@hugeicons/core-free-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { contractErrorMap } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { MAX_WRONG_PINS } from '@omnivo/sync';
import { Button } from '@omnivo/ui';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';

import { type LockReason, useDeviceState } from '../lib/local-data';
import { unlockFormSchema } from '../lib/pin';
import { logout, signInAgain } from '../lib/session';
import { useSession } from '../lib/session-store';
import { useOnline } from '../lib/use-online';
import { AuthLayout } from './auth-layout';
import { DocumentNotice } from './document-notice';
import { PinField } from './pin-field';
import { SignOutDialog } from './sign-out-dialog';

const DESCRIPTIONS = {
  locked: 'pin.lock.description',
  offline: 'pin.lock.offlineDescription',
  'key-changed': 'pin.lock.keyChangedDescription',
} as const satisfies Record<LockReason, string>;

const linkClass = 'font-medium text-brand underline-offset-[3px] hover:underline';

// Step 19b (decision 7): the lock screen, in the AppShell's place while the copy waits for the PIN
// (app-frame.tsx). The session (the LocalDataHost) runs on beside it and puts the lock's state and
// actions in the store.
export function LockScreen() {
  const { t, format } = useLocale();
  const device = useDeviceState();
  const me = useSession((state) => state.me);
  const openedOffline = useSession((state) => state.openedOffline);
  const online = useOnline();
  const [asking, setAsking] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const {
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(unlockFormSchema, { error: contractErrorMap }),
    defaultValues: { pin: '' },
  });

  // null while the session reads the key's row: the AppShell shows this screen from the start, so
  // the shell never shows for a moment before it
  const lock = device.kind === 'locked' ? device : null;
  const reason = lock?.reason ?? (openedOffline ? 'offline' : 'locked');
  const max = format.number(MAX_WRONG_PINS);

  const onSubmit = handleSubmit(async ({ pin }) => {
    if (!lock) return;
    const answer = await lock.unlock(pin);
    // open: the AppShell draws the app instead. pin-blocked: the screen shows the blocked state.
    if (answer.kind !== 'wrong-pin') return;
    // Empty again, for the next try; the error says how many are left
    setValue('pin', '');
    setError('pin', {
      message: t('pin.wrong', { count: answer.left, formatted: format.number(answer.left) }),
    });
  });

  // Decision 35: the PIN goes, the sign-in ends, and the password opens the copy; the dialog then
  // asks for a new PIN
  const toPassword = async () => {
    if (!lock) return;
    setLeaving(true);
    await lock.forgetPin();
    await signInAgain();
  };

  const signOut = () => {
    if (lock && lock.waiting > 0) setAsking(true);
    else void logout();
  };

  return (
    <AuthLayout>
      <h1 className="text-[28px] leading-[1.2]">{t('pin.lock.title')}</h1>
      <p className="mt-2 text-ink-2">{t(DESCRIPTIONS[reason])}</p>

      {me && (
        <p className="mt-6 grid rounded-control border border-line px-3 py-2.5">
          <span className="truncate text-body-sm font-medium">{me.user.fullName}</span>
          <span className="truncate text-caption text-ink-3">{me.user.email}</span>
        </p>
      )}

      {lock?.status.hasPin && (
        <>
          <form
            noValidate
            onSubmit={(event) => void onSubmit(event)}
            className="mt-6 grid gap-[18px]"
          >
            <Controller
              control={control}
              name="pin"
              render={({ field }) => (
                <PinField
                  label={t('pin.label')}
                  // The one field on the page, and the reason it is there
                  autoFocus
                  name={field.name}
                  ref={field.ref}
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  error={errors.pin?.message}
                />
              )}
            />
            <Button type="submit" disabled={isSubmitting} className="w-full">
              {isSubmitting ? t('pin.lock.unlocking') : t('pin.lock.unlock')}
            </Button>
          </form>
          {/* "Forgot PIN?" needs the password, so the server: offline it only says what to do */}
          <p className="mt-5 text-center text-body-sm text-ink-2">
            {online ? (
              <button
                type="button"
                disabled={leaving}
                className={linkClass}
                onClick={() => void toPassword()}
              >
                {t('pin.lock.forgot')}
              </button>
            ) : (
              t('pin.lock.forgotOffline')
            )}
          </p>
        </>
      )}

      {/* No PIN: too many wrong ones (or forgotten in another tab). Only the password opens it. */}
      {lock && !lock.status.hasPin && (
        <div className="mt-6 grid gap-[18px]">
          {online ? (
            <>
              {lock.status.pinBlocked && (
                <DocumentNotice tone="warn" icon={Alert02Icon}>
                  {t('pin.blocked', { max })}
                </DocumentNotice>
              )}
              <Button disabled={leaving} className="w-full" onClick={() => void toPassword()}>
                {t('pin.lock.signIn')}
              </Button>
            </>
          ) : (
            <DocumentNotice
              tone={lock.status.pinBlocked ? 'warn' : 'neutral'}
              icon={WifiDisconnected02Icon}
            >
              {lock.status.pinBlocked
                ? t('pin.lock.blockedOffline', { max })
                : t('pin.lock.forgotOffline')}
            </DocumentNotice>
          )}
        </div>
      )}

      {lock && (
        <p className="mt-7 text-center text-body-sm">
          <button type="button" className={linkClass} onClick={signOut}>
            {t('common.signOut')}
          </button>
        </p>
      )}

      {asking && lock && (
        <SignOutDialog
          count={lock.waiting}
          onClose={() => {
            setAsking(false);
          }}
        />
      )}
    </AuthLayout>
  );
}
```

- **`DESCRIPTIONS` with `satisfies Record<LockReason, string>`:** a fourth reason added later fails the type check
  here until it has its words (decision 32).
- **`lock` is `null` while the session reads the key's row.** The frame draws this screen from the start (decision
  38), so for that moment it shows the title and the description only. The reason is guessed the same way the frame
  decided to draw it.
- **After a wrong PIN, the box is emptied and the error says how many tries are left.** The message is already a
  sentence; the field shows a text that is not a code as it is (decision 29). After the fifth, `unlock` has shown the
  screen again with the PIN off, and the form goes away by itself.
- **`autoFocus` on the one field:** it is why the screen is there. The app uses it the same way in its pickers.
- **"Forgot PIN?" is a link that does something** (a `button` styled as a link) online, and a sentence offline,
  where the password cannot work.
- **No PIN** (too many wrong ones, or deleted in another tab): online, the primary button is the password sign-in,
  with the `warn` notice when the PIN stopped working; offline, a notice says what to do and that the work stays.
- **`toPassword` is "Forgot PIN?" and the blocked state's button:** the lock's `forgetPin`, then session.ts's
  `signInAgain`, in that order (local-session.ts says why). `leaving` disables both ways to the sign-in page after one
  click: each runs a delete and a sign-out request.
- **Sign out asks first when changes wait,** with 18b's dialog: signing out deletes the copy and its outbox. The
  dialog is imported directly here: this chunk loads only when the app is locked.
- **The name and email sit in a plain box, with no icon.** An icon that only the shell also used would put the shell's
  whole chunk into this one's graph, and the lock screen must load fast when it is all there is.

### `components/pin-dialog.tsx` (new): set or change the PIN

```tsx
import { zodResolver } from '@hookform/resolvers/zod';
import { contractErrorMap } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import type { KeyProblem } from '@omnivo/sync';
import { Button, Dialog, DialogContent, FormAlert, toast } from '@omnivo/ui';
import { useMemo } from 'react';
import { Controller, useForm } from 'react-hook-form';

import { applyApiError } from '../lib/field-errors';
import { askForPin, type PinDialogKind, type PinSave } from '../lib/local-data';
import { pinFormSchema } from '../lib/pin';
import { PinField } from './pin-field';

const FIELD_NAMES = ['current', 'pin', 'repeat'] as const;

const TITLES = {
  'set-up': 'pin.setUpTitle',
  new: 'pin.newTitle',
  change: 'pin.changeTitle',
} as const satisfies Record<PinDialogKind, string>;

// Step 19b (decision 5): set or change the device PIN. After set-up the session opens it ("Not
// now" and any other way of closing it mean not now); the Sync page's card and the account menu
// open it later. The session's two actions come as props from the host, like the branch dialog's:
// an import of local-session here would count Dexie into this lazy chunk a second time.
export function PinDialog({
  kind,
  savePin,
  close,
}: {
  kind: PinDialogKind;
  savePin: (save: PinSave) => Promise<{ kind: 'set' } | KeyProblem>;
  close: () => void;
}) {
  const { t, format } = useLocale();
  const change = kind === 'change';
  // The host remounts the dialog when the kind changes (key), so the schema is made once
  const schema = useMemo(() => pinFormSchema(change), [change]);
  const {
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(schema, { error: contractErrorMap }),
    defaultValues: { current: '', pin: '', repeat: '' },
  });

  const onSubmit = handleSubmit(async ({ current, pin }) => {
    try {
      const answer = await savePin({ current: change ? current : '', pin });
      switch (answer.kind) {
        case 'set':
          toast(t(change ? 'pin.changed' : 'pin.set'));
          close();
          return;
        case 'wrong-pin':
          setValue('current', '');
          setError('current', {
            message: t('pin.wrong', { count: answer.left, formatted: format.number(answer.left) }),
          });
          return;
        // The fifth wrong current PIN turned the PIN off: the dialog for a new one takes this
        // one's place, which sets it with the server's key
        case 'pin-blocked':
          askForPin('new');
          return;
        // no-pin and key-changed: the copy opened, so neither can happen here
        default:
          setError('root.server', { message: 'unknown_error' });
      }
    } catch (error) {
      // No connection, for a new PIN (it needs the server's key)
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        title={t(TITLES[kind])}
        description={
          kind === 'set-up'
            ? t('pin.setUpDescription')
            : kind === 'new'
              ? t('pin.newDescription')
              : undefined
        }
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              {change ? t('common.cancel') : t('pin.later')}
            </Button>
            <Button type="submit" form="pin-form" disabled={isSubmitting}>
              {isSubmitting ? t('pin.saving') : change ? t('pin.saveChange') : t('pin.save')}
            </Button>
          </>
        }
      >
        <form
          id="pin-form"
          noValidate
          onSubmit={(event) => void onSubmit(event)}
          className="grid gap-5"
        >
          {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
          {change && (
            <Controller
              control={control}
              name="current"
              render={({ field }) => (
                <PinField
                  label={t('pin.current')}
                  name={field.name}
                  ref={field.ref}
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  error={errors.current?.message}
                />
              )}
            />
          )}
          <Controller
            control={control}
            name="pin"
            render={({ field }) => (
              <PinField
                label={change ? t('pin.newPin') : t('pin.label')}
                hint={t('pin.hint')}
                name={field.name}
                ref={field.ref}
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                error={errors.pin?.message}
              />
            )}
          />
          <Controller
            control={control}
            name="repeat"
            render={({ field }) => (
              <PinField
                label={t('pin.repeat')}
                name={field.name}
                ref={field.ref}
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                error={errors.repeat?.message}
              />
            )}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- **Its actions come as props from the host,** like the branch dialog's (18b): importing local-session here would put
  Dexie into this chunk a second time.
- **`useMemo` for the schema:** the host remounts the dialog when its kind changes (`key`), so the memo keeps the
  resolver stable for the life of one form.
- **Each answer has its place.** `set`: a toast that names what happened, and the dialog closes. `wrong-pin`: under
  the current PIN, with the box emptied. `pin-blocked`: the new-PIN dialog takes this one's place (decision 46).
  `no-pin` and `key-changed` cannot happen with an open copy; they show the generic error rather than nothing.
- **A thrown error is the API's** (no connection, for a new PIN): `applyApiError` shows it above the fields.
- **"Not now" for a new PIN, "Cancel" for a change.** Both close the dialog; only the first is an answer to the
  question (the session's `closePin`).

### `components/local-data-host.tsx`: the PIN dialog

```diff
@@ -13,6 +13,11 @@ const DeviceBranchDialog = lazy(async () => ({
   default: (await import('./device-branch-dialog')).DeviceBranchDialog,
 }));
 
+// Step 19b: the same for the PIN dialog
+const PinDialog = lazy(async () => ({
+  default: (await import('./pin-dialog')).PinDialog,
+}));
+
 // Step 18a: the device and its copy of the data, for the person signed in now. Rendered once,
 // inside the AppShell, and loaded lazily with Dexie: the login page never downloads it. A switch
 // to another workspace changes the tenant id, which stops this copy and starts that one.
@@ -20,6 +25,9 @@ export function LocalDataHost() {
   const userId = useSession((state) => state.me?.user.id);
   const tenantId = useSession((state) => state.me?.tenant.id);
   const asking = useStore(localDataStore, (state) => state.asking);
+  const pinDialog = useStore(localDataStore, (state) => state.pinDialog);
+  const savePin = useStore(localDataStore, (state) => state.savePin);
+  const closePin = useStore(localDataStore, (state) => state.closePin);
   const device = useDeviceState();
   const waiting = useStore(syncSummaryStore, (state) => state.waiting);
 
@@ -40,13 +48,22 @@ export function LocalDataHost() {
     [],
   );
 
-  return asking && device.kind === 'not-set-up' ? (
+  if (asking && device.kind === 'not-set-up') {
+    return (
+      <Suspense fallback={null}>
+        <DeviceBranchDialog
+          branches={device.branches}
+          chooseBranch={chooseBranch}
+          chooseLater={chooseLater}
+        />
+      </Suspense>
+    );
+  }
+  // Step 19b: only on an open copy, whose key the PIN wraps. key: a new kind (the fifth wrong
+  // current PIN turns a change into a new PIN) is a new form.
+  return pinDialog && device.kind === 'ready' ? (
     <Suspense fallback={null}>
-      <DeviceBranchDialog
-        branches={device.branches}
-        chooseBranch={chooseBranch}
-        chooseLater={chooseLater}
-      />
+      <PinDialog key={pinDialog} kind={pinDialog} savePin={savePin} close={closePin} />
     </Suspense>
   ) : null;
 }
```

- **Lazy, like the branch dialog:** most sessions never open it.
- **Only on a ready copy:** the PIN wraps the data key, which only an open copy has.
- **`key={pinDialog}`:** a change that turns into a new PIN (decision 46) gets a fresh form, with its own schema and
  empty boxes.

### `components/pin-card.tsx` (new) and `routes/sync.tsx`: the "Device PIN" card

```tsx
import { Alert02Icon, CheckmarkCircle02Icon, SquareUnlock02Icon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { MAX_WRONG_PINS } from '@omnivo/sync';
import { Button, Card, CardHeader, Pill } from '@omnivo/ui';

import { askForPin, useKeyStatus } from '../lib/local-data';

// Step 19b (decision 5): the Sync page's card about the device PIN. "Stopped working" is warn: the
// person must set a new one before working offline again. "No PIN" is neutral: the data still
// opens online, and the card says what a PIN adds.
export function PinCard() {
  const { t, format } = useLocale();
  // null while no copy is open: nothing to set a PIN on
  const status = useKeyStatus();
  if (!status) return null;
  const max = format.number(MAX_WRONG_PINS);

  return (
    <Card>
      <CardHeader
        title={t('pin.card.title')}
        subtitle={t('pin.card.subtitle')}
        actions={
          status.hasPin ? (
            <Pill tone="good" icon={CheckmarkCircle02Icon}>
              {t('pin.card.on')}
            </Pill>
          ) : status.pinBlocked ? (
            <Pill tone="warn" icon={Alert02Icon}>
              {t('pin.card.blocked')}
            </Pill>
          ) : (
            <Pill tone="neutral" icon={SquareUnlock02Icon}>
              {t('pin.card.off')}
            </Pill>
          )
        }
      />
      <div className="grid gap-3 px-5 pt-3 pb-5">
        <p className="text-body-sm text-ink-2">
          {status.hasPin
            ? t('pin.card.onBody')
            : status.pinBlocked
              ? t('pin.card.blockedBody', { max })
              : t('pin.card.offBody')}
        </p>
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              askForPin(status.hasPin ? 'change' : status.pinBlocked ? 'new' : 'set-up');
            }}
          >
            {status.hasPin ? t('pin.card.change') : t('pin.card.set')}
          </Button>
        </div>
      </div>
    </Card>
  );
}
```

- **One pill and one sentence per state** (CLAUDE.md → Pill): `good` "PIN set", `warn` "Stopped working" (the person
  must act before working offline again), neutral "No PIN" (a choice, not a problem).
- **One button, which opens the dialog for the state:** a change with a PIN, a new PIN after it stopped working,
  set-up otherwise.
- **Nothing while no copy is open:** there is nothing to set a PIN on.

```diff
@@ -13,7 +13,6 @@ import {
   isOpen,
   type OutboxEntry,
   outboxEntries,
-  readPullState,
   retryEntry,
   syncNotices,
 } from '@omnivo/sync';
@@ -34,13 +33,15 @@ import { useState } from 'react';
 
 import { DocumentNotice } from '../components/document-notice';
 import { LocalState } from '../components/local-state';
+import { PinCard } from '../components/pin-card';
 import { StorageCard } from '../components/storage-card';
 import { useTenantId, useTimeZone } from '../components/stock-parts';
 import { OutboxStatusPill, useCommandText, useFieldList } from '../components/sync-parts';
 import {
+  readPull,
   requestSync,
+  useLocalCopy,
   useLocalData,
-  useLocalDb,
   useLocalQuery,
   useSyncStatus,
 } from '../lib/local-data';
@@ -88,10 +89,10 @@ export function SyncPage() {
   const timeZone = useTimeZone();
   const { view } = useLocalData();
   const status = useSyncStatus();
-  const db = useLocalDb();
-  const entries = useLocalQuery(db ? outboxEntries : null);
-  const notices = useLocalQuery(db ? syncNotices : null);
-  const pull = useLocalQuery(readPullState);
+  const copy = useLocalCopy();
+  const entries = useLocalQuery(copy ? outboxEntries : null);
+  const notices = useLocalQuery(copy ? syncNotices : null);
+  const pull = useLocalQuery(readPull);
   // Step 18c (decision 12): the limits, on this device's clock
   const age = useSyncAge();
   // Step 19a: opened offline with the remembered sign-in, not checked by the server yet
@@ -102,14 +103,14 @@ export function SyncPage() {
   const dependents = discarding && entries ? dependentsOf(entries, discarding).length : 0;
 
   const retry = async (entry: OutboxEntry) => {
-    if (!db || entry.seq === undefined) return;
-    await retryEntry(db, entry.seq);
+    if (!copy || entry.seq === undefined) return;
+    await retryEntry(copy, entry.seq);
     requestSync();
   };
 
   const discard = async (entry: OutboxEntry) => {
-    if (!db || entry.seq === undefined) return;
-    const result = await discardEntry(db, entry.seq);
+    if (!copy || entry.seq === undefined) return;
+    const result = await discardEntry(copy, entry.seq);
     setDiscarding(null);
     if (result === 'busy') {
       toast(t('sync.busy'));
@@ -129,7 +130,7 @@ export function SyncPage() {
         description={t('sync.description')}
         actions={
           <Button
-            disabled={!online || !db || status.syncing}
+            disabled={!online || !copy || status.syncing}
             onClick={() => {
               requestSync();
             }}
@@ -157,7 +158,7 @@ export function SyncPage() {
         </DocumentNotice>
       )}
 
-      {!db && view.kind !== 'ready' && <LocalState view={view} />}
+      {!copy && view.kind !== 'ready' && <LocalState view={view} />}
 
       {notices && notices.length > 0 && (
         <Card>
@@ -178,7 +179,7 @@ export function SyncPage() {
                   type="button"
                   className="text-body-sm font-medium text-brand underline-offset-3 hover:underline"
                   onClick={() => {
-                    if (db) void dismissNotice(db, notice.commandId);
+                    if (copy) void dismissNotice(copy, notice.commandId);
                   }}
                 >
                   {t('sync.dismiss')}
@@ -272,6 +273,8 @@ export function SyncPage() {
         </Card>
       )}
 
+      {/* Step 19b: next to the storage card: both are about this device, not about a sync */}
+      <PinCard />
       {/* Step 19a: last, because nothing in it changes from one sync to the next */}
       <StorageCard />
 
```

- **The page reads the copy** (`useLocalCopy`, `readPull`) instead of the database; the rest is the same page.
- **The card goes before the storage card:** both are about this device, not about a sync.

### `routes/app-frame.tsx` (new), `router.tsx` and `routes/app-shell.tsx`: the lock screen in the shell's place

```tsx
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useEffect } from 'react';

import { askForPin, lockNow, useDeviceState, useKeyStatus } from '../lib/local-data';
import { isLocked } from '../lib/remembered-session';
import { useSession } from '../lib/session-store';
import type { LockAction } from './app-shell';

// Step 19b: everything a signed-in page sits in. Before this step the AppShell was the route's
// component; now the shell is one of two things this frame shows, and the lock screen is the other.
// Both are lazy: the shell's menus and the lock screen's form are never loaded together.
const AppShell = lazy(async () => ({ default: (await import('./app-shell')).AppShell }));
const LockScreen = lazy(async () => ({
  default: (await import('../components/lock-screen')).LockScreen,
}));
// Step 18a: the device and its copy of the data (Dexie, the sync engine, the branch dialog) in a
// chunk of their own. The shell draws at once; the copy starts a moment later.
// Step 19b: here, beside the shell, not in it: the copy's session runs on while the lock screen
// takes the shell's place.
const LocalDataHost = lazy(async () => ({
  default: (await import('../components/local-data-host')).LocalDataHost,
}));

export function AppFrame() {
  const navigate = useNavigate();
  const status = useSession((state) => state.status);
  const openedOffline = useSession((state) => state.openedOffline);
  const device = useDeviceState();
  const keys = useKeyStatus();

  // refresh ব্যর্থ হলে (session শেষ, অন্য ট্যাবে লগআউট) api.ts store-এ signed-out বসায়
  // Step 19b: moved here from the AppShell, so a sign-out from the lock screen leaves too
  useEffect(() => {
    if (status === 'signed-out') void navigate({ to: '/login' });
  }, [status, navigate]);

  // The lock screen while the copy waits for the PIN, and while it is still opening when it is
  // going to ask (Lock now, an offline reload), so the shell never shows for a moment before it.
  // The shell is not drawn at all: no page keeps the workspace's data on the screen or in memory.
  const locked =
    device.kind === 'locked' || (device.kind === 'starting' && (openedOffline || isLocked()));

  // Decision 4: "Lock now" with a PIN; without one, the item opens the PIN dialog
  const lock: LockAction | undefined = keys
    ? {
        pin: keys.hasPin,
        run: keys.hasPin
          ? lockNow
          : () => {
              askForPin(keys.pinBlocked ? 'new' : 'set-up');
            },
      }
    : undefined;

  return (
    <>
      <Suspense fallback={null}>{locked ? <LockScreen /> : <AppShell lock={lock} />}</Suspense>
      {/* No fallback: the host draws nothing until a dialog is needed */}
      <Suspense fallback={null}>
        <LocalDataHost />
      </Suspense>
    </>
  );
}
```

- **The frame is the route's component now** (decision 38). It is small (about 7 KB with the device's store), and the
  shell and the lock screen are each a chunk of their own.
- **The redirect to `/login` moved here from the shell.** While the lock screen shows, the shell is not drawn, and a
  sign-out from the lock screen must still leave the page.
- **`locked` is also true while the copy is still opening, when it is going to ask:** after "Lock now" or an offline
  reload. Without that, the shell would show for the moment the session takes to read the key's row.
- **`LocalDataHost` sits beside both screens, at the same place in the tree,** so React keeps it mounted when the
  screen changes. Remounting it would stop the session and start it again.
- **The menu item comes from here as a prop:** the frame already reads the device's store, and the shell would
  otherwise import it and go over its budget.

```diff
@@ -90,7 +90,8 @@ const appRoute = createRoute({
     if (mustRunSetup()) throw redirect({ to: '/onboarding' });
   },
   // layout-ও lazy: সাইডবারের Radix মেনু (~৩০ KB gz) লগইনের আগে লাগে না
-  component: lazyRouteComponent(() => import('./routes/app-shell'), 'AppShell'),
+  // Step 19b: the frame around the shell, which shows the lock screen in its place (app-frame.tsx)
+  component: lazyRouteComponent(() => import('./routes/app-frame'), 'AppFrame'),
 });
 
 const dashboardRoute = createRoute({
```

```diff
@@ -23,14 +23,15 @@ import {
   Layers01Icon,
   LayoutGridIcon,
   LeftToRightListNumberIcon,
+  LockKeyIcon,
   Logout01Icon,
   MoneyExchange01Icon,
   MoneyReceive02Icon,
   MoneyReceiveCircleIcon,
   MoneySend02Icon,
   Note01Icon,
-  NoteRemoveIcon,
   Notebook02Icon,
+  NoteRemoveIcon,
   PackageIcon,
   PackageOutOfStockIcon,
   PackageReceiveIcon,
@@ -41,6 +42,7 @@ import {
   Settings02Icon,
   ShoppingBasket01Icon,
   ShoppingCart01Icon,
+  SquareLock02Icon,
   Store01Icon,
   TableIcon,
   Tag01Icon,
@@ -82,7 +84,7 @@ import {
 } from '@omnivo/ui';
 import { useQuery } from '@tanstack/react-query';
 import { createLink, Outlet, useNavigate } from '@tanstack/react-router';
-import { lazy, Suspense, useEffect, useState } from 'react';
+import { lazy, Suspense, useState } from 'react';
 
 import { NotificationBell } from '../components/notification-bell';
 import { type InstallWay, promptInstall, useInstallWay } from '../lib/install';
@@ -95,11 +97,6 @@ import { useSyncAge, useSyncSummary } from '../lib/sync-summary';
 import { isTheme } from '../lib/theme';
 import { useOnline } from '../lib/use-online';
 
-// Step 18a: the device and its copy of the data (Dexie, the sync engine, the branch dialog) in a
-// chunk of their own. The shell draws at once; the copy starts a moment later.
-const LocalDataHost = lazy(async () => ({
-  default: (await import('../components/local-data-host')).LocalDataHost,
-}));
 // Step 18b: the question before signing out with changes on the device. Loaded when it is asked:
 // the dialog's code (about 14 KB gz with its focus trap and scroll lock) took the shell over its
 // budget, for a dialog most sessions never open.
@@ -247,14 +244,24 @@ function SyncNavItem() {
 }
 
 // ডেস্কটপের সাইডবার-তলা আর ফোনের টপ বার — দুই trigger, একই মেনু
+// Step 19b: the account menu's lock item (decision 4), from the AppFrame, which has the copy.
+// pin = "Lock now"; without a PIN the item opens the PIN dialog instead.
+export interface LockAction {
+  pin: boolean;
+  run: () => void;
+}
+
 function UserMenuContent({
   align,
   onInstall,
+  lock,
   onSignOut,
 }: {
   align: 'start' | 'end';
   // Step 19a: undefined = nothing to install (installed already, or a browser that cannot)
   onInstall: (() => void) | undefined;
+  // Step 19b: undefined = no copy open on this device, so nothing to lock
+  lock: LockAction | undefined;
   onSignOut: () => void;
 }) {
   const { t, language } = useLocale();
@@ -276,6 +283,11 @@ function UserMenuContent({
           {t('shell.installApp')}
         </DropdownMenuItem>
       )}
+      {lock && (
+        <DropdownMenuItem icon={lock.pin ? SquareLock02Icon : LockKeyIcon} onSelect={lock.run}>
+          {lock.pin ? t('shell.lockNow') : t('shell.setPinToLock')}
+        </DropdownMenuItem>
+      )}
       <DropdownMenuSeparator />
       <DropdownMenuLabel>{t('common.language')}</DropdownMenuLabel>
       <DropdownMenuRadioGroup
@@ -315,10 +327,10 @@ function UserMenuContent({
   );
 }
 
-export function AppShell() {
+// Step 19b: inside the AppFrame (app-frame.tsx), which runs the device's copy beside it and shows the
+// lock screen in its place
+export function AppShell({ lock }: { lock: LockAction | undefined }) {
   const { t } = useLocale();
-  const navigate = useNavigate();
-  const status = useSession((state) => state.status);
   const me = useSession((state) => state.me);
   // লুকানো শুধু সুবিধা — আসল পাহারা API-র PermissionGuard। যেটা খুললেই 403, সেটা মেনুতে না দেখানো
   const can = useCan();
@@ -342,11 +354,6 @@ export function AppShell() {
           else setInstallHelp(installWay);
         };
 
-  // refresh ব্যর্থ হলে (session শেষ, অন্য ট্যাবে লগআউট) api.ts store-এ signed-out বসায়
-  useEffect(() => {
-    if (status === 'signed-out') void navigate({ to: '/login' });
-  }, [status, navigate]);
-
   return (
     <Shell
       brand={<Logo />}
@@ -356,7 +363,7 @@ export function AppShell() {
           <DropdownMenuTrigger asChild>
             <IconButton icon={UserCircleIcon} label={t('shell.account')} />
           </DropdownMenuTrigger>
-          <UserMenuContent align="end" onInstall={install} onSignOut={signOut} />
+          <UserMenuContent align="end" onInstall={install} lock={lock} onSignOut={signOut} />
         </DropdownMenu>
       }
       sidebarHeader={<WorkspaceSwitcher />}
@@ -627,7 +634,7 @@ export function AppShell() {
               />
             </button>
           </DropdownMenuTrigger>
-          <UserMenuContent align="start" onInstall={install} onSignOut={signOut} />
+          <UserMenuContent align="start" onInstall={install} lock={lock} onSignOut={signOut} />
         </DropdownMenu>
       }
     >
@@ -652,10 +659,6 @@ export function AppShell() {
           />
         </Suspense>
       )}
-      {/* No fallback: the host draws nothing until a branch dialog is needed */}
-      <Suspense fallback={null}>
-        <LocalDataHost />
-      </Suspense>
     </Shell>
   );
 }
```

- **`LockAction` is the item's whole contract:** whether the device has a PIN, and what to run. The shell picks the
  words and the icon; "Set a PIN to lock" instead of "Lock now" is decision 4's answer for a device without a PIN.
- **The item sits after "Install app",** with the other things about this device.
- **The `LocalDataHost` and the redirect left the shell** for the frame. Nothing else in the shell changed.

### The pages that read the copy

Each of these changes only the parameter of its reads, from the database to the copy, and `allRows` takes the copy
too (19b.1: every row is sealed now, small tables included).

```diff
@@ -47,7 +47,7 @@ import type { z } from 'zod';
 
 import { applyApiError, applyCommandError } from '../lib/field-errors';
 import { call } from '../lib/api';
-import { requestSync, type SaveMode, useLocalDb } from '../lib/local-data';
+import { requestSync, type SaveMode, useLocalCopy } from '../lib/local-data';
 import { useSyncAge } from '../lib/sync-summary';
 import { rowPath } from '../lib/products';
 import { customerQuery } from '../lib/queries';
@@ -176,7 +176,7 @@ export function CustomerForm({
   const queryClient = useQueryClient();
   const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
   const online = useOnline();
-  const db = useLocalDb();
+  const copy = useLocalCopy();
   const onDevice = mode === 'device';
   // Step 18c (decision 12): 7 days after the last sync the device saves no new work. The form
   // still opens (the person sees what they wanted to change), with no button to save it.
@@ -229,9 +229,9 @@ export function CustomerForm({
   const onSubmit = handleSubmit(async ({ version, ...values }) => {
     if (onDevice) {
       // Enter in a box submits the form even with no submit button
-      if (!db || blocked) return;
+      if (!copy || blocked) return;
       try {
-        await saveCustomer(db, {
+        await saveCustomer(copy, {
           base: customer,
           input: values,
           savedAt: new Date().toISOString(),
```

```diff
@@ -33,7 +33,7 @@ import { Controller, type Path, useForm, useWatch } from 'react-hook-form';
 
 import { call } from '../lib/api';
 import { applyApiError, applyCommandError } from '../lib/field-errors';
-import { requestSync, useLocalDb, useSaveMode } from '../lib/local-data';
+import { requestSync, useLocalCopy, useSaveMode } from '../lib/local-data';
 import { useSyncAge } from '../lib/sync-summary';
 import { rowPath } from '../lib/products';
 import { formTotals, type LineMeta, SALES_LINE_FIELDS, savedLines } from '../lib/sales';
@@ -178,7 +178,7 @@ export function SalesOrderForm({
   // has changes waiting on this device (a customer made offline is not on the server yet). A
   // server draft and an order from a quotation stay with the API: neither can be a command.
   const online = useOnline();
-  const db = useLocalDb();
+  const copy = useLocalCopy();
   const customerMode = useSaveMode(customerId);
   const onDevice =
     order === null &&
@@ -261,7 +261,7 @@ export function SalesOrderForm({
   // the total are kept with it for the Sync page and the unsynced orders.
   const saveOnDevice = handleSubmit(async (values) => {
     // Enter in a box submits the form even with no submit button
-    if (!db || blocked) return;
+    if (!copy || blocked) return;
     const input: SalesOrderDraftInput = {
       customerId: values.customerId,
       date: values.date,
@@ -275,7 +275,7 @@ export function SalesOrderForm({
     const rateOf = (id: string) => rates?.find((rate) => rate.id === id)?.rate ?? null;
     let result;
     try {
-      result = await saveOrderDraft(db, {
+      result = await saveOrderDraft(copy, {
         orderId: draft?.orderId ?? null,
         input,
         name: customer?.name ?? '',
```

```diff
@@ -1,7 +1,7 @@
 import { UserIcon } from '@hugeicons/core-free-icons';
 import type { PartyRef, PartyRole } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
-import { findCustomers, type SyncDatabase } from '@omnivo/sync';
+import { findCustomers, type LocalCopy } from '@omnivo/sync';
 import { Combobox, type ComboboxOption } from '@omnivo/ui';
 import { useQuery } from '@tanstack/react-query';
 import { type Ref, useCallback, useMemo, useState } from 'react';
@@ -75,7 +75,7 @@ export function PartyPicker({
   // Both reads, each for its side only: a hook cannot be called conditionally
   const { view } = useLocalData();
   const stateText = useLocalStateText();
-  const find = useCallback((db: SyncDatabase) => findCustomers(db, settled), [settled]);
+  const find = useCallback((copy: LocalCopy) => findCustomers(copy, settled), [settled]);
   const customers = useLocalQuery(role === 'customer' && view.kind === 'ready' ? find : null);
   const suppliers = useQuery({
     ...supplierSearchQuery(tenantId, settled),
```

```diff
@@ -9,7 +9,7 @@ import {
 import { HugeiconsIcon } from '@hugeicons/react';
 import type { Product } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
-import { findProducts, productSummaryOf, type SyncDatabase } from '@omnivo/sync';
+import { findProducts, type LocalCopy, productSummaryOf } from '@omnivo/sync';
 import { Button, DialogContent, EmptyState, Input, Pill } from '@omnivo/ui';
 import { useCallback, useState } from 'react';
 
@@ -45,7 +45,7 @@ export function ProductPicker({
   const [loading, setLoading] = useState<string | null>(null);
   const [problem, setProblem] = useState<string | null>(null);
   const { view } = useLocalData();
-  const find = useCallback((db: SyncDatabase) => findProducts(db, settled), [settled]);
+  const find = useCallback((copy: LocalCopy) => findProducts(copy, settled), [settled]);
   const products = useLocalQuery(view.kind === 'ready' ? find : null);
 
   // onAdd may still ask the server (a purchase order's last price paid), so it can fail
```

```diff
@@ -1,11 +1,11 @@
-import { allRows, customerCommands, type SyncDatabase } from '@omnivo/sync';
+import { allRows, customerCommands, type LocalCopy } from '@omnivo/sync';
 import { useQuery } from '@tanstack/react-query';
 import { useParams } from '@tanstack/react-router';
 import { lazy, Suspense, useCallback } from 'react';
 
 import { CustomerNotFound, useTenantId } from '../components/customer-parts';
 import { LocalState, type WaitingView } from '../components/local-state';
-import { useLocalData, useLocalDb, useLocalQuery, useSaveMode } from '../lib/local-data';
+import { useLocalCopy, useLocalData, useLocalQuery, useSaveMode } from '../lib/local-data';
 import { useCan } from '../lib/permissions';
 import { customerGroupsQuery, customerQuery, priceListsQuery } from '../lib/queries';
 import { useOnline } from '../lib/use-online';
@@ -21,8 +21,8 @@ const CustomerForm = lazy(async () => ({
 }));
 
 // Reads of the device's copy: stable functions, so useLocalQuery subscribes once
-const readGroups = (db: SyncDatabase) => allRows(db.customerGroups);
-const readPriceLists = (db: SyncDatabase) => allRows(db.priceLists);
+const readGroups = (copy: LocalCopy) => allRows(copy, copy.db.customerGroups);
+const readPriceLists = (copy: LocalCopy) => allRows(copy, copy.db.priceLists);
 
 // What the form needs besides the customer: the groups and the price lists to pick from. Step
 // 18b: offline, the device's copy has them.
@@ -73,13 +73,13 @@ export function EditCustomerPage() {
   const canManage = useCan()('sales.customer.manage');
   const { groups, priceLists } = useFormData();
   const mode = useSaveMode(customerId);
-  const db = useLocalDb();
+  const copy = useLocalCopy();
   // The customer's refused command, if any: the form shows its errors under the boxes
   const readCommands = useCallback(
-    (database: SyncDatabase) => customerCommands(database, customerId),
+    (open: LocalCopy) => customerCommands(open, customerId),
     [customerId],
   );
-  const commands = useLocalQuery(db ? readCommands : null);
+  const commands = useLocalQuery(copy ? readCommands : null);
   const failed = commands?.find((command) => command.status === 'failed')?.error ?? null;
   // In device mode the query reads the device (queries.ts): the customer with its changes on it
   const { data: customer, isError } = useQuery({
```

```diff
@@ -29,8 +29,8 @@ import {
   allRows,
   customerPage,
   customerSummaryOf,
+  type LocalCopy,
   type LocalCustomerSort,
-  type SyncDatabase,
 } from '@omnivo/sync';
 import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';
 import { useNavigate } from '@tanstack/react-router';
@@ -62,7 +62,7 @@ function chunksOf(ids: readonly string[]): string[][] {
 }
 
 // A read must be one stable function (useLocalQuery)
-const readGroups = (db: SyncDatabase) => allRows(db.customerGroups);
+const readGroups = (copy: LocalCopy) => allRows(copy, copy.db.customerGroups);
 
 // The groups' answers as one map. Outside the component: TanStack runs `combine` again only when
 // the answers or the function change, so an inline function would make a new map (and sort the
@@ -114,7 +114,7 @@ export function CustomersPage() {
   const [grown, setGrown] = useState({ key: filterKey, limit: PAGE });
   const limit = grown.key === filterKey ? grown.limit : PAGE;
   const readPage = useCallback(
-    (db: SyncDatabase) => customerPage(db, { search: settled, groupId, sort, limit }),
+    (copy: LocalCopy) => customerPage(copy, { search: settled, groupId, sort, limit }),
     [settled, groupId, sort, limit],
   );
   const local = useLocalQuery(archived ? null : readPage);
```

```diff
@@ -26,10 +26,10 @@ import {
 } from '@omnivo/ui';
 import {
   allRows,
+  type LocalCopy,
   type LocalProductSort,
   productPage,
   productSummaryOf,
-  type SyncDatabase,
 } from '@omnivo/sync';
 import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
 import { useNavigate } from '@tanstack/react-router';
@@ -52,8 +52,8 @@ const PAGE = 100;
 
 // The small lists of the rows' categories and units, whole. Outside the component: a read must be
 // one stable function (useLocalQuery).
-const readCategories = (db: SyncDatabase) => allRows(db.productCategories);
-const readUnits = (db: SyncDatabase) => allRows(db.units);
+const readCategories = (copy: LocalCopy) => allRows(copy, copy.db.productCategories);
+const readUnits = (copy: LocalCopy) => allRows(copy, copy.db.units);
 
 // The table's sort → the list's. Two sortable columns, each with an index on the device and a
 // stable order on the server.
@@ -105,7 +105,7 @@ export function ProductsPage() {
   );
   // The active tab (decision 5): a live query, so a pull that changes a product changes its row
   const readPage = useCallback(
-    (db: SyncDatabase) => productPage(db, { search: settled, categoryIds, sort, limit }),
+    (copy: LocalCopy) => productPage(copy, { search: settled, categoryIds, sort, limit }),
     [settled, categoryIds, sort, limit],
   );
   const local = useLocalQuery(archived ? null : readPage);
```

```diff
@@ -1,6 +1,6 @@
 import { AlertCircleIcon, WifiDisconnected02Icon } from '@hugeicons/core-free-icons';
 import { useLocale } from '@omnivo/i18n';
-import { outboxOf, productsOfVariants, type SyncDatabase } from '@omnivo/sync';
+import { type LocalCopy, outboxOf, productsOfVariants } from '@omnivo/sync';
 import { EmptyState } from '@omnivo/ui';
 import { useQuery } from '@tanstack/react-query';
 import { useParams, useSearch } from '@tanstack/react-router';
@@ -10,7 +10,7 @@ import { LocalState } from '../components/local-state';
 import type { OutboxDraft } from '../components/sales-order-form';
 import { SalesBackLink } from '../components/sales-parts';
 import { useTenantId, useToday, useWarehouses } from '../components/stock-parts';
-import { useLocalData, useLocalDb, useLocalQuery } from '../lib/local-data';
+import { useLocalCopy, useLocalData, useLocalQuery } from '../lib/local-data';
 import { useCan } from '../lib/permissions';
 import { draftLines } from '../lib/sales';
 import { useOnline } from '../lib/use-online';
@@ -50,12 +50,12 @@ function useReady(): { pricesIncludeVat: boolean } | null {
 
 // A draft order waiting in the outbox under this id, with its lines' products from the device;
 // null = none (the order is the server's)
-async function readDraft(db: SyncDatabase, orderId: string): Promise<OutboxDraft | null> {
-  const [entry] = await outboxOf(db, orderId);
+async function readDraft(copy: LocalCopy, orderId: string): Promise<OutboxDraft | null> {
+  const [entry] = await outboxOf(copy, orderId);
   if (entry?.command.type !== 'sales_order.create_draft') return null;
   const { input } = entry.command;
   const products = await productsOfVariants(
-    db,
+    copy,
     input.lines.map((line) => line.variantId),
   );
   return {
@@ -128,17 +128,17 @@ export function SalesOrderPage() {
   const today = useToday();
   const ready = useReady();
   const online = useOnline();
-  const db = useLocalDb();
+  const copy = useLocalCopy();
   // Step 18b: a draft saved on this device opens from the outbox; the server is asked only when
   // there is none (it does not know the order yet)
-  const read = useCallback((database: SyncDatabase) => readDraft(database, orderId), [orderId]);
-  const draft = useLocalQuery(db ? read : null);
+  const read = useCallback((open: LocalCopy) => readDraft(open, orderId), [orderId]);
+  const draft = useLocalQuery(copy ? read : null);
   const { data: order, isError } = useQuery({
     ...salesOrderQuery(useTenantId(), orderId),
-    enabled: orderId !== '' && (db === null || draft === null),
+    enabled: orderId !== '' && (copy === null || draft === null),
   });
 
-  if (db && draft === undefined) return null;
+  if (copy && draft === undefined) return null;
   if (draft && ready) {
     return (
       <Suspense fallback={null}>
```

```diff
@@ -6,7 +6,7 @@ import {
 import { HugeiconsIcon } from '@hugeicons/react';
 import { ORDER_STATUSES, type OrderStatus, type SalesOrderSummary } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
-import { type OutboxEntry, outboxEntries, type SyncDatabase } from '@omnivo/sync';
+import { type LocalCopy, type OutboxEntry, outboxEntries } from '@omnivo/sync';
 import {
   Button,
   DataTable,
@@ -24,7 +24,7 @@ import { CustomerFilter } from '../components/customer-filter';
 import { OrderStatusPills } from '../components/sales-pills';
 import { useIsoDate, useTenantId, useToday } from '../components/stock-parts';
 import { NotSyncedPill, OutboxStatusPill } from '../components/sync-parts';
-import { useLocalDb, useLocalQuery } from '../lib/local-data';
+import { useLocalCopy, useLocalQuery } from '../lib/local-data';
 import { useCan } from '../lib/permissions';
 import { salesOrdersQuery } from '../lib/queries';
 import { useOnline } from '../lib/use-online';
@@ -42,8 +42,8 @@ interface UnsyncedOrder {
 const unsyncedColumn = dataTableColumns<UnsyncedOrder>();
 
 // A stable read (useLocalQuery): the outbox's orders, oldest first
-const readUnsynced = async (db: SyncDatabase) =>
-  (await outboxEntries(db)).flatMap((entry): UnsyncedOrder[] =>
+const readUnsynced = async (copy: LocalCopy) =>
+  (await outboxEntries(copy)).flatMap((entry): UnsyncedOrder[] =>
     entry.command.type === 'sales_order.create_draft'
       ? [{ id: entry.key, entry, date: entry.command.input.date }]
       : [],
@@ -53,8 +53,8 @@ function UnsyncedOrders() {
   const { t, format } = useLocale();
   const navigate = useNavigate();
   const isoDate = useIsoDate();
-  const db = useLocalDb();
-  const rows = useLocalQuery(db ? readUnsynced : null);
+  const copy = useLocalCopy();
+  const rows = useLocalQuery(copy ? readUnsynced : null);
   const columns = useMemo(
     () =>
       unsyncedColumn.columns([
```

- **A read inside `useCallback` names its parameter `open`** where the component already has a `copy` variable, so
  the read always uses the copy it is given, the one `useLocalQuery` watches.

### Check this part

```bash
pnpm --filter @omnivo/sync build
pnpm --filter @omnivo/sync test
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/app build
pnpm --filter @omnivo/app test:bundle-size
pnpm boundaries
pnpm exec eslint apps/app/src packages/sync/src
pnpm exec prettier --check apps/app/src packages/sync/src
```

All pass: 85 sync tests, the app's type check and build, and every budget: the first load is 213.8 KB of 215 KB,
the shell 108.0 KB, the lock screen 54.6 KB, the frame 6.9 KB, and the largest page chunk (the debit note's lines)
109.4 KB of 110 KB.

`pnpm --filter @omnivo/app test` has six failures, all in `offline-session.spec.ts`. They are expected: those 19a tests
open the app offline on a device whose copy has no PIN, and a copy without a PIN no longer opens offline (decision 5).
19b.5 gives them a PIN and adds tests for the rest of this part.

Also checked while writing this part:

- The first version drew the lock screen inside the `AppShell`. The shell's chunk went to 113.5 KB (it imported the
  device's store), and the lock screen's to 139.7 KB, because it shared an icon with the shell and Rollup put that
  icon in the shell's chunk. Moving the choice to the frame (decision 38) and dropping the icon fixed both.
- Reading the key's row with a `useLocalQuery` in the card and the menu put `keys.ts` into every page that reads the
  device, and the debit note's lines went to 110.6 KB. Decision 44 fixed it.
- Not checked in a browser yet: the mock mode has no handler for the key's route until 19b.5, and the real-API smoke
  test is 19b.6.

## 19b.5 — `apps/app`: the tests

19b.4 was checked only by the type check, the build and the budgets. This part makes the mock app answer the key's
route, keeps the e2e tests of the earlier steps working with the new PIN dialog, and adds the tests of the PIN: unit
tests for its rules and for the offline opening, a mock e2e file for the lock screen and the dialog, and the worker's
offline test with a PIN. Running them found three bugs in 19b.4's code; their fixes are shown in 19b.4, marked "found
by 19b.5", so a reader who typed 19b.4 first must apply them now:

- `closePin` (local-session.ts) closes the dialog only once "Not now" is saved;
- `start` (local-session.ts) reads the lock again before the copy is shown;
- the locked state's `signInAgain` became `forgetPin`, and the lock screen calls `signInAgain` itself (local-data.ts,
  local-session.ts, lock-screen.tsx).

```
pnpm --filter @omnivo/app test            pin.spec.ts               the PIN box's digits, easy PINs, the two forms
                                          offline-session.spec.ts   an offline reload with a PIN, none, or a blocked one;
                                                                     Lock now and the password; Forgot PIN
pnpm --filter @omnivo/app test:e2e        device-pin.e2e.ts         the PIN dialog, Lock now, wrong PINs, the password,
                                                                     the Sync page's card, two tabs, offline
                                          (every other file)        the fixture answers the PIN dialog "Not now"
pnpm --filter @omnivo/app test:e2e:pwa    offline.pwa.ts            no PIN: the sign-in page says why; with a PIN: the
                                                                     lock screen opens the copy offline
```

### `package.json`: `fake-indexeddb` for the app's unit tests

```diff
@@ -22,6 +22,7 @@
     "@types/react": "^19.3.0",
     "@types/react-dom": "^19.3.0",
     "@vitejs/plugin-react": "^6.1.1",
+    "fake-indexeddb": "^6.2.6",
     "msw": "^2.15.0",
     "tailwindcss": "^4.3.3",
     "typescript": "^6.0.3",
```

- **The same version as `packages/sync`'s** (decision 50), so pnpm keeps one copy. Run `pnpm install` after the change.

### `mocks/sync-data.ts` and `mocks/handlers.ts`: the device's key

```diff
@@ -1,6 +1,7 @@
 import {
   addQuantity,
   type Device,
+  type DeviceKey,
   isZeroQuantity,
   priceListItemKey,
   type RegisterDeviceInput,
@@ -187,6 +188,23 @@ export function deviceFor(data: WorkspaceData, userId: string, id: string): Devi
   return device;
 }
 
+// Step 19b: the device's key (the API's GET /sync/devices/:id/key), with the pull's checks. The
+// API keeps 32 random bytes per device; the mock works them out from the device's id instead. Its
+// data starts again at every reload, and the device registers again (device_not_found), so a
+// random key would be a new one after each reload: the app would find its copy sealed with
+// another key (key-changed) and ask for the PIN, or delete the copy.
+export async function deviceKey(
+  data: WorkspaceData,
+  userId: string,
+  id: string,
+): Promise<DeviceKey> {
+  deviceFor(data, userId, id);
+  const bytes = new Uint8Array(
+    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`omnivo-mock-key\n${id}`)),
+  );
+  return { key: btoa(String.fromCharCode(...bytes)) };
+}
+
 // --- The rows a device keeps --------------------------------------------------------------------
 
 // The stock in the branch's active warehouses, from the movements: one row per variant and batch,
```

- **`deviceFor` first:** the API's route answers the same two errors as a pull (`device_not_found` for another
  person's or an unknown device, `device_revoked` for a revoked one), so the app's revoke and register-again paths run
  in the mock as they do for real.
- **SHA-256 of the device's id** (decision 49): 32 bytes, the same at every reload. The text before the id
  (`omnivo-mock-key`) only keeps the key from being a plain hash of the id.
- **`btoa(String.fromCharCode(...bytes))`** is standard base64, 44 characters with one `=`, what the contract's
  regex accepts (19b.2). The spread is fine for 32 bytes; a large array would need a loop.

```diff
@@ -313,7 +313,7 @@ import {
   revokeDevice,
 } from './device-data';
 import { push } from './push-data';
-import { pull, registerDevice } from './sync-data';
+import { deviceKey, pull, registerDevice } from './sync-data';
 import {
   assertCodeFree,
   checkVersion,
@@ -5010,6 +5010,19 @@ export const handlers = [
     }),
   ),
 
+  // Step 19b: the device's key, asked at every online opening. It follows the sign-in like a pull,
+  // so a revoke after a reload still signs this browser out.
+  mock(
+    routes.sync.deviceKey,
+    guarded(async ({ params }) => {
+      const { id } = routes.sync.deviceKey.params.parse(params);
+      const data = current();
+      const key = await deviceKey(data, OWNER.id, id);
+      keepSession(data, id, sessionId);
+      return reply(routes.sync.deviceKey, key);
+    }),
+  ),
+
   // Step 18b: the commands a device saved offline (push-data.ts)
   mock(
     routes.sync.push,
```

- **`keepSession`** like the pull's handler: the key's request comes first after every reload, so a revoke right
  after a reload must still find this browser's sign-in on the device and sign it out (18c's decision 3).
- **No `delay()`:** the app asks for the key at every opening, before anything shows, and the mock's 300 ms would
  only make every test slower.

### `mocks/offline-screens.ts`: the lock screen and the PIN dialog

```diff
@@ -22,6 +22,10 @@ const SCREENS = [
   () => import('../routes/sync'),
   () => import('../components/sign-out-dialog'),
   () => import('../routes/login'),
+  // Step 19b: "Lock now" offline closes the shell, and the lock screen takes its place; the PIN
+  // dialog (a change with the current PIN works offline)
+  () => import('../components/lock-screen'),
+  () => import('../components/pin-dialog'),
 ];
 
 // Once, by main.tsx's enableMocking. The dev server is on this computer, so it does not fail.
```

- **"Lock now" offline** closes the shell and loads the lock screen's chunk. Mock mode has no worker of ours to keep
  it (19a's decision 11), so without this line the offline test below would wait for a chunk that cannot load. The
  PIN dialog is here because a change of PIN works offline.

### `e2e/helpers.ts`: the fixture answers the PIN dialog

```diff
@@ -36,11 +36,27 @@ function copyOf(page: Page): Promise<void> {
 // again (device_not_found → registerAgain) and the dialog never shows. The key and the value come
 // from @omnivo/sync's own saveDevice(), so their format is written in one place. A test of the
 // dialog itself turns this off with test.use({ seedDevice: false }).
-export const test = base.extend<{ seedDevice: boolean }>({
+//
+// Step 19b: the first opening of a copy asks for a device PIN (decision 5), in every test that sets
+// up a device. The fixture answers "Not now" whenever the dialog shows, before the test's next
+// action or assertion (Playwright's locator handler), so the tests of step 18 and before run as
+// they did. A test of the PIN itself turns this off with test.use({ answerPinDialog: false }).
+// The dialog closes a menu or a panel that was open: a test that opens one right after the first
+// load waits for the copy first (waitForCopy), so the dialog has shown and is answered before.
+export const test = base.extend<{ seedDevice: boolean; answerPinDialog: boolean }>({
   seedDevice: [true, { option: true }],
+  answerPinDialog: [true, { option: true }],
   // `provide`, not Playwright's usual `use`: the React hooks lint rule reads `use(…)` as a hook
-  page: async ({ page, seedDevice }, provide) => {
+  page: async ({ page, seedDevice, answerPinDialog }, provide) => {
     copies.set(page, copyOf(page));
+    if (answerPinDialog) {
+      await page.addLocatorHandler(
+        page.getByRole('dialog', { name: 'Set a PIN for this device' }),
+        async (dialog) => {
+          await dialog.getByRole('button', { name: 'Not now' }).click();
+        },
+      );
+    }
     if (seedDevice) {
       const [garments] = WORKSPACES;
       const saved = new Map<string, string>();
@@ -113,8 +129,14 @@ export async function expectNoSideScroll(page: Page): Promise<void> {
 
 // A toast, then wait for it to close. On a phone it sits over the buttons at the bottom of the
 // page, and it stays open while the pointer that just clicked rests on it: move the pointer away.
-export async function toastShown(page: Page, text: string | RegExp): Promise<void> {
-  await expect(page.getByText(text)).toBeVisible();
+// Step 19b: `timeout` for a toast that waits for the copy to open (the branch dialog's).
+export async function toastShown(
+  page: Page,
+  text: string | RegExp,
+  timeout?: number,
+): Promise<void> {
+  // No `timeout` key without a value (exactOptionalPropertyTypes): the config's 5 seconds
+  await expect(page.getByText(text)).toBeVisible(timeout === undefined ? {} : { timeout });
   await page.mouse.move(0, 0);
   await expect(page.getByText(text)).toBeHidden();
 }
```

- **`addLocatorHandler`** (decision 48) runs before every action and every auto-waiting assertion, and only when the
  dialog is visible. After the handler, Playwright waits for the dialog to be hidden, then goes on with the step.
- **By its name, "Set a PIN for this device":** the other PIN dialogs (a new PIN after the password, a change) open
  only in the PIN tests, which turn the handler off.
- **Registered before the page loads anything,** next to the copy's listener, so it is there however soon the dialog
  shows.
- **`toastShown` takes a `timeout`** for the branch dialog's toast (below), which waits for the copy to open. The
  conditional object is for `exactOptionalPropertyTypes`: `{ timeout: undefined }` does not type-check, and `{}` keeps
  the config's 5 seconds.

### The tests that meet the dialog: `notifications`, `onboarding`, `requisitions` and `sync`

```diff
@@ -1,9 +1,12 @@
-import { expect, expectNoSideScroll, test } from './helpers.js';
+import { expect, expectNoSideScroll, test, waitForCopy } from './helpers.js';
 
 // The mock's Rahman Garments owner has three unread notifications (step 17a added a requisition
 // waiting for approval) and one read one
 test('reads notifications from the bell', async ({ page }) => {
   await page.goto('/');
+  // Step 19b: the PIN dialog opens before the first pull ends, and it would close the bell's panel
+  // if it opened just after the click. After the copy, the fixture answers it before the click.
+  await waitForCopy(page);
   const bell = page.getByRole('button', { name: 'Notifications, 3 unread' });
   await bell.click();
   const panel = page.getByRole('dialog');
```

```diff
@@ -1,11 +1,14 @@
 import type { Page } from '@playwright/test';
 
-import { expect, expectNoSideScroll, test } from './helpers.js';
+import { expect, expectNoSideScroll, test, waitForCopy } from './helpers.js';
 
 // The mock starts signed in (as the Rahman Garments owner). Sign out through the menu — client-side,
 // so the mock keeps its state — then create a new workspace from the sign-up page.
 async function signUpNewWorkspace(page: Page): Promise<void> {
   await page.goto('/');
+  // Step 19b: the PIN dialog opens before the first pull ends, and it would close the account
+  // menu if it opened just after the click. After the copy, the fixture answers it first.
+  await waitForCopy(page);
   // Desktop: the account button at the bottom of the sidebar; phone: the icon in the top bar.
   // Only one of them is visible at a time.
   await page
```

```diff
@@ -1,6 +1,14 @@
 import type { Page } from '@playwright/test';
 
-import { expect, expectNoSideScroll, listItem, openFromNav, test, toastShown } from './helpers.js';
+import {
+  expect,
+  expectNoSideScroll,
+  listItem,
+  openFromNav,
+  test,
+  toastShown,
+  waitForCopy,
+} from './helpers.js';
 
 // Step 17a in the mock garments workspace, where the signed-in person is the Owner. Requisitions
 // from ৳20,000 need the Purchase manager (Kamal Uddin), from ৳1,00,000 a Director as well, a role
@@ -179,6 +187,9 @@ test('cancels an approved requisition, reopens a waiting one, and deletes a draf
 });
 
 test('opens the waiting requisition from the bell', async ({ page }) => {
+  // Step 19b: the PIN dialog opens before the first pull ends, and it would close the bell's panel
+  // if it opened just after the click. After the copy, the fixture answers it before the click.
+  await waitForCopy(page);
   await page.getByRole('button', { name: 'Notifications, 3 unread' }).click();
   const panel = page.getByRole('dialog');
   await panel
```

- **`waitForCopy` before the first click** (decision 48). These tests open the bell's panel or the account menu right
  after the page loads. The PIN dialog opens about a second later, before the first pull ends, and a modal dialog
  closes a panel that is open: the next click then finds nothing. After the copy, the dialog has shown, and the
  fixture answers it before the click. On a phone the bell test failed this way in two runs of three.

```diff
@@ -19,7 +19,9 @@ function localDatabases(page: Page): Promise<string[]> {
 }
 
 test.describe('a device without a branch', () => {
-  test.use({ seedDevice: false });
+  // Step 19b: the PIN dialog opens with the branch's toast, so this test answers it itself: the
+  // fixture's handler, run before the toast's check, could take longer than the toast stays
+  test.use({ seedDevice: false, answerPinDialog: false });
 
   test('asks which branch it is in, and offers it again where the copy is needed', async ({
     page,
@@ -45,7 +47,13 @@ test.describe('a device without a branch', () => {
     await page.getByRole('button', { name: 'Choose the branch' }).click();
     await dialog.getByLabel('Branch').selectOption({ label: 'CTG · Chattogram depot' });
     await dialog.getByRole('button', { name: 'Use this branch' }).click();
-    await toastShown(page, 'This device is set up for Chattogram depot');
+    // The toast waits for the copy to open (the key, then the in-memory tables), while other tests
+    // copy 10,000 styles. The PIN dialog opens at the same moment, after its own chunk loads.
+    await toastShown(page, 'This device is set up for Chattogram depot', 15_000);
+    await page
+      .getByRole('dialog', { name: 'Set a PIN for this device' })
+      .getByRole('button', { name: 'Not now' })
+      .click();
     await waitForCopy(page);
 
     await page.getByRole('searchbox', { name: 'Search products' }).fill('pique');
```

- **The branch test answers the dialog itself:** choosing the branch always opens it, at the same moment as the
  toast. With the fixture's handler, the handler ran before the toast's check and, on a busy machine, the toast's
  3 seconds were over by then.
- **15 seconds for the toast:** it shows once the copy has opened (the key's request, the key's unwrap and the
  in-memory tables, which 19b added), while other workers seal 10,000 styles each. The PIN dialog draws later, after
  its own chunk, so the toast comes first in the test.

### `lib/pin.spec.ts` (new)

```ts
import { describe, expect, it } from 'vitest';

import { isEasyPin, pinDigits, pinFormSchema, unlockFormSchema } from './pin';

// Step 19b: the PIN box's rules, and the forms of the lock screen and the PIN dialog

describe('pinDigits', () => {
  it('turns Bangla digits into ASCII ones', () => {
    expect(pinDigits('৪৮০৯১৫')).toBe('480915');
    expect(pinDigits('৪8০9১5')).toBe('480915');
  });

  it('drops what is not a digit, and stops at six', () => {
    expect(pinDigits(' 48-09 15 ')).toBe('480915');
    expect(pinDigits('4809157')).toBe('480915');
    expect(pinDigits('pin')).toBe('');
  });

  it('drops digits of other scripts, which isPin would refuse', () => {
    // Arabic-Indic and Devanagari digits: a Bangla keyboard never types them
    expect(pinDigits('٤٨٠९१५')).toBe('');
  });
});

describe('isEasyPin (decision 30)', () => {
  it('refuses six of the same digit and straight runs both ways', () => {
    for (const pin of ['000000', '777777', '123456', '012345', '456789', '987654', '543210']) {
      expect(isEasyPin(pin), pin).toBe(true);
    }
  });

  it('accepts everything else, a run that wraps too', () => {
    for (const pin of ['480915', '135790', '112233', '123457', '890123', '246802']) {
      expect(isEasyPin(pin), pin).toBe(false);
    }
  });
});

describe('the forms', () => {
  it('unlocks with any six digits, an easy PIN set before too', () => {
    expect(unlockFormSchema.safeParse({ pin: '123456' }).success).toBe(true);
    expect(unlockFormSchema.safeParse({ pin: '12345' }).error?.issues[0]).toMatchObject({
      path: ['pin'],
      message: 'pin_format',
    });
  });

  it('refuses an easy new PIN, and two PINs that differ under the second box', () => {
    const form = pinFormSchema(false);
    expect(form.safeParse({ current: '', pin: '480915', repeat: '480915' }).success).toBe(true);
    expect(
      form.safeParse({ current: '', pin: '123456', repeat: '123456' }).error?.issues[0],
    ).toMatchObject({ path: ['pin'], message: 'pin_too_easy' });
    expect(
      form.safeParse({ current: '', pin: '480915', repeat: '480916' }).error?.issues[0],
    ).toMatchObject({ path: ['repeat'], message: 'pin_mismatch' });
  });

  it('needs the current PIN for a change, and only then', () => {
    const change = pinFormSchema(true);
    expect(
      change.safeParse({ current: '', pin: '480915', repeat: '480915' }).error?.issues[0],
    ).toMatchObject({
      path: ['current'],
      message: 'pin_format',
    });
    expect(change.safeParse({ current: '135790', pin: '480915', repeat: '480915' }).success).toBe(
      true,
    );
    // A new PIN after "Forgot PIN?": no current one to type
    expect(
      pinFormSchema(false).safeParse({ current: '135790', pin: '480915', repeat: '480915' })
        .success,
    ).toBe(false);
  });
});
```

- **Bangla digits mixed with ASCII ones** (`৪8০9১5`): a person may switch keyboards half way, and both are digits.
- **Arabic-Indic and Devanagari digits are dropped,** not converted: `pinDigits` converts only the script the app
  speaks, and `isPin` (six ASCII digits) would refuse the rest anyway.
- **`890123` is not easy** (decision 30): only straight runs that do not wrap. `112233` and `246802` are not easy
  either; the rule is about the first guesses, not every pattern.
- **The forms' messages are codes** (`pin_format`, `pin_too_easy`, `pin_mismatch`), checked with the issue's path, so
  the test also proves which box shows the error: the mismatch under the second box, not the first.
- **A new PIN with a `current` value fails:** the form for a new PIN sends `''`, which is how the session knows to
  use the server's key (19b.4's `savePin`).

### `lib/offline-session.spec.ts`: the copy and its PIN

```diff
@@ -1,5 +1,17 @@
+import 'fake-indexeddb/auto';
+
 import { type MeResponse, routes } from '@omnivo/contracts';
-import { newDeviceId, readDevice, saveDevice } from '@omnivo/sync';
+import {
+  databaseName,
+  deleteLocalDatabase,
+  MAX_WRONG_PINS,
+  newDeviceId,
+  openKey,
+  readDevice,
+  saveDevice,
+  setPin,
+  SyncDatabase,
+} from '@omnivo/sync';
 import { http, HttpResponse } from 'msw';
 import { setupServer } from 'msw/node';
 import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
@@ -8,11 +20,24 @@ import { HEAD_OFFICES, meIn, WORKSPACES } from '../mocks/fixtures';
 import { mock, problem, reply } from '../mocks/mock';
 import { seedPeople } from '../mocks/people-data';
 import { API_URL } from './api';
+import { LOCKED_KEY, rememberedMe } from './remembered-session';
 
 // Step 19a: the offline opening, the check when the server answers again, and the sign-out with
 // no connection. A test "reloads the page" with vi.resetModules(): every module of the app starts
 // again (the session store, restoreSession's promise, the offline check), and only the browser's
 // localStorage stays, as after a real reload.
+// Step 19b: and the device's IndexedDB (fake-indexeddb, in memory), where the copy keeps its key
+// and its PIN: an offline reload opens only a copy the PIN can open.
+
+// Step 19b: logout() deletes the copy through a lazy import of local-session.ts that it does not
+// wait for. For real, that delete would land in a later test and delete the copy that test made,
+// so the spy stands in for it, and the tests check that it was asked for.
+const { deleteLocalData } = vi.hoisted(() => ({
+  deleteLocalData: vi.fn<(tenantId: string, userId: string) => Promise<void>>(() =>
+    Promise.resolve(),
+  ),
+}));
+vi.mock('./local-session', () => ({ deleteLocalData }));
 
 const server = setupServer();
 
@@ -48,13 +73,32 @@ function stubBrowser(): void {
   });
 }
 
-// The device copy of step 18a: a branch chosen for this person on this browser
-function setUpDevice(): void {
+const SERVER_KEY = new Uint8Array(32).fill(7);
+const PIN = '480915';
+// Few rounds: the real 600,000 would take a second per PIN, and these tests never type it
+const ROUNDS = 1000;
+
+// The device copy of step 18a: a branch chosen for this person on this browser. Step 19b: opened
+// once online (the server's key made its key), and then, as the test asks, a PIN set, none, or
+// one that stopped working after five wrong ones.
+async function setUpDevice(pin: 'set' | 'none' | 'blocked' = 'set'): Promise<void> {
   saveDevice(storage, garments.tenantId, me.user.id, {
     id: newDeviceId(),
     branchId: HEAD_OFFICES[garments.slug],
     later: false,
   });
+  const db = new SyncDatabase(databaseName(garments.tenantId, me.user.id));
+  try {
+    await openKey(db, { serverKey: SERVER_KEY });
+    if (pin === 'none') return;
+    await setPin(db, { serverKey: SERVER_KEY }, PIN, ROUNDS);
+    if (pin === 'set') return;
+    for (let guess = 0; guess < MAX_WRONG_PINS; guess += 1) {
+      await openKey(db, { pin: '000001' });
+    }
+  } finally {
+    db.close();
+  }
 }
 
 // A new page load: new modules, the same storage
@@ -81,7 +125,7 @@ async function signedInOnce(): Promise<App> {
 
 // A reload with no connection, after an online visit on a device with a copy
 async function openedOffline(): Promise<App> {
-  setUpDevice();
+  await setUpDevice();
   await signedInOnce();
   server.use(http.post(`${API_URL}/auth/refresh`, () => HttpResponse.error()));
   app = await reload();
@@ -98,13 +142,16 @@ beforeAll(() => {
 });
 beforeEach(() => {
   stubBrowser();
+  deleteLocalData.mockClear();
 });
-afterEach(() => {
+afterEach(async () => {
   // A test that ends opened offline stops its watch for the server here
   app?.sessionStore.getState().signOut();
   app = null;
   server.resetHandlers();
   vi.unstubAllGlobals();
+  // Step 19b: the next test starts from a browser with no copy
+  await deleteLocalDatabase(garments.tenantId, me.user.id);
 });
 afterAll(() => {
   server.close();
@@ -130,7 +177,7 @@ describe('a reload with no answer from the server (step 19a)', () => {
   });
 
   it('treats a 502 from a proxy as no answer, and a refusal as the end of the sign-in', async () => {
-    setUpDevice();
+    await setUpDevice();
     await signedInOnce();
     server.use(mock(routes.auth.refresh, () => problem(502, 'unknown_error')));
     app = await reload();
@@ -150,7 +197,7 @@ describe('a reload with no answer from the server (step 19a)', () => {
   });
 
   it('does not trust a remembered person the contract no longer accepts', async () => {
-    setUpDevice();
+    await setUpDevice();
     // What an older version of the app could have saved: a `me` without a field added since
     // (JSON leaves out a key whose value is undefined)
     storage.setItem('omnivo.me', JSON.stringify({ ...me, preferences: undefined }));
@@ -266,6 +313,10 @@ describe('a sign-out with no connection (step 19a)', () => {
     server.use(http.post(`${API_URL}/auth/logout`, () => HttpResponse.error()));
     await signedIn.logout();
     expect(signedIn.sessionStore.getState().status).toBe('signed-out');
+    // Step 18a: the copy goes with the sign-out, offline too
+    await vi.waitFor(() => {
+      expect(deleteLocalData).toHaveBeenCalledWith(garments.tenantId, me.user.id);
+    });
     server.resetHandlers();
     return signedIn;
   }
@@ -342,3 +393,116 @@ describe('a sign-out with no connection (step 19a)', () => {
     });
   });
 });
+
+describe('the device PIN at an offline reload (step 19b)', () => {
+  // An online visit, then a reload with no connection
+  async function reloadedOffline(): Promise<App> {
+    await signedInOnce();
+    server.use(http.post(`${API_URL}/auth/refresh`, () => HttpResponse.error()));
+    app = await reload();
+    await app.restoreSession();
+    return app;
+  }
+
+  it('shows the sign-in page with its own notice on a copy without a PIN', async () => {
+    await setUpDevice('none');
+    const reloaded = await reloadedOffline();
+    expect(reloaded.sessionStore.getState()).toMatchObject({
+      status: 'signed-out',
+      notice: 'no_pin',
+      me: null,
+    });
+    // The server still has the sign-in, so the person is remembered: the next reload with no
+    // connection says the same, not the plain offline notice
+    expect(rememberedMe()?.user.id).toBe(me.user.id);
+    app = await reload();
+    await app.restoreSession();
+    expect(app.sessionStore.getState().notice).toBe('no_pin');
+  });
+
+  it('opens a copy whose PIN stopped working, so the lock screen can say what to do', async () => {
+    await setUpDevice('blocked');
+    const reloaded = await reloadedOffline();
+    expect(reloaded.sessionStore.getState()).toMatchObject({
+      status: 'signed-in',
+      openedOffline: true,
+    });
+  });
+
+  it('opens online as before on a copy without a PIN', async () => {
+    await setUpDevice('none');
+    await signedInOnce();
+    server.use(
+      mock(routes.auth.refresh, () => reply(routes.auth.refresh, session('fresh'))),
+      mock(routes.auth.me, () => reply(routes.auth.me, me)),
+    );
+    app = await reload();
+    await app.restoreSession();
+    expect(app.sessionStore.getState()).toMatchObject({
+      status: 'signed-in',
+      openedOffline: false,
+    });
+  });
+});
+
+describe('Lock now and the password (step 19b)', () => {
+  const credentials = {
+    workspace: garments.slug,
+    email: 'farhana@rahmangarments.com',
+    password: 'Gazipur-knit-2026',
+    keepSignedIn: true,
+  };
+
+  it('keeps the lock after a reload, and ends it at a sign-in with the password', async () => {
+    await setUpDevice();
+    await signedInOnce();
+    storage.setItem(LOCKED_KEY, '1');
+    server.use(
+      mock(routes.auth.refresh, () => reply(routes.auth.refresh, session('fresh'))),
+      mock(routes.auth.me, () => reply(routes.auth.me, me)),
+      mock(routes.auth.login, () => reply(routes.auth.login, session('password'))),
+    );
+    // A reload's refresh proves nothing about who sits at the computer
+    app = await reload();
+    await app.restoreSession();
+    expect(app.sessionStore.getState().status).toBe('signed-in');
+    expect(storage.items.has(LOCKED_KEY)).toBe(true);
+
+    await app.login(credentials);
+    expect(storage.items.has(LOCKED_KEY)).toBe(false);
+  });
+
+  it('keeps the lock when the password is wrong', async () => {
+    storage.setItem(LOCKED_KEY, '1');
+    server.use(mock(routes.auth.login, () => problem(401, 'invalid_credentials')));
+    app = await reload();
+    await expect(app.login(credentials)).rejects.toThrow();
+    expect(storage.items.has(LOCKED_KEY)).toBe(true);
+  });
+
+  it('“Forgot PIN?” ends the sign-in on the server too, and keeps the copy', async () => {
+    await setUpDevice();
+    const signedIn = await signedInOnce();
+    const sent: string[] = [];
+    server.use(
+      mock(routes.auth.logout, () => {
+        sent.push('logout');
+        return reply(routes.auth.logout, undefined);
+      }),
+    );
+    await signedIn.signInAgain();
+    expect(sent).toEqual(['logout']);
+    expect(signedIn.sessionStore.getState()).toMatchObject({
+      status: 'signed-out',
+      notice: 'pin_reset',
+    });
+    // The password opens it again with the server's key (decision 35)
+    expect(deleteLocalData).not.toHaveBeenCalled();
+    expect(readDevice(storage, garments.tenantId, me.user.id).branchId).toBe(
+      HEAD_OFFICES[garments.slug],
+    );
+    const db = new SyncDatabase(databaseName(garments.tenantId, me.user.id));
+    await expect(openKey(db, { serverKey: SERVER_KEY })).resolves.toMatchObject({ kind: 'open' });
+    db.close();
+  });
+});
```

- **`import 'fake-indexeddb/auto'` first,** before `@omnivo/sync` and with it Dexie load, so Dexie finds the fake
  `indexedDB` on the global object.
- **`setUpDevice` opens the copy with a server key, as an online visit does,** then sets the PIN with `setPin` (or not,
  or types five wrong PINs). These are `@omnivo/sync`'s own functions (decision 50): the six 19a tests that failed after
  19b.4 pass again because their device now has what a real one would.
- **The `vi.mock` of `./local-session`:** 19a's sign-out tests call `logout()`, which deletes the copy through a
  lazy import that it does not wait for. In this file that delete landed in a later test and deleted the copy that test
  had just made; a test passed alone and failed in the run. The spy stands in for it, and `signedOutOffline` now checks
  that the delete was asked for. `vi.hoisted` makes the spy before the hoisted `vi.mock` runs.
- **`afterEach` deletes the database,** so each test starts from a browser with no copy, as `stubBrowser` starts it
  with an empty localStorage.
- **"its own notice":** `no_pin` keeps the remembered person (19b.4's session-store change), and the test proves why it
  matters: the second offline reload says the same, not the plain offline notice.
- **"stopped working" opens offline:** the lock screen then says to sign in when online (decision 7). Without
  `|| status.pinBlocked` in `hasPin`, this test fails.
- **"opens online as before":** a copy without a PIN is no problem online; the PIN is only for offline and the lock.
- **The lock and the password:** a reload's refresh keeps the lock (it proves nothing about who is at the computer),
  a sign-in with the password ends it, and a wrong password does not. The last one fails if `clearLocked()` runs before
  the request instead of after it.
- **"Forgot PIN?":** the server hears the sign-out (`logout` was sent), the notice is `pin_reset`, the copy was not
  deleted (the spy), the device's identity stays, and the server's key still opens the copy. That is everything the
  password needs to open it again.

### `e2e/device-pin.e2e.ts` (new)

```ts
import type { Page } from '@playwright/test';

import { expect, openFromNav, test, toastShown } from './helpers.js';

// Step 19b: the device PIN in the mock app. The mock's key route answers the same key for a device
// at every reload (sync-data.ts), as the API does, so a reload opens the same copy. These tests
// answer the PIN dialog themselves.
test.use({ answerPinDialog: false });
// Each PIN typed or set takes up to a second on purpose (600,000 PBKDF2 rounds, decision 15), and
// a test types up to seven while the mock copies 10,000 styles: 30 seconds is too tight on a busy
// machine
test.describe.configure({ timeout: 90_000 });

const PIN = '480915';
// The same PIN typed on a Bangla keyboard
const BANGLA_PIN = '৪৮০৯১৫';

function setUpDialog(page: Page) {
  return page.getByRole('dialog', { name: 'Set a PIN for this device' });
}

function lockScreen(page: Page) {
  return page.getByRole('heading', { level: 1, name: 'Omnivo is locked' });
}

// Desktop: the account button at the bottom of the sidebar; phone: the icon in the top bar
async function openAccountMenu(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: /Farhana Rahman/ })
    .or(page.getByRole('button', { name: 'Account' }))
    .filter({ visible: true })
    .click();
}

async function setPinInDialog(page: Page, pin = PIN): Promise<void> {
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('PIN', { exact: true }).fill(pin);
  await dialog.getByLabel('Type the PIN again').fill(pin);
  await dialog.getByRole('button', { name: 'Set PIN' }).click();
  await toastShown(page, 'Device PIN set');
}

async function lockNow(page: Page): Promise<void> {
  await openAccountMenu(page);
  await page.getByRole('menuitem', { name: 'Lock now' }).click();
  await expect(lockScreen(page)).toBeVisible();
}

async function typePin(page: Page, pin: string): Promise<void> {
  await page.getByLabel('PIN', { exact: true }).fill(pin);
  await page.getByRole('button', { name: 'Unlock' }).click();
}

// The sign-in page after "Forgot PIN?" or a PIN that stopped working
async function signInWithPassword(page: Page): Promise<void> {
  await page.getByLabel('Workspace').fill('rahman-garments');
  await page.getByLabel('Email').fill('farhana@rahmangarments.com');
  await page.getByLabel('Password', { exact: true }).fill('Gazipur-knit-2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
}

// The Sync page's card, once the copy is open (the card shows only then). Its pill is the only
// text on the page that says exactly this.
async function pinCard(page: Page, state: 'No PIN' | 'PIN set'): Promise<void> {
  await openFromNav(page, /^Sync/);
  await expect(page.getByRole('heading', { name: 'Device PIN' })).toBeVisible();
  await expect(page.getByText(state, { exact: true })).toBeVisible();
}

test('asks for a PIN once the device is set up, and “Not now” is the answer for this copy', async ({
  page,
}) => {
  await page.goto('/');
  const dialog = setUpDialog(page);
  // After the key's request and the copy's opening, while other tests pull 10,000 styles
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(
    dialog.getByText('Without a PIN, the data on this device opens only online.', { exact: false }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Not now' }).click();
  await expect(dialog).toBeHidden();

  // Not asked again after a reload; the card still offers it
  await page.reload();
  await pinCard(page, 'No PIN');
  await expect(setUpDialog(page)).toHaveCount(0);

  // "Lock now" without a PIN opens the dialog instead
  await openAccountMenu(page);
  await page.getByRole('menuitem', { name: 'Set a PIN to lock' }).click();
  await expect(setUpDialog(page)).toBeVisible();
});

test('refuses an easy PIN and two different ones, then locks and unlocks with the PIN', async ({
  page,
}) => {
  await page.goto('/');
  const dialog = setUpDialog(page);
  await dialog.getByLabel('PIN', { exact: true }).fill('123456');
  await dialog.getByLabel('Type the PIN again').fill('123456');
  await dialog.getByRole('button', { name: 'Set PIN' }).click();
  await expect(
    dialog.getByText('Pick a PIN that is harder to guess than 123456 or 000000.'),
  ).toBeVisible();
  await dialog.getByLabel('PIN', { exact: true }).fill(PIN);
  await dialog.getByLabel('Type the PIN again').fill('480916');
  await dialog.getByRole('button', { name: 'Set PIN' }).click();
  await expect(
    dialog.getByText('The two PINs are different. Type the same 6 digits in both boxes.'),
  ).toBeVisible();
  await setPinInDialog(page);
  await pinCard(page, 'PIN set');

  await lockNow(page);
  // The person, so a shared computer shows whose work is locked
  await expect(page.getByText('farhana@rahmangarments.com')).toBeVisible();
  // The lock survives a reload: the server's key alone does not open a locked copy
  await page.reload();
  await expect(lockScreen(page)).toBeVisible();
  await expect(page.getByText('Type the PIN of this device to open your work.')).toBeVisible();

  await typePin(page, '111111');
  await expect(
    page.getByText('Wrong PIN. 4 tries left, then the PIN stops working.'),
  ).toBeVisible();
  // The field is empty again for the next try
  await expect(page.getByLabel('PIN', { exact: true })).toHaveValue('');
  // Bangla digits become ASCII ones as they are typed
  await page.getByLabel('PIN', { exact: true }).fill(BANGLA_PIN);
  await expect(page.getByLabel('PIN', { exact: true })).toHaveValue(PIN);
  await page.getByRole('button', { name: 'Unlock' }).click();
  // The page it was locked on (a reload keeps the address)
  await expect(page.getByRole('heading', { level: 1, name: 'Sync' })).toBeVisible();

  // The right PIN ended the lock: the next reload opens the app
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Sync' })).toBeVisible();
  await expect(lockScreen(page)).toHaveCount(0);
});

test('five wrong PINs stop the PIN; the password opens the copy and a new PIN is set', async ({
  page,
}) => {
  await page.goto('/');
  await setPinInDialog(page);
  await lockNow(page);
  for (const left of [4, 3, 2, 1]) {
    await typePin(page, '111111');
    const tries = left === 1 ? 'try' : 'tries';
    await expect(
      page.getByText(`Wrong PIN. ${String(left)} ${tries} left, then the PIN stops working.`),
    ).toBeVisible();
  }
  await typePin(page, '111111');
  await expect(
    page.getByText(
      'The PIN was wrong 5 times, so it stopped working. Sign in with your password to open your work.',
    ),
  ).toBeVisible();
  await expect(page.getByLabel('PIN', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Sign in with your password' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await expect(
    page.getByText(
      'Sign in with your password to open your work on this device. You then set a new PIN.',
    ),
  ).toBeVisible();
  await signInWithPassword(page);

  const dialog = page.getByRole('dialog', { name: 'Set a new PIN' });
  await expect(dialog.getByText('The old PIN no longer works.', { exact: false })).toBeVisible();
  await setPinInDialog(page, '135790');
  await pinCard(page, 'PIN set');
  await lockNow(page);
  await typePin(page, '135790');
  await expect(page.getByRole('heading', { level: 1, name: 'Sync' })).toBeVisible();
});

test('“Forgot PIN?” signs in with the password, and the copy stays', async ({ page }) => {
  await page.goto('/');
  await setPinInDialog(page);
  await lockNow(page);
  await page.getByRole('button', { name: 'Forgot PIN? Sign in with your password' }).click();
  await expect(
    page.getByText(
      'Sign in with your password to open your work on this device. You then set a new PIN.',
    ),
  ).toBeVisible();
  await signInWithPassword(page);

  // The password ended the lock; the PIN went, so the dialog asks for one
  await expect(setUpDialog(page)).toBeVisible();
  await setPinInDialog(page, '246802');
  await openFromNav(page, 'Customers');
  await expect(page.getByText('H&M Hennes & Mauritz').first()).toBeVisible();
});

test('changes the PIN on the Sync page with the current one', async ({ page }) => {
  await page.goto('/');
  await setPinInDialog(page);
  await pinCard(page, 'PIN set');
  await page.getByRole('button', { name: 'Change PIN' }).click();

  const dialog = page.getByRole('dialog', { name: 'Change the PIN of this device' });
  await dialog.getByLabel('Current PIN').fill('111111');
  await dialog.getByLabel('New PIN').fill('135790');
  await dialog.getByLabel('Type the PIN again').fill('135790');
  await dialog.getByRole('button', { name: 'Change PIN' }).click();
  await expect(
    dialog.getByText('Wrong PIN. 4 tries left, then the PIN stops working.'),
  ).toBeVisible();
  await dialog.getByLabel('Current PIN').fill(PIN);
  await dialog.getByRole('button', { name: 'Change PIN' }).click();
  await toastShown(page, 'Device PIN changed');

  await lockNow(page);
  await typePin(page, PIN);
  await expect(page.getByText('Wrong PIN. 4 tries left', { exact: false })).toBeVisible();
  await typePin(page, '135790');
  await expect(page.getByRole('heading', { level: 1, name: 'Sync' })).toBeVisible();
});

test('“Lock now” in one tab locks the other, and the PIN in one opens both', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await setPinInDialog(page);
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();

  await lockNow(page);
  await expect(lockScreen(other)).toBeVisible();
  await typePin(page, PIN);
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await expect(other.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
});

test('locks and unlocks with no connection', async ({ page, context }) => {
  await page.goto('/');
  await setPinInDialog(page);
  await pinCard(page, 'PIN set');
  await context.setOffline(true);
  await lockNow(page);
  // The password needs the server: offline the screen says what to do instead
  await expect(
    page.getByText('Forgot your PIN? Connect to the internet, then sign in with your password.'),
  ).toBeVisible();
  await typePin(page, PIN);
  await expect(page.getByRole('heading', { level: 1, name: 'Sync' })).toBeVisible();
  await expect(page.getByText('Offline', { exact: true }).first()).toBeVisible();
});
```

- **`test.use({ answerPinDialog: false })`** for the whole file: these tests answer the dialog themselves.
- **`test.describe.configure({ timeout: 90_000 })`** (decision 52).
- **The first test waits up to 15 seconds for the dialog:** it shows after the key's request, the registration and
  the copy's opening, and the first test of a run also waits for the dev server to build the chunks. "Not now" then a
  reload proves decision 34's "not asked again". This test found the `closePin` bug: the reload came before the
  answer was saved.
- **`pinCard` waits for the card's pill:** the card shows only with an open copy, and the dialog's choice is made in
  the same update, so once the pill is there the test can say the dialog did not come back.
- **The wrong-PIN messages are checked word for word,** with the singular "1 try left": `pin.wrong` has `_one` and
  `_other` forms (19b.3).
- **`fill(BANGLA_PIN)` and `toHaveValue(PIN)`:** the box converts as it is typed, so the value is ASCII before Unlock.
- **After the unlock, the Sync page:** a reload keeps the page's address, and the lock covered that page.
- **"five wrong PINs" ends with a new PIN that works,** after the password: the whole way back from a blocked PIN.
  The dialog's title is "Set a new PIN" here (the key's row says `pinBlocked`); after "Forgot PIN?" it is the set-up
  dialog, because the PIN was deleted, not blocked.
- **The two-tab test** found the `start` bug: the second tab was still opening its copy when the first locked, and in
  one run of three it stayed open.
- **"with no connection":** `context.setOffline(true)` before the lock. The lock screen's chunk loads from the
  preload above; the PIN opens the copy without the server.

### `e2e/offline.pwa.ts`: the offline reload with a PIN

```diff
@@ -1,7 +1,11 @@
+// Step 19b: the key's row is made here, in Node, by @omnivo/sync itself (in memory). First, so
+// Dexie finds it when @omnivo/sync loads.
+import 'fake-indexeddb/auto';
+
 import { readFileSync } from 'node:fs';
 import { join } from 'node:path';
 
-import { newDeviceId, saveDevice } from '@omnivo/sync';
+import { databaseName, newDeviceId, openKey, saveDevice, setPin, SyncDatabase } from '@omnivo/sync';
 import type { Locator, Page } from '@playwright/test';
 
 import { HEAD_OFFICES, meIn, OWNER, WORKSPACES } from '../src/mocks/fixtures.js';
@@ -65,11 +69,75 @@ test('the build opens with the server gone and no connection', async ({
   expect(status).toBe(200);
 });
 
+const [garments] = WORKSPACES;
+const PIN = '480915';
+const NO_PIN_NOTICE =
+  'This device has no PIN, so its data opens only with a connection. Connect to the internet to sign in.';
+
+// Step 19b: what an online visit with a PIN leaves in the copy: the key's row (keys.ts), made with
+// a server key that is never asked for again (offline, the PIN opens it). 1,000 rounds, not
+// 600,000: the row keeps its count, and the test types the PIN twice. Plain arrays, because that
+// is what page.evaluate() carries; the page turns them back into bytes.
+async function pinRow() {
+  const db = new SyncDatabase('pwa-e2e-key');
+  try {
+    const serverKey = new Uint8Array(32).fill(7);
+    await openKey(db, { serverKey });
+    await setPin(db, { serverKey }, PIN, 1000);
+    const row = await db.keys.get('data');
+    if (!row?.pin) throw new Error('The PIN was not set');
+    return {
+      ...row,
+      server: [...row.server],
+      pin: { ...row.pin, salt: [...row.pin.salt], wrapped: [...row.pin.wrapped] },
+    };
+  } finally {
+    db.close();
+  }
+}
+
+// Into the copy's database, which the first visit made (offline-session.ts opened it to read the
+// PIN). Plain IndexedDB: the built app's Dexie is not reachable from here.
+async function putPinRow(page: Page): Promise<void> {
+  await page.evaluate(
+    async ({ name, row }) => {
+      const db = await new Promise<IDBDatabase>((resolve, reject) => {
+        const request = indexedDB.open(name);
+        request.onsuccess = () => {
+          resolve(request.result);
+        };
+        request.onerror = () => {
+          reject(new Error('The copy did not open'));
+        };
+      });
+      await new Promise<void>((resolve, reject) => {
+        const transaction = db.transaction('keys', 'readwrite');
+        transaction.objectStore('keys').put({
+          ...row,
+          server: new Uint8Array(row.server),
+          pin: {
+            ...row.pin,
+            salt: new Uint8Array(row.pin.salt),
+            wrapped: new Uint8Array(row.pin.wrapped),
+          },
+        });
+        transaction.oncomplete = () => {
+          resolve();
+        };
+        transaction.onerror = () => {
+          reject(new Error('The key was not saved'));
+        };
+      });
+      db.close();
+    },
+    { name: databaseName(garments.tenantId, OWNER.id), row: await pinRow() },
+  );
+}
+
 test.describe('a device set up for Farhana Rahman', () => {
   // What an online visit leaves in this browser: the remembered `me` (step 19a) and the device
   // with its branch (step 18a). Only when nothing is there: a reload keeps what the app saved.
   test.beforeEach(async ({ page }) => {
-    const [garments] = WORKSPACES;
     const saved = new Map<string, string>();
     saveDevice(
       { getItem: () => null, setItem: (key, value) => saved.set(key, value) },
@@ -89,12 +157,55 @@ test.describe('a device set up for Farhana Rahman', () => {
     );
   });
 
-  test('a reload with no connection opens the app as her', async ({ page, context, server }) => {
+  // Step 19b (decision 5): this build's API never answers, so even the first visit is an opening
+  // with no answer, and with no PIN in the copy it is the sign-in page
+  test('a reload with no connection on a device without a PIN says why it cannot open', async ({
+    page,
+    context,
+    server,
+  }) => {
     await page.goto('/');
     await workerInControl(page);
+    // The browser is online here, so the page shows no notice: only a reload offline says why
+    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
     await server.stop();
     await context.setOffline(true);
     await page.reload();
+    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
+    // In place of the plain offline notice: it says why
+    await expect(page.getByText(NO_PIN_NOTICE)).toBeVisible();
+    await expect(page.getByText("You're offline. Signing in needs a connection.")).toHaveCount(0);
+  });
+
+  test('a reload with no connection opens the app as her, after the PIN', async ({
+    page,
+    context,
+    server,
+  }) => {
+    await page.goto('/');
+    await workerInControl(page);
+    // The sign-in page: offline-session.ts read the copy for its PIN, so the database is there
+    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
+    await putPinRow(page);
+    await server.stop();
+    await context.setOffline(true);
+    await page.reload();
+
+    await expect(page.getByRole('heading', { level: 1, name: 'Omnivo is locked' })).toBeVisible();
+    await expect(
+      page.getByText("You're offline, so Omnivo needs this device's PIN to open your work."),
+    ).toBeVisible();
+    // Offline, "Forgot PIN?" can only say what to do
+    await expect(
+      page.getByText('Forgot your PIN? Connect to the internet, then sign in with your password.'),
+    ).toBeVisible();
+    await page.getByLabel('PIN', { exact: true }).fill('111111');
+    await page.getByRole('button', { name: 'Unlock' }).click();
+    await expect(
+      page.getByText('Wrong PIN. 4 tries left, then the PIN stops working.'),
+    ).toBeVisible();
+    await page.getByLabel('PIN', { exact: true }).fill(PIN);
+    await page.getByRole('button', { name: 'Unlock' }).click();
 
     await expect(
       page
```

- **`import 'fake-indexeddb/auto'` in a Playwright file:** it runs in Node, where there is no IndexedDB. Only this
  file's process sees it; the browser has its own.
- **`pinRow()`** makes the key's row the way an online visit would (decision 51), and turns its bytes into plain arrays
  for `page.evaluate`, which the page turns back into `Uint8Array`s. The row's fields stay as `@omnivo/sync` wrote
  them.
- **`putPinRow` writes with plain IndexedDB.** The built app's Dexie is inside its bundle, out of the test's reach.
  The database is there already: the first visit had no answer from the API, so `offline-session.ts` opened the copy
  to read its PIN, which made the database at version 3 with every table.
- **The first visit waits for the sign-in page,** not for the no-PIN notice. The browser is online then (only the API
  does not answer), and the sign-in page shows its offline notices only while the browser says it is offline.
- **"says why it cannot open":** the no-PIN notice in place of the plain one, after the reload with no connection.
- **"after the PIN":** the lock screen with the offline description, the "Forgot your PIN?" sentence instead of the
  link, one wrong PIN, then the right one, and the 19a checks that the app opened as her.

### Check this part

```bash
pnpm install
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/app test
pnpm --filter @omnivo/app test:e2e
pnpm --filter @omnivo/app test:e2e:pwa
pnpm --filter @omnivo/app build
pnpm --filter @omnivo/app test:bundle-size
pnpm boundaries
pnpm exec eslint apps/app/src apps/app/e2e
pnpm exec prettier --check apps/app/src apps/app/e2e
```

All pass: 179 unit tests (14 new); the PIN's e2e file (its first six tests three times in a row on desktop, 18 of 18,
and all seven on both projects); the worker suite (4); the whole mock e2e suite on both projects, some files only on a
second run (see below); the build and every budget (the first load 213.8 KB of 215 KB); `pnpm boundaries`; ESLint and
Prettier.

> **What we checked in this part.** The whole mock suite ran on both projects, in halves, on a machine that macOS's
> own services kept at a load of 15 to 35 for part of the afternoon (after a reboot). The failures of those runs were
> timeouts and slow pages in files this part does not touch (journal, numbering, outbox, credit notes, purchase
> orders, quotations); every one passed when run again with `--last-failed --workers=2`. The runs that did point at
> this part were the two-tab test (the `start` bug), the "Not now" reload (the `closePin` bug), the bell test on a
> phone and the branch test (both fixed above). Then we broke the code on purpose, one change at a time: with `hasPin`
> ignoring a blocked PIN, "stopped working" fails; with no `clearLocked()` at a sign-in, "ends it at a sign-in with
> the password" fails; with `clearLocked()` before the request, "keeps the lock when the password is wrong" fails;
> with the dialog closing before "Not now" is saved, the first PIN e2e test fails twice in two runs; with a random
> mock key, setting the PIN fails at once (the key differs between the device's two requests), which is why the mock
> works the key out from the id. The real API, the full check list and a 10,000-row timing in a browser are 19b.6.

---

## 19b.6 — The real API, 10,000 rows, and every check once

### Root `package.json`: ESLint gets 6 GB

```diff
@@ -12,7 +12,7 @@
     "build": "turbo run build",
     "typecheck": "turbo run typecheck",
     "test": "turbo run test",
-    "lint": "turbo run build --filter=./packages/* && node --max-old-space-size=4096 node_modules/eslint/bin/eslint.js .",
+    "lint": "turbo run build --filter=./packages/* && node --max-old-space-size=6144 node_modules/eslint/bin/eslint.js .",
     "format": "prettier --check .",
     "format:write": "prettier --write .",
     "boundaries": "depcruise apps packages",
```

The only file this part changes. `pnpm lint` runs ESLint with type information over the whole repo in one process,
and with this step's code that process ran out of its 4 GB heap every time, after about three minutes ("Ineffective
mark-compacts near heap limit"). The same command on the code before this step (your commit `3bca857`) still
passes, so the step's new files and tests pushed it over, not a bug in them. With 6 GB it passes in about 90
seconds, with no problem found. CI runs the same `pnpm lint`, so it would have failed there too; GitHub's runners
have 16 GB of memory (decision 53).

### No other file changes

This part changes no API route, no table and no permission: `packages/contracts/openapi.json` is 19b.2's (`pnpm
test:openapi` passes without `pnpm gen:openapi`), the last migration is 0050, and no role template changes. The
boundaries rules already cover the new files.

### The app against the real API

The mock e2e tests have a mock key and no service worker, and the worker's tests have no API. So once, the whole
path ran in a real browser (Chromium, driven by a Playwright script that is not part of the guide) against the real
API: a production build of this guide's code with `VITE_API_URL` set to the API, served by `vite preview`, the API
and the worker built from this guide's code, and a throwaway Postgres and Valkey on other ports. "No connection"
meant, as in 19a.6, three things at once: the API stopped (and its process gone), the preview server stopped, and
the browser set offline. The script:

- signed up a pharma workspace through the API and added a customer, Rahman Traders (01711-234567). The browser
  opened `/customers`: the server's key opened a new copy, and "Set a PIN for this device" asked for a PIN; 480915
  was set. Then it read every row of every table of the device's database (18 tables): neither the name nor the
  phone number was anywhere in them, and the `keys` table held the key only wrapped. The Sync page's card said "PIN
  set";
- went offline and loaded `/customers` again: the worker served the app, and the lock screen said "You're offline,
  so Omnivo needs this device's PIN to open your work.", with Nusrat Jahan's email and "Forgot your PIN? Connect to
  the internet, then sign in with your password." (no link offline). A wrong PIN said "4 tries left"; the right one
  opened the list, with Rahman Traders and "Offline" in the sync line;
- saved Sylhet Pharmacy (01819-556677) with "Save on this device". The outbox's row was sealed too: neither the name
  nor the phone was readable in the database. Back online, the change went (the API listed it as `C-00002`), and the
  pulled customer was sealed like the others;
- went offline, reloaded, and left the lock screen waiting. When the connection came back, it opened by itself, with
  no PIN typed (decision 41);
- chose "Lock now" online and reloaded: the lock screen again, "Type the PIN of this device to open your work.",
  still there 3 seconds later (the server's key does not open a locked copy). The PIN opened it, and the next reload
  was an ordinary one;
- went offline again and typed a wrong PIN five times, waiting for each answer: "4, 3, 2, 1 tries left", then "The
  PIN was wrong 5 times, so it stopped working…", with no PIN field, also after a reload. Back online, the copy
  opened with the server's key and "Set a new PIN" asked for one (135790);
- revoked the device from the API while the browser was offline. In Postgres its `secret` was `NULL` at once, and
  `GET /sync/devices/:id/key` answered 403 `device_revoked`. Offline, the PIN still opened the copy (the device did
  not know yet). When the connection came back, 19a's check of the sign-in was refused, because the revoke ended the
  device's sign-in: the sign-in page said "You were signed out while offline…", `omnivo.me` was gone (so no offline
  reload opens anything any more), and the copy stayed on the disk, sealed, with no key on the server that opens it.
  The next sign-in was a new device: a new device id, a new key row, a new copy pulled, and the PIN asked again. The
  workspace had 1 active device of 2.

No error was thrown in the page. It passed 4 times in a row in its final form.

What happens to a device revoked while it is offline is 18c's and 19a's behaviour, not new: the device does not
learn that it was revoked, only that its sign-in ended (19a's decision 26), so the sign-in page shows the "signed
out" notice, not the "revoked" one, and the copy goes at the next sign-in instead of at once. With this step that
copy is only bytes: its server key is gone, `me` is forgotten so the lock screen never shows for it, and only
someone with the PIN and the browser's database could open it outside the app.

Two things in our own script cost time, and are worth knowing if you write one:

- **A second CDP session undoes `setOffline` for the page's `navigator.onLine`.** The first version of the script
  opened one (`context.newCDPSession`) to read the page's memory. With it, a page loaded offline from the worker
  said `navigator.onLine === true`: the lock screen showed the "Forgot PIN?" link and the sync line said "Online",
  while every request failed. Without it, `false`, as in a real browser. The script now reads the memory with
  `performance.memory` instead.
- **A stopped API waited for our script's own connection.** The API stopped listening at once, but its process did
  not end while the script's own API client (Playwright's request context) kept a connection open after the revoke.
  The script now kills it after 10 seconds. Waiting for the process to end matters (19a.6: a dying API can answer a
  request without the CORS headers).

### 10,000 products and 10,000 customers

Decision 12 keeps the products and the customers in memory, opened once, so that a key press in a search never opens
10,000 rows. Its cost is the time to open them and the memory they take. Measured once, in Chromium on the
production build, on this machine (an 8-core Apple laptop, other Docker stacks running), with 10,000 products and
10,000 customers added through the API:

| What | Time |
|---|---|
| The first opening: from the address to the customer list | 3.5 s |
| …until all 20,001 rows were pulled, sealed and written (the PIN set meanwhile) | 3.7 s |
| An online reload: the server's key, both in-memory tables, the list | 0.8 s |
| A customer search on the device ("Pharmacy 09999"), from typing to the row | 0.37 s, of which 0.3 s is the box's wait for the typing to stop |
| The products list, opened from the menu | 0.12 s |
| An offline reload: to the lock screen, then from Unlock to the list (the PIN's 600,000 rounds included) | 0.86 s, then 0.87 s |

The page used 190 MB of JavaScript memory after a garbage collection, the same after each opening, and the device's
copy took 23 MB of storage. Every row of the database was read back: no product name and no customer name or phone
number was readable in it. The `keys` table's one row held the key only as bytes: the server's wrap (60 bytes) and
the PIN's wrap (60 bytes, with a 16-byte salt and the rounds), plus the PIN's counts.

So decision 12's in-memory copy does what it should: a reload opens 20,000 sealed rows in under a second, and a
search does not open any. The memory is the price. A phone with 2 GB, or a till with three times as many products,
should be measured before step 20 adds a third table to it (see the notes).

### Every check once

Then run the whole checklist (at the end of this guide) once. Each part ran only its own package's checks; this is
the first time everything runs together.

All passed, two of them only after a change or a second run. The machine had restarted half an hour earlier (load
about 14 while the suites ran):

- `pnpm lint` ran out of memory: "Ineffective mark-compacts near heap limit", after about three minutes, twice in a
  row, also with nothing else running. That is the `package.json` change at the top of this part (decision 53).
  With it, `pnpm lint` passes.
- `pnpm test:e2e`: 306 passed, 1 skipped and 13 failed, all on timeouts or a toast still showing while the test
  waited for it to go: accounts, stock valuation and the branch change on desktop; bills, deliveries (2), the branch
  change, the outbox, purchase orders (4) and the branch dialog on the phone. All 13 passed when run again with two
  workers (load 4). Only the branch change failed on both projects; run alone, it takes about 22 seconds of its 30,
  and 21 on the code before this step, so it was near its limit already (see the notes at the end).

Everything else passed at the first run: `pnpm dedupe --check`, `pnpm format`, `pnpm typecheck`, `pnpm test` (722),
`pnpm build`, `pnpm test:bundle-size` (first load 213.8 KB of 215; debit note lines 109.4 of 110; the worker's list
389 files, 1335.4 KB gz), `pnpm test:openapi` (unchanged since 19b.2), `pnpm boundaries`, `pnpm test:integration`
(559), `pnpm test:tenant-leak` (112) and `pnpm test:e2e:pwa` (4, in 25 seconds).

---

## 19b.7 — Doc updates

After you implement this (ask me and I can do these):

**CLAUDE.md** — in "Components", after "Opened offline", add these entries. A pattern that is not listed there
does not exist for the next screen, and step 20's POS lock will reuse them:

> - **PIN field:** `PinField` (`apps/app/src/components/pin-field.tsx`), the input box with a 17px `LockKeyhole` icon,
>   `type="password"`, `inputmode="numeric"` and `autocomplete="off"`, 6 digits. Bangla digits become ASCII ones as
>   they are typed, so the value is always ASCII. Easy PINs (`000000`, `123456`) and two different PINs are refused
>   under the box, like any field error.
> - **Lock screen:** `LockScreen`, in the sign-in page's layout (`AuthLayout`, with the side panel), drawn by
>   `AppFrame` in the shell's place: "Omnivo is locked" (the auth form's 28px title), a line that says why it asks
>   (after Lock now, after an offline reload, after the server's key changed), the person's name and email in a 1px
>   `line` box, one PIN field, Unlock (primary, full width), "Forgot PIN? Sign in with your password" (a text link;
>   offline a sentence with `WifiDisconnected02` that says to connect first) and Sign out (a text link, asks first
>   when changes wait). A wrong PIN says how many tries are left. After 5 the PIN field goes: a `warn` notice and
>   "Sign in with your password" (primary) take its place, or offline a neutral notice that says to connect.
> - **PIN dialog:** the dialog, after the device is set up ("Set a PIN for this device", with "Not now"), after
>   "Forgot PIN?" or 5 wrong PINs ("Set a new PIN"), and from the Sync page's card ("Change the PIN of this device",
>   the current PIN first). PIN and "Type the PIN again", with the hint that the PIN works only on this device;
>   "Set PIN" / "Change PIN" (primary), "Setting the PIN…" while it works (up to a second, on purpose). Toasts
>   "Device PIN set" and "Device PIN changed".
> - **Device PIN card (Sync page):** before the storage card: "Device PIN", a `good` "PIN set" pill
>   (`CheckmarkCircle02`), a `warn` "Stopped working" pill (`Alert02`) or a neutral "No PIN" pill
>   (`SquareUnlock02`), a 13.5px `ink-2` sentence, and "Set a PIN" / "Change PIN" (secondary `sm`).
> - **Lock now:** an item in the account menu after Install app (`SquareLock02`). Without a PIN it is "Set a PIN to
>   lock" (`LockKey`) and opens the PIN dialog. Other tabs lock too, and a reload keeps the lock until the PIN or a
>   sign-in with the password. The words never say "key" or "encryption".

In the same section, add one sentence to the end of **Opened offline**:

> On a device without a PIN, an offline reload shows the sign-in page with "This device has no PIN…" in place of the
> offline notice, and with a PIN it shows the lock screen first.

In "Interaction", after the service worker entry, add:

> - **The device's copy is sealed.** Every row in the device's database is `{ key, gen, box }` plus the ids an index
>   needs, `box` sealed with AES-GCM by `LocalCopy` (`packages/sync/src/copy.ts`). A new table on the device goes
>   through `sealed.ts`, and only ids, codes that are searched exactly (SKU, barcodes) and dates stay readable: never
>   a name, a phone number, an amount or a command. Code that reads the copy takes the open `LocalCopy`, never the
>   database.

**docs/system-design.bn.md** — in ৭.২, after point ১ add:

> **ডিভাইসের কপি এনক্রিপ্টেড (ধাপ ১৯b):** IndexedDB-র প্রতিটা সারির ডেটা AES-GCM-এ সিল করা (Web Crypto); শুধু id,
> SKU/barcode আর index-এর id খোলা থাকে। একটা random data key দুইভাবে wrap করা: সার্ভারের device key দিয়ে (প্রতি
> ডিভাইসে ৩২ byte, `devices.secret`, revoke হলে মুছে যায়) আর ৬ অঙ্কের PIN দিয়ে (PBKDF2, ৬ লাখ round)। অনলাইনে
> সার্ভারের key কপি খোলে, PIN লাগে না; অফলাইন reload আর "Lock now"-এর পরে lock screen-এ PIN। ৫ বার ভুল PIN হলে
> অফলাইনে খোলা বন্ধ, password দিয়ে sign-in লাগে। সীমা: কেউ পুরো database কপি করে নিলে নিজের মেশিনে ১০ লাখ PIN চেষ্টা
> করতে পারে, অ্যাপের গোনা সেখানে নেই।

and in ৭.৪, change the row "ডিভাইস চুরি / হারানো" to:

> | **ডিভাইস চুরি / হারানো** | Workspace → Devices থেকে revoke (`core.device.manage`) বা নিজের My devices থেকে: সিঙ্ক বন্ধ, ওই ব্রাউজারের sign-in শেষ, সার্ভারের device key মুছে যায়, পরের যোগাযোগে কপি আর outbox মুছে যায়। তার আগ পর্যন্ত কপি এনক্রিপ্টেড: খোলে শুধু PIN দিয়ে, ৫ বার ভুল হলে আর না |

**docs/build-plan.bn.md** — under "ধাপ ১৯: PWA শেল", replace the 19b bullet with:

> - **এনক্রিপশন + PIN (১৯b):** ডিভাইসের কপির প্রতিটা সারি AES-GCM-এ (Web Crypto), data key সার্ভারের device key
>   (`devices.secret`, `GET /sync/devices/:id/key`) আর PIN (PBKDF2) দুটো দিয়েই খোলে। ডিভাইস সেট-আপের পরে PIN চাওয়া
>   ("Not now" সহ), Sync পাতায় Device PIN কার্ড, অফলাইন reload-এ আর "Lock now"-এর পরে lock screen, ৫ বার ভুল হলে
>   অফলাইনে খোলা বন্ধ, "Forgot PIN?" = password দিয়ে sign-in। Dexie version 3: পুরনো কপি মুছে আবার pull, outbox
>   থেকে যায়।

**COMMANDS.md** — no change: this step adds no command.

---

## 19b.8 — Run it

```bash
pnpm install          # fake-indexeddb, for the app's unit tests
pnpm db:migrate       # 0049 + 0050: devices.secret, a key for every active device
pnpm dev
```

No new environment variable. Migration 0050 creates the `pgcrypto` extension, so the migrator role must be allowed
to (it is the database's owner in the dev compose and in the test containers).

### What you will see

1. **The PIN after the set-up:** sign in. Once the copy opens, "Set a PIN for this device" asks for a PIN. Click
   "Not now" once: a reload does not ask again, and the Sync page's "Device PIN" card says "No PIN". Set one from the
   card (try `123456` first: it is refused). "Device PIN set", and the card says "PIN set".
2. **The copy is sealed:** DevTools → Application → IndexedDB → `omnivo-…` → `customers`: each row is a key, a
   number and a `box` of bytes. No name and no phone number anywhere. The `keys` table holds only wrapped bytes.
3. **Lock now:** the account menu → "Lock now". The lock screen shows your name and email. Reload: still locked.
   Type a wrong PIN once ("4 tries left"), then the right one: the page you were on.
4. **An offline reload:** DevTools → Network → Offline, then reload. With `pnpm dev` there is no service worker, so
   use the preview of 19a.8 for this one (a production build). The lock screen says you're offline; the PIN opens
   your products and customers. Turn the network on while the lock screen waits: it opens by itself (decision 41).
5. **Five wrong PINs:** lock again and type a wrong PIN five times: the PIN field goes, and "Sign in with your
   password" takes its place. After the sign-in, "Set a new PIN".
6. **Forgot PIN:** on the lock screen, "Forgot PIN? Sign in with your password": the sign-in page says you then set
   a new PIN, and the same copy opens after it, nothing pulled again.
7. **Revoke:** sign in on a second browser as the owner and revoke the first one in Workspace → Devices. In
   Postgres, `SELECT secret IS NULL FROM devices WHERE id = '…'` is true at once. The first browser, at its next
   request, deletes its copy and shows the revoked notice on the sign-in page.
8. **Bangla** and **390px:** the lock screen, the dialog and the card fit, Bangla digits typed on a Bangla keyboard
   unlock, and no page scrolls sideways.

---

## Checklist

```bash
pnpm dedupe --check
pnpm lint                    # now with a 6 GB heap for ESLint (decision 53)
pnpm format
pnpm typecheck
pnpm test                    # 722: contracts 293 + app 179 + api 123 + sync 85 + ui 19 + i18n 15 + auth 8
pnpm test:integration        # 559
pnpm test:tenant-leak        # 112
pnpm test:e2e                # 320: 160 flows × desktop and 390px (the sort test is skipped on the phone)
pnpm test:e2e:pwa            # 4: the build offline, an offline reload without and with a PIN, an update in two tabs
pnpm build
pnpm test:bundle-size        # first load 213.8 KB gz (budget 215); debit note lines 109.4 (110); the worker's list 389 files, 1335.4 KB gz (2048)
pnpm test:openapi
pnpm boundaries
```

## What we found on the way

All of these are fixed in the guide — if you get stuck at the same place, you will recognise it:

- **A read inside a liveQuery stopped following the rows** (19b.1): after `await crypto.subtle.decrypt(…)`, Dexie no
  longer knew the read belonged to the query, so a change did not show until the next reload. `unseal` wraps the
  call in `Promise.resolve` (decision 19). The specs had passed without it, because they opened rows inside
  `Promise.all`, which Dexie follows; a test now opens one with a plain `await`.
- **A pushed customer could be missing from the list for a moment** (19b.1): a push's answer writes the customer and
  removes its command from the outbox in one transaction, but the in-memory copy hears of the write a moment after
  the outbox does. The `marks` table makes the list wait for it (decision 13).
- **A stale `openapi.json`** (19b.2): a "break it on purpose" check (`.length(44)`) was left in the generated file.
  Run `pnpm gen:openapi` after the contract, then `pnpm test:openapi`, as 19b.2 says.
- **Two tabs, one lock** (19b.4, found by 19b.5): the second tab was still opening its copy when the first locked,
  and opened anyway. `start()` reads the lock again before it says "ready".
- **"Not now" was asked again after a reload** (19b.4, found by 19b.5): the dialog closed before `markPinAsked`
  had saved, and the reload cut the write off. `closePin` closes after the save.
- **An import circle** (19b.4, found by 19b.5): `local-session.ts` imported `session.ts` for "Forgot PIN?", which
  imports it back; `pnpm boundaries` refused it. The lock screen calls `signInAgain` from `session.ts` itself.
- **The PIN dialog closed menus in older e2e tests** (19b.5): it opens when the copy opens, at a moment the test
  does not choose. The three tests that open a popover first wait for the copy (decision 48).
- **ESLint ran out of memory** (19b.6): the whole-repo lint needs more than 4 GB now (decision 53).

---

## Notes left for later steps

**Step 20 (POS):**

- **Locking after idle time** comes with the shifts (decision 4). Use the same lock: `lockNow()` in
  `local-data.ts` drops the key and the in-memory copy, and `omnivo.locked` keeps it across a reload. A cashier
  change is a lock plus another person's sign-in, not a second kind of lock.
- **Every new table on the device is sealed** (decision 2): a sale, a shift, a cash count. Add it through
  `sealed.ts`, keep only what an index needs readable, and add it to the `marks` counter if a list reads it from
  memory (decision 13). A POS sale saved offline goes into the outbox, which is sealed already.
- **The in-memory copy costs memory** (decision 12, 19b.6's numbers above). A till with 30,000 products would hold
  three times that. If a POS device is a low-end phone, measure there before adding a third in-memory table.
- **A POS device should have a PIN.** A till works offline all day; without a PIN it opens only online (decision
  5). The set-up dialog's "Not now" may be wrong for a till: step 20 can make the PIN required on a POS device.

**Notes for any step:**

- **The device's code takes the open copy, never the database** (19b.1). A function that needs the data takes a
  `LocalCopy`; only the pull's cursor, the batch and the sending state read the database directly.
- **Web Crypto awaits end an IndexedDB transaction.** Seal before a write transaction and open after a read, never
  inside one (decision 9). A new write that needs a sealed value inside a transaction must seal it first.
- **A copy is bound to its server key** (decision 17). Restoring the API's database from a backup gives every device
  that registered after that backup a new key: those with a PIN ask for it once, those without one copy their
  branch again, and their changes that had not synced are lost. Say so in the restore runbook.
- **ESLint's heap grows with the repo** (decision 53): 6 GB now. When it runs out again, give each package its own
  `lint` script and run them through turbo, rather than raising the heap again.
- **The branch-change e2e test is near its timeout** (`devices.e2e.ts`, "changing the branch…"): about 22 seconds of
  30 on a quiet machine (21 before this step), because it copies 10,000 styles twice. It failed on both projects in
  the busy full run of 19b.6 and passed when run again. If it fails in CI, give it `test.slow()`.
- **A revoked device that was offline gets the "signed out" notice, not the "revoked" one** (19b.6, 19a's decision
  26): it learns only that its sign-in ended. If that confuses people, the sign-in page can ask the server why
  (a new route), but the copy is safe either way.
