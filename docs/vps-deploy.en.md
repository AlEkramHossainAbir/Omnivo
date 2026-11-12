# Omnivo on the home VPS

This is how the demo (staging) copy of Omnivo runs on the VPS at `192.140.255.22`. It uses the
files in [`infra/staging/`](../infra/staging/), which are explained line by line in
[staging-deploy.en.md](staging-deploy.en.md). This page says what is different on this server and
how to run it day to day.

## The addresses

| Address | What it is |
| --- | --- |
| `https://app.omnivosoft.com` | The ERP app |
| `https://api.omnivosoft.com` | The API (`/health` answers `{"status":"ok"}`) |
| `https://files.omnivosoft.com` | File storage (MinIO). The browser uploads and downloads here with signed links |
| `https://mail.omnivosoft.com` | Mailpit: every email the server sends lands here. User `tester`, password below |

`omnivosoft.com` itself is not used yet. It stays free for the marketing website.

The names are one level below the domain (`app.omnivosoft.com`, not `app.demo.omnivosoft.com`).
Cloudflare's free HTTPS certificate covers only one level, so a deeper name would show a
certificate error.

## How a request reaches the server

```text
browser ──HTTPS──> Cloudflare ──tunnel──> cloudflared ──HTTP──> Caddy ──> app files / api / storage / mail
                                          (container)         (web)
```

The VPS runs on a home connection. Only SSH (port 2222) is open from outside, and the IP address can
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
| Login | `ssh myvps` (the entry in `~/.ssh/config` on the Mac: port 2222, user `guest_abir`) |
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
| Environment `staging`, secret | `STAGING_SSH_HOST` | `192.140.255.22` |
| Environment `staging`, secret | `STAGING_SSH_PORT` | `2222` |
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
ssh-keyscan -p 2222 -t ed25519,ecdsa,rsa <new IP> 2>/dev/null | gh secret set STAGING_KNOWN_HOSTS --env staging
# 2. Your Mac: change HostName in the "Host myvps" entry of ~/.ssh/config
```

Then re-run the failed deploy in **Actions**.

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
scp -P 2222 'guest_abir@192.140.255.22:/srv/omnivo/backups/*.dump' ~/omnivo-backups/
```

(If `scp` says "Permission denied", the files belong to `deploy`; run
`ssh myvps 'sudo chmod o+r /srv/omnivo/backups/*.dump'` first, or copy them through `sudo`.)

Uploaded files (logos) live in the `storage-data` Docker volume and are not in the dump. On a demo
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

- The online shop (`apps/shop`). It needs its own image and Caddy site, and it still uses mock data.
- Real email (Amazon SES, Resend or similar). Mailpit catches everything for now.
- Off-site backups and uptime monitoring.
