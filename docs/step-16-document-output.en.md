# Step 16: Document output — PDFs, email, WhatsApp links and amounts in words

> The implementation guide for "Phase 5 → Step 16" of [build-plan.bn.md](build-plan.bn.md): which file gets what
> code, and which command runs where.
>
> Every file in this guide was placed in a separate copy of the repo (on top of commit `ac9e18c`, the end of step 15d
> and its doc updates) and checked on 2026-10-15: `pnpm dedupe --check`, `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test` (407 — 43 new), `pnpm test:integration` (350 — 19 new), `pnpm test:tenant-leak` (67 — 4 new), `pnpm build`, `pnpm test:bundle-size` (first load 197.3 KB gz, budget 200; the public page 38.8 KB, the Send menu 78.1 KB; the biggest lazy chunk is the transfer form, 99.0 KB), `pnpm gen:openapi` (151 paths), `pnpm test:openapi`, `pnpm boundaries` and `pnpm test:e2e` (Playwright, 192 — 22 new, desktop and 390px; ten phone tests timed out once while the machine was overloaded and passed when run again, see 16.8) — all pass, with the turbo cache bypassed (`--force`).
>
> Also checked:
>
> - **The database rules on their own**, in a throwaway Postgres: 59 checks of migration 0034 run as `omnivo_app`
>   with SQL the API would never send (a ready PDF changed, a sent email changed or deleted, a share link deleted,
>   six addresses in To, another workspace's rows), and a race: two requests for the same PDF at once make one row
>   (16.2). They ran again on 2026-10-15 on a database migrated from scratch.
> - **The PDFs as pictures** (16.3): an invoice of 34 lines over three pages and a money receipt, in English and
>   Bangla, turned into images and looked at. And the hard Bangla clusters (ক্ত, ন্দ্র, স্ত্র, ঙ্ক্ষ …) in four fonts
>   next to the macOS reference font; that is how Noto's ন্দ্র fault was found (decision 21).
> - **The whole flow against a real database, storage and mail server** (16.4): a PDF made by the worker job and
>   downloaded, an invoice paid and drawn again, an email read back from Mailpit with its CC, reply-to and PDF, a
>   failed email ringing the bell, a link opened and turned off, and who may send.
> - **Guards broken on purpose**: five in the API (16.4: a file of another document, a send without the permission,
>   a turned-off link that still opens, a failed file never tried again, an email without escaping) and three in the
>   app (16.7). Each was caught by exactly the test meant for it, and the code was restored after it.
>
> ⚠️ **Not checked:** (1) `pnpm dev` with your own `.env` and your own dev database: run `pnpm install` (the font)
> and `pnpm db:migrate` (0033 and 0034) first, then restart `pnpm dev`, or the worker does not know the two new
> jobs. (2) **A real mail provider**: the emails were read in Mailpit only, so how Gmail or Outlook shows "Company
> via Omnivo" and the attachment was not seen. (3) **WhatsApp on a real phone**: the tests check the `wa.me` link
> and its text, nobody tapped it in WhatsApp; WhatsApp's link preview will show only "Omnivo" (the app's own
> title), not the document. (4) **A PDF from the running app in a PDF reader**: the screens were tested against the
> mock API, which hands back a stand-in file; the real PDFs were checked by the API tests (pages, text) and as
> pictures of sample models (16.3). Please download one invoice in each language and print it once. (5) The Bangla texts and the Bangla amount in words were
> written by me, not reviewed by a native speaker or an accountant. (6) The new tests on GitHub Actions.

## Goal

📄 **A document leaves the building.** Step 15 made quotations, invoices, money receipts and credit notes, and the
browser could print them. But a customer in Chattogram does not stand next to your printer. Today an accountant
prints to PDF, saves it, finds the customer's email, attaches the file, and writes the same three lines every time;
or takes a phone photo of the paper and sends it on WhatsApp. This step does that work in one click, in the
customer's language.

After this step:

- **Download PDF** on a quotation, an invoice, a money receipt and a credit note. The worker draws the PDF (with
  Bangla text shaped correctly) and keeps it in storage. The next download is instant; a new file is drawn only when
  the document has changed (an invoice that got paid says "Paid").
- **Email**: a dialog with the customer's address already filled in, CC, a subject and a message you can change, in
  English or Bangla. The PDF goes as an attachment, from "Your company via Omnivo", and replies go to your company's
  own email. The document shows every email it was sent in; a failed one rings the bell.
- **Share on WhatsApp**: a short link (`app.omnivo.app/d/…`) that opens without a login, shows what the document is
  and from whom, and downloads the PDF. WhatsApp opens with the message ready, to the customer's number. A link works
  for 30 days and can be turned off.
- **Amount in words** under the total of every money document, on paper and in the PDF: "Eighteen lakh forty-two
  thousand six hundred taka and fifty paisa only" / "আঠারো লক্ষ বিয়াল্লিশ হাজার ছয়শত টাকা পঞ্চাশ পয়সা মাত্র".
- **A customer's document language** (English or Bangla) on the customer form. Every PDF, email and link for that
  customer starts in it.

## The whole picture

```
packages/contracts   amount-words.ts (new): English (lakh, crore) and Bangla, for the five currencies
      │               document-output.ts (new): OUTPUT_DOCUMENTS (quotation, invoice, receipt, credit_note)
      │               SEND_PERMISSIONS · the PDF, email, share link and public page shapes · SHARE_LINK_DAYS 30
      │               whatsAppNumber() · whatsAppUrl() · customer documentLanguage · 5 errors
      │               bell type document.email_failed · 8 routes under /documents/:kind/:id + 1 public route
      ▼
packages/db          document_files (one row per look: document, language, fingerprint, the page as text)
                     document_emails · document_shares (only the token's hash) · parties.document_language
                     0033 (drizzle) · 0034 (RLS, the policy that finds a link by its hash, what may change)
      │
      ▼
apps/api             pdf/text.ts (shared with step 11's exports: Geist + Hind Siliguri) · documents/: the model,
                     the words, the builder, the drawing · DocumentOutputService (8 routes)
                     PublicDocumentsService · worker: document.file_requested (jobs queue),
                     document.email_requested (email queue) · mail: CC, attachments, sender name, reply-to
      │
      ▼
apps/app             Send menu, email dialog, share dialog, Emails and Share links cards on 4 document pages
                     /d/$token public page (no login, no app shell) · customer form: Document language
                     the bell opens the document · print: amount in words · packages/i18n: the words
                     MSW: the same rules · Playwright: download, email, share, public page

one invoice, emailed in Bangla:
  Send → Email ──GET /documents/invoice/{id}/email-draft?language=bn──► To, subject and message, in Bangla
  Send email ──POST /documents/invoice/{id}/emails──► API, one transaction:
     invoice numbered? · sales.invoice.manage? · build the model (every word and number, in Bangla) → fingerprint
     document_files: insert … on conflict do nothing (two clicks share one row) · document_emails row, pending
     outbox: document.email_requested
  worker (email queue): the file is ready? read it from storage : draw it, store it, mark it ready
     send: From "Company via Omnivo", Reply-To the company's email, the PDF attached · email row → sent
     still failing after its retries → failed + the bell: "Invoice INV-… couldn't be emailed"
  Emails card: Sending → Sent (it asks again every 3 seconds while one is sending)

one share link, opened by the customer:
  Share on WhatsApp ──POST …/shares──► 22-character token, only its hash stored · the PDF asked for at once
     dialog: the link, the message, "Open WhatsApp" (wa.me/8801…?text=…)
  customer taps app.omnivo.app/d/<token> ──GET /public/documents/<token>──► find the row by hash
     ended, turned off, unknown, the document gone = the same 404 · first/last opened written
     number, date, total, what is still due · Download PDF (a signed storage link)
```

## Not in this step, on purpose

| What | Why not now / when |
|---|---|
| Mushak 6.3 and 6.7 (the VAT forms) | The VAT compliance step of the build plan. The model of a page (16.3) can draw them: a new kind and its builder |
| PDFs of an order, a challan, a return and a refund | Decision 2: they stay with the browser's Print. One more is a kind in `OUTPUT_DOCUMENTS`, its permission in `SEND_PERMISSIONS` and a builder in `models.service.ts` |
| WhatsApp Business API, SMS | Decision 3: the person sends the link from their own WhatsApp. The Business API needs a Meta business account and paid message templates |
| Sending many invoices at once, statements, overdue reminders | Later (collections). Today one document goes in one email |
| Deleting old PDFs from storage | Later. A PDF whose document changed stays in storage and in `document_files`; a cleanup job can remove older looks |
| A rate limit on the public route | Decision 27: one step for every public route, login too |
| Payment buttons on the public page (bKash, SSLCommerz) | With online payment |
| Knowing that an email was opened or bounced | Later. "Sent" means the mail server took it; a bounce comes back to the company's own inbox (reply-to) |
| A customer portal (all of a customer's documents behind one login) | Later. A link shows one document |

## What changes in the code you already have

- **One package swaps in `apps/api`:** `@fontsource/hind-siliguri` comes in and `@fontsource/noto-sans-bengali`
  goes out (decision 21). The app keeps Noto for the screens. No new `.env` line: the link uses `APP_ORIGIN`, the
  files go to the storage bucket of step 11, the email to the mail server of step 8. No new database role, no new
  permission.
- **Two new worker jobs:** `document.file_requested` (the jobs queue, like the report exports) and
  `document.email_requested` (the email queue). A worker started before this step does not know them, so restart
  `pnpm dev`.
- **`pnpm db:migrate`** adds three tables (0033) and their rules (0034), and `parties.document_language`, which is
  `'en'` for every customer you already have.
- **Contracts:** the customer has `documentLanguage`, and the customer form must send it. Every place that makes a
  customer changes with it: the app's customer form, the MSW customers, and five older API test files (16.4).
- **Step 11's report PDF:** its text helpers moved to `apps/api/src/pdf/text.ts`, and its Bangla is drawn with Hind
  Siliguri. An export looks the same as before, except that ন্দ্র is now drawn correctly.
- **Mail:** `MailService` can send to several addresses, with CC, a sender name, a reply-to address and attachments;
  the layout's button is optional and a message keeps its line breaks. The welcome and invitation emails do not
  change. `testing/mailpit.ts` also reads CC, reply-to and attachments.
- **app:** the bell opens the document of a failed email; `setLanguage` in `@omnivo/i18n` can change the language
  for one tab only (the public page); the eight sales lists load their customer filter lazily and the stock
  adjustment form its date picker (decision 37); the printed invoice, receipt, credit note and refund say the
  amount in words.
- **Existing tests that change:** the contracts' customer test and five API sales test files send
  `documentLanguage`; `customers.int.spec.ts` gets one test for it; the MSW customers have it, two of them in Bangla.

## The decisions behind this step

You made the first eight on 2026-10-12. The others came up while building it; please read them with care: they are
mine.

1. **pdfkit draws the PDF, in the worker.** (You chose this.) It is already there for step 11's report exports, with
   Geist and Noto Sans Bengali. The browser's Print stays for paper. The price is a second layout to keep in step
   with the printed one; headless Chrome would have reused the printed page, but it adds about 300 MB to the worker
   and a browser process to look after.
2. **Four documents go out:** quotation, invoice, money receipt, credit note. (You chose this.) An order, a challan,
   a return and a refund stay with the browser's Print.
3. **A share link is a token on a public page.** (You chose this.) The page needs no login, shows the document's
   number, date and total, and downloads the PDF. A link works for 30 days and can be turned off.
4. **The language is the customer's.** (You chose this.) A customer has a document language (English by default).
   The person sending can pick the other one each time. The amount in words follows it.
5. **A PDF is made when it is first needed, then kept.** (You chose this.) The first download, email or link opening
   asks the worker for it. A later request gets the same file, unless the document or the company's header changed.
   The page waits a few seconds for a new file and then opens it; nothing goes through the bell.
6. **An email is written in a dialog.** (You chose this.) To, CC, subject and message can be changed. From
   "Company via Omnivo", reply-to the company's email. Sent emails are listed on the document; a failure rings the
   bell.
7. **Amount in words on every money document,** in the PDF and on paper: invoice, money receipt, credit note,
   refund. (You chose this.)
8. **One guide, made like 15a–15d.** (You chose this.)

**The contract (16.1):**

9. **One path for the four documents:** `/documents/:kind/:id/…`, where `kind` is `quotation`, `invoice`, `receipt`
   or `credit_note`. Eight routes instead of thirty-two. The price: a route can name only one permission, so the
   send permission is checked by the API (`SEND_PERMISSIONS`), not by the route's guard.
10. **Downloading needs no permission; sending needs the document's own.** Everyone in the workspace may open an
    invoice (`GET /invoices/:id` has no permission), so they may download its PDF. Sending it to someone outside the
    company (an email, a link) needs the permission that makes it: `sales.invoice.manage` for an invoice. No new
    permission.
11. **Only a numbered document goes out** (`document_not_issued`): not a draft invoice or credit note (a draft on
    paper looks real, the same rule as Print in 15c), and not a voided receipt.
12. **The server writes every word the customer reads:** the PDF, the email's first subject and message, and the
    WhatsApp text, in the customer's language, from one dictionary in the API (like step 11's exports). The app's
    own words (buttons, labels) stay in `en.ts` and `bn.ts`. So a person whose screen is in English can still send
    a Bangla invoice, and the app never has to load the second language to do it.
13. **A share link is shown once.** Its token is 128 random bits, and the database keeps only its hash (like an
    invitation). Each "Share" makes a new link; old links keep working until they end or are turned off. The list
    shows when the customer first and last opened each one.
14. **An unknown, ended or turned-off link look the same** (`share_link_not_found`): the public page says the link
    no longer works, and tells a stranger nothing about the company.
15. **To and CC are one text box each,** up to five addresses, separated by commas, semicolons or spaces, the way
    people paste them. One error per box.
16. **Amounts in words use lakh and crore,** in sentence case, rounded half up at the paisa. Above 99 crore the
    crores are counted in words ("one hundred twenty crore"). All five currencies of the settings have their names.
17. **The WhatsApp number is read from the customer's phone:** a Bangladeshi mobile number as people write it
    (`01711-000000`) or an international one (`+44 …`, `0044 …`). Anything else (a land line) opens WhatsApp without
    a number, and the person picks the contact.

**The database (16.2):**

18. **One stored PDF per look of a document.** A look is everything the PDF shows: the document, the company's
    header, every word in the language and the layout's version. The row keeps the look itself (the model) and its
    hash (the fingerprint), which is part of the row's key. The worker draws exactly the stored model. So the same
    look is drawn once, a paid invoice gets a new file, and an invoice that goes back to unpaid (a bounced cheque)
    finds its old file again, because it looks exactly as it did.
19. **After a failure, the same row is tried again.** A new request sets a failed row back to pending and starts a
    new job. A table of failed attempts would tell nobody anything the worker's log does not.
20. **Emails and share links are history.** The database refuses to delete them or to change what they said. A sent
    email is a fact about what the customer was told; a link that was turned off stays off. PDFs can be deleted: they
    are a cache, and a later step can clean old ones out of storage.

**The API (16.3):**

21. **Bangla in a PDF uses Hind Siliguri, not Noto Sans Bengali.** (You chose this on 2026-10-14.) pdfkit shapes
    Bangla with fontkit, not with a browser's HarfBuzz. With Noto, fontkit draws ন্দ্র (কেন্দ্র, চন্দ্র, রবীন্দ্র,
    মহেন্দ্র) with the ra-phala loose beside the letters. Step 11's Bangla report exports have the same fault, and this
    change fixes them too. Hind Siliguri (free, OFL, from the same @fontsource family) builds its conjuncts as whole
    glyphs, and every cluster we tried came out like the macOS reference font. The app's screens keep Noto Sans
    Bengali: the browser shapes it correctly.
22. **The API writes the page; the worker only draws it.** The API reads the document with the same `get()` its own
    page uses, and turns it into a model: every word and number, already in the language. The row keeps that model
    (16.2), and the worker draws exactly it. The other way, the worker reading the invoice itself, would need the
    sales services in the worker, and they bring the journal, the stock posting and the Redis permission cache with
    them. It would also let a file disagree with its fingerprint when the invoice changed in between.
23. **A PDF has no "printed on" date.** The browser print shows when it was printed. A PDF with today's date would be
    a new look every day, so the stored file would never be reused, and the same invoice would be drawn again each
    morning.
24. **An email draws its own PDF when needed.** It does not wait for the file job: that one is in the other queue,
    perhaps behind a big product import. Both jobs may draw the same file at the same moment; they write the same
    object, and the database lets only one of them mark it ready.
25. **Making a share link asks for the PDF at once,** so it is usually ready by the time the customer taps the link.
26. **Sending is not written to the audit log.** The emails and the links are history tables that cannot change
    (decision 20), with who and when. An audit row would say the same thing a second time.
27. **The public route has no rate limit in this step.** The API has none anywhere yet. A token is 128 random bits,
    checked for its shape before the database is asked, so guessing is hopeless; a limit for all public routes
    (login too) is a step of its own.

**The words and the screens (16.5):**

28. **Sharing opens a dialog, not WhatsApp straight away.** The server makes the link, so WhatsApp could open only
    after that request comes back. Safari and Firefox block a window opened that late, because it no longer counts as
    the person's click. The dialog shows the link and the message, and "Open WhatsApp" is a real link the person
    clicks. The dialog also gives "Copy message", for a customer on Messenger or IMO, or for an SMS.
29. **One "Send" menu on the document page,** next to Print: Download PDF (in the customer's language), Download PDF
    in the other language, Email, and Share on WhatsApp. The page header already holds Print and the document's own
    actions (Record payment, Write credit note); three more buttons would wrap even on a laptop. Someone without the
    send permission sees a single "Download PDF" button instead of the menu.
30. **Changing the language in the email dialog writes the subject and the message again,** from the server's draft
    in that language. A half-English message under a Bangla PDF is worse than losing an edit, and the field's hint
    says so before it happens.
31. **Turning a link off asks first.** It cannot be undone (decision 20).
32. **A language is shown by its own name** ("English", "বাংলা"), from `LANGUAGES` in `@omnivo/i18n`, as the language
    switch does. Someone who reads only Bangla still finds "বাংলা" on an English screen.

**The screens (16.6):**

33. **A download waits about 20 seconds, then gives up.** The page asks for the file every 1.5 seconds, 13 times. A
    PDF is usually ready in one or two seconds; if the worker is still busy after 20, the page says "try again in a
    minute" instead of spinning. The next click finds the same row (decision 18), often ready by then.
34. **The public page speaks the link's language, and only in that tab.** It has no language switch: the PDF is in
    the language the sender chose, and a page in another language than its PDF would be confusing. It does not save
    the language either, so a sender who opens their own link to check it keeps their app in their language.
35. **On paper, the amount in words follows the screen's language; in the PDF, the customer's.** The browser's
    Print prints the page you are reading, in your language, like every other word on it. The PDF is what the
    customer gets, so it follows the customer (decision 4).
36. **The email history refreshes itself while an email is sending,** every 3 seconds, and stops once none is. So
    "Sending" turns into "Sent" without a reload, and a page left open does not keep asking.
37. **The eight sales lists load their customer filter a moment after the page,** and the stock adjustment form its
    date picker. This step's code took four lists and that form just over their 100 KB budget. For that moment the
    box is there, disabled. The forms already load the same picker this way.

---

## 16.1 — `packages/contracts`: the contract

The contract comes first, as in every step. Two new files hold what step 16 adds: `amount-words.ts` (an amount
written out in words) and `document-output.ts` (the PDF, the email and the share link). The rest are small changes:
the customer gets a document language, and there are new error codes, a new notification and two new route groups.

### `amount-words.ts` (new)

```ts
import type { LanguageCode } from './preferences.js';
import type { Currency } from './settings.js';

// An amount written out in words, as a Bangladeshi invoice, money receipt or cheque says it under
// the total: "Eighteen lakh forty-two thousand six hundred taka and fifty paisa only" /
// "আঠারো লক্ষ বিয়াল্লিশ হাজার ছয়শত টাকা পঞ্চাশ পয়সা মাত্র" (step 16). Here in contracts, so the
// worker's PDF and the browser's print show the same words.

// Lakh and crore, not million: 18,42,600 is "eighteen lakh ...", never "one million eight hundred ..."
const CRORE = 10_000_000n;
const LAKH = 100_000n;
const THOUSAND = 1_000n;
const HUNDRED = 100n;

const EN_ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
] as const;

const EN_TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
] as const;

// Bangla has its own word for every number below 100 (৪২ is "বিয়াল্লিশ", not "চল্লিশ দুই"), so
// there is no tens-and-ones rule to follow: the words are a list, read by index.
const BN_UNDER_100 = [
  'শূন্য',
  'এক',
  'দুই',
  'তিন',
  'চার',
  'পাঁচ',
  'ছয়',
  'সাত',
  'আট',
  'নয়',
  'দশ',
  'এগারো',
  'বারো',
  'তেরো',
  'চৌদ্দ',
  'পনেরো',
  'ষোলো',
  'সতেরো',
  'আঠারো',
  'উনিশ',
  'বিশ',
  'একুশ',
  'বাইশ',
  'তেইশ',
  'চব্বিশ',
  'পঁচিশ',
  'ছাব্বিশ',
  'সাতাশ',
  'আটাশ',
  'ঊনত্রিশ',
  'ত্রিশ',
  'একত্রিশ',
  'বত্রিশ',
  'তেত্রিশ',
  'চৌত্রিশ',
  'পঁয়ত্রিশ',
  'ছত্রিশ',
  'সাঁইত্রিশ',
  'আটত্রিশ',
  'ঊনচল্লিশ',
  'চল্লিশ',
  'একচল্লিশ',
  'বিয়াল্লিশ',
  'তেতাল্লিশ',
  'চুয়াল্লিশ',
  'পঁয়তাল্লিশ',
  'ছেচল্লিশ',
  'সাতচল্লিশ',
  'আটচল্লিশ',
  'ঊনপঞ্চাশ',
  'পঞ্চাশ',
  'একান্ন',
  'বাহান্ন',
  'তিপ্পান্ন',
  'চুয়ান্ন',
  'পঞ্চান্ন',
  'ছাপ্পান্ন',
  'সাতান্ন',
  'আটান্ন',
  'ঊনষাট',
  'ষাট',
  'একষট্টি',
  'বাষট্টি',
  'তেষট্টি',
  'চৌষট্টি',
  'পঁয়ষট্টি',
  'ছেষট্টি',
  'সাতষট্টি',
  'আটষট্টি',
  'ঊনসত্তর',
  'সত্তর',
  'একাত্তর',
  'বাহাত্তর',
  'তিয়াত্তর',
  'চুয়াত্তর',
  'পঁচাত্তর',
  'ছিয়াত্তর',
  'সাতাত্তর',
  'আটাত্তর',
  'ঊনআশি',
  'আশি',
  'একাশি',
  'বিরাশি',
  'তিরাশি',
  'চুরাশি',
  'পঁচাশি',
  'ছিয়াশি',
  'সাতাশি',
  'অষ্টাশি',
  'ঊননব্বই',
  'নব্বই',
  'একানব্বই',
  'বিরানব্বই',
  'তিরানব্বই',
  'চুরানব্বই',
  'পঁচানব্বই',
  'ছিয়ানব্বই',
  'সাতানব্বই',
  'আটানব্বই',
  'নিরানব্বই',
] as const;

interface Scale {
  under100: (n: number) => string;
  // "six hundred" / "ছয়শত": Bangla writes the hundred as one word with its digit
  hundreds: (digit: number) => string;
  thousand: string;
  lakh: string;
  crore: string;
}

// Every index below is 0–99 (or 1–9 for the hundreds) by the arithmetic that makes it, so the
// lookups cannot miss; the `?? ''` only satisfies noUncheckedIndexedAccess.
const SCALES = {
  en: {
    under100: (n) => {
      if (n < 20) return EN_ONES[n] ?? '';
      const ones = n % 10;
      const tens = EN_TENS[Math.floor(n / 10)] ?? '';
      return ones === 0 ? tens : `${tens}-${EN_ONES[ones] ?? ''}`;
    },
    hundreds: (digit) => `${EN_ONES[digit] ?? ''} hundred`,
    thousand: 'thousand',
    lakh: 'lakh',
    crore: 'crore',
  },
  bn: {
    under100: (n) => BN_UNDER_100[n] ?? '',
    hundreds: (digit) => `${BN_UNDER_100[digit] ?? ''}শত`,
    thousand: 'হাজার',
    lakh: 'লক্ষ',
    crore: 'কোটি',
  },
} satisfies Record<LanguageCode, Scale>;

// A whole number in words, Indian grouping: crore, lakh, thousand, hundred, then the rest. Above
// 99 crore the crores are themselves a number in words ("one hundred twenty crore"), the way a
// bank writes it. No "and" inside the number: the one "and" in the sentence is before the paisa.
function wholeInWords(n: bigint, scale: Scale): string {
  if (n === 0n) return scale.under100(0);
  const parts: string[] = [];
  const crores = n / CRORE;
  if (crores > 0n) parts.push(`${wholeInWords(crores, scale)} ${scale.crore}`);
  const lakhs = Number((n % CRORE) / LAKH);
  if (lakhs > 0) parts.push(`${scale.under100(lakhs)} ${scale.lakh}`);
  const thousands = Number((n % LAKH) / THOUSAND);
  if (thousands > 0) parts.push(`${scale.under100(thousands)} ${scale.thousand}`);
  const hundreds = Number((n % THOUSAND) / HUNDRED);
  if (hundreds > 0) parts.push(scale.hundreds(hundreds));
  const rest = Number(n % HUNDRED);
  if (rest > 0) parts.push(scale.under100(rest));
  return parts.join(' ');
}

// The money's two names in each language. English counts them (one dollar, two dollars); taka and
// paisa are the same for one and many, and Bangla never changes a noun for a number.
interface Units {
  major: readonly [one: string, many: string];
  minor: readonly [one: string, many: string];
}

const UNITS = {
  en: {
    BDT: { major: ['taka', 'taka'], minor: ['paisa', 'paisa'] },
    USD: { major: ['dollar', 'dollars'], minor: ['cent', 'cents'] },
    EUR: { major: ['euro', 'euros'], minor: ['cent', 'cents'] },
    GBP: { major: ['pound', 'pounds'], minor: ['penny', 'pence'] },
    INR: { major: ['rupee', 'rupees'], minor: ['paisa', 'paise'] },
  },
  bn: {
    BDT: { major: ['টাকা', 'টাকা'], minor: ['পয়সা', 'পয়সা'] },
    USD: { major: ['ডলার', 'ডলার'], minor: ['সেন্ট', 'সেন্ট'] },
    EUR: { major: ['ইউরো', 'ইউরো'], minor: ['সেন্ট', 'সেন্ট'] },
    GBP: { major: ['পাউন্ড', 'পাউন্ড'], minor: ['পেনি', 'পেন্স'] },
    INR: { major: ['রুপি', 'রুপি'], minor: ['পয়সা', 'পয়সা'] },
  },
} satisfies Record<LanguageCode, Record<Currency, Units>>;

function unit(names: readonly [string, string], count: bigint): string {
  return count === 1n ? names[0] : names[1];
}

// A decimal string with any number of decimals (the database sends NUMERIC(19,4) as "18450.5000").
// No minus sign: every amount a document prints in words (a total, a receipt) is zero or more,
// so a negative one is a bug to see, not a sentence to write.
const AMOUNT = /^(\d+)(?:\.(\d+))?$/;

// The amount in paisa, rounded half up at the second decimal like every printed amount
// ("10.005" → 1001 paisa). BigInt, never a JavaScript number: 15 digits of taka do not fit a double
// exactly.
function toPaisa(amount: string): bigint {
  const match = AMOUNT.exec(amount.trim());
  const whole = match?.[1];
  if (match === null || whole === undefined) {
    throw new Error(`Not a non-negative amount: "${amount}"`);
  }
  const fraction = match[2] ?? '';
  const paisa = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, '0'));
  // The third decimal decides the rounding; the ones after it cannot change a half-up result
  return Number(fraction.charAt(2) || '0') >= 5 ? paisa + 1n : paisa;
}

export function amountInWords(amount: string, language: LanguageCode, currency: Currency): string {
  const paisa = toPaisa(amount);
  const whole = paisa / 100n;
  const cents = paisa % 100n;
  const scale = SCALES[language];
  const names = UNITS[language][currency];
  const major = `${wholeInWords(whole, scale)} ${unit(names.major, whole)}`;
  const minor = `${wholeInWords(cents, scale)} ${unit(names.minor, cents)}`;
  if (language === 'bn') {
    // "পঞ্চাশ পয়সা মাত্র" when there is no whole taka; "শূন্য টাকা মাত্র" for nothing at all
    const words = whole === 0n && cents > 0n ? minor : cents === 0n ? major : `${major} ${minor}`;
    return `${words} মাত্র`;
  }
  const words = whole === 0n && cents > 0n ? minor : cents === 0n ? major : `${major} and ${minor}`;
  // Sentence case (CLAUDE.md → Copy): only the first letter is a capital
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} only`;
}
```

- **Here, not in the API.** The worker's PDF and the browser's Print must show the same words for the same amount.
  If each had its own copy, a fix to one (a spelling in Bangla) would leave the other wrong. `@omnivo/contracts` is
  the package both already load, and this file needs nothing but plain TypeScript.
- **Lakh and crore, never million.** `18,42,600` is "eighteen lakh forty-two thousand six hundred". That is how a
  Bangladeshi invoice, cheque and bank slip write it; "one million eight hundred forty-two thousand" would look
  foreign on paper.
- **`BN_UNDER_100` is a list of 100 words.** English builds 42 from "forty" and "two". Bangla does not: 42 is
  "বিয়াল্লিশ", one word you cannot build from "চল্লিশ" and "দুই". So the only correct way is a table, read by
  index. The spellings are the common printed ones ("ঊনত্রিশ" with ঊ); a native speaker should read the list once
  (see "Not checked" at the top).
- **`hundreds` is a function per language.** English writes "six hundred", two words. Bangla writes "ছয়শত", one
  word, the digit and "শত" joined. The formal "শত" is used, not the spoken "শো", because this text is printed on
  a financial document.
- **`wholeInWords` calls itself for the crores.** An amount of 120 crore is "one hundred twenty crore", the way a
  bank writes it. Without the recursion, anything above 99 crore would index past the end of the 0–99 table.
- **No "and" inside the number.** "One lakh five taka", not "one lakh and five taka". The only "and" in the sentence
  sits before the paisa ("… taka and fifty paisa only"), so a reader can see at once where the taka end.
- **`UNITS` has a one and a many.** English says "one dollar" but "two dollars". "Taka" and "paisa" are the same for
  one and many, and Bangla never changes a noun for a number, so their two names are the same word. `satisfies
  Record<LanguageCode, Record<Currency, Units>>` makes a sixth currency in `settings.ts` a type error here until it
  has its words.
- **`toPaisa` works in BigInt and rounds half up.** The rule is CLAUDE.md's: money is never a JavaScript `number`.
  A 15-digit amount does not fit a double exactly, and `0.1 + 0.2` problems would print the wrong paisa. The
  database sends 4 decimals ("10.0050"), and paper shows 2, so the third decimal decides the rounding, like every
  other printed amount. The fourth decimal cannot change a half-up result once the third is known, so it is ignored.
- **A negative amount throws.** Every amount a document writes in words (a total, a receipt's amount) is zero or
  more; the database checks this. A negative one would be a bug, and an error in the worker's log is better than a
  PDF that says "minus fifty taka" to a customer.
- **The Bangla sentence has no "ও"** ("… টাকা পঞ্চাশ পয়সা মাত্র"). This is how most Bangladeshi cheques and receipts
  write it. "মাত্র" closes the sentence like "only" does, so nobody can add words after it.
- **Sentence case in English.** CLAUDE.md asks for sentence case everywhere. Old invoices often use Title Case
  ("Taka Eighteen Lakh …"), but sentence case reads the same and matches the rest of the PDF.

```ts
import { describe, expect, it } from 'vitest';

import { amountInWords } from './amount-words.js';

describe('amountInWords (English)', () => {
  it('uses lakh and crore, not million', () => {
    expect(amountInWords('1842600.5000', 'en', 'BDT')).toBe(
      'Eighteen lakh forty-two thousand six hundred taka and fifty paisa only',
    );
    expect(amountInWords('25000000', 'en', 'BDT')).toBe('Two crore fifty lakh taka only');
  });

  it('writes the crores as a number of their own above 99 crore', () => {
    expect(amountInWords('1200000000', 'en', 'BDT')).toBe('One hundred twenty crore taka only');
  });

  it('skips the empty groups', () => {
    expect(amountInWords('100005', 'en', 'BDT')).toBe('One lakh five taka only');
    expect(amountInWords('62100.00', 'en', 'BDT')).toBe('Sixty-two thousand one hundred taka only');
  });

  it('says only the paisa when there is no whole taka, and zero for nothing', () => {
    expect(amountInWords('0.75', 'en', 'BDT')).toBe('Seventy-five paisa only');
    expect(amountInWords('0.0000', 'en', 'BDT')).toBe('Zero taka only');
  });

  it('rounds half up at the paisa', () => {
    expect(amountInWords('10.005', 'en', 'BDT')).toBe('Ten taka and one paisa only');
    expect(amountInWords('10.0049', 'en', 'BDT')).toBe('Ten taka only');
    expect(amountInWords('99.995', 'en', 'BDT')).toBe('One hundred taka only');
  });

  it('counts the units of other currencies', () => {
    expect(amountInWords('1.01', 'en', 'USD')).toBe('One dollar and one cent only');
    expect(amountInWords('2.50', 'en', 'GBP')).toBe('Two pounds and fifty pence only');
  });
});

describe('amountInWords (Bangla)', () => {
  it('uses the Bangla word of every number below 100', () => {
    expect(amountInWords('1842600.50', 'bn', 'BDT')).toBe(
      'আঠারো লক্ষ বিয়াল্লিশ হাজার ছয়শত টাকা পঞ্চাশ পয়সা মাত্র',
    );
    expect(amountInWords('99', 'bn', 'BDT')).toBe('নিরানব্বই টাকা মাত্র');
  });

  it('writes the crores and the zero amount', () => {
    expect(amountInWords('1200000000', 'bn', 'BDT')).toBe('একশত বিশ কোটি টাকা মাত্র');
    expect(amountInWords('0', 'bn', 'BDT')).toBe('শূন্য টাকা মাত্র');
    expect(amountInWords('0.25', 'bn', 'BDT')).toBe('পঁচিশ পয়সা মাত্র');
  });
});

describe('amountInWords (bad input)', () => {
  it('refuses a negative or broken amount instead of writing wrong words', () => {
    expect(() => amountInWords('-5', 'en', 'BDT')).toThrow();
    expect(() => amountInWords('1,000', 'en', 'BDT')).toThrow();
    expect(() => amountInWords('', 'en', 'BDT')).toThrow();
  });
});
```

- The tests use the examples from the design system (`৳18,42,600`) and the edge cases that are easy to get
  wrong: an empty group (`1,00,005` must not say "zero thousand"), no whole taka (`0.75`), rounding that
  carries into the taka (`99.995` → "one hundred taka"), and a number above 99 crore.

### `document-output.ts` (new)

```ts
import { z } from 'zod';

import { signedUrlSchema } from './attachments.js';
import { errorCode } from './errors.js';
import { defineRoute } from './http.js';
import type { PermissionKey } from './permissions.js';
import { LANGUAGE_CODES } from './preferences.js';
import { CURRENCIES } from './settings.js';

// Step 16: a document goes out to the customer as a PDF — downloaded, attached to an email, or
// behind a share link that opens without a login (sent on WhatsApp). The worker draws the PDF
// once and keeps it; a new one is drawn only when the document (or the company on its header)
// has changed since.

// The four documents a customer receives. An order, a challan, a return and a refund stay with
// the browser's Print (step 15c).
export const OUTPUT_DOCUMENTS = ['quotation', 'invoice', 'receipt', 'credit_note'] as const;
export type OutputDocument = (typeof OUTPUT_DOCUMENTS)[number];

export function isOutputDocument(value: string): value is OutputDocument {
  return OUTPUT_DOCUMENTS.some((kind) => kind === value);
}

// Sending a document out (an email, a share link) needs the permission that makes that document:
// whoever may write an invoice may send it. Reading one, and so downloading its PDF, needs no
// permission, like GET /invoices/:id. One path serves the four kinds (:kind), so the route cannot
// name one permission; the API checks this map instead (document-output.service.ts).
export const SEND_PERMISSIONS = {
  quotation: 'sales.quotation.manage',
  invoice: 'sales.invoice.manage',
  receipt: 'sales.receipt.manage',
  credit_note: 'sales.credit_note.manage',
} as const satisfies Record<OutputDocument, PermissionKey>;

const languageSchema = z.enum(LANGUAGE_CODES);

// ---------------------------------------------------------------------------------------------
// The PDF

export const DOCUMENT_FILE_STATUSES = ['pending', 'ready', 'failed'] as const;
export type DocumentFileStatus = (typeof DOCUMENT_FILE_STATUSES)[number];

export const documentFileSchema = z.object({
  id: z.uuid(),
  language: languageSchema,
  status: z.enum(DOCUMENT_FILE_STATUSES),
  // "INV-2026-27-0042.pdf"; null until the worker has written it
  fileName: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  // A short-lived download link while the file is ready, else null. Signing a link is local
  // arithmetic (no call to the storage), so a page that polls this gets a fresh one each time.
  download: signedUrlSchema.nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type DocumentFile = z.infer<typeof documentFileSchema>;

// The language of the PDF. The page sends the customer's document language unless the person
// picked another one.
export const documentFileInputSchema = z.object({ language: languageSchema });
export type DocumentFileInput = z.infer<typeof documentFileInputSchema>;

// ---------------------------------------------------------------------------------------------
// Email

export const MAX_EMAIL_RECIPIENTS = 5;

// The To and CC boxes take a few addresses separated by commas, semicolons or spaces (as people
// paste them from a mail program). One error for the whole box, not one per address: the form
// shows errors under a field, not under the third address inside it. Duplicates are dropped.
const emailListSchema = z.string().transform((value, ctx) => {
  const list = value
    .split(/[\s,;]+/)
    .map((email) => email.toLowerCase())
    .filter((email) => email !== '');
  if (list.some((email) => !z.email().safeParse(email).success)) {
    ctx.addIssue({ code: 'custom', message: errorCode('email_invalid') });
    return z.NEVER;
  }
  const unique = [...new Set(list)];
  if (unique.length > MAX_EMAIL_RECIPIENTS) {
    ctx.addIssue({ code: 'custom', message: errorCode('email_too_many') });
    return z.NEVER;
  }
  return unique;
});

export const documentEmailInputSchema = z.object({
  to: emailListSchema.refine((list) => list.length > 0, errorCode('email_to_required')),
  cc: emailListSchema,
  subject: z.string().trim().min(1, errorCode('email_subject_required')).max(200),
  // The person's own words, above the standard lines the server adds (what is attached, from whom)
  message: z.string().trim().max(5000),
  language: languageSchema,
});
export type DocumentEmailInput = z.infer<typeof documentEmailInputSchema>;
export type DocumentEmailFormValues = z.input<typeof documentEmailInputSchema>;

// What the dialog starts with: the customer's email address, and a subject and message in the
// chosen language. The server writes them (with the rest of the email and the PDF) so that every
// word the customer reads comes from one place, in the customer's language, whatever language
// the person's own screen is in.
export const documentEmailDraftQuerySchema = z.object({ language: languageSchema });

export const documentEmailDraftSchema = z.object({
  to: z.string(),
  subject: z.string(),
  message: z.string(),
});
export type DocumentEmailDraft = z.infer<typeof documentEmailDraftSchema>;

export const DOCUMENT_EMAIL_STATUSES = ['pending', 'sent', 'failed'] as const;
export type DocumentEmailStatus = (typeof DOCUMENT_EMAIL_STATUSES)[number];

// The person who sent an email or made a share link: the history says who did it
const personSchema = z.object({ id: z.uuid(), name: z.string() });

export const documentEmailSchema = z.object({
  id: z.uuid(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
  language: languageSchema,
  status: z.enum(DOCUMENT_EMAIL_STATUSES),
  sentBy: personSchema,
  createdAt: z.iso.datetime(),
  // When the mail server took it; null while pending or after it failed
  sentAt: z.iso.datetime().nullable(),
});
export type DocumentEmail = z.infer<typeof documentEmailSchema>;

// The whole history, newest first. No paging: a document is emailed a handful of times.
export const documentEmailListSchema = z.object({ items: z.array(documentEmailSchema) });

// ---------------------------------------------------------------------------------------------
// Share links

// How long a link works. Long enough for a customer to open it again when the payment is due
// (most payment terms are 30 days or less); a new link can always be made.
export const SHARE_LINK_DAYS = 30;

// The token in a link: 16 random bytes in base64url, 22 characters. 128 bits cannot be guessed,
// and the link stays short in a WhatsApp message. The database keeps only its hash.
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export const documentShareSchema = z.object({
  id: z.uuid(),
  language: languageSchema,
  createdBy: personSchema,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
  // When the customer first and last opened it; null until they do
  firstOpenedAt: z.iso.datetime().nullable(),
  lastOpenedAt: z.iso.datetime().nullable(),
});
export type DocumentShare = z.infer<typeof documentShareSchema>;

export const documentShareListSchema = z.object({ items: z.array(documentShareSchema) });

export const documentShareInputSchema = z.object({ language: languageSchema });
export type DocumentShareInput = z.infer<typeof documentShareInputSchema>;

// Only the answer to "make a link" has the link itself: the server keeps the token's hash, so a
// link cannot be shown again later (the person makes a new one). The message is the customer's
// text with the link in it; whatsAppUrl opens WhatsApp with that text, to the customer's number
// when the server could read one from the customer's phone.
export const createdShareSchema = z.object({
  share: documentShareSchema,
  url: z.url(),
  message: z.string(),
  whatsAppUrl: z.url(),
});
export type CreatedShare = z.infer<typeof createdShareSchema>;

// The number WhatsApp wants: the country code and the number, digits only. A phone is free text
// in Omnivo ("01711-000000", "+880 1711 000000", "008801711000000"), so this reads the common
// shapes and returns null for anything else — WhatsApp then lets the person pick the contact.
export function whatsAppNumber(phone: string | null): string | null {
  if (phone === null) return null;
  const digits = phone.replace(/\D/g, '');
  const international = phone.trim().startsWith('+')
    ? digits
    : digits.startsWith('00')
      ? digits.slice(2)
      : null;
  if (international !== null) return /^[1-9]\d{7,14}$/.test(international) ? international : null;
  // A Bangladeshi mobile number as people write it: 01 and nine more digits
  if (/^01\d{9}$/.test(digits)) return `88${digits}`;
  if (/^8801\d{9}$/.test(digits)) return digits;
  return null;
}

// https://wa.me/8801711000000?text=… (or https://wa.me/?text=… without a number)
export function whatsAppUrl(phone: string | null, text: string): string {
  return `https://wa.me/${whatsAppNumber(phone) ?? ''}?text=${encodeURIComponent(text)}`;
}

// ---------------------------------------------------------------------------------------------
// The public page behind a link

// What the customer sees before downloading: enough to know what the file is and from whom. Only
// an invoice has a due date and an amount still due.
export const publicDocumentSchema = z.object({
  company: z.string(),
  logoUrl: z.url().nullable(),
  // z.string(), not the enum: a newer server's fifth kind must not break an older page. The page
  // narrows it with isOutputDocument().
  kind: z.string(),
  number: z.string(),
  date: z.iso.date(),
  customer: z.string(),
  total: z.string(),
  currency: z.enum(CURRENCIES),
  dueDate: z.iso.date().nullable(),
  amountDue: z.string().nullable(),
  language: languageSchema,
  // The PDF in the link's language. Pending the first time a link is opened (or after the
  // document changed): the page asks again until it is ready.
  file: documentFileSchema,
});
export type PublicDocument = z.infer<typeof publicDocumentSchema>;

// ---------------------------------------------------------------------------------------------
// Routes

const documentParamsSchema = z.object({ kind: z.enum(OUTPUT_DOCUMENTS), id: z.uuid() });

export const documentOutputRoutes = {
  // The PDF in a language: the one already made when the document has not changed since, else a
  // new one the worker draws. 200 either way: the answer says whether it is ready.
  file: defineRoute({
    method: 'POST',
    path: '/documents/:kind/:id/files',
    summary: 'Get the PDF of a quotation, invoice, receipt or credit note, made now if needed',
    auth: 'bearer',
    status: 200,
    params: documentParamsSchema,
    body: documentFileInputSchema,
    response: documentFileSchema,
  }),
  // The page asks this every couple of seconds until the file is ready or failed
  getFile: defineRoute({
    method: 'GET',
    path: '/documents/:kind/:id/files/:fileId',
    summary: 'One PDF of a document, with a download link when it is ready',
    auth: 'bearer',
    status: 200,
    params: documentParamsSchema.extend({ fileId: z.uuid() }),
    response: documentFileSchema,
  }),
  emailDraft: defineRoute({
    method: 'GET',
    path: '/documents/:kind/:id/email-draft',
    summary:
      "The email dialog's first values in a language (needs the document's manage permission)",
    auth: 'bearer',
    status: 200,
    params: documentParamsSchema,
    query: documentEmailDraftQuerySchema,
    response: documentEmailDraftSchema,
  }),
  emails: defineRoute({
    method: 'GET',
    path: '/documents/:kind/:id/emails',
    summary: 'The emails a document was sent in, newest first',
    auth: 'bearer',
    status: 200,
    params: documentParamsSchema,
    response: documentEmailListSchema,
  }),
  sendEmail: defineRoute({
    method: 'POST',
    path: '/documents/:kind/:id/emails',
    summary: "Email a document's PDF (needs the document's manage permission)",
    auth: 'bearer',
    status: 201,
    params: documentParamsSchema,
    body: documentEmailInputSchema,
    response: documentEmailSchema,
  }),
  shares: defineRoute({
    method: 'GET',
    path: '/documents/:kind/:id/shares',
    summary: "A document's share links, newest first",
    auth: 'bearer',
    status: 200,
    params: documentParamsSchema,
    response: documentShareListSchema,
  }),
  createShare: defineRoute({
    method: 'POST',
    path: '/documents/:kind/:id/shares',
    summary:
      "Make a link that opens a document's PDF without a login (needs the manage permission)",
    auth: 'bearer',
    status: 201,
    params: documentParamsSchema,
    body: documentShareInputSchema,
    response: createdShareSchema,
  }),
  // POST, not DELETE: the link stays in the history, turned off
  revokeShare: defineRoute({
    method: 'POST',
    path: '/documents/:kind/:id/shares/:shareId/revoke',
    summary: 'Turn a share link off (needs the manage permission)',
    auth: 'bearer',
    status: 204,
    params: documentParamsSchema.extend({ shareId: z.uuid() }),
    response: z.void(),
  }),
};

export const publicDocumentRoutes = {
  get: defineRoute({
    method: 'GET',
    path: '/public/documents/:token',
    summary: 'The document behind a share link, and its PDF (no login)',
    auth: 'public',
    status: 200,
    params: z.object({ token: z.string().regex(SHARE_TOKEN_PATTERN) }),
    response: publicDocumentSchema,
  }),
};
```

- **`OUTPUT_DOCUMENTS` lists the four kinds** (decision 2), and `isOutputDocument()` narrows a plain string to one.
  The public page uses it on `kind`, which arrives as `z.string()` (see below).
- **`SEND_PERMISSIONS` maps a kind to its permission** (decisions 9 and 10). `as const satisfies Record<OutputDocument,
  PermissionKey>`: a fifth kind without a permission does not compile, and a typo in a key ("sales.invoices.manage")
  is caught too. `as const` keeps each value as its literal type, so the API can pass it to code that takes a
  `PermissionKey`.
- **`documentFileSchema.download` holds the link, not a second route.** A page that waits for a new PDF asks for
  the file every couple of seconds. When it is ready, the same answer carries the download link, so the page needs
  no second request. Signing a link is local arithmetic with the storage secret (no call to MinIO or S3), so making
  one on every poll costs almost nothing. The link lives for minutes, so it is useless in a log.
- **`emailListSchema` turns one text box into a list.** People paste addresses from a mail program as
  `a@x.com; b@y.com` or one per line. Splitting on commas, semicolons and spaces takes all three. One error is added
  for the whole box (`path` stays the box's own), because the form shows errors under a field; an error at
  `['to', 2]` would be shown nowhere. `z.NEVER` stops the parse at the first problem, so the box gets one message,
  not two. Lowercase plus `new Set` removes the duplicates people paste by accident.
- **`MAX_EMAIL_RECIPIENTS = 5`.** A real email to a customer goes to one or two people. A box of fifty addresses is a
  mailing list, and the company's mail sender (and its reputation with Gmail) would pay for it.
- **`to` is required, `cc` is not.** The `.refine` after the transform checks the list, not the text: `" , "` is
  text, but an empty list, and must fail with `email_to_required`.
- **`message` is plain text, up to 5,000 characters.** The server puts it into the email above its own lines (what is
  attached, who sent it) and escapes it. No HTML from the form ever reaches the email.
- **`documentEmailDraftSchema` comes from the server** (decision 12). The dialog asks for a draft in the chosen
  language and fills the boxes with it. When the person switches the language, the dialog asks again.
- **`personSchema` is the name, not just the id.** The history shows "Sent by Nasrin Akter", and the page does not
  need a members list (which needs its own permission) to print a name.
- **`sentAt` is null until the mail server took the email.** `pending` and `failed` both have no `sentAt`. The page
  shows "Sending…" or "Failed" from `status`, never from a missing date.
- **`SHARE_LINK_DAYS = 30`** (decision 3). Most payment terms are 30 days or shorter, so the customer can open the
  same link again when the money is due. After that a new link is one click.
- **`SHARE_TOKEN_PATTERN` is checked on the public route.** A token of the wrong shape is refused before any database
  work, so a bot trying random strings costs the database nothing.
- **`createdShareSchema` is the only place the link appears** (decision 13). The server keeps the token's hash, so
  it cannot show the link again. The answer also carries the message (in the customer's language, with the link in
  it) and `whatsAppUrl`, so the page only has to open it.
- **`whatsAppNumber()` reads a free-text phone** (decision 17). Omnivo stores phones as people typed them. WhatsApp's
  `wa.me` link wants the country code and the digits only. `+` or `00` means the number is already international
  (8 to 15 digits, never starting with 0, which is what the international numbering plan allows). `01` plus nine
  digits is a Bangladeshi mobile, which gets `88` in front. A land line (`02-9887766`) has no WhatsApp, so it returns
  null rather than a number that would open a chat with a stranger.
- **`whatsAppUrl()` without a number is `https://wa.me/?text=…`.** WhatsApp then asks the person which chat to send it
  to. `encodeURIComponent` encodes the `৳` and the Bangla text, so the message arrives exactly as written.
- **`publicDocumentSchema.kind` is `z.string()`.** The same rule as notification types and error codes: an old page
  (cached by a phone) must still parse an answer from a newer server that has a fifth kind.
- **Only an invoice has `dueDate` and `amountDue`.** They answer the customer's first question ("how much do I still
  owe, and by when?"). The other three kinds send null.
- **`file` is part of the public answer.** The customer's phone asks for the page; the server answers with the
  document and the state of its PDF in one go. While the PDF is pending, the page asks again; there is no second
  public route that a stranger could poke at.
- **`documentParamsSchema` uses `z.enum(OUTPUT_DOCUMENTS)` for `kind`.** `/documents/order/…` is refused as invalid
  input before the API looks at anything. A kind that does not go out has no path in.
- **`file` is a `POST` that may answer with an existing file.** It may start a job, so it is not a `GET` (a link
  preview or a prefetch must not start work). It answers 200, not 201, because often nothing new is made.
- **`revokeShare` is a `POST`, not a `DELETE`.** The link is turned off, not removed: the history still shows it,
  with when it was turned off.

```ts
import { describe, expect, it } from 'vitest';

import {
  type DocumentEmailFormValues,
  documentEmailInputSchema,
  whatsAppNumber,
  whatsAppUrl,
} from './document-output.js';

describe('whatsAppNumber', () => {
  it('adds the country code to a Bangladeshi mobile number as people write it', () => {
    expect(whatsAppNumber('01711-000000')).toBe('8801711000000');
    expect(whatsAppNumber('01711 000 000')).toBe('8801711000000');
    expect(whatsAppNumber('8801711000000')).toBe('8801711000000');
  });

  it('keeps an international number written with + or 00', () => {
    expect(whatsAppNumber('+880 1711-000000')).toBe('8801711000000');
    expect(whatsAppNumber('+44 20 7946 0958')).toBe('442079460958');
    expect(whatsAppNumber('0044 20 7946 0958')).toBe('442079460958');
  });

  it('gives up on a land line, an extension or no phone', () => {
    expect(whatsAppNumber('02-9887766')).toBeNull();
    expect(whatsAppNumber('+12')).toBeNull();
    expect(whatsAppNumber(null)).toBeNull();
  });
});

describe('whatsAppUrl', () => {
  it('encodes the message, with or without a number', () => {
    expect(whatsAppUrl('01711-000000', 'Invoice INV-1: ৳100')).toBe(
      'https://wa.me/8801711000000?text=Invoice%20INV-1%3A%20%E0%A7%B3100',
    );
    expect(whatsAppUrl(null, 'Hi')).toBe('https://wa.me/?text=Hi');
  });
});

function email(extra: Partial<DocumentEmailFormValues> = {}): DocumentEmailFormValues {
  return {
    to: 'accounts@rahman-traders.com',
    cc: '',
    subject: 'Invoice INV-2026-27-0042 from Karim Garments',
    message: '',
    language: 'en',
    ...extra,
  };
}

describe('document email input', () => {
  it('reads a list of addresses as people paste them, without duplicates', () => {
    const parsed = documentEmailInputSchema.parse(
      email({ to: 'A@x.com, b@y.com;a@x.com', cc: ' c@z.com ' }),
    );
    expect(parsed.to).toEqual(['a@x.com', 'b@y.com']);
    expect(parsed.cc).toEqual(['c@z.com']);
  });

  it('puts one error on the box, not on an address inside it', () => {
    const result = documentEmailInputSchema.safeParse(email({ to: 'a@x.com, not-an-email' }));
    expect(result.error?.issues).toMatchObject([{ path: ['to'], message: 'email_invalid' }]);
  });

  it('needs someone to send to, and at most five in a box', () => {
    expect(documentEmailInputSchema.safeParse(email({ to: ' ' })).error?.issues[0]?.message).toBe(
      'email_to_required',
    );
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => `${name}@x.com`).join(',');
    expect(documentEmailInputSchema.safeParse(email({ cc: six })).error?.issues[0]).toMatchObject({
      path: ['cc'],
      message: 'email_too_many',
    });
  });

  it('needs a subject', () => {
    expect(
      documentEmailInputSchema.safeParse(email({ subject: '  ' })).error?.issues[0]?.message,
    ).toBe('email_subject_required');
  });
});
```

- The WhatsApp tests are the phone shapes found in real customer lists. The email tests check the three things the
  form relies on: a pasted list is read, a bad address gives one error on the box, and the limits have their codes.

### `customers.ts`: the document language

```diff
@@ -6,6 +6,7 @@ import { defineRoute } from './http.js';
 import { ledgerPageSchema, ledgerQuerySchema } from './journal.js';
 import { priceSchema } from './money.js';
 import { pageOf, pageQuerySchema } from './pagination.js';
+import { LANGUAGE_CODES } from './preferences.js';
 import { optionalCode } from './products.js';
 import { binSchema, optionalEmailSchema } from './settings.js';
 
@@ -45,6 +46,9 @@ export const customerSchema = z.object({
   contactPerson: z.string().nullable(),
   phone: z.string().nullable(),
   email: z.string().nullable(),
+  // The language of the PDFs, emails and share links the customer gets (step 16). The person can
+  // still pick the other one when sending.
+  documentLanguage: z.enum(LANGUAGE_CODES),
   // The customer's VAT registration number: printed on the VAT invoice (Mushak 6.3)
   bin: z.string().nullable(),
   // Days from the invoice date to its due date. 0 = due on receipt.
@@ -112,6 +116,7 @@ export const customerInputSchema = z
     contactPerson: optionalText(80),
     phone: optionalText(30),
     email: optionalEmailSchema,
+    documentLanguage: z.enum(LANGUAGE_CODES),
     bin: binSchema,
     paymentTermsDays: z.number().int().min(0).max(MAX_PAYMENT_TERMS_DAYS),
     // '' = no limit, like a product's empty sale price: "0" is a real limit (cash only)
```

- **`documentLanguage` on the customer** (decision 4). It is on the full customer, not on the list row: only the
  customer page and the send dialogs read it.
- **Required in the input, no default.** The form always sends it (its default is `'en'`). A `.default('en')` in the
  schema would let an old client that does not know the field reset a Bangla customer to English without anybody
  choosing that. The database column has the default, so existing customers start in English (16.2).

```diff
@@ -11,6 +11,7 @@ function customer(extra: Partial<CustomerFormValues> = {}): CustomerFormValues {
     contactPerson: '',
     phone: '01711-000000',
     email: '',
+    documentLanguage: 'en',
     bin: '',
     paymentTermsDays: 30,
     creditLimit: '',
```

### `errors.ts`, `notifications.ts`

```diff
@@ -328,6 +328,13 @@ export const ERROR_CODES = [
   'receipt_has_refunds',
   'sales_account_invalid',
   'account_used_by_sales',
+  // Step 16: documents sent to customers. A draft (no number yet) or a voided receipt is not sent.
+  'document_not_issued',
+  'email_to_required',
+  'email_too_many',
+  'email_subject_required',
+  // The public page behind a share link: an unknown, expired or turned-off link all look the same
+  'share_link_not_found',
   // HTTP ও সার্ভার
   'invalid_cursor',
   'version_conflict',
```

- **`document_not_issued`** (decision 11): a PDF, an email or a link for a draft invoice or credit note, or for a
  voided receipt.
- **`email_to_required`, `email_too_many`, `email_subject_required`**: the email form's own checks. A bad address
  reuses `email_invalid`, which the app already translates.
- **`share_link_not_found`** (decision 14): the only error the public page can get about a link.

```diff
@@ -9,6 +9,8 @@ import { pageOf, pageQuerySchema } from './pagination.js';
 // import.done: params { file, count } — count = products made; import.failed: { file, count } —
 // count = problems found
 // stock.low: params { warehouse, count } — count = variants that fell to their reorder level
+// document.email_failed: params { document, id, number } — document = an OutputDocument kind, id =
+// the document's id (the bell opens its page)
 export const NOTIFICATION_TYPES = [
   'workspace.ready',
   'member.joined',
@@ -18,6 +20,7 @@ export const NOTIFICATION_TYPES = [
   'import.done',
   'import.failed',
   'stock.low',
+  'document.email_failed',
 ] as const;
 export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
 
```

- **`document.email_failed`, with `{ document, id, number }`.** The person who clicked Send hears that the email did
  not go ("Invoice INV-2026-27-0042 could not be emailed"). `id` is the document's id: a click on the bell opens the
  document's page, where the person can send it again. A sent email does not ring the bell: it shows in the
  document's history, and a bell for every success would teach people to ignore it.

### `routes.ts` and `index.ts`

```diff
@@ -18,6 +18,7 @@ import { creditNoteRoutes } from './credit-notes.js';
 import { customFieldRoutes } from './custom-fields.js';
 import { customerGroupRoutes, customerRoutes } from './customers.js';
 import { deliveryRoutes } from './deliveries.js';
+import { documentOutputRoutes, publicDocumentRoutes } from './document-output.js';
 import { priceListRoutes } from './price-lists.js';
 import { productCategoryRoutes } from './product-categories.js';
 import { productImportRoutes } from './product-imports.js';
@@ -101,4 +102,6 @@ export const routes = {
   creditNotes: creditNoteRoutes,
   refunds: refundRoutes,
   salesAccounts: salesAccountRoutes,
+  documentOutput: documentOutputRoutes,
+  publicDocuments: publicDocumentRoutes,
 };
```

```diff
@@ -1,4 +1,5 @@
 export * from './accounts.js';
+export * from './amount-words.js';
 export * from './attachments.js';
 export * from './audit.js';
 export * from './auth.js';
@@ -7,6 +8,7 @@ export * from './credit-notes.js';
 export * from './custom-fields.js';
 export * from './customers.js';
 export * from './deliveries.js';
+export * from './document-output.js';
 export * from './errors.js';
 export * from './fields.js';
 export * from './http.js';
```

- Two route groups: `documentOutput` (eight routes behind the login) and `publicDocuments` (one route without it).
  The API's route test (`contract.spec.ts`) fails until 16.3 adds their controllers, which is the point of the test.

### Check this part

```bash
pnpm --filter @omnivo/contracts typecheck
pnpm --filter @omnivo/contracts test
```

Both pass (contracts 176 tests, 17 new). Do not run the whole `pnpm typecheck` yet: the API, the app and the
translations do not know `documentLanguage` and the new error codes until 16.2, 16.3, 16.5 and 16.6.

---

## 16.2 — `packages/db`: PDFs, emails and share links

Three new tables hold what step 16 sends out: `document_files` (the PDFs the worker draws), `document_emails` (every
email with a PDF attached) and `document_shares` (the links a customer opens without a login). They all live in one
new schema file, because they belong to the same four documents and share the same "which document" columns. The
customer gets its document language, and the outbox learns two new events. Migration 0033 is generated from the
schema; 0034 is written by hand: row-level security, the lookup of a share link before the workspace is known, and
the guards that decide what may change.

### `schema/document-output.ts` (new)

```ts
import {
  DOCUMENT_EMAIL_STATUSES,
  DOCUMENT_FILE_STATUSES,
  LANGUAGE_CODES,
  OUTPUT_DOCUMENTS,
} from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

// The columns that say which document a row belongs to (step 16): a quotation, an invoice, a
// money receipt or a credit note. No FK to the document: it is in one of four tables, and a
// foreign key points at one. The API checks the document exists before it writes a row.
function documentColumns() {
  return {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind', { enum: OUTPUT_DOCUMENTS }).notNull(),
    documentId: uuid('document_id').notNull(),
    language: text('language', { enum: LANGUAGE_CODES }).notNull(),
  };
}

// A document's PDF, drawn by the worker and kept in S3/MinIO. One row per look of the document:
// the model is everything the PDF shows (the document, the company's header, every word in the
// row's language), and the fingerprint is its hash, so the same look is drawn once and reused,
// and a changed invoice (now paid) gets a new row. No baseColumns: the API writes a row, the
// worker finishes it.
export const documentFiles = pgTable(
  'document_files',
  {
    id: baseColumns().id,
    ...documentColumns(),
    // sha256 of the model (and the layout's version), in hex
    fingerprint: text('fingerprint').notNull(),
    // The page as the API worked it out (apps/api/src/documents/model.ts). The worker draws
    // exactly this, so the file always matches its fingerprint. Read back through a Zod schema.
    model: jsonb('model').notNull(),
    status: text('status', { enum: DOCUMENT_FILE_STATUSES }).notNull().default('pending'),
    // Who asked first. NULL when a customer opened a share link: they are not a user.
    requestedBy: uuid('requested_by').references(() => users.id),
    // Set by the worker when the file is in storage, as on report_exports
    fileName: text('file_name'),
    contentType: text('content_type'),
    sizeBytes: integer('size_bytes'),
    storageKey: text('storage_key'),
    createdAt: baseColumns().createdAt,
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    // One row per look, so two clicks at once share one row and one job: the API inserts with
    // ON CONFLICT DO NOTHING and then reads the row. It is also the lookup "is this look drawn?"
    // and, by its first three columns, "every file of this document".
    uniqueIndex('document_files_look_idx').on(
      table.tenantId,
      table.kind,
      table.documentId,
      table.language,
      table.fingerprint,
    ),
    check(
      'document_files_ready_check',
      sql`${table.status} <> 'ready' OR (${table.fileName} IS NOT NULL AND ${table.contentType} IS NOT NULL AND ${table.sizeBytes} IS NOT NULL AND ${table.storageKey} IS NOT NULL AND ${table.finishedAt} IS NOT NULL)`,
    ),
  ],
);

// An email with a document's PDF attached, as the person wrote it in the dialog. The worker sends
// it; the document page lists them. The message is kept as typed, so the history can show what
// the customer was told.
export const documentEmails = pgTable(
  'document_emails',
  {
    id: baseColumns().id,
    ...documentColumns(),
    // Lowercase addresses, from the contract's list parsing
    to: text('to').array().notNull(),
    cc: text('cc')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    subject: text('subject').notNull(),
    message: text('message').notNull(),
    status: text('status', { enum: DOCUMENT_EMAIL_STATUSES }).notNull().default('pending'),
    sentBy: uuid('sent_by')
      .notNull()
      .references(() => users.id),
    createdAt: baseColumns().createdAt,
    // When the mail server took it
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (table) => [
    // The document's history, newest first (id is UUIDv7)
    index('document_emails_document_idx').on(
      table.tenantId,
      table.kind,
      table.documentId,
      table.id,
    ),
    // 5 = the contract's MAX_EMAIL_RECIPIENTS; 200 and 5000 = its subject and message limits.
    // cardinality(), not array_length(): an empty array has length NULL, and NULL passes a check.
    check(
      'document_emails_recipients_check',
      sql`cardinality(${table.to}) BETWEEN 1 AND 5 AND cardinality(${table.cc}) <= 5`,
    ),
    check(
      'document_emails_text_check',
      sql`char_length(${table.subject}) BETWEEN 1 AND 200 AND char_length(${table.message}) <= 5000`,
    ),
    check(
      'document_emails_sent_check',
      sql`(${table.status} = 'sent') = (${table.sentAt} IS NOT NULL)`,
    ),
  ],
);

// A link a customer opens without a login (/d/<token>). Like an invitation, only the token's
// SHA-256 is kept: the link is shown once, and a leaked database dump cannot be turned back into
// working links. A link is turned off (revoked_at), never deleted, so the list still shows it.
export const documentShares = pgTable(
  'document_shares',
  {
    id: baseColumns().id,
    ...documentColumns(),
    tokenHash: text('token_hash').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: baseColumns().createdAt,
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    // Set by the public page, so the list shows whether the customer opened it
    firstOpenedAt: timestamp('first_opened_at', { withTimezone: true }),
    lastOpenedAt: timestamp('last_opened_at', { withTimezone: true }),
  },
  (table) => [
    // The public page finds a link by its hash before it knows the workspace
    uniqueIndex('document_shares_token_hash_idx').on(table.tokenHash),
    // The document's links, newest first
    index('document_shares_document_idx').on(
      table.tenantId,
      table.kind,
      table.documentId,
      table.id,
    ),
    check('document_shares_expiry_check', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'document_shares_opened_check',
      sql`(${table.firstOpenedAt} IS NULL) = (${table.lastOpenedAt} IS NULL) AND (${table.firstOpenedAt} IS NULL OR ${table.firstOpenedAt} <= ${table.lastOpenedAt})`,
    ),
  ],
);
```

- **`documentColumns()` is shared by the three tables.** Every row says which workspace, which kind of document,
  which document and which language. A function returns fresh column builders each time, like `baseColumns()`;
  Drizzle needs a new builder per table.
- **No foreign key to the document.** A row points at a quotation, an invoice, a receipt or a credit note, which are
  four tables, and a foreign key points at one. Four nullable columns with four FKs and a check that exactly one is
  set would work, but every query would then have to pick the right column. The API checks that the document exists
  (and is issued) before it writes a row, and every read goes through the document first. A quotation can still be
  deleted while it is open; its files, emails and links then point at nothing, and the public page treats such a
  link like an ended one (decision 14).
- **`kind` and `language` use the contract's lists** (`OUTPUT_DOCUMENTS`, `LANGUAGE_CODES`). As in every table
  since step 9, the enum is a TypeScript type, not a database check: code can only write a listed value, and an old
  row survives a renamed one.
- **`document_files` has no `baseColumns`,** like `report_exports`: the API writes a row, the worker finishes it,
  and nobody edits it. `version`, `updated_by` and `deleted_at` would have nothing to say.
- **`model` is the look, `fingerprint` its hash** (decision 18). The API works the model out from the document
  (16.3): every word and number the PDF will show, already in the row's language. The worker draws exactly this
  model and never reads the invoice itself. So a file is always the drawing of the look its fingerprint names, even
  if the invoice was paid a second after the request: that payment makes a new look and a new row. The worker also
  needs none of the sales code that reads an invoice (16.3 says why that matters). The database never looks inside
  the model; it only compares fingerprints.
- **`jsonb`, read back through a schema.** The worker parses the model with Zod before drawing it, like every
  other piece of data that comes from outside the code. A row written by an older API that a newer worker cannot
  read fails the job for good instead of drawing half a page.
- **`document_files_look_idx` is unique on (tenant, kind, document, language, fingerprint).** Two people click
  "Download PDF" on the same invoice at the same moment: both insert with `ON CONFLICT DO NOTHING`, the second waits
  for the first and inserts nothing, and both then read the one row. So there is one job and one file, not two. We
  tried this in two sessions (see "What we checked"). The same index answers "is this look drawn already?", and its
  first three columns find every file of a document.
- **`requested_by` is nullable.** A customer who opens a share link asks for the PDF too, and a customer is not a
  user. The column is "who asked first"; it does not decide who may download (anyone who may open the document may,
  decision 10).
- **`document_files_ready_check`** is `report_exports`' check: a ready row always says where its file is, so a
  download never meets a half-made row.
- **`document_emails.to` and `cc` are `text[]`, not a table of recipients.** Nobody looks for "every email sent to
  this address", and an email's recipients never change after it is written. One row per email keeps the history one
  simple read. The contract already lowercased and de-duplicated them.
- **The checks repeat the contract's limits** (five recipients, a 200-character subject, a 5,000-character message).
  The API never sends more, so these only catch a bug. `cardinality()` is used, not `array_length()`: the length of
  an empty array is `NULL`, and a check that is `NULL` passes, so `'{}'` would slip through as a "To".
- **`message` is kept as the person typed it.** The history can show what the customer was told. The server's own
  lines (what is attached, who sent it) are not stored: they are the same for every email and come from the code.
- **`document_emails_sent_check`: sent ⇔ `sent_at`.** The contract shows "Sending…" and "Failed" from `status`, and
  the date from `sent_at`. The check keeps the two from disagreeing.
- **No error column on an email.** The person needs to know it failed and to try again; the mail server's reason
  ("550 mailbox unavailable") goes to the worker's log, where support can find it, and not to a page.
- **`document_shares.token_hash` is the only trace of the token** (decision 13), as on an invitation. Its unique
  index is how the public page finds a link, before it knows the workspace.
- **`document_shares_expiry_check` and `document_shares_opened_check`.** A link that ends before it starts is a bug.
  The two opening dates come together (the first opening sets both), and the first is never after the last.
- **The two history indexes end in `id`.** The document page lists emails and links newest first, and `id` is a
  UUIDv7, so its order is the order they were made.

### `schema/parties.ts`, `schema/outbox-events.ts`, `schema/index.ts`

```diff
@@ -1,4 +1,4 @@
-import { ADDRESS_KINDS } from '@omnivo/contracts';
+import { ADDRESS_KINDS, LANGUAGE_CODES } from '@omnivo/contracts';
 import { sql } from 'drizzle-orm';
 import {
   boolean,
@@ -63,6 +63,9 @@ export const parties = pgTable(
     creditLimit: numeric('credit_limit', { precision: 19, scale: 4 }),
     // NULL = the products' own sale prices
     priceListId: uuid('price_list_id'),
+    // Step 16: the language of the PDFs, emails and links this party gets. The default fills the
+    // parties that already exist.
+    documentLanguage: text('document_language', { enum: LANGUAGE_CODES }).notNull().default('en'),
     notes: text('notes'),
     archivedAt: timestamp('archived_at', { withTimezone: true }),
   },
```

- **`document_language` defaults to `'en'` in the database,** though the contract's input has no default (16.1).
  The two do different jobs: the database default fills every customer that already exists when the column is
  added; the contract makes every save say which language it means.

```diff
@@ -18,6 +18,8 @@ export const OUTBOX_EVENT_TYPES = [
   'stock.below_reorder',
   'workspace.stock_accounts_requested',
   'workspace.tax_rates_requested',
+  'document.file_requested',
+  'document.email_requested',
 ] as const;
 export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];
 
```

- **`document.file_requested` and `document.email_requested`,** named as facts like the others. The first asks the
  worker to draw a PDF; the second to send an email (which draws its own PDF if the look is not stored yet). 16.3
  gives each its payload schema, its queue and its handler; until then the API does not type-check (see below).

```diff
@@ -39,3 +39,4 @@ export * from './receipts.js';
 export * from './sales-returns.js';
 export * from './credit-notes.js';
 export * from './refunds.js';
+export * from './document-output.js';
```

### Migration 0033 (generated)

Run `pnpm --filter @omnivo/db generate --name document-output`. This time nothing needs to be moved: the new tables
have no composite foreign keys, so the order `drizzle-kit` writes is already right. The result:

```sql
CREATE TABLE "document_emails" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"document_id" uuid NOT NULL,
	"language" text NOT NULL,
	"to" text[] NOT NULL,
	"cc" text[] DEFAULT '{}'::text[] NOT NULL,
	"subject" text NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sent_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "document_emails_recipients_check" CHECK (cardinality("document_emails"."to") BETWEEN 1 AND 5 AND cardinality("document_emails"."cc") <= 5),
	CONSTRAINT "document_emails_text_check" CHECK (char_length("document_emails"."subject") BETWEEN 1 AND 200 AND char_length("document_emails"."message") <= 5000),
	CONSTRAINT "document_emails_sent_check" CHECK (("document_emails"."status" = 'sent') = ("document_emails"."sent_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "document_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"document_id" uuid NOT NULL,
	"language" text NOT NULL,
	"fingerprint" text NOT NULL,
	"model" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" uuid,
	"file_name" text,
	"content_type" text,
	"size_bytes" integer,
	"storage_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "document_files_ready_check" CHECK ("document_files"."status" <> 'ready' OR ("document_files"."file_name" IS NOT NULL AND "document_files"."content_type" IS NOT NULL AND "document_files"."size_bytes" IS NOT NULL AND "document_files"."storage_key" IS NOT NULL AND "document_files"."finished_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "document_shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"document_id" uuid NOT NULL,
	"language" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"first_opened_at" timestamp with time zone,
	"last_opened_at" timestamp with time zone,
	CONSTRAINT "document_shares_expiry_check" CHECK ("document_shares"."expires_at" > "document_shares"."created_at"),
	CONSTRAINT "document_shares_opened_check" CHECK (("document_shares"."first_opened_at" IS NULL) = ("document_shares"."last_opened_at" IS NULL) AND ("document_shares"."first_opened_at" IS NULL OR "document_shares"."first_opened_at" <= "document_shares"."last_opened_at"))
);
--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "document_language" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_emails" ADD CONSTRAINT "document_emails_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_emails" ADD CONSTRAINT "document_emails_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_shares" ADD CONSTRAINT "document_shares_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_shares" ADD CONSTRAINT "document_shares_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_emails_document_idx" ON "document_emails" USING btree ("tenant_id","kind","document_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_files_look_idx" ON "document_files" USING btree ("tenant_id","kind","document_id","language","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "document_shares_token_hash_idx" ON "document_shares" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "document_shares_document_idx" ON "document_shares" USING btree ("tenant_id","kind","document_id","id");
```

- **`ADD COLUMN … DEFAULT 'en' NOT NULL` is instant.** Since Postgres 11, a constant default is stored once in the
  catalog, not written into every row, so a workspace with 20,000 customers is not locked while the table is
  rewritten.

### Migration 0034 (custom): RLS, the share link lookup, what may change

Run `pnpm --filter @omnivo/db generate --custom --name document-output-rules`, then fill the file:

```sql
-- Custom SQL migration file, put your code below! --
-- 1) The three new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002).
--    The worker draws a PDF and sends an email as omnivo_app inside the document's tenant, like
--    every job, so omnivo_worker needs no grant (as in 0018).
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['document_files', 'document_emails', 'document_shares'])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;

-- 2) A customer who opens a share link has no login and no workspace, so there is no tenant
--    context yet. The pattern of invitation_by_token (0010): SELECT only, and only the one row
--    whose hash is exactly the value the API set. Without the token no row is visible. Everything
--    after the lookup (stamping the opening, loading the document, asking for its PDF) runs in the
--    link's tenant with tenant_isolation.
CREATE POLICY share_by_token ON document_shares
  FOR SELECT
  USING (token_hash = NULLIF(current_setting('app.share_token_hash', true), ''));

-- 3) A ready PDF never changes: its row is the cache, and a download of the same look must get the
--    same file. Before that, the worker finishes the row (ready or failed), and a new request after
--    a failure sets it back to pending. Which document, which language, the look (model and
--    fingerprint) and who asked first never change: the file must always be the drawing of the
--    model its fingerprint names. A row may be deleted (a later cleanup of old files).
CREATE FUNCTION document_files_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'ready' THEN
    RAISE EXCEPTION 'document file % is ready and cannot be changed', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'document_files_ready_immutable';
  END IF;
  IF (NEW.tenant_id, NEW.kind, NEW.document_id, NEW.language, NEW.fingerprint, NEW.model,
      NEW.requested_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.kind, OLD.document_id, OLD.language, OLD.fingerprint, OLD.model,
      OLD.requested_by, OLD.created_at) THEN
    RAISE EXCEPTION 'document file % cannot move to another document, language or look', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'document_files_identity_immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER document_files_guard
  BEFORE UPDATE ON document_files
  FOR EACH ROW EXECUTE FUNCTION document_files_guard();

-- 4) An email is a record of what was sent to a customer. It is never deleted, and only the
--    worker's answer changes it, once: pending to sent or failed. Sending again makes a new row.
CREATE FUNCTION document_emails_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'pending'
     OR to_jsonb(NEW) - ARRAY['status', 'sent_at'] <> to_jsonb(OLD) - ARRAY['status', 'sent_at'] THEN
    RAISE EXCEPTION 'document email % cannot be changed', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'document_emails_immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER document_emails_guard
  BEFORE UPDATE OR DELETE ON document_emails
  FOR EACH ROW EXECUTE FUNCTION document_emails_guard();

-- 5) A share link is never deleted: the list shows the links that were turned off or ended, with
--    when the customer opened them. Only its openings and turning it off change it. A link that is
--    off stays off (turning it on again would bring back a link the person meant to kill), and the
--    first opening is written once. last_opened_at is not checked for order: two openings at the
--    same moment may commit in either order, and the API writes greatest(last_opened_at, now()).
CREATE FUNCTION document_shares_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR to_jsonb(NEW) - ARRAY['revoked_at', 'first_opened_at', 'last_opened_at']
     <> to_jsonb(OLD) - ARRAY['revoked_at', 'first_opened_at', 'last_opened_at']
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
     OR (OLD.first_opened_at IS NOT NULL
         AND NEW.first_opened_at IS DISTINCT FROM OLD.first_opened_at) THEN
    RAISE EXCEPTION 'document share % cannot be changed', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'document_shares_immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER document_shares_guard
  BEFORE UPDATE OR DELETE ON document_shares
  FOR EACH ROW EXECUTE FUNCTION document_shares_guard();
```

- **Section 1, RLS,** as on every tenant table. The worker draws and sends as `omnivo_app` inside the document's
  workspace, like every job, so `omnivo_worker` gets no new grant.
- **Section 2, `share_by_token`.** The public page runs before anybody has logged in, so there is no
  `app.tenant_id`. This policy shows exactly one row: the one whose hash the API put into `app.share_token_hash`.
  It is `SELECT` only. Stamping the opening and asking for the PDF happen after the API has read the link's
  workspace and switched into it, under `tenant_isolation`. So knowing a token lets you read its own link and
  nothing else, and lets you write nothing. It is the pattern of `invitation_by_token` (0010).
- **Section 3, a ready PDF never changes.** The row is the cache: two downloads of the same look must get the same
  file, so a ready row cannot be pointed at another file or set back to pending. Before it is ready, the worker
  finishes it, and a new request after a failure sets it back to pending (decision 19).
- **Which document, which language, the look and who asked first never change.** A bug that moved a file to
  another invoice would hand one customer's PDF to another. A changed model or fingerprint would make the file
  disagree with its look, and the next download of that look would get the wrong page.
- **Section 4, an email changes once.** Only `status` and `sent_at`, and only from pending. A failed email is not
  retried by hand: sending again writes a new row, so the history shows both attempts. It is never deleted
  (decision 20).
- **Section 5, a link changes in three ways only.** It is opened (the first opening once, the last one again and
  again) and turned off, once. A link that is off stays off: turning it on again would bring back a link that the
  person meant to kill, perhaps because it was sent to the wrong number. It is never deleted, so the list still
  shows it.
- **`last_opened_at` is not checked for order.** Two phones open a link at the same moment; each transaction has
  its own `now()`, and they may commit in either order. A check would make the later commit fail on the public page.
  The API writes `greatest(last_opened_at, now())` instead, which is right whatever the order.

> **What we checked.** On a throwaway database with every migration up to 0034, as `omnivo_app` (59 checks, plus a
> race in two sessions). A second request for the same look failed on `document_files_look_idx`, and with `ON CONFLICT
> DO NOTHING` inserted nothing; another language, another look and another kind were accepted, and so was a file
> without `requested_by`. A ready file without its storage fields failed; with them it passed, and then refused any
> change, including going back to pending. Pending → failed → pending passed. Changing the fingerprint or the model,
> moving a file to another document, kind or language, or changing who asked, failed. A ready file could be deleted.
> An email with no To, six To, six CC, an empty or 201-character subject (in Bangla letters) or a 5,001-character
> message failed; five To plus five CC, 200 and 5,000 characters, and an empty CC were accepted. Sent without a date,
> failed with a date, a changed subject, sent → failed, failed → pending and deleting either email failed. A duplicate
> token hash and a link that ends when it starts failed. A first opening without a last one, or after it, failed; a
> later opening passed; changing the first opening, clearing it, changing the expiry, the hash or the language,
> turning a link on again or off a second time, and deleting it failed. Another workspace saw none of the three
> tables, could not write into them, and changed and deleted nothing. With no workspace, no link was visible without
> the token or with a wrong one; with the token, its one link and none of the files or emails were, and the link could
> not be written until the workspace was set. Two sessions asking for the same look at once: the second waited for the
> first and inserted nothing; one row. `drizzle-kit generate` then reports no schema changes.

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/db typecheck
pnpm lint
```

`packages/db` reads the contract from its build, so build it first after 16.1. The whole repo still does not
type-check: on top of what 16.1 left, the API's outbox payload schemas, its queue map and its handler map now miss
the two new events, and the customer mapping misses `documentLanguage`. 16.3 adds all of them.

Then run `pnpm db:migrate` against your dev database. It applies 0033 and 0034; every customer you have starts in
English.

---

## 16.3 — `apps/api`: the PDF, the email and the share link

This is the biggest part. In order:

1. The text helpers of step 11's report PDF move into `src/pdf/text.ts`, so both kinds of PDF share them, and Bangla
   switches to Hind Siliguri (decision 21).
2. `src/documents/` gets the model of a page (`model.ts`), its words (`copy.ts`), the code that builds a model from
   a document (`models.service.ts`) and the code that draws it (`pdf.ts`).
3. The API's services: the PDF row (`files.ts`), the eight routes (`document-output.service.ts`) and the public page
   (`public-documents.service.ts`), with their controller and module.
4. The worker: the two jobs (`file.handler.ts`, `email.handler.ts`) and the email itself (`mail/document-email.ts`).
5. Small changes that tie it in: the outbox, the queues, the handler map, the modules, and the customer's
   `documentLanguage`.

First the new font:

```bash
pnpm --filter @omnivo/api add @fontsource/hind-siliguri@^5.3.0
pnpm --filter @omnivo/api remove @fontsource/noto-sans-bengali
```

The API used Noto Sans Bengali only for the report PDF; after this step nothing in `apps/api` loads it. The app keeps
its own copy for the screens.

### The text of a PDF: `src/pdf/text.ts` (new)

```ts
import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';

// Text in a PDF, shared by step 11's report exports and step 16's documents: the fonts, the
// Bangla/Latin runs, measuring and cutting. Moved here from reports/export/pdf.ts in step 16, so a
// fix to how Bangla is drawn reaches both kinds of file. Step 16 adds newPdf() and wrap().

// Geist for Latin text and digits, as in the app (CLAUDE.md → Typography). Bangla and the ৳ sign
// use Hind Siliguri, not the app's Noto Sans Bengali (step 16): pdfkit shapes Bangla with fontkit,
// not with a browser's HarfBuzz, and fontkit draws Noto's ন্দ্র (কেন্দ্র, চন্দ্র) with the ra-phala
// loose beside the letters. Hind Siliguri builds its conjuncts as whole glyphs, which fontkit gets
// right. A PDF must carry its fonts inside it; the files come from @fontsource packages, resolved
// through node_modules at run time.
const require = createRequire(import.meta.url);
const FONT_FILES = {
  latin: require.resolve('@fontsource/geist/files/geist-latin-400-normal.woff'),
  'latin-bold': require.resolve('@fontsource/geist/files/geist-latin-600-normal.woff'),
  bengali: require.resolve('@fontsource/hind-siliguri/files/hind-siliguri-bengali-400-normal.woff'),
  'bengali-bold':
    require.resolve('@fontsource/hind-siliguri/files/hind-siliguri-bengali-600-normal.woff'),
} as const;

export type Doc = InstanceType<typeof PDFDocument>;

// A new A4 document with the fonts registered, and a promise of its bytes once doc.end() is called
export function newPdf(options: PDFKit.PDFDocumentOptions): { pdf: Doc; done: Promise<Buffer> } {
  const pdf = new PDFDocument({ size: 'A4', ...options });
  for (const [name, file] of Object.entries(FONT_FILES)) pdf.registerFont(name, file);
  const chunks: Buffer[] = [];
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    pdf.on('error', reject);
  });
  return { pdf, done };
}

// pdfkit draws a string with one font, and neither font has every character: Geist has no
// Bangla, the Bangla subset has no Latin letters. So a string is cut into runs, each drawn with
// its own font. U+0980–U+09FF is the Bengali block (৳ is U+09F3); the zero-width joiners stay with
// the Bangla run they shape.
const BENGALI = /[ঀ-৿‌‍]/;

function runs(text: string): { bengali: boolean; text: string }[] {
  const out: { bengali: boolean; text: string }[] = [];
  for (const char of text) {
    const bengali = BENGALI.test(char);
    const last = out.at(-1);
    if (last?.bengali === bengali) last.text += char;
    else out.push({ bengali, text: char });
  }
  return out;
}

function fontOf(bengali: boolean, bold: boolean): keyof typeof FONT_FILES {
  if (bengali) return bold ? 'bengali-bold' : 'bengali';
  return bold ? 'latin-bold' : 'latin';
}

// tnum: Geist's tabular figures, so the digits of a column of amounts line up (CLAUDE.md:
// tabular-nums on every number that lines up)
const NUMBERS: PDFKit.Mixins.OpenTypeFeatures[] = ['tnum'];

export function widthOf(doc: Doc, text: string, size: number, bold: boolean): number {
  return runs(text).reduce((sum, run) => {
    doc.font(fontOf(run.bengali, bold)).fontSize(size);
    return sum + doc.widthOfString(run.text, { features: NUMBERS });
  }, 0);
}

// Whole letters as a reader sees them: a Bangla conjunct (ক্ষ) or a vowel sign is one grapheme
// of several code points, and cutting between them would leave a broken shape
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function lettersOf(text: string): string[] {
  return Array.from(graphemes.segment(text), (part) => part.segment);
}

// Cut with "…" until it fits: a long account name never runs into the amount next to it
function fit(doc: Doc, text: string, max: number, size: number, bold: boolean): string {
  if (widthOf(doc, text, size, bold) <= max) return text;
  let cut = lettersOf(text);
  while (cut.length > 0 && widthOf(doc, `${cut.join('')}…`, size, bold) > max) {
    cut = cut.slice(0, -1);
  }
  return `${cut.join('').trimEnd()}…`;
}

export interface TextStyle {
  size: number;
  bold: boolean;
  color: string;
}

// y is the baseline: the two fonts have different heights above it, and lining both up on the
// baseline (not on the top of the line) keeps "৳" level with the digits next to it
export function draw(
  doc: Doc,
  text: string,
  x: number,
  y: number,
  options: TextStyle & { align: 'left' | 'right'; width: number },
): void {
  const shown = fit(doc, text, options.width, options.size, options.bold);
  let cursor =
    options.align === 'right'
      ? x + options.width - widthOf(doc, shown, options.size, options.bold)
      : x;
  doc.fillColor(options.color);
  for (const run of runs(shown)) {
    doc.font(fontOf(run.bengali, options.bold)).fontSize(options.size);
    doc.text(run.text, cursor, y, { lineBreak: false, baseline: 'alphabetic', features: NUMBERS });
    cursor += doc.widthOfString(run.text, { features: NUMBERS });
  }
}

// Step 16: text that may need several lines (an address, a note, an amount in words). pdfkit can
// wrap by itself, but only inside one font, and our text switches fonts mid-line. So the words are
// laid out here, one line at a time, and each line is drawn with draw(). A line break the person
// typed stays a line break. A word longer than the whole width (a long serial number list without
// spaces) is cut between letters, never inside a Bangla letter.
export function wrap(doc: Doc, text: string, width: number, style: TextStyle): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ').filter((part) => part !== '')) {
      const candidate = line === '' ? word : `${line} ${word}`;
      if (widthOf(doc, candidate, style.size, style.bold) <= width) {
        line = candidate;
        continue;
      }
      if (line !== '') lines.push(line);
      // The word starts a new line. Wider than the whole line: as many letters per line as fit
      // (at least one, so a very narrow column cannot loop forever). The last letter is never cut
      // off on its own: it starts the next line, else an empty line would follow it.
      let rest = word;
      while (widthOf(doc, rest, style.size, style.bold) > width && lettersOf(rest).length > 1) {
        const letters = lettersOf(rest);
        let count = Math.max(1, letters.length - 1);
        while (
          count > 1 &&
          widthOf(doc, letters.slice(0, count).join(''), style.size, style.bold) > width
        ) {
          count -= 1;
        }
        lines.push(letters.slice(0, count).join(''));
        rest = letters.slice(count).join('');
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}
```

- **Moved, not copied.** `runs()`, `widthOf()`, `fit()` and `draw()` are step 11's code from
  `reports/export/pdf.ts`, unchanged. Two copies would drift: the next fix to Bangla drawing would reach one PDF and
  not the other.
- **`FONT_FILES` names Hind Siliguri for Bangla** (decision 21). The key names (`bengali`, `bengali-bold`) stay, so
  nothing else changes. Its `bengali` subset has every Bangla letter, the digits and `৳` (we checked each code point).
- **`newPdf()`** is the start both PDFs share: A4, the four fonts registered, and a promise of the bytes. pdfkit
  writes a stream; the promise collects it, so a caller simply awaits the file.
- **`wrap()` is new.** pdfkit can wrap text itself, but only inside one font, and our text changes font in the middle
  of a line (a Bangla name with a Latin code). So `wrap()` lays out the words, one line at a time, and each line is
  drawn with `draw()`. A line break someone typed (an address, a note) stays a line break.
- **A word wider than the line is cut between letters,** not inside one: `lettersOf()` uses `Intl.Segmenter`, so a
  conjunct like ক্ষ is never split into broken pieces. `Math.max(1, …)` keeps at least one letter per line: in a
  column narrower than one letter, the loop would otherwise run forever. The loop stops at the last letter and lets
  it start the next line; cutting that one off too would leave an empty line after it (a 16.4 test found this).

```diff
@@ -1,23 +1,8 @@
-import { createRequire } from 'node:module';
-import PDFDocument from 'pdfkit';
-
+import { draw, newPdf } from '../../pdf/text.js';
 import { COPY } from './copy.js';
 import type { DocCell, DocRow, ReportDocument } from './document.js';
 import { formatAmount } from './format.js';
 
-// The fonts of the app (CLAUDE.md → Typography): Geist for Latin text and digits, Noto Sans
-// Bengali for Bangla and the ৳ sign. A PDF must carry its fonts inside it; these files come from
-// the same @fontsource packages the app uses, resolved through node_modules at run time.
-const require = createRequire(import.meta.url);
-const FONT_FILES = {
-  latin: require.resolve('@fontsource/geist/files/geist-latin-400-normal.woff'),
-  'latin-bold': require.resolve('@fontsource/geist/files/geist-latin-600-normal.woff'),
-  bengali:
-    require.resolve('@fontsource/noto-sans-bengali/files/noto-sans-bengali-bengali-400-normal.woff'),
-  'bengali-bold':
-    require.resolve('@fontsource/noto-sans-bengali/files/noto-sans-bengali-bengali-600-normal.woff'),
-} as const;
-
 // The design system's colors (CLAUDE.md → Color tokens, light): the PDF is printed on white
 const INK = '#0F1728';
 const INK_2 = '#475467';
@@ -31,77 +16,6 @@ const ROW_HEIGHT = 18;
 const FONT_SIZE = 8.5;
 const INDENT = 10;
 
-type Doc = InstanceType<typeof PDFDocument>;
-
-// pdfkit draws a string with one font, and neither font has every character: Geist has no
-// Bangla, the Bangla subset has no Latin letters. So a string is cut into runs, each drawn with
-// its own font. U+0980–U+09FF is the Bengali block (৳ is U+09F3); the zero-width joiners stay with
-// the Bangla run they shape.
-const BENGALI = /[ঀ-৿‌‍]/;
-
-function runs(text: string): { bengali: boolean; text: string }[] {
-  const out: { bengali: boolean; text: string }[] = [];
-  for (const char of text) {
-    const bengali = BENGALI.test(char);
-    const last = out.at(-1);
-    if (last?.bengali === bengali) last.text += char;
-    else out.push({ bengali, text: char });
-  }
-  return out;
-}
-
-function fontOf(bengali: boolean, bold: boolean): keyof typeof FONT_FILES {
-  if (bengali) return bold ? 'bengali-bold' : 'bengali';
-  return bold ? 'latin-bold' : 'latin';
-}
-
-// tnum: Geist's tabular figures, so the digits of a column of amounts line up (CLAUDE.md:
-// tabular-nums on every number that lines up)
-const NUMBERS: PDFKit.Mixins.OpenTypeFeatures[] = ['tnum'];
-
-function widthOf(doc: Doc, text: string, size: number, bold: boolean): number {
-  return runs(text).reduce((sum, run) => {
-    doc.font(fontOf(run.bengali, bold)).fontSize(size);
-    return sum + doc.widthOfString(run.text, { features: NUMBERS });
-  }, 0);
-}
-
-// Whole letters as a reader sees them: a Bangla conjunct (ক্ষ) or a vowel sign is one grapheme
-// of several code points, and cutting between them would leave a broken shape
-const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
-
-// Cut with "…" until it fits: a long account name never runs into the amount next to it
-function fit(doc: Doc, text: string, max: number, size: number, bold: boolean): string {
-  if (widthOf(doc, text, size, bold) <= max) return text;
-  let cut = Array.from(graphemes.segment(text), (part) => part.segment);
-  while (cut.length > 0 && widthOf(doc, `${cut.join('')}…`, size, bold) > max) {
-    cut = cut.slice(0, -1);
-  }
-  return `${cut.join('').trimEnd()}…`;
-}
-
-// y is the baseline: the two fonts have different heights above it, and lining both up on the
-// baseline (not on the top of the line) keeps "৳" level with the digits next to it
-function draw(
-  doc: Doc,
-  text: string,
-  x: number,
-  y: number,
-  options: { size: number; bold: boolean; color: string; align: 'left' | 'right'; width: number },
-): void {
-  const shown = fit(doc, text, options.width, options.size, options.bold);
-  let cursor =
-    options.align === 'right'
-      ? x + options.width - widthOf(doc, shown, options.size, options.bold)
-      : x;
-  doc.fillColor(options.color);
-  for (const run of runs(shown)) {
-    doc.font(fontOf(run.bengali, options.bold)).fontSize(options.size);
-    doc.text(run.text, cursor, y, { lineBreak: false, baseline: 'alphabetic', features: NUMBERS });
-    cursor += doc.widthOfString(run.text, { features: NUMBERS });
-  }
-}
-
 function cellText(cell: DocCell, language: ReportDocument['language']): string {
   if (cell.kind === 'money') return formatAmount(cell.amount, language);
   return cell.kind === 'text' ? cell.text : '';
@@ -110,24 +24,13 @@ function cellText(cell: DocCell, language: ReportDocument['language']): string {
 const BOLD = new Set<DocRow['style']>(['group', 'heading', 'total', 'grand']);
 
 export function writePdf(doc: ReportDocument): Promise<Buffer> {
-  const pdf = new PDFDocument({
-    size: 'A4',
+  const { pdf, done } = newPdf({
     layout: doc.landscape ? 'landscape' : 'portrait',
     margin: MARGIN,
     // Every page stays in memory until the end, so the footer can say "Page 1 of 3"
     bufferPages: true,
     info: { Title: `${doc.title} — ${doc.company}`, Creator: 'Omnivo' },
   });
-  for (const [name, file] of Object.entries(FONT_FILES)) pdf.registerFont(name, file);
-
-  const chunks: Buffer[] = [];
-  pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
-  const done = new Promise<Buffer>((resolve, reject) => {
-    pdf.on('end', () => {
-      resolve(Buffer.concat(chunks));
-    });
-    pdf.on('error', reject);
-  });
 
   const left = MARGIN;
   const width = pdf.page.width - 2 * MARGIN;
```

- The report PDF now imports `draw` and `newPdf`. Nothing it draws changes, except that Bangla text is shaped
  correctly.

```diff
@@ -32,6 +32,16 @@ export function formatAmount(value: string, language: LanguageCode): string {
   return isDecimal(value) ? MONEY[language].format(value) : value;
 }
 
+// Step 16: a quantity on a document, with its unit's decimals ("72", "2.74"), grouped like money
+// and in Bangla digits on a Bangla document
+export function formatNumber(value: string, decimals: number, language: LanguageCode): string {
+  if (!isDecimal(value)) return value;
+  return new Intl.NumberFormat(language === 'bn' ? 'bn-BD' : 'en-IN', {
+    minimumFractionDigits: decimals,
+    maximumFractionDigits: decimals,
+  }).format(value);
+}
+
 const DAY = {
   en: new Intl.DateTimeFormat('en-US', {
     day: 'numeric',
```

- **`formatNumber()`** writes a quantity with its unit's decimals, grouped like money (`1,200`) and in Bangla digits
  on a Bangla document. It lives next to `formatAmount()`, because the reason is the same: the server cannot load
  `@omnivo/i18n` (it is built for the browser).

### The model of a page: `src/documents/model.ts` (new)

```ts
import { createHash } from 'node:crypto';
import { LANGUAGE_CODES } from '@omnivo/contracts';
import { z } from 'zod';

// The look of a document's PDF (step 16): every word and number the page shows, already in the
// row's language and already formatted. The API works it out (models.service.ts) and stores it on
// the document_files row; the worker draws exactly this (pdf.ts) and never reads the document
// itself. So the worker needs no sales code, and a stored file is always the drawing of the look
// its fingerprint names.

// Bump this when pdf.ts draws differently. The number is part of the fingerprint, so every look is
// drawn again (once, on its next request) instead of serving files in the old layout.
export const LAYOUT_VERSION = 1;

const pairSchema = z.object({ label: z.string(), value: z.string() });

export const documentModelSchema = z.object({
  language: z.enum(LANGUAGE_CODES),
  // "Invoice", "মানি রিসিট"
  title: z.string(),
  // "INV-2026-27-0042": the PDF's title, and the bell's text when an email fails
  number: z.string(),
  // "INV-2026-27-0042.pdf": the download's name and the email attachment's
  fileName: z.string(),
  company: z.object({
    name: z.string(),
    // The address one line per line, the BIN, the phone
    lines: z.array(z.string()),
    // The logo in storage. Its key is new for every upload, so a new logo is a new look.
    logo: z.object({ key: z.string(), contentType: z.string() }).nullable(),
  }),
  // Number, date, due date …: label and value, top right
  meta: z.array(pairSchema),
  // Who it is for: "Bill to", the name, the code, the address
  party: z.object({
    label: z.string(),
    name: z.string(),
    code: z.string(),
    lines: z.array(z.string()),
  }),
  // What a receipt says next to the party: the amount, how it was paid, the reference
  facts: z.array(pairSchema),
  // The lines (or a receipt's invoices). `width` is a share of the line, like the report export's
  // columns. `details` are the small lines under the first text column (the SKU, the batch …).
  table: z
    .object({
      columns: z.array(
        z.object({ label: z.string(), align: z.enum(['left', 'right']), width: z.number() }),
      ),
      rows: z.array(z.object({ cells: z.array(z.string()), details: z.array(z.string()) })),
    })
    .nullable(),
  // Under the table: the left-hand note ("Prices include VAT") and the sums on the right
  totals: z
    .object({
      note: z.string().nullable(),
      rows: z.array(pairSchema.extend({ strong: z.boolean() })),
    })
    .nullable(),
  // "Amount in words: Eighteen lakh … only", on money documents
  words: z.string().nullable(),
  note: pairSchema.nullable(),
  signatures: z.array(z.string()),
  // "Page {page} of {pages}", filled in by pdf.ts when the number of pages is known
  page: z.string(),
});
export type DocumentModel = z.infer<typeof documentModelSchema>;

// sha256 of the layout version and the model. JSON.stringify writes keys in the order the object
// was built, and the model is always built by the same code, so the same look gives the same
// string. It is hashed before it is stored: jsonb sorts the keys its own way, so the hash is
// never worked out again from what the database gives back.
export function fingerprintOf(model: DocumentModel): string {
  return createHash('sha256')
    .update(JSON.stringify({ layout: LAYOUT_VERSION, model }))
    .digest('hex');
}
```

- **The model is the page as text** (decision 22). It has no ids and no amounts as numbers, only what the PDF prints:
  `"৳18,42,600.00"`, `"23 Sep 2026"`, `"Bill to"`. Because every word is inside it, a change to any word (a fixed
  Bangla spelling in `copy.ts`) is a new fingerprint and a new file, with nothing to remember.
- **It is generic, not one shape per document.** A header, a party, a few facts, one table, totals, the amount in
  words, a note and signature lines are enough for all four documents. So `pdf.ts` has one layout to get right, not
  four.
- **`company.logo` is a storage key, not a link.** The worker reads the file itself. A new logo upload has a new key,
  so it is a new look.
- **`page` is a pattern (`"Page {page} of {pages}"`).** The number of pages is only known after drawing, so the
  drawing code fills it in.
- **`LAYOUT_VERSION` is part of the fingerprint.** When `pdf.ts` draws differently, bump it. Every stored file then
  stops matching, and each look is drawn again once, on its next request. Without it, people would keep getting
  files in the old layout until each document changed.
- **`fingerprintOf()` hashes the model before it is stored.** `JSON.stringify` writes keys in the order the code
  built the object, which is always the same. `jsonb` sorts keys its own way, so the hash is never worked out again
  from what the database returns; it is only compared.

### The words: `src/documents/copy.ts` (new)

```ts
import {
  type CreditNoteReason,
  type LanguageCode,
  type OutputDocument,
  type PaymentMethod,
  SHARE_LINK_DAYS,
} from '@omnivo/contracts';

// Every word a customer reads in step 16, in both languages side by side: the PDF, the email's
// first subject and message, the lines the server adds under the message, and the WhatsApp text.
// The server writes them (decision 12), so a person whose screen is in English can send a Bangla
// invoice. The PDF's words are the browser print's (print.* in en.ts/bn.ts), so paper and PDF say
// the same thing. satisfies: a text missing in one language does not compile.

// What the email and WhatsApp sentences need to know about the document
export interface DocumentFacts {
  kind: OutputDocument;
  title: string;
  number: string;
  // "৳1,15,000.00", in the language's digits
  amount: string;
  // The quotation's "valid until" or the invoice's due date, already formatted; else null
  date: string | null;
  // A credit note's invoice number; else null
  invoice: string | null;
}

export interface DocumentCopy {
  titles: Record<OutputDocument, string>;
  bin: (bin: string) => string;
  phone: (phone: string) => string;
  number: string;
  date: string;
  validUntil: string;
  dueDate: string;
  customerReference: string;
  order: string;
  originalInvoice: string;
  invoiceDate: string;
  reason: string;
  customer: string;
  billTo: string;
  receivedFrom: string;
  columns: {
    number: string;
    item: string;
    quantity: string;
    price: string;
    discount: string;
    vat: string;
    amount: string;
  };
  batch: (lot: string) => string;
  expires: (date: string) => string;
  serials: (serials: string) => string;
  fromChallan: (number: string) => string;
  fromReturn: (number: string) => string;
  lineDiscounts: string;
  net: string;
  vat: string;
  total: string;
  pricesWithVat: string;
  pricesWithoutVat: string;
  paid: string;
  credited: string;
  due: string;
  amountReceived: string;
  paidBy: string;
  reference: string;
  allocationColumns: { invoice: string; date: string; total: string; amount: string };
  advance: string;
  methods: Record<PaymentMethod, string>;
  reasons: Record<CreditNoteReason, string>;
  note: string;
  inWords: (words: string) => string;
  signatures: { customer: string; receivedBy: string; preparedBy: string; authorised: string };
  page: (page: string, pages: string) => string;
  // The email dialog's first values; the person can change both
  emailSubject: (facts: DocumentFacts, company: string) => string;
  emailMessage: (facts: DocumentFacts, customer: string, sender: string, company: string) => string;
  // The lines the server puts under the person's message. They are not editable: they say what is
  // attached and who really sent it, which the customer must be able to trust.
  emailAttached: (fileName: string) => string;
  emailSentBy: (sender: string, company: string) => string;
  emailReply: (company: string) => string;
  // The WhatsApp text with the link in it
  shareMessage: (facts: DocumentFacts, company: string, url: string) => string;
}

const bnDigits = new Intl.NumberFormat('bn-BD');

export const DOCUMENT_COPY = {
  en: {
    titles: {
      quotation: 'Quotation',
      invoice: 'Invoice',
      receipt: 'Money receipt',
      credit_note: 'Credit note',
    },
    bin: (bin) => `BIN ${bin}`,
    phone: (phone) => `Phone ${phone}`,
    number: 'No.',
    date: 'Date',
    validUntil: 'Valid until',
    dueDate: 'Due date',
    customerReference: 'Your reference',
    order: 'Order',
    originalInvoice: 'Original invoice',
    invoiceDate: 'Invoice date',
    reason: 'Reason',
    customer: 'Customer',
    billTo: 'Bill to',
    receivedFrom: 'Received from',
    columns: {
      number: '#',
      item: 'Item',
      quantity: 'Quantity',
      price: 'Price',
      discount: 'Discount',
      vat: 'VAT',
      amount: 'Amount',
    },
    batch: (lot) => `Batch ${lot}`,
    expires: (date) => `expires ${date}`,
    serials: (serials) => `Serial numbers: ${serials}`,
    fromChallan: (number) => `From ${number}`,
    fromReturn: (number) => `Goods back on ${number}`,
    lineDiscounts: 'Line discounts',
    net: 'Before VAT',
    vat: 'VAT',
    total: 'Total',
    pricesWithVat: 'Prices include VAT',
    pricesWithoutVat: 'Prices do not include VAT',
    paid: 'Paid',
    credited: 'Credited',
    due: 'Still due',
    amountReceived: 'Amount received',
    paidBy: 'Paid by',
    reference: 'Reference',
    allocationColumns: { invoice: 'Invoice', date: 'Date', total: 'Total', amount: 'Applied' },
    advance: 'Kept as an advance',
    methods: {
      cash: 'Cash',
      bank_transfer: 'Bank transfer',
      cheque: 'Cheque',
      mobile_wallet: 'Mobile wallet',
      card: 'Card',
    },
    reasons: {
      goods_returned: 'Goods came back',
      price_adjustment: 'Price cut',
      billing_error: 'Billing mistake',
      other: 'Other',
    },
    note: 'Note',
    inWords: (words) => `In words: ${words}`,
    signatures: {
      customer: 'Customer’s signature',
      receivedBy: 'Received by',
      preparedBy: 'Prepared by',
      authorised: 'Authorised signature',
    },
    page: (page, pages) => `Page ${page} of ${pages}`,
    emailSubject: (facts, company) => `${facts.title} ${facts.number} from ${company}`,
    emailMessage: (facts, customer, sender, company) => {
      const lead = {
        quotation:
          facts.date === null
            ? `Please find attached our quotation ${facts.number} for ${facts.amount}.`
            : `Please find attached our quotation ${facts.number} for ${facts.amount}, valid until ${facts.date}.`,
        invoice: `Please find attached invoice ${facts.number} for ${facts.amount}, due on ${facts.date ?? ''}.`,
        receipt: `Thank you for your payment. Please find attached money receipt ${facts.number} for ${facts.amount}.`,
        credit_note: `Please find attached credit note ${facts.number} for ${facts.amount}, against invoice ${facts.invoice ?? ''}.`,
      } satisfies Record<OutputDocument, string>;
      return `Dear ${customer},\n\n${lead[facts.kind]}\n\nRegards,\n${sender}\n${company}`;
    },
    emailAttached: (fileName) => `Attached: ${fileName}`,
    emailSentBy: (sender, company) => `${sender} sent this from ${company} using Omnivo.`,
    // The name is not last: "Ltd." would end the sentence with two full stops
    emailReply: (company) => `To reach ${company}, reply to this email.`,
    shareMessage: (facts, company, url) =>
      `${company}: ${facts.title} ${facts.number} for ${facts.amount}.\n` +
      `Open or download the PDF: ${url}\n` +
      `The link works for ${String(SHARE_LINK_DAYS)} days.`,
  },
  bn: {
    titles: {
      quotation: 'কোটেশন',
      invoice: 'ইনভয়েস',
      receipt: 'মানি রিসিট',
      credit_note: 'ক্রেডিট নোট',
    },
    bin: (bin) => `BIN ${bin}`,
    phone: (phone) => `ফোন ${phone}`,
    number: 'নং',
    date: 'তারিখ',
    validUntil: 'যে তারিখ পর্যন্ত',
    dueDate: 'পরিশোধের তারিখ',
    customerReference: 'আপনার রেফারেন্স',
    order: 'অর্ডার',
    originalInvoice: 'মূল ইনভয়েস',
    invoiceDate: 'ইনভয়েসের তারিখ',
    reason: 'কারণ',
    customer: 'গ্রাহক',
    billTo: 'বিলের ঠিকানা',
    receivedFrom: 'যার কাছ থেকে পাওয়া গেছে',
    columns: {
      number: '#',
      item: 'আইটেম',
      quantity: 'পরিমাণ',
      price: 'দাম',
      discount: 'ছাড়',
      vat: 'VAT',
      amount: 'টাকা',
    },
    batch: (lot) => `ব্যাচ ${lot}`,
    expires: (date) => `মেয়াদ ${date}`,
    serials: (serials) => `সিরিয়াল নম্বর: ${serials}`,
    fromChallan: (number) => `${number} থেকে`,
    fromReturn: (number) => `${number}-এ ফেরত আসা মাল`,
    lineDiscounts: 'লাইনের ছাড়',
    net: 'VAT-এর আগে',
    vat: 'VAT',
    total: 'মোট',
    pricesWithVat: 'দামে VAT ধরা',
    pricesWithoutVat: 'দাম VAT ছাড়া',
    paid: 'পরিশোধিত',
    credited: 'ক্রেডিট হয়েছে',
    due: 'বাকি',
    amountReceived: 'পাওয়া টাকা',
    paidBy: 'যেভাবে দিয়েছেন',
    reference: 'রেফারেন্স',
    allocationColumns: { invoice: 'ইনভয়েস', date: 'তারিখ', total: 'মোট', amount: 'ধরা হলো' },
    advance: 'অগ্রিম হিসেবে রাখা',
    methods: {
      cash: 'নগদ',
      bank_transfer: 'ব্যাংক ট্রান্সফার',
      cheque: 'চেক',
      mobile_wallet: 'মোবাইল ওয়ালেট',
      card: 'কার্ড',
    },
    reasons: {
      goods_returned: 'মাল ফেরত এসেছে',
      price_adjustment: 'দাম কমানো',
      billing_error: 'বিলের ভুল',
      other: 'অন্য কারণ',
    },
    note: 'নোট',
    inWords: (words) => `কথায়: ${words}`,
    signatures: {
      customer: 'গ্রাহকের স্বাক্ষর',
      receivedBy: 'গ্রহণকারী',
      preparedBy: 'প্রস্তুতকারী',
      authorised: 'অনুমোদিত স্বাক্ষর',
    },
    page: (page, pages) => `পৃষ্ঠা ${page} / ${pages}`,
    emailSubject: (facts, company) => `${company} থেকে ${facts.title} ${facts.number}`,
    emailMessage: (facts, customer, sender, company) => {
      const lead = {
        quotation:
          facts.date === null
            ? `আমাদের কোটেশন ${facts.number} (${facts.amount}) সংযুক্ত করা হলো।`
            : `আমাদের কোটেশন ${facts.number} (${facts.amount}) সংযুক্ত করা হলো। এটা ${facts.date} পর্যন্ত বহাল।`,
        invoice: `ইনভয়েস ${facts.number} (${facts.amount}) সংযুক্ত করা হলো। পরিশোধের তারিখ ${facts.date ?? ''}।`,
        receipt: `আপনার পেমেন্টের জন্য ধন্যবাদ। মানি রিসিট ${facts.number} (${facts.amount}) সংযুক্ত করা হলো।`,
        credit_note: `ইনভয়েস ${facts.invoice ?? ''}-এর বিপরীতে ক্রেডিট নোট ${facts.number} (${facts.amount}) সংযুক্ত করা হলো।`,
      } satisfies Record<OutputDocument, string>;
      return `প্রিয় ${customer},\n\n${lead[facts.kind]}\n\nধন্যবাদান্তে,\n${sender}\n${company}`;
    },
    emailAttached: (fileName) => `সংযুক্ত: ${fileName}`,
    emailSentBy: (sender, company) => `${sender} এটা ${company} থেকে Omnivo দিয়ে পাঠিয়েছেন।`,
    emailReply: (company) => `${company}-এর সাথে যোগাযোগ করতে এই ইমেইলের উত্তর দিন।`,
    shareMessage: (facts, company, url) =>
      `${company}: ${facts.title} ${facts.number}, ${facts.amount}।\n` +
      `PDF দেখুন বা নামান: ${url}\n` +
      `লিংকটা ${bnDigits.format(SHARE_LINK_DAYS)} দিন কাজ করবে।`,
  },
} satisfies Record<LanguageCode, DocumentCopy>;
```

- **The PDF's words are the browser print's** (`print.*` and friends in `en.ts`/`bn.ts`), so a printed invoice and
  its PDF say the same thing. They are written again here because the server cannot load `@omnivo/i18n` (decision
  12). One small change: the receipt's last column says "Applied" ("ধরা হলো"), not the form's "Apply".
- **`satisfies Record<LanguageCode, DocumentCopy>`**: a sentence missing in Bangla does not compile.
- **`DocumentFacts`** is what the email and WhatsApp sentences need: the title, the number, the amount already
  formatted, the date that matters (a quotation's "valid until", an invoice's due date) and a credit note's invoice.
- **`emailMessage()` is a first draft, not a template.** It fills the dialog's box; the person changes what they
  like. It starts with the customer's name and ends with the sender's, like a letter a person would write.
- **`emailAttached`, `emailSentBy` and `emailReply` are not in the draft.** The server adds them under the message on
  every email (see `document-email.ts`), so a customer can always see what is attached and who really sent it,
  whatever the person typed.
- **`emailReply()` does not end with the company's name.** Many names end with "Ltd.", and "reach Meghna
  Distributors Ltd.." would end the sentence with two full stops (a 16.4 test found this).
- **`shareMessage()`** says who it is from, what it is, the link, and how long it works. A customer who gets a link
  from an unknown number must be able to tell what it is before tapping it.

### Building a model: `src/documents/models.service.ts` (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  amountDueOf,
  amountInWords,
  type CreditNote,
  type Currency,
  defaultLineDescription,
  type DocumentTotals,
  type Invoice,
  isZeroMoney,
  type LanguageCode,
  type OutputDocument,
  type Quotation,
  type Receipt,
  type SalesLine,
  unappliedOf,
} from '@omnivo/contracts';
import { attachments, parties, tenants, tenantSettings, units } from '@omnivo/db';
import { and, eq, inArray } from 'drizzle-orm';

import { AppError } from '../common/http/app-error.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { formatAmount, formatIsoDate, formatNumber } from '../reports/export/format.js';
import { CreditNotesService } from '../sales/credit-notes.service.js';
import { InvoicesService } from '../sales/invoices.service.js';
import { QuotationsService } from '../sales/quotations.service.js';
import { ReceiptsService } from '../sales/receipts.service.js';
import { DOCUMENT_COPY, type DocumentCopy, type DocumentFacts } from './copy.js';
import { type DocumentModel, fingerprintOf } from './model.js';

// pdfkit draws PNG and JPEG. A WebP logo (the settings page takes one) is left off the PDF rather
// than failing it; the public page still shows it, because a browser draws WebP.
const DRAWABLE_LOGOS = new Set(['image/png', 'image/jpeg']);

type Loaded =
  | { kind: 'quotation'; doc: Quotation }
  | { kind: 'invoice'; doc: Invoice }
  | { kind: 'receipt'; doc: Receipt }
  | { kind: 'credit_note'; doc: CreditNote };

interface Company {
  name: string;
  lines: (copy: DocumentCopy) => string[];
  logo: { key: string; contentType: string } | null;
  // The company's own email: the reply-to of every email (null = replies go nowhere useful)
  email: string | null;
  currency: Currency;
}

interface Unit {
  code: string;
  decimals: number;
}

// One document, ready to be drawn, emailed or shown on the public page
export interface BuiltDocument {
  kind: OutputDocument;
  id: string;
  model: DocumentModel;
  fingerprint: string;
  // What the email and WhatsApp sentences say about it
  facts: DocumentFacts;
  customer: { id: string; name: string; email: string | null; phone: string | null };
  company: { name: string; logo: { key: string; contentType: string } | null };
  // The public page's numbers: plain decimal strings and ISO dates, the page formats them
  summary: {
    number: string;
    date: string;
    total: string;
    currency: Currency;
    dueDate: string | null;
    amountDue: string | null;
  };
}

function documentNotIssued(): AppError {
  return new AppError(
    409,
    'document_not_issued',
    'Only a numbered document goes out. Post it first; a voided receipt is not sent.',
  );
}

// The number of a document that may go out (decision 11), or the error. A quotation is numbered
// when it is saved. An invoice and a credit note get theirs when they are posted. A voided receipt
// still has its number, but it is not money received any more.
function issuedNumber(loaded: Loaded): string {
  switch (loaded.kind) {
    case 'quotation':
      return loaded.doc.number;
    case 'receipt':
      if (loaded.doc.status !== 'posted') throw documentNotIssued();
      return loaded.doc.number;
    case 'invoice':
    case 'credit_note':
      if (loaded.doc.status === 'draft' || loaded.doc.number === null) throw documentNotIssued();
      return loaded.doc.number;
  }
}

// The PDF's model and everything around it, from the same reads the document's own page uses
// (the four services' get). Runs in the API only: the worker draws the stored model.
@Injectable()
export class DocumentModels {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly quotations: QuotationsService,
    private readonly invoices: InvoicesService,
    private readonly receipts: ReceiptsService,
    private readonly creditNotes: CreditNotesService,
  ) {}

  async build(kind: OutputDocument, id: string, language: LanguageCode): Promise<BuiltDocument> {
    const loaded = await this.load(kind, id);
    const number = issuedNumber(loaded);
    const lines = loaded.kind === 'receipt' ? [] : loaded.doc.lines;
    const context = await this.withTenant(async (tx) => ({
      company: await companyOf(tx),
      units: await unitsOf(
        tx,
        lines.map((line) => line.unitId),
      ),
      customer: await customerOf(tx, loaded.doc.customer.id),
    }));
    const writer = new ModelWriter(language, context.company, context.units);
    const model = writer.model(loaded, number);
    return {
      kind,
      id,
      model,
      fingerprint: fingerprintOf(model),
      facts: writer.facts(loaded, number),
      customer: context.customer,
      company: { name: context.company.name, logo: context.company.logo },
      summary: {
        number,
        date: loaded.doc.date,
        total: loaded.kind === 'receipt' ? loaded.doc.amount : loaded.doc.total,
        currency: context.company.currency,
        dueDate: loaded.kind === 'invoice' ? loaded.doc.dueDate : null,
        amountDue: loaded.kind === 'invoice' ? amountDueOf(loaded.doc) : null,
      },
    };
  }

  // Each service throws not_found for a document that does not exist in this workspace
  private async load(kind: OutputDocument, id: string): Promise<Loaded> {
    switch (kind) {
      case 'quotation':
        return { kind, doc: await this.quotations.get(id) };
      case 'invoice':
        return { kind, doc: await this.invoices.get(id) };
      case 'receipt':
        return { kind, doc: await this.receipts.get(id) };
      case 'credit_note':
        return { kind, doc: await this.creditNotes.get(id) };
    }
  }
}
```

- **`load()` calls the four services' own `get()`.** The PDF then shows exactly what the document's page shows: the
  invoice's batch and serial numbers, what credit notes took off, the receipt's invoices. Writing those reads again
  here would mean two copies of step 15's hardest queries. `get()` needs no permission, which is right: reading a
  document needs none (decision 10). It throws `not_found` for a document of another workspace, like the page.
- **`issuedNumber()` is decision 11 in code**, and it also gives the number as a `string`: an invoice's `number` is
  `string | null` in its type (a draft has none), and after this check the rest of the code never has to ask again.
  A voided receipt keeps its number, so it needs its own check.
- **`document_not_issued` is a 409.** The request is fine; the document is in the wrong state for it, like posting a
  posted invoice.
- **One transaction for the company, the units and the customer,** after `get()`. They are three small reads; the
  document itself comes from the service's own transaction.
- **`BuiltDocument` carries more than the model.** The email dialog needs the customer's email; the share link needs
  the phone (for WhatsApp); the public page needs the totals as plain decimals, which it formats in the reader's own
  locale. Building it once and handing it around saves reading the document three times.

```ts
// The header of every page: the legal name (or the workspace's), the address, the BIN and the
// phone, as the browser print shows them (step 15c)
async function companyOf(tx: Transaction): Promise<Company> {
  const tenantId = getTenantId();
  const [row] = await tx
    .select({
      settings: tenantSettings,
      companyName: tenants.name,
      logoKey: attachments.storageKey,
      logoType: attachments.contentType,
    })
    .from(tenantSettings)
    .innerJoin(tenants, eq(tenants.id, tenantSettings.tenantId))
    .leftJoin(
      attachments,
      and(
        eq(attachments.tenantId, tenantSettings.tenantId),
        eq(attachments.id, tenantSettings.logoAttachmentId),
      ),
    )
    .where(eq(tenantSettings.tenantId, tenantId));
  if (!row) throw new Error(`tenant_settings row missing for tenant ${tenantId}`);
  const { settings } = row;
  return {
    name: settings.legalName ?? row.companyName,
    lines: (copy) => [
      ...(settings.address?.split('\n') ?? []),
      ...(settings.bin === null ? [] : [copy.bin(settings.bin)]),
      ...(settings.phone === null ? [] : [copy.phone(settings.phone)]),
    ],
    logo:
      row.logoKey === null || row.logoType === null
        ? null
        : { key: row.logoKey, contentType: row.logoType },
    email: settings.email,
    currency: settings.baseCurrency,
  };
}

// The code and decimals of the units the lines are counted in ("72 pcs", "2.74 m")
async function unitsOf(tx: Transaction, unitIds: readonly string[]): Promise<Map<string, Unit>> {
  if (unitIds.length === 0) return new Map();
  const rows = await tx
    .select({ id: units.id, code: units.code, decimals: units.decimals })
    .from(units)
    .where(and(eq(units.tenantId, getTenantId()), inArray(units.id, [...new Set(unitIds)])));
  return new Map(rows.map((row) => [row.id, { code: row.code, decimals: row.decimals }]));
}

// Where an email and a WhatsApp message go: the customer's own email and phone
async function customerOf(tx: Transaction, id: string): Promise<BuiltDocument['customer']> {
  const [row] = await tx
    .select({ id: parties.id, name: parties.name, email: parties.email, phone: parties.phone })
    .from(parties)
    .where(and(eq(parties.tenantId, getTenantId()), eq(parties.id, id)));
  // The document's customer FK makes this a broken database, not a 404
  if (!row) throw new Error(`Customer ${id} of a document is missing`);
  return row;
}
```

- **`companyOf()` is the browser print's header:** the legal name (the name on the trade licence) or the workspace's,
  the address line by line, the BIN (the NBR asks for it on a VAT invoice) and the phone.
- **`DRAWABLE_LOGOS` (at the top of the file):** pdfkit draws PNG and JPEG only. The settings page also takes WebP;
  such a logo is left off the PDF rather than failing it. The public page still shows it, because a browser draws
  WebP.
- **`unitsOf()`**: a line knows its unit's id; the PDF needs `pcs` and the unit's decimals (`2.74 m`). `new Set`
  asks for each unit once.
- **`customerOf()` throws a plain `Error`, not a 404.** A document always has its customer (a foreign key). If the
  row is missing, the database is broken, and a 500 with a log line is the honest answer.

```ts
// Writes the words and numbers of one document in one language
class ModelWriter {
  private readonly copy: DocumentCopy;

  constructor(
    private readonly language: LanguageCode,
    private readonly company: Company,
    private readonly units: Map<string, Unit>,
  ) {
    this.copy = DOCUMENT_COPY[language];
  }

  // ৳ first, 2 decimals, lakh/crore grouping, the language's digits: "৳18,42,600.50"
  private money(value: string): string {
    return `৳${formatAmount(value, this.language)}`;
  }

  private day(iso: string): string {
    return formatIsoDate(iso, this.language);
  }

  private words(amount: string): string {
    return this.copy.inWords(amountInWords(amount, this.language, this.company.currency));
  }

  facts(loaded: Loaded, number: string): DocumentFacts {
    const base = { kind: loaded.kind, title: this.copy.titles[loaded.kind], number };
    switch (loaded.kind) {
      case 'quotation': {
        const { validUntil } = loaded.doc;
        return {
          ...base,
          amount: this.money(loaded.doc.total),
          date: validUntil === null ? null : this.day(validUntil),
          invoice: null,
        };
      }
      case 'invoice':
        return {
          ...base,
          amount: this.money(loaded.doc.total),
          date: this.day(loaded.doc.dueDate),
          invoice: null,
        };
      case 'receipt':
        return { ...base, amount: this.money(loaded.doc.amount), date: null, invoice: null };
      case 'credit_note':
        return {
          ...base,
          amount: this.money(loaded.doc.total),
          date: null,
          invoice: loaded.doc.invoice.number,
        };
    }
  }

  model(loaded: Loaded, number: string): DocumentModel {
    const { copy } = this;
    const common = {
      language: this.language,
      title: copy.titles[loaded.kind],
      number,
      fileName: `${number}.pdf`,
      company: {
        name: this.company.name,
        lines: this.company.lines(copy),
        logo:
          this.company.logo !== null && DRAWABLE_LOGOS.has(this.company.logo.contentType)
            ? this.company.logo
            : null,
      },
      page: copy.page('{page}', '{pages}'),
    };
    const numberAndDate = [
      { label: copy.number, value: number },
      { label: copy.date, value: this.day(loaded.doc.date) },
    ];
    const party = (label: string, lines: string[] = []) => ({
      label,
      name: loaded.doc.customer.name,
      code: loaded.doc.customer.code,
      lines,
    });
    const note = (text: string | null) =>
      text === null ? null : { label: copy.note, value: text };

    switch (loaded.kind) {
      case 'quotation': {
        const quotation = loaded.doc;
        return {
          ...common,
          meta: [
            ...numberAndDate,
            ...(quotation.validUntil === null
              ? []
              : [{ label: copy.validUntil, value: this.day(quotation.validUntil) }]),
          ],
          party: party(copy.customer),
          facts: [],
          table: this.linesTable(quotation.lines, quotation.pricesIncludeVat),
          totals: this.totals(quotation, quotation.pricesIncludeVat, []),
          // A quotation is an offer, not money owed: no amount in words (decision 7)
          words: null,
          note: note(quotation.note),
          signatures: [copy.signatures.preparedBy, copy.signatures.authorised],
        };
      }
      case 'invoice': {
        const invoice = loaded.doc;
        const orders = invoice.orders.flatMap((order) =>
          order.number === null ? [] : [order.number],
        );
        // What is paid by the day the PDF is drawn, what credit notes took off, and what is still
        // due. Part of the look: a payment makes a new file (decision 18).
        const settled =
          isZeroMoney(invoice.amountPaid) && isZeroMoney(invoice.amountCredited)
            ? []
            : [
                ...(isZeroMoney(invoice.amountPaid)
                  ? []
                  : [{ label: copy.paid, value: this.money(invoice.amountPaid), strong: false }]),
                ...(isZeroMoney(invoice.amountCredited)
                  ? []
                  : [
                      {
                        label: copy.credited,
                        value: this.money(invoice.amountCredited),
                        strong: false,
                      },
                    ]),
                { label: copy.due, value: this.money(amountDueOf(invoice)), strong: true },
              ];
        return {
          ...common,
          meta: [
            ...numberAndDate,
            { label: copy.dueDate, value: this.day(invoice.dueDate) },
            ...(invoice.customerReference === null
              ? []
              : [{ label: copy.customerReference, value: invoice.customerReference }]),
            ...(orders.length === 0 ? [] : [{ label: copy.order, value: orders.join(', ') }]),
          ],
          party: party(copy.billTo, invoice.billingAddress?.split('\n') ?? []),
          facts: [],
          table: this.linesTable(invoice.lines, invoice.pricesIncludeVat),
          totals: this.totals(invoice, invoice.pricesIncludeVat, settled),
          words: this.words(invoice.total),
          note: note(invoice.note),
          signatures: [copy.signatures.customer, copy.signatures.authorised],
        };
      }
      case 'receipt': {
        const receipt = loaded.doc;
        // What refunds paid back is no advance any more (step 15d)
        const advance = unappliedOf(receipt);
        return {
          ...common,
          meta: numberAndDate,
          party: party(copy.receivedFrom),
          facts: [
            { label: copy.amountReceived, value: this.money(receipt.amount) },
            { label: copy.paidBy, value: copy.methods[receipt.method] },
            ...(receipt.reference === null
              ? []
              : [{ label: copy.reference, value: receipt.reference }]),
          ],
          table:
            receipt.allocations.length === 0
              ? null
              : {
                  columns: [
                    { label: copy.allocationColumns.invoice, align: 'left', width: 2 },
                    { label: copy.allocationColumns.date, align: 'left', width: 1.5 },
                    { label: copy.allocationColumns.total, align: 'right', width: 1.5 },
                    { label: copy.allocationColumns.amount, align: 'right', width: 1.5 },
                  ],
                  rows: receipt.allocations.map((allocation) => ({
                    cells: [
                      allocation.invoiceNumber,
                      this.day(allocation.invoiceDate),
                      this.money(allocation.invoiceTotal),
                      this.money(allocation.amount),
                    ],
                    details: [],
                  })),
                },
          totals: isZeroMoney(advance)
            ? null
            : {
                note: null,
                rows: [{ label: copy.advance, value: this.money(advance), strong: false }],
              },
          words: this.words(receipt.amount),
          note: note(receipt.note),
          signatures: [copy.signatures.receivedBy, copy.signatures.authorised],
        };
      }
      case 'credit_note': {
        const creditNote = loaded.doc;
        const reason = creditNote.reason;
        return {
          ...common,
          meta: [
            ...numberAndDate,
            { label: copy.originalInvoice, value: creditNote.invoice.number },
            { label: copy.invoiceDate, value: this.day(creditNote.invoice.date) },
            {
              label: copy.reason,
              // reason is z.string() in the contract (an older client must read a newer reason);
              // a reason this copy does not know is shown as stored rather than failing the PDF
              value: isCreditReason(reason, copy) ? copy.reasons[reason] : reason,
            },
          ],
          party: party(copy.billTo),
          facts: [],
          table: this.linesTable(creditNote.lines, creditNote.pricesIncludeVat),
          totals: this.totals(creditNote, creditNote.pricesIncludeVat, []),
          words: this.words(creditNote.total),
          note: note(creditNote.note),
          signatures: [copy.signatures.preparedBy, copy.signatures.authorised],
        };
      }
    }
  }

  // The priced lines, like PricedLines in the browser print: the item with what a pharmacy or an
  // electronics shop asks to see under it, then quantity, price, discount, VAT and amount
  private linesTable(
    lines: readonly (SalesLine & {
      lotNumber?: string | null;
      expiresOn?: string | null;
      serialNumbers?: readonly string[];
      deliveryNumber?: string | null;
      returnNumber?: string | null;
    })[],
    pricesIncludeVat: boolean,
  ): NonNullable<DocumentModel['table']> {
    const { copy, language } = this;
    return {
      columns: [
        { label: copy.columns.number, align: 'left', width: 0.45 },
        { label: copy.columns.item, align: 'left', width: 4.2 },
        { label: copy.columns.quantity, align: 'right', width: 1.3 },
        { label: copy.columns.price, align: 'right', width: 1.4 },
        { label: copy.columns.discount, align: 'right', width: 1.1 },
        { label: copy.columns.vat, align: 'right', width: 1.2 },
        { label: copy.columns.amount, align: 'right', width: 1.5 },
      ],
      rows: lines.map((line, index) => {
        const unit = this.units.get(line.unitId);
        const batch =
          line.lotNumber === null || line.lotNumber === undefined
            ? []
            : [
                [
                  copy.batch(line.lotNumber),
                  ...(line.expiresOn === null || line.expiresOn === undefined
                    ? []
                    : [copy.expires(this.day(line.expiresOn))]),
                ].join(', '),
              ];
        return {
          cells: [
            formatNumber(String(index + 1), 0, language),
            line.description,
            unit === undefined
              ? formatNumber(line.quantity, 0, language)
              : `${formatNumber(line.quantity, unit.decimals, language)} ${unit.code}`,
            this.money(line.unitPrice),
            isZeroMoney(line.discount)
              ? '—'
              : line.discountType === 'percent'
                ? `${formatNumber(line.discount, 2, language)}%`
                : this.money(line.discount),
            line.taxRate.name,
            this.money(pricesIncludeVat ? line.total : line.net),
          ],
          details: [
            line.sku,
            // The variant when the person typed their own description ("220 GSM pique")
            ...(line.description === defaultLineDescription(line)
              ? []
              : [defaultLineDescription(line)]),
            ...batch,
            ...(line.serialNumbers === undefined || line.serialNumbers.length === 0
              ? []
              : [copy.serials(line.serialNumbers.join(', '))]),
            ...(line.deliveryNumber === null || line.deliveryNumber === undefined
              ? []
              : [copy.fromChallan(line.deliveryNumber)]),
            ...(line.returnNumber === null || line.returnNumber === undefined
              ? []
              : [copy.fromReturn(line.returnNumber)]),
          ],
        };
      }),
    };
  }

  // Line discounts (only when there are any), before VAT, VAT, the total, and what follows it
  private totals(
    totals: DocumentTotals,
    pricesIncludeVat: boolean,
    after: { label: string; value: string; strong: boolean }[],
  ): NonNullable<DocumentModel['totals']> {
    const { copy } = this;
    return {
      note: pricesIncludeVat ? copy.pricesWithVat : copy.pricesWithoutVat,
      rows: [
        ...(isZeroMoney(totals.discount)
          ? []
          : [
              {
                label: copy.lineDiscounts,
                value: `−${this.money(totals.discount)}`,
                strong: false,
              },
            ]),
        { label: copy.net, value: this.money(totals.net), strong: false },
        { label: copy.vat, value: this.money(totals.vat), strong: false },
        { label: copy.total, value: this.money(totals.total), strong: true },
        ...after,
      ],
    };
  }
}

function isCreditReason(
  reason: string,
  copy: DocumentCopy,
): reason is keyof DocumentCopy['reasons'] {
  return Object.hasOwn(copy.reasons, reason);
}
```

- **`ModelWriter` holds the language and the company,** so every helper (`money()`, `day()`, `words()`) uses the same
  ones, and a Bangla invoice cannot end up with one English date.
- **`money()` always writes `৳` and 2 decimals,** like the browser print and every accounting document (CLAUDE.md →
  Money). The app does the same for every currency; the amount in words names the right currency.
- **A quotation has no amount in words** (decision 7): it is an offer, not money owed.
- **The invoice's "Paid / Credited / Still due" rows are part of the look.** That is why a payment gives the invoice
  a new file (decision 18): the customer's copy says what is still due today.
- **`isCreditReason()`**: a credit note's `reason` is `z.string()` in the contract (an older app must read a newer
  reason). A reason this copy does not know is printed as stored, rather than failing the whole PDF.
- **`linesTable()` mirrors `PricedLines`** in the browser print, detail for detail: the SKU, the variant when the
  person typed their own description, the batch and expiry a pharmacy needs, the serial numbers an electronics shop
  needs, and the challan or return the line came from.
- **Column widths are shares, not points**, like the report export. The item column takes what is left, and its
  description may take two lines (`pdf.ts` wraps it).
- **The row number uses the document's digits** (১, ২, ৩ on a Bangla PDF), like every other number on it.

### Drawing: `src/documents/pdf.ts` (new)

```ts
import { type Doc, draw, newPdf, type TextStyle, wrap } from '../pdf/text.js';
import type { DocumentModel } from './model.js';

// Draws a document's model on A4 (step 16). The layout is the browser print's (CLAUDE.md → Print
// layout, PrintSheet in @omnivo/ui): white paper, ink text, 1px rules (ink under the header and the
// table head, line between rows), no fills, no shadows. The header has the logo and the company on
// the left, the title and its details on the right. The table head repeats on every page, and a
// row, the totals and the signatures never break across two pages. Change anything here → bump
// LAYOUT_VERSION in model.ts.

const INK = '#0F1728';
const INK_2 = '#475467';
const INK_3 = '#8A94A6';
const LINE = '#E4E7EC';

// 12 mm, the print sheet's margin
const MARGIN = 34;
// The space left at the foot of each page for "Page 1 of 2"
const FOOTER = 22;

const BODY: TextStyle = { size: 9, bold: false, color: INK };
const SMALL: TextStyle = { size: 7.5, bold: false, color: INK_2 };
const CAPTION: TextStyle = { size: 7.5, bold: true, color: INK_2 };
const LEADING = 1.45;

function lineHeight(style: TextStyle): number {
  return style.size * LEADING;
}

// A cursor down the page. Every block asks `room()` first: when the block does not fit, it starts
// on a new page, so a table row or the totals never break in the middle.
class Page {
  y = MARGIN;
  readonly left = MARGIN;
  readonly width: number;
  private readonly bottom: number;

  constructor(
    readonly pdf: Doc,
    private readonly onNewPage: () => void,
  ) {
    this.width = pdf.page.width - 2 * MARGIN;
    this.bottom = pdf.page.height - MARGIN - FOOTER;
  }

  room(height: number): void {
    if (this.y + height <= this.bottom) return;
    this.pdf.addPage();
    this.y = MARGIN;
    this.onNewPage();
  }

  rule(color: string, width: number): void {
    this.pdf
      .moveTo(this.left, this.y)
      .lineTo(this.left + this.width, this.y)
      .lineWidth(width)
      .strokeColor(color)
      .stroke();
  }

  // Lines of text from the cursor down, at x; returns the height used
  text(
    lines: readonly string[],
    x: number,
    width: number,
    style: TextStyle,
    align: 'left' | 'right' = 'left',
  ): number {
    const height = lineHeight(style);
    lines.forEach((line, index) => {
      draw(this.pdf, line, x, this.y + height * (index + 1) - style.size * 0.3, {
        ...style,
        align,
        width,
      });
    });
    return height * lines.length;
  }
}

export function writeDocumentPdf(model: DocumentModel, logo: Uint8Array | null): Promise<Buffer> {
  const { pdf, done } = newPdf({
    margin: MARGIN,
    // Every page stays in memory until the end, so the footer can say "Page 1 of 2"
    bufferPages: true,
    info: {
      Title: `${model.title} ${model.number} — ${model.company.name}`,
      Creator: 'Omnivo',
    },
  });
  // The table head is drawn again at the top of every page after the first
  let repeatHead = (): void => undefined;
  const page = new Page(pdf, () => {
    repeatHead();
  });

  header(page, model, logo);
  party(page, model);
  if (model.table !== null) {
    const table = model.table;
    repeatHead = () => {
      tableHead(page, table);
    };
    tableHead(page, table);
    for (const row of table.rows) tableRow(page, table, row);
  }
  totals(page, model);
  words(page, model);
  note(page, model);
  signatures(page, model);
  footer(pdf, model);
  pdf.end();
  return done;
}
```

- **The browser print's layout** (CLAUDE.md → Print layout): white paper, ink text, a strong rule under the header
  and the table head, light rules between rows, no fills, the 12 mm margin. A customer who has seen your printed
  invoice recognises the PDF.
- **`Page` is a cursor down the page.** Every block asks `room()` for its height first, and starts a new page when
  it does not fit. So a table row, the totals and the signature lines never break in the middle, which is what
  `break-inside-avoid` does on paper.
- **The table head repeats on every page** (`repeatHead`), like `<thead>` in the print: on page 3 of a long invoice
  the reader still knows which column is the price.
- **`bufferPages: true`** keeps the pages in memory until the end, so the footer can say "Page 1 of 3" when the
  count is known.

```ts
function header(page: Page, model: DocumentModel, logo: Uint8Array | null): void {
  const { pdf } = page;
  const rightWidth = 210;
  const leftWidth = page.width - rightWidth - 24;
  const top = page.y;

  // Left: the logo, then the company. A logo that pdfkit cannot read (a broken upload) is left out
  // rather than failing the whole PDF.
  let left = top;
  if (logo !== null) {
    try {
      pdf.image(Buffer.from(logo), page.left, top, { fit: [110, 40] });
      left += 48;
    } catch {
      // the PDF goes out without the logo
    }
  }
  page.y = left;
  const nameStyle: TextStyle = { size: 12, bold: true, color: INK };
  left += page.text(
    wrap(pdf, model.company.name, leftWidth, nameStyle),
    page.left,
    leftWidth,
    nameStyle,
  );
  page.y = left;
  for (const line of model.company.lines) {
    left += page.text(wrap(pdf, line, leftWidth, SMALL), page.left, leftWidth, SMALL);
    page.y = left;
  }

  // Right: the title and the details, label on the left of the column and value on the right
  const x = page.left + page.width - rightWidth;
  page.y = top;
  const titleStyle: TextStyle = { size: 18, bold: true, color: INK };
  let right = top + page.text([model.title], x, rightWidth, titleStyle, 'right') + 4;
  for (const item of model.meta) {
    page.y = right;
    page.text([item.label], x, rightWidth / 2, { ...SMALL, color: INK_3 });
    right += page.text(
      [item.value],
      x + rightWidth / 2,
      rightWidth / 2,
      { ...BODY, size: 8.5 },
      'right',
    );
  }

  page.y = Math.max(left, right) + 10;
  page.rule(INK, 1);
  page.y += 14;
}

function party(page: Page, model: DocumentModel): void {
  const { pdf } = page;
  const half = (page.width - 24) / 2;
  const top = page.y;
  const nameStyle: TextStyle = { size: 10, bold: true, color: INK };

  let left = top + page.text([model.party.label], page.left, half, { ...CAPTION, color: INK_3 });
  page.y = left;
  left += page.text(wrap(pdf, model.party.name, half, nameStyle), page.left, half, nameStyle);
  page.y = left;
  left += page.text([model.party.code], page.left, half, { ...SMALL, color: INK_3 });
  for (const line of model.party.lines) {
    page.y = left;
    left += page.text(wrap(pdf, line, half, SMALL), page.left, half, SMALL);
  }

  // A receipt's facts: the amount (large), how it was paid, the reference
  const x = page.left + half + 24;
  let right = top;
  model.facts.forEach((fact, index) => {
    page.y = right;
    right += page.text([fact.label], x, half, { ...CAPTION, color: INK_3 });
    page.y = right;
    const style: TextStyle = index === 0 ? { size: 15, bold: true, color: INK } : BODY;
    right += page.text(wrap(pdf, fact.value, half, style), x, half, style) + 6;
  });

  page.y = Math.max(left, right) + 16;
}

type Table = NonNullable<DocumentModel['table']>;
type Row = Table['rows'][number];

const GAP = 8;

// Each column's x and width, from its share of the line. The widest column takes the details.
function placesOf(page: Page, table: Table): { x: number; width: number }[] {
  const share = table.columns.reduce((sum, column) => sum + column.width, 0);
  const usable = page.width - GAP * (table.columns.length - 1);
  let x = page.left;
  return table.columns.map((column) => {
    const place = { x, width: usable * (column.width / share) };
    x += place.width + GAP;
    return place;
  });
}

function detailColumn(table: Table): number {
  return table.columns.reduce(
    (best, column, index) => (column.width > (table.columns[best]?.width ?? 0) ? index : best),
    0,
  );
}

function tableHead(page: Page, table: Table): void {
  const places = placesOf(page, table);
  const height = lineHeight(CAPTION) + 6;
  page.room(height + lineHeight(BODY) * 2);
  const top = page.y;
  table.columns.forEach((column, index) => {
    const place = places[index];
    if (!place) return;
    page.y = top + 2;
    page.text([column.label], place.x, place.width, CAPTION, column.align);
  });
  page.y = top + height;
  page.rule(INK, 0.75);
}

function tableRow(page: Page, table: Table, row: Row): void {
  const { pdf } = page;
  const places = placesOf(page, table);
  const wide = detailColumn(table);
  const widePlace = places[wide];
  const wideText = row.cells[wide] ?? '';
  // The item's description may take two lines; the details go under it, each wrapped too
  const main = widePlace === undefined ? [wideText] : wrap(pdf, wideText, widePlace.width, BODY);
  const details =
    widePlace === undefined
      ? []
      : row.details.flatMap((detail) => wrap(pdf, detail, widePlace.width, SMALL));
  const height = lineHeight(BODY) * main.length + lineHeight(SMALL) * details.length + 8;
  page.room(height);

  const top = page.y + 3;
  row.cells.forEach((cell, index) => {
    const place = places[index];
    const column = table.columns[index];
    if (!place || !column) return;
    page.y = top;
    if (index === wide) {
      page.y += page.text(main, place.x, place.width, BODY);
      page.text(details, place.x, place.width, SMALL);
    } else {
      page.text([cell], place.x, place.width, BODY, column.align);
    }
  });
  page.y = top - 3 + height;
  page.rule(LINE, 0.5);
}

function totals(page: Page, model: DocumentModel): void {
  if (model.totals === null) return;
  const { rows, note: vatNote } = model.totals;
  const width = 230;
  const x = page.left + page.width - width;
  const row = lineHeight(BODY) + 3;
  page.y += 8;
  page.room(row * rows.length + 8);
  const top = page.y;
  if (vatNote !== null) {
    page.text([vatNote], page.left, page.width - width - 24, SMALL);
  }
  for (const item of rows) {
    // A strong row (the total, what is still due) sits under an ink rule, like the print
    if (item.strong) {
      page.pdf
        .moveTo(x, page.y + 1)
        .lineTo(x + width, page.y + 1)
        .lineWidth(0.75)
        .strokeColor(INK)
        .stroke();
    }
    const style: TextStyle = { ...BODY, bold: item.strong };
    const start = page.y + 1;
    page.y = start;
    page.text([item.label], x, width / 2, item.strong ? style : { ...style, color: INK_2 });
    page.y = start;
    page.text([item.value], x + width / 2, width / 2, style, 'right');
    page.y = start + row;
  }
  page.y = Math.max(page.y, top + lineHeight(SMALL)) + 6;
}

function words(page: Page, model: DocumentModel): void {
  if (model.words === null) return;
  const style: TextStyle = { ...BODY, bold: true };
  const lines = wrap(page.pdf, model.words, page.width, style);
  page.y += 4;
  page.room(lineHeight(style) * lines.length);
  page.y += page.text(lines, page.left, page.width, style) + 8;
}

function note(page: Page, model: DocumentModel): void {
  if (model.note === null) return;
  const lines = wrap(page.pdf, model.note.value, page.width, BODY);
  page.y += 4;
  // A long note may run over a page; its label and first lines stay together
  page.room(lineHeight(CAPTION) + lineHeight(BODY) * Math.min(lines.length, 3));
  page.y += page.text([model.note.label], page.left, page.width, { ...CAPTION, color: INK_3 });
  for (const line of lines) {
    page.room(lineHeight(BODY));
    page.y += page.text([line], page.left, page.width, BODY);
  }
  page.y += 8;
}

// The lines people sign on, side by side, with room above them for the signature and the stamp
function signatures(page: Page, model: DocumentModel): void {
  if (model.signatures.length === 0) return;
  const space = 44;
  page.room(space + lineHeight(SMALL) + 4);
  page.y += space;
  const gap = 32;
  const width = (page.width - gap * (model.signatures.length - 1)) / model.signatures.length;
  const top = page.y;
  model.signatures.forEach((label, index) => {
    const x = page.left + index * (width + gap);
    page.pdf
      .moveTo(x, top)
      .lineTo(x + width, top)
      .lineWidth(0.75)
      .strokeColor(INK)
      .stroke();
    page.y = top + 2;
    page.text([label], x, width, SMALL);
  });
  page.y = top + lineHeight(SMALL) + 4;
}

// "Page 1 of 2" at the foot of every page, in the document's digits, now that the count is known
function footer(pdf: Doc, model: DocumentModel): void {
  const range = pdf.bufferedPageRange();
  const digits = new Intl.NumberFormat(model.language === 'bn' ? 'bn-BD' : 'en-US');
  const width = pdf.page.width - 2 * MARGIN;
  for (let index = range.start; index < range.start + range.count; index += 1) {
    pdf.switchToPage(index);
    const text = model.page
      .replace('{page}', digits.format(index + 1))
      .replace('{pages}', digits.format(range.count));
    draw(pdf, text, MARGIN, pdf.page.height - MARGIN, {
      size: 7.5,
      bold: false,
      color: INK_3,
      align: 'right',
      width,
    });
  }
}
```

- **A logo pdfkit cannot read is skipped,** inside a `try`. A broken upload must not stop an invoice from going out.
- **The widest column takes the details** (`detailColumn()`): for the lines that is the item; a receipt's invoice
  table has no details.
- **A strong row sits under an ink rule:** the total, and an invoice's "Still due", the two numbers a customer looks
  for first.
- **The amount in words is bold and full width,** under the totals, as on a cheque. It may wrap: Bangla words for a
  large amount are long.
- **A long note may run over a page,** but its label and first lines stay together.
- **The signature lines have room above them** (44 pt) for a signature and a company stamp, which many Bangladeshi
  buyers still expect on a printed copy.

### The PDF's row: `src/documents/files.ts` (new)

```ts
import { Injectable } from '@nestjs/common';
import type { DocumentFile } from '@omnivo/contracts';
import { documentFiles } from '@omnivo/db';
import { and, eq } from 'drizzle-orm';

import { emit } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { StorageService } from '../storage/storage.service.js';
import type { BuiltDocument } from './models.service.js';

export type FileRow = typeof documentFiles.$inferSelect;

// Where the worker stores a file. Fixed by the row's id, so a job that runs twice writes the same
// object, and a key never says more than the document it belongs to.
export function storageKeyOf(row: Pick<FileRow, 'tenantId' | 'kind' | 'documentId' | 'id'>) {
  return ['tenants', row.tenantId, 'documents', row.kind, row.documentId, `${row.id}.pdf`].join(
    '/',
  );
}

// The API's half of a PDF (decisions 5, 18, 19): find the row of this look, or make it and ask
// the worker to draw it. Used by the download, the email, the share link and the public page.
@Injectable()
export class DocumentFiles {
  constructor(private readonly storage: StorageService) {}

  // Call it inside the caller's transaction, so the row, its job and whatever the caller writes
  // (an email, a share link) commit together. requestedBy is null on the public page.
  async request(
    tx: Transaction,
    built: BuiltDocument,
    requestedBy: string | null,
  ): Promise<FileRow> {
    const tenantId = getTenantId();
    const look = and(
      eq(documentFiles.tenantId, tenantId),
      eq(documentFiles.kind, built.kind),
      eq(documentFiles.documentId, built.id),
      eq(documentFiles.language, built.model.language),
      eq(documentFiles.fingerprint, built.fingerprint),
    );
    // Two clicks at the same moment: the second insert waits for the first and then does nothing
    // (document_files_look_idx), so there is one row and one job
    const [inserted] = await tx
      .insert(documentFiles)
      .values({
        tenantId,
        kind: built.kind,
        documentId: built.id,
        language: built.model.language,
        fingerprint: built.fingerprint,
        model: built.model,
        requestedBy,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) {
      await emit(tx, 'document.file_requested', { fileId: inserted.id });
      return inserted;
    }
    const [row] = await tx.select().from(documentFiles).where(look);
    if (!row)
      throw new Error(`Document file of ${built.kind} ${built.id} vanished after a conflict`);
    if (row.status !== 'failed') return row;
    // Decision 19: a failed look is tried again on the same row. `status = 'failed'` in the WHERE:
    // when two requests retry at once, only one of them starts a new job.
    const [retried] = await tx
      .update(documentFiles)
      .set({ status: 'pending', finishedAt: null })
      .where(and(eq(documentFiles.id, row.id), eq(documentFiles.status, 'failed')))
      .returning();
    if (!retried) {
      const [current] = await tx.select().from(documentFiles).where(eq(documentFiles.id, row.id));
      return current ?? row;
    }
    await emit(tx, 'document.file_requested', { fileId: retried.id });
    return retried;
  }

  // The answer the page reads. A ready file carries a fresh download link: signing is local
  // arithmetic, so a page that polls gets one each time at no cost (16.1).
  async toDocumentFile(row: FileRow): Promise<DocumentFile> {
    // The check constraint makes the three present whenever the status is 'ready'
    const download =
      row.status === 'ready' &&
      row.storageKey !== null &&
      row.contentType !== null &&
      row.fileName !== null
        ? await this.signedDownload(row.storageKey, row.contentType, row.fileName)
        : null;
    return {
      id: row.id,
      language: row.language,
      status: row.status,
      fileName: row.fileName,
      sizeBytes: row.sizeBytes,
      download,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
    };
  }

  private async signedDownload(key: string, contentType: string, fileName: string) {
    const signed = await this.storage.downloadUrl(key, contentType, fileName);
    return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
  }
}
```

- **`request()` runs in the caller's transaction.** The row, its job (the outbox event) and whatever the caller
  writes (an email, a link) commit together, or not at all.
- **`INSERT … ON CONFLICT DO NOTHING`, then `SELECT`** (16.2). `returning()` gives a row only when this request made
  it; then it, and only it, emits the job. A second click finds the same row and starts no second job.
- **A failed row is tried again on the same row** (decision 19): back to `pending`, and a new job. `status =
  'failed'` in the `WHERE` means two retries at once start one job, not two; the loser reads the row again.
- **`toDocumentFile()` signs a download link only for a ready file.** The three `!== null` checks look needless (the
  database's check makes the values present when the row is ready), but they let TypeScript know the values are not
  `null`, without a cast.
- **`storageKeyOf()`** fixes the key by the row's id, like report exports: a job that runs twice writes the same
  object. It sits next to the row's type; the worker's file maker uses it.

### Share tokens: `src/documents/share-token.ts` (new)

```ts
import { createHash, randomBytes } from 'node:crypto';

// A share link's token (decision 13), like an invitation's: random bytes, and only the SHA-256 in
// the database. 16 bytes = 128 bits, which nobody can guess, in 22 base64url characters
// (SHARE_TOKEN_PATTERN), so the link stays short in a WhatsApp message. A fast hash is enough: the
// token is random, not a password a person chose.
export function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newShareToken(): { token: string; hash: string } {
  const token = randomBytes(16).toString('base64url');
  return { token, hash: hashShareToken(token) };
}
```

- The invitation token's pattern (step 7), with 16 bytes instead of 32: the link must stay short in a WhatsApp
  message, and 128 random bits still cannot be guessed (decision 13).

### The eight routes: `src/documents/document-output.service.ts` (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  type CreatedShare,
  type DocumentEmail,
  type DocumentEmailDraft,
  type DocumentEmailInput,
  type DocumentFile,
  type DocumentShare,
  type LanguageCode,
  type OutputDocument,
  SEND_PERMISSIONS,
  SHARE_LINK_DAYS,
  whatsAppUrl,
} from '@omnivo/contracts';
import { documentEmails, documentFiles, documentShares, users } from '@omnivo/db';
import { and, desc, eq, isNull } from 'drizzle-orm';

import { AppError, notFound } from '../common/http/app-error.js';
import { emit } from '../common/outbox/outbox.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import type { Config } from '../config.js';
import { CONFIG, WITH_TENANT } from '../infra/tokens.js';
import { PermissionService } from '../rbac/permission.service.js';
import { DOCUMENT_COPY } from './copy.js';
import { DocumentFiles } from './files.js';
import { DocumentModels } from './models.service.js';
import { newShareToken } from './share-token.js';

const DAY_MS = 24 * 60 * 60 * 1000;

type EmailRow = typeof documentEmails.$inferSelect;
type ShareRow = typeof documentShares.$inferSelect;

function toEmail(row: EmailRow, sentByName: string): DocumentEmail {
  return {
    id: row.id,
    to: row.to,
    cc: row.cc,
    subject: row.subject,
    language: row.language,
    status: row.status,
    sentBy: { id: row.sentBy, name: sentByName },
    createdAt: row.createdAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
  };
}

function toShare(row: ShareRow, createdByName: string): DocumentShare {
  return {
    id: row.id,
    language: row.language,
    createdBy: { id: row.createdBy, name: createdByName },
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    firstOpenedAt: row.firstOpenedAt?.toISOString() ?? null,
    lastOpenedAt: row.lastOpenedAt?.toISOString() ?? null,
  };
}

// The eight routes behind /documents/:kind/:id (16.1): the PDF, the email and the share links of a
// quotation, an invoice, a money receipt or a credit note. Reading needs only a login (decision 10);
// sending something out needs the document's manage permission, checked here because one route
// serves four kinds (decision 9).
@Injectable()
export class DocumentOutputService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(CONFIG) private readonly config: Config,
    private readonly models: DocumentModels,
    private readonly files: DocumentFiles,
    private readonly permissions: PermissionService,
  ) {}

  async file(kind: OutputDocument, id: string, language: LanguageCode): Promise<DocumentFile> {
    const built = await this.models.build(kind, id, language);
    const row = await this.withTenant((tx) =>
      this.files.request(tx, built, currentPrincipal().userId),
    );
    return this.files.toDocumentFile(row);
  }

  // The page polls this while a file is pending. The file must belong to this document: a file id
  // from another invoice is "not found", not a way around the document in the path.
  getFile(kind: OutputDocument, id: string, fileId: string): Promise<DocumentFile> {
    return this.withTenant(async (tx) => {
      const [row] = await tx
        .select()
        .from(documentFiles)
        .where(
          and(
            eq(documentFiles.tenantId, getTenantId()),
            eq(documentFiles.id, fileId),
            eq(documentFiles.kind, kind),
            eq(documentFiles.documentId, id),
          ),
        );
      if (!row) throw notFound('Document file');
      return this.files.toDocumentFile(row);
    });
  }

  // The dialog's first values, in the language the person picked (decision 12)
  async emailDraft(
    kind: OutputDocument,
    id: string,
    language: LanguageCode,
  ): Promise<DocumentEmailDraft> {
    await this.assertCanSend(kind);
    const built = await this.models.build(kind, id, language);
    const sender = await this.withTenant((tx) => this.senderName(tx));
    const copy = DOCUMENT_COPY[language];
    return {
      to: built.customer.email ?? '',
      subject: copy.emailSubject(built.facts, built.company.name),
      message: copy.emailMessage(built.facts, built.customer.name, sender, built.company.name),
    };
  }

  emails(kind: OutputDocument, id: string): Promise<{ items: DocumentEmail[] }> {
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select({ email: documentEmails, sentByName: users.fullName })
        .from(documentEmails)
        .innerJoin(users, eq(users.id, documentEmails.sentBy))
        .where(
          and(
            eq(documentEmails.tenantId, getTenantId()),
            eq(documentEmails.kind, kind),
            eq(documentEmails.documentId, id),
          ),
        )
        // UUIDv7: the newest first
        .orderBy(desc(documentEmails.id));
      return { items: rows.map((row) => toEmail(row.email, row.sentByName)) };
    });
  }

  // The row, the PDF's row and the job commit together. The worker sends it (email.handler.ts);
  // the answer says "pending", and the history shows "sent" once the mail server took it.
  async sendEmail(
    kind: OutputDocument,
    id: string,
    input: DocumentEmailInput,
  ): Promise<DocumentEmail> {
    await this.assertCanSend(kind);
    const built = await this.models.build(kind, id, input.language);
    const userId = currentPrincipal().userId;
    return this.withTenant(async (tx) => {
      const file = await this.files.request(tx, built, userId);
      const [row] = await tx
        .insert(documentEmails)
        .values({
          tenantId: getTenantId(),
          kind,
          documentId: id,
          language: input.language,
          to: input.to,
          cc: input.cc,
          subject: input.subject,
          message: input.message,
          sentBy: userId,
        })
        .returning();
      if (!row) throw new Error('Document email insert returned no row');
      await emit(tx, 'document.email_requested', { emailId: row.id, fileId: file.id });
      return toEmail(row, await this.senderName(tx));
    });
  }

  shares(kind: OutputDocument, id: string): Promise<{ items: DocumentShare[] }> {
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select({ share: documentShares, createdByName: users.fullName })
        .from(documentShares)
        .innerJoin(users, eq(users.id, documentShares.createdBy))
        .where(
          and(
            eq(documentShares.tenantId, getTenantId()),
            eq(documentShares.kind, kind),
            eq(documentShares.documentId, id),
          ),
        )
        .orderBy(desc(documentShares.id));
      return { items: rows.map((row) => toShare(row.share, row.createdByName)) };
    });
  }

  // A new link each time (decision 13). The PDF is asked for now, so it is usually ready by the
  // time the customer taps the link.
  async createShare(
    kind: OutputDocument,
    id: string,
    language: LanguageCode,
  ): Promise<CreatedShare> {
    await this.assertCanSend(kind);
    const built = await this.models.build(kind, id, language);
    const userId = currentPrincipal().userId;
    const { token, hash } = newShareToken();
    const share = await this.withTenant(async (tx) => {
      const [row] = await tx
        .insert(documentShares)
        .values({
          tenantId: getTenantId(),
          kind,
          documentId: id,
          language,
          tokenHash: hash,
          createdBy: userId,
          expiresAt: new Date(Date.now() + SHARE_LINK_DAYS * DAY_MS),
        })
        .returning();
      if (!row) throw new Error('Document share insert returned no row');
      await this.files.request(tx, built, userId);
      return toShare(row, await this.senderName(tx));
    });
    // The app's route, not the API's: the page at /d/:token asks the public API route
    const url = `${this.config.appOrigin}/d/${token}`;
    const message = DOCUMENT_COPY[language].shareMessage(built.facts, built.company.name, url);
    return { share, url, message, whatsAppUrl: whatsAppUrl(built.customer.phone, message) };
  }

  // Turned off once; pressing it again on an off link changes nothing and is not an error
  async revokeShare(kind: OutputDocument, id: string, shareId: string): Promise<void> {
    await this.assertCanSend(kind);
    await this.withTenant(async (tx) => {
      const ofThisDocument = and(
        eq(documentShares.tenantId, getTenantId()),
        eq(documentShares.id, shareId),
        eq(documentShares.kind, kind),
        eq(documentShares.documentId, id),
      );
      const [revoked] = await tx
        .update(documentShares)
        .set({ revokedAt: new Date() })
        .where(and(ofThisDocument, isNull(documentShares.revokedAt)))
        .returning({ id: documentShares.id });
      if (revoked) return;
      const [exists] = await tx
        .select({ id: documentShares.id })
        .from(documentShares)
        .where(ofThisDocument);
      if (!exists) throw notFound('Share link');
    });
  }

  // The same answer the PermissionGuard gives, for the permission this kind needs (decision 9)
  private async assertCanSend(kind: OutputDocument): Promise<void> {
    const permission = SEND_PERMISSIONS[kind];
    const access = await this.permissions.forPrincipal(currentPrincipal());
    if (!access?.permissions.includes(permission)) {
      throw new AppError(403, 'permission_missing', `Missing permission: ${permission}.`, {
        params: { permissions: permission },
      });
    }
  }

  // The person's name, for the email's sign-off and the history
  private async senderName(tx: Transaction): Promise<string> {
    const [user] = await tx
      .select({ fullName: users.fullName })
      .from(users)
      .where(eq(users.id, currentPrincipal().userId));
    if (!user) throw new Error('The signed-in user has no users row');
    return user.fullName;
  }
}
```

- **`assertCanSend()` gives the guard's answer** (403 `permission_missing`, with the permission in `params`), so the
  app shows the same message as for any route. It runs before the document is read: a person without the
  permission costs no database work.
- **Reading routes check nothing more** (decision 10). `emails()` and `shares()` for a document of another workspace
  return an empty list: row-level security hides the rows.
- **`getFile()` checks the file belongs to the document in the path.** Otherwise a file id from another invoice
  would answer through this invoice's URL. It still reads only the file row: polling every two seconds must stay
  cheap.
- **`emailDraft()` asks for the document in the chosen language** and returns the customer's email in To. An empty
  string, not `null`, when the customer has none: the box is a text box, and the person types one.
- **`sendEmail()` writes the email, the PDF's row and the job in one transaction.** The email's job gets the file's
  id, so it attaches exactly that look (decision 24). The answer is the email with `status: 'pending'`; the history
  shows "Sent" once the worker is done.
- **`createShare()` makes the link, then the message and the WhatsApp link from it.** The URL is the app's
  (`APP_ORIGIN/d/<token>`), not the API's: the customer opens a page, and the page asks the API. The token leaves
  this method only in the answer; the database keeps its hash. The PDF is asked for in the same transaction
  (decision 25).
- **`revokeShare()` is safe to press twice.** The update needs `revoked_at IS NULL`; when it changes nothing, a second
  read tells "already off" (no error, 204) from "no such link" (404).
- **`senderName()`** reads the person's name inside the workspace transaction, like every read here.

### The public page: `src/documents/public-documents.service.ts` (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { PublicDocument } from '@omnivo/contracts';
import { type Db, documentShares } from '@omnivo/db';
import { and, eq, sql } from 'drizzle-orm';

import { AppError } from '../common/http/app-error.js';
import { getTenantId, runWithTenant } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { DB, WITH_TENANT } from '../infra/tokens.js';
import { StorageService } from '../storage/storage.service.js';
import { DocumentFiles } from './files.js';
import { type BuiltDocument, DocumentModels } from './models.service.js';
import { hashShareToken } from './share-token.js';

// Unknown, ended, turned off, or the document is gone or no longer issued (a voided receipt): one
// answer for all (decision 14). Telling them apart would tell a stranger which tokens were real.
function shareLinkNotFound(): AppError {
  return new AppError(404, 'share_link_not_found', 'This link does not work any more.');
}

// The page behind a share link (/d/:token in the app), opened by a customer without a login
@Injectable()
export class PublicDocumentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly models: DocumentModels,
    private readonly files: DocumentFiles,
    private readonly storage: StorageService,
  ) {}

  async get(token: string): Promise<PublicDocument> {
    const share = await this.findByToken(token);
    // From here on the link's own workspace, like a job in the worker: every read and write is
    // under tenant_isolation, and the token's policy is not needed again
    return runWithTenant(share.tenantId, async () => {
      const built = await this.build(share);
      const row = await this.withTenant(async (tx) => {
        // Stamped in the link's tenant (the token alone cannot write, 16.2). greatest(): two phones
        // opening it at once commit in any order, and the last opening never moves back.
        await tx
          .update(documentShares)
          .set({
            firstOpenedAt: sql`coalesce(${documentShares.firstOpenedAt}, now())`,
            lastOpenedAt: sql`greatest(${documentShares.lastOpenedAt}, now())`,
          })
          .where(and(eq(documentShares.tenantId, getTenantId()), eq(documentShares.id, share.id)));
        // The PDF in the link's language, drawn now if the document changed since the link was
        // made (an invoice that got paid). Nobody asked for it by name: requestedBy is null.
        return this.files.request(tx, built, null);
      });
      const logo = built.company.logo;
      return {
        company: built.company.name,
        logoUrl:
          logo === null ? null : (await this.storage.downloadUrl(logo.key, logo.contentType)).url,
        kind: share.kind,
        number: built.summary.number,
        date: built.summary.date,
        customer: built.customer.name,
        total: built.summary.total,
        currency: built.summary.currency,
        dueDate: built.summary.dueDate,
        amountDue: built.summary.amountDue,
        language: share.language,
        file: await this.files.toDocumentFile(row),
      };
    });
  }

  // Before the workspace is known. document_shares has FORCE RLS; migration 0034's share_by_token
  // policy shows only the row whose hash this transaction set, like an invitation (step 7).
  private async findByToken(token: string): Promise<typeof documentShares.$inferSelect> {
    const hash = hashShareToken(token);
    const [share] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.share_token_hash', ${hash}, true)`);
      return tx.select().from(documentShares).where(eq(documentShares.tokenHash, hash));
    });
    // No row at all also ends here: undefined !== null
    if (share?.revokedAt !== null || share.expiresAt <= new Date()) {
      throw shareLinkNotFound();
    }
    return share;
  }

  // A deleted quotation, or a receipt voided after the link was sent, ends the link too
  private async build(share: typeof documentShares.$inferSelect): Promise<BuiltDocument> {
    try {
      return await this.models.build(share.kind, share.documentId, share.language);
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.code === 'not_found' || error.code === 'document_not_issued')
      ) {
        throw shareLinkNotFound();
      }
      throw error;
    }
  }
}
```

- **`findByToken()` is the invitation lookup again** (step 7): a transaction on the plain pool sets
  `app.share_token_hash`, and migration 0034's `share_by_token` policy shows that one row. Without the token,
  nothing is visible.
- **An ended, turned-off or unknown link is one answer** (decision 14). The checks run on the row, after the lookup,
  so all three give the same 404.
- **`runWithTenant()` then works inside the link's own workspace,** like a job in the worker. From here every read
  and write is under `tenant_isolation`; the token's policy is not used again.
- **The opening is stamped with `coalesce` and `greatest`** (16.2): the first opening is kept, and two phones that
  open the link at once cannot move the last opening back.
- **The PDF is requested with `requestedBy: null`.** If the invoice was paid since the link was sent, the customer
  gets the paid version: the link points at the document, not at one old file.
- **A deleted quotation or a voided receipt ends the link too.** `build()` turns `not_found` and
  `document_not_issued` into `share_link_not_found`, so a customer never sees a voided receipt as if it were valid.
- **The logo here may be WebP.** It is a link for the browser, not a picture in the PDF.

### The controller and the module

```ts
import { Controller, Header } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { DocumentOutputService } from './document-output.service.js';
import { PublicDocumentsService } from './public-documents.service.js';

type Routes = typeof routes.documentOutput;
type PublicRoutes = typeof routes.publicDocuments;

@Controller()
export class DocumentOutputController {
  constructor(private readonly output: DocumentOutputService) {}

  @Endpoint(routes.documentOutput.file)
  file({ params, body }: RouteInput<Routes['file']>): Promise<RouteResponse<Routes['file']>> {
    return this.output.file(params.kind, params.id, body.language);
  }

  @Endpoint(routes.documentOutput.getFile)
  getFile({ params }: RouteInput<Routes['getFile']>): Promise<RouteResponse<Routes['getFile']>> {
    return this.output.getFile(params.kind, params.id, params.fileId);
  }

  @Endpoint(routes.documentOutput.emailDraft)
  emailDraft({
    params,
    query,
  }: RouteInput<Routes['emailDraft']>): Promise<RouteResponse<Routes['emailDraft']>> {
    return this.output.emailDraft(params.kind, params.id, query.language);
  }

  @Endpoint(routes.documentOutput.emails)
  emails({ params }: RouteInput<Routes['emails']>): Promise<RouteResponse<Routes['emails']>> {
    return this.output.emails(params.kind, params.id);
  }

  @Endpoint(routes.documentOutput.sendEmail)
  sendEmail({
    params,
    body,
  }: RouteInput<Routes['sendEmail']>): Promise<RouteResponse<Routes['sendEmail']>> {
    return this.output.sendEmail(params.kind, params.id, body);
  }

  @Endpoint(routes.documentOutput.shares)
  shares({ params }: RouteInput<Routes['shares']>): Promise<RouteResponse<Routes['shares']>> {
    return this.output.shares(params.kind, params.id);
  }

  // The link is in this answer only (decision 13): never kept by a cache
  @Endpoint(routes.documentOutput.createShare)
  @Header('Cache-Control', 'no-store')
  createShare({
    params,
    body,
  }: RouteInput<Routes['createShare']>): Promise<RouteResponse<Routes['createShare']>> {
    return this.output.createShare(params.kind, params.id, body.language);
  }

  @Endpoint(routes.documentOutput.revokeShare)
  revokeShare({ params }: RouteInput<Routes['revokeShare']>): Promise<void> {
    return this.output.revokeShare(params.kind, params.id, params.shareId);
  }
}

@Controller()
export class PublicDocumentsController {
  constructor(private readonly publicDocuments: PublicDocumentsService) {}

  // no-store, like the invitation lookup: the answer carries a signed download link, and a phone's
  // cache must not keep showing a link after it was turned off
  @Endpoint(routes.publicDocuments.get)
  @Header('Cache-Control', 'no-store')
  get({ params }: RouteInput<PublicRoutes['get']>): Promise<RouteResponse<PublicRoutes['get']>> {
    return this.publicDocuments.get(params.token);
  }
}
```

- **`Cache-Control: no-store` on two routes.** The new share link is shown once and must not sit in a cache. The
  public answer has a signed download link, and a phone's cache must not keep showing a document after its link was
  turned off.

```ts
import { Module } from '@nestjs/common';

import { RbacModule } from '../rbac/rbac.module.js';
import { SalesModule } from '../sales/sales.module.js';
import {
  DocumentOutputController,
  PublicDocumentsController,
} from './document-output.controller.js';
import { DocumentOutputService } from './document-output.service.js';
import { DocumentFiles } from './files.js';
import { DocumentModels } from './models.service.js';
import { PublicDocumentsService } from './public-documents.service.js';

// Step 16: a document goes out — its PDF, an email, a share link and the public page behind it.
// SalesModule gives the four services whose get() the PDF's model is built from (the same reads
// as the document's page), RbacModule the PermissionService behind the send permission. The
// worker's half (drawing, sending) is in file.handler.ts and email.handler.ts.
@Module({
  imports: [SalesModule, RbacModule],
  controllers: [DocumentOutputController, PublicDocumentsController],
  providers: [DocumentModels, DocumentFiles, DocumentOutputService, PublicDocumentsService],
})
export class DocumentsModule {}
```

```diff
@@ -79,5 +79,8 @@ import { SalesReturnsService } from './sales-returns.service.js';
     RefundsService,
     SalesAccountsService,
   ],
+  // Step 16: the PDF of a quotation, an invoice, a receipt or a credit note is built from what
+  // their get() returns (documents/models.service.ts)
+  exports: [QuotationsService, InvoicesService, ReceiptsService, CreditNotesService],
 })
 export class SalesModule {}
```

- **SalesModule exports the four services.** Until now nothing outside sales needed them.

```diff
@@ -14,6 +14,7 @@ import { AuthMiddleware } from './auth/auth.middleware.js';
 import { AuthModule } from './auth/auth.module.js';
 import { BranchesModule } from './branches/branches.module.js';
 import { CustomFieldsModule } from './custom-fields/custom-fields.module.js';
+import { DocumentsModule } from './documents/documents.module.js';
 import { ContractInterceptor } from './common/http/contract.interceptor.js';
 import { ProblemFilter } from './common/http/problem.filter.js';
 import { RequestContextMiddleware } from './common/request/request-context.js';
@@ -65,6 +66,7 @@ export class AppModule implements NestModule {
         InventoryModule,
         TaxModule,
         SalesModule,
+        DocumentsModule,
       ],
       controllers: [HealthController, ...(config.exposeDocs ? [DocsController] : [])],
       providers: [
```

### The worker: drawing a file

```ts
import { Inject, Injectable } from '@nestjs/common';
import { documentFiles } from '@omnivo/db';
import { and, eq, ne } from 'drizzle-orm';

import { PermanentJobError } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { StorageService } from '../storage/storage.service.js';
import { type FileRow, storageKeyOf } from './files.js';
import { type DocumentModel, documentModelSchema } from './model.js';
import { writeDocumentPdf } from './pdf.js';

const PDF = 'application/pdf';

// The model as stored. jsonb is data from outside this code (an older API wrote it), so it is
// parsed, not cast. One this worker cannot read will not read on a retry either: a permanent
// failure, and the next request writes a new row with a model of today's shape.
export function modelOf(row: FileRow): DocumentModel {
  const parsed = documentModelSchema.safeParse(row.model);
  if (!parsed.success) {
    throw new PermanentJobError(`Document file ${row.id} has a model this worker cannot read`);
  }
  return parsed.data;
}

// The worker's half of a PDF, shared by the file job and the email job: read a row, and draw,
// store and finish it. Runs inside the event's tenant context, like every handler.
@Injectable()
export class DocumentFileMaker {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly storage: StorageService,
  ) {}

  async load(fileId: string): Promise<FileRow> {
    const [row] = await this.withTenant((tx) =>
      tx
        .select()
        .from(documentFiles)
        .where(and(eq(documentFiles.tenantId, getTenantId()), eq(documentFiles.id, fileId))),
    );
    // A file row is a cache and may have been cleaned away: nothing a retry could fix
    if (!row) throw new PermanentJobError('The document file no longer exists');
    return row;
  }

  // The PDF's bytes: the stored file when it is ready, else drawn now
  async bytes(row: FileRow): Promise<Uint8Array> {
    if (row.status === 'ready' && row.storageKey !== null) {
      const stored = await this.storage.get(row.storageKey);
      if (stored !== null) return stored;
      // The object is missing from storage although the row is ready (removed by hand). The row
      // cannot change, so the same file goes back under the same key.
      const bytes = await this.draw(row);
      await this.storage.put(row.storageKey, bytes, PDF);
      return bytes;
    }
    return this.make(row);
  }

  // Draws the row's model, stores it under the row's key and marks the row ready. A second run (a
  // retry, or the file job and the email job at the same moment) writes the same object again, and
  // `status <> 'ready'` lets only the first update through. A failed row is finished too: the
  // email job may draw a file whose own job gave up.
  async make(row: FileRow): Promise<Uint8Array> {
    const bytes = await this.draw(row);
    const key = storageKeyOf(row);
    await this.storage.put(key, bytes, PDF);
    await this.withTenant((tx) =>
      tx
        .update(documentFiles)
        .set({
          status: 'ready',
          fileName: modelOf(row).fileName,
          contentType: PDF,
          sizeBytes: bytes.byteLength,
          storageKey: key,
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(documentFiles.tenantId, getTenantId()),
            eq(documentFiles.id, row.id),
            ne(documentFiles.status, 'ready'),
          ),
        ),
    );
    return bytes;
  }

  private async draw(row: FileRow): Promise<Uint8Array> {
    const model = modelOf(row);
    // The logo's object, read outside any transaction. Gone from storage = a PDF without it.
    const logo =
      model.company.logo === null ? null : await this.storage.get(model.company.logo.key);
    return writeDocumentPdf(model, logo);
  }
}
```

- **`modelOf()` parses the stored model** with the Zod schema, never casts it. A model this worker cannot read (an
  older shape) fails for good (`PermanentJobError`): a retry would read the same row. The next request makes a new
  row in today's shape anyway, because its fingerprint differs.
- **`make()` draws, stores, then marks the row ready,** in that order. If the worker dies after the upload, the row
  is still pending and the retry draws it again under the same key. `status <> 'ready'` lets only the first of two
  racing jobs (the file job and the email job) update the row; a ready row cannot change anyway (16.2).
- **A failed row can become ready.** The email job may draw a file whose own job already gave up.
- **`bytes()` repairs a missing object.** If someone removed the file from storage by hand, the row is still ready
  and cannot change, so the same drawing goes back under the same key.
- **The logo is read outside any transaction:** no database connection waits on storage.

```ts
import { Inject, Injectable } from '@nestjs/common';
import { documentFiles } from '@omnivo/db';
import { and, eq } from 'drizzle-orm';

import type { EventHandler, OutboxEvent } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { DocumentFileMaker } from './file-maker.js';

type Event = OutboxEvent<'document.file_requested'>;

// Draws a document's PDF (step 16). Nobody is told when it is done: the page that asked polls the
// file (decision 5), and a link's page asks again on its own.
@Injectable()
export class DocumentFileHandler implements EventHandler<'document.file_requested'> {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly maker: DocumentFileMaker,
  ) {}

  async handle(event: Event): Promise<void> {
    const row = await this.maker.load(event.payload.fileId);
    // Done already: a second run of this job, or the email job drew it first
    if (row.status === 'ready') return;
    await this.maker.make(row);
  }

  // After the last attempt the row says "failed", so the waiting page stops and offers Retry,
  // which asks again (decision 19). No bell: the person is looking at the page.
  async onGiveUp(event: Event): Promise<void> {
    await this.withTenant((tx) =>
      tx
        .update(documentFiles)
        .set({ status: 'failed', finishedAt: new Date() })
        .where(
          and(
            eq(documentFiles.tenantId, getTenantId()),
            eq(documentFiles.id, event.payload.fileId),
            eq(documentFiles.status, 'pending'),
          ),
        ),
    );
  }
}
```

- **No bell, ever** (decision 5): the person is looking at the page, which polls. After the last attempt the row says
  `failed`, and the page offers to try again.

### The worker: sending an email

```ts
import { Inject, Injectable } from '@nestjs/common';
import { documentEmails, tenantSettings, users } from '@omnivo/db';
import { and, eq } from 'drizzle-orm';

import { type EventHandler, type OutboxEvent, PermanentJobError } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { documentEmail } from '../mail/document-email.js';
import { MailService } from '../mail/mail.service.js';
import { notify } from '../notifications/notify.js';
import { DocumentFileMaker, modelOf } from './file-maker.js';

type Event = OutboxEvent<'document.email_requested'>;

// Sends a document email with its PDF attached (step 16). The PDF is drawn here when it is not
// ready yet, rather than waiting on the file job in the other queue: the email never waits for a
// job that may be stuck behind a big import.
@Injectable()
export class DocumentEmailHandler implements EventHandler<'document.email_requested'> {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly mail: MailService,
    private readonly maker: DocumentFileMaker,
  ) {}

  async handle(event: Event): Promise<void> {
    const tenantId = getTenantId();
    // 1) What to send, who sent it, and where replies go, in one short transaction
    const context = await this.withTenant(async (tx) => {
      const [email] = await tx
        .select({ email: documentEmails, sender: users.fullName })
        .from(documentEmails)
        .innerJoin(users, eq(users.id, documentEmails.sentBy))
        .where(
          and(eq(documentEmails.tenantId, tenantId), eq(documentEmails.id, event.payload.emailId)),
        );
      if (!email) throw new PermanentJobError('The document email no longer exists');
      // Sent already (this job ran before) or given up: nothing to do
      if (email.email.status !== 'pending') return null;
      const [settings] = await tx
        .select({ email: tenantSettings.email })
        .from(tenantSettings)
        .where(eq(tenantSettings.tenantId, tenantId));
      return { ...email, replyTo: settings?.email ?? null };
    });
    if (!context) return;

    // 2) The PDF, then the email, outside any transaction: drawing and a slow mail server hold no
    //    database lock. If sending throws, the queue tries again later.
    const file = await this.maker.load(event.payload.fileId);
    const model = modelOf(file);
    const bytes = await this.maker.bytes(file);
    const { email } = context;
    await this.mail.send(
      documentEmail({
        to: email.to,
        cc: email.cc,
        subject: email.subject,
        message: email.message,
        language: email.language,
        // The name on the PDF's header, so the email and its attachment say the same company
        company: model.company.name,
        sender: context.sender,
        replyTo: context.replyTo,
        file: { name: model.fileName, bytes },
      }),
    );

    // 3) Sent. A crash between 2 and 3 sends the email again on the retry: the customer may get it
    //    twice, which is better than never (the mail server gives no way to ask "did it arrive?").
    await this.withTenant((tx) =>
      tx
        .update(documentEmails)
        .set({ status: 'sent', sentAt: new Date() })
        .where(
          and(
            eq(documentEmails.tenantId, tenantId),
            eq(documentEmails.id, email.id),
            eq(documentEmails.status, 'pending'),
          ),
        ),
    );
  }

  // After the last retry: the history says "Failed", and the person who pressed Send hears it in
  // the bell (decision 6): they have probably left the page.
  async onGiveUp(event: Event): Promise<void> {
    const tenantId = getTenantId();
    // The document's number for the bell's text, from the PDF's model. A row this worker cannot
    // read still fails the email; the bell then says only which kind of document.
    const number = await this.maker
      .load(event.payload.fileId)
      .then((file) => modelOf(file).number)
      .catch(() => '');
    await this.withTenant(async (tx) => {
      const [failed] = await tx
        .update(documentEmails)
        .set({ status: 'failed' })
        .where(
          and(
            eq(documentEmails.tenantId, tenantId),
            eq(documentEmails.id, event.payload.emailId),
            eq(documentEmails.status, 'pending'),
          ),
        )
        .returning({
          sentBy: documentEmails.sentBy,
          kind: documentEmails.kind,
          documentId: documentEmails.documentId,
        });
      if (!failed) return;
      await notify(tx, {
        userId: failed.sentBy,
        type: 'document.email_failed',
        // id: a click on the bell opens the document's page
        params: { document: failed.kind, id: failed.documentId, number },
        eventId: event.id,
      });
    });
  }
}
```

- **Three steps, like the invitation email:** read in one short transaction, send outside any transaction, then mark
  it sent. A slow mail server holds no database lock.
- **`status <> 'pending'` ends the job early.** A retry after the email was marked sent sends nothing again.
- **A crash between sending and marking sends it twice.** The comment says why that is accepted: SMTP has no way to
  ask "did that one arrive?", and a duplicate invoice email is better than none.
- **The company's name comes from the PDF's model,** so the email's sender name and the attachment's header always
  agree, even if the company was renamed in between.
- **The reply-to is read at send time** from the settings: the company's current email.
- **`onGiveUp()` rings the bell of the person who pressed Send** (decision 6), with the document's kind, id and
  number. The id comes back from the same `UPDATE … RETURNING`, so the bell can open the document's page.
  If the file row is gone or unreadable, the bell still rings, with an empty number: telling the person matters more
  than the detail.

```ts
import type { LanguageCode } from '@omnivo/contracts';

import { DOCUMENT_COPY } from '../documents/copy.js';
import { emailHtml, emailText } from './layout.js';
import type { MailMessage } from './mail.service.js';

interface DocumentEmailInput {
  to: readonly string[];
  cc: readonly string[];
  subject: string;
  // As the person wrote it in the dialog
  message: string;
  language: LanguageCode;
  company: string;
  sender: string;
  // The company's own email; null when the settings have none
  replyTo: string | null;
  file: { name: string; bytes: Uint8Array };
}

// The email a company sends with a document's PDF (step 16). The person's message comes first,
// exactly as typed (escaped by the frame). Under it, lines the person cannot change: what is
// attached and who sent it, so a customer can always tell a real invoice from a forged one, and
// how to reply.
export function documentEmail(input: DocumentEmailInput): MailMessage {
  const copy = DOCUMENT_COPY[input.language];
  const body = {
    language: input.language,
    heading: input.company,
    intro: input.message,
    button: null,
    footer: [
      copy.emailAttached(input.file.name),
      copy.emailSentBy(input.sender, input.company),
      // Without a company email the reply would go to our no-reply address: better to say nothing
      ...(input.replyTo === null ? [] : [copy.emailReply(input.company)]),
    ],
  };
  return {
    to: input.to,
    cc: input.cc,
    fromName: `${input.company} via Omnivo`,
    ...(input.replyTo !== null && { replyTo: input.replyTo }),
    subject: input.subject,
    text: emailText(body),
    html: emailHtml(body),
    attachments: [
      {
        filename: input.file.name,
        content: Buffer.from(input.file.bytes),
        contentType: 'application/pdf',
      },
    ],
  };
}
```

- **The person's message first, as typed;** the frame escapes it, so a message with `<script>` arrives as text.
- **The footer is the server's:** what is attached and who sent it, and how to reply only when the company has an
  email. Without one, a reply would go to our no-reply address, so it is better to say nothing.
- **From "Company via Omnivo", on our address.** Mail servers trust a sender only for a domain whose records
  (SPF, DKIM) allow it. An email "from" `accounts@rahman-textiles.com` sent by our server would land in spam or be
  refused. The company's name in the display name, and its own address as the reply-to, give the customer the same
  result.

```diff
@@ -13,8 +13,13 @@ export function escapeHtml(value: string): string {
 
 export interface EmailBody {
   language: LanguageCode;
+  // The name at the top. Omnivo's own emails leave it out; a document email (step 16) is the
+  // company's, so it carries the company's name.
+  heading?: string;
+  // Line breaks are kept (a document email's message is typed by a person). '' = no paragraph.
   intro: string;
-  button: { label: string; href: string };
+  // null: no button (a document email: the PDF is attached, there is nothing to click)
+  button: { label: string; href: string } | null;
   // Small grey lines under the button (how long the link works, why you got this)
   footer: string[];
 }
@@ -23,14 +28,23 @@ export interface EmailBody {
 // <style> blocks. Every text passes through escapeHtml here, so a template cannot forget it.
 export function emailHtml(body: EmailBody): string {
   const footer = body.footer.map(escapeHtml).join('<br>');
+  // Escaped first, then the line breaks: a <br> the escaping cannot touch, and nothing else
+  const intro =
+    body.intro === ''
+      ? ''
+      : `<p style="margin:0 0 24px;font-size:15px;line-height:1.5">${escapeHtml(body.intro).replaceAll('\n', '<br>')}</p>`;
+  const button =
+    body.button === null
+      ? ''
+      : `<a href="${escapeHtml(body.button.href)}" style="display:inline-block;padding:11px 16px;background:#1F47B5;color:#FFFFFF;border-radius:10px;font-weight:500;text-decoration:none">${escapeHtml(body.button.label)}</a>
+      `;
   return `<!doctype html>
 <html lang="${body.language}">
   <body style="margin:0;padding:32px 16px;background:#F6F7F9;font-family:'Segoe UI',system-ui,sans-serif;color:#0F1728">
     <div style="max-width:480px;margin:0 auto;padding:32px;background:#FFFFFF;border:1px solid #E4E7EC;border-radius:14px">
-      <p style="margin:0 0 24px;font-size:17px;font-weight:600">Omnivo</p>
-      <p style="margin:0 0 24px;font-size:15px;line-height:1.5">${escapeHtml(body.intro)}</p>
-      <a href="${escapeHtml(body.button.href)}" style="display:inline-block;padding:11px 16px;background:#1F47B5;color:#FFFFFF;border-radius:10px;font-weight:500;text-decoration:none">${escapeHtml(body.button.label)}</a>
-      <p style="margin:24px 0 0;font-size:13px;line-height:1.45;color:#475467">${footer}</p>
+      <p style="margin:0 0 24px;font-size:17px;font-weight:600">${escapeHtml(body.heading ?? 'Omnivo')}</p>
+      ${intro}
+      ${button}<p style="margin:24px 0 0;font-size:13px;line-height:1.45;color:#475467">${footer}</p>
     </div>
   </body>
 </html>
@@ -39,5 +53,10 @@ export function emailHtml(body: EmailBody): string {
 
 // The plain-text part, for mail apps (and spam filters) that do not show HTML
 export function emailText(body: EmailBody): string {
-  return `${body.intro}\n\n${body.button.label}: ${body.button.href}\n\n${body.footer.join('\n')}\n`;
+  const parts = [
+    body.intro,
+    body.button === null ? '' : `${body.button.label}: ${body.button.href}`,
+    body.footer.join('\n'),
+  ];
+  return `${parts.filter((part) => part !== '').join('\n\n')}\n`;
 }
```

- **`heading`**: our own emails say "Omnivo" at the top; a company's document email says the company.
- **`button` may be `null`.** A document email has nothing to click: the PDF is attached.
- **Line breaks in the intro survive.** The text is escaped first and only then are `\n`s turned into `<br>`, so the
  only HTML that can appear is the `<br>` we add. The invitation and welcome emails come out exactly as before.

```diff
@@ -4,11 +4,20 @@ import { createTransport } from 'nodemailer';
 import { CONFIG } from '../infra/tokens.js';
 
 export interface MailMessage {
-  to: string;
+  to: string | readonly string[];
+  // Step 16: a document email can copy a few more people in
+  cc?: readonly string[];
+  // Step 16: an email a company sends shows its name ("Rahman Textiles via Omnivo"), still from our
+  // own address: mail servers trust only a domain that is ours (SPF, DKIM), and an email "from"
+  // the customer's own domain would land in spam or be refused.
+  fromName?: string;
+  // Where the customer's reply goes: the company's own email, never our no-reply address
+  replyTo?: string;
   subject: string;
   // দুটোই: HTML না দেখানো মেইল-অ্যাপ (আর স্প্যাম ফিল্টার) শুধু-লেখার অংশ পড়ে
   text: string;
   html: string;
+  attachments?: readonly { filename: string; content: Buffer; contentType: string }[];
 }
 
 // Only the part of the config this service reads. The worker's CONFIG is a WorkerConfig, and a
@@ -23,9 +32,13 @@ interface MailConfig {
 export class MailService implements OnApplicationShutdown {
   private readonly transport: ReturnType<typeof createTransport>;
   private readonly from: string;
+  // The address part of MAIL_FROM ("Omnivo <no-reply@omnivo.app>" → "no-reply@omnivo.app"), for
+  // an email that goes out under another display name
+  private readonly fromAddress: string;
 
   constructor(@Inject(CONFIG) config: MailConfig) {
     this.from = config.mail.from;
+    this.fromAddress = /<([^<>]+)>\s*$/.exec(config.mail.from)?.[1] ?? config.mail.from.trim();
     // nodemailer's default connection timeout is 2 minutes. A job holds its queue lock for 30
     // seconds (BullMQ's lockDuration), so a slow mail server must fail well before that; the
     // queue then retries the job instead of thinking the worker died.
@@ -41,7 +54,16 @@ export class MailService implements OnApplicationShutdown {
   // job again later — that is the whole retry mechanism, so nothing is swallowed here. Never log
   // the address or the body: an invitation email carries a link that lets you into a workspace.
   async send(message: MailMessage): Promise<void> {
-    await this.transport.sendMail({ from: this.from, ...message });
+    const { fromName, to, cc, attachments, ...rest } = message;
+    await this.transport.sendMail({
+      ...rest,
+      // The object form: nodemailer quotes a name with a comma or quotes in it ("Rahman & Sons,
+      // Ltd."), which a hand-built "Name <address>" string would break
+      from: fromName === undefined ? this.from : { name: fromName, address: this.fromAddress },
+      to: typeof to === 'string' ? to : [...to],
+      ...(cc !== undefined && cc.length > 0 && { cc: [...cc] }),
+      ...(attachments !== undefined && { attachments: [...attachments] }),
+    });
   }
 
   onApplicationShutdown(): void {
```

- **`from` as an object** when a display name is given. nodemailer then quotes a name with a comma or quotes in it
  ("Rahman & Sons, Ltd."), which a hand-built `"Name <address>"` string would break.
- **`fromAddress`** is the address part of `MAIL_FROM`, read once.
- **`cc` only when it has addresses:** an empty `Cc:` header is not wrong, but some mail programs show it.

### Wiring the events

```diff
@@ -34,6 +34,11 @@ export const outboxPayloadSchemas = {
   'workspace.stock_accounts_requested': z.object({}),
   // Like the chart's: the rates are the same for every workspace (step 15a)
   'workspace.tax_rates_requested': z.object({}),
+  // Step 16: the document_files row holds the look to draw (its model)
+  'document.file_requested': z.object({ fileId: z.uuid() }),
+  // The document_emails row says what to send; the file is the PDF to attach, drawn by the email
+  // job itself when it is not ready yet (the customer should not wait on a second queue)
+  'document.email_requested': z.object({ emailId: z.uuid(), fileId: z.uuid() }),
 } satisfies Record<OutboxEventType, z.ZodObject>;
 
 export type OutboxPayload<T extends OutboxEventType> = z.output<(typeof outboxPayloadSchemas)[T]>;
```

- **The payloads are ids only,** as the rule at the top of the file says. The email's subject, message and addresses
  stay in `document_emails`, never in the outbox or in Redis.

```diff
@@ -15,6 +15,7 @@ export type QueueName = (typeof QUEUE_NAMES)[number];
 const QUEUE_OF = {
   'workspace.created': 'email',
   'invitation.issued': 'email',
+  'document.email_requested': 'email',
   'workspace.setup_requested': 'jobs',
   'member.joined': 'jobs',
   'workspace.chart_requested': 'jobs',
@@ -24,6 +25,7 @@ const QUEUE_OF = {
   'stock.below_reorder': 'jobs',
   'workspace.stock_accounts_requested': 'jobs',
   'workspace.tax_rates_requested': 'jobs',
+  'document.file_requested': 'jobs',
 } satisfies Record<OutboxEventType, QueueName>;
 
 // The hourly maintenance job. Not an outbox event: no request asks for it, a scheduler adds it.
```

- **The email goes on the `email` queue,** with the other emails, so a slow mail server never holds up drawing
  PDFs or setting up a workspace. The file goes on `jobs`.

```diff
@@ -2,6 +2,8 @@ import { Injectable } from '@nestjs/common';
 import type { OutboxEventType } from '@omnivo/db';
 
 import type { EventHandler } from '../common/outbox/outbox.js';
+import { DocumentEmailHandler } from '../documents/email.handler.js';
+import { DocumentFileHandler } from '../documents/file.handler.js';
 import { LowStockHandler } from '../inventory/low-stock.handler.js';
 import { InvitationEmailHandler } from '../invitations/invitation-email.handler.js';
 import { MemberJoinedHandler } from '../invitations/member-joined.handler.js';
@@ -36,6 +38,8 @@ export class EventHandlers {
     lowStock: LowStockHandler,
     stockAccounts: StockAccountsHandler,
     taxRates: TaxRatesHandler,
+    documentFile: DocumentFileHandler,
+    documentEmail: DocumentEmailHandler,
   ) {
     this.byType = {
       'workspace.created': welcome,
@@ -49,6 +53,8 @@ export class EventHandlers {
       'stock.below_reorder': lowStock,
       'workspace.stock_accounts_requested': stockAccounts,
       'workspace.tax_rates_requested': taxRates,
+      'document.file_requested': documentFile,
+      'document.email_requested': documentEmail,
     };
   }
 
```

```diff
@@ -2,6 +2,9 @@ import { type DynamicModule, Inject, Module, type OnApplicationShutdown } from '
 import { createDb, type Db } from '@omnivo/db';
 
 import { createWithTenant } from '../common/tenant/with-tenant.js';
+import { DocumentEmailHandler } from '../documents/email.handler.js';
+import { DocumentFileHandler } from '../documents/file.handler.js';
+import { DocumentFileMaker } from '../documents/file-maker.js';
 import type { WorkerConfig } from '../config.js';
 import { CONFIG, DB, RELAY_DB, STORAGE_CONFIG, WITH_TENANT } from '../infra/tokens.js';
 import { LowStockHandler } from '../inventory/low-stock.handler.js';
@@ -64,6 +67,10 @@ export class WorkerModule implements OnApplicationShutdown {
         LowStockHandler,
         StockAccountsHandler,
         TaxRatesHandler,
+        // Step 16: the PDF (drawn from the model the API stored) and the email it goes out with
+        DocumentFileMaker,
+        DocumentFileHandler,
+        DocumentEmailHandler,
       ],
     };
   }
```

- **The worker gets the maker and the two handlers, nothing from sales.** That is decision 22 paying off: the worker
  module needs no journal, no stock posting, no Redis permission cache.

### The customer's document language

```diff
@@ -326,6 +326,7 @@ export class CustomersService {
       contactPerson: input.contactPerson,
       phone: input.phone,
       email: input.email,
+      documentLanguage: input.documentLanguage,
       bin: input.bin,
       paymentTermsDays: input.paymentTermsDays,
       creditLimit: input.creditLimit,
@@ -478,6 +479,7 @@ export class CustomersService {
       contactPerson: party.contactPerson,
       phone: party.phone,
       email: party.email,
+      documentLanguage: party.documentLanguage,
       bin: party.bin,
       paymentTermsDays: party.paymentTermsDays,
       creditLimit: party.creditLimit,
```

```diff
@@ -82,6 +82,7 @@ function customerForm(name: string, extra: Partial<CustomerFormValues> = {}): Cu
     contactPerson: '',
     phone: '',
     email: '',
+    documentLanguage: 'en',
     bin: '',
     paymentTermsDays: 30,
     creditLimit: '',
@@ -101,6 +102,7 @@ function formOf(customer: Customer, extra: Partial<CustomerFormValues> = {}) {
     contactPerson: customer.contactPerson ?? '',
     phone: customer.phone ?? '',
     email: customer.email ?? '',
+    documentLanguage: customer.documentLanguage,
     bin: customer.bin ?? '',
     paymentTermsDays: customer.paymentTermsDays,
     creditLimit: customer.creditLimit ?? '',
```

- The integration test's form helpers send the language too, as the form will (16.6). Its own test comes in 16.4.

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/db build
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api test
pnpm lint
```

The API and the worker type-check, and the API's unit tests pass (88, among them the route test from 16.1, which now
finds a controller for every route). The app still does not type-check: it learns `documentLanguage` and the new
words in 16.5 and 16.6.

> **What we checked.** We drew hand-written sample models (an invoice of 34 lines over three pages, and a money
> receipt) in English and Bangla, and looked at them as pictures: the table head repeats on every page, no row breaks
> across pages, the totals, the amount in words and the signature lines stay together, a long Bangla description wraps
> to a second line, and ৳ and Bangla digits sit level with Latin text. We drew the clusters ক্ত, ন্দ্র, ন্ত্র, স্ত্র,
> ষ্ট্র, স্প্র, ঙ্ক্ষ, দ্ভ, ন্ধ্য, ল্ল and ক্ষ with Noto Sans Bengali, Hind Siliguri, Anek Bangla and Tiro Bangla,
> next to the macOS reference font: only Noto broke (ন্দ্র). The models built from real documents, the routes, the
> jobs and the email are tested against a real database, storage and mail server in 16.4.

---

## 16.4 — `apps/api`: the tests

This part adds two integration test files and four unit test files, and changes a few old ones:

1. Six old test files learn the customer's `documentLanguage` (16.1 made it required), and `customers.int.spec.ts`
   tests it.
2. The Mailpit helper reads more of an email: the sender's name, Cc, Reply-To and the attachments.
3. `documents/document-output.int.spec.ts` runs the whole way of a document with the real API, the real worker, a
   real MinIO and a real Mailpit.
4. `documents/documents.tenant-leak.int.spec.ts` checks that one workspace never reaches another's files, emails or
   links, and that a share token shows exactly one row.
5. Unit tests for the drawing (`pdf.spec.ts`), the text wrapping (`text.spec.ts`), the fingerprint and the stored
   model (`model.spec.ts`), and the email (`document-email.spec.ts`).

**These tests found two small bugs in the 16.3 code**, and the code shown in 16.3 already has the fixes. The email's
last line said "Reply to this email to reach Meghna Distributors Ltd.." with two full stops; it now says "To reach
Meghna Distributors Ltd., reply to this email." And `wrap()` left an empty line after a word cut in a column
narrower than one letter.

### The old tests: the customer form has a language

16.1 made `documentLanguage` a required field of the customer form. Five test files that create customers send the
form by hand, so each gets one line. Without it, every customer they create is refused with a 400, and all their
tests fail in `beforeAll`.

```diff
@@ -206,6 +206,7 @@ async function addCustomer(name: string, extra: object = {}) {
     contactPerson: '',
     phone: '',
     email: '',
+    documentLanguage: 'en',
     bin: '',
     paymentTermsDays: 30,
     creditLimit: '',
```

```diff
@@ -221,6 +221,7 @@ async function addCustomer(name: string, extra: object = {}) {
     contactPerson: '',
     phone: '',
     email: '',
+    documentLanguage: 'en',
     bin: '',
     paymentTermsDays: 30,
     creditLimit: '',
```

```diff
@@ -175,6 +175,7 @@ async function addCustomer(name: string, extra: object = {}) {
     contactPerson: '',
     phone: '',
     email: '',
+    documentLanguage: 'en',
     bin: '',
     paymentTermsDays: 30,
     creditLimit: '',
```

```diff
@@ -319,6 +319,7 @@ describe('price lists', () => {
       contactPerson: '',
       phone: '',
       email: '',
+      documentLanguage: 'en',
       bin: '',
       paymentTermsDays: 15,
       creditLimit: '200000',
```

```diff
@@ -134,6 +134,7 @@ function customerForm(name: string, extra: object = {}) {
     contactPerson: '',
     phone: '',
     email: '',
+    documentLanguage: 'en',
     bin: '',
     paymentTermsDays: 30,
     creditLimit: '',
```

- **The tenant-leak file needs it most.** Its "cannot change B's customer" test expects a 404. Without the language,
  the form fails its check first and the answer is a 400: the test would fail, and for the wrong reason.

`customers.int.spec.ts` already sends the language since 16.3. Its new test:

```diff
@@ -488,6 +490,25 @@ describe('customers', () => {
     expect(old.items.map((item) => item.id)).toEqual([shop.id]);
     expect((await customer(shop.id)).name).toBe('Bongshal Tailors');
   });
+
+  it('keep the language their documents are sent in', async () => {
+    const shop = await addCustomer('Kaliganj Bazar Store', { documentLanguage: 'bn' });
+    expect(shop.documentLanguage).toBe('bn');
+    const changed = await send(
+      'PUT',
+      `/customers/${shop.id}`,
+      formOf(shop, { documentLanguage: 'en' }),
+    );
+    expect(customerSchema.parse(changed.json()).documentLanguage).toBe('en');
+
+    // Only a language the PDFs are written in
+    const unknown = await send('POST', '/customers', {
+      ...customerForm('Hindi Traders'),
+      documentLanguage: 'hi',
+    });
+    expect(unknown.statusCode).toBe(400);
+    expect(Object.keys(problemOf(unknown).fieldErrors ?? {})).toEqual(['documentLanguage']);
+  });
 });
 
 describe('customers in the books', () => {
```

- **The language is kept on create and on edit,** and the edit form sends back what the customer has
  (`formOf()` reads `customer.documentLanguage`).
- **Only `en` and `bn` are accepted.** The test checks only the field the error is under, not the error code:
  that code comes from Zod's enum check, and the form shows the field as wrong either way.

### Reading an email in Mailpit: `testing/mailpit.ts`

```diff
@@ -10,12 +10,33 @@ const mailboxSchema = z.object({
     }),
   ),
 });
-const messageSchema = z.object({ Text: z.string(), HTML: z.string() });
+// Mailpit writes an empty address list as null or [], depending on the header
+const addressesSchema = z
+  .array(z.object({ Address: z.string() }))
+  .nullable()
+  .transform((list) => (list ?? []).map((item) => item.Address));
+const messageSchema = z.object({
+  // SMTP ends lines with \r\n; the tests write \n
+  Text: z.string().transform((text) => text.replaceAll('\r\n', '\n')),
+  HTML: z.string(),
+  From: z.object({ Name: z.string(), Address: z.string() }),
+  Cc: addressesSchema,
+  ReplyTo: addressesSchema,
+  Attachments: z
+    .array(z.object({ PartID: z.string(), FileName: z.string(), ContentType: z.string() }))
+    .nullable()
+    .transform((list) => list ?? []),
+});
 
 export interface Mail {
+  id: string;
   subject: string;
   text: string;
   html: string;
+  from: { name: string; address: string };
+  cc: string[];
+  replyTo: string[];
+  attachments: { partId: string; fileName: string; contentType: string }[];
 }
 
 // The newest email to this address (Mailpit lists newest first). Throws when there is none yet —
@@ -27,7 +48,31 @@ export async function lastMailTo(apiUrl: string, address: string): Promise<Mail>
   const message = messageSchema.parse(
     await (await fetch(`${apiUrl}/api/v1/message/${found.ID}`)).json(),
   );
-  return { subject: found.Subject, text: message.Text, html: message.HTML };
+  return {
+    id: found.ID,
+    subject: found.Subject,
+    text: message.Text,
+    html: message.HTML,
+    from: { name: message.From.Name, address: message.From.Address },
+    cc: message.Cc,
+    replyTo: message.ReplyTo,
+    attachments: message.Attachments.map((item) => ({
+      partId: item.PartID,
+      fileName: item.FileName,
+      contentType: item.ContentType,
+    })),
+  };
+}
+
+// The bytes of one attachment, as the customer's mail program would save it
+export async function attachmentOf(
+  apiUrl: string,
+  mail: Mail,
+  partId: string,
+): Promise<Uint8Array> {
+  const res = await fetch(`${apiUrl}/api/v1/message/${mail.id}/part/${partId}`);
+  if (!res.ok) throw new Error(`no part ${partId} in mail ${mail.id}`);
+  return new Uint8Array(await res.arrayBuffer());
 }
 
 export function invitationTokenOf(mail: Mail): string {
```

- **Four more fields:** the sender's name, Cc, Reply-To and the attachments. A document email is the first email
  whose sender name, reply address and attachment matter, so step 7's helper never needed them.
- **`addressesSchema` accepts `null`.** Mailpit writes an empty address list as `null` for some headers and `[]`
  for others. Both become an empty array, so a test simply compares lists.
- **The text's `\r\n` become `\n`.** Mail sent over SMTP ends every line with `\r\n`. A test that looks for
  `"Dear Rafiq,\n\nThe bill"` should not have to know that. The invitation tests read only a link from the text,
  so they do not change.
- **`attachmentOf()`** downloads one attachment, like a customer's mail program saving it. The test then checks
  that it really is a PDF, not only that something with the right name was attached.

### `documents/document-output.int.spec.ts` (new): the setup

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  createdShareSchema,
  type CreditNote,
  creditNoteSchema,
  type Customer,
  customerSchema,
  type DocumentFile,
  documentEmailDraftSchema,
  documentEmailListSchema,
  documentEmailSchema,
  documentFileSchema,
  documentShareListSchema,
  type DocumentShare,
  type Invoice,
  invoiceSchema,
  type LanguageCode,
  memberPageSchema,
  notificationPageSchema,
  type OutputDocument,
  type PermissionKey,
  type Product,
  type ProductFormValues,
  productSchema,
  problemSchema,
  publicDocumentSchema,
  type Quotation,
  quotationSchema,
  type Receipt,
  receiptSchema,
  roleSchema,
  settingsSchema,
  setupSchema,
  stockCardSchema,
  type TaxRate,
  taxRateListSchema,
  type Unit,
  unitListSchema,
  type Warehouse,
  warehouseListSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestApp,
  createTestWorker,
  eventually,
  testConfig,
  testWorkerConfig,
} from '../testing/app.js';
import {
  startMail,
  startPostgres,
  startRedis,
  startStorage,
  type TestMail,
  type TestPostgres,
  type TestRedis,
  type TestStorage,
} from '../testing/containers.js';
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { attachmentOf, lastMailTo } from '../testing/mailpit.js';
import { joinWithoutRoles } from '../testing/workspace.js';
import { type DocumentModel, documentModelSchema } from './model.js';
import { hashShareToken } from './share-token.js';

// Step 16: a distributor's invoice, quotation, money receipt and credit note go out as PDFs, by
// email and by a WhatsApp link. The real API, the real worker, a real MinIO for the files and a
// real Mailpit for the emails. Bhairab Bazar Traders reads its documents in Bangla. Each test
// builds on the ones before it: read the first failure first.
let pg: TestPostgres;
let redis: TestRedis;
let storage: TestStorage;
let mail: TestMail;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;
// A member with no role: reads every document, sends none
let viewer: SignedIn;
// A billing clerk: may send invoices, not quotations
let clerk: SignedIn;
let units: Unit[];
let accounts: Account[];
let rates: TaxRate[];
let main: Warehouse;
let juice: Product;
let napa: Product;
let carriage: Product;
let bhairab: Customer;
// Posted: juice, Napa from a batch, and the delivery charge
let invoice: Invoice;
let draftInvoice: Invoice;
let quotation: Quotation;
let receipt: Receipt;
let creditNote: CreditNote;
// The first PDF of the invoice, in English, before anything was paid
let firstFile: DocumentFile;
```

- **A distributor again,** like 15c: mango juice by the piece, Napa in batches (so the PDF has a batch and an expiry
  under the item), and a delivery charge that is a service.
- **Bhairab Bazar Traders reads its documents in Bangla,** with an email and a phone. The email fills the dialog's
  To box, and the phone becomes the WhatsApp number.
- **Three people:** the owner, a member with no role (reads everything, sends nothing), and a clerk who may send
  invoices but not quotations. Together they test that the send permission depends on the kind of document.
- **The tests build on each other,** like every sales test since 15b: the invoice is paid in one test and a credit
  note is posted in the next, and later tests read what that did. Read the first failure first.

```ts

function send(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  as: SignedIn | null = owner,
) {
  return app.inject({
    method,
    url,
    ...(as && { headers: bearer(as.accessToken) }),
    ...(payload && { payload }),
  });
}

function problemOf(res: Awaited<ReturnType<typeof send>>) {
  return problemSchema.parse(res.json());
}

function unitId(code: string): string {
  const found = units.find((unit) => unit.code === code);
  if (!found) throw new Error(`no unit ${code}`);
  return found.id;
}

function rateId(name: string): string {
  const found = rates.find((rate) => rate.name === name);
  if (!found) throw new Error(`no VAT rate ${name}`);
  return found.id;
}

function account(code: string): string {
  const found = accounts.find((item) => item.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

async function addProduct(name: string, extra: Partial<ProductFormValues> = {}) {
  const res = await send('POST', '/products', {
    code: '',
    name,
    type: 'goods',
    categoryId: '',
    description: '',
    baseUnitId: unitId('pcs'),
    salesUnitId: '',
    purchaseUnitId: '',
    tracking: 'none',
    hasExpiry: false,
    taxRateId: '',
    options: [],
    variants: [
      { id: null, sku: '', optionValues: [], barcode: '', salePrice: '', archived: false },
    ],
    units: [],
    customFields: {},
    ...extra,
  } satisfies ProductFormValues);
  expect(res.statusCode, res.body).toBe(201);
  return productSchema.parse(res.json());
}

// Opening stock by the piece, at a cost
function openingLine(product: Product, quantity: string, unitCost: string, extra: object = {}) {
  return {
    variantId: variantOf(product),
    unitId: unitId('pcs'),
    quantity,
    batchId: '',
    lotNumber: '',
    expiresOn: '',
    manufacturedOn: '',
    serialNumbers: [],
    unitCost,
    ...extra,
  };
}

// A sales line by the piece, at 15% VAT, no discount
function salesLine(product: Product, quantity: string, unitPrice: string, extra: object = {}) {
  return {
    variantId: variantOf(product),
    unitId: unitId('pcs'),
    quantity,
    description: '',
    unitPrice,
    discountType: 'percent',
    discount: '',
    taxRateId: rateId('VAT 15%'),
    ...extra,
  };
}

function invoiceLine(product: Product, quantity: string, unitPrice: string, extra: object = {}) {
  return {
    ...salesLine(product, quantity, unitPrice),
    deliveryLineId: '',
    orderLineId: '',
    batchId: '',
    serialNumbers: [],
    ...extra,
  };
}

async function invoiced(lines: object[], post: boolean): Promise<Invoice> {
  const res = await send('POST', '/invoices', {
    customerId: bhairab.id,
    date: '2026-10-06',
    dueDate: '',
    customerReference: '',
    branchId: main.branchId,
    warehouseId: main.id,
    note: '',
    lines,
    post,
  });
  expect(res.statusCode, res.body).toBe(201);
  return invoiceSchema.parse(res.json());
}

async function received(amount: string, applied: string): Promise<Receipt> {
  const res = await send('POST', '/receipts', {
    customerId: bhairab.id,
    date: '2026-10-07',
    amount,
    accountId: account('1110'),
    method: 'cash',
    reference: '',
    branchId: main.branchId,
    note: '',
    allocations: applied === '' ? [] : [{ invoiceId: invoice.id, amount: applied }],
  });
  expect(res.statusCode, res.body).toBe(201);
  return receiptSchema.parse(res.json());
}

async function credited(post: boolean): Promise<CreditNote> {
  const [line] = invoice.lines;
  if (!line) throw new Error('the invoice has no lines');
  const res = await send('POST', '/credit-notes', {
    invoiceId: invoice.id,
    date: '2026-10-08',
    reason: 'price_adjustment',
    note: '',
    lines: [
      {
        invoiceLineId: line.id,
        returnLineId: '',
        unitId: unitId('pcs'),
        quantity: '24',
        description: '',
        unitPrice: '1',
        discountType: 'percent',
        discount: '',
      },
    ],
    post,
  });
  expect(res.statusCode, res.body).toBe(201);
  return creditNoteSchema.parse(res.json());
}

async function quoted(): Promise<Quotation> {
  const res = await send('POST', '/quotations', {
    customerId: bhairab.id,
    date: '2026-10-01',
    validUntil: '2026-10-15',
    note: '',
    lines: [salesLine(juice, '240', '24')],
  });
  expect(res.statusCode, res.body).toBe(201);
  return quotationSchema.parse(res.json());
}
```

- **The forms are the same as in `invoices.int.spec.ts`,** cut down to what this file needs. Each helper checks the
  status first (`expect(res.statusCode, res.body)`), so a broken setup fails with the API's own answer, not with a
  Zod error about a missing field three lines later.
- **`credited()` is a price cut of ৳1 on 24 pieces of juice.** A price cut needs no goods back, so the credit note
  needs no return first.

```ts
function documentPath(kind: OutputDocument, id: string): string {
  return `/documents/${kind}/${id}`;
}

async function fileOf(
  kind: OutputDocument,
  id: string,
  language: LanguageCode,
  as = owner,
): Promise<DocumentFile> {
  const res = await send('POST', `${documentPath(kind, id)}/files`, { language }, as);
  expect(res.statusCode, res.body).toBe(200);
  return documentFileSchema.parse(res.json());
}

// Waits for the worker: the file as the page reads it while it polls
async function finished(kind: OutputDocument, id: string, fileId: string): Promise<DocumentFile> {
  return eventually(async () => {
    const res = await send('GET', `${documentPath(kind, id)}/files/${fileId}`);
    const file = documentFileSchema.parse(res.json());
    expect(file.status).not.toBe('pending');
    return file;
  }, 8_000);
}

async function downloaded(file: DocumentFile) {
  if (file.download === null) throw new Error(`file ${file.id} has no download link`);
  const res = await fetch(file.download.url);
  expect(res.status).toBe(200);
  return { res, bytes: new Uint8Array(await res.arrayBuffer()) };
}

function isPdf(bytes: Uint8Array): boolean {
  return new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-';
}

async function superuserSql<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(pg.superuserUrl, { max: 1, onnotice: () => undefined });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

// The page as the API wrote it on the row: what the worker draws
async function modelOf(fileId: string): Promise<DocumentModel> {
  const [row] = await superuserSql(
    (sql) => sql<{ model: unknown }[]>`SELECT model FROM document_files WHERE id = ${fileId}`,
  );
  return documentModelSchema.parse(row?.model);
}

async function jobsFor(fileId: string): Promise<number> {
  const [row] = await superuserSql(
    (sql) => sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM outbox_events
       WHERE type = 'document.file_requested' AND payload->>'fileId' = ${fileId}`,
  );
  return row?.count ?? 0;
}

async function sharesOf(kind: OutputDocument, id: string): Promise<DocumentShare[]> {
  return documentShareListSchema.parse(
    (await send('GET', `${documentPath(kind, id)}/shares`)).json(),
  ).items;
}

async function shared(kind: OutputDocument, id: string, language: LanguageCode) {
  const res = await send('POST', `${documentPath(kind, id)}/shares`, { language });
  expect(res.statusCode, res.body).toBe(201);
  expect(res.headers['cache-control']).toBe('no-store');
  return createdShareSchema.parse(res.json());
}

function tokenOf(url: string): string {
  const token = /\/d\/([\w-]{22})$/.exec(url)?.[1];
  if (!token) throw new Error(`no token in ${url}`);
  return token;
}

function opened(token: string) {
  return send('GET', `/public/documents/${token}`, undefined, null);
}

// The same worker, with the mail server or the storage switched off (or back on)
async function restartWorker(down: { mail?: boolean; storage?: boolean } = {}): Promise<void> {
  await worker.close();
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
      ...(down.mail !== true && { mailUrl: mail.smtpUrl }),
      ...(down.storage !== true && { storageUrl: storage.url }),
    }),
  );
}

// A user who signs up for a workspace of their own, then joins this one; with a role, if given
async function member(
  email: string,
  fullName: string,
  password: string,
  permissions: PermissionKey[] | null,
): Promise<SignedIn> {
  await signUp(app, {
    companyName: `${fullName} Store`,
    workspaceSlug: email.split('@')[0] ?? 'store',
    fullName,
    email,
    password,
  });
  await joinWithoutRoles(pg.superuserUrl, { email, workspace: 'meghna-distributors' });
  if (permissions !== null) {
    const made = await send('POST', '/roles', { name: 'Billing', description: '' });
    expect(made.statusCode, made.body).toBe(201);
    const role = roleSchema.parse(made.json());
    const matrix = await send('PUT', '/permission-matrix', {
      roles: [{ id: role.id, version: role.version, permissions }],
    });
    expect(matrix.statusCode, matrix.body).toBe(200);
    const { items } = memberPageSchema.parse((await send('GET', '/members')).json());
    const found = items.find((item) => item.email === email);
    if (!found) throw new Error(`${email} is not a member`);
    const assigned = await send('PUT', `/members/${found.membershipId}/roles`, {
      roleIds: [role.id],
      version: found.version,
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
  }
  return logIn(app, { workspace: 'meghna-distributors', email, password, keepSignedIn: false });
}
```

- **`finished()` polls the file's route,** exactly as the page will (16.6): until the status is no longer
  `pending`. It waits up to 8 seconds; drawing a PDF with its fonts takes well under one.
- **`modelOf()` reads the stored model with the superuser,** past the API. The model is the page as text (decision
  22), so a test can check every word on the PDF without reading the PDF itself. The PDF's text is compressed and
  cut into font runs; the model is plain JSON.
- **`jobsFor()` counts the outbox events of one file.** "A second click starts no second job" is a promise about
  the outbox, so the test counts the outbox.
- **`restartWorker()` switches the mail server or the storage off,** the way the invitation tests do: a worker
  whose address for it is dead (port 1). Every send or upload fails at once, the job gives up after its two quick
  tries, and the test sees what a real outage leaves behind.
- **`member()` is the 15c helper** with a role named "Billing".

```ts
beforeAll(async () => {
  [pg, redis, storage, mail] = await Promise.all([
    startPostgres(),
    startRedis(),
    startStorage(),
    startMail(),
  ]);
  app = await createTestApp(
    testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url, storageUrl: storage.url }),
  );
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
      mailUrl: mail.smtpUrl,
      storageUrl: storage.url,
    }),
  );
  owner = await signUp(app, {
    companyName: 'Meghna Distributors',
    workspaceSlug: 'meghna-distributors',
    fullName: 'Shafiq Ahmed',
    email: 'shafiq@meghnadistributors.com',
    password: 'Narsingdi-depot-2026',
  });
  expect((await send('POST', '/setup', { industry: 'distribution' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  units = unitListSchema.parse((await send('GET', '/units')).json()).items;
  rates = taxRateListSchema.parse((await send('GET', '/tax-rates')).json()).items;
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  const [first] = warehouseListSchema.parse((await send('GET', '/warehouses')).json()).items;
  if (!first) throw new Error('sign-up made no warehouse');
  main = first;

  // The header of every PDF, and the address customers' replies go to
  const settings = settingsSchema.parse((await send('GET', '/settings')).json());
  const saved = await send('PUT', '/settings', {
    version: settings.version,
    companyName: settings.companyName,
    legalName: 'Meghna Distributors Ltd.',
    bin: '000123456-0101',
    phone: '01711-000000',
    email: 'accounts@meghnadistributors.com',
    address: 'House 12, Road 4\nNarsingdi Sadar, Narsingdi',
    baseCurrency: settings.baseCurrency,
    fiscalYearStartMonth: settings.fiscalYearStartMonth,
    timezone: settings.timezone,
    allowNegativeStock: settings.allowNegativeStock,
    pricesIncludeVat: false,
  });
  expect(saved.statusCode, saved.body).toBe(200);

  juice = await addProduct('Mango juice 250 ml');
  napa = await addProduct('Napa 500 mg', {
    tracking: 'batch',
    hasExpiry: true,
    taxRateId: rateId('Exempt'),
  });
  carriage = await addProduct('Delivery charge', { type: 'service' });
  const opening = await send('POST', '/stock-adjustments', {
    date: '2026-10-01',
    warehouseId: main.id,
    direction: 'in',
    reason: 'opening',
    note: '',
    post: true,
    lines: [
      openingLine(juice, '240', '18'),
      openingLine(napa, '120', '0.80', { lotNumber: 'NP24090', expiresOn: '2027-01-31' }),
    ],
  });
  expect(opening.statusCode, opening.body).toBe(201);
  const card = stockCardSchema.parse(
    (await send('GET', `/stock/variants/${variantOf(napa)}`)).json(),
  );
  const batch = card.batches.find((item) => item.lotNumber === 'NP24090');
  if (!batch) throw new Error('no Napa batch');

  const customer = await send('POST', '/customers', {
    code: '',
    name: 'Bhairab Bazar Traders',
    groupId: '',
    contactPerson: 'Rafiqul Islam',
    phone: '01712-334455',
    email: 'orders@bhairabbazar.com',
    documentLanguage: 'bn',
    bin: '',
    paymentTermsDays: 30,
    creditLimit: '',
    priceListId: '',
    notes: '',
    addresses: [
      {
        id: null,
        kind: 'billing',
        label: 'Head office',
        address: 'Station Road, Bhairab',
        phone: '',
      },
    ],
  });
  expect(customer.statusCode, customer.body).toBe(201);
  bhairab = customerSchema.parse(customer.json());

  invoice = await invoiced(
    [
      invoiceLine(juice, '24', '25'),
      invoiceLine(napa, '50', '1.2', { taxRateId: rateId('Exempt'), batchId: batch.batchId }),
      invoiceLine(carriage, '1', '500'),
    ],
    true,
  );
  draftInvoice = await invoiced([invoiceLine(carriage, '1', '300')], false);
  quotation = await quoted();

  viewer = await member('rina@meghnadistributors.com', 'Rina Akter', 'Counter-cash-2026', null);
  clerk = await member('tanvir@meghnadistributors.com', 'Tanvir Hasan', 'Billing-desk-2026', [
    'sales.invoice.manage',
  ]);
}, 180_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([
    pg.container.stop(),
    redis.container.stop(),
    storage.container.stop(),
    mail.container.stop(),
  ]);
});
```

- **Four containers:** Postgres, Valkey, MinIO and Mailpit. The worker gets the real mail server and the real
  storage; the API needs only the storage (it signs download links).
- **The settings fill the PDF's header:** a legal name, two address lines, the BIN, the phone, and the company email
  that becomes every email's reply-to address.
- **Opening stock first.** The invoice is a direct invoice (step 15c): it takes the juice and the Napa out of the
  warehouse on a challan of its own, so the stock must be there.
- **A draft invoice and a quotation** are made here too: later tests need them in several places.

### The PDF of a document

```ts
describe('the PDF of a document', () => {
  it('is drawn once per look, in the background, and downloaded by its link', async () => {
    firstFile = await fileOf('invoice', invoice.id, 'en');
    expect(firstFile).toMatchObject({ status: 'pending', download: null, language: 'en' });
    // A second click while it is drawn: the same row, and still one job
    const again = await fileOf('invoice', invoice.id, 'en');
    expect(again.id).toBe(firstFile.id);
    expect(await jobsFor(firstFile.id)).toBe(1);

    const ready = await finished('invoice', invoice.id, firstFile.id);
    expect(ready).toMatchObject({ status: 'ready', fileName: `${invoice.number ?? ''}.pdf` });
    const { res, bytes } = await downloaded(ready);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toContain(`${invoice.number ?? ''}.pdf`);
    expect(isPdf(bytes)).toBe(true);
    expect(bytes.byteLength).toBe(ready.sizeBytes);
    firstFile = ready;

    // Asked again once it is ready: the same file at once, with no new job
    const later = await fileOf('invoice', invoice.id, 'en');
    expect([later.id, later.status]).toEqual([firstFile.id, 'ready']);
    expect(await jobsFor(firstFile.id)).toBe(1);
  });

  it('writes the page as text: every line, the totals and the amount in words', async () => {
    const model = await modelOf(firstFile.id);
    expect(model).toMatchObject({
      language: 'en',
      title: 'Invoice',
      number: invoice.number,
      company: {
        name: 'Meghna Distributors Ltd.',
        lines: [
          'House 12, Road 4',
          'Narsingdi Sadar, Narsingdi',
          // Stored as digits only, as the NBR writes it
          'BIN 0001234560101',
          'Phone 01711-000000',
        ],
        logo: null,
      },
      party: {
        label: 'Bill to',
        name: 'Bhairab Bazar Traders',
        lines: ['Head office', 'Station Road, Bhairab'],
      },
      words: 'In words: One thousand three hundred twenty-five taka only',
      signatures: ['Customer’s signature', 'Authorised signature'],
    });
    expect(model.meta.slice(0, 3)).toEqual([
      { label: 'No.', value: invoice.number },
      { label: 'Date', value: '6 Oct 2026' },
      { label: 'Due date', value: '5 Nov 2026' },
    ]);
    expect(model.table?.rows.map((row) => row.cells)).toEqual([
      ['1', 'Mango juice 250 ml', '24 pcs', '৳25.00', '—', 'VAT 15%', '৳600.00'],
      ['2', 'Napa 500 mg', '50 pcs', '৳1.20', '—', 'Exempt', '৳60.00'],
      ['3', 'Delivery charge', '1 pcs', '৳500.00', '—', 'VAT 15%', '৳500.00'],
    ]);
    // Under the item: its SKU, the batch and expiry a pharmacy needs, and the challan the goods
    // left on. A direct invoice makes its own challan; the delivery charge, a service, has none.
    expect(model.table?.rows.map((row) => row.details)).toEqual([
      ['P-00001', 'From DC-2026-27-0001'],
      ['P-00002', 'Batch NP24090, expires 31 Jan 2027', 'From DC-2026-27-0001'],
      ['P-00003'],
    ]);
    // Nothing paid yet: no "Paid" or "Still due" rows
    expect(model.totals?.rows).toEqual([
      { label: 'Before VAT', value: '৳1,160.00', strong: false },
      { label: 'VAT', value: '৳165.00', strong: false },
      { label: 'Total', value: '৳1,325.00', strong: true },
    ]);
  });

  it('is written in the language asked for, a new file for each', async () => {
    const bangla = await fileOf('invoice', invoice.id, 'bn');
    expect(bangla.id).not.toBe(firstFile.id);
    const model = await modelOf(bangla.id);
    expect(model).toMatchObject({
      language: 'bn',
      title: 'ইনভয়েস',
      words: 'কথায়: এক হাজার তিনশত পঁচিশ টাকা মাত্র',
    });
    expect(model.totals?.rows.at(-1)).toEqual({ label: 'মোট', value: '৳১,৩২৫.০০', strong: true });
    expect(model.meta[1]).toEqual({ label: 'তারিখ', value: '৬ অক্টো, ২০২৬' });
    expect((await finished('invoice', invoice.id, bangla.id)).status).toBe('ready');
  });

  it('is a new file once the invoice is paid, with what is still due', async () => {
    receipt = await received('500', '500');
    const paid = await fileOf('invoice', invoice.id, 'en');
    expect(paid.id).not.toBe(firstFile.id);
    expect((await modelOf(paid.id)).totals?.rows.slice(-2)).toEqual([
      { label: 'Paid', value: '৳500.00', strong: false },
      { label: 'Still due', value: '৳825.00', strong: true },
    ]);
    // The first file stays as it was drawn: a ready file never changes
    const old = await finished('invoice', invoice.id, firstFile.id);
    expect([old.status, old.sizeBytes, old.finishedAt]).toEqual([
      'ready',
      firstFile.sizeBytes,
      firstFile.finishedAt,
    ]);
  });

  it('is drawn for all four documents, each with its own words', async () => {
    creditNote = await credited(true);
    const asked = await Promise.all(
      (
        [
          ['quotation', quotation.id],
          ['receipt', receipt.id],
          ['credit_note', creditNote.id],
        ] as const
      ).map(async ([kind, id]) => ({ kind, id, file: await fileOf(kind, id, 'en') })),
    );
    const [ofQuotation, ofReceipt, ofCreditNote] = await Promise.all(
      asked.map(({ file }) => modelOf(file.id)),
    );
    // A quotation is an offer: no amount in words
    expect(ofQuotation).toMatchObject({ title: 'Quotation', words: null });
    expect(ofQuotation?.meta.at(-1)).toEqual({ label: 'Valid until', value: '15 Oct 2026' });
    expect(ofReceipt).toMatchObject({
      title: 'Money receipt',
      words: 'In words: Five hundred taka only',
      facts: [
        { label: 'Amount received', value: '৳500.00' },
        { label: 'Paid by', value: 'Cash' },
      ],
      // All of it was applied: no advance row
      totals: null,
    });
    expect(ofReceipt?.table?.rows[0]?.cells).toEqual([
      invoice.number,
      '6 Oct 2026',
      '৳1,325.00',
      '৳500.00',
    ]);
    expect(ofCreditNote).toMatchObject({ title: 'Credit note' });
    expect(ofCreditNote?.meta.slice(2)).toEqual([
      { label: 'Original invoice', value: invoice.number },
      { label: 'Invoice date', value: '6 Oct 2026' },
      { label: 'Reason', value: 'Price cut' },
    ]);
    for (const { kind, id, file } of asked) {
      const ready = await finished(kind, id, file.id);
      expect(isPdf((await downloaded(ready)).bytes)).toBe(true);
    }
  }, 20_000);

  it('goes out only for a numbered document', async () => {
    const draftNote = await credited(false);
    const voided = await received('100', '');
    const voidRes = await send('POST', `/receipts/${voided.id}/void`, {
      version: voided.version,
      date: '2026-10-08',
      reason: 'Counted twice',
    });
    expect(voidRes.statusCode, voidRes.body).toBe(200);
    for (const [kind, id] of [
      ['invoice', draftInvoice.id],
      ['credit_note', draftNote.id],
      ['receipt', voided.id],
    ] as const) {
      const res = await send('POST', `${documentPath(kind, id)}/files`, { language: 'en' });
      expect(res.statusCode).toBe(409);
      expect(problemOf(res).code).toBe('document_not_issued');
    }
    // An id that is no invoice, and a kind that is no document
    const missing = await send('POST', `${documentPath('invoice', quotation.id)}/files`, {
      language: 'en',
    });
    expect(missing.statusCode).toBe(404);
    const strange = await send('POST', `/documents/sales_order/${invoice.id}/files`, {
      language: 'en',
    });
    expect(strange.statusCode).toBe(400);
  });

  it("answers 404 for a file of another document, even one of this workspace's", async () => {
    const res = await send(
      'GET',
      `${documentPath('quotation', quotation.id)}/files/${firstFile.id}`,
    );
    expect(res.statusCode).toBe(404);
  });

  it('is tried again on the same row after the worker gave up on it', async () => {
    await restartWorker({ storage: true });
    const asked = await fileOf('quotation', quotation.id, 'bn');
    expect((await finished('quotation', quotation.id, asked.id)).status).toBe('failed');

    await restartWorker();
    const retried = await fileOf('quotation', quotation.id, 'bn');
    expect([retried.id, retried.status]).toEqual([asked.id, 'pending']);
    expect(await jobsFor(asked.id)).toBe(2);
    expect((await finished('quotation', quotation.id, asked.id)).status).toBe('ready');
  }, 30_000);
});
```

- **"Drawn once per look":** the first request answers at once with `pending` and no download link; the second
  click gets the same row, and the outbox still has one job (16.2's unique index and `ON CONFLICT DO NOTHING`).
  Once it is ready, a third request gets the same file with no new job.
- **The download is checked like a browser would see it:** the type is `application/pdf`, the name is the
  invoice's number, the size is the row's `sizeBytes`, and the bytes start with `%PDF-`.
- **The model test is the PDF's content, word for word:** the company's lines (the BIN as stored, digits only),
  the billing address with its label, the number and the two dates, every cell of every line, what is under each item, and the
  totals. With a cell or a date in the wrong format, this test says exactly which.
- **Under each item:** the SKU, the batch with its expiry (`31 Jan 2027`), and the challan the goods left on. The
  direct invoice made challan DC-2026-27-0001 by itself; the delivery charge is a service, so nothing left the
  warehouse for it.
- **Bangla is a new file, in Bangla digits:** `৳১,৩২৫.০০`, `৬ অক্টো, ২০২৬`, and the amount in words from 16.1.
- **A payment makes a new file** (decision 18), with "Paid" and "Still due" under the total. The first file is
  still there and unchanged: the same size and the same `finishedAt`. A customer who downloaded it last week has the
  same file the server still keeps.
- **The four kinds each get a check of what is only theirs:** the quotation's "Valid until" and no amount in words
  (decision 7), the receipt's facts and the invoice it paid, the credit note's original invoice and its reason.
  The receipt applied all of its ৳500, so it has no "Kept as an advance" row.
- **"Only a numbered document goes out"** (decision 11): a draft invoice, a draft credit note and a voided receipt
  each answer 409 `document_not_issued`. The id of a quotation sent as an invoice is a 404, and `sales_order` is not
  a kind at all: 400.
- **A file id under the wrong document is a 404,** even when both are in this workspace.
- **A failed file is tried again on the same row** (decision 19). With the storage off, the job gives up and the
  row says `failed`. With the storage back, the next request gets the same row back as `pending`, with a second
  job, and it ends `ready`.

### Emailing a document

```ts
describe('emailing a document', () => {
  it('starts the dialog with the customer, a subject and a message in the language chosen', async () => {
    const english = documentEmailDraftSchema.parse(
      (await send('GET', `${documentPath('invoice', invoice.id)}/email-draft?language=en`)).json(),
    );
    expect(english).toEqual({
      to: 'orders@bhairabbazar.com',
      subject: `Invoice ${invoice.number ?? ''} from Meghna Distributors Ltd.`,
      message:
        'Dear Bhairab Bazar Traders,\n\n' +
        `Please find attached invoice ${invoice.number ?? ''} for ৳1,325.00, due on 5 Nov 2026.\n\n` +
        'Regards,\nShafiq Ahmed\nMeghna Distributors Ltd.',
    });
    const bangla = documentEmailDraftSchema.parse(
      (await send('GET', `${documentPath('invoice', invoice.id)}/email-draft?language=bn`)).json(),
    );
    expect(bangla.subject).toBe(`Meghna Distributors Ltd. থেকে ইনভয়েস ${invoice.number ?? ''}`);
  });

  it('sends the PDF from the company, with replies going to the company', async () => {
    const res = await send('POST', `${documentPath('invoice', invoice.id)}/emails`, {
      to: 'orders@bhairabbazar.com; Rafiq@BhairabBazar.com',
      cc: 'shafiq@meghnadistributors.com',
      subject: `Invoice ${invoice.number ?? ''}`,
      message: 'Dear Rafiq bhai,\n\nThe bill for <b>last week</b>.',
      language: 'en',
    });
    expect(res.statusCode, res.body).toBe(201);
    const email = documentEmailSchema.parse(res.json());
    expect(email).toMatchObject({
      // Lower case, as the mail server compares them
      to: ['orders@bhairabbazar.com', 'rafiq@bhairabbazar.com'],
      cc: ['shafiq@meghnadistributors.com'],
      status: 'pending',
      sentBy: { name: 'Shafiq Ahmed' },
      sentAt: null,
    });

    const sent = await eventually(() => lastMailTo(mail.apiUrl, 'rafiq@bhairabbazar.com'), 8_000);
    expect(sent).toMatchObject({
      subject: `Invoice ${invoice.number ?? ''}`,
      from: { name: 'Meghna Distributors Ltd. via Omnivo' },
      cc: ['shafiq@meghnadistributors.com'],
      replyTo: ['accounts@meghnadistributors.com'],
    });
    // The message as typed, the server's lines under it, and the HTML escaped
    expect(sent.text).toContain('Dear Rafiq bhai,\n\nThe bill for <b>last week</b>.');
    expect(sent.text).toContain(`Attached: ${invoice.number ?? ''}.pdf`);
    expect(sent.text).toContain(
      'Shafiq Ahmed sent this from Meghna Distributors Ltd. using Omnivo.',
    );
    expect(sent.text).toContain('To reach Meghna Distributors Ltd., reply to this email.');
    expect(sent.html).toContain(
      'Dear Rafiq bhai,<br><br>The bill for &lt;b&gt;last week&lt;/b&gt;.',
    );
    const [attachment] = sent.attachments;
    expect(attachment).toMatchObject({
      fileName: `${invoice.number ?? ''}.pdf`,
      contentType: 'application/pdf',
    });
    expect(isPdf(await attachmentOf(mail.apiUrl, sent, attachment?.partId ?? ''))).toBe(true);

    const history = await eventually(async () => {
      const { items } = documentEmailListSchema.parse(
        (await send('GET', `${documentPath('invoice', invoice.id)}/emails`)).json(),
      );
      expect(items[0]?.status).toBe('sent');
      return items;
    });
    expect(history.map((item) => item.id)).toEqual([email.id]);
    expect(history[0]?.sentAt).not.toBeNull();
  }, 20_000);

  it('checks the boxes, each error under its own box', async () => {
    const form = {
      to: 'orders@bhairabbazar.com',
      cc: '',
      subject: 'Invoice',
      message: '',
      language: 'en',
    };
    const cases = [
      [{ to: ' ' }, { to: ['email_to_required'] }],
      [{ to: 'orders@bhairabbazar' }, { to: ['email_invalid'] }],
      [{ cc: 'a@x.com, b@x.com, c@x.com, d@x.com, e@x.com, f@x.com' }, { cc: ['email_too_many'] }],
      [{ subject: '  ' }, { subject: ['email_subject_required'] }],
    ] as const;
    for (const [change, errors] of cases) {
      const res = await send('POST', `${documentPath('invoice', invoice.id)}/emails`, {
        ...form,
        ...change,
      });
      expect(res.statusCode).toBe(400);
      expect(problemOf(res).fieldErrors).toEqual(errors);
    }
  });

  it('fails when the mail server is down, and the bell tells the sender', async () => {
    await restartWorker({ mail: true });
    const res = await send(
      'POST',
      `${documentPath('invoice', invoice.id)}/emails`,
      {
        to: 'orders@bhairabbazar.com',
        cc: '',
        subject: 'Invoice',
        message: '',
        language: 'bn',
      },
      clerk,
    );
    expect(res.statusCode, res.body).toBe(201);
    const email = documentEmailSchema.parse(res.json());
    await eventually(async () => {
      const { items } = documentEmailListSchema.parse(
        (await send('GET', `${documentPath('invoice', invoice.id)}/emails`)).json(),
      );
      expect(items.find((item) => item.id === email.id)?.status).toBe('failed');
    }, 8_000);
    // The clerk pressed Send, so the clerk's bell rings, not the owner's
    const ofClerk = notificationPageSchema.parse(
      (await send('GET', '/notifications', undefined, clerk)).json(),
    );
    expect(ofClerk.items[0]).toMatchObject({
      type: 'document.email_failed',
      params: { document: 'invoice', id: invoice.id, number: invoice.number },
    });
    const ofOwner = notificationPageSchema.parse((await send('GET', '/notifications')).json());
    expect(ofOwner.items.map((item) => item.type)).not.toContain('document.email_failed');
    await restartWorker();
  }, 30_000);
});
```

- **The draft is in the language asked for,** whatever the language of the person's screen: the English and the
  Bangla subject differ, and the English message is checked in full, from "Dear" to the company's name.
- **The real email is read back from Mailpit:** the sender's name is "Meghna Distributors Ltd. via Omnivo", Cc and
  Reply-To are set, the PDF is attached and opens as a PDF. The two To addresses were typed with a semicolon and a
  capital letter; the API stored them lower case, which is how the history shows them.
- **The message arrives as typed:** its line breaks become `<br>` in the HTML part, and `<b>` arrives as text, not as
  bold. Under it, the three lines the server always adds.
- **The history says "sent"** once the worker has marked it, with the time.
- **Each box has its own error:** an empty To, an address with nothing after the domain name (`orders@bhairabbazar`), six CC addresses (the limit is five),
  and an empty subject.
- **With the mail server off,** the email ends `failed`, and the bell rings for the clerk who pressed Send, not for
  the owner (decision 6). The number in the bell's text comes from the PDF's model; the id is the invoice's, so a
  click on the bell opens it (16.6).

### Share links

```ts
describe('share links', () => {
  let token: string;

  it('are made for the customer, with a WhatsApp message to their number', async () => {
    const made = await shared('invoice', invoice.id, 'bn');
    token = tokenOf(made.url);
    expect(made.url).toBe(`http://localhost:5173/d/${token}`);
    expect(made.message).toContain(made.url);
    expect(made.message).toContain('লিংকটা ৩০ দিন কাজ করবে।');
    // 01712-334455 as WhatsApp wants it: the country code and the digits
    expect(made.whatsAppUrl).toBe(
      `https://wa.me/8801712334455?text=${encodeURIComponent(made.message)}`,
    );
    expect(made.share).toMatchObject({
      language: 'bn',
      createdBy: { name: 'Shafiq Ahmed' },
      revokedAt: null,
      firstOpenedAt: null,
    });
    // 30 days from now
    const days = (Date.parse(made.share.expiresAt) - Date.parse(made.share.createdAt)) / 86_400_000;
    expect(Math.round(days)).toBe(30);
    // Only the hash is kept: the token itself is nowhere in the table
    const [stored] = await superuserSql(
      (sql) => sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM document_shares
         WHERE token_hash = ${token} OR position(${token} IN token_hash) > 0`,
    );
    expect(stored?.count).toBe(0);
    expect((await sharesOf('invoice', invoice.id)).map((item) => item.id)).toEqual([made.share.id]);
  });

  it('open a page without a login, with the PDF in the link’s language', async () => {
    const res = await opened(token);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const page = publicDocumentSchema.parse(res.json());
    expect(page).toMatchObject({
      company: 'Meghna Distributors Ltd.',
      logoUrl: null,
      kind: 'invoice',
      number: invoice.number,
      date: '2026-10-06',
      customer: 'Bhairab Bazar Traders',
      total: invoice.total,
      currency: 'BDT',
      dueDate: '2026-11-05',
      language: 'bn',
    });
    // Paid ৳500 of ৳1,325, and the credit note took ৳27.60 off (৳24 and its VAT)
    expect(page.amountDue).toBe('797.4000');
    const ready = await eventually(async () => {
      const again = publicDocumentSchema.parse((await opened(token)).json());
      expect(again.file.status).toBe('ready');
      return again.file;
    }, 8_000);
    expect(ready.language).toBe('bn');
    expect(isPdf((await downloaded(ready)).bytes)).toBe(true);

    const [share] = await sharesOf('invoice', invoice.id);
    expect(share?.firstOpenedAt).not.toBeNull();
    expect(Date.parse(share?.lastOpenedAt ?? '')).toBeGreaterThan(
      Date.parse(share?.firstOpenedAt ?? ''),
    );
  });

  it('give one answer for an unknown, ended or turned-off link', async () => {
    // A link made 31 days ago, written past the API: the table lets no one move a link's dates
    const ended = 'Ended-link-0123456789A';
    await superuserSql(
      (sql) => sql`
        INSERT INTO document_shares (id, tenant_id, kind, document_id, language, token_hash,
                                     created_by, created_at, expires_at)
        SELECT gen_random_uuid(), tenant_id, kind, document_id, language,
               ${hashShareToken(ended)}, created_by, now() - interval '31 days',
               now() - interval '1 day'
          FROM document_shares WHERE token_hash = ${hashShareToken(token)}`,
    );
    const off = await shared('invoice', invoice.id, 'en');
    const revoked = await send(
      'POST',
      `${documentPath('invoice', invoice.id)}/shares/${off.share.id}/revoke`,
    );
    expect(revoked.statusCode).toBe(204);
    // Pressed twice: nothing more happens, and it is not an error
    const twice = await send(
      'POST',
      `${documentPath('invoice', invoice.id)}/shares/${off.share.id}/revoke`,
    );
    expect(twice.statusCode).toBe(204);

    const answers = await Promise.all(
      ['AAAAAAAAAAAAAAAAAAAAAA', ended, tokenOf(off.url)].map(opened),
    );
    for (const res of answers) {
      expect(res.statusCode).toBe(404);
      // The same body word for word, with nothing more in it; only the request's own id differs
      const problem = problemOf(res);
      expect(problem).toMatchObject({
        title: 'Not Found',
        status: 404,
        detail: 'This link does not work any more.',
        code: 'share_link_not_found',
      });
      expect(Object.keys(problem).toSorted()).toEqual([
        'code',
        'detail',
        'requestId',
        'status',
        'title',
      ]);
    }
    // A refused opening is not an opening
    const shares = await sharesOf('invoice', invoice.id);
    expect(shares.find((item) => item.id === off.share.id)?.firstOpenedAt).toBeNull();
  });

  it('stop working once the quotation is deleted or the receipt voided', async () => {
    const offer = await quoted();
    const ofOffer = await shared('quotation', offer.id, 'en');
    const money = await received('200', '');
    const ofMoney = await shared('receipt', money.id, 'en');
    expect((await opened(tokenOf(ofOffer.url))).statusCode).toBe(200);
    expect((await opened(tokenOf(ofMoney.url))).statusCode).toBe(200);

    const deleted = await send(
      'DELETE',
      `/quotations/${offer.id}?version=${String(offer.version)}`,
    );
    expect(deleted.statusCode, deleted.body).toBe(204);
    const voided = await send('POST', `/receipts/${money.id}/void`, {
      version: money.version,
      date: '2026-10-08',
      reason: 'Bounced cheque',
    });
    expect(voided.statusCode, voided.body).toBe(200);
    for (const url of [ofOffer.url, ofMoney.url]) {
      const res = await opened(tokenOf(url));
      expect(res.statusCode).toBe(404);
      expect(problemOf(res).code).toBe('share_link_not_found');
    }
  });

  it('are turned off only on their own document', async () => {
    const [share] = await sharesOf('invoice', invoice.id);
    const elsewhere = await send(
      'POST',
      `${documentPath('quotation', quotation.id)}/shares/${share?.id ?? ''}/revoke`,
    );
    expect(elsewhere.statusCode).toBe(404);
    // Still working
    expect((await opened(token)).statusCode).toBe(200);
  });
});
```

- **The link is the app's URL** with a 22-character token. The WhatsApp link has the customer's number as
  WhatsApp wants it (`01712-334455` becomes `8801712334455`) and the message, which says in Bangla that the link
  works for ৩০ days.
- **The token is nowhere in the database,** not as the hash and not inside it. Only the answer that made the link
  has it (decision 13).
- **The public page needs no login,** and says `no-store`. It shows what the customer needs to recognise the
  document. The amount due is ৳797.40: ৳1,325 less the ৳500 paid and the credit note's ৳27.60 (৳24 and its 15% VAT).
- **The PDF behind the link is drawn on demand,** in the link's language, and downloads. The link then shows when it
  was first and last opened.
- **Three dead links, one answer** (decision 14). An unknown token, a link 31 days old and a link that was turned
  off all get the same body, with no field that would tell them apart. The old link is written past the API: 16.2's
  guard lets no one move a link's dates, not even a test.
- **Turning a link off twice is fine** (204 both times), and a refused opening does not count as an opening.
- **A deleted quotation or a voided receipt ends its links,** though the links themselves were never turned off.
- **A link is turned off only under its own document.** Its id under the quotation's path is a 404, and the link
  still works.

### Who may send

```ts
describe('who may send', () => {
  it('needs the manage permission of the kind, but reading needs only a login', async () => {
    const [share] = await sharesOf('invoice', invoice.id);
    const asViewer = [
      send(
        'GET',
        `${documentPath('invoice', invoice.id)}/email-draft?language=en`,
        undefined,
        viewer,
      ),
      send(
        'POST',
        `${documentPath('invoice', invoice.id)}/emails`,
        { to: 'orders@bhairabbazar.com', cc: '', subject: 'Invoice', message: '', language: 'en' },
        viewer,
      ),
      send('POST', `${documentPath('invoice', invoice.id)}/shares`, { language: 'en' }, viewer),
      send(
        'POST',
        `${documentPath('invoice', invoice.id)}/shares/${share?.id ?? ''}/revoke`,
        undefined,
        viewer,
      ),
    ];
    for (const res of await Promise.all(asViewer)) {
      expect(res.statusCode).toBe(403);
      expect(problemOf(res)).toMatchObject({
        code: 'permission_missing',
        params: { permissions: 'sales.invoice.manage' },
      });
    }
    // The clerk sends invoices, not quotations
    const offer = await send(
      'POST',
      `${documentPath('quotation', quotation.id)}/shares`,
      { language: 'en' },
      clerk,
    );
    expect(problemOf(offer).params).toEqual({ permissions: 'sales.quotation.manage' });
    expect(
      (
        await send(
          'POST',
          `${documentPath('invoice', invoice.id)}/shares`,
          { language: 'en' },
          clerk,
        )
      ).statusCode,
    ).toBe(201);

    // Downloading and the history are reading: anyone signed in
    expect((await fileOf('invoice', invoice.id, 'en', viewer)).language).toBe('en');
    for (const list of ['emails', 'shares']) {
      const res = await send(
        'GET',
        `${documentPath('invoice', invoice.id)}/${list}`,
        undefined,
        viewer,
      );
      expect(res.statusCode).toBe(200);
    }
  });
});
```

- **The member with no role gets a 403 on the four routes that send something** (the draft, the email, the link and
  turning it off), with the permission named in `params`, like any route behind the permission guard.
- **The clerk may send invoices but not quotations:** the same route answers 201 for one kind and 403 (naming
  `sales.quotation.manage`) for the other. One route serves four kinds, so the check must depend on the kind
  (decision 9).
- **Downloading and the two histories need only a login** (decision 10). Anyone who can open the invoice on screen
  can download it.

### `documents/documents.tenant-leak.int.spec.ts` (new)

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  createdShareSchema,
  customerSchema,
  documentEmailListSchema,
  documentFileSchema,
  documentShareListSchema,
  invoiceSchema,
  productSchema,
  publicDocumentSchema,
  setupSchema,
  taxRateListSchema,
  unitListSchema,
  warehouseListSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
import { bearer, type SignedIn, signUp } from '../testing/http.js';
import { hashShareToken } from './share-token.js';

// Step 16's eight routes take a document's id in the path; the public route takes only a token.
// Tenant A, signed in with every permission of its own workspace, tries each of them on tenant
// B's invoice. Every answer must be a 404 or an empty list, never B's file, email, link or
// customer. The worker has no storage and no mail server: B's rows end up failed, which is all
// these tests need.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let tenantA: SignedIn;
let tenantB: SignedIn;
let invoiceOfB: string;
let fileOfB: string;
let shareOfB: string;
let tokenOfB: string;

function as(who: SignedIn | null, method: 'GET' | 'POST', url: string, payload?: object) {
  return app.inject({
    method,
    url,
    ...(who && { headers: bearer(who.accessToken) }),
    ...(payload && { payload }),
  });
}

// The body of a 201, or the failure with the API's own answer
function created(res: Awaited<ReturnType<typeof as>>): unknown {
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
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
  tenantA = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
  tenantB = await signUp(app, {
    companyName: 'Karim Pharma',
    workspaceSlug: 'karim-pharma',
    fullName: 'Karim Uddin',
    email: 'karim@karimpharma.com',
    password: 'Batch-expiry-2026',
  });
  // A medicine distributor: the pharma preset would ask every product for its generic name
  expect((await as(tenantB, 'POST', '/setup', { industry: 'distribution' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await as(tenantB, 'GET', '/setup')).json()).status).toBe('ready');
  });

  // B's invoice: a service, so no stock is needed, to a customer with an email and a phone
  const [pcs] = unitListSchema
    .parse((await as(tenantB, 'GET', '/units')).json())
    .items.filter((unit) => unit.code === 'pcs');
  const [rate] = taxRateListSchema.parse((await as(tenantB, 'GET', '/tax-rates')).json()).items;
  const [warehouse] = warehouseListSchema.parse(
    (await as(tenantB, 'GET', '/warehouses')).json(),
  ).items;
  if (!pcs || !rate || !warehouse) throw new Error('setup made no unit, VAT rate or warehouse');
  const service = productSchema.parse(
    created(
      await as(tenantB, 'POST', '/products', {
        code: '',
        name: 'Cold chain delivery',
        type: 'service',
        categoryId: '',
        description: '',
        baseUnitId: pcs.id,
        salesUnitId: '',
        purchaseUnitId: '',
        tracking: 'none',
        hasExpiry: false,
        taxRateId: '',
        options: [],
        variants: [
          { id: null, sku: '', optionValues: [], barcode: '', salePrice: '', archived: false },
        ],
        units: [],
        customFields: {},
      }),
    ),
  );
  const customer = customerSchema.parse(
    created(
      await as(tenantB, 'POST', '/customers', {
        code: '',
        name: 'Lazz Pharma, Kalabagan',
        groupId: '',
        contactPerson: '',
        phone: '01819-223344',
        email: 'purchase@lazzpharma.com',
        documentLanguage: 'en',
        bin: '',
        paymentTermsDays: 30,
        creditLimit: '',
        priceListId: '',
        notes: '',
        addresses: [],
      }),
    ),
  );
  const invoice = await as(tenantB, 'POST', '/invoices', {
    customerId: customer.id,
    date: '2026-10-06',
    dueDate: '',
    customerReference: '',
    branchId: warehouse.branchId,
    warehouseId: '',
    note: '',
    lines: [
      {
        variantId: service.variants[0]?.id,
        unitId: pcs.id,
        quantity: '1',
        description: '',
        unitPrice: '1500',
        discountType: 'percent',
        discount: '',
        taxRateId: rate.id,
        deliveryLineId: '',
        orderLineId: '',
        batchId: '',
        serialNumbers: [],
      },
    ],
    post: true,
  });
  expect(invoice.statusCode, invoice.body).toBe(201);
  invoiceOfB = invoiceSchema.parse(invoice.json()).id;

  // B's own file, email and link of that invoice, made through the API
  const path = `/documents/invoice/${invoiceOfB}`;
  fileOfB = documentFileSchema.parse(
    (await as(tenantB, 'POST', `${path}/files`, { language: 'en' })).json(),
  ).id;
  const email = await as(tenantB, 'POST', `${path}/emails`, {
    to: 'purchase@lazzpharma.com',
    cc: '',
    subject: 'Invoice',
    message: '',
    language: 'en',
  });
  expect(email.statusCode, email.body).toBe(201);
  const share = createdShareSchema.parse(
    created(await as(tenantB, 'POST', `${path}/shares`, { language: 'en' })),
  );
  shareOfB = share.share.id;
  tokenOfB = share.url.slice(share.url.lastIndexOf('/') + 1);
}, 180_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});
```

- **Tenant B makes its own file, email and link through the API.** The worker has no storage and no mail server, so
  B's rows end up `failed`; these tests only need them to exist.
- **B is set up as a distributor.** Karim Pharma sells medicine, but the pharma preset makes every product ask for a
  generic name, which a delivery service does not have.
- **`created()`** checks for a 201 and shows the API's answer if it is not, like the helpers of the other file.

```ts
describe("tenant A can't reach tenant B's documents", () => {
  it("answers 404 for every route that names B's invoice", async () => {
    const path = `/documents/invoice/${invoiceOfB}`;
    const attempts = [
      as(tenantA, 'POST', `${path}/files`, { language: 'en' }),
      as(tenantA, 'GET', `${path}/files/${fileOfB}`),
      as(tenantA, 'GET', `${path}/email-draft?language=en`),
      as(tenantA, 'POST', `${path}/emails`, {
        to: 'someone@rahmangarments.com',
        cc: '',
        subject: 'Invoice',
        message: '',
        language: 'en',
      }),
      as(tenantA, 'POST', `${path}/shares`, { language: 'en' }),
      as(tenantA, 'POST', `${path}/shares/${shareOfB}/revoke`),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.statusCode, res.body).toBe(404);
    }
    // The link still works: A's revoke changed nothing
    expect((await as(null, 'GET', `/public/documents/${tokenOfB}`)).statusCode).toBe(200);
  });

  it("lists none of B's emails or links", async () => {
    const path = `/documents/invoice/${invoiceOfB}`;
    const emails = documentEmailListSchema.parse(
      (await as(tenantA, 'GET', `${path}/emails`)).json(),
    );
    expect(emails.items).toEqual([]);
    const shares = documentShareListSchema.parse(
      (await as(tenantA, 'GET', `${path}/shares`)).json(),
    );
    expect(shares.items).toEqual([]);
    // B sees its own, so they were really there
    const own = documentShareListSchema.parse((await as(tenantB, 'GET', `${path}/shares`)).json());
    expect(own.items.map((item) => item.id)).toEqual([shareOfB]);
  });

  it("shows only B's own invoice behind B's link, whoever opens it", async () => {
    const page = publicDocumentSchema.parse(
      (await as(tenantA, 'GET', `/public/documents/${tokenOfB}`)).json(),
    );
    expect([page.company, page.customer]).toEqual(['Karim Pharma', 'Lazz Pharma, Kalabagan']);
  });
});

describe('the share_by_token policy', () => {
  it('shows one link, only to someone who holds its token, and never for writing', async () => {
    // As omnivo_app (NOBYPASSRLS) with no tenant context: exactly where the public lookup starts
    const appDb = postgres(pg.appUrl, { max: 1 });
    try {
      expect(await appDb`SELECT id FROM document_shares`).toHaveLength(0);
      await appDb.begin(async (tx) => {
        await tx`SELECT set_config('app.share_token_hash', ${hashShareToken(tokenOfB)}, true)`;
        const visible = await tx<{ id: string }[]>`SELECT id FROM document_shares`;
        expect(visible.map((row) => row.id)).toEqual([shareOfB]);
        // The policy is for SELECT only: the opening is stamped later, in the link's tenant
        const updated = await tx`UPDATE document_shares SET revoked_at = now()`;
        expect(updated.count).toBe(0);
        // The token shows the link, nothing else of B's
        expect(await tx`SELECT id FROM document_files`).toHaveLength(0);
        expect(await tx`SELECT id FROM document_emails`).toHaveLength(0);
      });
      // A wrong token shows nothing; an empty one neither (NULLIF in the policy)
      for (const hash of [hashShareToken('AAAAAAAAAAAAAAAAAAAAAA'), '']) {
        await appDb.begin(async (tx) => {
          await tx`SELECT set_config('app.share_token_hash', ${hash}, true)`;
          expect(await tx`SELECT id FROM document_shares`).toHaveLength(0);
        });
      }
    } finally {
      await appDb.end();
    }
  });
});
```

- **Every route that names B's invoice answers 404 for A**, never 403: a 403 would tell A that the invoice exists.
  A is the owner of its own workspace, so it has every send permission; the 404 comes from the document lookup and
  row-level security, not from a missing permission.
- **A's attempt to turn B's link off changed nothing:** the link still opens.
- **The two lists are empty for A,** and B's own list shows the link, so the rows were really there.
- **B's link shows B's invoice to anyone who opens it,** A included: that is what a link is for. It shows nothing of
  A's.
- **The `share_by_token` policy (16.2), as the API's own database role, with no workspace set:** without a token no
  link is visible; with B's token exactly B's link, and it cannot be changed; the token shows no file and no email;
  a wrong or an empty token shows nothing.
- **No change to the RLS coverage test:** it finds the three new tables by their `tenant_id` column and checks
  each has RLS, FORCE and a policy.

### Unit tests

```ts
import { describe, expect, it } from 'vitest';

import { DOCUMENT_COPY } from './copy.js';
import type { DocumentModel } from './model.js';
import { writeDocumentPdf } from './pdf.js';

// A hand-written invoice of `count` lines in one language, the shape models.service.ts writes
function invoiceModel(language: 'en' | 'bn', count: number): DocumentModel {
  const copy = DOCUMENT_COPY[language];
  return {
    language,
    title: copy.titles.invoice,
    number: 'INV-2026-27-0042',
    fileName: 'INV-2026-27-0042.pdf',
    company: {
      name: 'Rahman Pharmaceuticals Ltd.',
      lines: ['House 12, Road 7, Dhanmondi', 'Dhaka 1205', copy.bin('0001234560101')],
      logo: null,
    },
    meta: [
      { label: copy.number, value: 'INV-2026-27-0042' },
      { label: copy.date, value: language === 'bn' ? '২৩ সেপ, ২০২৬' : '23 Sep 2026' },
    ],
    party: { label: copy.billTo, name: 'Lazz Pharma, Kalabagan', code: 'C-00042', lines: [] },
    facts: [],
    table: {
      columns: [
        { label: copy.columns.number, align: 'left', width: 0.45 },
        { label: copy.columns.item, align: 'left', width: 4.2 },
        { label: copy.columns.quantity, align: 'right', width: 1.3 },
        { label: copy.columns.amount, align: 'right', width: 1.5 },
      ],
      rows: Array.from({ length: count }, (_, index) => ({
        cells: [
          String(index + 1),
          'Napa Extra 500 mg tablet, strip of 10',
          '1,200 pcs',
          '৳14,250.00',
        ],
        details: ['SKU-NAPA-500', copy.batch('L2309')],
      })),
    },
    totals: {
      note: copy.pricesWithVat,
      rows: [{ label: copy.total, value: '৳18,42,600.00', strong: true }],
    },
    words: copy.inWords('Eighteen lakh forty-two thousand six hundred taka only'),
    note: null,
    signatures: [copy.signatures.customer, copy.signatures.authorised],
    page: copy.page('{page}', '{pages}'),
  };
}

// pdfkit compresses the page contents, but not the objects that list the pages and the fonts
function pdfText(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes);
}

function pagesOf(bytes: Uint8Array): number {
  return pdfText(bytes).match(/\/Type \/Page\b/g)?.length ?? 0;
}

describe('writeDocumentPdf', () => {
  it('fits a short invoice on one page', async () => {
    const bytes = await writeDocumentPdf(invoiceModel('en', 3), null);
    expect(pdfText(bytes.subarray(0, 5))).toBe('%PDF-');
    expect(pagesOf(bytes)).toBe(1);
  });

  it('runs a long invoice over more pages instead of off the paper', async () => {
    // Each line with its two detail lines is about 40 pt high: 40 lines need three A4 pages
    expect(pagesOf(await writeDocumentPdf(invoiceModel('en', 40), null))).toBe(3);
  });

  it('draws Bangla with Hind Siliguri, and never with Noto Sans Bengali', async () => {
    const text = pdfText(await writeDocumentPdf(invoiceModel('bn', 3), null));
    // Embedded fonts are subsets: "ABCDEF+HindSiliguri-Regular"
    expect(text).toMatch(/\/BaseFont \/[A-Z]{6}\+HindSiliguri/);
    expect(text).not.toContain('NotoSansBengali');
  });

  it('leaves out a logo it cannot read, rather than failing the invoice', async () => {
    const model = invoiceModel('en', 1);
    const withLogo = {
      ...model,
      company: { ...model.company, logo: { key: 'tenants/x/logo.png', contentType: 'image/png' } },
    };
    const broken = new TextEncoder().encode('not a picture at all');
    expect(pagesOf(await writeDocumentPdf(withLogo, broken))).toBe(1);
  });

  it('draws a receipt that has no table, no totals and no note', async () => {
    const model = { ...invoiceModel('en', 0), table: null, totals: null, words: null };
    expect(pagesOf(await writeDocumentPdf(model, null))).toBe(1);
  });
});
```

- **The drawing is checked by its pages.** pdfkit compresses what is drawn on a page, but not the list of pages and
  fonts, so the test can count `/Type /Page` and read the font names without a PDF library.
- **40 lines make three pages:** with the table head repeated and no row broken, a long invoice runs on instead of
  off the paper.
- **Bangla is drawn with Hind Siliguri** (decision 21): the embedded font's name says so, and Noto Sans Bengali is
  nowhere in the file.
- **A logo that is not a picture is left off,** and the PDF is still made.
- **A document with no table, no totals and no words** (a receipt that paid no invoice) is still a valid page.

```ts
import { afterAll, describe, expect, it } from 'vitest';

import { newPdf, type TextStyle, widthOf, wrap } from './text.js';

// A real pdfkit document with the real fonts: wrap() measures with them
const { pdf } = newPdf({});
const style: TextStyle = { size: 10, bold: false, color: '#000000' };

afterAll(() => {
  pdf.end();
});

describe('wrap', () => {
  it('keeps text that fits on one line as it is', () => {
    expect(wrap(pdf, 'Station Road, Bhairab', 300, style)).toEqual(['Station Road, Bhairab']);
  });

  it('breaks between words, and every line fits', () => {
    const text = 'Deliver the cartons to the Mirpur depot before ten in the morning';
    const lines = wrap(pdf, text, 120, style);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toBe(text);
    for (const line of lines)
      expect(widthOf(pdf, line, style.size, false)).toBeLessThanOrEqual(120);
  });

  it('keeps the line breaks a person typed, empty lines too', () => {
    expect(wrap(pdf, 'House 12, Road 4\n\nNarsingdi', 300, style)).toEqual([
      'House 12, Road 4',
      '',
      'Narsingdi',
    ]);
  });

  it('cuts a word wider than the line between letters, never inside a Bangla letter', () => {
    const word = 'ক্ষ্মক্ষ্মক্ষ্মক্ষ্মক্ষ্মক্ষ্মক্ষ্মক্ষ্মক্ষ্মক্ষ্ম';
    const lines = wrap(pdf, word, 40, style);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe(word);
    // Every piece is whole clusters: ক্ষ্ম is one letter of five code points
    for (const line of lines) expect(line.replaceAll('ক্ষ্ম', '')).toBe('');
  });

  it('puts one letter on each line of a column narrower than a letter, and ends', () => {
    expect(wrap(pdf, 'SN0001', 1, style)).toEqual(['S', 'N', '0', '0', '0', '1']);
  });
});
```

- **A real pdfkit document with the real fonts,** because `wrap()` measures text with them. A fake measure would
  test the loop, not the line breaks a customer sees.
- **Every wrapped line fits,** and joined back together the lines give the text again: no word is lost.
- **A typed line break stays, and so does an empty line** (an address with a blank line in it).
- **ক্ষ্ম is one letter of five code points.** A word of ten of them in a narrow column is cut only between them:
  after removing every whole ক্ষ্ম, nothing is left on any line.
- **A column narrower than one letter** gets one letter per line, and the loop ends. This is the test that found the
  empty line at the end.

```ts
import { describe, expect, it } from 'vitest';

import { PermanentJobError } from '../common/outbox/outbox.js';
import { modelOf } from './file-maker.js';
import type { FileRow } from './files.js';
import { type DocumentModel, fingerprintOf } from './model.js';

const model: DocumentModel = {
  language: 'en',
  title: 'Money receipt',
  number: 'MR-2026-27-0007',
  fileName: 'MR-2026-27-0007.pdf',
  company: { name: 'Meghna Distributors Ltd.', lines: ['Narsingdi'], logo: null },
  meta: [{ label: 'No.', value: 'MR-2026-27-0007' }],
  party: { label: 'Received from', name: 'Bhairab Bazar Traders', code: 'C-00001', lines: [] },
  facts: [{ label: 'Amount received', value: '৳500.00' }],
  table: null,
  totals: null,
  words: 'In words: Five hundred taka only',
  note: null,
  signatures: ['Received by', 'Authorised signature'],
  page: 'Page {page} of {pages}',
};

function rowWith(stored: unknown): FileRow {
  return {
    id: '01939d1c-0000-7000-8000-000000000001',
    tenantId: '01939d1c-0000-7000-8000-000000000002',
    kind: 'receipt',
    documentId: '01939d1c-0000-7000-8000-000000000003',
    language: 'en',
    fingerprint: fingerprintOf(model),
    model: stored,
    status: 'pending',
    fileName: null,
    contentType: null,
    sizeBytes: null,
    storageKey: null,
    requestedBy: null,
    createdAt: new Date('2026-10-07T04:00:00Z'),
    finishedAt: null,
  };
}

describe('fingerprintOf', () => {
  it('is the same for the same look', () => {
    expect(fingerprintOf(structuredClone(model))).toBe(fingerprintOf(model));
    expect(fingerprintOf(model)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with any word or number on the page', () => {
    const others = [
      { ...model, words: 'In words: Five hundred taka only.' },
      { ...model, facts: [{ label: 'Amount received', value: '৳500.01' }] },
      { ...model, language: 'bn' as const },
      {
        ...model,
        company: { ...model.company, logo: { key: 'logo-2.png', contentType: 'image/png' } },
      },
    ];
    for (const other of others) expect(fingerprintOf(other)).not.toBe(fingerprintOf(model));
  });
});

describe('modelOf', () => {
  it('reads the model as the database gives it back', () => {
    // jsonb sorts the keys its own way: the model is the same, only the order differs
    const reordered: unknown = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(model).reverse())),
    );
    expect(modelOf(rowWith(reordered))).toEqual(model);
  });

  it('fails for good on a model this worker cannot read', () => {
    const older = { ...model, title: undefined, heading: 'Money receipt' };
    expect(() => modelOf(rowWith(older))).toThrow(PermanentJobError);
  });
});
```

- **The fingerprint is the same for the same look** and changes with any word, any paisa, the language and the logo.
  These are the changes that must make a new file.
- **`modelOf()` reads a model whose keys come back in another order,** as `jsonb` returns them, and refuses one of an
  older shape with `PermanentJobError`, so the job is not tried again for nothing.

```ts
import { describe, expect, it } from 'vitest';

import { documentEmail } from './document-email.js';

const input = {
  to: ['orders@bhairabbazar.com'],
  cc: [],
  subject: 'Invoice INV-2026-27-0001 from Meghna Distributors Ltd.',
  message: 'Dear Bhairab Bazar Traders,\n\nPlease find the invoice attached.',
  language: 'en',
  company: 'Meghna Distributors Ltd.',
  sender: 'Shafiq Ahmed',
  replyTo: 'accounts@meghnadistributors.com',
  file: { name: 'INV-2026-27-0001.pdf', bytes: new TextEncoder().encode('%PDF-1.3') },
} as const;

describe('documentEmail', () => {
  it("is the company's, sent from our address, with replies to the company", () => {
    const mail = documentEmail(input);
    expect(mail).toMatchObject({
      to: ['orders@bhairabbazar.com'],
      fromName: 'Meghna Distributors Ltd. via Omnivo',
      replyTo: 'accounts@meghnadistributors.com',
      subject: input.subject,
    });
    expect(mail.attachments).toEqual([
      {
        filename: 'INV-2026-27-0001.pdf',
        content: Buffer.from('%PDF-1.3'),
        contentType: 'application/pdf',
      },
    ]);
    // The company at the top, where our own emails say "Omnivo", and no button
    expect(mail.html).toContain('font-weight:600">Meghna Distributors Ltd.</p>');
    expect(mail.html).not.toContain('<a href=');
  });

  it("puts the person's message first, then lines they cannot change", () => {
    expect(documentEmail(input).text).toBe(
      'Dear Bhairab Bazar Traders,\n\nPlease find the invoice attached.\n\n' +
        'Attached: INV-2026-27-0001.pdf\n' +
        'Shafiq Ahmed sent this from Meghna Distributors Ltd. using Omnivo.\n' +
        'To reach Meghna Distributors Ltd., reply to this email.\n',
    );
  });

  it('says nothing about replying when the company has no email', () => {
    const mail = documentEmail({ ...input, replyTo: null });
    expect(mail).not.toHaveProperty('replyTo');
    expect(mail.text).not.toContain('reply');
  });

  it('keeps the line breaks of the message, and shows HTML in it as text', () => {
    const mail = documentEmail({ ...input, message: 'Dear Rafiq,\n<script>alert(1)</script>' });
    expect(mail.html).toContain('Dear Rafiq,<br>&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(mail.html).not.toContain('<script>');
  });

  it('writes its own lines in the language of the document', () => {
    const mail = documentEmail({ ...input, language: 'bn' });
    expect(mail.text).toContain('সংযুক্ত: INV-2026-27-0001.pdf');
    expect(mail.html).toContain('<html lang="bn">');
  });
});
```

- **The email without a mail server:** who it is from, where replies go, the attachment, the company's name at the
  top and no button.
- **The plain-text part is checked in full,** so a change to the server's own lines is a test change someone sees.
- **No company email, no reply line** and no `replyTo`.
- **`<script>` in the message arrives as text,** and the line break before it as `<br>`.

### Check this part

```bash
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api test
cd apps/api && npx vitest run src/documents src/sales src/invitations src/setup --maxWorkers=3
```

The `vitest` line runs the files this part touches, and the two older files that read Mailpit. Part 16.8 runs all
the API tests once.

> **What we checked in this part.** The API type-checks, and ESLint and Prettier are clean. The unit tests pass (107
> in 11 files, 19 of them new). The new integration file passes (18 tests) and so does the new tenant-leak file (4),
> and all six sales files (117 tests), the invitation and the setup files (26) pass with the changes above. Five
> things were checked by breaking the code on purpose, each caught by exactly the test meant for it: `getFile()`
> without the document check, `assertCanSend()` that lets everyone through, the public page that opens a turned-off
> link, `DocumentFiles.request()` that never retries a failed file, and the email frame without escaping.

---

## 16.5 — `packages/i18n`: the words

The screens of 16.6 need their words in English and Bangla, and the app cannot type-check without them, so they
come first. This part changes only the two locale files. The words the customer reads (the PDF, the email, the
WhatsApp text) are not here: the server writes them (decision 12, `apps/api/src/documents/copy.ts`). What is here is
what the person in the app reads: the buttons, the two dialogs, the two history lists, the bell, the customer form
and the public page.

When this part starts, `packages/i18n` has one error: the `errors` object is missing the five new codes of 16.1.
When it ends, the i18n package compiles, and the app has five type errors left. None of them is about a word: the
customer form and the MSW customers lack `documentLanguage`, and the bell's `TARGET` map has no page for
`document.email_failed`. 16.6 and 16.7 fix them.

### `locales/en.ts`

```diff
@@ -1448,6 +1448,9 @@ export const en = {
       creditLimitHint: 'The most they may owe. Leave it empty for no limit; 0 means cash only.',
       priceList: 'Price list',
       noPriceList: "The products' own prices",
+      documentLanguage: 'Document language',
+      documentLanguageHint:
+        'PDFs, emails and share links for this customer start in this language. You can pick the other one each time you send.',
       notes: 'Notes',
       notesPlaceholder: 'Takes deliveries before 11 am only. Pays by cheque on the 10th.',
     },
@@ -2329,6 +2332,123 @@ export const en = {
     postInvoice: 'Post anyway',
     back: 'Go back',
   },
+  // Download PDF, email and share link on a quotation, invoice, money receipt and credit note.
+  // Only the app's own words: what the customer reads (the PDF, the email, the WhatsApp text) is
+  // written by the server, in the customer's language (apps/api/src/documents/copy.ts)
+  documentOutput: {
+    // OutputDocument → name: the bell and the public page get the kind, not its words
+    kinds: {
+      quotation: 'Quotation',
+      invoice: 'Invoice',
+      receipt: 'Money receipt',
+      credit_note: 'Credit note',
+    },
+    send: 'Send',
+    downloadPdf: 'Download PDF',
+    // The other language; {{language}} is its own name (English, বাংলা)
+    downloadPdfIn: 'Download PDF in {{language}}',
+    email: 'Email',
+    share: 'Share on WhatsApp',
+    preparing: 'Making the PDF…',
+    pdfFailed: "Couldn't make the PDF. Try again.",
+    pdfSlow: 'The PDF is taking longer than usual. Try again in a minute.',
+    copyFailed: "Couldn't copy. Select the text and copy it yourself.",
+    emailDialog: {
+      title: 'Email {{number}}',
+      replyTo: 'The PDF goes as an attachment. Replies go to {{email}}.',
+      noReplyTo:
+        'The PDF goes as an attachment. Add your company’s email in Settings, so that replies reach you.',
+      language: 'Language',
+      languageHint: 'Of the PDF and the email. Changing it writes the subject and message again.',
+      to: 'To',
+      cc: 'CC',
+      recipientsHint: 'Up to {{max}} addresses, separated by commas',
+      toPlaceholder: 'accounts@rahmantraders.com.bd',
+      noCustomerEmail:
+        'This customer has no email address. Type one here, or add it to the customer.',
+      subject: 'Subject',
+      message: 'Message',
+      messageHint: 'Under your message, the email says what is attached and how to reply.',
+      attachment: 'Attached: {{file}}',
+      send: 'Send email',
+      sending: 'Sending…',
+      sent: 'Sending to {{to}}',
+      loadFailed: "Couldn't load the email. Close it and try again.",
+    },
+    emails: {
+      title: 'Emails',
+      subtitle: 'Who this document was emailed to',
+      empty: 'Not emailed yet.',
+      statuses: { pending: 'Sending', sent: 'Sent', failed: 'Failed' },
+      cc: 'CC {{list}}',
+      sentBy: '{{name}}, {{date}}',
+      failedHint: "The mail server didn't take it. Check the address and send it again.",
+      loadFailed: "Couldn't load the emails. Refresh the page to try again.",
+    },
+    shareDialog: {
+      title: 'Share {{number}}',
+      description:
+        'Anyone with the link can see this document and download its PDF for {{days}} days, without signing in. You can turn the link off sooner.',
+      language: 'Language',
+      languageHint: 'Of the page, the PDF and the message.',
+      create: 'Make link',
+      creating: 'Making the link…',
+      link: 'Link',
+      copyLink: 'Copy link',
+      linkCopied: 'Link copied',
+      message: 'Message',
+      copyMessage: 'Copy message',
+      messageCopied: 'Message copied',
+      openWhatsApp: 'Open WhatsApp',
+      noNumber:
+        'The customer’s phone is not a mobile number, so WhatsApp will ask you to pick the contact.',
+      shownOnce: 'The link is shown only now. To send it again later, make a new one.',
+    },
+    shares: {
+      title: 'Share links',
+      subtitle: 'Each link works for {{days}} days, or until it is turned off',
+      empty: 'No link made yet.',
+      // Worked out by the page from expiresAt and revokedAt
+      states: { active: 'Active', ended: 'Ended', revoked: 'Turned off' },
+      madeBy: 'Made by {{name}}, {{date}}',
+      until: 'Works until {{date}}',
+      endedOn: 'Ended {{date}}',
+      revokedOn: 'Turned off {{date}}',
+      firstOpened: 'First opened {{date}}',
+      lastOpened: 'Last opened {{date}}',
+      notOpened: 'Not opened yet',
+      revoke: 'Turn off',
+      revokeLabel: 'Turn off the link made {{date}}',
+      confirmTitle: 'Turn off this link?',
+      confirmBody:
+        'Whoever opens it will see that it no longer works. A link cannot be turned on again; make a new one instead.',
+      confirm: 'Turn off link',
+      revoked: 'Link turned off',
+      loadFailed: "Couldn't load the share links. Refresh the page to try again.",
+    },
+  },
+  // The page behind a share link (/d/:token): no login, no app shell, in the link's language
+  publicDocument: {
+    // A kind this version of the app does not know (a newer server)
+    document: 'Document',
+    pageTitle: '{{document}} {{number}} from {{company}}',
+    from: 'From {{company}}',
+    to: 'For {{customer}}',
+    number: 'Number',
+    date: 'Date',
+    total: 'Total',
+    dueDate: 'Due date',
+    amountDue: 'Still due',
+    download: 'Download PDF',
+    preparing: 'Getting the PDF ready…',
+    failed: "The PDF couldn't be made. Try again in a minute.",
+    private: 'Only people with this link can see this page.',
+    goneTitle: 'This link no longer works',
+    goneBody:
+      'A link works for {{days}} days, and the sender can turn it off sooner. Ask whoever sent it for a new one.',
+    loadFailed: "Couldn't open this document. Check your connection and try again.",
+    poweredBy: 'Sent with Omnivo',
+  },
   // The printed quotation, order, challan, invoice and receipt (A4, the browser's Print)
   print: {
     print: 'Print',
@@ -2386,6 +2506,8 @@ export const en = {
       preparedBy: 'Prepared by',
       authorised: 'Authorised signature',
     },
+    // Under the total of a money document; {{words}} is amountInWords() from @omnivo/contracts
+    inWords: 'In words: {{words}}',
     printedAt: 'Printed {{date}}',
   },
   yearEnd: {
@@ -3007,6 +3129,11 @@ export const en = {
       stock: {
         low: '{{warehouse}}: {{count}} items fell to their reorder level. Time to order more.',
       },
+      // {{document}} arrives as a kind (invoice); the bell puts its name in
+      document: {
+        email_failed:
+          "{{document}} {{number}} couldn't be emailed. Check the address and send it again.",
+      },
     },
   },
   // API-র error code → লেখা। satisfies: contracts-এর ERROR_CODES-এ নতুন code এলে এখানে না লেখা
@@ -3392,6 +3519,13 @@ export const en = {
       'The sales returns account must be an active income account, not a group. Pick another one in Settings → Sales.',
     account_used_by_sales:
       'Credit notes post to this account. Choose another sales returns account in Settings → Sales first.',
+    document_not_issued:
+      "This document has no number yet, or it was voided, so it can't be downloaded or sent. Post it first.",
+    email_to_required: 'Type at least one address to send it to.',
+    // 5 = MAX_EMAIL_RECIPIENTS; the schema's issue carries no number to put in
+    email_too_many: 'Up to 5 addresses in a box. Send a second email to the rest.',
+    email_subject_required: 'Type a subject.',
+    share_link_not_found: 'This link no longer works. Ask whoever sent it for a new one.',
     import_options_without_code:
       'Give rows with options a code: rows with the same code are one product.',
     invalid_cursor: 'This list has changed. Reload the page and try again.',
```

- **New keys go into `en.ts` first** (CLAUDE.md → Language). `bn.ts` has the type `Messages`, taken from `en`, so a
  key missing in Bangla fails the type check. The `errors` object ends with `satisfies Record<ErrorCode, string>`,
  so the five codes of 16.1 must all be here, or the package does not compile.
- **`customers.fields.documentLanguage`** is the customer form's new select (decision 4). Its hint says what the
  setting does and that it is only a start: the person can pick the other language each time. Without that second
  sentence, someone with one Bangla-speaking buyer at an English-speaking company would think they must change the
  customer every time.
- **`documentOutput` is one section for four documents,** like `print` and `creditLimit`. The quotation, invoice,
  money receipt and credit note pages show the same menu, the same dialogs and the same lists; four copies of the
  same words would drift apart.
- **`documentOutput.kinds` is keyed by `OutputDocument`** (`credit_note`, with the underscore), not like
  `print.titles` (`creditNote`). The bell and the public page get the kind as a string from the API and call
  `` t(`documentOutput.kinds.${kind}`) `` after narrowing it with `isOutputDocument()`. That template string is
  typed from the contract's union, so a fifth kind in the contract fails the app's type check until it has a name
  here.
- **`downloadPdfIn` has the language as a value,** filled with the language's own name from `LANGUAGES`
  (decision 32). There are no "English" or "Bangla" keys, so there is nothing to keep in step with the language
  switch. The Bangla text puts the name in brackets ("PDF ডাউনলোড (English)"), because Bangla would need a different
  ending for each name ("বাংলায়", "English-এ").
- **Three ways a download can end,** because the PDF is made by the worker (decision 5): `preparing` on the button
  while the page waits, `pdfFailed` when the file's status says `failed`, and `pdfSlow` when the page stops waiting
  and the file is still pending (the worker may be busy or down). `pdfSlow` says to try again, since a later click
  finds the same row, and by then the file is often ready.
- **`copyFailed`.** The browser's clipboard can refuse (an old browser, or a page not opened over HTTPS). Then the
  person is told to copy the text themselves; the link and the message are in boxes they can select.
- **The email dialog** (decisions 6 and 30):
  - `replyTo` and `noReplyTo` say where answers go. With no company email in Settings the email has no reply-to,
    and the customer's answer would go to the Omnivo sender address, where nobody reads it; the text says what to
    do about it.
  - `languageHint` warns that changing the language writes the subject and the message again (decision 30).
  - `recipientsHint` is shared by To and CC, with the limit as `{{max}}` (the page passes `MAX_EMAIL_RECIPIENTS`),
    and says how to separate addresses (decision 15).
  - `noCustomerEmail` shows under To when the server's draft has no address: the customer has no email. It says
    both ways out.
  - `messageHint` says that the email adds lines under the message, so the person does not write "PDF attached,
    reply to …" a second time.
  - `sent` is the toast. It says "Sending", not "Sent": the request only queues the email (`pending`). The history
    shows when it went.
- **`emails` is the list on the document page.** `statuses` follow `DOCUMENT_EMAIL_STATUSES`: `pending` is
  "Sending" (work in progress, `brand`), `failed` "Failed" (`crit`). `failedHint` tells the person what to check;
  the bell says the same (below).
- **The share dialog** (decisions 13 and 28):
  - `description` says who can open the link and for how long, with `{{days}}` from `SHARE_LINK_DAYS`, so the text
    cannot disagree with the server.
  - `shownOnce`: the server keeps only the token's hash, so the link cannot be shown again after the dialog closes.
    Saying so before it closes saves a "where is my link?" later.
  - `noNumber` shows when `whatsAppNumber()` cannot read a mobile number from the customer's phone (decision 17), so
    the contact picker that WhatsApp opens is no surprise.
- **`shares` is the list of links.** `states` is worked out by the page from `revokedAt` and `expiresAt`; the API
  sends dates, not a state, because "ended" depends on the clock. A turned-off link says "Turned off", not
  "Revoked": that is the word on the button. `revokeLabel` is the button's label for screen readers: every row has
  a "Turn off" button, and a list of identical labels does not say which link each one turns off. The confirm texts
  are decision 31.
- **`publicDocument` is the page behind the link.** It is read by the customer, but these words still belong to
  the app, because the app draws that page. The page switches to the link's language, so the customer reads it in
  the language the sender chose.
  - `document` is the name for a kind this version of the app does not know. `publicDocumentSchema.kind` is a plain
    string (16.1), so an older app still shows a page when a newer server sends a fifth kind.
  - `pageTitle` is the browser tab's title. It names the sender, because the customer may have three such tabs open.
  - `goneTitle` and `goneBody` are one text for an unknown, an ended and a turned-off link (decision 14). The body
    says what the customer can do: ask the sender.
  - `private` tells the customer why the page opened without a login, and that nobody else sees it.
- **`print.inWords`** is the line under the total of an invoice, a money receipt, a credit note and a refund
  (decision 7), filled with `amountInWords()` from `@omnivo/contracts`. The PDF has the same words ("In words: …",
  "কথায়: …") in `copy.ts`, so paper and PDF match.
- **`notifications.types.document.email_failed`.** The type's dot nests in i18next, so
  `` t(`notifications.types.${type}`) `` lands here. `{{document}}` arrives as a kind (`invoice`) and the bell puts
  the name in from `documentOutput.kinds`, like an export's report. The kind is the first word, so it can keep its
  capital letter.
- **The five error codes.**
  - `document_not_issued` covers both causes, a draft and a voided receipt, because the API sends one code for both
    (decision 11).
  - `email_too_many` has the number 5 written in. The Zod issue in 16.1 carries only the code, not the limit, and a
    `{{max}}` that nobody fills would print as it is. The comment ties it to `MAX_EMAIL_RECIPIENTS`.
  - `share_link_not_found` is the API's answer for the public page. The page shows `goneTitle` and `goneBody`
    instead; this text is there for any other place that shows the API error as it is.

### `locales/bn.ts`

```diff
@@ -1436,6 +1436,9 @@ export const bn: Messages = {
       creditLimitHint: 'সবচেয়ে বেশি কত বাকি রাখতে পারবে। খালি = লিমিট নেই; ০ = শুধু নগদ।',
       priceList: 'দামের তালিকা',
       noPriceList: 'প্রোডাক্টের নিজের দাম',
+      documentLanguage: 'ডকুমেন্টের ভাষা',
+      documentLanguageHint:
+        'এই গ্রাহকের PDF, ইমেইল আর শেয়ার লিংক এই ভাষায় শুরু হয়। প্রতিবার পাঠানোর সময় অন্য ভাষাটাও বাছা যায়।',
       notes: 'নোট',
       notesPlaceholder: 'শুধু সকাল ১১টার আগে মাল নেয়। প্রতি মাসের ১০ তারিখে চেকে টাকা দেয়।',
     },
@@ -2284,6 +2287,114 @@ export const bn: Messages = {
     postInvoice: 'তবুও পোস্ট করুন',
     back: 'ফিরে যান',
   },
+  documentOutput: {
+    kinds: {
+      quotation: 'কোটেশন',
+      invoice: 'ইনভয়েস',
+      receipt: 'মানি রিসিট',
+      credit_note: 'ক্রেডিট নোট',
+    },
+    send: 'পাঠান',
+    downloadPdf: 'PDF ডাউনলোড',
+    downloadPdfIn: 'PDF ডাউনলোড ({{language}})',
+    email: 'ইমেইল',
+    share: 'WhatsApp-এ শেয়ার',
+    preparing: 'PDF তৈরি হচ্ছে…',
+    pdfFailed: 'PDF তৈরি করা যায়নি। আবার চেষ্টা করুন।',
+    pdfSlow: 'PDF তৈরি হতে স্বাভাবিকের চেয়ে বেশি সময় লাগছে। এক মিনিট পরে আবার চেষ্টা করুন।',
+    copyFailed: 'কপি করা যায়নি। লেখাটা সিলেক্ট করে নিজে কপি করুন।',
+    emailDialog: {
+      title: '{{number}} ইমেইল করুন',
+      replyTo: 'PDF সংযুক্তি হিসেবে যাবে। উত্তর আসবে {{email}}-এ।',
+      noReplyTo:
+        'PDF সংযুক্তি হিসেবে যাবে। উত্তর যেন আপনার কাছে আসে, সেজন্য সেটিংসে কোম্পানির ইমেইল দিন।',
+      language: 'ভাষা',
+      languageHint: 'PDF আর ইমেইলের ভাষা। বদলালে বিষয় আর মেসেজ নতুন করে লেখা হবে।',
+      to: 'প্রাপক',
+      cc: 'CC',
+      recipientsHint: 'সর্বোচ্চ {{max}}টা ঠিকানা, কমা দিয়ে আলাদা করে',
+      toPlaceholder: 'accounts@rahmantraders.com.bd',
+      noCustomerEmail:
+        'এই গ্রাহকের কোনো ইমেইল ঠিকানা নেই। এখানে লিখুন, বা গ্রাহকের তথ্যে যোগ করুন।',
+      subject: 'বিষয়',
+      message: 'মেসেজ',
+      messageHint: 'আপনার মেসেজের নিচে ইমেইলে লেখা থাকবে কী সংযুক্ত আছে আর কীভাবে উত্তর দিতে হবে।',
+      attachment: 'সংযুক্ত: {{file}}',
+      send: 'ইমেইল পাঠান',
+      sending: 'পাঠানো হচ্ছে…',
+      sent: '{{to}}-এ পাঠানো হচ্ছে',
+      loadFailed: 'ইমেইলটা আনা যায়নি। বন্ধ করে আবার চেষ্টা করুন।',
+    },
+    emails: {
+      title: 'ইমেইল',
+      subtitle: 'এই ডকুমেন্ট কাকে কাকে ইমেইল করা হয়েছে',
+      empty: 'এখনো ইমেইল করা হয়নি।',
+      statuses: { pending: 'পাঠানো হচ্ছে', sent: 'পাঠানো হয়েছে', failed: 'যায়নি' },
+      cc: 'CC {{list}}',
+      sentBy: '{{name}}, {{date}}',
+      failedHint: 'মেইল সার্ভার এটা নেয়নি। ঠিকানা দেখে আবার পাঠান।',
+      loadFailed: 'ইমেইলগুলো আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    },
+    shareDialog: {
+      title: '{{number}} শেয়ার করুন',
+      description:
+        'লিংকটা যার কাছে থাকবে, সে সাইন ইন ছাড়াই {{days}} দিন এই ডকুমেন্ট দেখতে আর PDF ডাউনলোড করতে পারবে। চাইলে আগেই লিংক বন্ধ করা যায়।',
+      language: 'ভাষা',
+      languageHint: 'পেজ, PDF আর মেসেজের ভাষা।',
+      create: 'লিংক তৈরি করুন',
+      creating: 'লিংক তৈরি হচ্ছে…',
+      link: 'লিংক',
+      copyLink: 'লিংক কপি করুন',
+      linkCopied: 'লিংক কপি হয়েছে',
+      message: 'মেসেজ',
+      copyMessage: 'মেসেজ কপি করুন',
+      messageCopied: 'মেসেজ কপি হয়েছে',
+      openWhatsApp: 'WhatsApp খুলুন',
+      noNumber: 'গ্রাহকের ফোন নম্বরটা মোবাইল নম্বর না, তাই WhatsApp আপনাকে কন্টাক্ট বাছতে বলবে।',
+      shownOnce: 'লিংকটা শুধু এখনই দেখা যাবে। পরে আবার পাঠাতে হলে নতুন একটা তৈরি করুন।',
+    },
+    shares: {
+      title: 'শেয়ার লিংক',
+      subtitle: 'প্রতিটা লিংক {{days}} দিন চলে, বা যতক্ষণ না বন্ধ করা হয়',
+      empty: 'এখনো কোনো লিংক তৈরি হয়নি।',
+      states: { active: 'চালু', ended: 'মেয়াদ শেষ', revoked: 'বন্ধ' },
+      madeBy: '{{name}} তৈরি করেছেন, {{date}}',
+      until: '{{date}} পর্যন্ত চলবে',
+      endedOn: '{{date}}-এ মেয়াদ শেষ',
+      revokedOn: '{{date}}-এ বন্ধ করা হয়েছে',
+      firstOpened: 'প্রথম খোলা হয়েছে {{date}}',
+      lastOpened: 'শেষ খোলা হয়েছে {{date}}',
+      notOpened: 'এখনো খোলা হয়নি',
+      revoke: 'বন্ধ করুন',
+      revokeLabel: '{{date}}-এ তৈরি লিংক বন্ধ করুন',
+      confirmTitle: 'লিংকটা বন্ধ করবেন?',
+      confirmBody:
+        'যে খুলবে সে দেখবে লিংকটা আর কাজ করে না। বন্ধ লিংক আর চালু করা যায় না; দরকার হলে নতুন একটা তৈরি করুন।',
+      confirm: 'লিংক বন্ধ করুন',
+      revoked: 'লিংক বন্ধ হয়েছে',
+      loadFailed: 'শেয়ার লিংকগুলো আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    },
+  },
+  publicDocument: {
+    document: 'ডকুমেন্ট',
+    pageTitle: '{{company}}-এর {{document}} {{number}}',
+    from: 'প্রেরক: {{company}}',
+    to: 'প্রাপক: {{customer}}',
+    number: 'নং',
+    date: 'তারিখ',
+    total: 'মোট',
+    dueDate: 'পরিশোধের তারিখ',
+    amountDue: 'এখনো বাকি',
+    download: 'PDF ডাউনলোড',
+    preparing: 'PDF তৈরি হচ্ছে…',
+    failed: 'PDF তৈরি করা যায়নি। এক মিনিট পরে আবার চেষ্টা করুন।',
+    private: 'শুধু এই লিংক যার কাছে আছে, সে-ই এই পেজ দেখতে পারে।',
+    goneTitle: 'এই লিংক আর কাজ করে না',
+    goneBody:
+      'একটা লিংক {{days}} দিন চলে, আর যিনি পাঠিয়েছেন তিনি আগেই বন্ধ করতে পারেন। যিনি পাঠিয়েছেন, তাঁর কাছে নতুন লিংক চান।',
+    loadFailed: 'ডকুমেন্টটা খোলা যায়নি। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।',
+    poweredBy: 'Omnivo দিয়ে পাঠানো',
+  },
   print: {
     print: 'প্রিন্ট',
     titles: {
@@ -2340,6 +2451,7 @@ export const bn: Messages = {
       preparedBy: 'প্রস্তুতকারী',
       authorised: 'অনুমোদিত স্বাক্ষর',
     },
+    inWords: 'কথায়: {{words}}',
     printedAt: '{{date}}-এ প্রিন্ট করা',
   },
   yearEnd: {
@@ -2952,6 +3064,9 @@ export const bn: Messages = {
       stock: {
         low: '{{warehouse}}: {{count}}টা আইটেম রিঅর্ডার লেভেলে নেমেছে। আবার অর্ডার করার সময়।',
       },
+      document: {
+        email_failed: '{{document}} {{number}} ইমেইল করা যায়নি। ঠিকানা দেখে আবার পাঠান।',
+      },
     },
   },
   errors: {
@@ -3327,6 +3442,12 @@ export const bn: Messages = {
       'সেলস রিটার্নের অ্যাকাউন্টকে একটা চালু আয়ের অ্যাকাউন্ট হতে হবে, গ্রুপ না। সেটিংস → বিক্রি থেকে অন্য একটা বাছুন।',
     account_used_by_sales:
       'ক্রেডিট নোট এই অ্যাকাউন্টে পোস্ট হয়। আগে সেটিংস → বিক্রি থেকে সেলস রিটার্নের অন্য একটা অ্যাকাউন্ট বাছুন।',
+    document_not_issued:
+      'এই ডকুমেন্টের এখনো নম্বর হয়নি, বা এটা বাতিল হয়েছে, তাই ডাউনলোড বা পাঠানো যাবে না। আগে পোস্ট করুন।',
+    email_to_required: 'অন্তত একটা ঠিকানা লিখুন।',
+    email_too_many: 'একটা ঘরে সর্বোচ্চ ৫টা ঠিকানা। বাকিদের আরেকটা ইমেইল পাঠান।',
+    email_subject_required: 'একটা বিষয় লিখুন।',
+    share_link_not_found: 'এই লিংক আর কাজ করে না। যিনি পাঠিয়েছেন, তাঁর কাছে নতুন লিংক চান।',
     import_options_without_code:
       'অপশনওয়ালা সারিতে কোড দিন: একই কোডের সারিগুলো মিলে একটা প্রোডাক্ট।',
     invalid_cursor: 'তালিকাটা বদলে গেছে। পেজটা রিলোড করে আবার চেষ্টা করুন।',
```

The Bangla follows the words the server already uses in `copy.ts`: "লিংক", "সংযুক্ত", "PDF", "WhatsApp". PDF,
WhatsApp, CC and email addresses stay in English inside the Bangla text, like PO and LC (CLAUDE.md → Language).
`email_too_many` writes the limit in Bangla digits (৫), like the other Bangla texts.

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/i18n typecheck
pnpm --filter @omnivo/i18n test
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/ui typecheck
```

Build `@omnivo/contracts` first: the i18n package reads its built `ErrorCode` type, so until then the five new codes
are unknown and the `satisfies` line fails the other way round. Build `@omnivo/i18n` before you type-check the ui
package and the app, which read its built types.

> **What we checked in this part.** `packages/i18n` type-checks, ESLint and Prettier are clean, its unit tests pass
> (11), and it builds. `packages/ui` type-checks against the new build. The app has five type errors left: the
> customer form and two MSW customers lack `documentLanguage`, and the bell's `TARGET` has no page for
> `document.email_failed` (two errors at two lines). No error is about a missing translation key.

## 16.6 — `apps/app`: the screens

This part puts step 16 in front of people. The quotation, invoice, money receipt and credit note pages get a Send
menu and two history cards; the email and share dialogs open from the menu; a share link opens a public page; the
customer form gets its document language; and the printed money documents get their amount in words.

It runs in this order:

1. The bell, which needs one more value from the API (a fix in 16.1, 16.3 and 16.4).
2. Three small `lib` files: the helpers, their tests, and the queries.
3. The Send menu, the two dialogs and the history cards, each a lazy chunk.
4. The four document pages.
5. The public page and its route.
6. The customer form and page, and the printed amount in words.
7. Keeping every chunk inside its 100 KB budget.

When it ends, the app has two type errors left, both in the MSW mocks (two customers lack `documentLanguage`).
16.7 writes the mocks.

### The bell opens the document

The 16.1 notification `document.email_failed` had `{ document, number }`. That is enough for the text, but not for
the click: the bell must open the page the notification is about (CLAUDE.md → Notification bell), and that needs the
document's id. So this part added `id` in three places that earlier parts already show:

- `packages/contracts/src/notifications.ts` (16.1): the comment now lists `{ document, id, number }`.
- `apps/api/src/documents/email.handler.ts` (16.3): `onGiveUp()` returns `documentId` from the same `UPDATE …
  RETURNING` that marks the email failed, and puts it in the params.
- `apps/api/src/documents/document-output.int.spec.ts` (16.4): the test expects `id: invoice.id`.

If you built 16.1–16.4 from an earlier copy of this guide, make those three changes now.

```diff
@@ -4,6 +4,7 @@ import {
   DEFAULT_SETTINGS,
   isExportFormat,
   isNotificationType,
+  isOutputDocument,
   isReportKind,
   type Notification,
   type NotificationParams,
@@ -22,6 +23,7 @@ import { useSession } from '../lib/session-store';
 
 // Where a click on each kind of notification takes you. satisfies: a new type without a page does
 // not compile, and the values are checked against the router's real paths by navigate() below.
+// Step 16: a failed email opens its own document, so that type is not here (useOpen below).
 const TARGET = {
   'workspace.ready': '/roles',
   'member.joined': '/team',
@@ -31,7 +33,45 @@ const TARGET = {
   'import.done': '/products/imports',
   'import.failed': '/products/imports',
   'stock.low': '/stock/reorder',
-} as const satisfies Record<NotificationType, string>;
+} as const satisfies Record<Exclude<NotificationType, 'document.email_failed'>, string>;
+
+// A document's page from the notification's kind and id. The list of that kind when the id is
+// missing or not a document's (an older notification); the dashboard for a kind this app does
+// not know. One navigate() per kind: each path has its own parameter name, and TanStack checks
+// each pair against the router.
+function useOpenDocument(): (params: NotificationParams) => Promise<void> {
+  const navigate = useNavigate();
+  return async (params) => {
+    const { document: kind, id } = params;
+    if (typeof kind !== 'string' || !isOutputDocument(kind)) {
+      await navigate({ to: '/' });
+      return;
+    }
+    const known = typeof id === 'string' && id !== '';
+    switch (kind) {
+      case 'quotation':
+        await (known
+          ? navigate({ to: '/quotations/$quotationId', params: { quotationId: id } })
+          : navigate({ to: '/quotations' }));
+        return;
+      case 'invoice':
+        await (known
+          ? navigate({ to: '/invoices/$invoiceId', params: { invoiceId: id } })
+          : navigate({ to: '/invoices' }));
+        return;
+      case 'receipt':
+        await (known
+          ? navigate({ to: '/receipts/$receiptId', params: { receiptId: id } })
+          : navigate({ to: '/receipts' }));
+        return;
+      case 'credit_note':
+        await (known
+          ? navigate({ to: '/credit-notes/$creditNoteId', params: { creditNoteId: id } })
+          : navigate({ to: '/credit-notes' }));
+        return;
+    }
+  };
+}
 
 // The badge stops at 9+: a two-digit count would not fit the 18px circle, and past nine the exact
 // number no longer changes what you do
@@ -44,9 +84,12 @@ function badgeText(count: number): string {
 function useWords() {
   const { t } = useLocale();
   return (params: NotificationParams): NotificationParams => {
-    const { report, format } = params;
+    const { report, format, document: kind } = params;
     return {
       ...params,
+      // Step 16: a document's kind (invoice) becomes its name
+      ...(typeof kind === 'string' &&
+        isOutputDocument(kind) && { document: t(`documentOutput.kinds.${kind}`) }),
       ...(typeof report === 'string' &&
         isReportKind(report) && { report: t(`reports.kinds.${report}`) }),
       ...(typeof format === 'string' &&
@@ -100,6 +143,7 @@ function Item({
 export function NotificationBell() {
   const { t } = useLocale();
   const navigate = useNavigate();
+  const openDocument = useOpenDocument();
   const queryClient = useQueryClient();
   const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
   const [open, setOpen] = useState(false);
@@ -184,7 +228,11 @@ export function NotificationBell() {
                 onOpen={() => {
                   if (notification.readAt === null) markRead.mutate(notification.id);
                   setOpen(false);
-                  void navigate({ to: TARGET[notification.type] });
+                  if (notification.type === 'document.email_failed') {
+                    void openDocument(notification.params);
+                  } else {
+                    void navigate({ to: TARGET[notification.type] });
+                  }
                 }}
               />
             ))}
```

- **`TARGET` leaves out `document.email_failed`.** `TARGET` maps a type to one fixed path. A failed email has four
  possible pages, each with its own parameter. `Exclude<NotificationType, 'document.email_failed'>` keeps the
  `satisfies` check: a sixth type without a page still fails the type check.
- **`useOpenDocument()` has one `navigate()` per kind,** not a map of paths. TanStack Router checks each `to` and its
  `params` against the route tree. A map would need a cast to make `{ quotationId }` and `{ invoiceId }` fit one
  type, and a wrong parameter name would then compile.
- **The fallbacks.** No `id` (a notification made before this change) opens the kind's list; a kind this app does not
  know (a newer server) opens the dashboard. A click always goes somewhere.
- **`useWords()` turns the kind into its name,** like a report's kind: "Invoice INV-2026-27-0042 couldn't be emailed".
  The destructured name is `kind`, not `document`, so it does not hide the browser's global `document`.

### The helpers: `lib/document-output.ts` (new)

```ts
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
```

- **`OutputTarget`** is the document the menu, the dialogs and the history work on. Each page builds it only when
  the document has its number (decision 11), so the number is a plain `string` here, never `null`.
- **`otherLanguage()` and `languageName()`** give the second menu item its words: "Download PDF in বাংলা"
  (decision 32). `LANGUAGES` from `@omnivo/i18n` is the list the language switch uses, so there is one place for
  a language's name.
- **`shareState()` works the state out from the dates** (16.5 says why the API sends dates). "Turned off" wins over
  "Ended": someone did it on purpose, and the list should say so even after the 30 days are over.
- **`waitForPdf()`** is decision 33. It takes the first answer and a `poll` function, so the test can feed it answers
  without a server. It counts attempts instead of reading the clock, so the test needs no fake timers. A file that
  came back ready at once is not asked for again.
- **`saveFile()`** clicks a hidden `<a download>`, like step 11's exports. The page does not change, so the person is
  still on the invoice after the download.

```ts
import type { DocumentFile, DocumentShare } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { languageName, otherLanguage, shareState, waitForPdf } from './document-output';

function file(status: DocumentFile['status']): DocumentFile {
  return {
    id: '0199a6c0-0000-7000-8000-000000000001',
    language: 'en',
    status,
    fileName: status === 'ready' ? 'INV-2026-27-0042.pdf' : null,
    sizeBytes: status === 'ready' ? 48_213 : null,
    download:
      status === 'ready'
        ? { url: 'https://files.example.com/x.pdf', expiresAt: '2026-10-14T10:05:00.000Z' }
        : null,
    createdAt: '2026-10-14T10:00:00.000Z',
    finishedAt: status === 'pending' ? null : '2026-10-14T10:00:02.000Z',
  };
}

const noWait = () => Promise.resolve();

describe('waitForPdf', () => {
  it('does not ask again for a file that is ready', async () => {
    let polls = 0;
    const outcome = await waitForPdf(
      file('ready'),
      () => {
        polls += 1;
        return Promise.resolve(file('ready'));
      },
      { sleep: noWait },
    );
    expect(outcome.status).toBe('ready');
    expect(polls).toBe(0);
  });

  it('asks until the worker is done', async () => {
    const answers = [file('pending'), file('pending'), file('ready')];
    let polls = 0;
    const outcome = await waitForPdf(
      file('pending'),
      () => Promise.resolve(answers[polls++] ?? file('ready')),
      { sleep: noWait },
    );
    expect(outcome).toMatchObject({ status: 'ready', file: { fileName: 'INV-2026-27-0042.pdf' } });
    expect(polls).toBe(3);
  });

  it('says failed when the worker gave up', async () => {
    const outcome = await waitForPdf(file('pending'), () => Promise.resolve(file('failed')), {
      sleep: noWait,
    });
    expect(outcome.status).toBe('failed');
  });

  it('stops waiting after the last attempt', async () => {
    let polls = 0;
    const outcome = await waitForPdf(
      file('pending'),
      () => {
        polls += 1;
        return Promise.resolve(file('pending'));
      },
      { sleep: noWait, attempts: 4 },
    );
    expect(outcome.status).toBe('slow');
    expect(polls).toBe(4);
  });
});

describe('shareState', () => {
  const share: DocumentShare = {
    id: '0199a6c0-0000-7000-8000-000000000002',
    language: 'bn',
    createdBy: { id: '0199a6c0-0000-7000-8000-000000000003', name: 'Nusrat Jahan' },
    createdAt: '2026-10-01T09:00:00.000Z',
    expiresAt: '2026-10-31T09:00:00.000Z',
    revokedAt: null,
    firstOpenedAt: null,
    lastOpenedAt: null,
  };

  it('is active until it expires', () => {
    expect(shareState(share, new Date('2026-10-31T08:59:59.000Z'))).toBe('active');
    expect(shareState(share, new Date('2026-10-31T09:00:00.000Z'))).toBe('ended');
  });

  it('says turned off before ended', () => {
    const revoked = { ...share, revokedAt: '2026-10-02T09:00:00.000Z' };
    expect(shareState(revoked, new Date('2026-11-30T00:00:00.000Z'))).toBe('revoked');
  });
});

describe('languages', () => {
  it('names the other language by its own name', () => {
    expect(otherLanguage('en')).toBe('bn');
    expect(otherLanguage('bn')).toBe('en');
    expect(languageName('bn')).toBe('বাংলা');
  });
});
```

The four ways a wait can end (ready at once, ready after a few answers, failed, still pending after the last try),
when a link counts as ended (at its `expiresAt`, not a second later), and that a turned-off link stays "turned off".

### The queries: `lib/document-queries.ts` (new)

```ts
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
```

- **A file of their own, not `queries.ts`.** `queries.ts` is in almost every page's chunk. These three are needed
  only by the document output chunks; in `queries.ts` they made every page a little bigger, and the stock adjustment
  form went over its budget by that alone.
- **One key prefix per document,** `['documents', tenantId, kind, id]`. Sending an email or making a link refreshes
  only that document's lists.
- **`refetchInterval` while an email is pending** (decision 36). The function returns `false` once no email is
  pending, so a page left open stops asking.
- **`emailDraftQuery()` has `gcTime: 0`.** The draft is read again for each dialog: an invoice that was paid since
  the last dialog has a different message.

### The Send menu: `components/send-menu.tsx` (new)

```tsx
import {
  ArrowDown01Icon,
  Mail01Icon,
  Pdf01Icon,
  SentIcon,
  WhatsappIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { type LanguageCode, routes, SEND_PERMISSIONS } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';

import { call } from '../lib/api';
import {
  languageName,
  otherLanguage,
  type OutputTarget,
  saveFile,
  waitForPdf,
} from '../lib/document-output';
import { useCan } from '../lib/permissions';
import { customerQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { failureOf } from './journal-parts';

// Step 16: the Send menu in the header of a quotation, an invoice, a money receipt and a credit
// note. A lazy chunk of its own, loaded by those four pages: it brings Radix's dropdown (with its
// positioning code), and inside the pages' chunks the menu and the history cards took the invoice
// page from 68 KB to 108 KB, over its 100 KB budget.
// The two dialogs are one more chunk (document-dialogs.tsx), loaded when one opens: they bring the
// form library. They share no module with this file that is not already shared with other pages:
// the bundler would fold such a module into this chunk, the dialogs' chunk would import this one,
// and the budget check would count the dropdown a second time for the dialogs.
const EmailForm = lazy(async () => ({
  default: (await import('./document-dialogs')).EmailForm,
}));
const ShareForm = lazy(async () => ({
  default: (await import('./document-dialogs')).ShareForm,
}));

function useTenant(): string {
  return useSession((state) => state.me?.tenant.id) ?? '';
}

// The customer's document language and phone (the document carries only the customer's name and
// code). null while the customer loads; English if it cannot be read, so Download still works.
function useCustomerOf(customerId: string): {
  language: LanguageCode;
  phone: string | null;
} | null {
  const customer = useQuery(customerQuery(useTenant(), customerId));
  if (customer.data) {
    return { language: customer.data.documentLanguage, phone: customer.data.phone };
  }
  return customer.isError ? { language: 'en', phone: null } : null;
}

// Download PDF: ask for the file, wait while the worker draws it, then save it. A second click
// while the first one waits does nothing: the button says "Making the PDF…" and is disabled.
function useDownload(target: OutputTarget) {
  const { t, errorText } = useLocale();
  const { kind, id } = target;
  return useMutation({
    mutationFn: async (language: LanguageCode) =>
      waitForPdf(
        await call(routes.documentOutput.file, { params: { kind, id }, body: { language } }),
        (fileId) => call(routes.documentOutput.getFile, { params: { kind, id, fileId } }),
      ),
    onSuccess: (outcome) => {
      if (outcome.status === 'ready') saveFile(outcome.file);
      else
        toast(
          t(outcome.status === 'failed' ? 'documentOutput.pdfFailed' : 'documentOutput.pdfSlow'),
        );
    },
    onError: (error) => {
      toast(errorText(failureOf(error) ?? 'unknown_error'));
    },
  });
}

// One "Send" menu next to Print (decision 29). Someone who may not send the document still may
// download it (decision 10): they get a single button instead of a menu with one item.
export function SendMenu({ target }: { target: OutputTarget }) {
  const { t } = useLocale();
  const canSend = useCan()(SEND_PERMISSIONS[target.kind]);
  const customer = useCustomerOf(target.customerId);
  const download = useDownload(target);
  const [dialog, setDialog] = useState<'email' | 'share' | null>(null);
  const busy = download.isPending || customer === null;

  if (!canSend || customer === null) {
    return (
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() => {
          if (customer) download.mutate(customer.language);
        }}
      >
        <HugeiconsIcon icon={Pdf01Icon} size={17} strokeWidth={1.5} />
        {download.isPending ? t('documentOutput.preparing') : t('documentOutput.downloadPdf')}
      </Button>
    );
  }

  const other = otherLanguage(customer.language);
  return (
    <>
      {/* modal={false}: the menu opens a dialog; a modal menu would leave the page's
          pointer-events off while the dialog takes over the focus */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" disabled={busy}>
            <HugeiconsIcon icon={SentIcon} size={17} strokeWidth={1.5} />
            {download.isPending ? t('documentOutput.preparing') : t('documentOutput.send')}
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={16}
              strokeWidth={1.5}
              className="text-ink-3"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            icon={Pdf01Icon}
            onSelect={() => {
              download.mutate(customer.language);
            }}
          >
            {t('documentOutput.downloadPdf')}
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={Pdf01Icon}
            onSelect={() => {
              download.mutate(other);
            }}
          >
            {t('documentOutput.downloadPdfIn', { language: languageName(other) })}
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={Mail01Icon}
            onSelect={() => {
              setDialog('email');
            }}
          >
            {t('documentOutput.email')}
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={WhatsappIcon}
            onSelect={() => {
              setDialog('share');
            }}
          >
            {t('documentOutput.share')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <Suspense fallback={null}>
          {dialog === 'email' && (
            <EmailForm
              target={target}
              language={customer.language}
              onDone={() => {
                setDialog(null);
              }}
            />
          )}
          {dialog === 'share' && (
            <ShareForm target={target} language={customer.language} phone={customer.phone} />
          )}
        </Suspense>
      </Dialog>
    </>
  );
}
```

- **Why a lazy chunk.** The menu brings Radix's dropdown with its positioning code. With the menu and the history in
  the pages' own chunks, the invoice page went from 68 KB to 108 KB, over its 100 KB budget. The page shows Print at
  once and the menu a moment later.
- **The dialogs are one more chunk,** loaded when one opens. The comment at the top explains a trap we hit: if the
  dialogs share a module with the menu that no other page uses, the bundler puts that module into the menu's chunk,
  the dialogs' chunk then imports the menu's chunk, and the budget check counts the whole dropdown again for the
  dialogs (it went from 75 KB to 97 KB that way, through one WhatsApp icon).
- **`useCustomerOf()`** reads the customer for its document language and phone. A document carries only the
  customer's name and code. While the customer loads, the button is disabled; if the customer cannot be read, the
  menu still works, in English.
- **`useDownload()`**: ask, wait (`waitForPdf`), save. The three endings are three toasts: ready saves the file,
  `failed` says "Couldn't make the PDF", still pending says "taking longer than usual" (16.5). An API error (a draft,
  `document_not_issued`) shows its own text.
- **The button says "Making the PDF…" and is disabled while it waits.** A second click would only start a second
  wait for the same row.
- **No send permission, no menu** (decision 29): a single "Download PDF" button. A menu with one item would be one
  click too many.
- **`modal={false}` on the dropdown.** The menu's items open a dialog. A modal Radix menu turns pointer events off on
  the page while it is open, and when a dialog opens from it, the page can stay unclickable after both close.
- **The share dialog has no `onDone`:** the person closes it with Close or the X. It stays open after the link is
  made, because the link is shown only there (decision 13).

### The dialogs: `components/document-dialogs.tsx` (new)

```tsx
import { Copy01Icon, LinkSquare02Icon, Mail01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type DocumentEmailDraft,
  type DocumentEmailFormValues,
  type DocumentEmailInput,
  documentEmailInputSchema,
  type LanguageCode,
  MAX_EMAIL_RECIPIENTS,
  routes,
  SHARE_LINK_DAYS,
  whatsAppNumber,
} from '@omnivo/contracts';
import { LANGUAGES, useLocale } from '@omnivo/i18n';
import {
  Button,
  DialogClose,
  DialogContent,
  Field,
  FormAlert,
  Input,
  SelectField,
  TextAreaField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import type { OutputTarget } from '../lib/document-output';
import { documentEmailsQuery, documentSharesQuery, emailDraftQuery } from '../lib/document-queries';
import { settingsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { failureOf } from './journal-parts';

// The Send menu's two dialogs (step 16), a lazy chunk of their own: send-menu.tsx says why.

const LANGUAGE_OPTIONS = LANGUAGES.map((language) => ({
  value: language.code,
  label: language.label,
}));

const EMAIL_FIELDS = ['to', 'cc', 'subject', 'message', 'language'] as const;

function useTenant(): string {
  return useSession((state) => state.me?.tenant.id) ?? '';
}

// "Email": the server's draft in the customer's language first, then the form. The dialog shows
// once the draft is there (a fraction of a second): a form that fills itself while someone types
// into it would lose what they typed.
export function EmailForm({
  target,
  language,
  onDone,
}: {
  target: OutputTarget;
  language: LanguageCode;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const draft = useQuery(emailDraftQuery(useTenant(), target.kind, target.id, language));
  if (draft.isError) {
    return (
      <DialogContent title={t('documentOutput.emailDialog.title', { number: target.number })}>
        <p className="text-body-sm text-crit">{t('documentOutput.emailDialog.loadFailed')}</p>
      </DialogContent>
    );
  }
  if (!draft.data) return null;
  return <EmailFields target={target} language={language} draft={draft.data} onDone={onDone} />;
}

function EmailFields({
  target,
  language,
  draft,
  onDone,
}: {
  target: OutputTarget;
  language: LanguageCode;
  draft: DocumentEmailDraft;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const tenantId = useTenant();
  const queryClient = useQueryClient();
  const replyTo = useQuery(settingsQuery(tenantId)).data?.email ?? null;
  const { kind, id } = target;
  const [rewriting, setRewriting] = useState(false);
  const {
    register,
    handleSubmit,
    getValues,
    setValue,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<DocumentEmailFormValues, unknown, DocumentEmailInput>({
    resolver: zodResolver(documentEmailInputSchema, { error: contractErrorMap }),
    defaultValues: {
      to: draft.to,
      cc: '',
      subject: draft.subject,
      message: draft.message,
      language,
    },
  });

  // A new language writes the subject and the message again, from the server's draft in that
  // language (decision 30); To and CC stay as typed. A second change before the first answer
  // came back wins: the older answer is dropped when it arrives.
  const rewrite = async () => {
    const wanted = getValues('language');
    setRewriting(true);
    try {
      const next = await queryClient.query(emailDraftQuery(tenantId, kind, id, wanted));
      if (getValues('language') !== wanted) return;
      setValue('subject', next.subject, { shouldValidate: true });
      setValue('message', next.message);
    } catch (error) {
      applyApiError(error, EMAIL_FIELDS, setError);
    } finally {
      setRewriting(false);
    }
  };

  const onSubmit = handleSubmit(async (values) => {
    // The body is what the schema takes in (one string per box), so the cleaned lists go back as
    // text: lower case, no duplicates, the way the server will read them again
    const body = { ...values, to: values.to.join(', '), cc: values.cc.join(', ') };
    try {
      await call(routes.documentOutput.sendEmail, { params: { kind, id }, body });
      await queryClient.invalidateQueries({
        queryKey: documentEmailsQuery(tenantId, kind, id).queryKey,
      });
      // "Sending", not "Sent": the request only queues it, and the history shows when it went
      toast(t('documentOutput.emailDialog.sent', { to: body.to }));
      onDone();
    } catch (error) {
      applyApiError(error, EMAIL_FIELDS, setError);
    }
  });

  const hint = t('documentOutput.emailDialog.recipientsHint', { max: MAX_EMAIL_RECIPIENTS });
  return (
    <DialogContent
      title={t('documentOutput.emailDialog.title', { number: target.number })}
      description={
        replyTo === null
          ? t('documentOutput.emailDialog.noReplyTo')
          : t('documentOutput.emailDialog.replyTo', { email: replyTo })
      }
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="email-form" disabled={isSubmitting || rewriting}>
            <HugeiconsIcon icon={Mail01Icon} size={17} strokeWidth={1.5} />
            {isSubmitting
              ? t('documentOutput.emailDialog.sending')
              : t('documentOutput.emailDialog.send')}
          </Button>
        </>
      }
    >
      <form
        id="email-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <SelectField
          label={t('documentOutput.emailDialog.language')}
          hint={t('documentOutput.emailDialog.languageHint')}
          options={LANGUAGE_OPTIONS}
          {...register('language', {
            onChange: () => {
              void rewrite();
            },
          })}
          error={errors.language?.message}
        />
        <TextField
          label={t('documentOutput.emailDialog.to')}
          // An address list, not one address: type="email" would refuse the comma
          type="text"
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          placeholder={t('documentOutput.emailDialog.toPlaceholder')}
          // The customer has no email: say so under the box until someone types one
          hint={draft.to === '' ? t('documentOutput.emailDialog.noCustomerEmail') : hint}
          {...register('to')}
          error={errors.to?.message}
        />
        <TextField
          label={t('documentOutput.emailDialog.cc')}
          optional
          type="text"
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          hint={hint}
          {...register('cc')}
          error={errors.cc?.message}
        />
        <TextField
          label={t('documentOutput.emailDialog.subject')}
          {...register('subject')}
          error={errors.subject?.message}
        />
        <TextAreaField
          label={t('documentOutput.emailDialog.message')}
          rows={6}
          hint={t('documentOutput.emailDialog.messageHint')}
          {...register('message')}
          error={errors.message?.message}
        />
        {/* The name the API gives the attachment (email.handler.ts) */}
        <p className="text-label text-ink-3">
          {t('documentOutput.emailDialog.attachment', { file: `${target.number}.pdf` })}
        </p>
      </form>
    </DialogContent>
  );
}

// The browser's clipboard can refuse (an old browser, a page not on HTTPS): then the person
// selects the text in its box and copies it themselves
function useCopy(): (text: string, done: string) => void {
  const { t } = useLocale();
  return (text, done) => {
    navigator.clipboard.writeText(text).then(
      () => {
        toast(done);
      },
      () => {
        toast(t('documentOutput.copyFailed'));
      },
    );
  };
}

// The primary button's look on a real link. "Open WhatsApp" must be an <a> the person clicks:
// a window opened by the page after the request came back is blocked by Safari and Firefox
// (decision 28).
const LINK_BUTTON =
  'inline-flex min-h-[42px] items-center justify-center gap-2 rounded-control bg-brand px-4 text-body font-medium whitespace-nowrap text-brand-ink shadow-sm transition-colors duration-150 hover:bg-brand-hover';

// "Share on WhatsApp": pick the language, make the link, then copy it or open WhatsApp with the
// message ready. The link is shown only here (decision 13): closing the dialog forgets it.
export function ShareForm({
  target,
  language,
  phone,
}: {
  target: OutputTarget;
  language: LanguageCode;
  phone: string | null;
}) {
  const { t } = useLocale();
  const tenantId = useTenant();
  const queryClient = useQueryClient();
  const copy = useCopy();
  const linkId = useId();
  const [chosen, setChosen] = useState<LanguageCode>(language);
  const { kind, id } = target;
  const create = useMutation({
    mutationFn: () =>
      call(routes.documentOutput.createShare, { params: { kind, id }, body: { language: chosen } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: documentSharesQuery(tenantId, kind, id).queryKey,
      });
    },
  });
  const failure = failureOf(create.error);
  const title = t('documentOutput.shareDialog.title', { number: target.number });
  const description = t('documentOutput.shareDialog.description', { days: SHARE_LINK_DAYS });
  const created = create.data;

  if (!created) {
    return (
      <DialogContent
        title={title}
        description={description}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary">{t('common.cancel')}</Button>
            </DialogClose>
            <Button
              disabled={create.isPending}
              onClick={() => {
                create.mutate();
              }}
            >
              {create.isPending
                ? t('documentOutput.shareDialog.creating')
                : t('documentOutput.shareDialog.create')}
            </Button>
          </>
        }
      >
        <div className="grid gap-5">
          {failure && <FormAlert message={failure} />}
          <SelectField
            label={t('documentOutput.shareDialog.language')}
            hint={t('documentOutput.shareDialog.languageHint')}
            options={LANGUAGE_OPTIONS}
            value={chosen}
            onChange={(event) => {
              const next = LANGUAGES.find((item) => item.code === event.target.value);
              if (next) setChosen(next.code);
            }}
          />
        </div>
      </DialogContent>
    );
  }

  return (
    <DialogContent
      title={title}
      description={description}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.close')}</Button>
          </DialogClose>
          <a
            href={created.whatsAppUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={LINK_BUTTON}
          >
            {/* It opens another app or tab. Not the WhatsApp icon: the Send menu has that one, and
                a module used only by the menu and this dialog would make the bundler fold it into
                the menu's chunk (send-menu.tsx says what that costs). */}
            <HugeiconsIcon icon={LinkSquare02Icon} size={17} strokeWidth={1.5} />
            {t('documentOutput.shareDialog.openWhatsApp')}
          </a>
        </>
      }
    >
      <div className="grid gap-5">
        <Field
          id={linkId}
          label={t('documentOutput.shareDialog.link')}
          hint={t('documentOutput.shareDialog.shownOnce')}
        >
          {/* Read only, and selected on focus: one tap selects it for copying by hand */}
          <Input
            id={linkId}
            readOnly
            value={created.url}
            onFocus={(event) => {
              event.currentTarget.select();
            }}
          />
        </Field>
        <TextAreaField
          label={t('documentOutput.shareDialog.message')}
          readOnly
          rows={4}
          value={created.message}
          onFocus={(event) => {
            event.currentTarget.select();
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              copy(created.url, t('documentOutput.shareDialog.linkCopied'));
            }}
          >
            <HugeiconsIcon icon={Copy01Icon} size={16} strokeWidth={1.5} />
            {t('documentOutput.shareDialog.copyLink')}
          </Button>
          {/* For a customer on Messenger or IMO, or for an SMS */}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              copy(created.message, t('documentOutput.shareDialog.messageCopied'));
            }}
          >
            <HugeiconsIcon icon={Copy01Icon} size={16} strokeWidth={1.5} />
            {t('documentOutput.shareDialog.copyMessage')}
          </Button>
        </div>
        {/* The same reading of the phone the server used for the link (decision 17) */}
        {whatsAppNumber(phone) === null && (
          <p className="text-label text-ink-3">{t('documentOutput.shareDialog.noNumber')}</p>
        )}
      </div>
    </DialogContent>
  );
}
```

The email dialog:

- **The form waits for the server's draft.** It appears a fraction of a second later than a form that fills itself,
  but a form that fills itself while someone types into it loses what they typed. If the draft cannot be loaded,
  the dialog says so.
- **`useForm<DocumentEmailFormValues, unknown, DocumentEmailInput>`.** The boxes hold text (`to: string`); the schema
  turns To and CC into lists. With these three types, `values` in `handleSubmit` is the parsed form, so
  `values.to` is a `string[]`.
- **The body goes back as text.** The route's body type is the schema's input (one string per box), because the
  server parses it again. The page joins the cleaned lists, so the server gets the addresses in lower case and
  without duplicates, and the toast names the same list.
- **Changing the language** (decision 30) fetches the draft in the new language and writes the subject and the
  message again; To and CC stay. If the person changes it twice quickly, the older answer is dropped when it
  arrives (`getValues('language') !== wanted`). Send is disabled while the new text is on its way, so the email
  cannot go out with the old language's words.
- **`queryClient.query()`**, not `fetchQuery()`: TanStack Query marks `fetchQuery` as going away, and ESLint
  refuses deprecated calls.
- **To is `type="text"` with `inputMode="email"`.** `type="email"` would refuse a comma (several addresses); the
  input mode still gives a phone the keyboard with `@`.
- **The hint under To** is "This customer has no email" when the draft had no address, else how to separate
  addresses. The dialog's description says where replies go, or that there is no company email to reply to.
- **"Attached: INV-….pdf"** uses the same name the API gives the attachment (`email.handler.ts`).

The share dialog:

- **Two states:** first the language and "Make link", then the link and the message. The link exists only in this
  answer (decision 13), so the second state keeps it until the dialog closes.
- **The language select is a plain controlled select,** not a form: there is nothing to validate.
- **"Open WhatsApp" is a real `<a>` with `target="_blank"`** (decision 28). `rel="noopener noreferrer"` keeps
  WhatsApp's page from reaching back into ours. It looks like the primary button (`LINK_BUTTON`, the button's own
  classes). Its icon is the external-link icon, not WhatsApp's: the reason is the trap described under the Send menu.
- **Copy uses the clipboard, with a fallback.** If the browser refuses, a toast says to copy by hand, and both boxes
  select their whole text on focus, so one tap is enough.
- **"No mobile number"** uses the contract's `whatsAppNumber()`, the same reading of the phone the server used to
  build the link, so the note and the link never disagree.

### The history: `components/document-history.tsx` (new)

```tsx
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
```

- **Two cards side by side** on a wide screen, one under the other on a phone. They use `LinkList`, the card the
  document pages already use for payments and credit notes, so they look the same.
- **Everyone who can read the document sees the history** (the API asks no permission, decision 10). Only someone
  who may send it sees "Turn off".
- **Email statuses:** Sending is `brand` with a clock (work in progress, CLAUDE.md → Sales document statuses), Sent is
  `good`, Failed is `crit` with what to do under it.
- **Times are in the workspace's time zone,** like the bell and the audit log: "the email went at 16:05" means the
  same in Dhaka and in Dubai.
- **Addresses break anywhere** (`break-all`): a long address must not push the card wider than a phone screen.
- **Share states:** Active is `good` with a link icon; Ended and Turned off are neutral, because neither needs action.
- **Each "Turn off" button has a label with the link's date** (16.5): a screen reader hears which link it turns off.
- **`RevokeDialog`** asks first (decision 31). After it, the list is refreshed and the toast says the link is off.

### The four document pages

```diff
@@ -5,9 +5,10 @@ import { useLocale } from '@omnivo/i18n';
 import { Button, Card, FormAlert, PageHeader, toast } from '@omnivo/ui';
 import { useMutation } from '@tanstack/react-query';
 import { Link, useNavigate } from '@tanstack/react-router';
-import { useState } from 'react';
+import { lazy, Suspense, useState } from 'react';
 
 import { call } from '../lib/api';
+import type { OutputTarget } from '../lib/document-output';
 import { useCan } from '../lib/permissions';
 import { isExpired } from '../lib/sales';
 import { Fact } from './adjustment-view';
@@ -18,6 +19,12 @@ import { CustomerLink, DocumentNotice, SalesBackLink, useSalesRefresh } from './
 import { QuotationStatusPill } from './sales-pills';
 import { useIsoDate } from './stock-parts';
 
+// Step 16: the Send menu and the history cards, each a chunk of its own (send-menu.tsx says why)
+const SendMenu = lazy(async () => ({ default: (await import('./send-menu')).SendMenu }));
+const DocumentHistory = lazy(async () => ({
+  default: (await import('./document-history')).DocumentHistory,
+}));
+
 // A quotation as the customer got it, with what can be done with it next: make the order, change
 // it, mark it declined or delete it while it is open; open it again once declined.
 export function QuotationView({
@@ -39,6 +46,13 @@ export function QuotationView({
   const [confirming, setConfirming] = useState(false);
   const open = quotation.status === 'open';
   const { version } = quotation;
+  // Step 16: a quotation has its number from the moment it is saved, so it can always go out
+  const target: OutputTarget = {
+    kind: 'quotation',
+    id: quotation.id,
+    number: quotation.number,
+    customerId: quotation.customer.id,
+  };
 
   const decline = useMutation({
     mutationFn: () =>
@@ -78,6 +92,9 @@ export function QuotationView({
           <>
             <QuotationStatusPill quotation={quotation} today={today} />
             <PrintButton />
+            <Suspense fallback={null}>
+              <SendMenu target={target} />
+            </Suspense>
           </>
         }
       />
@@ -197,6 +214,9 @@ export function QuotationView({
           </Button>
         </div>
       )}
+      <Suspense fallback={null}>
+        <DocumentHistory target={target} />
+      </Suspense>
       <QuotationPrint quotation={quotation} />
     </div>
   );
```

```diff
@@ -15,8 +15,10 @@ import { useLocale } from '@omnivo/i18n';
 import { Button, Card, FormAlert, PageHeader, toast } from '@omnivo/ui';
 import { useMutation, useQuery } from '@tanstack/react-query';
 import { Link, useNavigate } from '@tanstack/react-router';
+import { lazy, Suspense } from 'react';
 
 import { call } from '../lib/api';
+import type { OutputTarget } from '../lib/document-output';
 import { daysLate } from '../lib/invoices';
 import { useCan } from '../lib/permissions';
 import { branchesQuery } from '../lib/queries';
@@ -37,6 +39,12 @@ import {
 import { InvoicePills } from './sales-pills';
 import { useIsoDate, useTenantId, useWarehouses, warehouseLabel } from './stock-parts';
 
+// Step 16: the Send menu and the history cards, each a chunk of its own (send-menu.tsx says why)
+const SendMenu = lazy(async () => ({ default: (await import('./send-menu')).SendMenu }));
+const DocumentHistory = lazy(async () => ({
+  default: (await import('./document-history')).DocumentHistory,
+}));
+
 // A posted invoice (or a draft for someone who may not write invoices), read only. A posted one
 // never changes: a credit note corrects it (15d). What it was paid with, and "Record payment"
 // while something is still due. Step 15d: what credit notes took back, "Write credit note", and
@@ -55,6 +63,11 @@ export function InvoiceView({ invoice, today }: { invoice: Invoice; today: strin
   const posted = invoice.status === 'posted';
   const late = isOverdue(invoice, today) ? daysLate(invoice.dueDate, today) : 0;
   const open = posted && paymentStatusOf(invoice) !== 'paid';
+  // Step 16: only a numbered invoice goes out (decision 11); a draft has no number yet
+  const target: OutputTarget | null =
+    posted && invoice.number !== null
+      ? { kind: 'invoice', id: invoice.id, number: invoice.number, customerId: invoice.customer.id }
+      : null;
 
   // "Credit whole invoice" (decision 5): a draft with every line as it was billed, saved in one
   // click and opened, so the person checks it before posting. No route of its own: the lines come
@@ -88,6 +101,11 @@ export function InvoiceView({ invoice, today }: { invoice: Invoice; today: strin
           <>
             <InvoicePills invoice={invoice} today={today} />
             {posted && <PrintButton />}
+            {target && (
+              <Suspense fallback={null}>
+                <SendMenu target={target} />
+              </Suspense>
+            )}
           </>
         }
       />
@@ -283,6 +301,11 @@ export function InvoiceView({ invoice, today }: { invoice: Invoice; today: strin
           )}
         </div>
       )}
+      {target && (
+        <Suspense fallback={null}>
+          <DocumentHistory target={target} />
+        </Suspense>
+      )}
       {posted && <InvoicePrint invoice={invoice} />}
     </div>
   );
```

```diff
@@ -17,6 +17,7 @@ import { Link, useNavigate } from '@tanstack/react-router';
 import { lazy, Suspense, useState } from 'react';
 
 import { call } from '../lib/api';
+import type { OutputTarget } from '../lib/document-output';
 import { useCan } from '../lib/permissions';
 import { accountsQuery, branchesQuery } from '../lib/queries';
 import { Fact } from './adjustment-view';
@@ -26,6 +27,12 @@ import { CustomerLink, DocumentNotice, SalesBackLink } from './sales-parts';
 import { ReceiptStatusPill } from './sales-pills';
 import { useIsoDate, useTenantId } from './stock-parts';
 
+// Step 16: the Send menu and the history cards, each a chunk of its own (send-menu.tsx says why)
+const SendMenu = lazy(async () => ({ default: (await import('./send-menu')).SendMenu }));
+const DocumentHistory = lazy(async () => ({
+  default: (await import('./document-history')).DocumentHistory,
+}));
+
 // The two dialogs as a chunk of their own, loaded when one opens: they bring the form library, the
 // money boxes (decimal.js) and the date picker, and inside this chunk they took it to 113 KB, over
 // its 100 KB budget. Most visits only read the receipt.
@@ -57,6 +64,10 @@ export function ReceiptView({ receipt, today }: { receipt: Receipt; today: strin
   // Step 15d: money a refund paid back is neither applied nor an advance any more
   const unapplied = unappliedOf(receipt);
   const account = accounts?.find((item) => item.id === receipt.accountId);
+  // Step 16: a voided receipt does not go out (decision 11), the same rule as Print
+  const target: OutputTarget | null = posted
+    ? { kind: 'receipt', id: receipt.id, number: receipt.number, customerId: receipt.customer.id }
+    : null;
 
   return (
     <div className="grid max-w-6xl grid-cols-1 gap-5">
@@ -68,6 +79,11 @@ export function ReceiptView({ receipt, today }: { receipt: Receipt; today: strin
           <>
             <ReceiptStatusPill status={receipt.status} />
             {posted && <PrintButton />}
+            {target && (
+              <Suspense fallback={null}>
+                <SendMenu target={target} />
+              </Suspense>
+            )}
           </>
         }
       />
@@ -231,6 +247,11 @@ export function ReceiptView({ receipt, today }: { receipt: Receipt; today: strin
           )}
         </Suspense>
       </Dialog>
+      {target && (
+        <Suspense fallback={null}>
+          <DocumentHistory target={target} />
+        </Suspense>
+      )}
       {posted && <ReceiptPrint receipt={receipt} />}
     </div>
   );
```

```diff
@@ -16,6 +16,7 @@ import { Link, useNavigate } from '@tanstack/react-router';
 import { lazy, Suspense, useState } from 'react';
 
 import { call } from '../lib/api';
+import type { OutputTarget } from '../lib/document-output';
 import { useCan } from '../lib/permissions';
 import { creditReasonKey } from '../lib/returns';
 import { Fact } from './adjustment-view';
@@ -33,6 +34,12 @@ import {
 import { DocumentStatusPill } from './sales-pills';
 import { useIsoDate } from './stock-parts';
 
+// Step 16: the Send menu and the history cards, each a chunk of its own (send-menu.tsx says why)
+const SendMenu = lazy(async () => ({ default: (await import('./send-menu')).SendMenu }));
+const DocumentHistory = lazy(async () => ({
+  default: (await import('./document-history')).DocumentHistory,
+}));
+
 // "Apply money" is the receipt's dialog (money-dialogs.tsx), loaded when it opens
 const ApplyForm = lazy(async () => ({ default: (await import('./money-dialogs')).ApplyForm }));
 
@@ -56,6 +63,16 @@ export function CreditNoteView({ creditNote }: { creditNote: CreditNote }) {
   const [applying, setApplying] = useState(false);
   const money = (value: string) => format.money(value, { decimals: 2 });
   const posted = creditNote.status === 'posted';
+  // Step 16: only a posted credit note has a number and goes out (decision 11)
+  const target: OutputTarget | null =
+    posted && creditNote.number !== null
+      ? {
+          kind: 'credit_note',
+          id: creditNote.id,
+          number: creditNote.number,
+          customerId: creditNote.customer.id,
+        }
+      : null;
   const unapplied = unappliedOf({
     amount: creditNote.total,
     applied: creditNote.applied,
@@ -75,6 +92,11 @@ export function CreditNoteView({ creditNote }: { creditNote: CreditNote }) {
               label={t(`creditNotes.statuses.${creditNote.status}`)}
             />
             {posted && <PrintButton />}
+            {target && (
+              <Suspense fallback={null}>
+                <SendMenu target={target} />
+              </Suspense>
+            )}
           </>
         }
       />
@@ -219,6 +241,11 @@ export function CreditNoteView({ creditNote }: { creditNote: CreditNote }) {
           )}
         </Suspense>
       </Dialog>
+      {target && (
+        <Suspense fallback={null}>
+          <DocumentHistory target={target} />
+        </Suspense>
+      )}
       {posted && <CreditNotePrint creditNote={creditNote} />}
     </div>
   );
```

- **`target` is built only for a document that may go out** (decision 11): a quotation always (it has its number when
  saved), an invoice and a credit note once posted, a receipt unless voided. The same rule decides whether Print is
  shown, so Print and Send always appear together.
- **`SendMenu` and `DocumentHistory` are lazy,** each in a `Suspense` with no fallback. The header keeps Print and
  the status pill at once; the menu joins them a moment later.
- **The history goes last, just before the print sheet.** What the document says comes first; who it was sent to is
  history.

### The public page: `routes/public-document.tsx` (new)

```tsx
import { Alert02Icon, Pdf01Icon, Unlink01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  isOutputDocument,
  type PublicDocument,
  routes,
  SHARE_LINK_DAYS,
  SHARE_TOKEN_PATTERN,
} from '@omnivo/contracts';
import { setLanguage, useLocale } from '@omnivo/i18n';
import { Button, Card, EmptyState, parseIsoDate } from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { type ReactNode, useEffect } from 'react';

import { ApiRequestError, call } from '../lib/api';
import { saveFile } from '../lib/document-output';

// Step 16: the page behind a share link (/d/<token>). No login and no app shell: the customer is
// not an Omnivo user. It says what the document is and from whom, and downloads its PDF.

// While the PDF is being drawn the page asks again every 2 s, at most 15 times (30 s). After that
// it says the PDF could not be made: a worker that is down does not get better by being asked.
const POLL_MS = 2000;
const MAX_POLLS = 15;

function Frame({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  return (
    <div className="flex min-h-dvh flex-col bg-bg px-4 py-8 sm:px-16">
      <div className="grid flex-1 place-items-center py-10">
        <div className="w-full max-w-[480px]">{children}</div>
      </div>
      {/* The sender is the company; Omnivo only carries the file, so a quiet line, not the logo
          (the logo's own "Omnivo" next to "Sent with Omnivo" said the name twice) */}
      <footer className="text-center text-caption text-ink-3">
        {t('publicDocument.poweredBy')}
      </footer>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-caption font-medium text-ink-3">{label}</dt>
      <dd className="text-body-sm text-ink tabular-nums">{value}</dd>
    </div>
  );
}

function DocumentCard({
  shared,
  polls,
  onDownload,
  downloading,
}: {
  shared: PublicDocument;
  polls: number;
  onDownload: () => void;
  downloading: boolean;
}) {
  const { t, format } = useLocale();
  const date = (iso: string) => {
    const parsed = parseIsoDate(iso);
    return parsed ? format.date(parsed) : iso;
  };
  // ৳ is the app's sign for taka; another currency is written by its code, after the amount
  const money = (value: string) =>
    shared.currency === 'BDT'
      ? format.money(value, { decimals: 2 })
      : `${format.number(value, 2)} ${shared.currency}`;
  const name = isOutputDocument(shared.kind)
    ? t(`documentOutput.kinds.${shared.kind}`)
    : t('publicDocument.document');
  const { status } = shared.file;
  const gaveUp = status === 'failed' || (status === 'pending' && polls >= MAX_POLLS);

  return (
    <Card className="grid gap-6 p-[22px] sm:p-8">
      <header className="flex items-center gap-3">
        {shared.logoUrl !== null && (
          // The company's name sits next to it and says the same: an empty alt
          <img src={shared.logoUrl} alt="" className="h-10 w-auto max-w-28 object-contain" />
        )}
        <p className="text-label font-medium text-ink-2">
          {t('publicDocument.from', { company: shared.company })}
        </p>
      </header>
      <div className="grid gap-1">
        <h1 className="text-h1 text-balance">
          {name} {/* A number never breaks at its hyphens: on a phone "QT-" ended one line */}
          <span className="font-mono whitespace-nowrap tabular-nums">{shared.number}</span>
        </h1>
        <p className="text-body-sm text-ink-2">
          {t('publicDocument.to', { customer: shared.customer })}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
        <Fact label={t('publicDocument.date')} value={date(shared.date)} />
        <Fact label={t('publicDocument.total')} value={money(shared.total)} />
        {shared.dueDate !== null && (
          <Fact label={t('publicDocument.dueDate')} value={date(shared.dueDate)} />
        )}
        {shared.amountDue !== null && (
          <Fact label={t('publicDocument.amountDue')} value={money(shared.amountDue)} />
        )}
      </dl>
      {gaveUp ? (
        <p className="flex items-center gap-1.5 text-label text-crit">
          <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
          {t('publicDocument.failed')}
        </p>
      ) : (
        <Button
          className="w-full"
          disabled={status !== 'ready' || downloading}
          onClick={onDownload}
        >
          <HugeiconsIcon icon={Pdf01Icon} size={17} strokeWidth={1.5} />
          {status === 'ready' ? t('publicDocument.download') : t('publicDocument.preparing')}
        </Button>
      )}
      <p className="text-label text-ink-3">{t('publicDocument.private')}</p>
    </Card>
  );
}

export function PublicDocumentPage() {
  const { t } = useLocale();
  const { token = '' } = useParams({ strict: false });
  // A token of the wrong shape cannot be a link: the page says "no longer works" without asking
  // the server (which would answer 400, not 404)
  const wellFormed = SHARE_TOKEN_PATTERN.test(token);
  const queryKey = ['public-document', token];
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey,
    queryFn: () => call(routes.publicDocuments.get, { params: { token } }),
    enabled: wellFormed,
    retry: false,
    refetchInterval: (current) =>
      current.state.data?.file.status === 'pending' && current.state.dataUpdateCount < MAX_POLLS
        ? POLL_MS
        : false,
  });
  const shared = query.data;

  // The page reads in the language the sender chose for the link, in this tab only: the customer
  // may use Omnivo in another language themselves (remember: false, 16.6)
  const language = shared?.language;
  useEffect(() => {
    if (language !== undefined) void setLanguage(language, { remember: false });
  }, [language]);

  // The tab's title names the sender: the customer may have three of these open
  useEffect(() => {
    if (!shared) return;
    const name = isOutputDocument(shared.kind)
      ? t(`documentOutput.kinds.${shared.kind}`)
      : t('publicDocument.document');
    document.title = t('publicDocument.pageTitle', {
      document: name,
      number: shared.number,
      company: shared.company,
    });
  }, [shared, t]);

  // Asks again before saving: the download link inside the answer is short-lived, and the
  // customer may tap the button long after the page loaded
  const download = async () => {
    const fresh = await query.refetch();
    if (fresh.data?.file.status === 'ready') saveFile(fresh.data.file);
  };

  const gone =
    !wellFormed ||
    (query.error instanceof ApiRequestError && query.error.code === 'share_link_not_found');

  return (
    <Frame>
      {gone ? (
        // One text for an unknown, an ended and a turned-off link (decision 14)
        <EmptyState
          icon={Unlink01Icon}
          title={t('publicDocument.goneTitle')}
          description={t('publicDocument.goneBody', { days: SHARE_LINK_DAYS })}
        />
      ) : query.isError ? (
        <div className="grid justify-items-center gap-4 text-center">
          <p className="text-body-sm text-crit">{t('publicDocument.loadFailed')}</p>
          <Button
            variant="secondary"
            onClick={() => {
              void query.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : shared ? (
        <DocumentCard
          shared={shared}
          // How many answers came so far: the state the refetchInterval above counts with
          polls={queryClient.getQueryState(queryKey)?.dataUpdateCount ?? 0}
          downloading={query.isFetching}
          onDownload={() => {
            void download();
          }}
        />
      ) : null}
    </Frame>
  );
}
```

- **No app shell and no login.** The customer is not an Omnivo user. The page is a card on the page background with
  "Sent with Omnivo" under it: the company is the sender, Omnivo only carries the file.
- **A token of the wrong shape never reaches the server.** `SHARE_TOKEN_PATTERN` is the contract's own check; the API
  would answer 400 for it, not 404, and the page would show "couldn't open" instead of "this link no longer works".
- **`gone`** is one text for an unknown, an ended and a turned-off link (decision 14). Any other error (no network)
  says so and offers Retry.
- **Polling:** every 2 seconds while the file is pending, at most 15 times. `refetchInterval` counts with the query's
  `dataUpdateCount`; the card reads the same count from the query client (the observer result does not carry it)
  to decide when to say the PDF could not be made.
- **The language** (decision 34): `setLanguage(language, { remember: false })` switches this tab only.
- **The tab's title** names the document, its number and the sender, in the page's language.
- **The number never breaks** (`whitespace-nowrap`). A browser may break a line after a hyphen; on a phone the Bangla
  heading showed "কোটেশন QT-" on one line and the rest of the number on the next (found in 16.7).
- **The footer is one quiet line,** "Sent with Omnivo", without the logo: the logo has the word "Omnivo" itself, and
  the two side by side said the name twice (found in 16.7).
- **Download asks again first.** The download link inside the answer is short-lived (minutes), and a customer may
  tap the button long after the page opened. A fresh answer has a fresh link.
- **Money:** `৳` for taka, like the rest of the app; another currency is written by its code after the amount, since
  the app has no symbol table for it.
- **A newer server's fifth kind** shows as "Document" (16.5), so the page still works.

```diff
@@ -39,6 +39,15 @@ const inviteRoute = createRoute({
   component: lazyRouteComponent(() => import('./routes/invite'), 'InvitePage'),
 });
 
+// Step 16: a share link (/d/<token>, sent on WhatsApp). No login, and no redirect for someone who
+// is signed in: the sender may open it to check what the customer sees. Outside the AppShell:
+// the customer is not a user of the app.
+const publicDocumentRoute = createRoute({
+  getParentRoute: () => rootRoute,
+  path: '/d/$token',
+  component: lazyRouteComponent(() => import('./routes/public-document'), 'PublicDocumentPage'),
+});
+
 const signUpRoute = createRoute({
   getParentRoute: () => rootRoute,
   path: '/sign-up',
@@ -615,6 +624,7 @@ const routeTree = rootRoute.addChildren([
   loginRoute,
   signUpRoute,
   inviteRoute,
+  publicDocumentRoute,
   onboardingRoute,
   appRoute.addChildren([
     dashboardRoute,
```

- **Under the root route, not under `appRoute`:** no `beforeLoad`, so nobody is sent to the login page. There is no
  `redirectIfSignedIn` either: the sender may open their own link to see what the customer sees.
- **`lazyRouteComponent`:** the page is a chunk of its own (39 KB), and the first page load does not grow.

```diff
@@ -69,9 +69,15 @@ function syncDocumentLanguage(language: string): void {
 syncDocumentLanguage(i18n.language);
 i18n.on('languageChanged', syncDocumentLanguage);
 
-export async function setLanguage(language: Language): Promise<void> {
+// remember: false changes this tab only. Step 16's public page shows a document in the language
+// its sender chose; a reader who opens a Bangla link keeps their own language for the app.
+export async function setLanguage(
+  language: Language,
+  { remember = true }: { remember?: boolean } = {},
+): Promise<void> {
   await loadLanguage(language);
   await i18n.changeLanguage(language);
+  if (!remember) return;
   try {
     localStorage.setItem(STORAGE_KEY, language);
   } catch {
```

- **`remember` defaults to `true`,** so every existing call (the language switch, the session's preference) works as
  before. Only the public page passes `false`. It still loads the Bangla texts first, so the page never shows a
  missing key.

### The customer's document language

```diff
@@ -19,7 +19,7 @@ import {
   routes,
   updateCustomerInputSchema,
 } from '@omnivo/contracts';
-import { useLocale } from '@omnivo/i18n';
+import { LANGUAGES, useLocale } from '@omnivo/i18n';
 import {
   Button,
   Card,
@@ -64,6 +64,8 @@ function valuesOf(customer: Customer | null): FormValues {
     contactPerson: customer?.contactPerson ?? '',
     phone: customer?.phone ?? '',
     email: customer?.email ?? '',
+    // Step 16: English until someone picks Bangla (decision 4)
+    documentLanguage: customer?.documentLanguage ?? 'en',
     bin: customer?.bin ?? '',
     paymentTermsDays: customer?.paymentTermsDays ?? 0,
     // "0.0000" stays: a limit of nothing is cash only, not "no limit"
@@ -93,6 +95,7 @@ function fieldNames(addressCount: number): Path<FormValues>[] {
     'contactPerson',
     'phone',
     'email',
+    'documentLanguage',
     'bin',
     'paymentTermsDays',
     'creditLimit',
@@ -291,6 +294,17 @@ export function CustomerForm({
                 {...register('bin')}
                 error={errors.bin?.message}
               />
+              {/* Step 16: each language by its own name, like the language switch (decision 32) */}
+              <SelectField
+                label={t('customers.fields.documentLanguage')}
+                hint={t('customers.fields.documentLanguageHint')}
+                options={LANGUAGES.map((language) => ({
+                  value: language.code,
+                  label: language.label,
+                }))}
+                {...register('documentLanguage')}
+                error={errors.documentLanguage?.message}
+              />
             </div>
             <TextAreaField
               label={t('customers.fields.notes')}
```

- **A select with the languages by their own names** (decision 32), in the contact section next to the email it
  is used with. The hint (16.5) says it is only where sending starts.
- **A new customer starts in English** (decision 4), and `documentLanguage` is in the list of field names, so a
  server error about it lands under the select.

```diff
@@ -16,7 +16,7 @@ import {
   routes,
   todayIn,
 } from '@omnivo/contracts';
-import { useLocale } from '@omnivo/i18n';
+import { LANGUAGES, useLocale } from '@omnivo/i18n';
 import {
   Button,
   Card,
@@ -389,6 +389,13 @@ function CustomerView({ customer }: { customer: Customer }) {
             <Detail label={t('customers.fields.contactPerson')} value={customer.contactPerson} />
             <Detail label={t('customers.fields.phone')} value={customer.phone} />
             <Detail label={t('customers.fields.email')} value={customer.email} />
+            <Detail
+              label={t('customers.fields.documentLanguage')}
+              value={
+                LANGUAGES.find((language) => language.code === customer.documentLanguage)?.label ??
+                null
+              }
+            />
             <Detail label={t('customers.fields.bin')} value={customer.bin} />
             <Detail label={t('customers.fields.group')} value={group?.name ?? null} />
             <Detail
```

The customer's page shows the language in its details card, by its own name.

### Amount in words on paper

```diff
@@ -2,6 +2,7 @@ import { PrinterIcon } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
 import {
   amountDueOf,
+  amountInWords,
   type CreditNote,
   type Delivery,
   type DocumentTotals,
@@ -101,6 +102,20 @@ function Sheet({
   );
 }
 
+// Step 16: "In words: Eighteen lakh … taka and fifty paisa only" under a money document's total,
+// in the language of the screen (the PDF has the same words in the customer's language). The
+// currency is the books' own; null until the settings arrive, like the sheet itself.
+function InWords({ amount }: { amount: string }) {
+  const { t, language } = useLocale();
+  const currency = useQuery(settingsQuery(useTenantId())).data?.baseCurrency;
+  if (currency === undefined) return null;
+  return (
+    <p className="break-inside-avoid text-ink-2">
+      {t('print.inWords', { words: amountInWords(amount, language, currency) })}
+    </p>
+  );
+}
+
 // The customer: name and code, then an address as it was saved, one part per line
 function PartyBlock({
   label,
@@ -143,12 +158,15 @@ function PricedLines({
   totals,
   pricesIncludeVat,
   after,
+  words = false,
 }: {
   lines: readonly PricedLine[];
   totals: DocumentTotals;
   pricesIncludeVat: boolean;
   // Rows under the total: what an invoice was paid and still asks for
   after?: { label: string; value: string }[];
+  // Step 16: the total in words, on the money documents only (decision 7)
+  words?: boolean;
 }) {
   const { t, format } = useLocale();
   const quantity = useQuantity();
@@ -272,6 +290,7 @@ function PricedLines({
           ))}
         </dl>
       </div>
+      {words && <InWords amount={totals.total} />}
     </>
   );
 }
@@ -493,6 +512,7 @@ export function InvoicePrint({ invoice }: { invoice: Invoice }) {
         lines={invoice.lines}
         totals={invoice}
         pricesIncludeVat={invoice.pricesIncludeVat}
+        words
         // What is paid by the day it is printed, what credit notes took off (15d), and what is
         // still due
         after={
@@ -548,6 +568,7 @@ export function ReceiptPrint({ receipt }: { receipt: Receipt }) {
           </PrintBlock>
         )}
       </div>
+      <InWords amount={receipt.amount} />
       {receipt.allocations.length > 0 && (
         <PrintBlock label={t('print.appliedTo')}>
           <table className="w-full border-collapse text-caption">
@@ -662,6 +683,7 @@ export function CreditNotePrint({ creditNote }: { creditNote: CreditNote }) {
         lines={creditNote.lines}
         totals={creditNote}
         pricesIncludeVat={creditNote.pricesIncludeVat}
+        words
       />
       <Note note={creditNote.note} />
     </Sheet>
@@ -706,6 +728,7 @@ export function RefundPrint({ refund }: { refund: Refund }) {
           </p>
         </PrintBlock>
       </div>
+      <InWords amount={refund.amount} />
       <Note note={refund.note} />
     </Sheet>
   );
```

- **`InWords`** prints "In words: …" with `amountInWords()` from the contracts, the function the PDF uses, so paper
  and PDF say the same words (decision 7). The language is the screen's (decision 35).
- **The currency is the books' own** (`baseCurrency` from the settings). Until the settings arrive it prints
  nothing; the sheet itself waits for the same query, so on paper the line is always there.
- **`words` on `PricedLines`** is off by default: a quotation, an order and a challan are not money received or
  owed, so they have no amount in words. The invoice and the credit note turn it on.
- **The receipt and the refund** print it under their amount block, where the amount is.
- **`break-inside-avoid`:** the line never starts on one page and ends on the next.

### Keeping every chunk inside its budget

The bundle check (`pnpm --filter @omnivo/app test:bundle-size`) allows 100 KB gzipped per lazy chunk. After 16.5,
before any screen, the sales returns list was already 0.2 KB over: the 16.1 contract made the shared `routes` chunk
bigger, and that chunk is in almost every page. This part's Send menu also made the bundler share Radix's code in a
new way, which moved 0.5 KB out of the first load into the lazy chunks. Four lists and the stock adjustment form
ended over the budget. Two changes fix it (decision 37):

```tsx
import { UserIcon } from '@hugeicons/core-free-icons';
import { Input } from '@omnivo/ui';
import { lazy, Suspense } from 'react';

import type { CustomerPickerProps } from './customer-picker';

// Step 16: the customer filter of the eight sales lists (quotations to refunds), with the picker
// loaded after the page. The picker brings ui's Combobox, its Radix popover and their helpers
// (about 25 KB). The lists had grown to the edge of their 100 KB budget, and step 16 took four of
// them over; without the picker they are about 75 KB. The forms already load the same picker this
// way (receipt-form.tsx). Until it arrives, a disabled box of the same size holds its place, so the
// row does not jump.
const CustomerPicker = lazy(async () => ({
  default: (await import('./customer-picker')).CustomerPicker,
}));

export function CustomerFilter(props: CustomerPickerProps) {
  return (
    <Suspense
      fallback={
        <Input
          id={props.id}
          icon={UserIcon}
          disabled
          aria-label={props['aria-label']}
          placeholder={props.allLabel}
        />
      }
    >
      <CustomerPicker {...props} />
    </Suspense>
  );
}
```

- **`CustomerFilter`** is the list's customer filter with the picker loaded after the page. The picker brings ui's
  Combobox, its Radix popover and their helpers; without them each list drops from about 100 KB to about 75 KB,
  room for several more steps. The forms already load the same picker this way.
- **The fallback is a disabled box of the same size,** with the same id and label, so the row does not jump and a
  screen reader finds the box at once.

```diff
@@ -10,7 +10,7 @@ import { customerSearchQuery } from '../lib/queries';
 import { useSession } from '../lib/session-store';
 import { useDebounced } from '../lib/use-debounced';
 
-interface CustomerPickerProps {
+export interface CustomerPickerProps {
   id: string;
   name?: string;
   // The chosen customer's id, or '' for none
```

`CustomerPickerProps` is exported, so the filter takes exactly the picker's props.

```diff
@@ -14,7 +14,7 @@ import { useInfiniteQuery } from '@tanstack/react-query';
 import { useNavigate } from '@tanstack/react-router';
 import { useCallback, useMemo, useState } from 'react';
 
-import { CustomerPicker } from '../components/customer-picker';
+import { CustomerFilter } from '../components/customer-filter';
 import { QuotationStatusPill } from '../components/sales-pills';
 import { useIsoDate, useTenantId, useToday } from '../components/stock-parts';
 import { useCan } from '../lib/permissions';
@@ -110,7 +110,7 @@ export function QuotationsPage() {
       />
       <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
         <div className="min-w-0 basis-72">
-          <CustomerPicker
+          <CustomerFilter
             id="quotations-customer"
             aria-label={t('quotations.customer')}
             value={customerId}
```

```diff
@@ -14,7 +14,7 @@ import { useInfiniteQuery } from '@tanstack/react-query';
 import { useNavigate } from '@tanstack/react-router';
 import { useCallback, useMemo, useState } from 'react';
 
-import { CustomerPicker } from '../components/customer-picker';
+import { CustomerFilter } from '../components/customer-filter';
 import { OrderStatusPills } from '../components/sales-pills';
 import { useIsoDate, useTenantId, useToday } from '../components/stock-parts';
 import { useCan } from '../lib/permissions';
@@ -113,7 +113,7 @@ export function SalesOrdersPage() {
       />
       <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
         <div className="min-w-0 basis-72">
-          <CustomerPicker
+          <CustomerFilter
             id="orders-customer"
             aria-label={t('salesOrders.customer')}
             value={customerId}
```

```diff
@@ -20,7 +20,7 @@ import { useInfiniteQuery } from '@tanstack/react-query';
 import { useNavigate } from '@tanstack/react-router';
 import { useCallback, useMemo, useState } from 'react';
 
-import { CustomerPicker } from '../components/customer-picker';
+import { CustomerFilter } from '../components/customer-filter';
 import { DeliveryStatusPill, InvoiceStatePill, ReturnStatePill } from '../components/sales-pills';
 import { useIsoDate, useTenantId, useWarehouses, warehouseLabel } from '../components/stock-parts';
 import { useCan } from '../lib/permissions';
@@ -140,7 +140,7 @@ export function DeliveriesPage() {
       />
       <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
         <div className="min-w-0 basis-72">
-          <CustomerPicker
+          <CustomerFilter
             id="deliveries-customer"
             aria-label={t('deliveries.customer')}
             value={customerId}
```

```diff
@@ -14,7 +14,7 @@ import { useInfiniteQuery } from '@tanstack/react-query';
 import { useNavigate } from '@tanstack/react-router';
 import { useCallback, useMemo, useState } from 'react';
 
-import { CustomerPicker } from '../components/customer-picker';
+import { CustomerFilter } from '../components/customer-filter';
 import { InvoicePills } from '../components/sales-pills';
 import { useIsoDate, useTenantId, useToday } from '../components/stock-parts';
 import { useCan } from '../lib/permissions';
@@ -133,7 +133,7 @@ export function InvoicesPage() {
       />
       <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
         <div className="min-w-0 basis-72">
-          <CustomerPicker
+          <CustomerFilter
             id="invoices-customer"
             aria-label={t('invoices.customer')}
             value={customerId}
```

```diff
@@ -19,7 +19,7 @@ import { useInfiniteQuery } from '@tanstack/react-query';
 import { useNavigate } from '@tanstack/react-router';
 import { useCallback, useMemo, useState } from 'react';
 
-import { CustomerPicker } from '../components/customer-picker';
+import { CustomerFilter } from '../components/customer-filter';
 import { ReceiptStatusPill } from '../components/sales-pills';
 import { useIsoDate, useTenantId } from '../components/stock-parts';
 import { useCan } from '../lib/permissions';
@@ -132,7 +132,7 @@ export function ReceiptsPage() {
       />
       <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
         <div className="min-w-0 basis-72">
-          <CustomerPicker
+          <CustomerFilter
             id="receipts-customer"
             aria-label={t('receipts.customer')}
             value={customerId}
```

```diff
@@ -18,7 +18,7 @@ import { useInfiniteQuery } from '@tanstack/react-query';
 import { useNavigate } from '@tanstack/react-router';
 import { useCallback, useMemo, useState } from 'react';
 
-import { CustomerPicker } from '../components/customer-picker';
+import { CustomerFilter } from '../components/customer-filter';
 import { DocumentStatusPill } from '../components/sales-pills';
 import { useIsoDate, useTenantId, useWarehouses, warehouseLabel } from '../components/stock-parts';
 import { useCan } from '../lib/permissions';
@@ -125,7 +125,7 @@ export function SalesReturnsPage() {
       />
       <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
         <div className="min-w-0 basis-72">
-          <CustomerPicker
+          <CustomerFilter
             id="sales-returns-customer"
             aria-label={t('salesReturns.customer')}
             value={customerId}
```

```diff
@@ -19,7 +19,7 @@ import { useInfiniteQuery } from '@tanstack/react-query';
 import { useNavigate } from '@tanstack/react-router';
 import { useCallback, useMemo, useState } from 'react';
 
-import { CustomerPicker } from '../components/customer-picker';
+import { CustomerFilter } from '../components/customer-filter';
 import { DocumentStatusPill } from '../components/sales-pills';
 import { useIsoDate, useTenantId } from '../components/stock-parts';
 import { useCan } from '../lib/permissions';
@@ -139,7 +139,7 @@ export function CreditNotesPage() {
       />
       <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
         <div className="min-w-0 basis-72">
-          <CustomerPicker
+          <CustomerFilter
             id="credit-notes-customer"
             aria-label={t('creditNotes.customer')}
             value={customerId}
```

```diff
@@ -14,7 +14,7 @@ import { useInfiniteQuery } from '@tanstack/react-query';
 import { useNavigate } from '@tanstack/react-router';
 import { useCallback, useMemo, useState } from 'react';
 
-import { CustomerPicker } from '../components/customer-picker';
+import { CustomerFilter } from '../components/customer-filter';
 import { DocumentStatusPill } from '../components/sales-pills';
 import { useIsoDate, useTenantId } from '../components/stock-parts';
 import { useCan } from '../lib/permissions';
@@ -128,7 +128,7 @@ export function RefundsPage() {
       />
       <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
         <div className="min-w-0 basis-72">
-          <CustomerPicker
+          <CustomerFilter
             id="refunds-customer"
             aria-label={t('refunds.customer')}
             value={customerId}
```

The eight lists change only their import and the component's name.

```diff
@@ -1,4 +1,4 @@
-import { Delete02Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
+import { Calendar03Icon, Delete02Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
 import { zodResolver } from '@hookform/resolvers/zod';
 import {
@@ -22,7 +22,6 @@ import { useLocale } from '@omnivo/i18n';
 import {
   Button,
   Card,
-  DatePicker,
   Dialog,
   FormAlert,
   FormField,
@@ -58,6 +57,10 @@ import {
 
 // Loaded the first time a "Stock in" line shows its cost box (cost-input.tsx says why)
 const MoneyInput = lazy(async () => ({ default: (await import('./cost-input')).MoneyInput }));
+// Step 16: the date picker too (date-input.tsx says why). The form stood at its 100 KB budget, and
+// step 16's Send menu made the bundler share the popover's Radix code in a new way, which took
+// it 0.5 KB over.
+const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));
 
 // The adjustment form: its own chunk (loaded by routes/stock-adjustment.tsx), because the form
 // library, the date picker and the picker are only needed to write — a posted adjustment is read
@@ -272,7 +275,11 @@ export function AdjustmentForm({
         {failure && <FormAlert message={failure} />}
         <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-[13rem_minmax(0,1fr)_minmax(0,1fr)]">
           <FormField control={control} name="date" label={t('adjustments.date')}>
-            {(field) => <DatePicker {...field} />}
+            {(field) => (
+              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
+                <DatePicker {...field} />
+              </Suspense>
+            )}
           </FormField>
           <SelectField
             label={t('adjustments.warehouse')}
@@ -381,15 +388,19 @@ export function AdjustmentForm({
                           label={t(`stockLines.${date}`)}
                           error={fieldState.error?.message}
                         >
-                          <DatePicker
-                            id={dateField.name}
-                            name={dateField.name}
-                            ref={dateField.ref}
-                            value={dateField.value ?? ''}
-                            onChange={dateField.onChange}
-                            onBlur={dateField.onBlur}
-                            invalid={fieldState.error !== undefined}
-                          />
+                          <Suspense
+                            fallback={<Input id={dateField.name} icon={Calendar03Icon} disabled />}
+                          >
+                            <DatePicker
+                              id={dateField.name}
+                              name={dateField.name}
+                              ref={dateField.ref}
+                              value={dateField.value ?? ''}
+                              onChange={dateField.onChange}
+                              onBlur={dateField.onBlur}
+                              invalid={fieldState.error !== undefined}
+                            />
+                          </Suspense>
                         </LineField>
                       )}
                     />
```

The stock adjustment form loads its date picker from `date-input.tsx`, like the receipt and void dialogs. Both date
boxes (the adjustment's date and a batch's dates on a line) show a disabled box with the calendar icon until the
picker arrives. The form goes from 100.5 KB to 88 KB.

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/app exec tsc --noEmit
pnpm --filter @omnivo/app test
pnpm --filter @omnivo/app exec vite build
pnpm --filter @omnivo/app test:bundle-size
pnpm --filter @omnivo/api exec vitest run src/documents/document-output.int.spec.ts
```

Build the i18n package before the app: the app reads its built types, and `setLanguage`'s new option is in them.
The app's own `build` script runs `tsc` first, which still fails on the two MSW customers, so build with `vite build`
until 16.7. The integration test needs Docker (it starts its own Postgres, Valkey and Mailpit).

> **What we checked in this part.** The app type-checks except the two MSW customers (16.7), ESLint and Prettier are
> clean, and its unit tests pass (87, 7 of them new). The bundle check passes: first load 197.3 KB, the Send menu
> 78.1 KB, the history 72.0 KB, the dialogs 75.4 KB, the public page 39.2 KB (38.8 KB after 16.7's fix), the eight lists 74–75 KB. The API
> type-checks and the document output integration test passes (18), including the new `id` in the bell's params.
> Not checked yet: the screens in a browser. 16.7 adds the MSW handlers and the Playwright tests that click through
> them.

---

## 16.7 — `apps/app`: the mock API and the end-to-end tests

`pnpm dev:mock` and the Playwright tests run the app on MSW, the fake API inside the browser (step 4). This part
teaches the mock the eight document output routes and the public page's route, with the API's rules, shortened. It
also fixes the two mock type errors that 16.6 left. Then one new test file clicks through the screens of 16.6 on a
desktop and on a phone: download a quotation in both languages, email it (and see the email bounce and the bell
open the quotation), make a WhatsApp link, copy it and turn it off, change a customer's document language, read an
older quotation's history, download an invoice and check its amount in words, and open the public page in four
states.

This was the first time the 16.6 screens ran in a browser. All of them worked. A look at screenshots in both themes
found two small problems on the public page, both fixed in this part (and in 16.6's file):

- **The footer said "Omnivo" twice.** The `Logo` component already has the word "Omnivo" next to its mark, and the
  footer put "Sent with Omnivo" beside it. The footer is now the quiet line alone. The company is the sender; Omnivo
  only carries the file, so a small line is enough. The page also got 0.4 KB smaller.
- **On a phone, the Bangla heading broke inside the number:** "কোটেশন QT-" on one line and "2026-27-0003" on the
  next. A browser may break a line after a hyphen. The number now has `whitespace-nowrap`, so it moves to the next
  line whole.

Decisions made while building this part (you were not asked):

- **Document output lives in its own file,** `mocks/document-output-data.ts`, and in a new `documentOutput` field of
  the mock workspace, like 15d's `returns`. It imports the quotation, invoice, receipt and credit note files to read
  a document; nothing imports it back except `workspace-data.ts` and `handlers.ts`, so there is no circle for
  `pnpm boundaries` to refuse.
- **The public page answers demo links only.** A share link opens in a new tab, and a new tab starts its own mock
  from the seed, which has never heard of the link the dialog made. So the mock keeps no token, and
  `/public/documents/:token` answers three fixed demo tokens (an English invoice, a Bangla quotation whose PDF is
  still being made, a receipt whose PDF failed). Every other token is "no longer works". The invitation page (step
  8) works the same way.
- **An address with "bounce" in it never arrives,** as for invitations. That gives the tests and `dev:mock` a
  failed email and the bell's notification without a switch of its own.
- **Aarong and Tamanna Pharmacy read their documents in Bangla;** the other customers read English. Aarong has no
  email address, so its email dialog shows the "no email" hint; it has a mobile number, so its WhatsApp link goes
  straight to it.
- **The declined H&M quotation has a history:** one email that arrived, a link that ran its 30 days, and a link
  turned off the next day. The history cards and all their pills have something to show on the first page load.
- **No end-to-end test of the single "Download PDF" button** that someone without the send permission sees. The
  mock always signs in as the owner, who has every permission (as 15b.7–15d.7 said). The API's tests (16.4) check
  the 403 answers.

### `mocks/document-output-data.ts` (new): the shapes

```ts
import {
  amountDueOf,
  type CreatedShare,
  type DocumentEmail,
  type DocumentEmailDraft,
  type DocumentEmailInput,
  type DocumentFile,
  type DocumentShare,
  type LanguageCode,
  type OutputDocument,
  type PublicDocument,
  SHARE_LINK_DAYS,
  todayIn,
  whatsAppUrl,
} from '@omnivo/contracts';
import { formatDate, formatMoney, formatNumber } from '@omnivo/i18n';

import { OWNER } from './fixtures';
import { findInvoice, findReceipt, toInvoice, toReceipt } from './invoice-data';
import { MockProblem } from './mock';
import { findCreditNote, toCreditNote } from './return-data';
import { findCustomer } from './sales-data';
import { findQuotation, toQuotation } from './sales-document-data';
import type { WorkspaceData } from './workspace-data';

// Step 16 on the mock's arrays: the PDFs, the emails and the share links of a quotation, an
// invoice, a money receipt and a credit note, with the API's rules, shortened. There is no worker:
// like an export (report-data.ts), a file or an email "finishes" on the first read after its delay.

// Shorter than the Send menu's 1.5 s wait, so its first poll finds the file ready
const FILE_DELAY_MS = 1_200;
// Shorter than the history's 3 s poll, but long enough that the list shows "Sending" first
const EMAIL_DELAY_MS = 2_500;

export interface MockDocumentFile extends DocumentFile {
  kind: OutputDocument;
  documentId: string;
  // The file's name once it is made: only the number, as in the API, so both languages are
  // "QT-2026-27-0003.pdf"
  name: string;
  // What the PDF shows (the API's fingerprint): when the document changes, so does this, and the
  // next request makes a new file
  look: string;
  readyAt: number;
}

export interface MockDocumentEmail extends DocumentEmail {
  kind: OutputDocument;
  documentId: string;
  number: string;
  sendsAt: number;
}

export interface MockDocumentShare extends DocumentShare {
  kind: OutputDocument;
  documentId: string;
}

export interface MockDocumentOutput {
  files: MockDocumentFile[];
  // Newest first, like the API's lists
  emails: MockDocumentEmail[];
  shares: MockDocumentShare[];
}

export function emptyDocumentOutput(): MockDocumentOutput {
  return { files: [], emails: [], shares: [] };
}
```

- **Two delays, chosen against the page's own timers.** The Send menu asks again every 1.5 seconds (16.6); a file
  that takes 1.2 seconds is ready at the first ask, so a download test does not wait 3 seconds for nothing. The
  emails card asks again every 3 seconds while one is sending; an email that takes 2.5 seconds is still "Sending"
  when the card first reads it, so the test can see it go from "Sending" to "Sent". With the invitations' 1.5
  seconds, a card that read it a little late on a busy machine could find it already sent, and the test could not
  tell whether the card asks again by itself.
- **Each `Mock…` type extends the contract's type** with what the mock needs and the API keeps in its tables: which
  document a row belongs to, the file's future name, its "look", and when the pretend worker finishes.
- **`look` is the mock's fingerprint.** The API makes a new PDF when what it would show changes (decision 18). The
  mock writes down the facts it shows (number, totals, what is still due, the language, the company name) as one
  string; a payment changes "still due", so the next download is a new file.

### The document

```ts
// ---------------------------------------------------------------------------------------------
// The document

// What the PDF, the email and the link need to know about a document
interface Issued {
  number: string;
  date: string;
  customerId: string;
  total: string;
  // The quotation's "valid until" or the invoice's due date, named in the email's first message
  until: string | null;
  dueDate: string | null;
  amountDue: string | null;
  // A credit note's invoice
  invoice: string | null;
}

// The API's 409: only a numbered document goes out (decision 11)
function notIssued(): never {
  throw new MockProblem(409, 'document_not_issued');
}

// Each find…() throws not_found (404) for a document this workspace does not have
function issuedOf(data: WorkspaceData, kind: OutputDocument, id: string): Issued {
  switch (kind) {
    case 'quotation': {
      const doc = toQuotation(data, findQuotation(data, id));
      return {
        number: doc.number,
        date: doc.date,
        customerId: doc.customer.id,
        total: doc.total,
        until: doc.validUntil,
        dueDate: null,
        amountDue: null,
        invoice: null,
      };
    }
    case 'invoice': {
      const doc = toInvoice(data, findInvoice(data, id));
      if (doc.number === null) return notIssued();
      return {
        number: doc.number,
        date: doc.date,
        customerId: doc.customer.id,
        total: doc.total,
        until: doc.dueDate,
        dueDate: doc.dueDate,
        amountDue: amountDueOf(doc),
        invoice: null,
      };
    }
    case 'receipt': {
      const doc = toReceipt(data, findReceipt(data, id));
      if (doc.status === 'voided') return notIssued();
      return {
        number: doc.number,
        date: doc.date,
        customerId: doc.customer.id,
        total: doc.amount,
        until: null,
        dueDate: null,
        amountDue: null,
        invoice: null,
      };
    }
    case 'credit_note': {
      const doc = toCreditNote(data, findCreditNote(data, id));
      if (doc.number === null) return notIssued();
      return {
        number: doc.number,
        date: doc.date,
        customerId: doc.customer.id,
        total: doc.total,
        until: null,
        dueDate: null,
        amountDue: null,
        invoice: doc.invoice.number,
      };
    }
  }
}
```

- **`issuedOf()` reads the document through the mock's own `to…()` functions,** the ones the document pages read.
  So an invoice's "still due" is worked out the same way here and on the page (`amountDueOf()` from the contracts).
- **Only a numbered document goes out** (decision 11): a draft invoice or credit note, and a voided receipt, get the
  API's 409 `document_not_issued`. A quotation is numbered when it is saved, so it always goes out.
- **A document that does not exist** gets `not_found` from the `find…()` functions, as from the API.
- **`notIssued()` returns `never`.** After `if (doc.number === null) return notIssued();` TypeScript knows that
  `doc.number` is a `string`, so `Issued.number` needs no cast.

### The customer's words

```ts
// ---------------------------------------------------------------------------------------------
// The customer's words: the API's copy.ts, only the sentences the screens show

const TITLES = {
  en: {
    quotation: 'Quotation',
    invoice: 'Invoice',
    receipt: 'Money receipt',
    credit_note: 'Credit note',
  },
  bn: {
    quotation: 'কোটেশন',
    invoice: 'ইনভয়েস',
    receipt: 'মানি রিসিট',
    credit_note: 'ক্রেডিট নোট',
  },
} satisfies Record<LanguageCode, Record<OutputDocument, string>>;

function money(amount: string, language: LanguageCode): string {
  return formatMoney(amount, language, { decimals: 2 });
}

// A date part, read in local time like the app's date picker: "2026-09-23" is the 23rd everywhere
function day(iso: string, language: LanguageCode): string {
  return formatDate(new Date(`${iso}T00:00:00`), language);
}

function emailSubject(kind: OutputDocument, doc: Issued, company: string, language: LanguageCode) {
  const title = TITLES[language][kind];
  return language === 'bn'
    ? `${company} থেকে ${title} ${doc.number}`
    : `${title} ${doc.number} from ${company}`;
}

function emailMessage(
  kind: OutputDocument,
  doc: Issued,
  customer: string,
  company: string,
  language: LanguageCode,
): string {
  const amount = money(doc.total, language);
  const until = doc.until === null ? '' : day(doc.until, language);
  if (language === 'bn') {
    const lead = {
      quotation: `আমাদের কোটেশন ${doc.number} (${amount}) সংযুক্ত করা হলো।`,
      invoice: `ইনভয়েস ${doc.number} (${amount}) সংযুক্ত করা হলো। পরিশোধের তারিখ ${until}।`,
      receipt: `আপনার পেমেন্টের জন্য ধন্যবাদ। মানি রিসিট ${doc.number} (${amount}) সংযুক্ত করা হলো।`,
      credit_note: `ইনভয়েস ${doc.invoice ?? ''}-এর বিপরীতে ক্রেডিট নোট ${doc.number} (${amount}) সংযুক্ত করা হলো।`,
    } satisfies Record<OutputDocument, string>;
    return `প্রিয় ${customer},\n\n${lead[kind]}\n\nধন্যবাদান্তে,\n${OWNER.fullName}\n${company}`;
  }
  const lead = {
    quotation: `Please find attached our quotation ${doc.number} for ${amount}.`,
    invoice: `Please find attached invoice ${doc.number} for ${amount}, due on ${until}.`,
    receipt: `Thank you for your payment. Please find attached money receipt ${doc.number} for ${amount}.`,
    credit_note: `Please find attached credit note ${doc.number} for ${amount}, against invoice ${doc.invoice ?? ''}.`,
  } satisfies Record<OutputDocument, string>;
  return `Dear ${customer},\n\n${lead[kind]}\n\nRegards,\n${OWNER.fullName}\n${company}`;
}

function shareMessage(
  kind: OutputDocument,
  doc: Issued,
  company: string,
  url: string,
  language: LanguageCode,
): string {
  const title = TITLES[language][kind];
  const amount = money(doc.total, language);
  return language === 'bn'
    ? `${company}: ${title} ${doc.number}, ${amount}।\nPDF দেখুন বা নামান: ${url}\nলিংকটা ${formatNumber(SHARE_LINK_DAYS, 'bn')} দিন কাজ করবে।`
    : `${company}: ${title} ${doc.number} for ${amount}.\nOpen or download the PDF: ${url}\nThe link works for ${String(SHARE_LINK_DAYS)} days.`;
}
```

- **The same sentences as the API's `copy.ts`,** but only the ones a screen shows: the email's subject and first
  message, and the WhatsApp message. The PDF's words are not needed: the mock's "PDF" is a line of text.
- **Money and dates use `@omnivo/i18n`'s own formatters,** so Bangla gets Bangla digits ("৳৭২,৪২৭.৫০"), as the API
  writes them.
- **A date is read in local time** (`T00:00:00` without a `Z`). "2026-09-23" must stay the 23rd in Dhaka; read as
  UTC, it could show as the 22nd in a time zone behind UTC.
- **`satisfies Record<…>`** on the title and sentence maps: a fifth document kind, or a language without its
  sentence, fails the type check.

### The PDF

```ts
// ---------------------------------------------------------------------------------------------
// The PDF

// The mock has no storage: the "PDF" is a line of text in a blob URL, like an export's file
function downloadOf(file: MockDocumentFile): DocumentFile['download'] {
  if (file.status !== 'ready') return null;
  const text = `Omnivo mock PDF: ${file.fileName ?? ''} (${file.language})\n`;
  return {
    url: URL.createObjectURL(new Blob([text], { type: 'text/plain' })),
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

// The contract's shape: everything but the mock's own fields. A ready file gets a fresh link on
// every read, like the API's signed link.
export function toDocumentFile(file: MockDocumentFile): DocumentFile {
  return {
    id: file.id,
    language: file.language,
    status: file.status,
    fileName: file.fileName,
    sizeBytes: file.sizeBytes,
    download: downloadOf(file),
    createdAt: file.createdAt,
    finishedAt: file.finishedAt,
  };
}

// POST /documents/:kind/:id/files: the file already made for this look, else a new pending one.
// Two clicks while the first is pending share one file (the API's unique look).
export function requestFile(
  data: WorkspaceData,
  kind: OutputDocument,
  id: string,
  language: LanguageCode,
): MockDocumentFile {
  const doc = issuedOf(data, kind, id);
  const look = JSON.stringify({ doc, language, company: data.settings.companyName });
  const made = data.documentOutput.files.find(
    (file) => file.kind === kind && file.documentId === id && file.look === look,
  );
  if (made) return made;
  const file: MockDocumentFile = {
    id: crypto.randomUUID(),
    kind,
    documentId: id,
    language,
    status: 'pending',
    fileName: null,
    sizeBytes: null,
    download: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    name: `${doc.number}.pdf`,
    look,
    readyAt: Date.now() + FILE_DELAY_MS,
  };
  data.documentOutput.files.push(file);
  return file;
}

// GET /documents/:kind/:id/files/:fileId: a file of another document is not found, like the API
export function findFile(
  data: WorkspaceData,
  kind: OutputDocument,
  id: string,
  fileId: string,
): MockDocumentFile {
  const file = data.documentOutput.files.find(
    (item) => item.id === fileId && item.kind === kind && item.documentId === id,
  );
  if (!file) throw new MockProblem(404, 'not_found');
  return file;
}
```

- **The "PDF" is a line of text in a blob URL,** like a step 11 export. It names its file and language, so a test
  can read the download and check that the Bangla item gave a Bangla file.
- **A fresh link on every read,** like the API's signed link. A ready file's `download` is built in
  `toDocumentFile()`, not stored.
- **`requestFile()` returns the file already made for the same look.** Two clicks while the first file is pending
  share one row, like the API's unique index. A changed document has a new look and gets a new file.
- **`findFile()` checks the kind and the document too:** asking for a file through another document's path is not
  found, as in the API (16.3).

### Email

```ts
// ---------------------------------------------------------------------------------------------
// Email

export function emailDraft(
  data: WorkspaceData,
  kind: OutputDocument,
  id: string,
  language: LanguageCode,
): DocumentEmailDraft {
  const doc = issuedOf(data, kind, id);
  const customer = findCustomer(data.sales, doc.customerId);
  const company = data.settings.companyName;
  return {
    to: customer.email ?? '',
    subject: emailSubject(kind, doc, company, language),
    message: emailMessage(kind, doc, customer.name, company, language),
  };
}

export function toDocumentEmail(email: MockDocumentEmail): DocumentEmail {
  return {
    id: email.id,
    to: email.to,
    cc: email.cc,
    subject: email.subject,
    language: email.language,
    status: email.status,
    sentBy: email.sentBy,
    createdAt: email.createdAt,
    sentAt: email.sentAt,
  };
}

// Queued, not sent: the pretend worker sends it a moment later (settleDocumentOutput)
export function sendEmail(
  data: WorkspaceData,
  kind: OutputDocument,
  id: string,
  input: DocumentEmailInput,
): MockDocumentEmail {
  const doc = issuedOf(data, kind, id);
  const email: MockDocumentEmail = {
    id: crypto.randomUUID(),
    kind,
    documentId: id,
    number: doc.number,
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    language: input.language,
    status: 'pending',
    sentBy: { id: OWNER.id, name: OWNER.fullName },
    createdAt: new Date().toISOString(),
    sentAt: null,
    sendsAt: Date.now() + EMAIL_DELAY_MS,
  };
  data.documentOutput.emails.unshift(email);
  return email;
}
```

- **`emailDraft()` fills To with the customer's address, or leaves it empty.** The dialog then shows its "no email"
  hint (16.6).
- **`sendEmail()` only queues the email:** status `pending`, with the time the pretend worker sends it. The handler
  answers at once, as the API does (the worker sends it later).
- **The body arrives already parsed** by the contract's schema in the handler (`readBody`), so `input.to` is the
  cleaned list (lower case, no duplicates), as in the API.

### Share links

```ts
// ---------------------------------------------------------------------------------------------
// Share links

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

export function toDocumentShare(share: MockDocumentShare): DocumentShare {
  return {
    id: share.id,
    language: share.language,
    createdBy: share.createdBy,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    revokedAt: share.revokedAt,
    firstOpenedAt: share.firstOpenedAt,
    lastOpenedAt: share.lastOpenedAt,
  };
}

// The link is in this answer only (decision 13). The mock keeps no token: a link opens in a new
// tab, and a new tab starts its own mock from the seed, which has never heard of it. The public
// page answers the demo links below instead, like the invitation page's demo tokens.
export function createShare(
  data: WorkspaceData,
  kind: OutputDocument,
  id: string,
  language: LanguageCode,
): CreatedShare {
  const doc = issuedOf(data, kind, id);
  const customer = findCustomer(data.sales, doc.customerId);
  const now = Date.now();
  const share: MockDocumentShare = {
    id: crypto.randomUUID(),
    kind,
    documentId: id,
    language,
    createdBy: { id: OWNER.id, name: OWNER.fullName },
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SHARE_LINK_DAYS * 86_400_000).toISOString(),
    revokedAt: null,
    firstOpenedAt: null,
    lastOpenedAt: null,
  };
  data.documentOutput.shares.unshift(share);
  // Like the API, the link starts the PDF, so the customer seldom waits for it
  requestFile(data, kind, id, language);
  const url = `${window.location.origin}/d/${newToken()}`;
  console.info(`[mock] share link: ${url} (open a demo link instead: see DEMO_SHARE_TOKENS)`);
  const message = shareMessage(kind, doc, data.settings.companyName, url, language);
  return {
    share: toDocumentShare(share),
    url,
    message,
    whatsAppUrl: whatsAppUrl(customer.phone, message),
  };
}

// Turning off an off link changes nothing and is not an error; a link of another document is
// not found (the API's revokeShare)
export function revokeShare(
  data: WorkspaceData,
  kind: OutputDocument,
  id: string,
  shareId: string,
): void {
  const share = data.documentOutput.shares.find(
    (item) => item.id === shareId && item.kind === kind && item.documentId === id,
  );
  if (!share) throw new MockProblem(404, 'not_found');
  share.revokedAt ??= new Date().toISOString();
}
```

- **`newToken()` makes a token of the real shape:** 16 random bytes in base64url, 22 characters. The dialog's link
  then looks like a real one, and the test can check its shape.
- **No token is stored** (the decision above). The link is logged to the console, with a note that points to the
  demo links, like the invitation link the mock logs.
- **Making a link also asks for its PDF** (decision 25), so the mock's file list matches the API's.
- **`whatsAppUrl()` is the contract's,** so the mock builds the WhatsApp link from the customer's phone exactly as
  the API does: a mobile number goes into the link, anything else leaves WhatsApp to ask.
- **Turning off an off link changes nothing** (`??=` keeps the first time), and a link of another document is not
  found, like the API's `revokeShare`.

### The seed

```ts
// ---------------------------------------------------------------------------------------------
// The seed

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

const DAY_MINUTES = 24 * 60;

// The declined H&M quotation went out a month ago: an email that arrived, a link the buyer opened
// until it ended, and a second link turned off the next day. The history cards and their pills
// have something to show from the first page load. Nothing is seeded for the pharmacy.
export function seedDocumentOutput(data: WorkspaceData, garments: boolean): void {
  if (!garments) return;
  const hm = data.sales.customers.find((item) => item.name === 'H&M Hennes & Mauritz GBC AB');
  const quotation = data.salesDocuments.quotations.find(
    (item) => item.customer.id === hm?.id && item.status === 'declined',
  );
  if (!hm || !quotation) return;
  const sentBy = { id: OWNER.id, name: OWNER.fullName };
  const ofQuotation = { kind: 'quotation', documentId: quotation.id } as const;
  // A minute past 30 days: the link has just ended, on the quotation's own date
  const month = 30 * DAY_MINUTES + 1;
  data.documentOutput.emails = [
    {
      ...ofQuotation,
      id: crypto.randomUUID(),
      number: quotation.number,
      to: [hm.email ?? 'sourcing.dhaka@hm.com'],
      cc: ['merchandising@rahmangarments.com'],
      subject: `Quotation ${quotation.number} from ${data.settings.companyName}`,
      language: 'en',
      status: 'sent',
      sentBy,
      createdAt: ago(month - 5),
      sentAt: ago(month - 6),
      sendsAt: 0,
    },
  ];
  data.documentOutput.shares = [
    {
      ...ofQuotation,
      id: crypto.randomUUID(),
      language: 'en',
      createdBy: sentBy,
      createdAt: ago(29 * DAY_MINUTES),
      expiresAt: ago(29 * DAY_MINUTES - SHARE_LINK_DAYS * DAY_MINUTES),
      revokedAt: ago(28 * DAY_MINUTES),
      firstOpenedAt: null,
      lastOpenedAt: null,
    },
    {
      ...ofQuotation,
      id: crypto.randomUUID(),
      language: 'en',
      createdBy: sentBy,
      createdAt: ago(month),
      expiresAt: ago(month - SHARE_LINK_DAYS * DAY_MINUTES),
      revokedAt: null,
      firstOpenedAt: ago(month - 90),
      lastOpenedAt: ago(26 * DAY_MINUTES),
    },
  ];
}
```

- **On the declined H&M quotation,** because it is the oldest (dated 30 days ago): its history can be a month old
  without being older than the quotation itself.
- **The ended link was made 30 days and one minute ago.** It ended a minute ago, on the quotation's own date. A
  link made exactly 30 days ago would end during the test run and make the pill depend on the clock.
- **Times are worked out from now (`ago()`),** not fixed dates, so the history looks the same any day the mock runs.
- **Nothing for the pharmacy,** so its quotations show the empty cards ("Not emailed yet.").

### The pretend worker

```ts
// ---------------------------------------------------------------------------------------------
// The pretend worker

// Called on every read, like settleExports: what the worker would have done by now. An address
// with "bounce" in it never arrives (as for invitations): the email fails and the bell says so.
export function settleDocumentOutput(data: WorkspaceData): void {
  const now = Date.now();
  for (const file of data.documentOutput.files) {
    if (file.status !== 'pending' || now < file.readyAt) continue;
    Object.assign(file, {
      status: 'ready',
      fileName: file.name,
      sizeBytes: 48_213,
      finishedAt: new Date(now).toISOString(),
    });
  }
  for (const email of data.documentOutput.emails) {
    if (email.status !== 'pending' || now < email.sendsAt) continue;
    if ([...email.to, ...email.cc].some((address) => address.includes('bounce'))) {
      email.status = 'failed';
      data.notifications.unshift({
        id: crypto.randomUUID(),
        type: 'document.email_failed',
        params: { document: email.kind, id: email.documentId, number: email.number },
        readAt: null,
        createdAt: new Date(now).toISOString(),
      });
    } else {
      Object.assign(email, { status: 'sent', sentAt: new Date(now).toISOString() });
    }
  }
}
```

- **Called on every read**, like `settleExports()`: anything whose time has come is finished before the answer.
- **A bounce writes the bell's notification** with `{ document, id, number }`, the params the API sends since 16.6, so
  the bell can open the quotation.
- **A sent email gets `sentAt`;** a failed one does not (sent ⇔ `sentAt`, as in the API's table).

### The public page's demo links

```ts
// ---------------------------------------------------------------------------------------------
// The public page's demo links

// A page opened at /d/<token> starts a fresh mock (a new tab, or Playwright's goto), so these
// links always answer. 22 characters, the shape of a real token.
export const DEMO_SHARE_TOKENS = {
  // An invoice in English, its PDF already made
  invoice: 'demo-invoice-link-0042',
  // A quotation in Bangla, its PDF still being made the first time the page asks
  bangla: 'demo-bangla-quote-0003',
  // A receipt whose PDF the worker could not make
  failed: 'demo-failed-receipt-07',
} as const;
// Any other token is not found: an unknown, an ended and a turned-off link get the same answer
// (decision 14)

// When each demo link was first opened in this tab: the pending PDF is ready a moment later
const demoOpened = new Map<string, number>();

// A pending one is ready 1.5 seconds after the first answer: the page's first poll (2 s) finds it
function demoFile(
  token: string,
  number: string,
  language: LanguageCode,
  status: DocumentFile['status'],
): DocumentFile {
  const opened = demoOpened.get(token) ?? Date.now();
  demoOpened.set(token, opened);
  const file: MockDocumentFile = {
    id: crypto.randomUUID(),
    kind: 'invoice',
    documentId: crypto.randomUUID(),
    name: `${number}.pdf`,
    language,
    status: status === 'pending' && Date.now() >= opened + 1_500 ? 'ready' : status,
    fileName: null,
    sizeBytes: null,
    download: null,
    createdAt: new Date(opened).toISOString(),
    finishedAt: null,
    look: token,
    readyAt: opened,
  };
  if (file.status === 'ready') {
    Object.assign(file, { fileName: file.name, sizeBytes: 48_213, finishedAt: file.createdAt });
  }
  return toDocumentFile(file);
}

function daysAfter(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// GET /public/documents/:token. The company is the workspace's; the rest is a fixed example.
export function publicDocument(data: WorkspaceData, token: string): PublicDocument {
  const today = todayIn(data.settings.timezone);
  const company = data.settings.companyName;
  switch (token) {
    case DEMO_SHARE_TOKENS.invoice:
      return {
        company,
        logoUrl: data.settings.logo?.url ?? null,
        kind: 'invoice',
        number: 'INV-2026-27-0042',
        date: today,
        customer: 'Aarong',
        total: '115000.0000',
        currency: data.settings.baseCurrency,
        dueDate: daysAfter(today, 30),
        amountDue: '40000.0000',
        language: 'en',
        file: demoFile(token, 'INV-2026-27-0042', 'en', 'ready'),
      };
    case DEMO_SHARE_TOKENS.bangla:
      return {
        company,
        logoUrl: null,
        kind: 'quotation',
        number: 'QT-2026-27-0003',
        date: today,
        customer: 'Aarong',
        total: '72427.5000',
        currency: data.settings.baseCurrency,
        dueDate: null,
        amountDue: null,
        language: 'bn',
        file: demoFile(token, 'QT-2026-27-0003', 'bn', 'pending'),
      };
    case DEMO_SHARE_TOKENS.failed:
      return {
        company,
        logoUrl: null,
        kind: 'receipt',
        number: 'MR-2026-27-0007',
        date: today,
        customer: 'Bengal Buying House Ltd.',
        total: '25000.0000',
        currency: data.settings.baseCurrency,
        dueDate: null,
        amountDue: null,
        language: 'en',
        file: demoFile(token, 'MR-2026-27-0007', 'en', 'failed'),
      };
    default:
      throw new MockProblem(404, 'share_link_not_found');
  }
}
```

- **Three tokens, each 22 characters,** so they pass the page's shape check and reach the mock. Any other token,
  including a well-shaped one, is `share_link_not_found`: an unknown, an ended and a turned-off link look the same
  (decision 14).
- **The pending demo PDF is ready 1.5 seconds after the first answer.** The page asks again every 2 seconds, so its
  first ask finds it ready, and the test does not wait near Playwright's 5-second limit.
- **The first answer's time is kept per token in the tab** (`demoOpened`), so each ask sees the same file grow up.
- **The company is the workspace's** (Settings), the rest a fixed example: the page shows how the sender's own name
  appears.
- **The invoice is due 30 days after today,** so it is not overdue whenever the mock runs.

### `mocks/workspace-data.ts`, `mocks/sales-data.ts`

```diff
@@ -28,6 +28,11 @@ import {
   seedSalesAccounts,
   seedStockAccounts,
 } from './accounting-data';
+import {
+  emptyDocumentOutput,
+  type MockDocumentOutput,
+  seedDocumentOutput,
+} from './document-output-data';
 import { OWNER, type Workspace } from './fixtures';
 import { emptyBilling, type MockBilling } from './invoice-data';
 import { emptyJournal, type MockJournal, seedJournal } from './journal-data';
@@ -76,6 +81,8 @@ export interface WorkspaceData {
   returns: MockReturns;
   // The account credit notes take sales back from (step 15d, Settings → Sales)
   salesAccounts: SalesAccounts;
+  // The PDFs, emails and share links of the documents a customer receives (step 16)
+  documentOutput: MockDocumentOutput;
 }
 
 function now(): string {
@@ -139,6 +146,7 @@ function seed(workspace: Workspace): WorkspaceData {
     billing: emptyBilling(),
     returns: emptyReturns(),
     salesAccounts: { returns: null },
+    documentOutput: emptyDocumentOutput(),
   };
   data.stockAccounts = seedStockAccounts(data.accounts, garments ? 'garments' : 'pharma');
   data.salesAccounts = seedSalesAccounts(data.accounts);
@@ -148,6 +156,8 @@ function seed(workspace: Workspace): WorkspaceData {
   seedStock(data, garments);
   // After the stock: an order is sent from a warehouse
   seedSalesDocuments(data, garments);
+  // After the quotations: the history belongs to one of them
+  seedDocumentOutput(data, garments);
   record(data, 'workspace.created', 'workspace', workspace.tenantId, {
     name: { from: null, to: workspace.name },
   });
```

The new `documentOutput` field, empty for a new workspace, seeded after the quotations (the history belongs to one
of them). `transaction()` does not copy it: nothing that can be refused writes to it.

```diff
@@ -8,6 +8,7 @@ import {
   defaultNumberFormat,
   type ErrorCode,
   formatDocumentNumber,
+  type LanguageCode,
   type PartyRef,
   periodOf,
   type PriceList,
@@ -125,6 +126,8 @@ interface CustomerParts {
   billing?: string;
   shipping?: [label: string, address: string][];
   archived?: boolean;
+  // English unless the customer reads its documents in Bangla (step 16)
+  documentLanguage?: LanguageCode;
 }
 
 function customer(sales: MockSales, parts: CustomerParts): MockCustomer {
@@ -141,6 +144,7 @@ function customer(sales: MockSales, parts: CustomerParts): MockCustomer {
     paymentTermsDays: parts.paymentTermsDays,
     creditLimit: parts.creditLimit === null ? null : money(parts.creditLimit),
     priceListId: parts.priceList?.id ?? null,
+    documentLanguage: parts.documentLanguage ?? 'en',
     notes: null,
     addresses: [
       ...(parts.billing === undefined
@@ -238,6 +242,7 @@ export function seedSales(data: WorkspaceData, garments: boolean): void {
         name: 'Aarong',
         group: local,
         contactPerson: 'Mahmudul Hasan',
+        documentLanguage: 'bn',
         phone: '+880 1713-045678',
         bin: '0003456780202',
         paymentTermsDays: 30,
@@ -304,6 +309,7 @@ export function seedSales(data: WorkspaceData, garments: boolean): void {
     customer(sales, {
       name: 'Tamanna Pharmacy',
       group: pharmacies,
+      documentLanguage: 'bn',
       phone: '+880 1913-778899',
       paymentTermsDays: 0,
       creditLimit: '0',
@@ -570,6 +576,7 @@ export function saveCustomer(
     paymentTermsDays: input.paymentTermsDays,
     creditLimit: input.creditLimit === null ? null : money(input.creditLimit),
     priceListId: input.priceListId,
+    documentLanguage: input.documentLanguage,
     notes: input.notes,
     addresses: [
       ...addresses.filter((address) => address.kind === 'billing'),
```

- **`documentLanguage` is optional in `CustomerParts`, English by default,** so only the two Bangla customers say it.
- **A saved customer keeps what the form sent** (`input.documentLanguage`). These two lines are the type errors 16.6
  left.

### `mocks/handlers.ts`: the routes

```diff
@@ -31,6 +31,19 @@ import {
   toReceipt,
   voidReceipt,
 } from './invoice-data';
+import {
+  createShare,
+  emailDraft,
+  findFile,
+  publicDocument,
+  requestFile,
+  revokeShare,
+  sendEmail,
+  settleDocumentOutput,
+  toDocumentEmail,
+  toDocumentFile,
+  toDocumentShare,
+} from './document-output-data';
 import { mock, MockProblem, problem, readBody, readQuery, reply } from './mock';
 import {
   allocateCreditNote,
@@ -211,6 +224,7 @@ function current() {
   const data = dataOf(workspace);
   settleSetup(data);
   settleExports(data);
+  settleDocumentOutput(data);
   settleImports(data.catalog, (type, params) => {
     data.notifications.unshift({
       id: crypto.randomUUID(),
@@ -3219,4 +3233,103 @@ export const handlers = [
       return reply(routes.salesAccounts.update, data.salesAccounts);
     }),
   ),
+  // --- Step 16: PDFs, emails and share links (document-output-data.ts) ---------------------------
+  // The API asks for the send permission on the four routes that send; the mock signs in as the
+  // owner, who has it, so it checks nothing.
+
+  mock(
+    routes.documentOutput.file,
+    guarded(async ({ request, params }) => {
+      const { kind, id } = routes.documentOutput.file.params.parse(params);
+      const { language } = await readBody(routes.documentOutput.file.body, request);
+      return reply(
+        routes.documentOutput.file,
+        toDocumentFile(requestFile(current(), kind, id, language)),
+      );
+    }),
+  ),
+
+  mock(
+    routes.documentOutput.getFile,
+    guarded(({ params }) => {
+      const { kind, id, fileId } = routes.documentOutput.getFile.params.parse(params);
+      return reply(
+        routes.documentOutput.getFile,
+        toDocumentFile(findFile(current(), kind, id, fileId)),
+      );
+    }),
+  ),
+
+  mock(
+    routes.documentOutput.emailDraft,
+    guarded(({ request, params }) => {
+      const { kind, id } = routes.documentOutput.emailDraft.params.parse(params);
+      const { language } = readQuery(routes.documentOutput.emailDraft.query, request);
+      return reply(routes.documentOutput.emailDraft, emailDraft(current(), kind, id, language));
+    }),
+  ),
+
+  mock(
+    routes.documentOutput.emails,
+    guarded(({ params }) => {
+      const { kind, id } = routes.documentOutput.emails.params.parse(params);
+      const items = current().documentOutput.emails.filter(
+        (email) => email.kind === kind && email.documentId === id,
+      );
+      return reply(routes.documentOutput.emails, { items: items.map(toDocumentEmail) });
+    }),
+  ),
+
+  mock(
+    routes.documentOutput.sendEmail,
+    guarded(async ({ request, params }) => {
+      const { kind, id } = routes.documentOutput.sendEmail.params.parse(params);
+      const body = await readBody(routes.documentOutput.sendEmail.body, request);
+      return reply(
+        routes.documentOutput.sendEmail,
+        toDocumentEmail(sendEmail(current(), kind, id, body)),
+      );
+    }),
+  ),
+
+  mock(
+    routes.documentOutput.shares,
+    guarded(({ params }) => {
+      const { kind, id } = routes.documentOutput.shares.params.parse(params);
+      const items = current().documentOutput.shares.filter(
+        (share) => share.kind === kind && share.documentId === id,
+      );
+      return reply(routes.documentOutput.shares, { items: items.map(toDocumentShare) });
+    }),
+  ),
+
+  mock(
+    routes.documentOutput.createShare,
+    guarded(async ({ request, params }) => {
+      const { kind, id } = routes.documentOutput.createShare.params.parse(params);
+      const { language } = await readBody(routes.documentOutput.createShare.body, request);
+      return reply(routes.documentOutput.createShare, createShare(current(), kind, id, language));
+    }),
+  ),
+
+  mock(
+    routes.documentOutput.revokeShare,
+    guarded(({ params }) => {
+      const { kind, id, shareId } = routes.documentOutput.revokeShare.params.parse(params);
+      revokeShare(current(), kind, id, shareId);
+      return reply(routes.documentOutput.revokeShare, undefined);
+    }),
+  ),
+
+  // No login: the customer opens the link. The mock answers its demo links in the first
+  // workspace (document-output-data.ts says why it cannot answer a link made in the dialog).
+  mock(
+    routes.publicDocuments.get,
+    guarded(async ({ params }) => {
+      const { token } = routes.publicDocuments.get.params.parse(params);
+      const shared = publicDocument(dataOf(WORKSPACES[0]), token);
+      await delay();
+      return reply(routes.publicDocuments.get, shared);
+    }),
+  ),
 ];
```

- **No permission check.** The API checks the send permission in the service (decision 9); the mock always signs in
  as the owner, who has it.
- **`settleDocumentOutput()` joins the other settle calls** in `current()`, so every answer sees what the pretend
  worker has done by now.
- **The public route reads the first workspace** with `dataOf()`, not `current()`: it must not depend on who is
  signed in. It also waits a moment (`delay()`), as the invitation preview does, so the page's empty first moment is
  visible in `dev:mock`.
- **`reply(…revokeShare, undefined)`** answers 204 with no body; `reply()` still checks the value against the route's
  `z.void()`.

### `routes/public-document.tsx`: two fixes from the screenshots

The file is shown whole in 16.6, already fixed. The changes: the footer is the "Sent with Omnivo" line without the
`Logo` (and the `Logo` import is gone), and the number in the heading has `whitespace-nowrap`. The comment `{/* … */}`
between the name and the number keeps the space in front of it: JSX keeps spaces inside one line and drops them only
at line breaks.

### `e2e/document-output.e2e.ts` (new)

```ts
import { readFile } from 'node:fs/promises';

import { type Download, expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav, toastShown } from './helpers.js';

// Step 16 in the mock garments workspace. Aarong reads its documents in Bangla, has no email
// address and a mobile number; its open quotation is QT-…-0003. H&M reads English; its declined
// quotation QT-…-0001 went out a month ago (an email, a link that has ended and one turned off).
// The mock's pretend worker makes a PDF in 1.2 seconds and sends an email in 2.5; an address with
// "bounce" in it never arrives. The mock's "PDF" is a line of text that names its language.

const QT_3 = /QT-\d{4}-\d{2}-0003/;

async function openQuotation(page: Page, number: RegExp) {
  await openFromNav(page, 'Quotations');
  await listItem(page, number).click();
  await expect(page.getByRole('heading', { level: 1, name: number })).toBeVisible();
}

// The Send menu's button, then one of its items
async function send(page: Page, item: string) {
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

// A row of the history cards. In the page's main region: a toast is a list item too, and the
// email toast names the same address.
function historyRow(page: Page, text: string) {
  return page.getByRole('main').getByRole('listitem').filter({ hasText: text });
}

// The mock's file says which language it was made in
async function languageOf(download: Download): Promise<string> {
  return readFile(await download.path(), 'utf8');
}
```

- **`send()`** clicks the menu's button and an item. `exact: true` matters: "Download PDF" is also the start of
  "Download PDF in English".
- **`historyRow()` looks inside `main`.** A toast is a list item too, and the email toast ("Sending to
  accounts@aarong.com") names the same address as the history row. Without `main`, the locator found two elements
  and Playwright's strict mode stopped the test.
- **`languageOf()` reads the downloaded file.** Playwright saves a download to a temporary file; the mock's file
  names its language, so the test sees which language was asked for, not only the file name (both languages have the
  same name).

```ts
test.describe('in the app', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test("downloads a quotation's PDF in the customer's language, and in the other", async ({
    page,
  }) => {
    await openQuotation(page, QT_3);
    // Aarong reads Bangla: the first item is its language, the second names the other one
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Download PDF in English' })).toBeVisible();
    const bangla = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'Download PDF', exact: true }).click();
    // While the worker draws it, the button says so and takes no second click
    await expect(page.getByRole('button', { name: 'Making the PDF…' })).toBeDisabled();
    expect((await bangla).suggestedFilename()).toMatch(/^QT-\d{4}-\d{2}-0003\.pdf$/);
    expect(await languageOf(await bangla)).toContain('(bn)');

    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    const english = page.waitForEvent('download');
    await send(page, 'Download PDF in English');
    expect((await english).suggestedFilename()).toMatch(/^QT-\d{4}-\d{2}-0003\.pdf$/);
    expect(await languageOf(await english)).toContain('(en)');
    await expectNoSideScroll(page);
  });

  test("emails a quotation in the customer's language, or in another, and the history shows it go", async ({
    page,
  }) => {
    await openQuotation(page, QT_3);
    await send(page, 'Email');
    const dialog = page.getByRole('dialog', { name: /Email QT-\d{4}-\d{2}-0003/ });
    // The server's draft, in Aarong's Bangla; no address to send it to yet
    await expect(dialog.getByLabel('Language')).toHaveValue('bn');
    await expect(dialog.getByLabel('Subject')).toHaveValue(
      /^Rahman Garments Ltd\. থেকে কোটেশন QT-\d{4}-\d{2}-0003$/,
    );
    await expect(dialog.getByLabel('To', { exact: true })).toHaveValue('');
    await expect(
      dialog.getByText('This customer has no email address.', { exact: false }),
    ).toBeVisible();
    // The mock company has no email in Settings, so replies have nowhere to go
    await expect(
      dialog.getByText('Add your company’s email in Settings', { exact: false }),
    ).toBeVisible();
    await expect(dialog.getByText(/^Attached: QT-\d{4}-\d{2}-0003\.pdf$/)).toBeVisible();
    await expectNoSideScroll(page);

    // The form checks the boxes before anything goes out
    await dialog.getByRole('button', { name: 'Send email' }).click();
    await expect(dialog.getByText('Type at least one address to send it to.')).toBeVisible();
    await dialog.getByLabel('To', { exact: true }).fill('accounts@aarong.com');
    await dialog.getByLabel('CC (optional)').fill('mahmudul@aarong.com, not-an-address');
    await dialog.getByRole('button', { name: 'Send email' }).click();
    await expect(dialog.getByText('Enter an email like name@company.com.')).toBeVisible();
    await dialog
      .getByLabel('CC (optional)')
      .fill('a@aarong.com b@aarong.com c@aarong.com d@aarong.com e@aarong.com f@aarong.com');
    await dialog.getByRole('button', { name: 'Send email' }).click();
    await expect(dialog.getByText('Up to 5 addresses in a box.', { exact: false })).toBeVisible();
    // Pasted from a mail program: a semicolon, capitals and the same address twice
    await dialog.getByLabel('CC (optional)').fill('Mahmudul@Aarong.com; mahmudul@aarong.com');

    // English instead: the subject and the message are written again; To and CC stay
    await dialog.getByLabel('Language').selectOption({ label: 'English' });
    await expect(dialog.getByLabel('Subject')).toHaveValue(
      /^Quotation QT-\d{4}-\d{2}-0003 from Rahman Garments Ltd\.$/,
    );
    await expect(dialog.getByLabel('Message')).toHaveValue(/^Dear Aarong,/);
    await expect(dialog.getByLabel('To', { exact: true })).toHaveValue('accounts@aarong.com');
    await dialog.getByRole('button', { name: 'Send email' }).click();
    await expect(page.getByText('Sending to accounts@aarong.com')).toBeVisible();
    await expect(dialog).toBeHidden();

    // Queued, then sent: the history asks again by itself while an email is on its way. Checked
    // before the toast closes, which takes longer than the mock's email.
    const row = historyRow(page, 'accounts@aarong.com');
    await expect(row).toContainText('Sending');
    await expect(row).toContainText('Sent');
    await expect(row).toContainText('CC mahmudul@aarong.com');
    await expect(row).toContainText('English · Farhana Rahman');
    await expectNoSideScroll(page);
  });
```

- **The download test** checks that the button says "Making the PDF…" and is disabled while the file is drawn (no
  second wait for the same row), and that the menu names the other language by its own name.
- **The email test walks the dialog in order:** the Bangla draft, the empty To with its hint, the "no company email"
  description, then each check of the form (no address, a wrong address, six addresses), a pasted CC with a
  semicolon, capitals and a duplicate, and the language change that writes the subject and message again while To and
  CC stay.
- **"Sending" is checked before the toast closes.** `toastShown()` waits for the toast to go (about 3 seconds); by
  then the mock's email is already sent. So this test checks the toast's text, then the row.
- **"CC mahmudul@aarong.com"** proves the cleaning: one address, lower case, although the box had two spellings.

```ts
  test('says when an email bounced, and the bell opens the quotation', async ({ page }) => {
    await openQuotation(page, QT_3);
    await send(page, 'Email');
    const dialog = page.getByRole('dialog', { name: /Email QT-\d{4}-\d{2}-0003/ });
    await dialog.getByLabel('To', { exact: true }).fill('accounts@aarong.bounce');
    await dialog.getByRole('button', { name: 'Send email' }).click();
    await toastShown(page, 'Sending to accounts@aarong.bounce');

    const row = historyRow(page, 'accounts@aarong.bounce');
    await expect(row).toContainText('Failed');
    await expect(row).toContainText("The mail server didn't take it.");

    // From another page, the bell names the quotation and opens it
    await openFromNav(page, 'Overview');
    await page.getByRole('button', { name: /^Notifications/ }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /Quotation QT-\d{4}-\d{2}-0003 couldn't be emailed/ })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: QT_3 })).toBeVisible();
  });

  test('makes a link to share on WhatsApp, copies it, and turns it off', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openQuotation(page, QT_3);
    await send(page, 'Share on WhatsApp');
    const dialog = page.getByRole('dialog', { name: /Share QT-\d{4}-\d{2}-0003/ });
    await expect(dialog.getByLabel('Language')).toHaveValue('bn');
    await dialog.getByRole('button', { name: 'Make link' }).click();

    // The link and the message in Bangla, with the link in it
    const link = dialog.getByLabel('Link', { exact: true });
    await expect(link).toHaveValue(/\/d\/[A-Za-z0-9_-]{22}$/);
    const url = await link.inputValue();
    await expect(dialog.getByLabel('Message')).toHaveValue(
      new RegExp(`^Rahman Garments Ltd\\.: কোটেশন QT-\\d{4}-\\d{2}-0003, ৳[০-৯,.]+।`),
    );
    expect(await dialog.getByLabel('Message').inputValue()).toContain(url);
    await expect(dialog.getByText('The link is shown only now.', { exact: false })).toBeVisible();
    // WhatsApp opens in a new tab, to Aarong's mobile, with the message typed in
    const whatsApp = dialog.getByRole('link', { name: 'Open WhatsApp' });
    await expect(whatsApp).toHaveAttribute('href', /^https:\/\/wa\.me\/8801713045678\?text=/);
    await expect(whatsApp).toHaveAttribute('target', '_blank');
    await expect(dialog.getByText('is not a mobile number', { exact: false })).toHaveCount(0);
    await expectNoSideScroll(page);

    await dialog.getByRole('button', { name: 'Copy link' }).click();
    await toastShown(page, 'Link copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // The new link heads the list; turning it off asks first
    const active = historyRow(page, 'Active');
    await expect(active).toContainText('বাংলা');
    await expect(active).toContainText('Not opened yet');
    await active.getByRole('button', { name: /^Turn off the link made / }).click();
    const confirm = page.getByRole('dialog', { name: 'Turn off this link?' });
    await confirm.getByRole('button', { name: 'Turn off link' }).click();
    await toastShown(page, 'Link turned off');
    await expect(historyRow(page, 'Active')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Turn off the link made / })).toHaveCount(0);
  });
```

- **The bounce test opens the bell from another page** (Overview), so the click must navigate to the quotation, not
  stay on it. The bell's list is read fresh when it opens, so the test does not wait for the 30-second badge poll.
- **The share test grants the clipboard** to the browser context (`clipboard-read`, `clipboard-write`), clicks "Copy
  link", and reads the clipboard back. Without the grant, Chromium refuses and the page shows its "copy it yourself"
  toast instead.
- **The WhatsApp link is checked by its `href` and `target`, never clicked:** clicking would open wa.me, a real site.
- **Turning off** goes through the confirm dialog; after it no row is active and no "Turn off" button is left.

```ts
  test("starts from the customer's document language, and says when the phone is no mobile", async ({
    page,
  }) => {
    await openFromNav(page, 'Customers');
    await listItem(page, /Aarong/).click();
    await expect(page.locator('dt:text-is("Document language") + dd')).toHaveText('বাংলা');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByLabel('Document language').selectOption({ label: 'English' });
    // A Dhaka landline, written the way people do
    await page.getByLabel('Phone (optional)', { exact: true }).fill('02-9123456');
    await page.getByRole('button', { name: 'Save customer' }).click();
    await toastShown(page, 'Aarong saved');
    await expect(page.locator('dt:text-is("Document language") + dd')).toHaveText('English');

    await openQuotation(page, QT_3);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Download PDF in বাংলা' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Share on WhatsApp' }).click();
    const dialog = page.getByRole('dialog', { name: /Share QT-\d{4}-\d{2}-0003/ });
    await expect(dialog.getByLabel('Language')).toHaveValue('en');
    await dialog.getByRole('button', { name: 'Make link' }).click();
    await expect(dialog.getByLabel('Message')).toHaveValue(
      /^Rahman Garments Ltd\.: Quotation QT-\d{4}-\d{2}-0003 for ৳[\d,.]+\./,
    );
    // No number to send to: WhatsApp asks for the contact
    await expect(dialog.getByText('is not a mobile number', { exact: false })).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'Open WhatsApp' })).toHaveAttribute(
      'href',
      /^https:\/\/wa\.me\/\?text=/,
    );
  });

  test('shows where an older quotation went', async ({ page }) => {
    await openQuotation(page, /QT-\d{4}-\d{2}-0001/);
    const email = historyRow(page, 'sourcing.dhaka@hm.com');
    await expect(email).toContainText('Sent');
    await expect(email).toContainText('CC merchandising@rahmangarments.com');
    // A link that ran its 30 days, and one turned off: neither can be turned off now
    await expect(historyRow(page, 'Ended')).toContainText('First opened');
    await expect(historyRow(page, 'Turned off')).toContainText('Not opened yet');
    await expect(page.getByRole('button', { name: /^Turn off the link made / })).toHaveCount(0);
    await expectNoSideScroll(page);
  });

  test('downloads an invoice, and prints its amount in words', async ({ page }) => {
    await openFromNav(page, 'Invoices');
    await page.getByRole('button', { name: 'New invoice' }).first().click();
    // The list has a "Customer" filter too: wait for the form
    await expect(page.getByRole('heading', { level: 1, name: 'New invoice' })).toBeVisible();
    await page.getByRole('button', { name: 'Customer', exact: true }).click();
    await page.getByRole('combobox', { name: 'Search customers' }).fill('aarong');
    await page.getByRole('option', { name: /Aarong/ }).click();
    await page.getByRole('button', { name: 'Add items' }).click();
    const picker = page.getByRole('dialog');
    await picker.getByRole('searchbox', { name: 'Search products and services' }).fill('crew-neck');
    const item = picker.getByRole('listitem').filter({ hasText: 'Basic crew-neck T-shirt' });
    await item.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(item.getByRole('button', { name: 'Added' })).toBeVisible();
    await page.keyboard.press('Escape');
    // 10 T-shirts at ৳290 and 15% VAT: ৳3,335
    await page.getByRole('group', { name: 'Line 1' }).getByLabel('Quantity').fill('10');
    await page.getByLabel('Deliver from (optional)').selectOption({ label: 'MAIN · Main store' });
    await page.getByRole('button', { name: 'Post invoice' }).click();
    await toastShown(page, /INV-\d{4}-\d{2}-0001 posted/);

    const pdf = page.waitForEvent('download');
    await send(page, 'Download PDF');
    expect((await pdf).suggestedFilename()).toMatch(/^INV-\d{4}-\d{2}-0001\.pdf$/);

    // The printed page, in the screen's language, under the totals
    await expect(page.locator('[data-print-sheet]')).toContainText(
      'In words: Three thousand three hundred thirty-five taka only',
    );
  });
});
```

- **The customer test changes two things at once:** the document language (English) and the phone, to a Dhaka
  landline written the usual way (`02-9123456`). The menu then offers "Download PDF in বাংলা", the share dialog starts
  in English, and the dialog says the phone is not a mobile number, with a WhatsApp link that has no number.
- **The history test reads the seeded H&M quotation.** "Ended" and "Turned off" rows have no "Turn off" button: only
  an active link can be turned off.
- **The invoice test** posts a counter sale (10 T-shirts at ৳290 plus 15% VAT, ৳3,335), downloads its PDF, and reads
  the hidden print sheet: "In words: Three thousand three hundred thirty-five taka only". It waits for the "New
  invoice" heading before it clicks "Customer": the invoices list has a "Customer" filter too (16.6), and without the
  wait the click landed on the list's filter.

```ts

// A link opens in a new tab, which starts its own mock: these tests open the mock's demo links
test.describe('the page behind a link', () => {
  test('shows an invoice and downloads its PDF, without a login', async ({ page }) => {
    await page.goto('/d/demo-invoice-link-0042');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Invoice INV-2026-27-0042' }),
    ).toBeVisible();
    await expect(page.getByText('From Rahman Garments Ltd.')).toBeVisible();
    await expect(page.getByText('For Aarong')).toBeVisible();
    await expect(page.getByText('৳1,15,000.00')).toBeVisible();
    await expect(page.getByText('Still due')).toBeVisible();
    await expect(page.getByText('৳40,000.00')).toBeVisible();
    await expect(page).toHaveTitle('Invoice INV-2026-27-0042 from Rahman Garments Ltd.');
    // No app shell: the customer is not an Omnivo user
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await expectNoSideScroll(page);

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download PDF' }).click();
    expect((await download).suggestedFilename()).toBe('INV-2026-27-0042.pdf');
  });

  test("reads in the link's language, in this tab only, and waits for the PDF", async ({
    page,
  }) => {
    await page.goto('/d/demo-bangla-quote-0003');
    await expect(
      page.getByRole('heading', { level: 1, name: 'কোটেশন QT-2026-27-0003' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'PDF তৈরি হচ্ছে…' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'PDF ডাউনলোড' })).toBeEnabled();

    // The person's own language was not changed: the app opens in English
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  });

  test("says when the PDF couldn't be made", async ({ page }) => {
    await page.goto('/d/demo-failed-receipt-07');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Money receipt MR-2026-27-0007' }),
    ).toBeVisible();
    await expect(page.getByText("The PDF couldn't be made.", { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download PDF' })).toHaveCount(0);
  });

  test('says when a link no longer works', async ({ page }) => {
    // Unknown, ended and turned off look the same
    await page.goto('/d/link-turned-off-000001');
    await expect(page.getByText('This link no longer works')).toBeVisible();
    await expectNoSideScroll(page);
    // Not the shape of a link: the page does not ask the server
    await page.goto('/d/not-a-link');
    await expect(page.getByText('This link no longer works')).toBeVisible();
  });
});
```

- **These tests start at the link itself** (`page.goto('/d/…')`), as a customer does, and never sign in. "No app
  shell" is checked as "no navigation".
- **The Bangla test then opens `/`:** the app is in English again. The public page switched the language for its own
  tab only (decision 34).
- **The gone test tries two tokens:** a well-shaped unknown one (the server says not found) and a short one (the page
  does not ask the server). Both show the same text.

### Check this part

```bash
pnpm --filter @omnivo/app exec tsc --noEmit
pnpm --filter @omnivo/app build
pnpm --filter @omnivo/app exec playwright test -c e2e/playwright.config.ts document-output
```

The type check now has no errors left, so the app's own `build` (which runs `tsc` first) works again. The last line
runs the new file on both screen sizes (22 tests, under a minute). Part 16.8 runs the whole suite once more.

> **What we checked in this part.** The app type-checks with no errors (the two mock errors of 16.6 are gone), and
> ESLint and Prettier are clean in `src/mocks`, `e2e` and the public page. The app builds, its unit tests pass (87),
> the bundle check passes (first load 197.3 KB, the public page 38.8 KB), and `pnpm boundaries` finds no violation
> (716 modules). The new file passed 22 of 22 after two fixes to the tests themselves (the "Sending" check came after
> the toast closed; the invoice test clicked the list's customer filter). The whole end-to-end suite ran once: 192 of
> 192 passed. We looked at screenshots of the menu, both dialogs, the history cards and the public page on a desktop
> and a phone, in light and dark; that found the two public page fixes above. Three checks by breaking things on
> purpose: an emails list that never asks again fails the email and bounce tests (they stay "Sending"); the public
> page remembering the link's language fails the "this tab only" test (the app opens in Bangla); a Send menu that
> ignores the customer's language fails the download, email and share tests.

---

## 16.8 — The OpenAPI document, and every check once

### No role templates this time

Steps 15c and 15d ended by giving the role templates their new permissions. Step 16 adds none (decision 10):
whoever may manage an invoice may email it and share it, and everyone who can open it may download it. So
`apps/api/src/setup/templates.ts` does not change.

### The OpenAPI document

No root file changes: no new script and no new `.env` line. Generate the API document again and commit it:

```bash
pnpm gen:openapi      # packages/contracts/openapi.json — 151 paths (144 before)
```

The 7 new paths are `/documents/{kind}/{id}/files`, `/documents/{kind}/{id}/files/{fileId}`,
`/documents/{kind}/{id}/email-draft`, `/documents/{kind}/{id}/emails` (list and send),
`/documents/{kind}/{id}/shares` (list and make), `/documents/{kind}/{id}/shares/{shareId}/revoke` and
`/public/documents/{token}`. Nine routes share these seven paths, because a list and its POST have one path. The
customer's paths changed too (`documentLanguage`). `pnpm test:openapi` fails if the committed file and the routes
disagree.

The Drizzle snapshots (`migrations/meta/0033_snapshot.json`, `0034_snapshot.json`, `_journal.json`) are written by
`drizzle-kit generate`; commit them as they are.

### Every check once

Then run the whole checklist (at the end of this guide) once. Each part ran only its own package's checks; this is
the first time everything runs together.

In the copy of the repo every check passed, but two needed a second run, and both times it was the machine, not
the code:

- **The first `pnpm test`**, two minutes after the Mac had started, had one PDF test time out: 42 seconds for a
  one-page invoice, with every package's tests running at once and a load of 30. The file takes about a second on
  its own, and the whole run passed when repeated.
- **The first end-to-end run** had 182 of 192 pass. The other ten were all on the phone and all timeouts, in the
  same minutes, while the load reached 46 (some tests waited 17 minutes for a page). Four of them were older tests
  (deliveries, credit notes). Run again with two workers, all ten passed; a second whole run passed 192 of 192 in
  under six minutes.

If a test times out on your machine, run
`pnpm --filter @omnivo/app exec playwright test -c e2e/playwright.config.ts --last-failed --workers=2` before
looking for a bug.

---

## 16.9 — Doc updates

After you implement this (ask me and I can do these):

**CLAUDE.md** — under "Typography", after the "Font-family names" bullet. Without it, the next step that draws a
PDF would reach for Noto, as the app does, and break ন্দ্র again:

> - **Server PDFs** (pdfkit, `apps/api/src/pdf/text.ts`) draw Bangla with Hind Siliguri
>   (`@fontsource/hind-siliguri`), not Noto Sans Bengali: pdfkit's shaper (fontkit) breaks Noto's ন্দ্র
>   (কেন্দ্র, চন্দ্র). The app's screens keep Noto Sans Bengali.

Under "Components", after "Print layout". The design system lists every pattern, and a pattern that is not listed
there does not exist for the next screen:

> - **Send menu (document output):** a secondary button "Send" (`Sent` icon, `ArrowDown01` on the right) next to
>   Print on a quotation, invoice, money receipt and credit note: Download PDF (the customer's language), Download
>   PDF in the other language (named in its own script, "বাংলা"), Email, Share on WhatsApp. Without the send
>   permission it is a single secondary "Download PDF" button (`Pdf01`). While the PDF is being made the button says
>   "Making the PDF…"; after about 20 seconds it gives up with a message, never a spinner forever.
> - **Email dialog:** the dialog with Language (a select), To and CC (one text box each, up to 5 addresses), Subject
>   and Message (a text area). A line under the title says the PDF is attached and where replies go. "Send email"
>   (`Mail01`) is the primary button. Changing the language writes the subject and the message again, and its hint
>   says so.
> - **Share dialog:** first the language and "Make link"; then the link in a read-only input (selected on focus,
>   "shown once" as its hint), the WhatsApp message in a read-only text area, "Copy link" and "Copy message"
>   (secondary `sm`, `Copy01`), and "Open WhatsApp" as a real link (`LinkSquare02`) in the footer. When the
>   customer's phone is not a mobile number, a 13px `ink-3` line says WhatsApp will ask for the contact.
> - **Document history cards:** "Emails" and "Share links" under the document, each a card with rows. An email:
>   Sending (`brand`, `Clock01`), Sent (`good`, `CheckmarkCircle02`), Failed (`crit`, `Alert02`) with a `crit`
>   hint, the addresses, CC, who and when. A link: Active (`good`, `Link01`), Ended (neutral, `Hourglass`), Turned
>   off (neutral, `CancelCircle`), its language, who made it, until when, first and last opened; "Turn off"
>   (secondary `sm`, `Unlink01`, asks first) on an active link for people with the send permission.
> - **Public document page (`/d/<token>`):** no app shell and no login. The `bg` page with one centered card (at
>   most 480px; padding 32px, 22px on phones): the company's logo and name, the document's name and number
>   (`Geist Mono`, never broken), the customer, then number, date, total (and for an invoice the due date and what
>   is still due) in a two-column list, a full-width primary "Download PDF" (a `crit` line with `Alert02` instead
>   when the PDF could not be made), and a 13px `ink-3` line that the link is private. A caption footer "Sent with Omnivo". It speaks the link's language
>   and does not save it. An ended or unknown link shows the same "This link no longer works" state.

In "Credit line and credit dialog", nothing changes. In the customer form, "Document language" is a plain select
(the `Select` pattern), so no new pattern is needed.

**build-plan.bn.md** — after the "ধাপ ১৫: Sales — চারটা গাইডে" block, add:

> #### ধাপ ১৬: ডকুমেন্ট আউটপুট
>
> চারটা ডকুমেন্ট বাইরে যায় — quotation, invoice, money receipt, credit note (order, challan, return, refund শুধু
> browser print)। **PDF:** worker-এ pdfkit; API পেজের model (সব শব্দ ও সংখ্যা, ভাষাসহ) বানায়, worker শুধু আঁকে।
> বাংলা ফন্ট Hind Siliguri (fontkit Noto-র ন্দ্র ভাঙে)। প্রথম দরকারে বানায়, MinIO/R2-তে রাখে; ডকুমেন্ট বদলালে
> (যেমন invoice paid হলে) নতুন fingerprint, নতুন ফাইল। **ইমেইল:** dialog (To, CC ≤৫, subject, message), PDF
> attachment, From "Company via Omnivo", reply-to কোম্পানির ইমেইল; ডকুমেন্টে ইমেইলের ইতিহাস; ব্যর্থ হলে bell।
> **WhatsApp:** token লিংক `/d/<token>` (login ছাড়া, ৩০ দিন, বন্ধ করা যায়, DB-তে শুধু hash), `wa.me` মেসেজ
> সহ; public পেজে নম্বর, তারিখ, মোট, বাকি, PDF ডাউনলোড। **কাস্টমারের document language** (English/বাংলা),
> পাঠানোর সময় বদলানো যায়। **কথায় টাকা** (লাখ/কোটি, বাংলা ও ইংরেজি) invoice, receipt, credit note, refund-এ — PDF
> ও প্রিন্টে। পাঠাতে ডকুমেন্টের manage permission, ডাউনলোডে কিছু লাগে না। Mushak 6.3/6.7 পরে।

**COMMANDS.md** — in "Look at the data", after the last sales query, add:

```bash
# PDFs per workspace, document kind, language and status (a 'pending' one older than a minute means the worker is not running)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, f.kind, f.language, f.status, count(*) AS files, max(f.created_at) AS last FROM document_files f JOIN tenants t ON t.id = f.tenant_id GROUP BY t.slug, f.kind, f.language, f.status ORDER BY t.slug, f.kind, f.language, f.status"
# the last 20 document emails ('failed' rang the sender's bell)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, e.kind, array_to_string(e.\"to\", ', ') AS \"to\", e.subject, e.status, u.email AS sent_by, e.created_at, e.sent_at FROM document_emails e JOIN tenants t ON t.id = e.tenant_id JOIN users u ON u.id = e.sent_by ORDER BY e.created_at DESC LIMIT 20"
# share links that still work, newest first, with when the customer opened them
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, s.kind, s.language, s.created_at, s.expires_at, s.first_opened_at, s.last_opened_at FROM document_shares s JOIN tenants t ON t.id = s.tenant_id WHERE s.revoked_at IS NULL AND s.expires_at > now() ORDER BY s.created_at DESC"
# customers per document language
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, p.document_language, count(*) AS customers FROM parties p JOIN tenants t ON t.id = p.tenant_id WHERE p.is_customer GROUP BY t.slug, p.document_language ORDER BY t.slug, p.document_language"
```

The four queries were run against a database migrated to 0034, holding 16.2's check data. `"to"` is quoted
because `TO` is an SQL keyword; the backslashes keep the quotes inside the shell's own double quotes. The PDF files
themselves are in the storage bucket under `tenants/<tenant id>/documents/<kind>/<document id>/`; MinIO's console
(port 9001 in the dev stack) shows them.

---

## 16.10 — Run it

```bash
pnpm install                                  # Hind Siliguri comes into apps/api, Noto Sans Bengali leaves it
pnpm db:migrate                               # 0033 + 0034: three tables, their rules, parties.document_language
pnpm gen:openapi                              # commit it
pnpm dev                                      # restart it: new routes and two new worker jobs
```

In `pnpm db:psql`:

```sql
SELECT relname, relforcerowsecurity FROM pg_class
 WHERE relname IN ('document_files', 'document_emails', 'document_shares');   -- t, three rows
SELECT polname FROM pg_policy WHERE polrelid = 'document_shares'::regclass;  -- tenant_isolation, share_by_token
SELECT document_language, count(*) FROM parties WHERE is_customer GROUP BY 1; -- en for every customer you have
```

### What you will see

1. **A customer** → Edit: "Document language", English. Set one customer to বাংলা; the customer page shows it.
2. **An invoice of that customer** (posted) → **Send** → **Download PDF**: "Making the PDF…" for a second or two,
   then the PDF opens in a new tab, in Bangla, with the amount in words under the total. Click again: it opens at
   once (the same file). **Download PDF in English** draws a second file.
3. **Record a payment** on it, then download again: a new file, which says what is still due. The old one stays in
   storage (see "Not in this step").
4. **Send → Email**: To is the customer's email, the subject and message are in Bangla. Switch the language to
   English: both are written again. Add a CC, **Send email**: the toast says it is sending, the "Emails" card says
   Sending, then Sent. Mailpit (`http://localhost:8025`) has the email from "Your company via Omnivo", with
   Reply-To your company's email (Settings → Company), the CC and the PDF attached.
5. **A failed email** cannot be seen here: Mailpit takes every address. With a real mail provider, an email the
   server refuses is tried again, then says Failed on the card and rings your bell; the bell opens the invoice.
   The end-to-end tests show it with the mock's "bounce" address.
6. **Send → Share on WhatsApp** → **Make link**: the link, the message, "Open WhatsApp". If the customer's phone is
   not a mobile number (`01…`, or a number with its country code), WhatsApp opens without a number and the dialog
   says so. Open the
   link in a private window: the public page, in the link's language, with **Download PDF**. The "Share links" card
   now says when it was first opened.
7. **Turn off** the link (it asks first), then reload the private window: "This link no longer works".
8. **A draft invoice** has no Send menu: only numbered documents go out. **A voided receipt** has none either.
9. **Someone without `sales.invoice.manage`** sees a single "Download PDF" button.
10. **Print** an invoice, a receipt, a credit note and a refund: "In words: …" under the total, in the language of
    your screen.
11. **A step 11 report** → Export → PDF, in Bangla: the same report as before, now in Hind Siliguri, and ন্দ্র (in
    "কেন্দ্র", if an account name has it) drawn correctly.
12. **A company logo in WebP** is left off the PDF (pdfkit draws only PNG and JPEG); upload a PNG in Settings →
    Company if you want it on the PDF.
13. **Bangla** and **390px**: the Send menu, both dialogs and the public page fit, and no page scrolls sideways.

---

## Checklist

```bash
pnpm dedupe --check
pnpm lint
pnpm format
pnpm typecheck
pnpm test                    # 407: contracts 176 + api 107 + app 87 + ui 19 + i18n 11 + auth 7
pnpm test:integration        # 350 — 19 new
pnpm test:tenant-leak        # 67 — 4 new
pnpm test:e2e                # 192: 96 flows × desktop and 390px
pnpm build
pnpm test:bundle-size        # first load 197.3 KB gz; public page 38.8, Send menu 78.1, dialogs 75.3, history 72.0
pnpm test:openapi
pnpm boundaries
```

## What we found on the way

All of these are fixed in the guide — if you get stuck at the same place, you will recognise it:

- **fontkit draws Noto Sans Bengali's ন্দ্র wrong** (16.3): the ra-phala sits loose beside the letters in
  কেন্দ্র and চন্দ্র. The browser shapes the same font correctly, so the screens never showed it; step 11's Bangla
  report PDFs had it all along. Hind Siliguri draws every cluster we tried correctly (decision 21).
- **The English email said "reach Rahman Traders Ltd.."** (16.4): the sentence ended with the company's name, and
  a name that ends in a full stop gave two. The sentence now ends with "reply to this email."
- **`wrap()` gave a long text an empty last line** (16.4), which pushed the totals down by a line. The loop now
  stops at the last letter.
- **The bell could not open the document of a failed email** (16.6): the notification named the kind and number
  but not the id. `document.email_failed` now carries the id too (16.1, 16.3 and 16.4 changed with it).
- **The sales lists went over their 100 KB budget** (16.5–16.6) because the contract grew the shared `routes`
  object. The customer filter loads lazily now (decision 37).
- **A lazy chunk was counted with its parent's code** (16.6): a module that only the Send menu and the dialogs
  (the menu's own lazy child) used was folded into the menu's chunk, and the budget script then counted it for the
  dialogs. The WhatsApp icon did it; the dialog's link uses another icon.
- **The public page said "Omnivo" twice** at the bottom, and **a Bangla heading broke inside "QT-…"** on a phone
  (16.7, from the screenshots). The footer is text only, and the number never breaks.
- **Mailpit's text has `\r\n` line ends** (16.4); `testing/mailpit.ts` turns them into `\n` before a test compares
  text.

---

## Notes left for later steps

**Step 17 (purchasing):**

- **A purchase order goes to a supplier** the way a quotation goes to a customer. Add `purchase_order` to
  `OUTPUT_DOCUMENTS` and `SEND_PERMISSIONS`, a builder in `models.service.ts` and its words in `copy.ts`; the
  routes, the tables, the worker, the dialogs and the public page take it as they are. `parties.document_language`
  is already on every party, so a supplier can have one; the supplier's contract and form need the field.
- **A debit note** is the mirror of the credit note; its PDF can copy the credit note's builder.

**The VAT compliance step:**

- **Mushak 6.3 and 6.7** can be drawn by `pdf.ts` from a model, as the invoice and credit note are. They need the
  buyer's BIN (kept on the customer) and the VAT of each line (kept on the invoice and credit note lines).

**Notes for any step:**

- **Change `LAYOUT_VERSION` in `apps/api/src/documents/model.ts`** whenever `pdf.ts` draws something differently.
  The fingerprint includes it; without the change, the stored PDFs keep the old look.
- **Server PDFs use Hind Siliguri** for Bangla (16.9's CLAUDE.md line). Test a new font with ন্দ্র before you use it.
- **Old PDF files are never deleted** (see "Not in this step"). A cleanup job would delete the files of looks that a
  newer one replaced, and their `document_files` rows (the guard allows deleting them, and no foreign key points at them).
- **Public routes have no rate limit** (decision 27): login, sign-up and the share page should get one together.
