# Omnivo on the home VPS

The home VPS runs **two separate copies** of Omnivo:

- **Production** (`app.omnivosoft.com`): what the users use. It changes only when a pull request
  is merged into `main`.
- **Demo** (`demo.omnivosoft.com`): the staging copy. Every push to `dev` lands here, so the team
  can check a change before the users get it.

Each copy is its own Docker Compose stack with its **own database**, job queue, file storage,
Mailpit and Cloudflare Tunnel. Nothing is shared between them except the machine. Testing on the
demo can never change a user's data.

Both stacks use the files in [`infra/staging/`](../infra/staging/) (the folder kept its old
name), which are explained line by line in [staging-deploy.en.md](staging-deploy.en.md). This page
says what is different on this server and how to run it day to day. All the addresses are listed
in [domains.en.md](domains.en.md).

This repository is public, so the server's IP address, SSH port and user names are not written
here. They are in the VPS access sheet and in the `myvps` entry of `~/.ssh/config` on your Mac.

## The addresses

| Production (from `main`) | Demo (from `dev`) | What it is |
| --- | --- | --- |
| `https://app.omnivosoft.com` | `https://demo.omnivosoft.com` | The ERP app |
| `https://api.omnivosoft.com` | `https://demo-api.omnivosoft.com` | The API (`/health` answers `{"status":"ok"}`) |
| `https://files.omnivosoft.com` | `https://demo-files.omnivosoft.com` | File storage (MinIO). The browser uploads and downloads here with signed links. Only the shop's photos (`/omnivo/storefront/…`) are public |
| `https://mail.omnivosoft.com` | `https://demo-mail.omnivosoft.com` | Mailpit: every email that stack sends lands here. User `tester`, each stack has its own password |
| `https://shop.omnivosoft.com` | `https://demo-shop.omnivosoft.com` | The online shop as a demo (the `shop` service). It shows the mock shop, so nothing in it is real, and a deploy forgets its orders |

`omnivosoft.com` itself is not used yet. It stays free for the marketing website.

The names are one level below the domain (`demo-api.omnivosoft.com`, not
`api.demo.omnivosoft.com`). Cloudflare's free HTTPS certificate covers only one level, so a deeper
name would show a certificate error.

## How the code moves

```text
feature work ──push──> dev ──CI passes──> demo.omnivosoft.com   (demo database)
                        │
                        └──pull request dev → main, merged──> main ──CI passes──> app.omnivosoft.com   (production database)
```

1. Push to `dev`. CI runs the checks, then deploys the demo. Check the change on
   `demo.omnivosoft.com`.
2. When the demo looks right, open a pull request from `dev` to `main` and merge it. CI runs the
   checks again on `main`, then deploys production.
3. A user with Omnivo open sees the update notice ("A new version of Omnivo is ready…") and gets
   the new version on reload. The app never reloads by itself.

A push to `dev` never touches production. A pull request never deploys anything.

**Migrations run on production when `main` is deployed.** A migration that worked on the demo
database runs again, on real data, at that moment. Keep every migration safe for the old code too
(the old API keeps running while it runs).

## How a request reaches the server

```text
browser ──HTTPS──> Cloudflare ──tunnel "omnivo"──────> cloudflared ──> Caddy ──> production's app / api / storage / mail
                              └─tunnel "omnivo-demo"─> cloudflared ──> Caddy ──> demo's app / api / storage / mail
                                                       (each stack has its own two containers)
```

The VPS runs on a home connection. Only SSH is open from outside, and the IP address can
change. So the server opens no web port at all:

- **cloudflared** (the `tunnel` service in `compose.yml`) opens an outgoing connection to
  Cloudflare and keeps it open. Cloudflare sends each visitor's request down this connection. When
  the home IP changes, cloudflared simply connects again, and the site keeps working. Each stack
  runs its own cloudflared with its own tunnel, so each tunnel's requests can only reach its own
  stack.
- **HTTPS ends at Cloudflare.** Caddy only gets plain HTTP from cloudflared, inside Docker's own
  network, so the Caddyfile has `auto_https off` and no Let's Encrypt.
- **The visitor's IP:** Cloudflare puts it in the `CF-Connecting-IP` header. Caddy reads it from
  there and writes it into `X-Forwarded-For` for the API, so the audit log shows the person's real
  address.

The tunnels are called `omnivo` (production) and `omnivo-demo` in Cloudflare (**Zero Trust →
Networks → Tunnels**). Their DNS records are `CNAME`s to the tunnel, made by
`cloudflared tunnel route dns` or by hand. Do not point a demo name at the production tunnel, or
the other way round.

## The server

| | |
| --- | --- |
| Login | `ssh myvps` (the entry in `~/.ssh/config` on the Mac) |
| Machine | 2 vCPU, 3 GB RAM, 30 GB disk, x86-64, Ubuntu 24.04 |
| Swap | 2 GB, in `/swapfile` |
| Docker | Docker Engine and the Compose plugin, from Docker's own apt repository |
| App user | `deploy` (in the `docker` group) |
| Production stack | `/srv/omnivo`, Compose project `omnivo-production` |
| Demo stack | `/srv/omnivo-demo`, Compose project `omnivo-demo` |
| Settings and secrets | `.env` in each folder, mode `600`, made on the server with `openssl rand`. The two have different secrets |

Docker names a stack's volumes after its project (`omnivo-production_db-data` holds production's
database). The name is set in `.env` (`COMPOSE_PROJECT_NAME`); `compose.yml` refuses to start
without it, so a stack never falls back to the folder's name and never picks up the other stack's
containers. Never change it on a running stack: a new name starts an empty database next to the
old one.

The VPS owner says: the host may reboot around 22:00 UTC for updates, and there are **no
backups** of the VM. Every container has `restart: unless-stopped`, and Docker starts at boot, so
both stacks come back by themselves after a reboot.

To run a command as the app user:

```bash
ssh myvps
sudo -iu deploy
cd /srv/omnivo          # production
# cd /srv/omnivo-demo   # demo
docker compose ps
```

`docker compose` always acts on the stack of the folder you are in. Check the folder before a
`down`, a `restore.sh` or anything else that changes data.

## Deploys

When CI's checks pass, GitHub Actions ([`deploy.yml`](../.github/workflows/deploy.yml)) builds four
images (`api`, `migrate`, `web`, `shop`), pushes them to GHCR, logs in to the server as `deploy`
over SSH, copies the stack files into that target's folder and runs
`./deploy.sh <commit> <target>`. Nothing has to be done by hand.

- `api`, `migrate` and `shop` are tagged with the commit and are the same for both targets.
- `web` has the API's address built into its JavaScript, so it is tagged `<commit>-demo` or
  `<commit>-production`.
- `deploy.sh` refuses a build whose target is not the folder's `DEPLOY_TARGET`.
- A production deploy refuses a commit that is not on `main`, also from the **Run workflow**
  button.

GitHub settings it uses:

| Where | Name | Value |
| --- | --- | --- |
| Repository secret | `VPS_SSH_HOST` | The VPS's IP address |
| Repository secret | `VPS_SSH_PORT` | The VPS's SSH port (not 22) |
| Repository secret | `VPS_SSH_USER` | `deploy` |
| Repository secret | `VPS_SSH_KEY` | The private half of the deploy key. Only GitHub has it |
| Repository secret | `VPS_KNOWN_HOSTS` | The server's SSH fingerprints |
| Repository variable | `DEMO_API_URL` | `https://demo-api.omnivosoft.com` (built into the demo app) |
| Repository variable | `DEMO_APP_URL` | `https://demo.omnivosoft.com` |
| Repository variable | `PRODUCTION_API_URL` | `https://api.omnivosoft.com` (built into the production app) |
| Repository variable | `PRODUCTION_APP_URL` | `https://app.omnivosoft.com` |
| Environments | `demo`, `production` | The deploy history of each. `production` allows only the `main` branch |

The secrets are **repository** secrets, because both stacks are on the same server. The variables
must be **repository** variables too: the build job has no environment, so it cannot see
environment variables, and the app would be built without the API's address.

To deploy an older build again, run on the server, in that stack's folder:
`./deploy.sh <full commit hash>`. Every deploy is listed in `deploys.log` in the folder. Or use
**Actions → Deploy → Run workflow**, pick the target and type the commit.

## Setting up the two stacks (once, 25 Nov 2026)

The full checklist, with checks after each step and the setup of a new computer, is
[demo-production-rollout.en.md](demo-production-rollout.en.md). This section is the short form.

Until 25 Nov 2026, every push to `dev` went to `app.omnivosoft.com`, and it held only test data
(no users, no testers kept). So production starts **empty**: the old stack (Compose project
`omnivo-staging`) and all its data are deleted, and the first deploy from `main` makes a new,
empty database. Do the steps in this order: a deploy fails, but changes nothing, when a step
before it is missing.

### 1. Production starts empty

Do this just before step 5.2 (the merge into `main`). From here until the production deploy ends,
`app.omnivosoft.com` does not answer.

```bash
ssh myvps
sudo -iu deploy
cd /srv/omnivo
./backup.sh                              # one last copy of the test data, just in case
cp .env backups/.env.before-split
docker compose down -v --remove-orphans  # deletes the old stack's containers and every volume
# The old .env has no COMPOSE_PROJECT_NAME yet, so the down above still used the old name
# (omnivo-staging, from the old compose.yml still in this folder). Check that nothing is left:
docker volume ls | grep omnivo-staging   # must print nothing
cat >>.env <<'EOF'
DEPLOY_TARGET=production
COMPOSE_PROJECT_NAME=omnivo-production
MAIL_FROM_NAME=Omnivo
EOF
sed -i "s/^MAIL_UI_PASSWORD=.*/MAIL_UI_PASSWORD=$(openssl rand -hex 8)/" .env   # testers had the old one
```

The database passwords may stay: the new database's roles are made from `.env` on its first
start. Production's backup cron keeps working (same folder).

### 2. The demo's tunnel and addresses

```bash
ssh myvps
sudo -iu deploy
cf() { docker run --rm --user "$(id -u):$(id -g)" -e HOME=/cf -v /home/deploy/.cloudflared:/cf/.cloudflared cloudflare/cloudflared:2026.10.6 "$@"; }
cf tunnel login            # prints a link: open it, pick omnivosoft.com, click Authorize (10 minutes)
cf tunnel create omnivo-demo
for h in demo demo-api demo-files demo-mail demo-shop; do cf tunnel route dns omnivo-demo "$h.omnivosoft.com"; done
cf tunnel token omnivo-demo   # the demo's CLOUDFLARE_TUNNEL_TOKEN, for step 3
rm /home/deploy/.cloudflared/cert.pem   # delete the login again
```

### 3. The demo's folder and `.env`

```bash
sudo install -d -o deploy -g deploy -m 750 /srv/omnivo-demo
sudo -iu deploy
cd /srv/omnivo-demo
# .env.example comes from the repo: copy infra/staging/.env.example here first (scp from the Mac)
cp .env.example .env && chmod 600 .env
for k in POSTGRES_PASSWORD MIGRATOR_DB_PASSWORD APP_DB_PASSWORD WORKER_DB_PASSWORD \
  BETTER_AUTH_SECRET JWT_SECRET MINIO_ROOT_PASSWORD S3_APP_SECRET; do
  sed -i "s/^$k=\$/$k=$(openssl rand -hex 32)/" .env
done
sed -i "s/^MAIL_UI_PASSWORD=\$/MAIL_UI_PASSWORD=$(openssl rand -hex 8)/" .env
nano .env
```

In `nano`, set the host names to `demo`, `demo-api`, `demo-files`, `demo-mail` and `demo-shop`
`.omnivosoft.com`, `MAIL_FROM_DOMAIN=omnivosoft.com`, `REGISTRY` (the same as production's),
and `CLOUDFLARE_TUNNEL_TOKEN` (from step 2). Keep `DEPLOY_TARGET=demo` and
`COMPOSE_PROJECT_NAME=omnivo-demo`. Then check that only `IMAGE_TAG` is empty:

```bash
grep -E '^[A-Z_]+=$' .env      # must print only IMAGE_TAG=
```

Every secret is new: the demo shares no password with production. Keep a copy of this `.env` in
the password manager too.

### 4. GitHub

A new deploy key (the old one was only in the `staging` environment, whose secrets cannot be read
back):

```bash
ssh-keygen -t ed25519 -N '' -C omnivo-deploy -f ./omnivo-deploy
ssh myvps 'sudo tee -a /home/deploy/.ssh/authorized_keys' < omnivo-deploy.pub
gh secret set VPS_SSH_KEY < omnivo-deploy
gh secret set VPS_SSH_HOST --body <the VPS IP>
gh secret set VPS_SSH_PORT --body <the SSH port>
gh secret set VPS_SSH_USER --body deploy
ssh-keyscan -p <the SSH port> -t ed25519,ecdsa,rsa <the VPS IP> 2>/dev/null | gh secret set VPS_KNOWN_HOSTS
rm omnivo-deploy omnivo-deploy.pub

gh variable set DEMO_API_URL --body https://demo-api.omnivosoft.com
gh variable set DEMO_APP_URL --body https://demo.omnivosoft.com
gh variable set PRODUCTION_API_URL --body https://api.omnivosoft.com
gh variable set PRODUCTION_APP_URL --body https://app.omnivosoft.com

gh api -X PUT repos/{owner}/{repo}/environments/demo
gh api -X PUT repos/{owner}/{repo}/environments/production \
  --input - <<<'{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
gh api -X POST repos/{owner}/{repo}/environments/production/deployment-branch-policies -f name=main -f type=branch
```

### 5. Push to `dev`, then merge into `main`

Production's database is empty, so its first deploy runs every migration of `main` from the start.

1. Push the split to `dev`. CI deploys the demo. Check `https://demo-api.omnivosoft.com/health`,
   sign up on `https://demo.omnivosoft.com` and find the welcome email on
   `https://demo-mail.omnivosoft.com`.
2. Do step 1 (production starts empty). Then open a pull request from `dev` to `main` and merge
   it. CI deploys production. Check `https://api.omnivosoft.com/health`, and sign up on
   `https://app.omnivosoft.com` as the first real workspace.

### 6. Clean up

When both deploys worked: delete the `staging` environment (**Settings → Environments**), the
repository variables `STAGING_API_URL` and `STAGING_APP_URL`, and the old deploy key's line in
`/home/deploy/.ssh/authorized_keys` (the one that is not `omnivo-deploy`).

## When the home IP changes

The websites keep working (the tunnels do not care about the IP). Only SSH, and so the
automatic deploys, stop working, because they use the old IP. Ask the VPS owner for the new IP,
then:

```bash
# 1. GitHub Actions
gh secret set VPS_SSH_HOST --body <new IP>
ssh-keyscan -p <SSH port> -t ed25519,ecdsa,rsa <new IP> 2>/dev/null | gh secret set VPS_KNOWN_HOSTS
# 2. Your Mac: change HostName in the "Host myvps" entry of ~/.ssh/config
```

Then re-run the failed deploy in **Actions**.

## A new address on a tunnel

The tunnels were made from the server with `cloudflared` commands, so their routes are managed
there, not in the Cloudflare dashboard. The Cloudflare login that allows this is deleted after each
use, because it can change every DNS record of the domain. To add an address:

```bash
ssh myvps
sudo -iu deploy
cf() { docker run --rm --user "$(id -u):$(id -g)" -e HOME=/cf -v /home/deploy/.cloudflared:/cf/.cloudflared cloudflare/cloudflared:2026.10.6 "$@"; }
cf tunnel login            # prints a link: open it, pick omnivosoft.com, click Authorize
cf tunnel route dns omnivo new.omnivosoft.com             # production
cf tunnel route dns omnivo-demo demo-new.omnivosoft.com   # demo
rm /home/deploy/.cloudflared/cert.pem   # delete the login again
```

Then add the site to the Caddyfile. The link works for about 10 minutes.

There is a shorter way that needs no login on the server. `route dns` only makes one DNS record,
so you can make the same record by hand: in the Cloudflare dashboard → `omnivosoft.com` → **DNS**
→ **Add record**, type `CNAME`, the name, target `<tunnel id>.cfargotunnel.com`, **Proxied** on.
Each tunnel's id is the name of its `.json` file in `/home/deploy/.cloudflared/` on the server
(`cf tunnel list` shows which is which). The tunnel sends every name to its stack's Caddy, so
nothing changes in the tunnel itself.

A new site in the Caddyfile that reads a new `.env` name (like `SHOP_HOST`) needs that line in
**both** `.env` files **before** the deploy. `compose.yml` refuses to start without it, and the
demo's deploy comes first.

## Mailpit

No email leaves the server, on either stack. Every email (welcome, invitations, password resets)
lands in that stack's Mailpit. To see a password:

```bash
ssh myvps 'sudo grep MAIL_UI_PASSWORD /srv/omnivo/.env'        # production
ssh myvps 'sudo grep MAIL_UI_PASSWORD /srv/omnivo-demo/.env'   # demo
```

To invite a customer on production: create the invitation in the app, open the email in
production's Mailpit, copy the link and send it to the customer yourself.

## Backups

`backup.sh` saves a copy of its own stack's database in `backups/` of that folder and keeps 7 days.
Production's runs every night at 03:00 UTC from the `deploy` user's crontab:

```text
0 3 * * * /srv/omnivo/backup.sh >> /srv/omnivo/backups/backup.log 2>&1
```

The demo has no nightly backup: its data is test data. To keep a copy before a risky test, run
`/srv/omnivo-demo/backup.sh` by hand (make `/srv/omnivo-demo/backups` first).

## Cleaning the demo

"Clean the database" always means the **demo**, never production. Production's data belongs to the
users: it is only backed up and, after a mistake, restored.

```bash
ssh myvps
sudo -iu deploy
cd /srv/omnivo-demo
./reset-demo.sh
```

`reset-demo.sh` deletes the demo's database, files, job queue and mail, then starts the same build
on an empty database. It refuses to run unless the folder's `.env` says `DEPLOY_TARGET=demo` and
`COMPOSE_PROJECT_NAME=omnivo-demo`, so it cannot empty production even when run from the wrong
folder. Everyone on the demo has to sign up again afterwards.

These copies are on the same VM, and the VM has no backup. So also copy production's to your Mac
now and then:

```bash
mkdir -p ~/omnivo-backups
scp 'myvps:/srv/omnivo/backups/*.dump' ~/omnivo-backups/
```

Uploaded files (logos, the shop's photos) live in the `storage-data` Docker volume and are not in
the dump. For real customers, plan off-site backups first (see
[home-server-requirements.en.md](home-server-requirements.en.md), Part 3.7).

To restore a dump: `./restore.sh backups/<file>.dump` (as `deploy`, in that stack's folder).

**Keep a copy of both `.env` files in your password manager.** The database passwords and the auth
secrets are only there. If a `.env` is lost, its database cannot be opened and everyone on it is
signed out.

## Memory

3 GB is small for two stacks. One stack used about 1.3 GB after its first deploy, so the two use
most of the RAM, with the 2 GB swap as a safety net. The demo's job queue is capped at 128 MB
(`VALKEY_MAXMEMORY`), production's at 256 MB. Check it now and then:

```bash
ssh myvps 'free -h; sudo docker stats --no-stream'
```

If swap is in use most of the time, ask for more RAM, or stop the demo while nobody tests
(`cd /srv/omnivo-demo && docker compose stop`; the next push to `dev` starts it again). A busy demo
can slow production down, because they share the CPU and the disk. Move production to its own
server before many real customers depend on it.

## Not on this server yet

- **Real email on production.** Production's emails go to Mailpit, so a user never gets an
  invitation or a password reset by themselves. Before real users sign up on their own, add a
  sending service (Amazon SES, Resend or similar) to production only: the demo keeps Mailpit.
- A real shop. Since 26g a workspace can set up and open a shop in the app (Storefront menu), but
  the shop addresses still show the mock shop (`SHOP_SOURCE` is not set). A real shop lives at
  `<subdomain>.<SHOP_BASE_DOMAIN>`, and each stack has one fixed `SHOP_HOST`, so the switch needs a wildcard
  host first: a DNS record and a tunnel route for the shops' names, and a Caddy site for them. Then the `shop`
  service gets `SHOP_SOURCE=api` and `SHOP_API_URL=http://api:3000` (inside Docker's network), and the API gets
  `SHOP_BASE_DOMAIN` (the shops' domain). Until then, the app's "View shop" link points at an address that does
  not answer. `SHOP_PUBLIC_PORT` stays unset here: in production a shop's address has no port.
- A rate limit for the public shop API. `https://api.omnivosoft.com/public/v1/*` answers anyone, with no
  sign-in. Before a real shop opens, add a Cloudflare rate limiting rule for that path (**Security → WAF → Rate
  limiting rules**). The shop's server calls the API inside Docker's network, so the rule never slows the shop.
- Off-site backups and uptime monitoring.
- A production server of its own, apart from the demo.
