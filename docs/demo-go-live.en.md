# Demo go-live checklist

This puts Omnivo on a demo server, so the first customer can see the admin panel. It is a demo
(staging) copy, not production.

- The setup is already in the repo: [staging-deploy.en.md](staging-deploy.en.md) and
  [`infra/staging/`](../infra/staging/). Only the purchases and a few accounts are missing.
- No email leaves the demo server. Mailpit (a test inbox on the server) keeps every email. So you
  create the customer's account yourself, copy the invitation link from Mailpit, and send it to
  the customer.
- Do not put real business data on the demo server.

## Your part: purchases and accounts

### Step 1. Get an international card

- [ ] Cloudflare and Hetzner charge in US dollars or euros. A dual-currency card (endorsed on your
      passport) or an international debit card works.

### Step 2. Buy the domain on Cloudflare

- [ ] Open an account at `dash.cloudflare.com`.
- [ ] Go to **Domain Registration → Register Domains**, search for a name and buy it (`.com` is
      about $10 a year). The DNS stays on Cloudflare by itself.

### Step 3. Make an SSH key on your computer

An SSH key is a pair of files that lets you log in to the server without a password. In
PowerShell:

```powershell
# Press Enter to save it in C:\Users\HP\.ssh\id_ed25519, and set a passphrase
ssh-keygen -t ed25519 -C "ekram-pc"
# Start the SSH agent, so the passphrase is asked only once
Get-Service ssh-agent | Set-Service -StartupType Automatic
Start-Service ssh-agent
ssh-add $env:USERPROFILE\.ssh\id_ed25519
```

- [ ] Done.

With the agent running, Claude can run commands on the server for you without the passphrase. The
key itself stays only on your computer.

### Step 4. Buy the server on Hetzner Cloud

- [ ] Open an account at `console.hetzner.cloud`. Hetzner checks the ID of new accounts and
      sometimes refuses one. If it refuses yours, take DigitalOcean (Singapore, a 4 GB droplet).
      The steps are the same.
- [ ] Click **Add Server** and choose:
  - **Location:** Singapore
  - **Image:** Ubuntu 24.04
  - **Type:** Shared vCPU, **x86** (AMD or Intel, not ARM), 4 GB RAM or more
  - **SSH key:** paste the whole text of `C:\Users\HP\.ssh\id_ed25519.pub` (the `.pub` file only,
    never the other one)
  - **Backups:** on (it adds 20% to the price)
  - **Name:** `omnivo-demo`
- [ ] When the server is ready, write down its **IPv4 address**.

Why Singapore and x86: Singapore is about 50–70 ms from Bangladesh, Germany more than 150 ms. The
later storefront serves shoppers on mobile data, so a fast first load matters. GitHub's standard
runners build amd64 images, so an ARM server would need a slow emulated build.

### Step 5. Add four DNS records on Cloudflare

- [ ] Go to your domain → **DNS → Records**. Make four `A` records. Each one points at the
      server's IPv4 address, with the proxy set to **DNS only (grey cloud)**:

| Name | Type | Value | Proxy |
| --- | --- | --- | --- |
| `app.demo` | A | the server's IPv4 | DNS only |
| `api.demo` | A | the server's IPv4 | DNS only |
| `files.demo` | A | the server's IPv4 | DNS only |
| `mail.demo` | A | the server's IPv4 | DNS only |

The names say `demo`, not `staging`, because "staging" may look odd to the customer. Every host
name is read from the server's `.env` and the GitHub variables, so no code changes. Keep
`app.<domain>` free for production later.

"DNS only" matters: Caddy then gets its own HTTPS certificates from Let's Encrypt directly, and
nothing between the browser and the server changes the requests.

### Step 6. Install the GitHub CLI

```powershell
winget install --id GitHub.cli
gh auth login
```

- [ ] Done.

With it, Claude can put the deploy key and the secrets into GitHub straight from the files. No
secret is ever pasted into the chat.

## What to send Claude

Send these four things when steps 1 to 6 are done:

- The domain name (for example `omnivo.com`)
- The server's IPv4 address
- An email address for Let's Encrypt (it writes there if a certificate has a problem)
- One line that says steps 3, 5 and 6 are done

**Never send** a private key, any password, card details or the server's `.env`. Claude needs none
of them.

## What Claude does next

Claude asks for your approval before each step.

1. **Check the DNS.** All four names must point at the server.
2. **Set up the server** (step A5 of [staging-deploy.en.md](staging-deploy.en.md)): updates, the
   firewall, Docker, a `deploy` user, a separate deploy key for GitHub Actions, random secrets in
   `.env` made on the server itself, and the nightly backup.
   - **When `.env` is made, keep a copy in your own password manager.** If it is lost, the
     database cannot be opened again.
3. **Set up GitHub** (step A6): the `staging` environment, its secrets and variables, with `gh`.
4. **Deploy.** The deploy files are only on the `staging-deploy` branch now, and a deploy starts on
   a push to `dev`. So the branch is merged into `dev` and pushed. This needs a clear "yes" from
   you first.
5. **Check it** (step A7): health, HTTPS, a logo upload, a Bangla PDF and the IP in the audit log.

Then you create a workspace at `https://app.demo.<domain>` and send the customer the link.

## Cost and time

| Item | Cost (approximate) | Time |
| --- | --- | --- |
| Domain (Cloudflare) | about $10 a year | a few minutes |
| Server (Hetzner Singapore, with backups) | about €8–12 a month | an hour or two for your purchases, plus Hetzner's ID check |
| Setup by Claude | free | about half an hour |

Prices change, so check them on each site before you buy (prices as of November 2026).

## Before real production

This demo is not production. Before a customer keeps real data on Omnivo, plan these:

- Real email (Amazon SES or Resend) in place of Mailpit, with SPF and DKIM records in DNS.
- Off-site backups (Cloudflare R2 or Backblaze B2), not only the server's own backup.
- Uptime monitoring (UptimeRobot or Better Stack, free plans).
- A separate production server and host names (`app.<domain>`), apart from the demo.
