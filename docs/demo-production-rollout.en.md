# Demo and production rollout (checklist)

This is the hand-done work that turns on the two stacks:

- **Demo** (`demo.omnivosoft.com`): every push to `dev` lands here, with its own database.
- **Production** (`app.omnivosoft.com`): only a merge into `main` lands here. Users see it.

The code for this is on the `staging-deploy` branch (written on 25 Nov 2026). How the two stacks
work, and how to run them day to day, is in [vps-deploy.en.md](vps-deploy.en.md). This page is
only the one-time setup, in order. Tick each step before you go to the next one: a later step
needs the earlier ones.

## Where things stand (27 Nov 2026)

| Thing | State |
| --- | --- |
| Code (workflow, compose, scripts, docs) | Done, on the `staging-deploy` branch, with `dev` merged into it on 27 Nov 2026 (the marketing website is in). Not on `dev` or `main` yet |
| Marketing website | Production serves it on `omnivosoft.com` (and `www`), the demo on `demo-site.omnivosoft.com`. Both are in the same `web` image, built with that stack's app address (`PUBLIC_APP_URL`) |
| `app.omnivosoft.com` | Still the old stack (Compose project `omnivo-staging`), running an older build of `dev`. It holds **test data only**: no users and no testers to keep |
| Demo stack, demo tunnel, GitHub settings | Not made yet |
| SSH to the VPS | The server answers again (27 Nov 2026). A new computer still needs its key added (step 0.4) |

Pushing `staging-deploy` changes nothing on the server. CI runs only on pushes to `dev` and `main`
(and on pull requests), so this branch never deploys.

## Words used below

- `<IP>`: the VPS's IP address. `<PORT>`: its SSH port (not 22). Both are in the VPS access sheet.
  This repository is public, so they are not written here.
- `$` lines run on your own computer. `server$` lines run on the VPS as your own login
  (`guest_abir`). `deploy$` lines run on the VPS as the `deploy` user (`sudo -iu deploy`).
- On Windows, run every `$` command in **Git Bash** or **WSL**, not in PowerShell or cmd. They use
  bash features (`<<<`, `$(...)`).

---

# Part 0: Get the computer ready

Do this on the computer you will work from (for example the home PC).

## Step 0.1: Tools

You need `git`, `ssh` (with `ssh-keygen` and `ssh-keyscan`) and the GitHub CLI `gh`.

```bash
$ git --version
$ ssh -V
$ gh --version
```

Install what is missing. On Windows: Git for Windows (gives Git Bash and ssh), and
`winget install --id GitHub.cli`.

## Step 0.2: GitHub login with admin rights

Setting secrets and environments needs an account with **admin** rights on the repository (the
owner's account).

```bash
$ gh auth login            # GitHub.com, HTTPS, log in with a browser
$ gh auth status           # must show the owner's account
```

## Step 0.3: The code

```bash
$ git clone https://github.com/AlEkramHossainAbir/Omnivo.git    # skip if you already have it
$ cd Omnivo
$ git fetch origin
$ git switch staging-deploy
$ git pull
$ git log --oneline -3      # the top commit is "Split demo and production deploys"
```

Run every `$` command below from this folder.

## Step 0.4: SSH access to the VPS from this computer

The Mac that set up the server has a key for it (`Host myvps` in `~/.ssh/config`). A new computer
needs its own key, added to your login on the VPS.

1. Make a key on this computer:

   ```bash
   $ ssh-keygen -t ed25519 -C home-pc -f ~/.ssh/omnivo_vps
   $ cat ~/.ssh/omnivo_vps.pub
   ```

2. Get the printed line (it starts with `ssh-ed25519`) onto the VPS, in
   `/home/guest_abir/.ssh/authorized_keys`. Any one of these works:
   - From the Mac that already has access:
     `ssh myvps 'cat >> ~/.ssh/authorized_keys' <<< '<the line>'`
   - Ask the VPS owner to add it.
3. Add this entry to `~/.ssh/config` on this computer:

   ```text
   Host myvps
     HostName <IP>
     Port <PORT>
     User guest_abir
     IdentityFile ~/.ssh/omnivo_vps
     IdentitiesOnly yes
   ```

4. Check:

   ```bash
   $ ssh myvps 'echo ok'
   ```

If it times out, the home IP of the VPS has probably changed. Ask the VPS owner for the new IP and
change `HostName`.

---

# Part 1: Before pushing to `dev`

## Step 1: Check the server has room

```bash
$ ssh myvps 'free -h; df -h /; sudo docker stats --no-stream'
```

- `df` should show at least **8 GB free**. The demo adds its own volumes and its own web image.
- `free` should show the 2 GB swap.

Then check that `docker compose` still works with a docker config folder of its own. The deploy
uses one, so that a demo deploy and a production deploy never share a registry login:

```bash
$ ssh myvps 'sudo -iu deploy bash -c "DOCKER_CONFIG=\$(mktemp -d) docker compose version"'
```

It must print `Docker Compose version v…`. If it says `compose` is not a docker command, stop here:
the deploy would fail the same way.

## Step 2: The demo's folder and `.env`

1. Send the settings template to the server:

   ```bash
   $ scp infra/staging/.env.example myvps:/tmp/omnivo-demo.env
   ```

2. Make the folder and put the file in it, owned by `deploy`:

   ```bash
   $ ssh myvps
   server$ sudo install -d -o deploy -g deploy -m 750 /srv/omnivo-demo
   server$ sudo install -o deploy -g deploy -m 600 /tmp/omnivo-demo.env /srv/omnivo-demo/.env
   server$ rm /tmp/omnivo-demo.env
   server$ sudo -iu deploy
   deploy$ cd /srv/omnivo-demo
   ```

3. Fill every secret with a new random value. The demo shares no password with production:

   ```bash
   deploy$ for k in POSTGRES_PASSWORD MIGRATOR_DB_PASSWORD APP_DB_PASSWORD WORKER_DB_PASSWORD \
             BETTER_AUTH_SECRET JWT_SECRET MINIO_ROOT_PASSWORD S3_APP_SECRET; do
             sed -i "s/^$k=\$/$k=$(openssl rand -hex 32)/" .env
           done
   deploy$ sed -i "s/^MAIL_UI_PASSWORD=\$/MAIL_UI_PASSWORD=$(openssl rand -hex 8)/" .env
   ```

   The pattern `^$k=$` matches only an empty line, so running the loop again never replaces a
   secret that is already in use.

4. Open `nano .env` and make these lines exactly so:

   ```text
   DEPLOY_TARGET=demo
   COMPOSE_PROJECT_NAME=omnivo-demo
   APP_HOST=demo.omnivosoft.com
   API_HOST=demo-api.omnivosoft.com
   FILES_HOST=demo-files.omnivosoft.com
   MAIL_HOST=demo-mail.omnivosoft.com
   SHOP_HOST=demo-shop.omnivosoft.com
   SITE_HOST=demo-site.omnivosoft.com
   MAIL_FROM_NAME="Omnivo Demo"
   MAIL_FROM_DOMAIN=omnivosoft.com
   VALKEY_MAXMEMORY=128mb
   REGISTRY=ghcr.io/alekramhossainabir
   MAIL_UI_USER=tester
   ```

   - Keep the quotes around `Omnivo Demo`. `deploy.sh` reads this file with bash, and a space
     without quotes stops it.
   - `REGISTRY` must be the same as production's. Check with `grep ^REGISTRY /srv/omnivo/.env`.
   - Leave `CLOUDFLARE_TUNNEL_TOKEN=` empty (step 3 fills it) and `IMAGE_TAG=` empty (`deploy.sh`
     writes it).

   Save with Ctrl+O, Enter, and leave with Ctrl+X.

## Step 3: The demo's Cloudflare Tunnel and its six addresses

Still as `deploy`, in `/srv/omnivo-demo`:

```bash
deploy$ cf() { docker run --rm --user "$(id -u):$(id -g)" -e HOME=/cf -v /home/deploy/.cloudflared:/cf/.cloudflared cloudflare/cloudflared:2026.10.6 "$@"; }
deploy$ cf tunnel login
```

It prints a link. Open it in a browser **within 10 minutes**, pick `omnivosoft.com` and click
**Authorize**. Then:

```bash
deploy$ cf tunnel create omnivo-demo
deploy$ for h in demo demo-api demo-files demo-mail demo-shop demo-site; do cf tunnel route dns omnivo-demo "$h.omnivosoft.com"; done
deploy$ sed -i "s|^CLOUDFLARE_TUNNEL_TOKEN=.*|CLOUDFLARE_TUNNEL_TOKEN=$(cf tunnel token omnivo-demo)|" .env
deploy$ rm /home/deploy/.cloudflared/cert.pem
```

- `route dns` makes one proxied `CNAME` per name, pointing at the new tunnel.
- The `sed` uses `|` as its separator, because the token can contain `/`.
- `cert.pem` is the login. It can change every DNS record of the domain, so it is deleted again.

Check in the Cloudflare dashboard:

- `omnivosoft.com` → **DNS**: six proxied `CNAME`s (`demo`, `demo-api`, `demo-files`, `demo-mail`,
  `demo-shop`, `demo-site`).
- **Zero Trust → Networks → Tunnels**: `omnivo-demo` is listed. "Inactive" is fine until the first
  deploy starts its cloudflared.

## Step 4: Check the demo's `.env` and keep a copy

```bash
deploy$ grep -E '^[A-Z_]+=$' .env     # must print only IMAGE_TAG=
deploy$ grep -E '^(DEPLOY_TARGET|COMPOSE_PROJECT_NAME|APP_HOST|CLOUDFLARE_TUNNEL_TOKEN)=' .env
deploy$ cat .env
```

Copy the whole output of `cat .env` into your password manager as "Omnivo demo .env". The secrets
are nowhere else.

## Step 5: A new deploy key for GitHub Actions

The old deploy key lived only in the `staging` environment's secrets, and GitHub never shows a
secret again. So GitHub gets a new key. This key is for the `deploy` user (the one that runs the
stacks), not for your own login.

```bash
$ ssh-keygen -t ed25519 -N '' -C omnivo-deploy -f ./omnivo-deploy
$ ssh myvps 'sudo tee -a /home/deploy/.ssh/authorized_keys >/dev/null' < omnivo-deploy.pub
$ ssh -i ./omnivo-deploy -p <PORT> -o IdentitiesOnly=yes deploy@<IP> 'docker ps --format "{{.Names}}" | head -3'
```

The last command must print container names. That proves GitHub will get in with this key. Keep
the two files until step 6 is done.

## Step 6: GitHub secrets, variables and environments

From the repository folder:

```bash
# Secrets. Both stacks are on one server, so they are repository secrets.
$ gh secret set VPS_SSH_KEY < ./omnivo-deploy
$ gh secret set VPS_SSH_HOST --body <IP>
$ gh secret set VPS_SSH_PORT --body <PORT>
$ gh secret set VPS_SSH_USER --body deploy
$ ssh-keyscan -p <PORT> -t ed25519,ecdsa,rsa <IP> 2>/dev/null | gh secret set VPS_KNOWN_HOSTS

# Variables. Each API address is built into its app.
$ gh variable set DEMO_API_URL --body https://demo-api.omnivosoft.com
$ gh variable set DEMO_APP_URL --body https://demo.omnivosoft.com
$ gh variable set PRODUCTION_API_URL --body https://api.omnivosoft.com
$ gh variable set PRODUCTION_APP_URL --body https://app.omnivosoft.com

# Environments. Only main may deploy to production.
$ gh api -X PUT repos/{owner}/{repo}/environments/demo
$ gh api -X PUT repos/{owner}/{repo}/environments/production \
    --input - <<<'{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
$ gh api -X POST repos/{owner}/{repo}/environments/production/deployment-branch-policies -f name=main -f type=branch
```

`{owner}` and `{repo}` are typed as they are: `gh` fills them in from the folder's repository.

Check:

```bash
$ gh secret list      # VPS_KNOWN_HOSTS, VPS_SSH_HOST, VPS_SSH_KEY, VPS_SSH_PORT, VPS_SSH_USER
$ gh variable list    # DEMO_API_URL, DEMO_APP_URL, PRODUCTION_API_URL, PRODUCTION_APP_URL (STAGING_* too, for now)
$ gh api repos/{owner}/{repo}/environments --jq '.environments[].name'   # demo, production, staging
```

Then delete the key files. Only GitHub keeps the private half now:

```bash
$ rm ./omnivo-deploy ./omnivo-deploy.pub
```

## Step 7: Bring the code to `dev` and push

```bash
$ git switch dev
$ git pull
$ git merge staging-deploy        # a fast-forward if dev has not moved since 25 Nov 2026
$ git push origin dev
```

If `dev` has new commits, the merge makes a merge commit. That is fine. If it shows a conflict,
stop and ask: the conflicting file decides how to fix it.

GitHub → **Actions** → the CI run of this push: `gate` runs first, then `deploy-demo`. This push
does **not** change `app.omnivosoft.com`: the old build keeps running there.

## Step 8: Check the demo

When `deploy-demo` is green:

1. `https://demo-api.omnivosoft.com/health` answers `{"status":"ok"}`.
2. Sign up on `https://demo.omnivosoft.com` and make a workspace.
3. The welcome email is in `https://demo-mail.omnivosoft.com` (user `tester`; the password:
   `ssh myvps 'sudo grep MAIL_UI_PASSWORD /srv/omnivo-demo/.env'`).
4. Upload a logo in the workspace settings. It goes through `demo-files`.
5. `https://demo-shop.omnivosoft.com` opens.
6. `https://demo-site.omnivosoft.com` opens, and its "Start free trial" goes to `demo.omnivosoft.com`.
7. Memory with both stacks running: `ssh myvps 'free -h'`.

If the deploy fails, open the red step in the Actions log. Common causes:

| Error says | Fix |
| --- | --- |
| `Set the repository variable DEMO_API_URL first` | Step 6, the variables |
| `Permission denied (publickey)` or `Host key verification failed` | Step 5 or the `VPS_*` secrets in step 6 |
| `/srv/omnivo-demo/.env is missing on the server` | Step 2 |
| `required variable … is missing a value` | That line in the demo's `.env` (step 2.4) |
| The check at the end (`curl`) fails | The tunnel or its DNS records (step 3), or `CLOUDFLARE_TUNNEL_TOKEN` |

---

# Part 2: Before merging into `main`

## Step 9: Production starts empty

The old stack holds test data only, so production starts with an empty database. That data is
not lost: on 27 Nov 2026 its database and its files were copied into the demo (a fresh
`backup.sh` dump loaded into `/srv/omnivo-demo`, and the storage bucket copied across with
`mc mirror`), so the old logins work on `demo.omnivosoft.com`. Do this **just before** step 10. From here until the production deploy ends, `app.omnivosoft.com` does not answer.

```bash
$ ssh myvps
server$ sudo -iu deploy
deploy$ cd /srv/omnivo
deploy$ ./backup.sh                                  # one last copy of the test data
deploy$ cp .env backups/.env.before-split
deploy$ docker compose down -v --remove-orphans      # deletes the old stack's containers and every volume
deploy$ docker volume ls | grep omnivo-staging       # must print nothing
```

This folder still has the old `compose.yml` (`name: omnivo-staging`), because no production deploy
has copied the new files yet. So `down -v` removes exactly the old stack. The demo is a different
project and is not touched.

Then tell the folder it is production, and give Mailpit a new password (the testers had the old
one):

```bash
deploy$ cat >>.env <<'EOF'
DEPLOY_TARGET=production
COMPOSE_PROJECT_NAME=omnivo-production
MAIL_FROM_NAME=Omnivo
EOF
deploy$ sed -i "s/^MAIL_UI_PASSWORD=.*/MAIL_UI_PASSWORD=$(openssl rand -hex 8)/" .env
deploy$ grep -E '^(DEPLOY_TARGET|COMPOSE_PROJECT_NAME)=' .env
deploy$ grep -q '^SITE_HOST=' .env || echo 'SITE_HOST=omnivosoft.com' >>.env
deploy$ grep ^SITE_HOST= .env                         # must print SITE_HOST=omnivosoft.com
deploy$ cat .env
```

`SITE_HOST` is the marketing website's host. The old stack may already have it (the website went
live on it before the split); the `grep -q` adds it only when it is missing. Without it,
`compose.yml` refuses to start. The `@` and `www` DNS records already point at the `omnivo`
tunnel, so nothing changes in Cloudflare.

Update "Omnivo production .env" in your password manager with the output of `cat .env`. The
database passwords stay the same: the new database's roles are made from them on its first start.

## Step 10: Merge `dev` into `main`

```bash
$ gh pr create --base main --head dev --title "Split demo and production" --fill
```

Or open the pull request on GitHub. When its checks pass, merge it. GitHub → **Actions** → the CI
run on `main`: `gate`, then `deploy-production`. The first deploy runs every migration on the empty
database, so it takes a little longer.

## Step 11: Check production

1. `https://api.omnivosoft.com/health` answers `{"status":"ok"}`.
2. Sign up on `https://app.omnivosoft.com`. This is the first real workspace.
3. The welcome email is in `https://mail.omnivosoft.com`, with the new password.
4. GitHub → **Settings → Environments → production** lists the deploy.
5. The nightly backup still works on the new stack:

   ```bash
   $ ssh myvps 'sudo -iu deploy /srv/omnivo/backup.sh'
   ```

---

# Part 3: Clean up

## Step 12: Remove what the old setup left

1. GitHub → **Settings → Environments** → delete **`staging`**. Its old `STAGING_SSH_*` secrets go
   with it.
2. The old variables:

   ```bash
   $ gh variable delete STAGING_API_URL
   $ gh variable delete STAGING_APP_URL
   ```

3. The old deploy key. In `/home/deploy/.ssh/authorized_keys`, delete the line that does **not**
   end with `omnivo-deploy`:

   ```bash
   $ ssh myvps 'sudo cat /home/deploy/.ssh/authorized_keys'
   $ ssh -t myvps 'sudo nano /home/deploy/.ssh/authorized_keys'
   ```

   Your own login keys are in `/home/guest_abir/.ssh/authorized_keys`, a different file, so this
   never locks you out.

4. Delete the `staging-deploy` branch when everything works (`git push origin --delete
   staging-deploy`), or keep it for later setup work.

---

# From now on

- **Daily work:** push to `dev`. Only the demo changes.
- **Release to users:** open a pull request from `dev` to `main` and merge it. Production changes,
  and users get the new version when they reload.
- **Clean the database:** always the demo, never production:
  `ssh myvps`, `sudo -iu deploy`, `cd /srv/omnivo-demo`, `./reset-demo.sh`. The script refuses to
  run anywhere else.

# Notes for Claude (another account or computer)

Read `CLAUDE.md` first, especially "Environments and deploys" and the working agreement. In short:

- Do not commit or push unless the user asks for it in that conversation. A push to `dev` deploys
  the demo, and a push to `main` deploys production.
- "Clean the DB" means the demo (`reset-demo.sh`). Never run `down -v`, `reset-demo.sh` or a
  restore on `/srv/omnivo` (production) unless the user asks for exactly that, and take a backup
  first.
- This repository is public: never write the VPS's IP, SSH port or user names into a file in it.
- Some steps need the user's own hands: the Cloudflare **Authorize** click (step 3) and, in some
  tool modes, `gh secret set` (step 6).
