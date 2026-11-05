# Step 19a: The app on the device, part 1 — the service worker, installing, updates and opening offline

> The implementation guide for "Phase 6 → Step 19", the first of two parts, of [build-plan.bn.md](build-plan.bn.md):
> which file gets what code, and which command runs where. Step 19 (the PWA shell) is split into two guides: this one
> (the service worker that keeps the app's files, the manifest and the icons, installing, updates, keeping the
> storage, and opening the app offline after a reload) and 19b (encrypting the copy on the device, and the PIN that
> opens it).

> Every file in this guide was placed in a separate copy of the repo (on top of commit `8c515fe`, your commit named
> "claude updated": 18c's code and its doc updates) and checked from 2026-10-25 to 2026-10-26: `pnpm dedupe
> --check`, `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test` (681 — 25 new), `pnpm test:integration`
> (553, unchanged), `pnpm test:tenant-leak` (111, unchanged), `pnpm build`, `pnpm test:bundle-size`
> (first load 212.7 KB gz, budget 215; the worker's list 380 files, 1317.0 KB gz, budget 2 MB), `pnpm test:openapi`, `pnpm boundaries`, `pnpm test:e2e` (Playwright on the mocks, 306 — 16 new) and
> the new `pnpm test:e2e:pwa` (the worker on a production build, 3 tests) — with the turbo cache bypassed
> (`--force`).
>
> Also checked:
>
> - **The worker in a real browser on the production build** (19a.1 and 19a.4): a reload with the server stopped, a
>   deep link, a screen never loaded online, an update that waits, two tabs and one Reload.
> - **The offline sign-in on its own** (19a.3 and 19a.5): a reload with no answer and with a 502, the check at the
>   first 401, a refused check, signing out offline and the sign-out that waits.
> - **The app against the real API in a browser** (19a.6): an offline reload that opens the copy, a customer saved
>   offline and sent when the connection came back, a sign-in ended while offline, and signing out offline.

## Goal

📱 **The app opens without a connection, every time.** After step 18, a device keeps its branch's products,
customers, prices and stock, and saves new customers and draft orders offline. But only while the tab stays open:
the app's own files (the scripts, the styles, the fonts) still come from the server. A reload during a power cut, a
laptop that wakes up in a warehouse with no signal, or a browser that closed the tab overnight gets the browser's
"No internet" page, and the copy on the device cannot be reached at all. Step 18b worked around part of it by
loading the offline screens in the background (`offline-screens.ts`); that only helped a tab that never closed.

After this step:

- **The app's files live on the device.** A service worker keeps every script, style and font of the version the
  device runs. The app opens, and every screen loads, with no connection: also a screen nobody opened before.
- **A reload offline opens the last person's copy.** The sales officer in Sylhet who reloads the app at a pharmacy
  with no signal sees their products and customers, and can save a draft order, as before the reload. The sign-in
  check waits until the connection is back. (19b adds the device PIN to this.)
- **Updates never surprise anyone.** A new version downloads in the background and waits. The app says "A new version
  is ready · Reload"; it changes only when the person clicks, so a half-typed order is never lost to an update.
- **The app can be installed** ("Install app" in the account menu): its own window and icon on a desktop, a home
  screen icon on a phone, the number of changes waiting on the icon.
- **The browser is asked to keep the copy.** Without that, a browser low on space may delete a site's data. The Sync
  page says whether the copy is kept, and how much space it uses.

## The whole picture

```
apps/app (build)   vite-plugin-pwa (injectManifest): sw/sw.ts → dist/sw.js with the list of every script,
      │             style and font of the build · manifest.webmanifest · the app icons · test:bundle-size checks
      │             that every built file is in the list
      ▼
dist/sw.js          keeps the list in the browser's cache · answers every page of the app with index.html ·
      │             a new version waits until "Reload"
      ▼
apps/app (page)     registers the worker after the first render (production build only) · the update notice ·
                    "Install app" · storage kept or not on the Sync page · the count on the app icon ·
                    a reload offline opens the last person's copy with the `me` it remembered

the Sylhet route, a Thursday:
  09:10  the sales officer opens the app at the office: the worker keeps the 374 files of this version
  11:40  at Sylhet Pharmacy, no signal; the laptop slept, the browser reloads the tab
           index.html, scripts, fonts ──from the worker──► the app opens
           the session: no answer from the server ──► the last person's copy, with the remembered `me`
           a draft order ──► the outbox (step 18b), "Save on this device"
  14:05  back on the network: the sign-in is checked, the outbox is sent
  17:30  a new version was published at noon: "A new version is ready · Reload"; she clicks it after saving
```

## Not in this step, on purpose

| What | Why not now / when |
|---|---|
| Encrypting the copy, and a PIN to open it offline | 19b (decision 1). 19a opens the last person's copy without a PIN |
| Locking the app after some idle time | Step 20, with the POS shifts (decision 8) |
| Caching the API's answers in the service worker | The data lives in IndexedDB since step 18, with its own rules. Two copies would disagree |
| Background sync (the worker sends the outbox while the app is closed) | Safari and Firefox do not have it. The outbox goes when the app is open and online, as in 18b |
| Push notifications | The bell polls (step 8). A push needs a server key and a permission prompt: a step of its own |
| The host's cache headers for `sw.js` and `index.html` | There is no deployment setup in the repo yet. The note in decision 13 says what the host must do |

## What changes in the code you already have

- **The build (19a.1):** four new packages in `apps/app` (`vite-plugin-pwa` for the build, and three Workbox
  modules that become the worker's code). A new folder `apps/app/sw/` with the service worker and its own
  `tsconfig.json`. `vite.config.ts` builds the worker and the manifest; `index.html` gets the iOS icon and the
  theme colour; four app icons in `public/`, made once from `favicon.svg` by `pwa-assets.config.js`.
  `test:bundle-size` also checks the worker's list of files.
- **The words (19a.2):** `packages/i18n` gets the words of the update notice, installing, the storage card and the
  offline opening, in English and Bangla, and a new formatter, `formatBytes` (`useLocale().format.bytes`).
- **The offline sign-in (19a.3):** two new files in `apps/app/src/lib/` (`remembered-session.ts`, `offline-session.ts`);
  `session-store.ts`, `api.ts` and `session.ts` learn to open offline and check the sign-in later; the sign-in page
  and the Sync page say so. The first load's budget is 215 KB.
- **The app (19a.4):** six new files (the update notice, installing, the storage card); `main.tsx` registers the
  worker; the account menu gets "Install app"; the Sync page gets the storage card. `apps/app/src/lib/offline-screens.ts`
  is deleted (its list moves to `src/mocks/` for mock mode), and so is `loadCalendar` in `packages/ui`.
- **The tests (19a.5):** two unit test files for the offline sign-in and the updates, one mock e2e file for
  installing and the storage card, and a second Playwright suite, `pnpm test:e2e:pwa`, that tests the worker on a
  production build. `package.json`, `turbo.json` and CI get the new command.
- **Not touched:** the API, the database, `packages/contracts` (`openapi.json` stays as it is), `packages/sync` and
  the permissions. No new environment variable.

## The decisions behind this step

You made the first eight on 2026-10-25 (the last four are for 19b, listed here so the two guides agree). The others
came up while building it; please read them with care: they are mine.

1. **Two guides.** (You chose this.) 19a: the service worker, the manifest, installing, updates, keeping the storage,
   and opening offline after a reload. 19b: encrypting the copy on the device, and the PIN.
2. **A reload offline opens the last person's copy.** (You chose this.) In 19a it opens without a PIN; 19b asks for
   the device PIN first. Online nothing changes: the sign-in cookie is refreshed as before, and no PIN is asked.
3. **An update waits for a click.** (You chose this.) The new version downloads and waits. The notice "A new version
   is ready · Reload" lets the person choose the moment; the app never reloads by itself, because a reload under an
   open form loses what was typed.
4. **The worker keeps every script, style and font.** (You chose this.) Not only the screens that work offline: a
   screen that needs the connection still shows its "Needs a connection" state offline instead of an error page.
   `offline-screens.ts` (18b's background loading) is deleted, and so is its rule in CLAUDE.md.
5. **(19b) One random key encrypts the copy,** kept twice: wrapped by a key the server gives only to an active device
   after the sign-in, and by a key made from the PIN. Online, the server's key opens it with no PIN; offline, the PIN
   does. Revoking a device means the server stops giving its key.
6. **(19b) Every row's data is encrypted:** products, prices, stock, customers, the outbox and the notices. Only the
   ids, the generation, SKUs and barcodes and the ids the device searches by stay readable.
7. **(19b) Five wrong PINs turn the offline unlock off** until the next online sign-in. The copy stays, encrypted.
8. **(19b) "Lock now" in the account menu,** and a lock on every offline reload. Locking after idle time is step 20.

**The build (19a.1):**

9. **`vite-plugin-pwa` 2.0, with a worker we write ourselves** (`injectManifest`). The plugin builds `sw/sw.ts` with
   Vite and puts the list of the build's files in it. Its other mode (`generateSW`) writes the whole worker from a
   config; that would work today, but the worker would be code nobody in the repo reads, with no type check, and 19b
   and later steps add their own parts to it. Version 2.0.0 (3 October 2026) is the first that lists Vite 8 as a peer.
   Workbox 7.4 is the library behind both modes; the three modules the worker imports (`workbox-core`,
   `workbox-precaching`, `workbox-routing`) are the app's own dependencies.
10. **The worker lives in `apps/app/sw/`, with its own `tsconfig.json`.** A service worker has no `document` and no
    `window`; its types come from TypeScript's `WebWorker` library, which cannot be mixed with the `DOM` library
    the app uses. A folder of its own with its own `tsconfig.json` is the pattern `scripts/` and `e2e/` already
    follow, and ESLint's `projectService` finds that `tsconfig.json` by itself.
11. **The plugin does not register the worker; the app does (19a.4).** It registers it after the first render, and
    only in a production build. `pnpm dev` never has it (a worker would keep old files while you edit them), and
    `pnpm dev:mock` cannot: MSW's own worker needs the same scope (`/`), and a page has one worker per scope. The
    Playwright tests run on the mock API, so they are not touched; the worker gets its own tests on the production
    build (19a.5).
12. **Every page of the app answers with `index.html`, with no list of exceptions.** The router reads the address,
    as it does today. The API is on its own origin (`VITE_API_URL`), and a service worker never answers another
    origin's pages, so no API path needs to be excluded. The API's requests do pass through the worker (every request
    of a page it controls does), but no route of the worker matches them, so the browser sends them as usual.
13. **The first install takes over the open page at once (`clientsClaim`); an update never does.** Without it, the
    first visit is not controlled until the next load, and a person who opened the app once and lost the connection
    would still get the browser's error on a reload. The host must send `sw.js` and `index.html` with
    `Cache-Control: no-cache` (a short check, not "never cache"): the browser always checks `sw.js` itself, but a CDN
    in front of the app could serve an old one for hours.
14. **Every built script, style and woff2 font is kept, and nothing else.** Not the `.woff` fonts: the font CSS lists
    them after the woff2 ones for old browsers, and every browser this app supports takes woff2 (20 fonts instead of
    29). Not `mockServiceWorker.js`, which Vite copies from `public/` into every build. The list is 374 files, 1.3 MB
    gz to download the first time; a new version downloads only the files that changed (their names carry a hash).
15. **`test:bundle-size` checks the list.** Workbox leaves a file out with only a warning in the build log: one bigger
    than 2 MiB, or a kind the glob does not name (an image someone imports later). That screen would then fail
    offline, so the check fails when a built file is missing from the list. It also gives the list a budget of 2 MB
    gz, so a large file added by mistake is seen.
16. **The icons are made once and committed.** `@vite-pwa/assets-generator` turns `favicon.svg` into the four PNGs,
    run by hand with `pnpm dlx`. The plugin can also make them at every build, but that would put `sharp` (a native
    image library) into every install and every CI run, for files that change when the logo changes. The config file
    stays in the repo so the next run gives the same files. The maskable icon has more space around the logo (0.4
    instead of the usual 0.3), so Android's circle mask never cuts the logo's corners.
17. **The manifest's colours are the light theme's `surface` and `bg`, written as hex.** A manifest is JSON and cannot
    read the CSS tokens, the same reason `favicon.svg` has its hex values by hand. The `theme-color` tags in
    `index.html` follow the system's light or dark mode.

**The words (19a.2):**

18. **Sizes are written in SI units, from kB up** (1 MB = 1,000,000 bytes). That is what "MB" means, and what the
    storage screens of macOS, iOS and Android count in. `formatBytes` lives in `@omnivo/i18n` next to the money and
    date formatters, so the Sync page writes "24.5 MB" / "২৪.৫ MB" through `useLocale().format`, like every other
    number. The unit stays "MB" in Bangla: that is how ICU writes it, and the app does not translate it, like other
    office terms.
19. **A sign-in refused after an offline opening keeps the copy.** When the connection is back, the app checks the
    sign-in; if the server refuses it (the sign-in expired, the password was reset, the person was removed), the app
    signs out, as it does today on a refused refresh, and the sign-in page says `auth.login.sessionEnded`. Only
    "Sign out" and a revoke delete the copy (steps 18a and 18c). The copy belongs to one person in one workspace, so
    signing in again as that person opens it and sends the changes made offline. Deleting it would throw away a
    day's work done in good faith.
20. **Safari gets a dialog that says where its own command is.** Chrome and Edge give the page an install prompt
    (`beforeinstallprompt`), and "Install app" opens it. Safari can add a web app too (iOS and iPadOS: Share → Add to
    Home Screen; macOS: File → Add to Dock), but it gives the page no prompt to open, so the item opens a dialog with
    those steps. In a browser with neither, the item is hidden (19a.4).

**The offline sign-in (19a.3):**

21. **The browser remembers the last `me`, never a token.** `me` is what the server says about the person: name,
    workspace, roles, permissions, preferences. The app needs it to draw any screen, and it is all an offline opening
    has. It sits in localStorage under one key (`omnivo.me`): the last sign-in of this browser, whoever it was. The
    session store writes it on every sign-in and every new `me`, and removes it on every sign-out, so no screen has
    to remember to do it. The access token stays in memory only, as before: a token in localStorage would be readable
    by any script that gets into the page, and an offline opening has no use for it, since no server can check it.
    The remembered `me` is not the workspace's data (no customer, no price, no stock), so 19a leaves it readable;
    19b encrypts the copy, and says what it does with this key.
22. **Only "no answer" opens offline, never a refusal.** No connection, or a 5xx (the API restarting, or a proxy
    in front of it failing), opens the last person's copy. A 401 or 403 from the refresh means the server checked and
    said no: the app shows the sign-in page, as before. So `refreshSession` now throws for a 5xx instead of giving
    `null`. That also changes one thing online, for the better: a 502 during a token refresh used to sign the person
    out; now the request fails like a lost connection, and the next request tries the refresh again.
23. **Only a device that has a copy opens offline.** The device's identity (step 18a) must name a branch, which
    means a copy was pulled. A device in "Not now" has nothing to open, and a revoked device has no identity at all
    (step 18c), so neither opens: both get the sign-in page.
24. **The sign-in is checked at the first chance, three ways.** The first request that reaches the server gets a
    401 (it has no token), and `call()` runs the check before it gives up. The browser's `online` event runs it too.
    And every minute while the browser says it is online, because a reload while the API was down opened offline
    with the browser online, and no `online` event comes then. When the check gives back the same person in the same
    workspace, the app keeps what it shows and asks the server again for everything (`invalidateQueries`). When it is
    someone else (another tab signed in as another person meanwhile), that sign-in wins from an empty cache, like any
    new sign-in.
25. **Signing out offline signs out at once, and tells the server later.** This was left open after 19a.2. The
    sign-out's request cannot reach the server, so the server's session and the browser's cookie still work. The
    app signs out on the device at once (the copy is deleted, as in 18a), and remembers that the server has not heard
    of it (`omnivo.signOutPending`). While that mark is there, the app never refreshes the cookie: the next reload
    sends the sign-out first and stays signed out, and a new sign-in sends it first too. The other choice, refusing
    to sign out without a connection, would leave a shared counter PC signed in as the last person, which is worse.
    One limit: a browser that refuses localStorage cannot keep the mark, and its next online reload signs the person
    in again. Such a browser cannot open offline either.
26. **A device revoked while it was offline looks like a refused sign-in.** A revoke ends the device's session on
    the server (step 18c), and the refresh then answers like an expired session: there is no separate code. So the
    app signs out with "You were signed out while offline", and the copy stays. The next sign-in as that person pulls,
    the server answers `device_revoked`, and 18c's revoke deletes the copy and sets up a new device. Until then the
    copy is on the device but cannot be opened: the remembered `me` is gone, and the cookie no longer works.
27. **The first load's budget is 215 KB now.** (You chose this.) 19a.2's words took the first load to 210.5 KB, and
    this part's code to 211.6 KB. The offline opening itself is a lazy chunk (0.6 KB gz); what stays in the first
    load is what every reload needs: remembering `me`, the sign-out that waits, and the check in `call()`. From this
    step on, the service worker keeps these files, so only the very first visit of a device downloads them.
28. **The sign-in page says when it is offline.** A neutral notice with the `WifiDisconnected02` icon, the one the
    lists use for "offline" (CLAUDE.md → Device copy states), above the form.

**The app (19a.4):**

29. **The app registers the worker after the page has loaded.** Registering starts the first download of the whole
    list (380 files, 1.3 MB gz). Started earlier, it would compete with the page's own scripts on a slow connection.
    A page that has loaded already registers at once.
30. **Every tab hears of an update; only the one that clicks reloads.** This was an open point after 19a.1. When a
    new version waits, every open tab shows the notice. A click on Reload in one tab makes the new version take over,
    and the new worker then deletes the old version's files. Another tab still runs the old version and would fail at
    its next page that is not loaded yet, so it says "Omnivo was updated in another tab" instead of reloading. A tab
    is never reloaded under the person.
31. **The app looks for a new version every hour, when the connection comes back, and when the server says the app
    is too old.** The browser checks `sw.js` on every page load, but a counter PC can keep one tab open for days. The
    sync notice for `sync_protocol_mismatch` (18a) now looks at once, and its Reload takes the waiting version: a
    plain reload would only open the old version again, from the worker's files.
32. **The notice looks like a toast, but it stays.** It sits at the bottom, `ink` with `bg` text like a toast
    (CLAUDE.md → Toast), so it never moves the page under an open form. It has no close button: it says what is
    needed, and in the other tab's case that tab's next page needs the reload. CLAUDE.md has no "update notice" yet;
    19a.7 adds it to the component list.
33. **"Install app" is in the account menu, after My devices,** because it is about this device, like My devices.
    Chrome's prompt is caught before the first render (it comes once per page load, often before the menu exists),
    and `preventDefault` stops Chrome on Android from showing its own bar over the bottom of the page, where a form's
    buttons are. A prompt can be used once; after it, the item hides until Chrome offers a new one.
34. **Safari is recognised by its user agent.** It has no install prompt and nothing else a page can test for, so
    the name in the user agent is the only sign. iPadOS says "Macintosh" like a Mac; a touch screen tells them apart.
    A wrong guess only shows steps that do not apply; nothing breaks.
35. **The icon shows the number of changes on the device, refused ones included:** the same number as the Sync line
    (`syncSummaryStore.waiting`). It is cleared on sign-out, because the outbox is deleted then and the next person
    must not see the count. A browser without the badge API shows nothing.
36. **The browser is asked to keep the copy when the device is set up** (the branch is chosen, just before the first
    pull), and again by the Sync page's button. Not awaited: Firefox asks the person, and the pull must not wait for
    the answer.
37. **The storage card is the last card on the Sync page,** because nothing in it changes from one sync to the next.
    "May be cleared" is a `warn` pill: the person can act on it, and what is at stake is work not synced yet.
38. **Mock mode keeps 18b's background loading,** now in `src/mocks/offline-screens.ts`. Decision 4 deletes it from
    the app, because a production build has the worker. But `pnpm dev:mock` cannot have our worker (decision 11), and
    the Playwright tests run in that mode and go offline: without the loading, 7 tests of 18b and 18c failed on a
    page whose code could not load offline. In `src/mocks/` it never reaches a production build.
39. **The `theme-color` tags stay as 19a.1 wrote them** (decision 17). This was an open point after 19a.1. The app
    could set them from the person's own theme choice, but that is code in `theme.ts` for the colour of a browser
    bar. It can come later if anyone asks.
40. **The session's unit tests "reload the page" with `vi.resetModules()`,** in Node, with a pretend `window` (an
    `EventTarget` with a small localStorage). apps/app's tests have no DOM, and adding jsdom for two files is not worth
    it. A reset gives new copies of every module (the session store, `restoreSession`'s promise, the offline check),
    and only the storage stays, which is exactly what a real reload does.
41. **`updateStore` is exported** from `app-update.ts`, like `sessionStore`, so the unit tests can read the state
    without React. The screens still read it with `useUpdateState`.
42. **The worker is tested on its own production build,** with its own Playwright config (`*.pwa.ts`, port 4174,
    one test at a time). The build goes to `node_modules/.pwa-e2e`, never `dist/`, and its API is
    `http://127.0.0.1:9`, where nothing answers, so on a machine that runs `pnpm dev` the real API can never answer
    these tests. Each test starts its own `vite preview` and stops it to be offline for real: Playwright's
    `setOffline` is the page's view, and a worker could still reach a server that runs.
43. **The worker tests run in desktop Chromium only.** The worker's code is the same on a phone, and Playwright
    supports service workers in Chromium only. The phone sizes are tested by the mock app's suites.
44. **CI runs the worker tests after the mock e2e,** as their own step (`pnpm test:e2e:pwa`). It needs about a
    minute: one build and three tests.

## 19a.1 — `apps/app`: the build, the service worker and the manifest

Nothing in the app uses the worker yet: this part only makes the build produce it, with the manifest and the icons.
The app registers it in 19a.4. Until then, you can try it by hand (see "Check this part").

### The packages

```bash
pnpm --filter @omnivo/app add -D vite-plugin-pwa@^2.0.0
pnpm --filter @omnivo/app add workbox-core@^7.4.1 workbox-precaching@^7.4.1 workbox-routing@^7.4.1
pnpm dedupe
```

```diff
@@ -8,10 +8,11 @@
     "dev:mock": "vite --mode mock",
     "build": "tsc --noEmit && vite build",
     "preview": "vite preview",
-    "typecheck": "tsc --noEmit && tsc --noEmit -p scripts && tsc --noEmit -p e2e",
+    "typecheck": "tsc --noEmit && tsc --noEmit -p scripts && tsc --noEmit -p e2e && tsc --noEmit -p sw",
     "test": "vitest run --passWithNoTests",
     "test:bundle-size": "node scripts/check-bundle-size.ts",
-    "test:e2e": "playwright test --config e2e/playwright.config.ts"
+    "test:e2e": "playwright test --config e2e/playwright.config.ts",
+    "test:e2e:pwa": "playwright test --config e2e/playwright.pwa.config.ts"
   },
   "devDependencies": {
     "@omnivo/config": "workspace:*",
@@ -25,6 +26,7 @@
     "tailwindcss": "^4.3.3",
     "typescript": "^6.0.3",
     "vite": "^8.3.0",
+    "vite-plugin-pwa": "^2.0.0",
     "vitest": "^5.0.1"
   },
   "dependencies": {
@@ -40,6 +42,9 @@
     "react": "^19.3.0",
     "react-dom": "^19.3.0",
     "react-hook-form": "^7.89.0",
+    "workbox-core": "^7.4.1",
+    "workbox-precaching": "^7.4.1",
+    "workbox-routing": "^7.4.1",
     "zod": "^4.6.5",
     "zustand": "^5.0.15"
   }
```

- **This part adds the `sw` type check and the four packages.** The `test:e2e:pwa` line comes with the worker's
  tests in 19a.5; type it then.
- **`vite-plugin-pwa` is a dev dependency, the three Workbox modules are not.** The plugin only runs during the
  build. The Workbox modules become the code of `sw.js`, the way `react` becomes the code of the app, so they sit in
  `dependencies` next to it. They must be the app's own dependencies in any case: with pnpm, `sw.ts` can import only
  the packages its own `package.json` names, not the copies that `workbox-build` brings along.
- **`pnpm dedupe` is needed once.** `workbox-build` (inside the plugin) brings about 250 packages for the build,
  Babel among them, and the first install picks older copies of a few that the repo already has in newer versions.
  `pnpm dedupe --check` in CI fails until they are merged.
- **The `typecheck` script gets `tsc --noEmit -p sw`:** the worker is type-checked on its own (decision 10), so the
  app's `tsc --noEmit` alone would never see it.

### The service worker: `sw/sw.ts` (new) and `sw/tsconfig.json` (new)

```json
{
  "extends": "../../../packages/config/tsconfig/base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023", "WebWorker"],
    "types": [],
    "noEmit": true,
    "declaration": false
  },
  "include": ["*.ts"]
}
```

- **`"lib": ["ES2023", "WebWorker"]`, no `DOM`.** The worker's global is `ServiceWorkerGlobalScope`, which has
  `skipWaiting()`, `clients` and the `install`/`activate`/`fetch` events; `document` and `window` do not exist there,
  and with this library a line that uses them fails the type check instead of failing in the browser.
- **`"types": []`:** the base config would otherwise load every `@types/*` package it finds, and `@types/node` would
  bring Node's globals into a file that runs in a browser.
- **`moduleResolution: "Bundler"`** like the app's own config: Vite builds this file, and the Workbox packages are
  resolved the way Vite resolves them.

```ts
import { clientsClaim } from 'workbox-core';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

// Step 19a: the app's own files on the device. The browser runs this file apart from the page, and
// it answers the page's requests for the app's files from a cache, so the app opens and every
// screen loads without a connection. The data is not here: it lives in IndexedDB (step 18), and
// the API's requests go to the network untouched.

// The WebWorker lib types `self` as a plain worker. This file only ever runs as a service worker.
declare const self: ServiceWorkerGlobalScope;

// Every file of this build, with a hash of its content (see vite.config.ts). The plugin puts the
// list here when it builds this file. A new build makes a new list, so the browser sees a changed
// service worker and installs it next to the running one: the update of decision 3.
precacheAndRoute(self.__WB_MANIFEST);

// The lists of older Workbox versions (a different cache name) are deleted. This build's own
// list deletes the files that left it by itself, when it takes over.
cleanupOutdatedCaches();

// Every page of the app is index.html: the router reads the address in the browser. Opening
// /sales/orders offline, or reloading on it, gets the cached index.html. The API never reaches
// this route: it is on another origin (VITE_API_URL), and a service worker only answers the
// navigations of its own origin.
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')));

// The first time: the page that installed this worker becomes its client at once, so a reload
// without a connection already works. Later versions never take over by themselves (they wait,
// see below), so this only changes the very first install.
clientsClaim();

// A new version waits until every tab of the old one is closed. "Reload" in the app's notice
// (19a.4) sends this message to the waiting worker, which then takes over, and the page reloads.
// It never happens without the click: a reload under an open form would lose what was typed.
self.addEventListener('message', (event) => {
  // MessageEvent's data is `any`; read it as unknown and check its shape (rule 3)
  const data: unknown = event.data;
  if (typeof data === 'object' && data !== null && 'type' in data && data.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});
```

- **`declare const self: ServiceWorkerGlobalScope`.** The `WebWorker` library types `self` as a plain worker, which
  has no `skipWaiting()` and no `__WB_MANIFEST`. In a module file this line declares `self` again with the exact type,
  the pattern Workbox documents. Without it, `self.skipWaiting()` fails the type check, and ESLint reports every use of
  `self` as unsafe.
- **`self.__WB_MANIFEST` must be written exactly like this.** The plugin finds this expression in the built file and
  replaces it with the list of files (`[{"revision":null,"url":"assets/index-….js"}, …]`). Its type comes from
  `workbox-precaching`, which adds it to `ServiceWorkerGlobalScope`. A file whose name has a hash gets `revision:
  null`: a new content means a new name. `index.html` and the icons keep their names, so they get a revision (a hash
  of their content), and a new `index.html` is downloaded again when it changes.
- **`precacheAndRoute` does two things:** it downloads the list when the worker installs (all of it, or the install
  fails and the old version keeps running), and it answers every request for one of those files from the cache,
  without asking the network. That is why a chunk never opened online still loads offline.
- **`cleanupOutdatedCaches()`** only deletes caches that older Workbox versions named differently. When this build's
  worker takes over, `precacheAndRoute` itself deletes the files the new list no longer has.
- **`createHandlerBoundToURL('index.html')`** answers with the cached `index.html`. The URL is the one in the list, so
  it is relative (`index.html`, not `/index.html`); Workbox resolves it against the worker's own address.
- **`NavigationRoute` only answers navigations:** opening a page, a reload, a link that opens a new tab. A `fetch()`
  by the app is never a navigation, so it never gets `index.html` by mistake. Decision 12 explains why there is no
  list of exceptions.
- **`clientsClaim()`** makes the first install control the page that installed it (decision 13). On an update it does
  nothing until the new worker activates, and that only happens after the message below.
- **The message is checked as `unknown`.** `event.data` is typed `any` by the browser's types; reading
  `event.data.type` directly fails ESLint's `no-unsafe-member-access` (rule 3). The shape `{ type: 'SKIP_WAITING' }`
  is what Workbox's own page-side library (`workbox-window`, 19a.4) sends. Only pages of the same origin can send a
  message to this worker.
- **`void self.skipWaiting()`:** it returns a promise the handler does not wait for. The page learns that the new
  worker took over from the `controllerchange` event, not from this promise.

### The icons: `pwa-assets.config.js` (new) and four PNGs

```js
// Step 19a: how the app icons in public/ were made. They are committed, so the build never runs
// this. Run it again only when the logo changes:
//   pnpm dlx @vite-pwa/assets-generator@2.0.0 --manifest false
// (from apps/app). It reads favicon.svg and writes the PNGs next to it.
export default {
  images: ['public/favicon.svg'],
  preset: {
    // The logo on a clear background, for the install dialog and the desktop's app list
    transparent: { sizes: [192, 512], favicons: [] },
    // Android cuts the icon to a circle or a rounded square. Everything inside the middle 80% (a
    // circle) is kept. The logo's rounded corners reach 63% of its width from its centre, so it
    // must be at most 326 px wide on 512: padding 0.4 makes it 307 px.
    maskable: { sizes: [512], padding: 0.4, resizeOptions: { background: '#ffffff' } },
    // iOS puts its own rounded corners on a square with no see-through parts
    apple: { sizes: [180], padding: 0.3, resizeOptions: { background: '#ffffff' } },
  },
};
```

Then, once, from `apps/app`:

```bash
pnpm dlx @vite-pwa/assets-generator@2.0.0 --manifest false
```

It writes `pwa-192x192.png`, `pwa-512x512.png`, `maskable-icon-512x512.png` and `apple-touch-icon-180x180.png` into
`public/`, next to `favicon.svg`. Commit the four PNGs.

- **The source is `favicon.svg` itself,** so the app icon is always the logo the tab shows. The image library ignores
  the SVG's dark-mode `@media` block, so the icons get the light colours. That is what an icon on a home screen needs:
  it does not change with the theme.
- **`--manifest false`:** the generator would otherwise print a manifest entry to copy. The manifest is written in
  `vite.config.ts` below, where it can be read next to the rest of the build.
- **`favicons: []`:** no `favicon.ico`. Every browser the app supports reads `favicon.svg`.
- **The maskable padding of 0.4 is worked out, not guessed.** Android keeps only a circle of 80% of the icon. The
  logo's two rounded corners reach 16.3 of its 26 units from its centre, 63% of its width; 63% of a logo 307 pixels
  wide is 193 pixels, inside the circle's 205. With the usual 0.3, the logo is 358 pixels wide and its corners reach
  225 pixels, so a circle mask would cut them.
- **The white background on the maskable and Apple icons** is there because both are shown as a full square or
  circle with nothing see-through. The transparent ones are for the install dialog and the desktop's list of apps.
- **A `.js` file, not `.ts`:** the generator runs from `pnpm dlx`, outside the workspace, and loads the file as it is.
  ESLint's config already treats plain `.js` files as Node config files.

### `vite.config.ts`: the worker and the manifest

```diff
@@ -1,6 +1,7 @@
 import tailwindcss from '@tailwindcss/vite';
 import react from '@vitejs/plugin-react';
 import { defineConfig, type Plugin } from 'vite';
+import { VitePWA } from 'vite-plugin-pwa';
 
 // One route's summary in the built contracts, a whole line: `summary: 'Sales orders, newest date
 // first',` (a summary with an apostrophe is in double quotes). Never `summary: route.summary,`.
@@ -20,8 +21,52 @@ function dropRouteSummaries(): Plugin {
   };
 }
 
+// Step 19a: the service worker (sw/sw.ts) and the web app manifest. The worker is written by hand
+// (injectManifest): the plugin only builds it and puts the list of this build's files in it.
+const pwa = VitePWA({
+  strategies: 'injectManifest',
+  srcDir: 'sw',
+  filename: 'sw.ts',
+  // The app registers the worker itself, after the first render and only in a production build
+  // (19a.4). `pnpm dev` and `pnpm dev:mock` never get it: MSW's worker needs the same scope (/).
+  injectRegister: false,
+  devOptions: { enabled: false },
+  manifest: {
+    id: '/',
+    name: 'Omnivo',
+    short_name: 'Omnivo',
+    description: 'Accounting, sales, purchase and stock, online and offline',
+    start_url: '/',
+    scope: '/',
+    display: 'standalone',
+    lang: 'en',
+    // The window's title bar (surface) and the splash screen while it opens (bg). A manifest
+    // cannot read the CSS tokens, so these are the light theme's hex values, like favicon.svg.
+    theme_color: '#ffffff',
+    background_color: '#f6f7f9',
+    icons: [
+      { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
+      { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
+      {
+        src: 'maskable-icon-512x512.png',
+        sizes: '512x512',
+        type: 'image/png',
+        purpose: 'maskable',
+      },
+    ],
+  },
+  injectManifest: {
+    // Decision 4: every script, style and font of the build. Each page and each dialog is a chunk
+    // of its own, and one that was never opened online must still open offline. Not *.woff: the
+    // font CSS lists it after woff2 for old browsers, and every browser we support takes woff2.
+    globPatterns: ['**/*.{js,css,html,svg,woff2}'],
+    // MSW's worker is in public/ for `pnpm dev:mock`, and Vite copies public/ into the build.
+    globIgnores: ['mockServiceWorker.js'],
+  },
+});
+
 export default defineConfig({
-  plugins: [react(), tailwindcss(), dropRouteSummaries()],
+  plugins: [react(), tailwindcss(), dropRouteSummaries(), pwa],
   server: { port: 5173, strictPort: true },
   // dist/.vite/manifest.json: কোন chunk কোন chunk-কে import করে — bundle-size চেক এটা পড়ে
   build: { manifest: true },
```

- **`strategies: 'injectManifest'`, `srcDir: 'sw'`, `filename: 'sw.ts'`:** the plugin builds `sw/sw.ts` into
  `dist/sw.js`, at the root, so its scope is the whole app (`/`). A worker only controls the pages at or below its own
  address, so `dist/assets/sw.js` would control nothing.
- **`injectRegister: false` and `devOptions: { enabled: false }`** (decision 11). With the plugin's defaults it would
  add a registering script to `index.html`, in every mode.
- **`id: '/'`** names the installed app. Without it, the browser uses `start_url`, and changing `start_url` later
  would make an installed app a different one, installed twice.
- **`display: 'standalone'`:** the installed app opens in its own window with no address bar. The app's own top bar
  and sidebar are its navigation.
- **The icons are listed by hand,** the same three files the generator wrote (the Apple icon is not in the manifest:
  iOS reads it from `index.html`). The plugin adds the manifest's icons to the worker's list by itself.
- **`globPatterns` lists the kinds of files to keep** (decision 14). `html` is `index.html`, `svg` is `favicon.svg`.
  The plugin never lists `sw.js` itself.
- **`globIgnores: ['mockServiceWorker.js']`:** it is in `dist/` because Vite copies all of `public/`. Keeping it would
  cost nothing, but it has no use in a production build.

The build prints one warning from the plugin, `inlineDynamicImports option is deprecated`. It comes from the way
`vite-plugin-pwa` 2.0 builds the worker with Vite 8, not from this config; the built worker is correct (it is one file
with no imports). It goes away when the plugin changes its own option.

### `index.html`: the iOS icon and the theme colour

```diff
@@ -4,6 +4,12 @@
     <meta charset="UTF-8" />
     <meta name="viewport" content="width=device-width, initial-scale=1.0" />
     <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
+    <!-- Step 19a: iOS reads its home-screen icon from here, not from the manifest -->
+    <link rel="apple-touch-icon" href="/apple-touch-icon-180x180.png" />
+    <!-- The browser's bar and the installed app's title bar: the surface token, light and dark.
+         The build adds <link rel="manifest"> itself (vite-plugin-pwa). -->
+    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
+    <meta name="theme-color" content="#111722" media="(prefers-color-scheme: dark)" />
     <title>Omnivo</title>
     <!-- প্রথম রং আঁকার আগেই থিম: React লোড হতে কয়েকশো ms লাগে, ততক্ষণ dark বাছাই করা ইউজার সাদা পেজ
          দেখত। key আর মান src/lib/theme.ts-এর সাথে এক -->
```

- **`apple-touch-icon`:** Safari on iOS ignores the manifest's icons for the home screen and reads this tag.
- **Two `theme-color` tags with `media`:** the browser's bar on a phone, and the title bar of the installed app, take
  the `surface` colour of the system's theme. The manifest has one colour only (the light one); the tags win when the
  page is open. A person who chose dark in the app while the system is light still gets the light bar.
- **No `<link rel="manifest">` by hand:** the plugin adds it to the built `index.html`, and only there.

### `scripts/check-bundle-size.ts`: the worker's list

```diff
@@ -1,4 +1,4 @@
-import { readFileSync } from 'node:fs';
+import { readdirSync, readFileSync } from 'node:fs';
 import path from 'node:path';
 import { gzipSync } from 'node:zlib';
 
@@ -17,6 +19,10 @@ const INITIAL_BUDGET = 210 * 1024;
 // The customer box and the pickers now read the device's customers with the outbox on top, and the
 // line editors and the shell were already at 104–105 KB.
 const CHUNK_BUDGET = 110 * 1024;
+// Step 19a: everything the service worker downloads the first time, gz (the fonts do not shrink).
+// 1.3 MB at 19a. It is downloaded once per device; a new version downloads only the files that
+// changed.
+const PRECACHE_BUDGET = 2 * 1024 * 1024;
 
 const dist = path.resolve(import.meta.dirname, '../dist');
 
@@ -72,7 +78,28 @@ for (const [key, chunk] of Object.entries(manifest)) {
   if (bytes > CHUNK_BUDGET) failed = true;
 }
 
+// Step 19a: the files the service worker keeps (sw/sw.ts). The build writes their list into sw.js
+// as JSON ({"revision":…,"url":"assets/…"}). Workbox leaves a file out with only a warning in the
+// build log: one over 2 MiB, or a kind the glob in vite.config.ts does not name (a .webp someone
+// imports later). That screen would then fail offline, so every built asset must be in the list.
+const sw = readFileSync(path.join(dist, 'sw.js'), 'utf8');
+const precached = new Set([...sw.matchAll(/"url":"([^"]+)"/g)].flatMap((match) => match[1] ?? []));
+// *.woff is left out on purpose (vite.config.ts): every browser we support loads the woff2
+const missing = readdirSync(path.join(dist, 'assets'))
+  .map((file) => `assets/${file}`)
+  .filter((file) => !file.endsWith('.woff') && !precached.has(file));
+for (const file of missing) console.error(`not precached  ${file}`);
+if (missing.length > 0 || !precached.has('index.html')) failed = true;
+
+const precacheBytes = [...precached].reduce((sum, file) => sum + gzipBytes(file), 0);
+console.log(
+  `precache    ${String(precached.size)} files  ${kb(precacheBytes)} gz  (budget ${kb(PRECACHE_BUDGET)})`,
+);
+if (precacheBytes > PRECACHE_BUDGET) failed = true;
+
 if (failed) {
-  console.error('Bundle budget exceeded — lazy-load the heavy part or remove a dependency.');
+  console.error(
+    'Bundle budget exceeded or a file not precached — lazy-load the heavy part, remove a dependency, or add the file kind to globPatterns in vite.config.ts.',
+  );
   process.exit(1);
 }
```

- **The list is read from `sw.js`** with `"url":"…"`: the plugin writes it with `JSON.stringify`, so the shape is the
  same in every build, minified or not.
- **Every file in `dist/assets/` must be in the list,** except the `.woff` fonts left out on purpose. Checking the
  folder, not the Vite manifest, also catches files the manifest does not name, such as the fonts the CSS loads.
- **`index.html` must be in the list:** without it, the navigation route has nothing to answer with, and every
  offline reload fails.
- **The budget counts gz bytes,** like the other budgets: the browser downloads the files compressed. The fonts do not
  shrink (woff2 is already compressed), so they count at their full size.
- **`String(precached.size)`:** ESLint's `restrict-template-expressions` does not allow a number in a template string
  without saying so.

### Check this part

```bash
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/app build
pnpm --filter @omnivo/app test:bundle-size
pnpm --filter @omnivo/app test
```

All four pass: the build lists `precache 374 entries (3443.76 KiB)`, and `test:bundle-size` prints
`precache 374 files 1310.8 KB gz (budget 2048.0 KB)`; the first load is still 209.9 KB, because nothing in the app
imports the worker's code. The app's unit tests (144) pass with the plugin in `vite.config.ts`, which Vitest also
reads.

Try the worker by hand before 19a.4 registers it:

1. `pnpm --filter @omnivo/app preview` (port 4173: another origin than `pnpm dev`'s 5173, so MSW's worker there is not
   touched).
2. Open `http://localhost:4173`, and in the browser's console run `await navigator.serviceWorker.register('/sw.js')`.
   DevTools → Application → Service workers shows it activated, and Cache storage shows 374 entries.
3. Stop the preview server and reload: the app opens. Go to `/sales-orders` in the address bar: it opens too (the
   data cannot load, since no API runs; the files can).
4. Unregister it afterwards (Application → Storage → Clear site data), so the next build starts clean.

Also checked while writing this part: removing `woff2` from `globPatterns` makes `test:bundle-size` fail and name the
20 fonts; removing the `declare const self` line fails the type check; reading `event.data.type` directly fails
ESLint. In Chromium (Playwright), with the preview server stopped: the reload, `/sales-orders`, and a chunk the page
had never loaded all answered from the worker; a changed `sw.js` installed and waited, and the `SKIP_WAITING` message
made it take over. `pnpm dev:mock` serves no `sw.js` and no manifest.

## 19a.2 — `packages/i18n`: the words

The screens of 19a.3 and 19a.4 need their words in English and Bangla, and the app cannot type-check without them, so
they come first. This part changes the two locale files and adds one formatter, `formatBytes`. The ui package needs
nothing new: the update notice and the storage card use the document notice, the card and the pills that exist, and
the install steps are a dialog.

When this part starts, everything type-checks. When it ends, it still does: no screen uses the new keys yet.

### `format.ts`: `formatBytes`

```diff
@@ -58,6 +58,42 @@ export function formatMoney(
   return `${sign}৳${digits}`;
 }
 
+// Step 19a: the storage the device copy uses (the Sync page). SI units, 1 MB = 1,000,000 bytes:
+// what "MB" means, and what macOS, iOS and Android show in their own storage screens
+const BYTE_UNITS = ['kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;
+
+type ByteUnit = (typeof BYTE_UNITS)[number];
+
+const byteFormats = new Map<string, Intl.NumberFormat>();
+
+function byteFormat(language: Language, unit: ByteUnit): Intl.NumberFormat {
+  const key = `${language}:${unit}`;
+  let format = byteFormats.get(key);
+  if (!format) {
+    format = new Intl.NumberFormat(NUMBER_LOCALE[language], {
+      style: 'unit',
+      unit,
+      maximumFractionDigits: 1,
+    });
+    byteFormats.set(key, format);
+  }
+  return format;
+}
+
+// "24.5 MB" / "২৪.৫ MB". Never in bytes: a copy of a branch is never that small, and "byte" is
+// the one unit ICU spells out in English
+export function formatBytes(bytes: number, language: Language): string {
+  let value = bytes / 1000;
+  let unit: ByteUnit = 'kilobyte';
+  for (const next of BYTE_UNITS.slice(1)) {
+    // shown with 1 decimal: 999.96 kB would round to "1,000 kB", so it moves up from 999.95
+    if (value < 999.95) break;
+    value /= 1000;
+    unit = next;
+  }
+  return byteFormat(language, unit).format(value);
+}
+
 // en-GB নতুন ICU-তে "Sept" লেখে, তাই en-US-এর অংশ নিয়ে নিজেরা সাজানো: "23 Sep 2026"
 const EN_DATE = new Intl.DateTimeFormat('en-US', {
   day: 'numeric',
```

- **`style: 'unit'` with a `unit` from a fixed list.** `Intl.NumberFormat` knows `kilobyte`, `megabyte`, `gigabyte`
  and `terabyte`, and writes them short ("MB") in both languages, with the language's digits and grouping. The list
  is `as const`, so `ByteUnit` is the union of the four names, and TypeScript checks that each one is a unit `Intl`
  accepts.
- **The formats are kept in a `Map`,** like `numberFormat` above: making an `Intl.NumberFormat` is slow, and the Sync
  page draws two sizes on every render.
- **It starts at kB, never bytes.** A copy is never that small, and ICU writes "byte" as a whole word in English
  ("512 byte"), which reads wrong next to "MB".
- **It moves up at 999.95, not 1000.** The value is shown with one decimal, so 999.96 kB would round to "1,000 kB";
  moving up first gives "1 MB".
- **The loop walks `BYTE_UNITS.slice(1)`,** not an index: with `noUncheckedIndexedAccess`, `BYTE_UNITS[i]` would be
  `ByteUnit | undefined` and need a check that can never fail.
- **No case for a negative number.** The only input is `navigator.storage.estimate()`, whose `usage` and `quota` are
  never negative; the page leaves the line out when the browser gives no numbers (19a.4).

```diff
@@ -2,6 +2,7 @@ import { useCallback, useMemo } from 'react';
 import { useTranslation } from 'react-i18next';
 
 import {
+  formatBytes,
   formatDate,
   formatDateTime,
   formatMoney,
@@ -38,6 +39,7 @@ export function useLocale() {
       month: (date: Date) => formatMonth(date, language),
       dateTime: (date: Date, timeZone: string) => formatDateTime(date, language, timeZone),
       monthName: (month: number) => formatMonthName(month, language),
+      bytes: (bytes: number) => formatBytes(bytes, language),
     }),
     [language],
   );
```

```diff
@@ -2,6 +2,7 @@ import './types.js';
 
 export { i18n, isLanguage, LANGUAGES, languageReady, setLanguage, type Language } from './i18n.js';
 export {
+  formatBytes,
   formatDate,
   formatDateTime,
   formatMoney,
```

- **`format.bytes`** joins the other formatters in `useLocale()`, so a screen writes `format.bytes(usage)` and gets
  the page's language. `formatBytes` is exported too, like the others, for code outside React.

```diff
@@ -1,6 +1,7 @@
 import { describe, expect, it } from 'vitest';
 
 import {
+  formatBytes,
   formatDate,
   formatDateTime,
   formatMoney,
@@ -74,3 +75,23 @@ describe('formatMonthName', () => {
     expect(formatMonthName(7, 'bn')).toBe('জুলাই');
   });
 });
+
+describe('formatBytes', () => {
+  it('picks the unit and keeps one decimal', () => {
+    expect(formatBytes(24_500_000, 'en')).toBe('24.5 MB');
+    expect(formatBytes(1_234_000_000, 'en')).toBe('1.2 GB');
+  });
+
+  it('writes Bangla digits and keeps the unit as it is', () => {
+    expect(formatBytes(24_500_000, 'bn')).toBe('২৪.৫ MB');
+  });
+
+  it('starts at kB, and moves up before the rounding would print 1,000', () => {
+    expect(formatBytes(0, 'en')).toBe('0 kB');
+    expect(formatBytes(999_960, 'en')).toBe('1 MB');
+  });
+
+  it('groups a large value the lakh way', () => {
+    expect(formatBytes(123_456e12, 'en')).toBe('1,23,456 TB');
+  });
+});
```

- The tests pin the four things a page relies on: one decimal and the unit, Bangla digits with "MB" kept, the step
  at 999.95, and the lakh grouping (`1,23,456 TB`) that `en-IN` gives every number in the app.

### `locales/en.ts`

```diff
@@ -33,6 +33,30 @@ export const en = {
     notificationsUnread_other: 'Notifications, {{count}} unread',
     // Step 18c: the account menu's link to your own devices (decision 1)
     myDevices: 'My devices',
+    // Step 19a: a new version waits until the person reloads (decision 3). The notice stays above
+    // every page until then; its button is common.reload
+    update: {
+      ready: 'A new version of Omnivo is ready. Save what you are working on, then reload.',
+      // Another tab clicked Reload. This tab still runs the old version, whose files are gone
+      otherTab: 'Omnivo was updated in another tab. Reload this tab to keep working.',
+      reloading: 'Reloading…',
+    },
+    // Step 19a: the account menu's item. Chrome and Edge show their own install prompt; Safari
+    // has none, so the item opens a dialog that says where Safari's own command is
+    installApp: 'Install app',
+    install: {
+      title: 'Install Omnivo',
+      description:
+        'Omnivo then opens in its own window, with its own icon, and works without a connection.',
+      iosTitle: 'On an iPhone or iPad',
+      iosStep1: 'Tap Share in the toolbar.',
+      iosStep2: 'Tap Add to Home Screen.',
+      iosStep3: 'Tap Add.',
+      macTitle: 'In Safari on a Mac',
+      macStep1: 'Choose File, then Add to Dock.',
+      macStep2: 'Click Add.',
+    },
+    installed: 'Omnivo is installed',
   },
   nav: {
     overview: 'Overview',
@@ -113,6 +137,13 @@ export const en = {
       submitting: 'Signing in…',
       newHere: 'New to Omnivo?',
       createWorkspace: 'Create a workspace',
+      // Step 19a: the sign-in page with no connection. Only the last person's copy opens offline
+      // (decision 2), and only after a reload of the app, so anyone else must wait
+      offlineNotice: "You're offline. Signing in needs a connection.",
+      // Step 19a: the app opened offline, and the server refused the sign-in once the connection
+      // was back. The copy stays on the device, so signing in again sends its changes
+      sessionEnded:
+        'You were signed out while offline. Sign in again: the changes saved on this device are sent after that.',
       panelLabel: 'What Omnivo does',
       panelTitle: 'Production, stock and accounts. One system.',
       panelBody:
@@ -556,6 +587,26 @@ export const en = {
       "This device last synced more than {{days}} days ago, so it can't save new work offline. Changes already waiting are sent once the connection is back.",
     blockedFormNotice:
       "This device last synced more than {{days}} days ago, so it can't save new work offline. Connect to the internet to save this.",
+    // Step 19a: the app opened offline with the person it remembered (decision 2). The Sync page
+    // says so under its "Last synced" line
+    openedOffline:
+      'Omnivo opened without a connection. Your sign-in is checked once the connection is back.',
+    // Step 19a: the storage card on the Sync page. navigator.storage.persist() asks the browser to
+    // keep the copy; without it, a browser low on space may delete a site's data
+    storage: {
+      title: 'Storage on this device',
+      subtitle: 'The copy of the data, the changes waiting and the app itself',
+      kept: 'Kept',
+      keptBody: 'The browser keeps this copy, even when the device runs low on space.',
+      mayBeCleared: 'May be cleared',
+      mayBeClearedBody:
+        'When the device runs low on space, the browser may delete this copy, with any changes not synced yet.',
+      ask: 'Ask to keep it',
+      refused: 'The browser said no. Install the app: browsers keep the data of an installed app.',
+      unknown: "This browser doesn't say whether it keeps the copy.",
+      // used and quota = formatBytes in the page's language (24.5 MB / ২৪.৫ MB)
+      used: '{{used}} used. The browser allows up to {{quota}}.',
+    },
   },
   accounts: {
     title: 'Chart of accounts',
```

- **New keys go into `en.ts` first** (CLAUDE.md → Language). `bn.ts` has the type `Messages`, taken from `en`, so a
  key missing in Bangla fails the type check.
- **`shell.update` is the update notice** (decision 3). It sits in `shell` because it shows above every page, not on
  one screen.
  - `ready` says what to do before the click: save first. The app never reloads by itself, so the person chooses
    the moment, and the sentence reminds them that a reload loses an open form. The button is the existing
    `common.reload`.
  - `otherTab` is for the tabs that did not click. When one tab reloads into the new version, the new worker
    deletes the old version's files; another tab still on the old version would fail at its next screen that is not
    loaded yet. That tab gets this notice instead of reloading under the person (19a.4).
  - `reloading` is the button's text between the click and the reload: the new worker must take over first, which
    takes a moment.
  - 18a's `errors.sync_protocol_mismatch` ("Omnivo was updated. Reload the page to keep syncing.") stays: it is the
    server saying the device's sync code is too old, which also happens with no new worker waiting.
- **`shell.installApp` and `shell.install`** (decision 20). The item says what happens. The dialog's `description`
  says what installing gives, because "install" alone means nothing to most people at a counter. The steps are one
  key each, not an array: `t()` returns strings, and an ordered list of keys keeps them type-checked. Safari's own
  words (Share, Add to Home Screen, Add to Dock) stay in English in both languages, because Safari shows them in the
  device's language, not the app's, and an English-speaking device shows exactly these. `installed` is the toast
  after the browser's `appinstalled` event.
- **`auth.login.offlineNotice`** is the sign-in page with no connection. Only the last person's copy opens offline,
  and only from a reload of the app (decision 2); everyone else must wait. Saying so before they type a password
  saves them the `network_error` after it.
- **`auth.login.sessionEnded`** (decision 19). It says what happened (signed out, offline) and what the person gets
  by signing in again (their changes are sent), so nobody thinks the offline work is lost.
- **`sync.openedOffline`** is the line on the Sync page while the app runs on the remembered `me` with no sign-in
  checked yet. It is the honest answer to "am I signed in?": the copy is open, the check comes later.
- **`sync.storage` is the storage card** on the Sync page. The two states are pills (CLAUDE.md: a status is an icon
  and a label, never colour alone), each with a sentence that says what it means for the work: `mayBeClearedBody`
  names the risk that matters (changes not synced are lost with the copy).
  - `ask` asks the browser again. Chrome and Edge decide without a prompt, by how the site is used (an installed app
    is always kept); Firefox shows its own prompt; Safari keeps the data of a web app on the home screen. So
    `refused` points to the one thing that works in every browser: installing.
  - `unknown` is for a browser with no `navigator.storage.persisted()`.
  - `used` has two values, both `formatBytes` (decision 18). The quota is what the browser allows this site, often
    far more than the disk has free, so the sentence calls it what the browser allows, not the free space.

### `locales/bn.ts`

```diff
@@ -32,6 +32,24 @@ export const bn: Messages = {
     notificationsUnread_one: 'নোটিফিকেশন, {{count}}টা পড়া হয়নি',
     notificationsUnread_other: 'নোটিফিকেশন, {{count}}টা পড়া হয়নি',
     myDevices: 'আমার ডিভাইস',
+    update: {
+      ready: 'Omnivo-র নতুন ভার্সন তৈরি। যে কাজ চলছে সেটা সেভ করে রিলোড করুন।',
+      otherTab: 'আরেকটা ট্যাবে Omnivo আপডেট হয়েছে। কাজ চালিয়ে যেতে এই ট্যাবটা রিলোড করুন।',
+      reloading: 'রিলোড হচ্ছে…',
+    },
+    installApp: 'অ্যাপ ইনস্টল করুন',
+    install: {
+      title: 'Omnivo ইনস্টল করুন',
+      description: 'তখন Omnivo নিজের উইন্ডোতে, নিজের আইকনে খোলে, আর ইন্টারনেট সংযোগ ছাড়াও চলে।',
+      iosTitle: 'iPhone বা iPad-এ',
+      iosStep1: 'টুলবারে Share-এ ট্যাপ করুন।',
+      iosStep2: 'Add to Home Screen-এ ট্যাপ করুন।',
+      iosStep3: 'Add-এ ট্যাপ করুন।',
+      macTitle: 'Mac-এর Safari-তে',
+      macStep1: 'File মেনু থেকে Add to Dock বাছুন।',
+      macStep2: 'Add-এ ক্লিক করুন।',
+    },
+    installed: 'Omnivo ইনস্টল হয়েছে',
   },
   nav: {
     overview: 'সারসংক্ষেপ',
@@ -112,6 +130,9 @@ export const bn: Messages = {
       submitting: 'সাইন ইন হচ্ছে…',
       newHere: 'Omnivo-তে নতুন?',
       createWorkspace: 'ওয়ার্কস্পেস তৈরি করুন',
+      offlineNotice: 'আপনি অফলাইনে। সাইন ইন করতে ইন্টারনেট সংযোগ লাগবে।',
+      sessionEnded:
+        'অফলাইনে থাকার সময় আপনি সাইন আউট হয়ে গেছেন। আবার সাইন ইন করুন: তারপর এই ডিভাইসে সেভ করা পরিবর্তনগুলো পাঠানো হবে।',
       panelLabel: 'Omnivo কী করে',
       panelTitle: 'উৎপাদন, স্টক আর হিসাব। এক সিস্টেমে।',
       panelBody:
@@ -522,6 +543,21 @@ export const bn: Messages = {
       'এই ডিভাইস শেষ সিঙ্ক হয়েছে {{days}} দিনেরও আগে, তাই অফলাইনে নতুন কাজ সেভ করা যাবে না। যে পরিবর্তনগুলো অপেক্ষায় আছে, সংযোগ ফিরলে সেগুলো পাঠানো হবে।',
     blockedFormNotice:
       'এই ডিভাইস শেষ সিঙ্ক হয়েছে {{days}} দিনেরও আগে, তাই অফলাইনে নতুন কাজ সেভ করা যাবে না। এটা সেভ করতে ইন্টারনেটে যুক্ত হন।',
+    openedOffline: 'Omnivo ইন্টারনেট সংযোগ ছাড়া খুলেছে। সংযোগ ফিরলে আপনার সাইন ইন যাচাই করা হবে।',
+    storage: {
+      title: 'এই ডিভাইসের স্টোরেজ',
+      subtitle: 'ডেটার কপি, অপেক্ষায় থাকা পরিবর্তন আর অ্যাপটা নিজে',
+      kept: 'রাখা থাকবে',
+      keptBody: 'ডিভাইসে জায়গা কমে গেলেও ব্রাউজার এই কপি রেখে দেয়।',
+      mayBeCleared: 'মুছে যেতে পারে',
+      mayBeClearedBody:
+        'ডিভাইসে জায়গা কমে গেলে ব্রাউজার এই কপি মুছে ফেলতে পারে, সাথে যে পরিবর্তনগুলো এখনো সিঙ্ক হয়নি সেগুলোও।',
+      ask: 'রেখে দিতে বলুন',
+      refused:
+        'ব্রাউজার রাজি হয়নি। অ্যাপটা ইনস্টল করুন: ইনস্টল করা অ্যাপের ডেটা ব্রাউজার রেখে দেয়।',
+      unknown: 'এই ব্রাউজার কপিটা রেখে দেবে কি না, তা জানায় না।',
+      used: '{{used}} ব্যবহার হয়েছে। ব্রাউজার {{quota}} পর্যন্ত দেয়।',
+    },
   },
   accounts: {
     title: 'চার্ট অফ অ্যাকাউন্টস',
```

- **The same keys, in the same places,** without the comments: they are in `en.ts`. Office and app words stay as
  the app already writes them: সিঙ্ক, ভার্সন, ইনস্টল, রিলোড, স্টোরেজ (CLAUDE.md → Language).
- **Safari's words stay in English** (Share, Add to Home Screen, File, Add to Dock), for the reason given under
  `en.ts`: they are the browser's labels, not the app's.
- **`kept` is রাখা থাকবে and `mayBeCleared` is মুছে যেতে পারে:** what happens to the copy, the way a person would
  say it, instead of a word for "persistent storage".

### Check this part

```bash
pnpm --filter @omnivo/i18n typecheck
pnpm --filter @omnivo/i18n test
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/ui typecheck
pnpm --filter @omnivo/app typecheck
```

Build `@omnivo/i18n` before you type-check the ui package and the app: they read its built types. All five pass.

> **What we checked in this part.** `packages/i18n` type-checks, ESLint and Prettier are clean, its unit tests pass
> (15, four of them new), and it builds. `packages/ui` and `apps/app` (with its scripts, e2e and worker configs)
> type-check against the new build. To be sure the two languages cannot drift apart, we removed the Bangla
> `shell.install.macStep2` on purpose: the type check named it as missing in `bn.ts`, and passed again after it was
> put back. The first run of the new tests caught a wrong example in the test itself (123,456 billion bytes is 123.5
> TB, not 1,23,456 TB); the test now uses `123_456e12`.

## 19a.3 — `apps/app`: opening offline, and the sign-in after it

Before this part, a reload with no connection showed the sign-in page: `restoreSession` asked the server for a new
token, got no answer, and signed out. Now the same reload opens the app as the last person, on their copy, and the
sign-in is checked once the server answers. The pieces:

```
every sign-in, every new `me`    session-store.ts ──► localStorage `omnivo.me` (remembered-session.ts)
a reload                         restoreSession: refresh
                                   ├─ a session ──► startSession, as before
                                   ├─ refused (4xx) ──► the sign-in page, as before
                                   └─ no answer (offline, 5xx) ──► import('./offline-session')
                                        `omnivo.me` + a device with a branch? ──► openOffline(me): signed in,
                                        no token, `openedOffline: true`; the LocalDataHost opens the copy
the server answers again          the first 401 in call() · the `online` event · every minute while online
                                   └─► check(): refresh
                                        ├─ refused ──► signOut('session_ended'): `me` forgotten, copy kept
                                        └─ a session ──► token + a fresh `me` ──► signIn: a normal session
Sign out with no connection       signed out here at once · `omnivo.signOutPending` · never refreshed until
                                   the server hears of it (the next reload or sign-in sends it first)
```

Nothing changes for a person who is online: the refresh works, `startSession` runs, and none of the new code does
anything but write `omnivo.me`.

### `lib/remembered-session.ts` (new)

```ts
import { type MeResponse, meResponseSchema } from '@omnivo/contracts';

// Step 19a: what this browser keeps of the sign-in, for a reload with no connection (decision 2).
// The last `me` the server gave: the offline opening shows the app as that person, in that
// workspace. And a sign-out the server has not heard of yet. localStorage, not the device's
// database: the first page load reads it, and Dexie is not in the first page load.

const ME_KEY = 'omnivo.me';
const SIGN_OUT_KEY = 'omnivo.signOutPending';

// localStorage itself can throw (a sandboxed frame, storage turned off): then no storage.
// Exported for offline-session.ts, which reads the device's identity with it.
export function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// Every sign-in and every new `me` (session-store.ts). A storage that refuses (full, a private
// window) only means no offline opening on this device.
export function rememberMe(me: MeResponse): void {
  try {
    storage()?.setItem(ME_KEY, JSON.stringify(me));
  } catch {
    // Nothing to do: the app works as before step 19a
  }
}

// Every sign-out: the next offline reload shows the sign-in page
export function forgetMe(): void {
  try {
    storage()?.removeItem(ME_KEY);
  } catch {
    // A storage that cannot be read cannot be read at the next reload either
  }
}

// Checked, not trusted: a value from an older version of the app (a `me` without a field added
// since) or a hand-edited one is no `me`, and the app shows the sign-in page
export function rememberedMe(): MeResponse | null {
  try {
    const saved = storage()?.getItem(ME_KEY);
    if (saved === null || saved === undefined) return null;
    const parsed = meResponseSchema.safeParse(JSON.parse(saved));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Sign out with no connection (session.ts): the server still has the session, and the browser
// still has its cookie. Until the server hears of it, the app must never refresh that cookie.
export function markSignOutPending(): void {
  try {
    storage()?.setItem(SIGN_OUT_KEY, '1');
  } catch {
    // The storage refused: the next online reload signs the person in again (see the guide)
  }
}

export function signOutPending(): boolean {
  try {
    const saved = storage()?.getItem(SIGN_OUT_KEY);
    return saved !== null && saved !== undefined;
  } catch {
    return false;
  }
}

export function clearSignOutPending(): void {
  try {
    storage()?.removeItem(SIGN_OUT_KEY);
  } catch {
    // Nothing to clear in a storage that cannot be read
  }
}
```

- **Its own small file, in the first page load.** The router's `restoreSession` needs `signOutPending()` on every
  reload, and the store writes `me` on every sign-in, so this cannot be lazy. It imports only the contracts' `me`
  schema, which the first load already has (`authRoutes.me` carries it), so the file costs only its own code.
- **localStorage, not the device's database.** Dexie is not in the first load (step 18a kept it out), and a
  reload must know before anything else whether it can open offline. localStorage is read at once, with no
  `await`.
- **Every function catches.** localStorage can throw on every call: Safari's private windows refuse `setItem`,
  a full disk refuses it, a page in a sandboxed frame cannot even read `window.localStorage`. A storage that
  refuses only means no offline opening, and the app works as before step 19a. `storage()` is the same small helper
  as in `local-session.ts`; it is exported here because `offline-session.ts` needs it to read the device's identity,
  and that file must not import `local-session.ts` (Dexie).
- **`rememberedMe()` checks what it reads** with `meResponseSchema`, like every answer from the server. A `me` saved
  by an older version of the app (before a field was added) or edited by hand is not a `me`: the function gives
  `null`, and the app shows the sign-in page instead of a screen that breaks on a missing field.
- **`omnivo.signOutPending` is only a mark** (`'1'`). The server needs nothing from it: the sign-out request sends
  the cookie, as every sign-out does (`auth/logout` is a public route that reads the cookie).

### `lib/session-store.ts`

```diff
@@ -2,9 +2,12 @@ import type { MeResponse } from '@omnivo/contracts';
 import { createStore } from 'zustand/vanilla';
 import { useStore } from 'zustand';
 
-// Step 18c: why the sign-in page is showing, when the person did not sign out themself. Only one
-// reason so far: this device was revoked (its data was deleted).
-export type SignOutNotice = 'device_revoked';
+import { forgetMe, rememberMe } from './remembered-session';
+
+// Step 18c: why the sign-in page is showing, when the person did not sign out themself: this
+// device was revoked (its data was deleted), or (step 19a) the server refused the sign-in once the
+// connection was back after an offline opening (the data stays).
+export type SignOutNotice = 'device_revoked' | 'session_ended';
 
 interface SessionState {
   // unknown = অ্যাপ সবে খুলেছে, refresh cookie দিয়ে session ফেরানো এখনো শেষ হয়নি
@@ -12,9 +15,13 @@ interface SessionState {
   // শুধু memory-তে — localStorage-এ রাখলে যেকোনো XSS স্ক্রিপ্ট টোকেন পড়তে পারত
   accessToken: string | null;
   me: MeResponse | null;
+  // Step 19a: opened offline with the remembered `me` (offline-session.ts). Signed in for the
+  // screens, but the server has not checked this sign-in yet, and there is no token until it has.
+  openedOffline: boolean;
   notice: SignOutNotice | null;
   setAccessToken: (accessToken: string) => void;
   signIn: (me: MeResponse) => void;
+  openOffline: (me: MeResponse) => void;
   // লগইনের পরে me-র অংশ বদলালে (কোম্পানির নাম, পছন্দ) — status না ছুঁয়ে
   setMe: (me: MeResponse) => void;
   signOut: (notice?: SignOutNotice) => void;
@@ -25,23 +32,34 @@ export const sessionStore = createStore<SessionState>()((set) => ({
   status: 'unknown',
   accessToken: null,
   me: null,
+  openedOffline: false,
   notice: null,
   setAccessToken: (accessToken) => {
     set({ accessToken });
   },
+  // Step 19a: every `me` the server gives is remembered, for the next reload with no connection
   signIn: (me) => {
-    set({ status: 'signed-in', me, notice: null });
+    rememberMe(me);
+    set({ status: 'signed-in', me, openedOffline: false, notice: null });
+  },
+  openOffline: (me) => {
+    set({ status: 'signed-in', accessToken: null, me, openedOffline: true, notice: null });
   },
   setMe: (me) => {
+    rememberMe(me);
     set({ me });
   },
   // Step 18c: a sign-out without a reason keeps the one already there. After a revoke, the requests
   // still on their way get a 401, and api.ts signs out again for each: the notice must stay.
+  // Step 19a: every sign-out forgets the remembered `me`: a sign-in the server refused, or one the
+  // person ended, never opens offline again.
   signOut: (notice) => {
+    forgetMe();
     set((state) => ({
       status: 'signed-out',
       accessToken: null,
       me: null,
+      openedOffline: false,
       notice: notice ?? (state.status === 'signed-out' ? state.notice : null),
     }));
   },
```

- **`'session_ended'`** joins `'device_revoked'` as a reason for the sign-in page (decision 19). The 18c rule
  stays: a sign-out without a reason keeps the reason already there, so requests still on their way, which get a
  401 and sign out again, do not wipe the notice.
- **`openedOffline`** tells the rest of the app that this sign-in is the remembered one. `status` stays
  `'signed-in'`: the router's guards, the AppShell and every screen work unchanged, which is the point. Only two
  places read the flag: `call()` (to check the sign-in at the first 401) and the Sync page (to say so).
- **`openOffline(me)`** sets `accessToken: null` on purpose. A token from before the reload is not there anyway
  (memory only), and a request without one is what makes the server answer 401, which starts the check.
- **`signIn` and `setMe` remember `me`; `signOut` forgets it.** In the store, because these three are the only
  ways the app changes who is signed in, and each caller (login, switching workspace, a refused refresh, a revoke,
  the offline check) would otherwise need to remember it. `openOffline` does not write: the `me` came from there.
- **Every sign-out forgets it, also a refused refresh while online.** A person whose sign-in the server refused
  (removed from the workspace, password reset) must not be able to open the copy by reloading without a connection
  a minute later.

### `lib/api.ts`

```diff
@@ -40,6 +40,13 @@ function clientError(status: number, code: ErrorCode, detail: string): ApiReques
   return new ApiRequestError({ title: 'Client error', status, detail, code });
 }
 
+// Step 19a: the server did not answer the question: no connection (status 0), or the API or a
+// proxy in front of it failing (5xx). A refusal (4xx) is an answer. The offline opening and the
+// sign-out with no connection both need to tell the two apart.
+export function isNoAnswer(error: unknown): boolean {
+  return error instanceof ApiRequestError && (error.status === 0 || error.status >= 500);
+}
+
 async function toError(response: Response): Promise<ApiRequestError> {
   const body: unknown = await response.json().catch(() => null);
   const parsed = problemSchema.safeParse(body);
@@ -114,6 +121,9 @@ export function refreshSession(): Promise<AuthSession | null> {
     // call() না, send() — call() নিজেই 401-এ refresh ডাকে, lock-এর ভেতর থেকে সেটা আটকে যেত
     .request('omnivo-refresh', async () => {
       const response = await send(authRoutes.refresh, {}, null);
+      // Step 19a: null only for a refusal. A 502 from a proxy while the API restarts is no
+      // answer, and throws like a lost connection: it must not sign anyone out.
+      if (response.status >= 500) throw await toError(response);
       if (!response.ok) return null;
       return read(authRoutes.refresh, response);
     })
@@ -148,6 +158,12 @@ export async function call(route: RouteDef, input: RequestParts = {}): Promise<u
     }
     sessionStore.getState().setAccessToken(session.accessToken);
     response = await send(route, input, session.accessToken);
+  } else if (response.status === 401 && sessionStore.getState().openedOffline) {
+    // Step 19a: an app opened offline has no token. Its first request that reaches the server
+    // is the moment to check the sign-in; then the request goes again, with the new token.
+    const token = await checkOfflineSession();
+    if (!token) throw await toError(response);
+    response = await send(route, input, token);
   }
 
   const result = await read(route, response);
@@ -155,6 +171,15 @@ export async function call(route: RouteDef, input: RequestParts = {}): Promise<u
   return result;
 }
 
+// Step 19a: the check of an offline opening (offline-session.ts): the new token, or null when the
+// server refused the sign-in (the person is signed out by then). Handed over at run time, like
+// the write listeners below: that file imports this one, and loads only after an offline opening.
+let checkOfflineSession: () => Promise<string | null> = () => Promise.resolve(null);
+
+export function setOfflineCheck(check: () => Promise<string | null>): void {
+  checkOfflineSession = check;
+}
+
 // Step 18a: a save on this device pulls its change onto the device at once, instead of up to a
 // minute later. Every write goes through call(), so one listener here covers the product form,
 // the customer form, a stock posting and every other save. The sync code subscribes; this file
```

- **`isNoAnswer`** is the one place that says what "no answer" means (decision 22): status 0 from `send()` (the
  request never reached a server), or 5xx. `session.ts` uses it twice: to open offline, and to keep a sign-out
  waiting.
- **`refreshSession` throws for a 5xx.** Before, any failed refresh gave `null`, and `null` means "refused" to every
  caller: `call()` signs out on it, and `restoreSession` shows the sign-in page. A 502 from a proxy while the API
  restarts is not a refusal. The callers already handle a throw: `call()` passes it on like a lost connection,
  `restoreSession` catches it (and now may open offline), and 18c's `revoke()` has its own `.catch(() => null)`.
- **The 401 of an offline opening runs the check** (`else if`). The first branch is unchanged: a token that
  expired. The new one is for no token at all, which before meant "not signed in" (a wrong password at the login
  page also gets a 401 with no token). `openedOffline` tells the two apart: the login page is never in an offline
  opening. When the check gives a token, the same request goes again, so the screen that made it never sees the
  401.
- **`setOfflineCheck` hands the check over at run time.** The check lives in `offline-session.ts`, which imports
  this file. If this file imported it back, the two would form a loop (dependency-cruiser's `no-circular` refuses
  it), and the offline code would be in the first page load. The same pattern as `onApiWrite` below. Until the
  offline code loads, the default gives `null`: with `openedOffline` false it never runs anyway.

### `lib/offline-session.ts` (new)

```ts
import { authRoutes, type MeResponse } from '@omnivo/contracts';
import { readDevice } from '@omnivo/sync';

import { call, refreshSession, setOfflineCheck } from './api';
import { applyPreferences } from './preferences';
import { queryClient } from './query-client';
import { rememberedMe, storage } from './remembered-session';
import { sessionStore } from './session-store';

// Step 19a (decision 2): a reload with no answer from the server opens the app as the last person,
// with the `me` the browser remembered, on their copy of the data. session.ts loads this file with
// import(), only after such a reload: the first page load of every other visit does not carry it.
// The service worker keeps its chunk like every other, so it loads with no connection.

// Only a device set up for that person opens: a branch chosen, so the copy was pulled (step 18a).
// A revoked device has no identity any more (step 18c), so it never opens offline; neither does a
// person who pressed "Not now" in the branch dialog, who has no copy to open.
function hasCopy(me: MeResponse): boolean {
  return readDevice(storage(), me.tenant.id, me.user.id).branchId !== null;
}

export async function openOffline(): Promise<boolean> {
  const me = rememberedMe();
  if (!me || !hasCopy(me)) return false;
  // The person's theme and language, as after an online sign-in. The Bangla words are a chunk of
  // their own; the worker keeps it. Failing to load them only leaves the page in English.
  await applyPreferences(me.preferences).catch(() => undefined);
  sessionStore.getState().openOffline(me);
  watchForServer();
  return true;
}

// Read again after each await: a sign-out may end the offline opening at any of them
function stillOffline(): boolean {
  return sessionStore.getState().openedOffline;
}

// The check runs when the browser says the connection is back, and every minute while it says it
// is online: a reload while the API was down (a 502) opened offline with the browser online, and
// no `online` event comes then. Both stop when the offline opening ends, however it ends.
function watchForServer(): void {
  const again = () => {
    void resume().catch(() => undefined);
  };
  const timer = setInterval(() => {
    if (navigator.onLine) again();
  }, 60_000);
  window.addEventListener('online', again);
  const unsubscribe = sessionStore.subscribe((state) => {
    if (state.openedOffline) return;
    clearInterval(timer);
    window.removeEventListener('online', again);
    unsubscribe();
  });
}

// One check at a time: the `online` event, the timer and the first 401 of api.ts often come
// together, and each refresh uses the cookie up (the server rotates it)
let checking: Promise<string | null> | null = null;

function resume(): Promise<string | null> {
  checking ??= check().finally(() => {
    checking = null;
  });
  return checking;
}

// The new token, or null when the server refused the sign-in. Throws while there is still no
// answer: the opening stays as it is, and the next check tries again.
async function check(): Promise<string | null> {
  const remembered = sessionStore.getState().me;
  if (!stillOffline() || !remembered) return null;
  const session = await refreshSession();
  if (!stillOffline()) return null;
  if (!session) {
    // Refused: the sign-in expired, the password was reset, the person was removed, or the device
    // was revoked (the server ends its session and says no more). Signed out as after any refused
    // refresh, and the remembered `me` goes with it, but the copy stays (decision 19).
    queryClient.clear();
    sessionStore.getState().signOut('session_ended');
    return null;
  }
  sessionStore.getState().setAccessToken(session.accessToken);
  const me = await call(authRoutes.me);
  if (!stillOffline()) return session.accessToken;
  await applyPreferences(me.preferences).catch(() => undefined);
  if (me.user.id !== remembered.user.id || me.tenant.id !== remembered.tenant.id) {
    // The cookie is another sign-in's (another tab signed in as someone else while this one was
    // offline). That sign-in wins, from an empty cache, as in session.ts's startSession; the
    // LocalDataHost then opens that person's copy, and this one stays for its owner.
    queryClient.clear();
    sessionStore.getState().signIn(me);
    return session.accessToken;
  }
  sessionStore.getState().signIn(me);
  // What failed or read the device while offline asks again. invalidate, not clear: the screens
  // keep showing what they have until the answer comes, and an open form keeps its pickers.
  void queryClient.invalidateQueries();
  return session.accessToken;
}

setOfflineCheck(resume);
```

- **A lazy chunk of 0.6 KB gz.** `session.ts` loads it with `import()`, only after a reload that got no answer.
  The service worker (19a.1) keeps every chunk of the build, so it loads with no connection; without a worker (the
  first visit, or `pnpm dev`) the import fails offline, and `session.ts` shows the sign-in page, as before.
- **`hasCopy` reads the device's identity** with `readDevice` from `@omnivo/sync`. The package has
  `"sideEffects": false`, so the build takes only `device.ts` (zod and uuidv7) into a small shared chunk, never Dexie.
  `readDevice` gives a new identity with `branchId: null` when nothing is saved, so "has a branch" also covers "no
  identity" (decision 23).
- **`applyPreferences` before `openOffline`,** in the same order as `startSession`: the first screen is drawn in the
  person's language and theme. The Bangla words are a chunk of their own (step 13); if that chunk cannot load, the
  page is in English rather than not there, hence the `.catch`.
- **`watchForServer`** (decision 24). The minute timer checks `navigator.onLine` first: offline, it would only fail.
  The store's `subscribe` ends the watch when `openedOffline` turns false, however that happens (the check worked,
  the server refused, the person signed out), so no path has to remember to stop it. `unsubscribe` is used inside its
  own listener; that runs only on a later change of the store, after the `const` has its value.
- **`resume` runs one check at a time.** The `online` event, the timer and a 401 in `call()` often come within the
  same second. Each refresh uses the cookie up (the server rotates it, and a second refresh with the old cookie looks
  like a stolen token, which ends the whole session), so the others wait for the first one's answer. The Web Lock in
  `refreshSession` keeps two tabs apart; this keeps the callers of one tab together.
- **`check` reads `openedOffline` again after each `await`** (`stillOffline`). The person may sign out while the
  refresh is on its way; signing them in again after that would undo what they asked for.
- **A refused check signs out with `'session_ended'`** and clears the query cache, like `call()` on a refused
  refresh. The store forgets `me`, so the next offline reload shows the sign-in page. The copy is not touched
  (decision 19): it belongs to this person, and signing in again sends what they saved offline.
- **A working check fetches a new `me`.** The remembered one may be days old: a role taken away since then must not
  stay on screen. The token is set first, because `/auth/me` needs it. If `/auth/me` fails (the connection drops
  again), the token stays and `openedOffline` stays true: the next `online` event or minute tries again, and the
  requests in between use the token.
- **Same person:** `signIn(me)` ends the offline opening, and `invalidateQueries()` makes every query ask again. Not
  `clear()`: a clear empties every screen at once, and an open form loses the rows its pickers show while it waits.
  The LocalDataHost does not restart: its `tenantId` and `userId` did not change.
- **Another person:** the cookie belongs to a sign-in made in another tab while this one was offline. That sign-in
  is the browser's now, so this tab follows it with an empty cache, as `startSession` does. The first person's copy
  stays on the device for them.
- **`setOfflineCheck(resume)` runs when the module loads,** so the check is in place before `openOffline` returns.

### `lib/session.ts`

```diff
@@ -9,9 +9,10 @@ import {
   type SignUpInput,
 } from '@omnivo/contracts';
 
-import { call, refreshSession } from './api';
+import { call, isNoAnswer, refreshSession } from './api';
 import { applyPreferences } from './preferences';
 import { queryClient } from './query-client';
+import { clearSignOutPending, markSignOutPending, signOutPending } from './remembered-session';
 import { sessionStore } from './session-store';
 
 async function startSession(session: AuthSession): Promise<void> {
@@ -36,33 +37,71 @@ let restoring: Promise<void> | null = null;
 
 export function restoreSession(): Promise<void> {
   restoring ??= (async () => {
+    // Step 19a: signed out with no connection. The cookie still works, so it is never refreshed:
+    // the sign-out is sent first, and the person stays signed out whatever the answer.
+    if (signOutPending()) {
+      await sendPendingSignOut();
+      sessionStore.getState().signOut();
+      return;
+    }
     try {
       const session = await refreshSession();
       if (session) {
         await startSession(session);
         return;
       }
-    } catch {
+    } catch (error) {
       // API বন্ধ বা নেটওয়ার্ক নেই — reject হলে প্রতিটা route চিরতরে ভাঙত; লগইন পেজ দেখানোই নিরাপদ,
-      // সেখানে চেষ্টা করলে network_error-এর লেখা দেখাবে
+      // সেখানে চেষ্টা করলে network_error-এর লেখা দেখাবে।
+      // Step 19a (decision 2): no answer, and this browser remembers the last person and their copy:
+      // the app opens as that person. import(): only such a reload loads the code.
+      if (isNoAnswer(error) && (await openOffline())) return;
     }
     sessionStore.getState().signOut();
   })();
   return restoring;
 }
 
-export async function login(input: LoginInput): Promise<void> {
-  await startSession(await call(authRoutes.login, { body: input }));
+// A failure to load the chunk (no worker yet, and no connection) is the sign-in page, as before
+async function openOffline(): Promise<boolean> {
+  try {
+    const offline = await import('./offline-session');
+    return await offline.openOffline();
+  } catch {
+    return false;
+  }
+}
+
+// Step 19a: any answer ends the wait (the server cleared the cookie, or there was no session to
+// end); no answer keeps it for the next try
+async function sendPendingSignOut(): Promise<void> {
+  try {
+    await call(authRoutes.logout);
+    clearSignOutPending();
+  } catch (error) {
+    if (!isNoAnswer(error)) clearSignOutPending();
+  }
+}
+
+// Step 19a: a sign-out still waiting goes before the new sign-in. After it, the new cookie takes
+// the old one's place in the browser, and the old session could not be ended from here any more.
+async function signInWith(request: () => Promise<AuthSession>): Promise<void> {
+  if (signOutPending()) await sendPendingSignOut();
+  await startSession(await request());
+}
+
+export function login(input: LoginInput): Promise<void> {
+  return signInWith(() => call(authRoutes.login, { body: input }));
 }
 
-export async function signUp(input: SignUpInput): Promise<void> {
-  await startSession(await call(authRoutes.signUp, { body: input }));
+export function signUp(input: SignUpInput): Promise<void> {
+  return signInWith(() => call(authRoutes.signUp, { body: input }));
 }
 
 // invitation গ্রহণ = লগইন: উত্তরে একই session, আর সেই workspace-এ। আগে অন্য অ্যাকাউন্টে লগইন থাকলে
 // startSession সেটার ক্যাশ মুছে নতুনটা বসায়
-export async function acceptInvitation(input: AcceptInvitationInput): Promise<void> {
-  await startSession(await call(invitationRoutes.accept, { body: input }));
+export function acceptInvitation(input: AcceptInvitationInput): Promise<void> {
+  return signInWith(() => call(invitationRoutes.accept, { body: input }));
 }
 
 export async function switchTenant(tenantId: string): Promise<void> {
@@ -73,6 +112,11 @@ export async function logout(): Promise<void> {
   const me = sessionStore.getState().me;
   try {
     await call(authRoutes.logout);
+  } catch (error) {
+    // Step 19a: no connection. The person is signed out here at once (below); the server hears of
+    // it at the next reload or sign-in, and until then the cookie is never refreshed. A refusal
+    // is an answer: there was no session left to end.
+    if (isNoAnswer(error)) markSignOutPending();
   } finally {
     // নেটওয়ার্ক ব্যর্থ হলেও এই ট্যাবে লগআউট দেখাতে হবে, আর আগের ইউজারের ক্যাশ মুছতে হবে
     queryClient.clear();
```

- **A waiting sign-out comes first in `restoreSession`.** With the mark there, the cookie must not be refreshed: the
  refresh would work, and the person who signed out would be signed in again. So the sign-out goes to the server
  first, and the person stays signed out whatever the answer: the sign-in page is what they asked for.
- **The `catch` opens offline only for "no answer".** A body that breaks the contract (`unexpected_response`) or
  any other error shows the sign-in page, as before. `startSession` can throw too (the refresh worked, `/auth/me` did
  not answer): that is also "no answer", and opening offline is right.
- **`openOffline` here is a wrapper** that turns a failed `import()` into `false`. Without a worker there is no
  chunk to load offline, and `restoreSession` must never reject (every route awaits it).
- **`sendPendingSignOut` clears the mark on any answer.** 204 means the server ended the session; a 4xx means there
  was none to end. Only no answer keeps it, for the next try.
- **`signInWith`** sends a waiting sign-out before a new sign-in. The new sign-in's cookie takes the old one's place
  in the browser, and after that nothing on this device could end the old session. `login`, `signUp` and
  `acceptInvitation` go through it; `switchTenant` does not, because only a signed-in person switches. These three
  now return the promise instead of being `async`: the same type, one less wrapper.
- **`logout` catches now.** It used to let the error through its `finally`, and both callers use `void logout()`, so
  an offline sign-out ended as an unhandled rejection in the console. Now no answer sets the mark, and the
  `finally` does what it did: the cache, the store, the copy.

### `routes/login.tsx`

```diff
@@ -8,6 +8,7 @@ import {
   TShirtIcon,
   ViewIcon,
   ViewOffIcon,
+  WifiDisconnected02Icon,
 } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
 import { zodResolver } from '@hookform/resolvers/zod';
@@ -24,6 +25,7 @@ import { LanguageSwitch } from '../components/language-switch';
 import { applyApiError } from '../lib/field-errors';
 import { login } from '../lib/session';
 import { useSession } from '../lib/session-store';
+import { useOnline } from '../lib/use-online';
 
 // key-টা অনুবাদের, লেখা না — ভাষা বদলালে সাথে সাথে বদলায়
 const INDUSTRIES = [
@@ -39,6 +41,8 @@ export function LoginPage() {
   const [showPassword, setShowPassword] = useState(false);
   // Step 18c: why this page shows, when the app signed the person out (a revoked device)
   const notice = useSession((state) => state.notice);
+  // Step 19a: signing in needs the server; saying so first saves typing a password for nothing
+  const online = useOnline();
   // zodResolver: API যে schema দিয়ে যাচাই করে, ফর্মও ঠিক সেটা দিয়ে — একই নিয়ম, একই code।
   // contractErrorMap: schema যেখানে নিজে code দেয়নি সেখানে Zod-এর ইংরেজি মেসেজের বদলে code
   const {
@@ -82,6 +86,15 @@ export function LoginPage() {
               {notice === 'device_revoked' && (
                 <DocumentNotice tone="neutral">{t('devices.revokedSignedOut')}</DocumentNotice>
               )}
+              {/* Step 19a (decision 19): signed out after an offline opening; the copy stays */}
+              {notice === 'session_ended' && (
+                <DocumentNotice tone="neutral">{t('auth.login.sessionEnded')}</DocumentNotice>
+              )}
+              {!online && (
+                <DocumentNotice tone="neutral" icon={WifiDisconnected02Icon}>
+                  {t('auth.login.offlineNotice')}
+                </DocumentNotice>
+              )}
               {/* message-এ code; FormAlert আর TextField নিজেরাই বর্তমান ভাষায় লেখে */}
               {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
               <TextField
```

- **`'session_ended'`** gets its notice, like 18c's revoke. Neutral, not an error: nothing in the form is wrong.
- **The offline notice** (decision 28) shows while the browser says it is offline (`useOnline`). It goes by
  itself when the connection comes back. It stays under the session notice, so the reason for the page comes first.

### `routes/sync.tsx`

```diff
@@ -43,6 +44,7 @@ import {
   useLocalQuery,
   useSyncStatus,
 } from '../lib/local-data';
+import { useSession } from '../lib/session-store';
 import { useSyncAge } from '../lib/sync-summary';
 import { useOnline } from '../lib/use-online';
 
@@ -92,6 +94,8 @@ export function SyncPage() {
   const pull = useLocalQuery(readPullState);
   // Step 18c (decision 12): the limits, on this device's clock
   const age = useSyncAge();
+  // Step 19a: opened offline with the remembered sign-in, not checked by the server yet
+  const openedOffline = useSession((state) => state.openedOffline);
   const commandText = useCommandText();
   const fieldList = useFieldList();
   const [discarding, setDiscarding] = useState<OutboxEntry | null>(null);
@@ -143,6 +147,7 @@ export function SyncPage() {
             : t('sync.lastSynced', { time: format.dateTime(new Date(lastSync), timeZone) })}
         {!online && ` · ${t('sync.syncNowOffline')}`}
       </p>
+      {openedOffline && <DocumentNotice tone="neutral">{t('sync.openedOffline')}</DocumentNotice>}
       {/* Step 18c: after 24 hours what may be out of date; after 7 days what stops. The waiting
           changes are not blocked, so the page says they still go. */}
       {age?.age === 'warn' && <DocumentNotice tone="warn">{t('sync.staleNotice')}</DocumentNotice>}
```

- **`sync.openedOffline`** under the "Last synced" line, as a neutral notice: it says what the state means (the copy
  is open, the sign-in is checked later), and there is nothing to click. It goes when the check works.

### `scripts/check-bundle-size.ts`: the first load's budget

```diff
@@ -8,8 +8,10 @@ import { z } from 'zod';
 // first load is 210 KB for now. All the English words load with it (about 48 KB gz), and every
 // step adds its own, so 17c's words alone took it to 200.7 KB. Loading each module's words with
 // its pages is the real fix, a step of its own; until then the budget still stops anything else
-// from growing the first load unnoticed.
-const INITIAL_BUDGET = 210 * 1024;
+// from growing the first load unnoticed. Step 19a: 215 KB (you chose this). 19a's words and the
+// offline sign-in took it to 211.6 KB; from now on the service worker keeps these files, so only
+// the very first visit downloads them.
+const INITIAL_BUDGET = 215 * 1024;
 // Step 17d: a lazy chunk is 105 KB for now. Almost every page loads the contracts' whole route
 // table (about 28 KB gz) to call the API, and 17d's three documents grew it enough to push pages
 // that 17d never touched (team, units) over 100 KB. Loading each module's routes with its own
```

- **215 KB** (decision 27, you chose this). 19a.2's words took the first load from 209.9 to 210.5 KB; 19a.2 did not
  run this check, so it showed up here. This part adds 1.1 KB: `remembered-session.ts`, the waiting sign-out and the
  check in `call()`. The new limit leaves room for 19a.4's update notice and install item.

### Check this part

```bash
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/app test
pnpm --filter @omnivo/app build
pnpm --filter @omnivo/app test:bundle-size
pnpm boundaries
```

All five pass. The bundle check prints `initial JS 211.6 KB gz (budget 215.0 KB)` and `precache 378 files`: the new
chunks are in the worker's list too.

> **What we checked in this part.** `apps/app` type-checks (with its scripts, e2e and worker configs), ESLint and
> Prettier are clean on every touched file, its 144 unit tests pass, it builds, the bundle check passes, and
> dependency-cruiser finds no loop. The offline opening is its own chunk with no Dexie in it. We also ran a
> throwaway test (in Node, with MSW and a stand-in localStorage) through the whole path: a reload with no connection
> opened as the remembered person with no token; the first request after the server came back got a 401, the check
> refreshed, fetched `me` and sent the request again, which worked, and the session became a normal one; signing out
> with no connection set the mark, forgot `me` and sent no refresh; a reload that got a 502 opened offline; an
> `online` event whose refresh was refused signed out with `session_ended` and forgot `me`. Then we removed the
> `else if` branch in `call()` on purpose: the request failed with the server's 401, as expected. The real tests
> come in 19a.5, and a real browser in 19a.6.

## 19a.4 — `apps/app`: the worker in the app, updates, installing and the storage

19a.1 made the build produce the worker; nothing registered it. This part does, and adds what a person sees of it:
the update notice, "Install app", the count on the app icon, and the storage card on the Sync page. It also deletes
18b's background loading of the offline screens, which the worker makes useless.

```
main.tsx            watchInstall()              Chrome's install prompt, kept from the first moment
                    startAppUpdates() (build)   after `load`: register sw.js · every hour, on `online`: update()
                    <UpdateNotice />            outside the routes, on every page and the sign-in page
a new sw.js         installed, waiting ──► every tab: "A new version is ready" ──► Reload in tab B
                      tab B: SKIP_WAITING ──► controllerchange ──► reload into the new version
                      tab A: controllerchange ──► "updated in another tab" ──► Reload ──► a plain reload
account menu        "Install app": Chrome's prompt, or the dialog with Safari's steps; hidden once installed
LocalDataHost       the outbox count ──► navigator.setAppBadge
device set-up       navigator.storage.persist() ──► the Sync page's storage card says kept / may be cleared
```

### `lib/app-update.ts` (new)

```ts
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

// Step 19a (decision 3): the service worker's updates. A new version downloads in the background
// and waits; the notice (update-notice.tsx) lets the person choose when to reload into it.
//   none       nothing new, or no worker (pnpm dev, an old browser)
//   ready      a new version waits for this tab's Reload
//   other-tab  another tab reloaded into the new version: this tab still runs the old one, whose
//              files the new worker has deleted, so its next lazy page would fail to load
//   reloading  this tab asked the waiting version to take over
export type UpdateState = 'none' | 'ready' | 'other-tab' | 'reloading';

// Exported for the tests (app-update.spec.ts); the screens read it with useUpdateState
export const updateStore = createStore<{ state: UpdateState }>()(() => ({ state: 'none' }));

export function useUpdateState(): UpdateState {
  return useStore(updateStore, (store) => store.state);
}

function setState(state: UpdateState): void {
  updateStore.setState({ state });
}

// A tab can stay open for days (a counter PC). The browser checks sw.js on every load, but not
// while a page stays open, so the app asks again every hour and when the connection comes back.
const CHECK_EVERY_MS = 60 * 60 * 1000;

let registration: ServiceWorkerRegistration | null = null;
// Whether a worker already ran this app before this page loaded. The first install's worker
// takes over the page at once (clientsClaim in sw.ts): that changes nothing under the page, so
// its controllerchange must not say "updated in another tab".
let hadWorker = false;

// A new version has installed while an older one runs this page. With no worker in control it
// is the first install, and there is nothing to update from.
function noticeWaiting(): void {
  if (
    registration?.waiting &&
    navigator.serviceWorker.controller &&
    updateStore.getState().state === 'none'
  ) {
    setState('ready');
  }
}

// Also run by the sync notice when the server says this app is too old (local-state.tsx). An
// update that fails (offline, a 5xx) is tried again by the next check.
export function checkForUpdate(): void {
  void registration?.update().catch(() => undefined);
}

async function register(): Promise<void> {
  let found: ServiceWorkerRegistration;
  try {
    found = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
  } catch {
    // Refused (a Firefox private window, a browser setting): the app works online as before 19a
    return;
  }
  registration = found;
  // A hard reload (Shift + Reload) opens the page without the worker in control, though one is
  // active: its next controllerchange is a real update
  if (found.active) hadWorker = true;
  // Downloaded during an earlier visit, while another tab of the old version stayed open
  noticeWaiting();
  found.addEventListener('updatefound', () => {
    const installing = found.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed') noticeWaiting();
    });
  });
  setInterval(checkForUpdate, CHECK_EVERY_MS);
  window.addEventListener('online', checkForUpdate);
}

// Called once by main.tsx, in a production build only (decision 11)
export function startAppUpdates(): void {
  // Not in an old browser, or on a plain http:// address other than localhost
  if (!('serviceWorker' in navigator)) return;
  hadWorker = navigator.serviceWorker.controller !== null;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadWorker) {
      hadWorker = true;
      return;
    }
    // This tab clicked Reload: the new version runs now, so load its files
    if (updateStore.getState().state === 'reloading') window.location.reload();
    else setState('other-tab');
  });
  // After the page's own files: the worker's first download (1.3 MB) must not slow the first load
  if (document.readyState === 'complete') void register();
  else {
    window.addEventListener(
      'load',
      () => {
        void register();
      },
      { once: true },
    );
  }
}

// How long Reload waits for the new version to take over before it reloads anyway
const TAKE_OVER_MS = 5000;

// The notice's Reload, and the sync notice's. A waiting version is asked to take over (sw.ts's
// SKIP_WAITING); its controllerchange then reloads this tab, and tells every other tab. A plain
// reload would not do: the browser keeps the old version while any tab still shows it, and the
// page being reloaded is one of them.
export function reloadApp(): void {
  const waiting = registration?.waiting;
  setState('reloading');
  if (!waiting) {
    // Another tab took the new version already (other-tab), or there is none: the files the
    // browser has now are the newest
    window.location.reload();
    return;
  }
  waiting.postMessage({ type: 'SKIP_WAITING' });
  // A waiting version can stop waiting without taking over (a newer one replaced it): never
  // leave "Reloading…" on the screen
  setTimeout(() => {
    window.location.reload();
  }, TAKE_OVER_MS);
}
```

- **A small store with four states,** read by the notice through `useUpdateState`. `zustand/vanilla` like the
  session store, so `reloadApp` and the worker's events can change it from outside React.
- **`hadWorker` tells an update from the first install.** The first install takes over the page at once
  (`clientsClaim`, decision 13), and that fires `controllerchange` too. Nothing changed under the page then (the same
  files, now from the cache), so that one event is skipped. Without this check, the very first visit of every device
  said "Omnivo was updated in another tab"; we removed it on purpose to see that.
- **`found.active` sets `hadWorker` as well.** A hard reload (Shift + Reload) opens the page with no worker in control
  although one is active. The worker then takes the page back with a `controllerchange` that is not a first install:
  it must count as one only when there was no worker at all.
- **`noticeWaiting` needs a controller.** `registration.waiting` with no worker in control is the first install
  still finishing, not an update. And it only moves from `'none'`: a tab that already says "updated in another tab"
  keeps saying so.
- **It is called three times:** at registration (a version downloaded during an earlier visit, while another tab of
  the old version stayed open, still waits), and on `updatefound` → `installed`. Every tab of the app gets
  `updatefound` from its own `registration` object, so every tab shows the notice (decision 30).
- **`checkForUpdate` swallows its error.** `registration.update()` rejects offline, or when the server answers 5xx.
  The next check (an hour, the next `online`) tries again; nothing on the screen depends on one check.
- **`register` catches a refused registration.** Firefox's private windows and some browser settings refuse service
  workers. The app then works online as before 19a, with no notice and no offline opening.
- **The `controllerchange` listener is added at once, before `register`.** The first install's `controllerchange`
  can come before `register()` returns; a listener added later would miss it, and the next one would be taken for
  the first.
- **`'reloading'` decides who reloads.** Only the tab that clicked has that state, so only it reloads when the new
  version takes over. Every other tab moves to `'other-tab'` (decision 30).
- **After `load`** (decision 29). `document.readyState === 'complete'` covers a call made after the page loaded; the
  `{ once: true }` listener covers the usual case.
- **`reloadApp` posts `SKIP_WAITING`, then waits for the takeover.** A plain `location.reload()` does not activate a
  waiting worker: the browser keeps the old one while any page uses it, and the page being reloaded is one of them.
  The message is the one `sw.ts` listens for (19a.1).
- **With nothing waiting, it reloads at once.** That is the other tab's case: the new version already runs, and a
  reload loads its files.
- **The five-second fallback.** A waiting worker can be replaced by a newer one before it takes over, and then no
  `controllerchange` comes for this message. Without the fallback the button would say "Reloading…" for ever.

### `components/update-notice.tsx` (new)

```tsx
import { useLocale } from '@omnivo/i18n';

import { reloadApp, useUpdateState } from '../lib/app-update';

// Step 19a (decision 3): "A new version is ready · Reload". Outside the router (main.tsx), so it
// stays on every page, the sign-in page too, and a page change never hides it. Fixed in a corner
// in the toast's look: it never moves the page under an open form. It cannot be closed: it says
// what will happen, and in another tab's case this tab's next page needs the reload.
export function UpdateNotice() {
  const { t } = useLocale();
  const state = useUpdateState();
  if (state === 'none') return null;
  return (
    <div
      role="status"
      className="fixed inset-x-4 bottom-4 z-40 mx-auto flex max-w-md flex-wrap items-center gap-x-4 gap-y-2 rounded-control bg-ink px-4 py-3 text-body-sm text-bg shadow-lg sm:right-6 sm:bottom-6 sm:left-auto"
    >
      <span className="min-w-0 flex-1">
        {state === 'other-tab' ? t('shell.update.otherTab') : t('shell.update.ready')}
      </span>
      <button
        type="button"
        disabled={state === 'reloading'}
        onClick={reloadApp}
        className="h-9 shrink-0 rounded-lg bg-bg px-3 font-medium text-ink transition-colors duration-150 hover:bg-subtle"
      >
        {state === 'reloading' ? t('shell.update.reloading') : t('common.reload')}
      </button>
    </div>
  );
}
```

- **`role="status"`:** a screen reader reads the notice when it appears, without moving the focus away from the
  form the person is typing in.
- **The toast's look, fixed at the bottom** (decision 32): `ink` background, `bg` text, `rounded-control`,
  `shadow-lg`. `fixed` takes it out of the page's flow, so it never pushes a form down while someone types.
  `inset-x-4` keeps the 16px phone gutters; from `sm` it moves to the right corner, out of the way of the centred
  toasts.
- **`z-40`,** under the dialogs: a dialog that is open (a sign-out question, the branch dialog) stays on top.
- **The button is in the notice's own colours** (`bg` on `ink`), not a primary button: a `brand` button on `ink`
  would be a second accent next to the page's own primary button.
- **Disabled while `'reloading'`:** a second click would post `SKIP_WAITING` again and start a second timer.

### `main.tsx`

```diff
@@ -8,7 +8,10 @@ import { RouterProvider } from '@tanstack/react-router';
 import { StrictMode } from 'react';
 import { createRoot } from 'react-dom/client';
 
+import { UpdateNotice } from './components/update-notice';
 import { API_URL } from './lib/api';
+import { startAppUpdates } from './lib/app-update';
+import { watchInstall } from './lib/install';
 import { queryClient } from './lib/query-client';
 import { router } from './router';
 
@@ -23,6 +26,10 @@ async function enableMocking(): Promise<void> {
       if (request.url.startsWith(API_URL)) print.error();
     },
   });
+  // Step 19a: the offline screens' code, since this mode has no service worker of ours
+  void import('./mocks/offline-screens').then(({ preloadOfflineScreens }) => {
+    preloadOfflineScreens();
+  });
 }
 
 const rootElement = document.getElementById('root');
@@ -30,6 +37,13 @@ if (!rootElement) {
   throw new Error('Root element #root is missing from index.html');
 }
 
+// Step 19a: before the first render, so Chrome's install prompt is never missed (install.ts)
+watchInstall();
+// Step 19a (decision 11): the service worker only in a production build. `pnpm dev` would keep
+// old files while they are edited, and `pnpm dev:mock` cannot have it: MSW's worker needs the
+// same scope (/). A production build has no MSW (enableMocking above).
+if (import.meta.env.PROD) startAppUpdates();
+
 // worker চালু হওয়ার পরে render — নাহলে প্রথম request (session ফেরানো) mock-এর আগেই বেরিয়ে যেত.
 // And after this device's language has arrived (Bangla is its own chunk since step 13).
 void Promise.all([enableMocking(), languageReady]).then(() => {
@@ -40,6 +54,8 @@ void Promise.all([enableMocking(), languageReady]).then(() => {
       </QueryClientProvider>
       {/* রুটের বাইরে: পেজ বদলালেও চলতি toast মুছে যায় না */}
       <Toaster />
+      {/* Step 19a: outside the routes too, for the same reason, and for the sign-in page */}
+      <UpdateNotice />
     </StrictMode>,
   );
 });
```

- **`watchInstall()` before the first render** (decision 33). Chrome sends `beforeinstallprompt` once per page
  load, often while the app still waits for the session. An event nobody listened to is lost until the next load.
- **`import.meta.env.PROD`** (decision 11). In `pnpm dev` and `pnpm dev:mock` the branch is never taken, and in a
  production build `enableMocking` is never taken, so the two workers never meet.
- **`<UpdateNotice />` next to the `<Toaster />`,** outside the router, for the same reason as the toasts: a page
  change never removes it. It also shows on the sign-in page, which has no AppShell.
- **The mock mode's background loading** (decision 38) is a dynamic import inside `enableMocking`, the only way
  dependency-cruiser's `mocks-only-in-dev` rule lets app code reach `src/mocks/`. A production build removes the whole
  branch.

### `components/local-state.tsx`: the sync notice's Reload

```diff
@@ -10,7 +10,9 @@ import {
 import { HugeiconsIcon } from '@hugeicons/react';
 import { useLocale } from '@omnivo/i18n';
 import { Button, EmptyState } from '@omnivo/ui';
+import { useEffect } from 'react';
 
+import { checkForUpdate, reloadApp } from '../lib/app-update';
 import { askForBranch, type LocalView, retryLocalData } from '../lib/local-data';
 
 export type WaitingView = Exclude<LocalView, { kind: 'ready' }>;
@@ -119,8 +121,15 @@ export function useLocalStateText(): (view: WaitingView) => string | undefined {
 
 // A problem of the engine that needs the person (local-data.ts → NOTICES, all error codes): above the list, which
 // still shows the copy. Like a document notice (CLAUDE.md), neutral: the data is still there.
+// Step 19a: the app is older than the server (sync_protocol_mismatch) right after a new version was
+// published, so the notice asks the service worker to look for it at once: by the time the person
+// reads this, it is often waiting, and Reload takes it. A plain reload would open the old version
+// again, from the worker's files.
 export function SyncNotice({ code }: { code: string }) {
   const { t, errorText } = useLocale();
+  useEffect(() => {
+    if (code === 'sync_protocol_mismatch') checkForUpdate();
+  }, [code]);
   return (
     <p className="flex items-start gap-2 rounded-control border border-line bg-subtle px-3 py-2.5 text-body-sm text-ink-2">
       <HugeiconsIcon
@@ -134,9 +143,7 @@ export function SyncNotice({ code }: { code: string }) {
         <button
           type="button"
           className="font-medium text-brand underline-offset-3 hover:underline"
-          onClick={() => {
-            window.location.reload();
-          }}
+          onClick={reloadApp}
         >
           {t('common.reload')}
         </button>
```

- **`checkForUpdate()` when the code is `sync_protocol_mismatch`** (decision 31). The server says this app's sync code
  is too old, which happens right after a new version was published. The browser has not looked at `sw.js` since the
  page loaded, so the app asks now: by the time the person reads the notice, the new version is often waiting.
- **Its Reload is `reloadApp`.** With a new version waiting, a plain reload would open the old version again from
  the worker's files, and the notice would come back. With nothing waiting, `reloadApp` is a plain reload, as before.

### `lib/install.ts` (new)

```ts
import { i18n } from '@omnivo/i18n';
import { toast } from '@omnivo/ui';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

// Step 19a: installing the app (decision 20), and the count on its icon.

// Chromium's install prompt (Chrome, Edge, Samsung Internet). It is not a web standard, so
// TypeScript's DOM types do not have it: this is the one part the app uses, and isInstallPrompt
// checks an event against it instead of a cast (rule 3).
interface InstallPromptEvent extends Event {
  prompt: () => Promise<unknown>;
}

function isInstallPrompt(event: Event): event is InstallPromptEvent {
  return 'prompt' in event && typeof event.prompt === 'function';
}

// How this browser installs the app: its own prompt, or the steps of Safari's own command
export type InstallWay = 'prompt' | 'ios' | 'mac-safari';

const installStore = createStore<{ prompt: InstallPromptEvent | null; installed: boolean }>()(
  () => ({ prompt: null, installed: false }),
);

// Safari gives a page no install prompt, so the user agent is the only way to know it is there
function safariWay(): InstallWay | null {
  const agent = navigator.userAgent;
  // iPadOS says "Macintosh", like a Mac; only a touch screen tells them apart. Every browser on
  // iOS is Safari underneath and has Add to Home Screen in its share menu (iOS 16.4 and later).
  if (
    /iPhone|iPad|iPod/.test(agent) ||
    (agent.includes('Macintosh') && navigator.maxTouchPoints > 1)
  ) {
    return 'ios';
  }
  // Safari on a Mac (File → Add to Dock, Safari 17 and later). Chrome, Edge and Opera say
  // "Safari" too, so they are named to be left out; Firefox on a Mac has no install at all.
  if (
    agent.includes('Macintosh') &&
    agent.includes('Safari/') &&
    !/Chrome|Chromium|Edg|OPR|Firefox/.test(agent)
  ) {
    return 'mac-safari';
  }
  return null;
}

// Called once by main.tsx, before the first render: Chrome sends its prompt once per page load,
// often before the AppShell is on the screen, and an event nobody listened to is gone.
export function watchInstall(): void {
  // The app already runs in its own window: there is nothing to install
  const standalone = window.matchMedia('(display-mode: standalone)');
  installStore.setState({ installed: standalone.matches });
  standalone.addEventListener('change', () => {
    installStore.setState({ installed: standalone.matches });
  });
  window.addEventListener('beforeinstallprompt', (event) => {
    if (!isInstallPrompt(event)) return;
    // Kept for the menu item. Without preventDefault, Chrome on Android shows its own bar over
    // the bottom of the page, which on a phone is where a form's buttons are.
    event.preventDefault();
    installStore.setState({ prompt: event });
  });
  window.addEventListener('appinstalled', () => {
    installStore.setState({ prompt: null, installed: true });
    toast(i18n.t('shell.installed'));
  });
}

// null = nothing to show: installed already, or a browser with no way to install (Firefox)
export function useInstallWay(): InstallWay | null {
  const prompt = useStore(installStore, (store) => store.prompt);
  const installed = useStore(installStore, (store) => store.installed);
  if (installed) return null;
  return prompt ? 'prompt' : safariWay();
}

// The menu item's click (a user gesture, which the prompt needs). A prompt can be shown once:
// after it, the item hides until Chrome sends a new one (it does after a dismissal, later).
export function promptInstall(): void {
  const { prompt } = installStore.getState();
  if (!prompt) return;
  installStore.setState({ prompt: null });
  void prompt.prompt().catch(() => undefined);
}

// The number of changes waiting on the device, on the installed app's icon: Chrome and Edge on a
// computer, an app added to the Dock on a Mac. iOS shows it only with the notification permission,
// which the app does not ask for. A browser tab shows nothing, and an old browser lacks the call.
export function setIconCount(count: number): void {
  if (!('setAppBadge' in navigator)) return;
  const done = count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge();
  void done.catch(() => undefined);
}
```

- **`InstallPromptEvent` is written here, with only `prompt()`.** `beforeinstallprompt` is Chromium's own event, not
  a web standard, so TypeScript's DOM types do not have it. `isInstallPrompt` checks the event at run time instead of
  a cast (rule 3); `'prompt' in event` narrows it, and `typeof event.prompt === 'function'` checks what it is.
- **`InstallWay`:** the three ways the menu item can work. The dialog takes only the two Safari ones
  (`Exclude<InstallWay, 'prompt'>`), so passing `'prompt'` to it is a type error.
- **`safariWay` reads the user agent** (decision 34). The iOS test comes first: on iOS every browser is Safari
  underneath and has Add to Home Screen. The Mac test leaves out Chrome, Edge, Opera and Firefox by name, because
  they all write "Safari" in their user agent too. In a browser with neither, it gives `null` and the item hides
  (decision 20).
- **`display-mode: standalone`** is true inside the installed app. The `change` listener follows a page that moves
  into the app's window (Chrome can do that after installing).
- **`preventDefault()` on the prompt** (decision 33). It also tells Chrome the page will show the prompt itself.
- **`appinstalled` clears the prompt and shows `shell.installed`.** `i18n.t`, not the hook's `t`: this is outside
  React. The toast says what happened, as CLAUDE.md asks.
- **`useInstallWay` reads two values with two selectors.** One selector that returns a new object would give a new
  value on every store change, and React would draw the menu again each time.
- **`promptInstall` clears the prompt before showing it.** Chrome allows `prompt()` once per event; a second call
  throws. The `.catch` covers a browser that refuses it anyway (the click was not a user gesture, for example).
- **`setIconCount`** (decision 35). `'setAppBadge' in navigator` is the check, because TypeScript's types say the call
  always exists. Both calls return a promise that rejects when the app is not installed, or the browser does not
  allow a badge right now: a missing count is never an error the person needs to see.

### `components/install-dialog.tsx` (new)

```tsx
import { useLocale } from '@omnivo/i18n';
import { Button, Dialog, DialogClose, DialogContent } from '@omnivo/ui';

import type { InstallWay } from '../lib/install';

// Step 19a (decision 20): Safari can install the app, but only from its own menus, so the dialog
// says where. Only the steps of this device: an iPhone user has no File menu to look for.
export function InstallDialog({
  way,
  onClose,
}: {
  way: Exclude<InstallWay, 'prompt'>;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const steps =
    way === 'ios'
      ? [t('shell.install.iosStep1'), t('shell.install.iosStep2'), t('shell.install.iosStep3')]
      : [t('shell.install.macStep1'), t('shell.install.macStep2')];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        title={t('shell.install.title')}
        description={t('shell.install.description')}
        footer={
          <DialogClose asChild>
            <Button>{t('common.close')}</Button>
          </DialogClose>
        }
      >
        <section className="grid gap-2">
          <h3 className="text-body-sm font-medium">
            {way === 'ios' ? t('shell.install.iosTitle') : t('shell.install.macTitle')}
          </h3>
          <ol className="grid list-decimal gap-1.5 pl-5 text-body-sm text-ink-2">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </section>
      </DialogContent>
    </Dialog>
  );
}
```

- **Only the steps of this device** (decision 20): an iPhone user has no File menu, a Mac user has no Share sheet.
- **The steps are an `<ol>`** because their order matters; the keys are one per step (19a.2), so each is type-checked.
- **One button, Close, and it is the primary button.** The dialog cannot install anything itself; its only action is
  to close so the person can follow the steps.
- **A lazy chunk of its own** (app-shell.tsx below): most devices never open it.

### `routes/app-shell.tsx`: "Install app"

```diff
@@ -11,6 +11,7 @@ import {
   DashboardSquare01Icon,
   DeliveryReturn01Icon,
   DeliveryTruck01Icon,
+  Download04Icon,
   Factory01Icon,
   FileDownloadIcon,
   FileImportIcon,
@@ -84,6 +85,7 @@ import { createLink, Outlet, useNavigate } from '@tanstack/react-router';
 import { lazy, Suspense, useEffect, useState } from 'react';
 
 import { NotificationBell } from '../components/notification-bell';
+import { type InstallWay, promptInstall, useInstallWay } from '../lib/install';
 import { savePreference } from '../lib/preferences';
 import { logout, switchTenant } from '../lib/session';
 import { useCan } from '../lib/permissions';
@@ -104,6 +106,10 @@ const LocalDataHost = lazy(async () => ({
 const SignOutDialog = lazy(async () => ({
   default: (await import('../components/sign-out-dialog')).SignOutDialog,
 }));
+// Step 19a: Safari's how-to, the same way: opened once per device at most
+const InstallDialog = lazy(async () => ({
+  default: (await import('../components/install-dialog')).InstallDialog,
+}));
 
 // ui-র সাধারণ <a> → TanStack-এর টাইপ-চেকড লিংক: to="/kitchn-sink" লিখলে compile error,
 // আর সক্রিয় রুটে Link নিজেই aria-current="page" বসায়
@@ -241,7 +247,16 @@ function SyncNavItem() {
 }
 
 // ডেস্কটপের সাইডবার-তলা আর ফোনের টপ বার — দুই trigger, একই মেনু
-function UserMenuContent({ align, onSignOut }: { align: 'start' | 'end'; onSignOut: () => void }) {
+function UserMenuContent({
+  align,
+  onInstall,
+  onSignOut,
+}: {
+  align: 'start' | 'end';
+  // Step 19a: undefined = nothing to install (installed already, or a browser that cannot)
+  onInstall: (() => void) | undefined;
+  onSignOut: () => void;
+}) {
   const { t, language } = useLocale();
   const navigate = useNavigate();
   const theme = useSession((state) => state.me?.preferences.theme ?? 'system');
@@ -255,6 +270,12 @@ function UserMenuContent({ align, onSignOut }: { align: 'start' | 'end'; onSignO
       >
         {t('shell.myDevices')}
       </DropdownMenuItem>
+      {/* Step 19a: about this device, like My devices */}
+      {onInstall && (
+        <DropdownMenuItem icon={Download04Icon} onSelect={onInstall}>
+          {t('shell.installApp')}
+        </DropdownMenuItem>
+      )}
       <DropdownMenuSeparator />
       <DropdownMenuLabel>{t('common.language')}</DropdownMenuLabel>
       <DropdownMenuRadioGroup
@@ -310,6 +331,16 @@ export function AppShell() {
     if (unsynced > 0) setAsking(true);
     else void logout();
   };
+  // Step 19a (decision 20): Chrome's own prompt, or the dialog with Safari's steps
+  const installWay = useInstallWay();
+  const [installHelp, setInstallHelp] = useState<Exclude<InstallWay, 'prompt'> | null>(null);
+  const install =
+    installWay === null
+      ? undefined
+      : () => {
+          if (installWay === 'prompt') promptInstall();
+          else setInstallHelp(installWay);
+        };
 
   // refresh ব্যর্থ হলে (session শেষ, অন্য ট্যাবে লগআউট) api.ts store-এ signed-out বসায়
   useEffect(() => {
@@ -325,7 +356,7 @@ export function AppShell() {
           <DropdownMenuTrigger asChild>
             <IconButton icon={UserCircleIcon} label={t('shell.account')} />
           </DropdownMenuTrigger>
-          <UserMenuContent align="end" onSignOut={signOut} />
+          <UserMenuContent align="end" onInstall={install} onSignOut={signOut} />
         </DropdownMenu>
       }
       sidebarHeader={<WorkspaceSwitcher />}
@@ -596,7 +627,7 @@ export function AppShell() {
               />
             </button>
           </DropdownMenuTrigger>
-          <UserMenuContent align="start" onSignOut={signOut} />
+          <UserMenuContent align="start" onInstall={install} onSignOut={signOut} />
         </DropdownMenu>
       }
     >
@@ -611,6 +642,16 @@ export function AppShell() {
           />
         </Suspense>
       )}
+      {installHelp && (
+        <Suspense fallback={null}>
+          <InstallDialog
+            way={installHelp}
+            onClose={() => {
+              setInstallHelp(null);
+            }}
+          />
+        </Suspense>
+      )}
       {/* No fallback: the host draws nothing until a branch dialog is needed */}
       <Suspense fallback={null}>
         <LocalDataHost />
```

- **`onInstall` is `undefined` when there is nothing to install.** The menu item is shown only when it is set, so the
  menu has one source of truth for "can this device install the app", `useInstallWay`.
- **`Download04Icon`,** from HugeIcons' Stroke Rounded set, like every icon in the menu.
- **After My devices** (decision 33), above the separator: both are about this device; language and theme below are
  about the person.
- **Both menus get the same `install`:** the desktop sidebar's and the phone's top bar's, as with `onSignOut`.
- **`installHelp` keeps which dialog to open** (`'ios'` or `'mac-safari'`), so the dialog does not have to work out
  the browser again.

### `components/local-data-host.tsx`: the count on the icon, and no more background loading

```diff
@@ -3,8 +3,9 @@ import { useStore } from 'zustand';
 
 import { localDataStore, useDeviceState } from '../lib/local-data';
 import { chooseBranch, chooseLater, startLocalData } from '../lib/local-session';
-import { preloadOfflineScreens } from '../lib/offline-screens';
+import { setIconCount } from '../lib/install';
 import { useSession } from '../lib/session-store';
+import { syncSummaryStore } from '../lib/sync-summary';
 
 // Step 18b: loaded when it opens, once per device at most. The push took this chunk (with Dexie)
 // over its budget, and the dialog's code is 14 KB gz of it.
@@ -20,20 +21,24 @@ export function LocalDataHost() {
   const tenantId = useSession((state) => state.me?.tenant.id);
   const asking = useStore(localDataStore, (state) => state.asking);
   const device = useDeviceState();
+  const waiting = useStore(syncSummaryStore, (state) => state.waiting);
 
   useEffect(() => {
     if (userId === undefined || tenantId === undefined) return;
     return startLocalData({ tenantId, userId });
   }, [tenantId, userId]);
 
-  // Step 18b (decision 42): the offline screens' code, while there is a connection
+  // Step 19a: the changes waiting, on the installed app's icon. Gone when the host goes (sign-out):
+  // the copy and its outbox are deleted then, and the next person must not see the count.
   useEffect(() => {
-    preloadOfflineScreens();
-    window.addEventListener('online', preloadOfflineScreens);
-    return () => {
-      window.removeEventListener('online', preloadOfflineScreens);
-    };
-  }, []);
+    setIconCount(waiting);
+  }, [waiting]);
+  useEffect(
+    () => () => {
+      setIconCount(0);
+    },
+    [],
+  );
 
   return asking && device.kind === 'not-set-up' ? (
     <Suspense fallback={null}>
```

- **The host is the right place:** it runs only while a person is signed in, and it already lives as long as that
  person's copy. Its unmount effect clears the count on sign-out (decision 35).
- **Two effects, not one:** an effect that cleared the count in its cleanup on every change would clear it and set
  it again at each change of the number, and the icon would blink.
- **18b's `preloadOfflineScreens` effect is gone** (decision 4). The worker keeps every chunk, also the ones no
  screen loaded yet.

### `lib/storage.ts` (new)

```ts
// Step 19a: whether the browser keeps the device's copy, and how much space it uses. Without
// "persistent" storage, a browser low on space may delete a site's data, the outbox with it.

export type StorageKept = 'kept' | 'may-be-cleared' | 'unknown';

export interface StorageInfo {
  kept: StorageKept;
  // Bytes, for the whole site: the copy, the outbox and the service worker's files. null = the
  // browser does not say.
  used: number | null;
  quota: number | null;
}

// navigator.storage exists only on https:// and localhost. TypeScript's types say it is always
// there, so the check is `in`, which they cannot rule out.
function storageManager(): StorageManager | null {
  return 'storage' in navigator ? navigator.storage : null;
}

async function keptState(storage: StorageManager): Promise<StorageKept> {
  if (!('persisted' in storage)) return 'unknown';
  try {
    return (await storage.persisted()) ? 'kept' : 'may-be-cleared';
  } catch {
    return 'unknown';
  }
}

async function estimate(storage: StorageManager): Promise<StorageEstimate | null> {
  if (!('estimate' in storage)) return null;
  try {
    return await storage.estimate();
  } catch {
    return null;
  }
}

export async function readStorage(): Promise<StorageInfo> {
  const storage = storageManager();
  if (!storage) return { kept: 'unknown', used: null, quota: null };
  const [kept, space] = await Promise.all([keptState(storage), estimate(storage)]);
  return { kept, used: space?.usage ?? null, quota: space?.quota ?? null };
}

// Asked when the device's copy is set up (local-session.ts), and by the Sync page's button. No
// browser shows a question for it but Firefox: Chrome and Edge answer at once from how the site is
// used (installed, bookmarked), Safari by its own rules. null = this browser cannot be asked.
export async function askToKeep(): Promise<boolean | null> {
  const storage = storageManager();
  if (!storage || !('persist' in storage)) return null;
  try {
    return await storage.persist();
  } catch {
    return null;
  }
}
```

- **`'storage' in navigator`:** `navigator.storage` exists only in a secure context (`https://` or `localhost`).
  TypeScript's types say it is always there, so a plain `if (navigator.storage)` would be flagged as always true.
- **Each call has its own `try`.** `persisted()` and `estimate()` can reject (a browser setting, a private window),
  and one failing must not hide the other's answer.
- **`'unknown'` and `null` are real answers** for the page: the card says "This browser does not say whether it keeps
  the copy" and leaves out the size line.
- **`askToKeep` gives `null` when it cannot ask,** so its callers can tell "refused" (`false`) from "cannot ask".

### `lib/local-session.ts`: asking at set-up

```diff
@@ -29,6 +29,7 @@ import { setDeviceReads } from './device-reads';
 import { localDataStore, type MoveResult } from './local-data';
 import { queryClient } from './query-client';
 import { sessionStore } from './session-store';
+import { askToKeep } from './storage';
 import { NO_SUMMARY, syncSummaryStore } from './sync-summary';
 
 // Step 18a: this browser as a device, and its copy of the data, for the person signed in now.
@@ -259,8 +260,12 @@ async function register(session: Session, branchId: string): Promise<Device> {
   // The server's branch, not the one asked for: registering an existing device again changes
   // nothing (decision 37)
   remember(session, { id: device.id, branchId: device.branchId, later: false });
-  if (device.revokedAt === null) await open(session);
-  else await revoke(session);
+  if (device.revokedAt === null) {
+    // Step 19a: the copy is about to be pulled, so the browser is asked to keep it. Not awaited:
+    // Firefox shows a question, and the pull must not wait for the answer.
+    void askToKeep();
+    await open(session);
+  } else await revoke(session);
   return device;
 }
 
```

- **In `register`, for an active device only,** just before the first pull (decision 36). That is the moment the
  device starts to hold work worth keeping. A revoked device gets no copy, so it is not asked.
- **`void askToKeep()`:** the pull starts at once. In Chrome and Edge the answer comes in a few milliseconds with no
  question; in Firefox a question waits for the person.

### `components/storage-card.tsx` (new) and `routes/sync.tsx`

```tsx
import { Alert02Icon, CheckmarkCircle02Icon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, CardHeader, Pill } from '@omnivo/ui';
import { useEffect, useState } from 'react';

import { askToKeep, readStorage, type StorageInfo } from '../lib/storage';

// Step 19a: the Sync page's card about the space the device uses. "May be cleared" is warn: the
// person can act on it (ask, or install the app), and what is at stake is work not synced yet.
export function StorageCard() {
  const { t, format } = useLocale();
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [asking, setAsking] = useState(false);
  const [refused, setRefused] = useState(false);

  useEffect(() => {
    let live = true;
    void readStorage().then((read) => {
      if (live) setInfo(read);
    });
    return () => {
      live = false;
    };
  }, []);

  const ask = async () => {
    setAsking(true);
    const kept = await askToKeep();
    // false = asked and refused; null = this browser cannot be asked, which `unknown` already says
    setRefused(kept === false);
    setInfo(await readStorage());
    setAsking(false);
  };

  // The browser answers in a few milliseconds: a card that waits for it is better than one that
  // shows a wrong state first
  if (!info) return null;

  return (
    <Card>
      <CardHeader
        title={t('sync.storage.title')}
        subtitle={t('sync.storage.subtitle')}
        actions={
          info.kept === 'kept' ? (
            <Pill tone="good" icon={CheckmarkCircle02Icon}>
              {t('sync.storage.kept')}
            </Pill>
          ) : info.kept === 'may-be-cleared' ? (
            <Pill tone="warn" icon={Alert02Icon}>
              {t('sync.storage.mayBeCleared')}
            </Pill>
          ) : null
        }
      />
      <div className="grid gap-3 px-5 pt-3 pb-5">
        <p className="text-body-sm text-ink-2">
          {info.kept === 'kept'
            ? t('sync.storage.keptBody')
            : info.kept === 'may-be-cleared'
              ? t('sync.storage.mayBeClearedBody')
              : t('sync.storage.unknown')}
        </p>
        {info.used !== null && info.quota !== null && (
          <p className="text-caption text-ink-3 tabular-nums">
            {t('sync.storage.used', {
              used: format.bytes(info.used),
              quota: format.bytes(info.quota),
            })}
          </p>
        )}
        {info.kept === 'may-be-cleared' &&
          (refused ? (
            <p className="text-body-sm text-ink-2">{t('sync.storage.refused')}</p>
          ) : (
            <div>
              <Button variant="secondary" size="sm" disabled={asking} onClick={() => void ask()}>
                {t('sync.storage.ask')}
              </Button>
            </div>
          ))}
      </div>
    </Card>
  );
}
```

- **Read once when the card opens.** The answers change only when the person asks (the button) or the browser's
  rules change, so polling would only cost work.
- **`live`** keeps a late answer from setting state after the person left the page.
- **Nothing until the browser answers:** it takes a few milliseconds, and a card that first said "May be cleared"
  and then "Kept" would look like a problem that went away.
- **The pill is the status** (CLAUDE.md: an icon and a label, never colour alone): `good` + `CheckmarkCircle02` for
  kept, `warn` + `Alert02` for may be cleared (decision 37). "Unknown" has no pill: the sentence says it.
- **`refused` replaces the button with what works instead** (`sync.storage.refused`: install the app). Asking again
  at once would get the same answer in every browser.
- **The sizes are `format.bytes`** (decision 18) with `tabular-nums`, in caption text: they are a detail, not the
  status.

```diff
@@ -34,6 +34,7 @@ import { useState } from 'react';
 
 import { DocumentNotice } from '../components/document-notice';
 import { LocalState } from '../components/local-state';
+import { StorageCard } from '../components/storage-card';
 import { useTenantId, useTimeZone } from '../components/stock-parts';
 import { OutboxStatusPill, useCommandText, useFieldList } from '../components/sync-parts';
 import {
@@ -267,6 +272,9 @@ export function SyncPage() {
         </Card>
       )}
 
+      {/* Step 19a: last, because nothing in it changes from one sync to the next */}
+      <StorageCard />
+
       <Dialog
         open={discarding !== null}
         onOpenChange={(open) => {
```

- **Last on the page** (decision 37), after the changes on the device.

### The background loading: deleted from the app, kept for mock mode

```bash
git rm apps/app/src/lib/offline-screens.ts
```

```ts
// Step 19a: mock mode has no service worker of ours (MSW's worker needs the same scope, decision
// 11), so a chunk the browser never loaded cannot load offline there. The Playwright tests run in
// this mode and go offline (context.setOffline), so the code of every screen that works without a
// connection is fetched in the background at start, as the app did in every mode in step 18b. A
// production build has the service worker instead, which keeps every chunk.
const SCREENS = [
  // The lists read from the device (18a)
  () => import('../routes/products'),
  () => import('../routes/customers'),
  // A customer saved on the device
  () => import('../routes/customer-edit'),
  () => import('../components/customer-form'),
  // A draft order saved on the device, with its lines, the customer box and the date boxes
  () => import('../routes/sales-orders'),
  () => import('../routes/sales-order'),
  () => import('../components/sales-order-form'),
  () => import('../components/sales-line-editor'),
  () => import('../components/customer-picker'),
  () => import('../components/date-input'),
  // The Sync page, the question before signing out with changes on the device, and the sign-in
  // page that signing out offline ends on
  () => import('../routes/sync'),
  () => import('../components/sign-out-dialog'),
  () => import('../routes/login'),
];

// Once, by main.tsx's enableMocking. The dev server is on this computer, so it does not fail.
export function preloadOfflineScreens(): void {
  void Promise.all(SCREENS.map((load) => load())).catch(() => undefined);
}
```

- **The same list as 18b's file,** without the calendar (below), in `src/mocks/` (decision 38). It runs once at start:
  the dev server is on the same computer, so the load does not fail half way, and the 18b retry on `online` is not
  needed.
- **`.catch(() => undefined)`:** a chunk that fails here only means a test that goes offline fails, with a clear
  message, at the screen that did not load.

```diff
@@ -8,14 +8,7 @@ import { parseIsoDate, toIsoDate } from '../lib/iso-date.js';
 import { controlBoxClass } from './field.js';
 import { Popover, PopoverContent, PopoverTrigger } from './popover.js';
 
-// Step 18b: also called by the app while it is online, so that a date can be picked offline later
-// (the app's offline-screens.ts): before step 19's service worker, a chunk the browser never
-// loaded cannot load without a connection
-export function loadCalendar() {
-  return import('./calendar.js');
-}
-
-const Calendar = lazy(async () => ({ default: (await loadCalendar()).Calendar }));
+const Calendar = lazy(async () => ({ default: (await import('./calendar.js')).Calendar }));
 
 interface DatePickerProps {
   id?: string;
```

```diff
@@ -15,7 +15,7 @@ export {
   type DataTableColumnMeta,
   type SortingState,
 } from './components/data-table.js';
-export { DatePicker, loadCalendar } from './components/date-picker.js';
+export { DatePicker } from './components/date-picker.js';
 export { DiscountInput, type DiscountType } from './components/discount-input.js';
 export { Dialog, DialogClose, DialogContent, DialogTrigger } from './components/dialog.js';
 export {
```

- **`loadCalendar` is gone.** It existed only so that 18b's list could load the calendar's chunk in the background.
  The date picker imports the chunk itself again, the first time it opens, as before 18b; the worker keeps it. Mock
  mode's list leaves it out: no test opens a date picker offline, and in `pnpm dev:mock` a date picker opened for the
  first time offline fails to open, which is what a browser without the worker does.

### Check this part

```bash
pnpm --filter @omnivo/ui build
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/app test
pnpm --filter @omnivo/app build
pnpm --filter @omnivo/app test:bundle-size
pnpm boundaries
pnpm --filter @omnivo/app test:e2e outbox sync devices
```

Build `@omnivo/ui` first: the app reads it from `dist/`. All seven pass. The bundle check prints `initial JS 212.7 KB
gz (budget 215.0 KB)` and `precache 380 files 1317.0 KB gz`: this part adds 1.1 KB to the first load (the update
store, the install watch and the notice), and two files to the worker's list: the install dialog, and `storage.ts`,
which the build puts in a small chunk of its own because two chunks use it (the device's host and the Sync page).
The mock list is not in it: a production build has no mocks.

Try it by hand on a production build:

1. `pnpm --filter @omnivo/app build && pnpm --filter @omnivo/app preview`, open `http://localhost:4173`. DevTools →
   Application → Service workers shows `sw.js` activated, with nothing typed in the console this time.
2. Change any text in the app, build again (leave the preview running), and open a second tab. Both tabs say "A new
   version of Omnivo is ready". Click Reload in one: it reloads, and the other says "Omnivo was updated in another
   tab".
3. In Chrome, the account menu has "Install app"; in Safari on a Mac it opens the dialog with "File, then Add to
   Dock".

> **What we checked in this part.** `apps/app` and `packages/ui` type-check, ESLint and Prettier are clean on every
> touched file, the app's 144 unit tests pass, it builds, the bundle check passes, and dependency-cruiser finds no
> problem. The e2e suites that go offline (outbox, sync, devices) pass on desktop and phone. Their first run, before
> decision 38, failed 7 tests at the first screen opened offline: that is how we found that mock mode needs the
> background loading. In a real Chromium on the production build, with two tabs: the app registered the worker by
> itself, and the first install showed no notice; a changed `sw.js` and an `online` event made both tabs show the
> notice; Reload in one tab reloaded it into the new version, the other said "updated in another tab", and its
> Reload was a plain reload with no notice after it; with the server stopped, a reload opened the new version. We
> then removed the `hadWorker` check on purpose: the first visit showed the notice, as expected. A throwaway
> Playwright test (deleted) on the mock app checked the rest: no "Install app" before a prompt; a prompt event is
> kept (`preventDefault`), the item calls its `prompt()` and then hides; `appinstalled` shows "Omnivo is installed";
> the icon count is 0 at start and 1 after a customer saved offline; `persist()` is asked once when the branch is
> chosen; the storage card shows "May be cleared" in headless Chromium, and after "Ask to keep it" the browser's no;
> Safari's user agent opens the dialog with the Mac's two steps. The real tests come in 19a.5.

## 19a.5 — `apps/app`: the tests

The code of 19a.3 and 19a.4 was checked with throwaway scripts. This part turns them into tests that stay: two unit
test files for the session and the update notice, one e2e file on the mock app, and a new e2e suite on a real
production build for the worker itself.

```
pnpm --filter @omnivo/app test            offline-session.spec.ts   a reload with no answer, the check, the sign-out offline
                                          app-update.spec.ts        which update state follows which worker event
pnpm --filter @omnivo/app test:e2e        install-and-storage.e2e   Install app, Safari's steps, icon count, storage card
                                                                     (the mock app: MSW, no worker of ours)
pnpm --filter @omnivo/app test:e2e:pwa    pwa-build.ts              build once: node_modules/.pwa-e2e, API = 127.0.0.1:9
                                          pwa-server.ts             vite preview per test, stopped to be offline for real
                                          offline.pwa.ts            offline reload · the last person · two-tab update
```

### `lib/offline-session.spec.ts` (new)

```ts
import { type MeResponse, routes } from '@omnivo/contracts';
import { newDeviceId, readDevice, saveDevice } from '@omnivo/sync';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { HEAD_OFFICES, meIn, WORKSPACES } from '../mocks/fixtures';
import { mock, problem, reply } from '../mocks/mock';
import { seedPeople } from '../mocks/people-data';
import { API_URL } from './api';

// Step 19a: the offline opening, the check when the server answers again, and the sign-out with
// no connection. A test "reloads the page" with vi.resetModules(): every module of the app starts
// again (the session store, restoreSession's promise, the offline check), and only the browser's
// localStorage stays, as after a real reload.

const server = setupServer();

const [garments] = WORKSPACES;
const me = meIn(garments, 'Rahman Garments Ltd.', { language: null, theme: 'system' }, 'ready');
const page = { items: seedPeople(garments).members.slice(0, 2), nextCursor: null };

// The part of localStorage the app uses. A Map, so a test can read what the app left there.
function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
  };
}

let storage = memoryStorage();

// apps/app's tests run in Node, with no DOM. The window is an EventTarget, for the `online` event
// the offline opening listens to, with the storage on it; the document has only what applyTheme
// touches.
function stubBrowser(): void {
  storage = memoryStorage();
  vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage: storage }));
  vi.stubGlobal('document', {
    documentElement: { dataset: {}, removeAttribute: () => undefined },
  });
}

// The device copy of step 18a: a branch chosen for this person on this browser
function setUpDevice(): void {
  saveDevice(storage, garments.tenantId, me.user.id, {
    id: newDeviceId(),
    branchId: HEAD_OFFICES[garments.slug],
    later: false,
  });
}

// A new page load: new modules, the same storage
async function reload() {
  vi.resetModules();
  const [session, store, api] = await Promise.all([
    import('./session'),
    import('./session-store'),
    import('./api'),
  ]);
  return { ...session, sessionStore: store.sessionStore, call: api.call };
}

type App = Awaited<ReturnType<typeof reload>>;
let app: App | null = null;

// A page that was signed in online: the store remembered the person
async function signedInOnce(): Promise<App> {
  app = await reload();
  app.sessionStore.getState().signIn(me);
  app.sessionStore.getState().setAccessToken('first');
  return app;
}

// A reload with no connection, after an online visit on a device with a copy
async function openedOffline(): Promise<App> {
  setUpDevice();
  await signedInOnce();
  server.use(http.post(`${API_URL}/auth/refresh`, () => HttpResponse.error()));
  app = await reload();
  await app.restoreSession();
  return app;
}

function session(accessToken: string) {
  return { accessToken, accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString() };
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
beforeEach(() => {
  stubBrowser();
});
afterEach(() => {
  // A test that ends opened offline stops its watch for the server here
  app?.sessionStore.getState().signOut();
  app = null;
  server.resetHandlers();
  vi.unstubAllGlobals();
});
afterAll(() => {
  server.close();
});

describe('a reload with no answer from the server (step 19a)', () => {
  it('opens as the person who was signed in, with no token', async () => {
    const opened = await openedOffline();
    expect(opened.sessionStore.getState()).toMatchObject({
      status: 'signed-in',
      openedOffline: true,
      accessToken: null,
      me: { user: { id: me.user.id }, tenant: { id: garments.tenantId } },
    });
  });

  it('shows the sign-in page on a device with no copy for that person', async () => {
    await signedInOnce();
    server.use(http.post(`${API_URL}/auth/refresh`, () => HttpResponse.error()));
    app = await reload();
    await app.restoreSession();
    expect(app.sessionStore.getState()).toMatchObject({ status: 'signed-out', me: null });
  });

  it('treats a 502 from a proxy as no answer, and a refusal as the end of the sign-in', async () => {
    setUpDevice();
    await signedInOnce();
    server.use(mock(routes.auth.refresh, () => problem(502, 'unknown_error')));
    app = await reload();
    await app.restoreSession();
    expect(app.sessionStore.getState().openedOffline).toBe(true);

    server.use(mock(routes.auth.refresh, () => problem(401, 'session_ended')));
    app = await reload();
    await app.restoreSession();
    expect(app.sessionStore.getState().status).toBe('signed-out');

    // The refusal forgot the person: no connection now opens nothing
    server.use(http.post(`${API_URL}/auth/refresh`, () => HttpResponse.error()));
    app = await reload();
    await app.restoreSession();
    expect(app.sessionStore.getState().status).toBe('signed-out');
  });

  it('does not trust a remembered person the contract no longer accepts', async () => {
    setUpDevice();
    // What an older version of the app could have saved: a `me` without a field added since
    // (JSON leaves out a key whose value is undefined)
    storage.setItem('omnivo.me', JSON.stringify({ ...me, preferences: undefined }));
    server.use(http.post(`${API_URL}/auth/refresh`, () => HttpResponse.error()));
    app = await reload();
    await app.restoreSession();
    expect(app.sessionStore.getState().status).toBe('signed-out');
  });
});

describe('when the server answers again (step 19a)', () => {
  it('checks the sign-in at the first request that gets a 401, then sends it again', async () => {
    const opened = await openedOffline();
    const seen: (string | null)[] = [];
    server.use(
      mock(routes.auth.refresh, () => reply(routes.auth.refresh, session('fresh'))),
      mock(routes.auth.me, () => reply(routes.auth.me, me)),
      mock(routes.members.list, ({ request }) => {
        const token = request.headers.get('authorization');
        seen.push(token);
        return token === 'Bearer fresh'
          ? reply(routes.members.list, page)
          : problem(401, 'sign_in_required');
      }),
    );
    await expect(opened.call(routes.members.list)).resolves.toMatchObject({ nextCursor: null });
    expect(seen).toEqual([null, 'Bearer fresh']);
    expect(opened.sessionStore.getState()).toMatchObject({
      status: 'signed-in',
      openedOffline: false,
      accessToken: 'fresh',
    });
  });

  it('runs one check at a time, so the rotated cookie is never sent twice', async () => {
    const opened = await openedOffline();
    let refreshes = 0;
    let meAsked = false;
    let answerMe: () => void = () => undefined;
    const meAnswered = new Promise<void>((resolve) => {
      answerMe = resolve;
    });
    server.use(
      mock(routes.auth.refresh, () => {
        refreshes += 1;
        return reply(routes.auth.refresh, session(`fresh-${String(refreshes)}`));
      }),
      // The check waits here, after its refresh: api.ts's own guard (one refresh in flight) is
      // over by then, and only the offline check's guard stops a second refresh
      mock(routes.auth.me, async () => {
        meAsked = true;
        await meAnswered;
        return reply(routes.auth.me, me);
      }),
    );
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => {
      expect(meAsked).toBe(true);
    });
    // The minute's timer, or a second `online`, while the first check still runs
    window.dispatchEvent(new Event('online'));
    answerMe();
    await vi.waitFor(() => {
      expect(opened.sessionStore.getState().openedOffline).toBe(false);
    });
    expect(refreshes).toBe(1);
  });

  it('signs out with a notice when the server refuses, and keeps the copy', async () => {
    const opened = await openedOffline();
    server.use(mock(routes.auth.refresh, () => problem(401, 'session_ended')));
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => {
      expect(opened.sessionStore.getState()).toMatchObject({
        status: 'signed-out',
        notice: 'session_ended',
      });
    });
    // Decision 19: the device and its copy stay for the next online sign-in
    expect(readDevice(storage, garments.tenantId, me.user.id).branchId).toBe(
      HEAD_OFFICES[garments.slug],
    );
    // ...but the person is forgotten, so a reload with no connection shows the sign-in page
    server.use(http.post(`${API_URL}/auth/refresh`, () => HttpResponse.error()));
    app = await reload();
    await app.restoreSession();
    expect(app.sessionStore.getState().status).toBe('signed-out');
  });

  it('lets a sign-in from another tab win when the cookie is someone else’s', async () => {
    const opened = await openedOffline();
    const other: MeResponse = { ...me, user: { ...me.user, id: crypto.randomUUID() } };
    server.use(
      mock(routes.auth.refresh, () => reply(routes.auth.refresh, session('other'))),
      mock(routes.auth.me, () => reply(routes.auth.me, other)),
    );
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => {
      expect(opened.sessionStore.getState().openedOffline).toBe(false);
    });
    expect(opened.sessionStore.getState()).toMatchObject({
      status: 'signed-in',
      accessToken: 'other',
      me: { user: { id: other.user.id } },
    });
  });
});

describe('a sign-out with no connection (step 19a)', () => {
  // Signed in online, then the connection drops and the person signs out
  async function signedOutOffline(): Promise<App> {
    const signedIn = await signedInOnce();
    server.use(http.post(`${API_URL}/auth/logout`, () => HttpResponse.error()));
    await signedIn.logout();
    expect(signedIn.sessionStore.getState().status).toBe('signed-out');
    server.resetHandlers();
    return signedIn;
  }

  it('is sent at the next reload, which never refreshes the cookie', async () => {
    await signedOutOffline();
    const sent: string[] = [];
    server.use(
      mock(routes.auth.logout, () => {
        sent.push('logout');
        return reply(routes.auth.logout, undefined);
      }),
      mock(routes.auth.refresh, () => {
        sent.push('refresh');
        return reply(routes.auth.refresh, session('fresh'));
      }),
    );
    app = await reload();
    await app.restoreSession();
    expect(sent).toEqual(['logout']);
    expect(app.sessionStore.getState().status).toBe('signed-out');

    // Sent once: the reload after it refreshes as before step 19a
    app = await reload();
    server.use(mock(routes.auth.me, () => reply(routes.auth.me, me)));
    await app.restoreSession();
    expect(sent).toEqual(['logout', 'refresh']);
    expect(app.sessionStore.getState().status).toBe('signed-in');
  });

  it('keeps waiting while the server still does not answer', async () => {
    await signedOutOffline();
    let refreshes = 0;
    server.use(
      http.post(`${API_URL}/auth/logout`, () => HttpResponse.error()),
      mock(routes.auth.refresh, () => {
        refreshes += 1;
        return reply(routes.auth.refresh, session('fresh'));
      }),
    );
    for (let load = 0; load < 2; load += 1) {
      app = await reload();
      await app.restoreSession();
      expect(app.sessionStore.getState().status).toBe('signed-out');
    }
    expect(refreshes).toBe(0);
  });

  it('goes before the next sign-in', async () => {
    await signedOutOffline();
    const sent: string[] = [];
    server.use(
      mock(routes.auth.logout, () => {
        sent.push('logout');
        return reply(routes.auth.logout, undefined);
      }),
      mock(routes.auth.login, () => {
        sent.push('login');
        return reply(routes.auth.login, session('fresh'));
      }),
      mock(routes.auth.me, () => reply(routes.auth.me, me)),
    );
    app = await reload();
    await app.login({
      workspace: garments.slug,
      email: 'farhana@rahmangarments.com',
      password: 'Gazipur-knit-2026',
      keepSignedIn: true,
    });
    expect(sent).toEqual(['logout', 'login']);
    expect(app.sessionStore.getState()).toMatchObject({
      status: 'signed-in',
      accessToken: 'fresh',
    });
  });
});
```

- **`reload()`: a page load is `vi.resetModules()` plus a new import** of `session.ts`, `session-store.ts` and
  `api.ts` (decision 40). Each test gets new module state: `restoreSession` keeps its promise in the module, and
  without a reset the second "reload" in a test would return the first one's result.
- **The pretend `window` is an `EventTarget`** with a Map-backed storage. `offline-session.ts` listens to `online`
  on it, and `remembered-session.ts` reads `window.localStorage`. Only `getItem`, `setItem` and `removeItem` are there:
  the app uses nothing else, and a full `Storage` would need an `any` index signature (rule 3).
- **`document` has only what `applyTheme` touches.** `startSession` awaits `applyPreferences`, which sets the theme
  on `<html>`; without it, the sign-in tests would fail in a place that has nothing to do with step 19a.
- **`signedInOnce()` signs in through the store,** not by writing `omnivo.me` by hand: the test proves that a sign-in
  remembers the person. Only the "older version" test writes the key itself, because that is the point of the test.
- **`JSON.stringify({ ...me, preferences: undefined })`:** JSON leaves out a key whose value is `undefined`, so this
  is a `me` without the field, with no unused variable to name.
- **The 502 test also checks the refusal after it,** and then a third reload with no connection: after a refusal,
  the remembered person is gone, so no connection shows the sign-in page.
- **"one check at a time" holds the `me` answer open** after the refresh. `refreshSession` already merges refreshes
  that run at the same moment, so a test that sends two checks together passes even without the offline check's own
  guard (we tried it). The guard matters later: the refresh is over and the server rotated the cookie, but the
  check is still waiting for `me`. A second `online` there must not send the used cookie again.
- **"keeps the copy" reads the device's identity** after the refused sign-in: `readDevice` still finds the branch,
  so the next online sign-in finds the copy (decision 19).
- **The other person's id is `crypto.randomUUID()`:** the contract checks that it is a UUID, and the test only needs
  it to differ.
- **`afterEach` signs out the test's store:** an offline opening runs a one-minute timer and listens to `online`, and
  the sign-out stops both. Without it, the timers of earlier tests would keep running into later ones.

### `lib/app-update.ts`: the store for the tests

19a.4's file above already shows it: `export const updateStore`, with the comment "Exported for the tests". If you
typed 19a.4 before this part, add `export` and that comment now (decision 41). Nothing else in the app imports the
store.

### `lib/app-update.spec.ts` (new)

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Step 19a (decision 3): what the update notice says, with a pretend service worker. The browser's
// part (a changed sw.js installs and waits, SKIP_WAITING makes it take over) is tested on the real
// build in e2e/offline.pwa.ts; this file tests the app's side of it: which state follows which
// event.

// A worker of one version. The browser moves it from installing to installed (it then waits) to
// activated; each move is a statechange event.
class FakeWorker extends EventTarget {
  state = 'installing';
  readonly posted: unknown[] = [];
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  become(state: string): void {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  active: FakeWorker | null = null;
  updates = 0;
  update(): Promise<void> {
    this.updates += 1;
    return Promise.resolve();
  }
  // A new version downloads and installs; it waits while an older one runs a page
  install(): FakeWorker {
    const worker = new FakeWorker();
    this.installing = worker;
    this.dispatchEvent(new Event('updatefound'));
    this.installing = null;
    this.waiting = worker;
    worker.become('installed');
    return worker;
  }
}

interface Browser {
  registration: FakeRegistration;
  // navigator.serviceWorker: controller = the worker that runs this page (null = none)
  container: EventTarget & { controller: FakeWorker | null; register: () => Promise<unknown> };
  reload: ReturnType<typeof vi.fn>;
}

// apps/app's tests run in Node: window, navigator and document are made here, with what
// app-update.ts reads of them
function stubBrowser(options: { controlled: boolean; loaded?: boolean }): Browser {
  const registration = new FakeRegistration();
  const controller = options.controlled ? new FakeWorker() : null;
  if (controller) registration.active = controller;
  const container = Object.assign(new EventTarget(), {
    controller,
    register: vi.fn(() => Promise.resolve(registration)),
  });
  const reload = vi.fn();
  vi.stubGlobal('navigator', { serviceWorker: container });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { reload } }));
  vi.stubGlobal('document', { readyState: options.loaded === false ? 'loading' : 'complete' });
  return { registration, container, reload };
}

// The module keeps the registration and its listeners: a fresh copy for every test
async function start() {
  vi.resetModules();
  const update = await import('./app-update');
  update.startAppUpdates();
  // register() runs after an await
  await vi.advanceTimersByTimeAsync(0);
  return { ...update, state: () => update.updateStore.getState().state };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the update notice (step 19a)', () => {
  it('says nothing about the first install, then shows the next version', async () => {
    const browser = stubBrowser({ controlled: false });
    const app = await start();
    // The first worker installs and takes the page over at once (clientsClaim in sw.ts)
    const first = browser.registration.install();
    expect(app.state()).toBe('none');
    browser.registration.waiting = null;
    browser.registration.active = first;
    browser.container.controller = first;
    browser.container.dispatchEvent(new Event('controllerchange'));
    expect(app.state()).toBe('none');
    expect(browser.reload).not.toHaveBeenCalled();

    browser.registration.install();
    expect(app.state()).toBe('ready');
  });

  it('shows a version that installs while the page runs', async () => {
    const browser = stubBrowser({ controlled: true });
    const app = await start();
    expect(browser.container.register).toHaveBeenCalledWith('/sw.js');
    expect(app.state()).toBe('none');
    browser.registration.install();
    expect(app.state()).toBe('ready');
  });

  it('shows a version that was already waiting when the page loaded', async () => {
    const browser = stubBrowser({ controlled: true });
    browser.registration.waiting = new FakeWorker();
    const app = await start();
    expect(app.state()).toBe('ready');
  });

  it('registers only after the page has loaded', async () => {
    const browser = stubBrowser({ controlled: true, loaded: false });
    await start();
    expect(browser.container.register).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('load'));
    expect(browser.container.register).toHaveBeenCalledTimes(1);
  });

  it('asks the waiting version to take over on Reload, then reloads', async () => {
    const browser = stubBrowser({ controlled: true });
    const app = await start();
    const next = browser.registration.install();
    app.reloadApp();
    expect(next.posted).toEqual([{ type: 'SKIP_WAITING' }]);
    expect(app.state()).toBe('reloading');
    // Not yet: the page would load the old version's files again
    expect(browser.reload).not.toHaveBeenCalled();
    browser.container.dispatchEvent(new Event('controllerchange'));
    expect(browser.reload).toHaveBeenCalledTimes(1);
  });

  it('reloads anyway when the waiting version never takes over', async () => {
    const browser = stubBrowser({ controlled: true });
    const app = await start();
    browser.registration.install();
    app.reloadApp();
    await vi.advanceTimersByTimeAsync(4999);
    expect(browser.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(browser.reload).toHaveBeenCalledTimes(1);
  });

  it('tells a tab that another tab took the update, and its Reload is a plain reload', async () => {
    const browser = stubBrowser({ controlled: true });
    const app = await start();
    const next = browser.registration.install();
    // Another tab clicked Reload: the new version takes over every tab
    browser.registration.waiting = null;
    browser.container.controller = next;
    browser.container.dispatchEvent(new Event('controllerchange'));
    expect(app.state()).toBe('other-tab');
    expect(browser.reload).not.toHaveBeenCalled();

    app.reloadApp();
    expect(next.posted).toEqual([]);
    expect(browser.reload).toHaveBeenCalledTimes(1);
  });

  it('treats a page opened with Shift + Reload as running the old version', async () => {
    const browser = stubBrowser({ controlled: false });
    // A worker is active, but this one page loaded without it
    browser.registration.active = new FakeWorker();
    const app = await start();
    browser.container.dispatchEvent(new Event('controllerchange'));
    expect(app.state()).toBe('other-tab');
  });

  it('looks for a new version every hour and when the connection comes back', async () => {
    const browser = stubBrowser({ controlled: true });
    await start();
    expect(browser.registration.updates).toBe(0);
    window.dispatchEvent(new Event('online'));
    expect(browser.registration.updates).toBe(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(browser.registration.updates).toBe(2);
  });

  it('works on as before when the browser refuses the worker', async () => {
    const browser = stubBrowser({ controlled: false });
    browser.container.register = vi.fn(() => Promise.reject(new Error('SecurityError')));
    const app = await start();
    app.checkForUpdate();
    app.reloadApp();
    expect(browser.reload).toHaveBeenCalledTimes(1);
  });
});
```

- **`FakeRegistration.install()` plays a new version:** `updatefound` while `installing` is set, then the worker
  waits and becomes `installed`. That is the order a real browser follows, and the order `app-update.ts` listens in.
- **`stubBrowser({ controlled })`:** `controlled: false` is a first visit (no worker runs the page); `true` is a
  page that an older version runs. The first test needs both in turn: the first install takes the page over
  (`controllerchange`) and must show nothing, then the next version must show "ready".
- **Fake timers everywhere,** so the hourly check and Reload's 5-second fallback are tested to the millisecond
  (`4999` then `1`). `advanceTimersByTimeAsync(0)` in `start()` lets `register()`, which runs after an `await`,
  finish.
- **`vi.resetModules()` in `start()`:** the module keeps the registration, `hadWorker` and its listeners. A test that
  shared them with the one before would see two `controllerchange` listeners.
- **The Shift + Reload test** has a worker that is active but not in control of the page. `controllerchange` there
  is a real update, so it says "other tab". This is the `if (found.active) hadWorker = true` line.
- **"refuses the worker":** `register()` rejects (a Firefox private window). The app must work on: Reload is then a
  plain reload, and `checkForUpdate` does nothing.

### `e2e/install-and-storage.e2e.ts` (new)

```ts
import type { Locator, Page } from '@playwright/test';

import { expect, openFromNav, test, toastShown, waitForCopy } from './helpers.js';

// Step 19a: the parts of the installed app that the mock app can show. The service worker itself
// is not here: `pnpm dev:mock` never registers it (MSW's worker needs the same scope), so the
// worker, the offline reload and the update notice are tested on the real build in offline.pwa.ts.

// What the page told the browser, read back by the test
declare global {
  interface Window {
    pwaSpy?: { badges: number[]; persistCalls: number; prompted: number };
  }
}

// Runs in the page before the app (addInitScript), on every load. The badge calls do nothing in a
// browser tab, and the storage answers depend on the browser and the machine: the spy records the
// first and gives fixed answers for the second. keep = how the browser answers persist().
function spyOnBrowser(options: { keep: boolean }): void {
  const spy = { badges: [] as number[], persistCalls: 0, prompted: 0 };
  window.pwaSpy = spy;
  Object.defineProperty(navigator, 'setAppBadge', {
    configurable: true,
    value: (count?: number) => {
      spy.badges.push(count ?? 0);
      return Promise.resolve();
    },
  });
  Object.defineProperty(navigator, 'clearAppBadge', {
    configurable: true,
    value: () => {
      spy.badges.push(0);
      return Promise.resolve();
    },
  });
  let kept = false;
  navigator.storage.persisted = () => Promise.resolve(kept);
  navigator.storage.persist = () => {
    spy.persistCalls += 1;
    kept = options.keep;
    return Promise.resolve(kept);
  };
  navigator.storage.estimate = () => Promise.resolve({ usage: 24_500_000, quota: 1_234_000_000 });
}

async function openAccountMenu(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: /Farhana Rahman/ })
    .or(page.getByRole('button', { name: 'Account' }))
    .filter({ visible: true })
    .click();
}

async function start(page: Page, options = { keep: true }): Promise<void> {
  await page.addInitScript(spyOnBrowser, options);
  await page.goto('/');
  await waitForCopy(page);
}

test('the mock app has no service worker of its own (decision 11)', async ({ page }) => {
  await start(page);
  const workers = await page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistrations()).map(
      (registration) => registration.active?.scriptURL ?? '',
    ),
  );
  expect(workers.map((url) => new URL(url).pathname)).toEqual(['/mockServiceWorker.js']);
});

test('Install app shows the browser’s own prompt, once', async ({ page }) => {
  await start(page);
  // Chromium sends its prompt only to a site it finds installable; a test browser never does
  await openAccountMenu(page);
  await expect(page.getByRole('menuitem', { name: 'My devices' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Install app' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  const prevented = await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: () => {
        if (window.pwaSpy) window.pwaSpy.prompted += 1;
        return Promise.resolve();
      },
    });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  // Kept for the menu: no install bar of Chrome's own over the page's buttons
  expect(prevented).toBe(true);
  await openAccountMenu(page);
  await page.getByRole('menuitem', { name: 'Install app' }).click();
  expect(await page.evaluate(() => window.pwaSpy?.prompted)).toBe(1);

  // A prompt can be shown once: the item hides until the browser sends a new one
  await openAccountMenu(page);
  await expect(page.getByRole('menuitem', { name: 'My devices' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Install app' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await toastShown(page, 'Omnivo is installed');
});

test.describe('Safari on a Mac', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  });

  test('Install app says where Safari’s own command is', async ({ page }) => {
    await start(page);
    await openAccountMenu(page);
    await page.getByRole('menuitem', { name: 'Install app' }).click();
    const dialog = page.getByRole('dialog', { name: 'Install Omnivo' });
    await expect(dialog.getByRole('heading', { name: 'In Safari on a Mac' })).toBeVisible();
    await expect(dialog.getByRole('listitem')).toHaveText([
      'Choose File, then Add to Dock.',
      'Click Add.',
    ]);
    await dialog.getByRole('button', { name: 'Close' }).last().click();
    await expect(dialog).toHaveCount(0);
  });
});

test.describe('an iPhone', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });

  test('Install app gives the Add to Home Screen steps', async ({ page }) => {
    await start(page);
    await openAccountMenu(page);
    await page.getByRole('menuitem', { name: 'Install app' }).click();
    const dialog = page.getByRole('dialog', { name: 'Install Omnivo' });
    await expect(dialog.getByRole('heading', { name: 'On an iPhone or iPad' })).toBeVisible();
    await expect(dialog.getByRole('listitem')).toHaveText([
      'Tap Share in the toolbar.',
      'Tap Add to Home Screen.',
      'Tap Add.',
    ]);
  });
});

test('the app icon counts the changes waiting on the device', async ({ page, context }) => {
  await start(page);
  await expect.poll(() => page.evaluate(() => window.pwaSpy?.badges.at(-1))).toBe(0);

  await context.setOffline(true);
  await openFromNav(page, 'Customers');
  await page.getByRole('button', { name: 'Add customer' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Sylhet Pharmacy');
  await page.getByRole('button', { name: 'Add an address' }).click();
  await page
    .getByRole('group', { name: 'Address 1' })
    .getByLabel('Address', { exact: true })
    .fill('Zindabazar, Sylhet 3100');
  await page.getByRole('button', { name: 'Save on this device' }).click();
  await toastShown(page, 'Saved on this device. It syncs when the connection is back.');
  await expect.poll(() => page.evaluate(() => window.pwaSpy?.badges.at(-1))).toBe(1);

  // Synced: the count goes from the icon
  await context.setOffline(false);
  await expect.poll(() => page.evaluate(() => window.pwaSpy?.badges.at(-1))).toBe(0);
});

function storageCard(page: Page): Locator {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Storage on this device' }) });
}

test('the Sync page says whether the browser keeps the copy, and asks', async ({ page }) => {
  await start(page);
  await openFromNav(page, /^Sync/);
  const card = storageCard(page);
  await expect(card.getByText('May be cleared')).toBeVisible();
  await expect(card.getByText('24.5 MB used. The browser allows up to 1.2 GB.')).toBeVisible();

  await card.getByRole('button', { name: 'Ask to keep it' }).click();
  await expect(card.getByText('Kept', { exact: true })).toBeVisible();
  await expect(
    card.getByText('The browser keeps this copy, even when the device runs low on space.'),
  ).toBeVisible();
  await expect(card.getByRole('button', { name: 'Ask to keep it' })).toHaveCount(0);
});

test('a browser that says no is told to install the app', async ({ page }) => {
  await start(page, { keep: false });
  await openFromNav(page, /^Sync/);
  const card = storageCard(page);
  await card.getByRole('button', { name: 'Ask to keep it' }).click();
  await expect(
    card.getByText(
      'The browser said no. Install the app: browsers keep the data of an installed app.',
    ),
  ).toBeVisible();
  await expect(card.getByText('May be cleared')).toBeVisible();
});

test.describe('a new device', () => {
  test.use({ seedDevice: false });

  test('asks the browser to keep the copy once the branch is chosen', async ({ page }) => {
    await page.addInitScript(spyOnBrowser, { keep: true });
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: 'Which branch is this device in?' });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    expect(await page.evaluate(() => window.pwaSpy?.persistCalls)).toBe(0);
    await dialog.getByRole('combobox').selectOption({ index: 1 });
    await dialog.getByRole('button', { name: 'Use this branch' }).click();
    await expect.poll(() => page.evaluate(() => window.pwaSpy?.persistCalls)).toBe(1);
  });
});
```

- **`declare global { interface Window { pwaSpy?: … } }`** types what the init script leaves on the page, so the test
  reads `window.pwaSpy?.badges` with no cast (rule 3). It is optional because the page could load without the
  script.
- **`spyOnBrowser` replaces the badge calls and the storage answers.** In a browser tab the badge calls do nothing
  you can see, so the spy records them. The storage answers depend on the browser and on the disk, so the spy gives
  fixed ones: 24.5 MB of 1.2 GB, and `persist()` says yes or no as the test asks (`keep`).
- **No worker of ours in mock mode** (decision 11): the only registration is MSW's `mockServiceWorker.js`. If the
  app ever registered `sw.js` in `pnpm dev:mock`, the two workers would fight over the scope `/`.
- **The install prompt is a plain `Event` with a `prompt` function on it.** Chromium sends the real one only to a
  site it finds installable, and a test browser never does. `install.ts` checks the event's shape
  (`isInstallPrompt`), not its class, so this event is enough.
- **"once":** after the prompt, the item is gone until the browser sends a new one. The test opens the menu again and
  waits for "My devices" first, so `toHaveCount(0)` is checked on an open menu, not on a menu still opening.
- **Safari on a Mac, and an iPhone,** by user agent only (`test.use`): that is all `install.ts` reads, apart from
  the touch points that tell an iPad from a Mac. The steps are checked word for word, as a list.
- **The icon count goes 0 → 1 → 0:** at start, after a customer saved offline, and after the sync that sends it.
- **A new device** (`seedDevice: false`): the browser is asked to keep the copy only once the branch is chosen, not
  before (decision 36).

### The worker's own e2e suite: `e2e/playwright.pwa.config.ts`, `e2e/pwa-build.ts`, `e2e/pwa-server.ts` (new)

```ts
import { defineConfig, devices } from '@playwright/test';

// Step 19a: the service worker on a production build (pwa-build.ts builds it, pwa-server.ts
// serves it). Its own port: `pnpm test:e2e` (4173) can run at the same time.
const PORT = 4174;

export default defineConfig({
  testDir: '.',
  testMatch: '*.pwa.ts',
  globalSetup: './pwa-build.ts',
  // One test at a time: each starts and stops the server on the same port, and the update test
  // changes the built sw.js
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${String(PORT)}`,
    trace: 'retain-on-failure',
  },
  // Chromium only: the worker's code is the same on a phone, and Playwright's offline mode and
  // service worker support are Chromium's
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
});
```

- **`testMatch: '*.pwa.ts'`:** the mock suite matches `*.e2e.ts`, so the two suites never pick up each other's
  files, and vitest's default pattern matches neither.
- **`workers: 1`:** every test starts and stops the server on port 4174, and the update test changes the built
  `sw.js`. Two at a time would stop each other's server.
- **No `webServer`:** Playwright's `webServer` runs for the whole run, and these tests must stop the server half way.

```ts
import { spawnSync } from 'node:child_process';

import { APP_DIR, OUT_DIR, VITE_BIN } from './pwa-server.js';

// Step 19a: Playwright's globalSetup for *.pwa.ts, once per run: a production build of the app.
// Its API is an address where nothing answers (port 9, closed on every machine), so every request
// to the API fails at once, like no connection. Never the default localhost:3000: on a machine
// that runs `pnpm dev`, the real API would answer, and the offline tests would sign in for real.
export default function buildForTests(): void {
  const result = spawnSync(process.execPath, [VITE_BIN, 'build', '--outDir', OUT_DIR], {
    cwd: APP_DIR,
    env: { ...process.env, VITE_API_URL: 'http://127.0.0.1:9' },
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('The build for the service worker tests failed');
}
```

- **Built once per run,** before the tests, by Playwright's `globalSetup`. It skips the app's own `tsc`:
  `pnpm typecheck` covers that.
- **`VITE_API_URL: 'http://127.0.0.1:9'`** (decision 42). Port 9 is closed on every normal machine, so each API
  request fails at once, as with no connection. The default `localhost:3000` would reach a real API on a machine
  that runs `pnpm dev`, and these tests would then sign in for real.

```ts
import { type ChildProcess, spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test as base } from '@playwright/test';

export { expect } from '@playwright/test';

// Step 19a: the service worker's tests (*.pwa.ts) run on a production build, served by
// `vite preview`. The mock app cannot test it: `pnpm dev:mock` never registers the worker.

export const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
// Inside node_modules: git, ESLint and Prettier leave it alone, and `pnpm build`'s dist/ (which
// the bundle-size check reads) is never replaced by this build
export const OUT_DIR = join(APP_DIR, 'node_modules/.pwa-e2e');
// Vite's own command, started with this Node: killing it stops the server. A `pnpm exec` in
// between would be killed alone and leave the server running.
export const VITE_BIN = join(
  dirname(createRequire(import.meta.url).resolve('vite/package.json')),
  'bin/vite.js',
);

async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
}

async function until(done: () => Promise<boolean>, what: string): Promise<void> {
  for (let tries = 0; tries < 80; tries += 1) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The preview server ${what} in 20 seconds`);
}

// One server per test. A test stops it to be offline for real: Playwright's setOffline is the
// page's view, and a worker could still reach a server that runs.
class PreviewServer {
  private process: ChildProcess | null = null;
  private readonly url: string;
  private readonly worker = join(OUT_DIR, 'sw.js');
  private workerBefore: string | null = null;

  constructor(url: string) {
    this.url = url;
  }

  async start(): Promise<void> {
    // A server left from an earlier run would answer in this one's place, and could not be
    // stopped by it: the offline steps would then reach a server that runs
    if (await answers(this.url)) throw new Error(`Something already listens on ${this.url}`);
    const port = new URL(this.url).port;
    const child = spawn(
      process.execPath,
      [VITE_BIN, 'preview', '--outDir', OUT_DIR, '--port', port, '--strictPort'],
      { cwd: APP_DIR, stdio: 'ignore' },
    );
    this.process = child;
    try {
      await until(async () => {
        if (child.exitCode !== null) throw new Error('The preview server ended at its start');
        return answers(this.url);
      }, 'did not start');
    } catch (error) {
      // Never left running: the fixture's teardown does not run when its setup fails
      child.kill('SIGKILL');
      this.process = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.process) return;
    this.process.kill('SIGTERM');
    this.process = null;
    await until(async () => !(await answers(this.url)), 'did not stop');
  }

  // A new version of the app on the server: the browser compares sw.js byte by byte, so one
  // more line is a new worker. The fixture puts the file back after the test.
  publishNewWorker(): void {
    this.workerBefore ??= readFileSync(this.worker, 'utf8');
    appendFileSync(this.worker, '\n// the next version\n');
  }

  restoreWorker(): void {
    if (this.workerBefore !== null) writeFileSync(this.worker, this.workerBefore);
    this.workerBefore = null;
  }
}

// The server listens on the config's baseURL, so the tests' page.goto('/login') reaches it
export const test = base.extend<{ server: PreviewServer }>({
  server: [
    // `provide`, not Playwright's usual `use`: the React hooks lint rule reads `use(…)` as a hook
    async ({ baseURL }, provide) => {
      if (!baseURL) throw new Error('playwright.pwa.config.ts sets baseURL');
      const server = new PreviewServer(baseURL);
      await server.start();
      try {
        await provide(server);
      } finally {
        server.restoreWorker();
        await server.stop();
      }
    },
    // Its own time, apart from the test's 30 seconds: on a busy machine Vite can take a while
    // to start, and a start cut off by the test's timeout would leave the server running
    { timeout: 60_000 },
  ],
});
```

- **`node_modules/.pwa-e2e`:** git, ESLint and Prettier already ignore `node_modules`, so no ignore file changes.
  And `dist/` stays the one `pnpm build` made, which the bundle check reads.
- **Vite's own `bin/vite.js`, started with this Node.** Killing it stops the server. With `pnpm exec` in between,
  the kill would stop pnpm and leave Vite running.
- **`start()` refuses when something already answers on the port.** A server left from an earlier run would answer
  in place of this one, and `stop()` could not stop it: the "offline" steps would then reach a running server. We
  had this once while writing the tests (a start cut off by the test's timeout).
- **The `catch` in `start()` kills the child.** When a fixture's setup fails, its teardown does not run, so this is
  the only place that can stop it.
- **`{ timeout: 60_000 }` on the fixture:** its own time, apart from the test's 30 seconds. On a busy machine Vite
  can take a while to start, and a start cut off by the test's timeout is the leak above.
- **`publishNewWorker()` appends one line to `sw.js`.** The browser compares the file byte by byte, so that is a new
  version. The teardown puts the file back, so the next test starts from the version that was built.
- **The fixture reads `baseURL`:** the server listens where `page.goto('/login')` goes. It is also a real thing to
  name in the fixture's first argument, which Playwright requires and which may not be an empty pattern.

### `e2e/offline.pwa.ts` (new)

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { newDeviceId, saveDevice } from '@omnivo/sync';
import type { Locator, Page } from '@playwright/test';

import { HEAD_OFFICES, meIn, OWNER, WORKSPACES } from '../src/mocks/fixtures.js';
import { openFromNav } from './helpers.js';
import { expect, OUT_DIR, test } from './pwa-server.js';

// Step 19a: the service worker of the real build, in a real Chromium. The build's API never
// answers (pwa-build.ts), so these pages see the API as an offline device does.

const READY = 'A new version of Omnivo is ready. Save what you are working on, then reload.';
const OTHER_TAB = 'Omnivo was updated in another tab. Reload this tab to keep working.';
// Either notice of app-update.ts
const ANY = /A new version of Omnivo is ready|Omnivo was updated in another tab/;

// clientsClaim in sw.ts: the first install takes the page over without a reload
async function workerInControl(page: Page): Promise<void> {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout: 20_000,
  });
}

function updateNotice(page: Page, text: string | RegExp): Locator {
  return page.getByRole('status').filter({ hasText: text });
}

// The files the worker keeps, read from the built sw.js (the list vite-plugin-pwa put in it)
function precachedScripts(): string[] {
  const worker = readFileSync(join(OUT_DIR, 'sw.js'), 'utf8');
  return [...worker.matchAll(/"url":"(assets\/[^"]+\.js)"/g)].flatMap((match) =>
    match[1] ? [`/${match[1]}`] : [],
  );
}

test('the build opens with the server gone and no connection', async ({
  page,
  context,
  server,
}) => {
  await page.goto('/login');
  await workerInControl(page);
  const loaded = await page.evaluate(() =>
    performance.getEntriesByType('resource').map((entry) => new URL(entry.name).pathname),
  );

  await server.stop();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await expect(page.getByText("You're offline. Signing in needs a connection.")).toBeVisible();

  // A link deep into the app: the worker answers every page's address with index.html
  // (the app's own router then sends a signed-out person to the sign-in page)
  await page.goto('/sales-orders');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();

  // Decision 4: a page that was never opened online still opens offline
  const never = precachedScripts().find((path) => !loaded.includes(path));
  expect(never).toBeDefined();
  const status = await page.evaluate(async (path) => (await fetch(path)).status, never ?? '');
  expect(status).toBe(200);
});

test.describe('a device set up for Farhana Rahman', () => {
  // What an online visit leaves in this browser: the remembered `me` (step 19a) and the device
  // with its branch (step 18a). Only when nothing is there: a reload keeps what the app saved.
  test.beforeEach(async ({ page }) => {
    const [garments] = WORKSPACES;
    const saved = new Map<string, string>();
    saveDevice(
      { getItem: () => null, setItem: (key, value) => saved.set(key, value) },
      garments.tenantId,
      OWNER.id,
      { id: newDeviceId(), branchId: HEAD_OFFICES[garments.slug], later: false },
    );
    const me = meIn(garments, 'Rahman Garments Ltd.', { language: null, theme: 'system' }, 'ready');
    saved.set('omnivo.me', JSON.stringify(me));
    await page.addInitScript(
      (entries) => {
        for (const [key, value] of entries) {
          if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
        }
      },
      [...saved],
    );
  });

  test('a reload with no connection opens the app as her', async ({ page, context, server }) => {
    await page.goto('/');
    await workerInControl(page);
    await server.stop();
    await context.setOffline(true);
    await page.reload();

    await expect(
      page
        .getByRole('button', { name: /Farhana Rahman/ })
        .or(page.getByRole('button', { name: 'Account' }))
        .filter({ visible: true }),
    ).toBeVisible();
    await openFromNav(page, /^Sync/);
    await expect(
      page.getByText(
        'Omnivo opened without a connection. Your sign-in is checked once the connection is back.',
      ),
    ).toBeVisible();
  });
});

test('a new version waits for Reload, in every tab', async ({ page, context, server }) => {
  await page.goto('/login');
  await workerInControl(page);
  const other = await context.newPage();
  await other.goto('/login');
  await workerInControl(other);
  // The first install is no update: neither notice
  await expect(updateNotice(page, ANY)).toHaveCount(0);
  await expect(updateNotice(other, ANY)).toHaveCount(0);

  // The app looks for a new version when the connection comes back (and every hour)
  server.publishNewWorker();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(updateNotice(page, READY)).toBeVisible({ timeout: 15_000 });
  await expect(updateNotice(other, READY)).toBeVisible({ timeout: 15_000 });

  // The other tab reloads into the new version; this one is told it still runs the old one
  const reloaded = other.waitForEvent('load');
  await updateNotice(other, READY).getByRole('button', { name: 'Reload' }).click();
  await reloaded;
  await workerInControl(other);
  await expect(updateNotice(other, READY)).toHaveCount(0);
  await expect(updateNotice(page, OTHER_TAB)).toBeVisible({ timeout: 15_000 });
  expect(
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting),
  ).toBeFalsy();

  // Nothing waits any more: this tab's Reload is a plain reload, and the notice goes
  const reloadedToo = page.waitForEvent('load');
  await updateNotice(page, OTHER_TAB).getByRole('button', { name: 'Reload' }).click();
  await reloadedToo;
  await expect(updateNotice(page, ANY)).toHaveCount(0);
});
```

- **`workerInControl`** waits for `navigator.serviceWorker.controller`. With `clientsClaim` (19a.1) that happens on the
  first visit, without a reload; until then, the worker may not have kept every file.
- **The server is stopped and the context set offline:** the stopped server is the proof (nothing can answer), and
  `setOffline` makes `navigator.onLine` false, so the sign-in page shows its offline notice.
- **`/sales-orders`:** a page address deep in the app. Only the worker's `NavigationRoute` answers it with
  `index.html`; Workbox's precache already answers `/`. The app's router then sends a signed-out person to
  `/login`, which is why the test checks the URL.
- **A chunk never loaded online:** the test reads the list from the built `sw.js` and picks a script the page did
  not load. It loads offline with status 200 (decision 4).
- **"a device set up for Farhana Rahman" writes what an online visit leaves:** the remembered `me` and the device
  with its branch. The API never answers in this build, so a real sign-in cannot happen here; the unit tests prove
  that a sign-in remembers the person.
- **The two-tab test** is the 19a.4 script made into a test. `ANY` matches both notices, so the first install must
  show neither: a missing first-install guard shows "other tab", not "ready", and a check of "ready" alone would
  miss it.

### `package.json`, `turbo.json` and CI

```diff
@@ -8,10 +8,11 @@
     "dev:mock": "vite --mode mock",
     "build": "tsc --noEmit && vite build",
     "preview": "vite preview",
-    "typecheck": "tsc --noEmit && tsc --noEmit -p scripts && tsc --noEmit -p e2e",
+    "typecheck": "tsc --noEmit && tsc --noEmit -p scripts && tsc --noEmit -p e2e && tsc --noEmit -p sw",
     "test": "vitest run --passWithNoTests",
     "test:bundle-size": "node scripts/check-bundle-size.ts",
-    "test:e2e": "playwright test --config e2e/playwright.config.ts"
+    "test:e2e": "playwright test --config e2e/playwright.config.ts",
+    "test:e2e:pwa": "playwright test --config e2e/playwright.pwa.config.ts"
   },
   "devDependencies": {
     "@omnivo/config": "workspace:*",
```

- **The one new line here is `test:e2e:pwa`.** The `sw` type check in the same lines is 19a.1's.

```diff
@@ -19,6 +19,7 @@
     "test:integration": "turbo run test:integration",
     "test:tenant-leak": "turbo run test:tenant-leak",
     "test:e2e": "turbo run test:e2e",
+    "test:e2e:pwa": "turbo run test:e2e:pwa",
     "test:bundle-size": "turbo run test:bundle-size",
     "gen:openapi": "turbo run gen:openapi",
     "test:openapi": "turbo run test:openapi",
```

```diff
@@ -47,6 +47,10 @@
     "test:e2e": {
       "dependsOn": ["^build"],
       "cache": false
+    },
+    "test:e2e:pwa": {
+      "dependsOn": ["^build"],
+      "cache": false
     }
   }
 }
```

```diff
@@ -47,6 +47,9 @@ jobs:
       - name: E2E (Playwright on MSW mocks)
         run: pnpm test:e2e
 
+      - name: E2E (service worker on a production build)
+        run: pnpm test:e2e:pwa
+
       - name: Build
         run: pnpm build
 
```

- **`test:e2e:pwa` depends on `^build`,** like `test:e2e`: the app reads `@omnivo/ui`, `@omnivo/i18n` and the other
  packages from their `dist/`.
- **Its own CI step after the mock e2e** (decision 44). The Playwright browser is installed one step earlier.

### Check this part

```bash
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/app test
pnpm --filter @omnivo/app test:e2e install-and-storage
pnpm test:e2e:pwa
pnpm boundaries
```

All pass: 165 unit tests (21 new), the new e2e file on desktop and phone (16), and the 3 worker tests (about 12
seconds after a 2-second build).

> **What we checked in this part.** `apps/app` type-checks (all four configs), ESLint and Prettier are clean on every
> touched file, the 165 unit tests pass, the new mock e2e file passes on desktop and phone, the worker suite passes
> twice in a row through turbo and on its own, and dependency-cruiser finds no problem. Then we broke the code on
> purpose, one change at a time. With no `else if` for an offline opening in `call()`, two tests fail. With no
> pending sign-out in `logout()`, three fail. With `checking =` in place of `checking ??=`, "one check at a time"
> fails (the first version of that test did not, which is why it now holds the `me` answer open). With no
> first-install guard in `app-update.ts`, the first unit test and the two-tab e2e fail. With no `NavigationRoute` in
> `sw.ts`, the offline-reload e2e fails at the deep link. With no offline opening in `restoreSession`, "opens the app
> as her" fails. The full e2e suite runs once in 19a.6.

---

## 19a.6 — The real API, and every check once

### No other file changes

This step changes no API route, no database table and no permission, so `packages/contracts/openapi.json` stays as it
is (`pnpm test:openapi` passes without `pnpm gen:openapi`), there is no migration, and no role template changes. The
root files are 19a.5's (`package.json`, `turbo.json`, CI). The boundaries rules already cover `apps/app/sw/`:
dependency-cruiser reads every folder of `apps/app`, and the worker imports only Workbox.

### The app against the real API

The worker tests of 19a.5 run on an API that never answers, and the mock e2e has no worker. So once, the whole path
ran in a real browser (Chromium, driven by a Playwright script that is not part of the guide) against the real API:
a production build of this guide's code with `VITE_API_URL` set to the API, served by `vite preview`, the API and the
worker built from this guide's code, and a throwaway Postgres and Valkey on other ports. "No connection" meant three
things at once: the API stopped, the preview server stopped, and the browser set offline (decision 42 says why the
last alone is not enough). The script:

- signed up a pharma workspace through the API and added a customer, Rahman Traders. The browser opened
  `/customers`: the sign-up's cookie signed it in, the copy was pulled (one branch, so no branch dialog), and the
  list showed Rahman Traders. The worker controlled the page (`navigator.serviceWorker.controller`), localStorage held
  `omnivo.me`, and the Sync page's storage card showed the space used;
- went offline and loaded `/customers` again: the worker served the app, which opened as Nusrat Jahan, with Rahman
  Traders from the copy and "Offline" in the sync line. The Sync page said "Omnivo opened without a connection…";
- added a customer, Sylhet Pharmacy, with "Save on this device": "Not synced", and "1 change waiting" in the sync
  line. Then the connection came back (API, preview server, browser online): the `online` event checked the
  sign-in, the change went, and the sync line said "All changes synced" again. The notice on the Sync page was
  gone, and the API listed Sylhet Pharmacy with its number (`C-…`). A reload then was an ordinary online one;
- opened offline again, and while it was offline, ended its sign-in from "another computer" (a logout sent with the
  browser's refresh cookie, which is what a password reset or a revoke does to the session). When the connection came
  back, the check was refused: the sign-in page said "You were signed out while offline…", `omnivo.me` was gone, and
  the copy was still in IndexedDB (decision 19). Signing in again opened the same copy, with nothing asked;
- opened offline again and signed out from the account menu: the sign-in page at once, with "You're offline.
  Signing in needs a connection.", no `omnivo.me`, and `omnivo.signOutPending` set, while the browser still held the
  refresh cookie. With the connection back, a reload sent the sign-out first and stayed on the sign-in page; the mark
  was gone, and the old cookie got 401 from `/auth/refresh`. One more offline reload showed the sign-in page: nobody
  was remembered, so nothing opened (decision 25).

No error was thrown in the page. It passed 12 times in a row in its final form.

Getting there took longer, and what we saw is worth knowing. The first version of the script waited only until
the stopped API's `/health` stopped answering, then started a new API at once. In 4 of about 30 runs, the first
request after a restart (the sign-in, or the sign-out that waited) then failed in the browser with a CORS error
and `net::ERR_FAILED`. The app did what it should: the sign-in page said "Could not reach the server. Check your
connection and try again.", and the sign-out kept waiting for the next reload. The API had not crashed. Two
experiments narrowed it down. With the API never stopped (offline = the browser offline and the preview server
stopped), 12 runs out of 12 passed with no failed request. With the script waiting until the old API process had
really ended before starting the new one, 12 out of 12 passed too, and the only failed requests were the bell's
polls in flight at the moment the API was stopped. So the cause is the old process: it stops listening at once,
but it ends some time later, and while it ends it can still answer the browser's open (keep-alive) connection,
without the CORS headers. We did not trace it further: a test harness that restarts the API within a second is
not how the API runs. The same can happen during a real restart of the API, though, and the app already treats it
as no connection (decision 22). See the note for any step at the end.

### Every check once

Then run the whole checklist (at the end of this guide) once. Each part ran only its own package's checks; this is
the first time everything runs together.

All passed, with two tests that needed a second run. The machine had just restarted, and macOS was indexing
(load above 100 for the first minutes):

- `pnpm test`: the first test of `offline-session.spec.ts` timed out at Vitest's 5 seconds. It is the test that
  imports the whole session code for the first time after `vi.resetModules()`; it takes about 0.9 seconds on a quiet
  machine. A second run of the whole `pnpm test --force` passed: 681.
- `pnpm test:e2e`: 304 passed, 1 skipped, and one phone test of bills ("pays the bill oldest first…") timed out
  waiting for a click; 18c.8 saw the same test time out under load. Run alone, it passed in 23 seconds.

Everything else passed at the first run: `pnpm dedupe --check`, `pnpm format`, `pnpm lint`, `pnpm typecheck`,
`pnpm build`, `pnpm test:bundle-size` (first load 212.7 KB of 215; the worker's list 380 files, 1317.0 KB gz),
`pnpm test:openapi` (unchanged), `pnpm boundaries`, `pnpm test:integration` (553, unchanged), `pnpm
test:tenant-leak` (111, unchanged) and `pnpm test:e2e:pwa` (3, in 9 seconds).

---

## 19a.7 — Doc updates

After you implement this (ask me and I can do these):

**CLAUDE.md** — in "Components", after "Sign-out with changes waiting", add these entries. A pattern that is not
listed there does not exist for the next screen, and 19b adds the PIN screens next to them:

> - **Update notice:** `UpdateNotice` (`apps/app/src/components/update-notice.tsx`), outside the router so it stays on
>   every page. The toast's look (`ink` background, `bg` text, radius 10px, `shadow-lg`), fixed at the bottom (centered
>   on a phone, bottom-right from `sm`), `role="status"`, with a `bg`/`ink` Reload button; it never closes by itself and
>   has no close button. "A new version of Omnivo is ready. Save what you are working on, then reload." in the tab
>   that may reload; "Omnivo was updated in another tab. Reload this tab to keep working." in the others. The app
>   never reloads by itself.
> - **Install app:** an item in the account menu after My devices (`Download04`), only where the browser can
>   install: Chrome and Edge open their own prompt; Safari opens a dialog with its own steps (iPhone and iPad: Share,
>   Add to Home Screen; Mac: File, Add to Dock). Hidden in the installed app. "Omnivo is installed" is the toast.
> - **Storage card (Sync page):** the last card: "Storage on this device", a `good` "Kept" pill
>   (`CheckmarkCircle02`) or a `warn` "May be cleared" pill (`Alert02`) with "Ask to keep it" (secondary `sm`), and the
>   space used in 12px `ink-3` `tabular-nums` ("24.5 MB used. The browser allows up to 1.2 GB.").
> - **Opened offline:** a reload with no answer from the server opens the last person's copy. The Sync page then
>   shows a neutral document notice ("Omnivo opened without a connection…") until the sign-in is checked. The
>   sign-in page shows a neutral notice with `WifiDisconnected02` while the browser is offline, and "You were signed
>   out while offline…" when the check was refused.
> - **App icon badge:** the installed app's icon shows the changes waiting on the device (the sync line's count),
>   where the browser has the badge API.

In "Interaction", replace the entry "A screen that works offline" with:

> - **The service worker keeps every built script, style and woff2 font** (`apps/app/sw/sw.ts`), so every screen loads
>   offline in a production build, with nothing to list. A new kind of built file (an image a screen imports) needs
>   its extension in `globPatterns` in `vite.config.ts`; `pnpm test:bundle-size` fails while a built file is missing
>   from the worker's list. Mock mode has no worker of ours, so a screen that works offline also goes into
>   `apps/app/src/mocks/offline-screens.ts`, or the mock e2e tests that go offline cannot load it.

**docs/system-design.bn.md** — in ৭.২, replace point ১ with:

> ১. **App Shell ক্যাশ (Service Worker/Workbox):** build-এর সব JS, CSS আর woff2 ফন্ট worker আগেই রেখে দেয়
>    (precache), আর অ্যাপের প্রতিটা পাতার ঠিকানায় `index.html` দেয়, তাই নেট ছাড়াও অ্যাপ খোলে, reload-এর পরেও।
>    API-র উত্তর worker রাখে না: ডেটা IndexedDB-তে। নতুন version অপেক্ষা করে, আর "A new version is ready · Reload"
>    দেখায়; অ্যাপ নিজে কখনো reload করে না। সার্ভারের কোনো উত্তর না পেলে (নেট নেই বা 5xx) reload শেষ ব্যবহারকারীর
>    কপি খোলে, localStorage-এ রাখা `me` দিয়ে (token কখনো রাখা হয় না); কানেকশন ফিরলে sign-in যাচাই হয়।

and in ৭.৪, change the row "স্টোরেজ মুছে যাওয়া" to:

> | **স্টোরেজ মুছে যাওয়া** (ব্রাউজার ক্লিয়ার) | ডিভাইস সেট-আপের সময় `navigator.storage.persist()` চাওয়া; Sync পাতায় "Kept" / "May be cleared" আর কতটা জায়গা লাগছে; অপেক্ষায় থাকা পরিবর্তনের সংখ্যা সাইডবারে আর install করা অ্যাপের আইকনে (badge) |

**docs/build-plan.bn.md** — under "ধাপ ১৯: PWA শেল", put this before the paragraph that is there:

> **দুটো গাইডে:** ১৯a service worker + অফলাইনে খোলা, ১৯b এনক্রিপশন + PIN।
>
> - **Service worker (১৯a):** `vite-plugin-pwa` (injectManifest) + নিজের `sw/sw.ts` (Workbox), সব JS/CSS/woff2
>   precache, manifest আর আইকন, update notice (ক্লিকে reload), Install app (Chrome-এর prompt, Safari-তে নির্দেশনা),
>   `persist()` + Sync পাতায় স্টোরেজ কার্ড, আইকনে অপেক্ষার সংখ্যা। নেট ছাড়া reload শেষ ব্যবহারকারীর কপি খোলে;
>   অফলাইনে sign-out সঙ্গে সঙ্গে, সার্ভার পরে জানে। worker-এর নিজের e2e (`pnpm test:e2e:pwa`)।
> - **এনক্রিপশন + PIN (১৯b):** ডিভাইসের কপি AES-GCM-এ, চাবি সার্ভারের device key আর PIN দুটো দিয়েই খোলে;
>   অফলাইন reload-এ PIN, ৫ বার ভুল হলে অফলাইনে খোলা বন্ধ, "Lock now"।

**COMMANDS.md** — in "Checks", change the bundle-size line and add the worker suite after `test:e2e`:

```sh
pnpm test:bundle-size # build the app, then fail if first-load JS > 215 KB gz, a route chunk > 110 KB gz, or the worker's list misses a file / is over 2 MB gz
pnpm test:e2e:pwa # the service worker on a production build (Chromium): offline reload, updates — no API or Docker needed
```

and in "Run the full stack", after `pnpm dev:mock`, add:

````md
To try the service worker (only a production build has it) against the real API:

```sh
APP_ORIGIN=http://localhost:4173 pnpm turbo run dev dev:worker --filter=@omnivo/api
pnpm --filter @omnivo/app build && pnpm --filter @omnivo/app preview   # http://localhost:4173
```

`preview` is another origin than `pnpm dev` (4173, not 5173), so its worker never serves old files to the dev server;
the API must allow that origin. Clear it with DevTools → Application → Storage → Clear site data.
````

---

## 19a.8 — Run it

```bash
pnpm install          # vite-plugin-pwa and the three Workbox modules
pnpm dev              # nothing changes here: the dev server never registers the worker (decision 11)
```

No migration, no new environment variable, and the API does not change. The worker exists only in a production build,
so to see it, run the API on its own with the preview's origin allowed, and serve a build:

```bash
APP_ORIGIN=http://localhost:4173 pnpm turbo run dev dev:worker --filter=@omnivo/api
pnpm --filter @omnivo/app build && pnpm --filter @omnivo/app preview      # http://localhost:4173
```

`APP_ORIGIN` in front of the command wins over the one in `.env` (dotenv never replaces a variable that is already
set). Stop `pnpm dev` first, or the two APIs fight over port 3000.

### What you will see

1. **The worker:** open `http://localhost:4173` and sign in. DevTools → Application → Service workers shows `sw.js`
   activated; Cache storage holds about 380 files. Manifest shows Omnivo with its icons.
2. **A reload without a connection:** wait until Customers shows the list, then stop the preview server and the API
   (Ctrl+C) and turn the network off (DevTools → Network → Offline). Reload: the app opens as you, on your copy. Go
   to `/sales-orders` in the address bar: it opens too. The Sync page says "Omnivo opened without a connection".
3. **Work offline, then the connection back:** add a customer ("Save on this device"). Start the preview and the
   API again and turn the network on: within a few seconds the sync line says "All changes synced", the notice is
   gone, and the customer has its number.
4. **Signing out offline:** go offline again, reload, and sign out. The sign-in page says you're offline. Back
   online, reload: you stay signed out (the sign-out was sent first). Offline again, a reload shows the sign-in page:
   nobody is remembered.
5. **An update:** with a tab open, change any text in the app, build again (leave the preview running) and reload
   the page once: the notice "A new version of Omnivo is ready" stays at the bottom until you click Reload. With
   two tabs, the other one says "Omnivo was updated in another tab".
6. **Installing:** in Chrome or Edge the account menu has "Install app", which opens the browser's prompt; the app
   then opens in its own window, and "Install app" is gone there. In Safari on a Mac the item opens the dialog with
   "File, then Add to Dock". With a change waiting, the installed app's icon shows the number.
7. **Storage:** the Sync page's last card says "Kept" (Chrome keeps an installed app's data, and often a site you
   visit a lot) or "May be cleared" with "Ask to keep it", and the space used.
8. **Bangla** and **390px:** the notice, the dialog and the storage card fit, and no page scrolls sideways.

When you are done, clear the preview's worker (DevTools → Application → Storage → Clear site data), so the next
build starts clean.

---

## Checklist

```bash
pnpm dedupe --check
pnpm lint
pnpm format
pnpm typecheck
pnpm test                    # 681: contracts 291 + app 165 + api 123 + sync 60 + ui 19 + i18n 15 + auth 8
pnpm test:integration        # 553
pnpm test:tenant-leak        # 111
pnpm test:e2e                # 306: 153 flows × desktop and 390px (the sort test is skipped on the phone)
pnpm test:e2e:pwa            # 3: offline reload, a never-loaded screen, two tabs and an update
pnpm build
pnpm test:bundle-size        # first load 212.7 KB gz (budget 215); debit note lines 108.0 (110); the worker's list 380 files, 1317.0 KB gz (2048)
pnpm test:openapi
pnpm boundaries
```

## What we found on the way

All of these are fixed in the guide — if you get stuck at the same place, you will recognise it:

- **`pnpm dedupe --check` failed after installing the plugin** (19a.1): `workbox-build` brought older copies of a
  few Babel and browserslist packages. One `pnpm dedupe` merged them.
- **The plugin prints one warning at every build** (19a.1): `inlineDynamicImports` is deprecated in the bundler
  Vite 8 uses. It comes from the plugin's own build of `sw.ts`, not from our config, and the worker works; it goes
  away with a later plugin version.
- **A 502 during a refresh signed the person out** (19a.3): `refreshSession` turned every failure that was not a
  network error into "no session". It now throws for a 5xx, which counts as no answer (decision 22).
- **Signing out offline did not reach the server** (19a.3): the cookie stayed valid, and the next online reload
  would have signed the person in again, with the copy already deleted. The sign-out now waits in localStorage and
  goes first (decision 25).
- **The first load went over its budget** (19a.3): 211.6 KB of 210 after 19a.2's words and the session code. You
  chose 215 KB (decision 27).
- **An update would break the other open tabs** (19a.4): the new worker deletes the old version's files, so an old
  tab's next screen that was not loaded yet would fail. Only the tab that clicks reloads; the others say so
  (decision 30).
- **Seven mock e2e tests failed offline once `offline-screens.ts` was gone** (19a.4): mock mode has no worker of
  ours, so their screens' code could not load. The list moved to `src/mocks/` (decision 38).
- **A deep link in our own check did not exist** (19a.5): the 19a.1 check opened `/sales/orders`, which is
  "Not Found"; the page is `/sales-orders`. The worker answered both, so the check passed for the wrong reason. The
  e2e test uses the real one, and 19a.1's text above is corrected.
- **A test that could not fail** (19a.5): "one check at a time" passed with `checking =` in place of `checking ??=`,
  because the first check ended before the second began. It now holds the `me` answer open.
- **A preview server left running** (19a.5): when the server's start timed out, the fixture's cleanup never ran, and
  the next run found port 4174 busy. `pwa-server.ts` now refuses a busy port and kills the server on a failed start.
- **Our own browser check counted a dying API as a bug** (19a.6): requests right after a restart of the API failed
  now and then. The cause was the old API process, not the app (see "The app against the real API" above).

---

## Notes left for later steps

**Step 19b (encryption and the PIN):**

- **Anyone at the device opens the last person's copy offline** (decision 2). That is 19a's limit until 19b's PIN.
  Keep the order of the checks in `openOffline()`: the PIN comes after `hasCopy`, so a device with no copy never
  asks for one.
- **`omnivo.me` is readable in localStorage** (decision 21): the name, the workspace, the roles and the
  preferences, not the workspace's data. 19b decides whether it is encrypted with the copy; the offline opening
  needs at least the tenant and user ids before the PIN, to find the copy.
- **A device revoked while offline keeps its copy until the next sign-in** (decision 26). With 19b, the server
  stops giving the device key, so only the PIN can open it, and 5 wrong PINs turn that off.
- **The first load is at 212.7 KB of 215 KB.** 19b's PIN screen and the Web Crypto code must be lazy chunks: only
  an offline reload or the lock needs them.

**Step 20 (POS):**

- **A POS register is an installed app.** Install it ("Install app") on every till: Chrome keeps an installed app's
  data (the storage card says "Kept"), and it opens in its own window without the address bar.
- **Locking after idle time** comes with the shifts (decision 8), next to 19b's "Lock now".
- **The icon's badge counts every change waiting** (decision 35). If the POS wants "5 sales not synced" on the
  icon, that is the same count, with the sales commands in the outbox.

**Notes for any step:**

- **The host must send `sw.js` and `index.html` with `Cache-Control: no-cache`** (decision 13), when the app is
  deployed: a CDN that keeps an old `sw.js` keeps every device on the old version.
- **A new kind of file in the build must be in the worker's list.** The glob has js, css, html, svg and woff2. A PNG
  or a JSON file imported by a screen is left out with only a warning in the build log; `test:bundle-size` then
  fails and names it. Add the extension to `globPatterns`, not a list of files.
- **A screen that works offline still goes into `src/mocks/offline-screens.ts`,** for the mock e2e tests that go
  offline (decision 38). A production build does not need it.
- **A restart of the API can fail a request now and then** (19a.6): while the old process ends, it may still answer
  a browser's open connection, without the CORS headers, and the browser reports it like a lost connection. The app
  takes that as no answer (decision 22): nothing is lost, and the person can try again. When the API is deployed
  behind a proxy, let the proxy drain an instance (stop sending it requests) before it stops, so nobody sees it.
- **API answers are never cached by the worker.** A screen that should work offline reads from the device's copy
  (step 18), never from a cached response.
