# Omnivo on the home VPS

This is how the demo (staging) copy of Omnivo runs on the home VPS. It uses the
files in [`infra/staging/`](../infra/staging/), which are explained line by line in
[staging-deploy.en.md](staging-deploy.en.md). This page says what is different on this server and
how to run it day to day. All the addresses are listed in [domains.en.md](domains.en.md).

This repository is public, so the server's IP address, SSH port and user names are not written
here. They are in the VPS access sheet and in the `myvps` entry of `~/.ssh/config` on your Mac.

## The addresses

| Address | What it is |
| --- | --- |
| `https://app.omnivosoft.com` | The ERP app |
| `https://api.omnivosoft.com` | The API (`/health` answers `{"status":"ok"}`) |
| `https://files.omnivosoft.com` | File storage (MinIO). The browser uploads and downloads here with signed links. Only the shop's photos (`/omnivo/storefront/…`) are public |
| `https://mail.omnivosoft.com` | Mailpit: every email the server sends lands here. User `tester`, password below |
| `https://shop.omnivosoft.com` | The online shop as a demo (the `shop` service). It shows the mock shop, so nothing in it is real, and a deploy forgets its orders |
| `https://omnivosoft.com` | The marketing website (`apps/website`). Static files inside the `web` image, served by the same Caddy as the app. `www.omnivosoft.com` redirects here. Search engines are told not to list it while its prices are placeholders |

The website's host is `SITE_HOST` in `/srv/omnivo/.env`. It must be there before the first deploy
that has the website, or `compose.yml` refuses to start. Its two DNS records (`@` and `www`) are
made by hand, as in "A new address on the tunnel" below.

The names are one level below the domain (`app.omnivosoft.com`, not `app.demo.omnivosoft.com`).
Cloudflare's free HTTPS certificate covers only one level, so a deeper name would show a
certificate error.

## How a request reaches the server

```text
browser ──HTTPS──> Cloudflare ──tunnel──> cloudflared ──HTTP──> Caddy ──> app files / api / storage / mail
                                          (container)         (web)
```

The VPS runs on a home connection. Only SSH is open from outside, and the IP address can
change. So the server opens no web port at all:

- **cloudflared** (the `tunnel` service in `compose.yml`) opens an outgoing connection to
  Cloudflare and keeps it open. Cloudflare sends each visitor's request down this connection. When
  the home IP changes, cloudflared simply connects again, and the site keeps working.
- **HTTPS ends at Cloudflare.** Caddy only gets plain HTTP from cloudflared, inside Docker's own
  network, so the Caddyfile has `auto_https off` and no Let's Encrypt.
- **The visitor's IP:** Cloudflare puts it in the `CF-Connecting-IP` header. Caddy reads it from
  there and writes it into `X-Forwarded-For` for the API, so the audit log shows the person's real
  address.

The tunnel is called `omnivo` in Cloudflare (**Zero Trust → Networks → Tunnels**). Its four DNS
records are `CNAME`s to the tunnel, made by `cloudflared tunnel route dns`. Do not change them by
hand.

## The server

| | |
| --- | --- |
| Login | `ssh myvps` (the entry in `~/.ssh/config` on the Mac) |
| Machine | 2 vCPU, 3 GB RAM, 30 GB disk, x86-64, Ubuntu 24.04 |
| Swap | 2 GB, in `/swapfile` |
| Docker | Docker Engine and the Compose plugin, from Docker's own apt repository |
| App user | `deploy` (in the `docker` group). The stack lives in `/srv/omnivo` |
| Settings and secrets | `/srv/omnivo/.env`, mode `600`, made on the server with `openssl rand` |

The VPS owner says: the host may reboot around 22:00 UTC for updates, and there are **no
backups** of the VM. Every container has `restart: unless-stopped`, and Docker starts at boot, so
the stack comes back by itself after a reboot.

To run a command as the app user:

```bash
ssh myvps
sudo -iu deploy
cd /srv/omnivo
docker compose ps
```

## Deploys

A push to `dev` runs CI. When the checks pass, GitHub Actions builds three images (`api`,
`migrate`, `web`), pushes them to GHCR, logs in to the server as `deploy` over SSH, copies the
stack files and runs `./deploy.sh <commit>`. Nothing has to be done by hand.

GitHub settings it uses:

| Where | Name | Value |
| --- | --- | --- |
| Environment `staging`, secret | `STAGING_SSH_HOST` | The VPS's IP address |
| Environment `staging`, secret | `STAGING_SSH_PORT` | The VPS's SSH port (not 22) |
| Environment `staging`, secret | `STAGING_SSH_USER` | `deploy` |
| Environment `staging`, secret | `STAGING_SSH_KEY` | The private half of the deploy key. Only GitHub has it |
| Environment `staging`, secret | `STAGING_KNOWN_HOSTS` | The server's SSH fingerprints |
| Repository variable | `STAGING_API_URL` | `https://api.omnivosoft.com` (built into the app) |
| Repository variable | `STAGING_APP_URL` | `https://app.omnivosoft.com` |

The two variables must be **repository** variables, not environment variables. The build job
has no environment, so it cannot see environment variables, and the app would be built without
the API's address.

To deploy an older build again, run on the server: `./deploy.sh <full commit hash>`. Every deploy
is listed in `/srv/omnivo/deploys.log`.

## When the home IP changes

The website keeps working (the tunnel does not care about the IP). Only SSH, and so the
automatic deploys, stop working, because they use the old IP. Ask the VPS owner for the new IP,
then:

```bash
# 1. GitHub Actions
gh secret set STAGING_SSH_HOST --env staging --body <new IP>
ssh-keyscan -p <SSH port> -t ed25519,ecdsa,rsa <new IP> 2>/dev/null | gh secret set STAGING_KNOWN_HOSTS --env staging
# 2. Your Mac: change HostName in the "Host myvps" entry of ~/.ssh/config
```

Then re-run the failed deploy in **Actions**.

## A new address on the tunnel

The tunnel was made from the server with `cloudflared` commands, so its routes are managed there,
not in the Cloudflare dashboard. The Cloudflare login that allows this was deleted after the setup,
because it can change every DNS record of the domain. To add an address (for example
`shop.omnivosoft.com`):

```bash
ssh myvps
sudo -iu deploy
cf() { docker run --rm --user "$(id -u):$(id -g)" -e HOME=/cf -v /home/deploy/.cloudflared:/cf/.cloudflared cloudflare/cloudflared:2026.10.6 "$@"; }
cf tunnel login            # prints a link: open it, pick omnivosoft.com, click Authorize
cf tunnel route dns omnivo shop.omnivosoft.com
rm /home/deploy/.cloudflared/cert.pem   # delete the login again
```

Then add the site to the Caddyfile. The link works for about 10 minutes.

There is a shorter way that needs no login on the server. `route dns` only makes one DNS record,
so you can make the same record by hand: in the Cloudflare dashboard → `omnivosoft.com` → **DNS**
→ **Add record**, type `CNAME`, name `shop`, target `<tunnel id>.cfargotunnel.com`, **Proxied** on.
The tunnel id is the name of the `.json` file in `/home/deploy/.cloudflared/` on the server. The
tunnel sends every name to Caddy, so nothing changes in the tunnel itself.

A new site in the Caddyfile that reads a new `.env` name (like `SHOP_HOST`) needs that line in
`/srv/omnivo/.env` **before** the deploy. `compose.yml` refuses to start without it.

## Mailpit

No email leaves the server. Every email (welcome, invitations, password resets) lands in
`https://mail.omnivosoft.com`. To see the password:

```bash
ssh myvps 'sudo grep MAIL_UI_PASSWORD /srv/omnivo/.env'
```

To invite a customer: create the invitation in the app, open the email in Mailpit, copy the link
and send it to the customer yourself.

## Backups

`backup.sh` saves a copy of the database in `/srv/omnivo/backups` and keeps 7 days. It runs every
night at 03:00 UTC from the `deploy` user's crontab:

```text
0 3 * * * /srv/omnivo/backup.sh >> /srv/omnivo/backups/backup.log 2>&1
```

These copies are on the same VM, and the VM has no backup. So also copy them to your Mac now and
then:

```bash
mkdir -p ~/omnivo-backups
scp 'myvps:/srv/omnivo/backups/*.dump' ~/omnivo-backups/
```

The `backups` folder must exist before the first night: cron opens `backup.log` in it before
`backup.sh` runs. It was made by hand on 12 Nov 2026, with a first backup.

Uploaded files (logos, the shop's photos) live in the `storage-data` Docker volume and are not in the dump. On a demo
that is acceptable; for real customers, plan off-site backups first (see
[home-server-requirements.en.md](home-server-requirements.en.md), Part 3.7).

To restore a dump: `./restore.sh backups/<file>.dump` (as `deploy`, in `/srv/omnivo`).

**Keep a copy of `.env` in your password manager.** The database passwords and the auth secrets
are only there. If `.env` is lost, the database cannot be opened and everyone is signed out.

## Memory

3 GB is small for this stack. After the first deploy it used about 1.3 GB, with the 2 GB swap as a
safety net. Valkey (the job queue) is capped at 256 MB. Check it now and then:

```bash
ssh myvps 'free -h; sudo docker stats --no-stream'
```

If swap is in use most of the time, ask for more RAM before adding testers.

## Not on this server yet

- A real shop. Since 26g a workspace can set up and open a shop in the app (Storefront menu), but
  `https://shop.omnivosoft.com` still shows the mock shop (`SHOP_SOURCE` is not set). A real shop lives at
  `<subdomain>.<SHOP_BASE_DOMAIN>`, and this server has one fixed `SHOP_HOST`, so the switch needs a wildcard
  host first: a DNS record and a tunnel route for the shops' names, and a Caddy site for them. Then the `shop`
  service gets `SHOP_SOURCE=api` and `SHOP_API_URL=http://api:3000` (inside Docker's network), and the API gets
  `SHOP_BASE_DOMAIN` (the shops' domain). Until then, the app's "View shop" link points at an address that does
  not answer. `SHOP_PUBLIC_PORT` stays unset here: in production a shop's address has no port.
- A rate limit for the public shop API. `https://api.omnivosoft.com/public/v1/*` answers anyone, with no
  sign-in. Before a real shop opens, add a Cloudflare rate limiting rule for that path (**Security → WAF → Rate
  limiting rules**). The shop's server calls the API inside Docker's network, so the rule never slows the shop.
- Real email (Amazon SES, Resend or similar). Mailpit catches everything for now.
- Off-site backups and uptime monitoring.
