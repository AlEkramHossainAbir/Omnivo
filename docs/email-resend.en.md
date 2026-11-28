# Real email with Resend (production)

Since 28 Nov 2026, production can send real email through [Resend](https://resend.com). The demo keeps
sending every email to Mailpit. The SMS (the shop's phone codes) stay in Mailpit on both stacks, until a
real SMS provider is chosen.

| | Demo | Production |
|---|---|---|
| Emails (invitations, welcome, documents, scheduled reports) | Mailpit (`demo-mail.omnivosoft.com`) | Resend, to the real inbox |
| SMS (phone codes, "picked up") | Mailpit | Mailpit (`mail.omnivosoft.com`) |
| `SMTP_URL` in `.env` | not set | `smtps://resend:<API key>@smtp.resend.com:465` |

## How it works in the code

- Only the worker sends email. `MailService` (`apps/api/src/mail/mail.service.ts`) uses nodemailer with
  `SMTP_URL`. Any SMTP service works, so moving away from Resend later only changes `SMTP_URL`. No Resend SDK
  is used.
- `infra/staging/compose.yml` sets `SMTP_URL: ${SMTP_URL:-smtp://mail:1025}`. With no `SMTP_URL` in `.env`,
  the worker uses Mailpit, as before.
- The SMS have their own mail server, `SMS_SMTP_URL`, which `compose.yml` always sets to Mailpit
  (`smtp://mail:1025`). `MailSmsSender` (`apps/api/src/sms/sms-sender.ts`) sends through its own
  `MailService` (the `SMS_MAIL` provider in `worker.module.ts`), never the worker's main one.
- Why the SMS are kept apart: each SMS is an email to `<phone>@sms.invalid`. Resend would refuse it or count
  it as a bounce. Too many bounces and Resend blocks the account, and then the invitations stop too.
- `config.ts` (`smsConfig`) refuses to start a production worker without `SMS_SMTP_URL`. Outside production
  (your computer, the tests), it falls back to `SMTP_URL`, which is Mailpit there.
- Why the demo keeps Mailpit: testers type made-up addresses. Real email to them would bounce and hurt the
  account.

## What you do by hand

Do the steps in this order. Nothing breaks if you stop half way: until step 5, production keeps sending to
Mailpit.

### 1. Make a Resend account

1. Sign up at <https://resend.com>. The free plan sends 3,000 emails a month and 100 a day, for one domain.
   That is enough to start. Upgrade when the dashboard shows you near the limit.
2. Turn on two-factor sign-in (Settings → Account). This account can send email as `omnivosoft.com`.

### 2. Add the domain

1. **Domains → Add domain**. Type `omnivosoft.com`. Pick any region; the DNS values depend on it, so copy them
   from the Resend page, not from this guide.
2. Resend shows three records:
   - an `MX` record on `send` (this is where bounces come back to Resend),
   - a `TXT` record on `send` with `v=spf1 include:amazonses.com ~all` (SPF: it lists the servers that may
     send for this domain),
   - a `TXT` record on `resend._domainkey` with a long `p=…` value (DKIM: a signature on every email, so
     nobody can change it on the way).

   They are on `send.` and `resend._domainkey.`, not on the bare domain. So they do not clash with the
   tunnel's `CNAME`s (`app`, `api`, `mail` …) or with any other mail records on `omnivosoft.com`.
3. Do **not** use `mail.omnivosoft.com` as the sending domain. That name is a `CNAME` to the tunnel
   (production's Mailpit page), and a name with a `CNAME` cannot have other records.

### 3. Put the records in Cloudflare

Resend offers **"Sign in to Cloudflare"**, which adds the records for you. Or add them by hand:

1. Cloudflare dashboard → `omnivosoft.com` → **DNS → Records → Add record**.
2. Add each record exactly as Resend shows it. The name is only the part before the domain (`send`,
   `resend._domainkey`). Cloudflare adds `.omnivosoft.com` itself.
3. Make sure the proxy is **off (DNS only, grey cloud)**. Cloudflare cannot proxy `MX` and `TXT` records
   anyway. Check it if a record is a `CNAME`.
4. Add a DMARC record if `_dmarc` has none yet (look in the list first; keep only one DMARC record):
   - Type `TXT`, name `_dmarc`, content `v=DMARC1; p=none; rua=mailto:<an inbox you read>`.
   - `p=none` only collects reports. After 2–4 weeks with only passing reports, change it to
     `p=quarantine`. Then an email that pretends to be from `omnivosoft.com` goes to spam.
5. Back in Resend, click **Verify DNS records**. It usually takes a few minutes, but can take up to a few
   hours. Wait until the domain shows **Verified**.

### 4. Make the API key

1. Resend → **API Keys → Create API key**.
2. Name: `omnivo-production-smtp`. Permission: **Sending access**. Domain: `omnivosoft.com` only. With only
   sending access, the key cannot read or delete anything in the account if it leaks.
3. Copy the key (`re_…`). Resend shows it only once. Save it in the password manager.

### 5. Put it in production's `.env`

The code must be on `main` first (merge `dev` into `main`), so the server has the new `compose.yml`. A
`compose.yml` from before this change ignores `SMTP_URL`.

```bash
ssh myvps
sudo -iu deploy
cd /srv/omnivo                         # production only, never /srv/omnivo-demo
grep -E '^(DEPLOY_TARGET|MAIL_FROM_NAME|MAIL_FROM_DOMAIN)=' .env
# must print DEPLOY_TARGET=production, MAIL_FROM_NAME=Omnivo, MAIL_FROM_DOMAIN=omnivosoft.com
nano .env
```

Add this line at the end, with your key in place of `re_xxxxxxxx`, and keep the quotes:

```bash
SMTP_URL="smtps://resend:re_xxxxxxxx@smtp.resend.com:465"
```

- The user name is the word `resend`. The password is the API key.
- Port 465 uses TLS from the first byte. Use it, not 587, so the password never goes over a connection that
  is not encrypted yet.
- Type the key in `nano`, not with `echo … >> .env`, so it does not stay in the shell's history.
- A Resend key has only letters, digits and `_`, so it needs no escaping. If you ever use another provider
  whose password has `+`, `/`, `=` or `@`, write them as `%2B`, `%2F`, `%3D`, `%40`.

Then restart the worker with the new `.env`:

```bash
docker compose up -d worker
docker compose exec worker printenv SMTP_URL SMS_SMTP_URL | sed 's/:[^:@]*@/:***@/'
# smtps://resend:***@smtp.resend.com:465, then smtp://mail:1025 (the sed hides the key)
docker compose logs --tail 50 worker   # no "Invalid environment" error
```

Every later deploy keeps it: `deploy.sh` keeps `.env` as it is (it only rewrites `IMAGE_TAG`).

Do not add `SMTP_URL` to the demo's `.env`.

### 6. Check that it works

1. In production, invite a real address you can read (from the team page). The email arrives within a
   few seconds. Check the spam folder too.
2. In Gmail, open the email → **⋮ → Show original**. `SPF`, `DKIM` and `DMARC` must all say `PASS`.
3. Email an invoice to yourself. The sender must read "<Company> via Omnivo <no-reply@omnivosoft.com>".
   **Reply** must go to the company's own email (the email in the company settings), not to `no-reply`.
4. The email also shows in Resend → **Emails**, with its delivery status.
5. `https://mail.omnivosoft.com` (production's Mailpit) gets no new invitation now. Only SMS land there.

## When something goes wrong

| What you see | Why | What to do |
|---|---|---|
| The team page says "Email not sent", the worker log has `Invalid login` / `535` | Wrong API key, or the key was deleted | Make a new key (step 4), put it in `.env`, `docker compose up -d worker` |
| Worker log: `450` / `domain is not verified` | Resend has not verified `omnivosoft.com` yet | Wait for **Verified** (step 3.5) |
| Worker log: `Invalid environment … SMS_SMTP_URL` | The server's `compose.yml` is older than this change, or the line was removed | Deploy `main` again, which copies `compose.yml` |
| Worker log: `ETIMEDOUT` / `Greeting never received` | The home connection blocks port 465 going out | Try `smtp://resend:<key>@smtp.resend.com:2587` (Resend's STARTTLS port), then `587`. Tell the ISP if all are blocked |
| Email lands in spam | DMARC missing, or a new domain with no history yet | Check step 6.2. New domains get better after a few days of normal sending |
| Some emails of a big scheduled report run fail | Resend's rate limit (a few emails a second) | The worker retries each email 5 times over about 30 seconds, so most still go. If it keeps happening, ask Resend for a higher limit |

Going back to Mailpit at any time: remove the `SMTP_URL` line from production's `.env` and run
`docker compose up -d worker`.

## Later

- A real SMS provider: a new `SmsSender` class in `apps/api/src/sms/` and one line in `worker.module.ts`
  (`SMS_SENDER`). Then `SMS_SMTP_URL`, `SMS_MAIL` and production's Mailpit can go.
- Bounce and complaint handling (Resend webhooks), so an address that bounces is not mailed again. Not
  needed at today's volume.
