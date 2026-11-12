# Home server requirements

This document says what a Linux PC at home needs to run Omnivo for real users without breaking
down. It is written for two readers:

- **The owner**, who buys the parts, talks to the ISP and makes the decisions marked "Owner".
- **The setup agent**, who prepares the server. Part 4 is its step-by-step checklist.

Omnivo runs as a set of Docker containers on one machine. The files for that already exist on
the `staging-deploy` branch (`infra/staging/compose.yml`, `Caddyfile`, `backup.sh`, `deploy.sh`,
`infra/docker/Dockerfile`) and are explained in `docs/staging-deploy.en.md` on that branch. This
document reuses them and says what must change for real users on a home machine.

## 1. The short answer

| Item | Minimum | Recommended | Why |
| --- | --- | --- | --- |
| CPU | 4 cores / 8 threads, x86-64 | 8 cores / 16 threads, x86-64 (Ryzen 7 / Core i7, 2021 or newer) | Node.js uses one core per process. Postgres, PDFs and Excel exports need more cores. |
| RAM | 16 GB | 32 GB (ECC if the board supports it) | Postgres is fast only when the data fits in memory. |
| Disk | 1 × 512 GB NVMe SSD | 2 × 1 TB NVMe SSD as a mirror (RAID 1) | One disk failure must not stop the business. Never a hard disk (HDD) for the database. |
| Backup disk | — | 1 external USB SSD, 1–2 TB | Fast local restore. Off-site copies are needed as well (Part 3.7). |
| Network card | 1 Gbit Ethernet | 1 Gbit Ethernet, wired | Never Wi-Fi for a server. |
| Internet | Fiber, 20 Mbps upload | Fiber, 50+ Mbps upload, plus a second ISP for failover | Users download from the server, so the **upload** speed is the limit. |
| Public IP | Not needed with Cloudflare Tunnel | A static public IP from the ISP | See Part 3.2. Many Bangladeshi ISPs use CGNAT (no real public IP). |
| Power | UPS, 30 minutes | Online UPS, 60+ minutes, that also powers the router and ONU | Load shedding. A power cut in the middle of a database write is the main risk at home. |
| OS | Ubuntu Server 24.04 LTS | Ubuntu Server 24.04 LTS, no desktop | Long support (to 2029, 2034 with Pro), and the staging scripts were written for it. |

**What this machine can carry (estimates, to be confirmed with a load test, Part 3.9):**

| Machine | Users working at the same moment | People using it in a day |
| --- | --- | --- |
| Minimum | about 50 | about 200–300 |
| Recommended | about 200–300 | about 1,000–2,000 |

"Working at the same moment" means people clicking through screens, saving invoices, running
reports. An ERP user sends far fewer requests than a social media user, and the PWA keeps a copy
of the data on each device (step 18), so many reads never reach the server. The busiest work is
reports, PDFs, Excel exports and the first sync of a new device.

Beyond the recommended size, a single home PC is the wrong tool. Move to a data center
(Part 5).

## 2. Honest risks of a home server

The hardware is the easy part. These are what usually break a home server:

1. **Power cuts.** Without a UPS, every cut is a hard crash. Postgres survives a crash, but a
   cheap SSD without power-loss protection can lose recent writes.
2. **The internet line.** If the ISP is down, every customer is down. A home line has no uptime
   promise.
3. **No real public IP (CGNAT).** Then nobody can reach the server from outside unless a tunnel
   is used.
4. **ISP rules.** Some home plans block ports 80 and 443, or forbid servers.
5. **One machine.** A broken motherboard means hours or days down, unless backups can be restored
   on another machine.
6. **Physical access.** Anyone in the house can take the disk. Customers' accounts are on it.

Omnivo keeps working offline on devices (the outbox and the POS), so a short outage is not lost
work: changes wait on the device and sync later. A long outage still stops new devices, reports,
PDFs, emails and the online shop.

**Owner decision:** for a demo, a pilot or a few friendly customers, a home server is fine. For
many paying customers with their financial data, plan the move to a data center (Part 5) before
they arrive.

## 3. Detailed requirements

### 3.1 Hardware

- **CPU:** x86-64 (AMD or Intel). Not ARM: the Docker images are built for amd64, and some native
  packages are tested only there.
- **RAM:** 32 GB recommended. The memory plan for 32 GB:

  | Part | Memory | Note |
  | --- | --- | --- |
  | Postgres | 8 GB shared buffers + up to 4 GB for queries | The rest of the free RAM works as Postgres's file cache, which matters as much |
  | API (2–3 copies) | 1 GB each | Node's heap limit set with `--max-old-space-size=768` |
  | Worker | 1.5 GB | PDFs (pdfkit) and Excel exports are the heaviest jobs |
  | Shop (Astro) | 512 MB | Server-side pages for each tenant's shop |
  | Valkey | 1 GB | BullMQ jobs; `noeviction`, so it must never fill up |
  | MinIO | 1–2 GB | File storage |
  | Caddy | 200 MB | HTTPS and static files |
  | OS + Docker | 2 GB | |
  | Free for file cache | about 10 GB | Postgres and MinIO read faster from it |

  With 16 GB, halve the Postgres numbers and run one API copy.
- **Disks:** NVMe SSD with a DRAM cache and a TBW (write endurance) rating of 600 TB or more per
  TB. Two equal disks in a software mirror (Linux `mdadm` RAID 1, or a ZFS mirror). The OS, Docker
  and all data live on the mirror. ext4 or XFS, mounted with `noatime`.
- **Cooling:** the machine runs all the time. A case with good airflow, and no dust filter left
  dirty. Check temperatures with `sensors` (lm-sensors) and the NVMe temperature with
  `smartctl`.
- **BIOS settings (Owner):**
  - "Restore on AC power loss" = **Power On**, so the server starts again after a cut.
  - Turn off sleep and other power saving that suspends the machine.
  - Turn on virtualization (VT-x / AMD-V) only if needed later; it is not needed for Docker.
  - Turn on the TPM 2.0 if disk encryption with automatic unlock is used (Part 3.6).

### 3.2 Network and internet

First find out what the ISP gives (the agent can check, Part 4, step 1):

- **Case A: a static public IPv4.** Best. Point DNS at it, forward ports 80 and 443 (TCP) and 443
  (UDP, for HTTP/3) on the router to the server. Caddy gets HTTPS certificates by itself. Many
  ISPs sell a static IP as a monthly add-on; ask for it.
- **Case B: no public IP (CGNAT) or a changing IP.** Use **Cloudflare Tunnel** (`cloudflared`).
  The server opens an outgoing connection to Cloudflare, so no port is opened on the router and
  the home IP is hidden. HTTPS ends at Cloudflare.

Trade-offs of the tunnel:

- **Tenant shop domains:** each tenant's shop can have its own domain (`shop.acme.com`). With a
  public IP, Caddy's on-demand certificates handle that. With a tunnel, custom domains need
  Cloudflare for SaaS ("Custom Hostnames"); check its current free limit before choosing.
- **Upload size:** Cloudflare's free plan accepts request bodies up to 100 MB. Omnivo's uploads
  (logos, CSV imports) are far smaller, so this is fine.
- **Client IP:** the audit log needs the real client IP. Behind a tunnel, Caddy must take it from
  the `CF-Connecting-IP` header and only trust Cloudflare's addresses (Caddy's
  `trusted_proxies` with Cloudflare's IP ranges). `TRUST_PROXY=true` stays on the API.

Other network needs:

- **Wired Ethernet** from the server to the router. Give the server a fixed local address
  (a DHCP reservation on the router).
- **UPS for the router and the ONU** too. A server on a UPS behind a router without one is
  offline anyway.
- **Second ISP (recommended):** a router with dual WAN failover, or a 4G/5G backup. With a
  tunnel, failover is automatic (cloudflared reconnects on whichever line works). With a static
  IP, the second line has a different IP, so failover needs the tunnel anyway.
- **Bandwidth:** a new device downloads the app (a few MB, kept by the service worker) and its
  first copy of the data. 50 Mbps upload serves about 200 busy users comfortably.
- **Email:** a home IP cannot send email (port 25 is usually blocked and home IPs are on spam
  lists). Use an email service over SMTP on port 465 or 587: Amazon SES, Resend, Brevo or
  Postmark. Mailpit stays for testing only. Add SPF, DKIM and DMARC records in DNS.

### 3.3 Domain and DNS

- A domain, with DNS on Cloudflare (free).
- Host names (the same pattern as the demo guide):

  | Name | Points to | Use |
  | --- | --- | --- |
  | `app.<domain>` | the server (or the tunnel) | the ERP app (PWA) |
  | `api.<domain>` | the server (or the tunnel) | the API |
  | `files.<domain>` | the server (or the tunnel) | MinIO, for presigned uploads and downloads |
  | tenant shop domains | the server (or Cloudflare for SaaS) | each tenant's shop |

  Mailpit gets no public name in production.
- With a public IP: records are "DNS only" (grey cloud), so Caddy gets its own certificates.
  With a tunnel: records are created by `cloudflared` and are proxied (orange cloud).

### 3.4 Operating system

- **Ubuntu Server 24.04 LTS**, a fresh install, with no desktop. A desktop uses 1–2 GB of RAM and
  updates that may need a reboot. If the PC already has a desktop Ubuntu, either reinstall the
  server edition, or turn the desktop off with `systemctl set-default multi-user.target`.
- During install: the mirror (RAID 1) for the root disk, OpenSSH server on, no snaps for Docker.
- Time zone **UTC** on the server (`timedatectl set-timezone UTC`). Omnivo works out each
  workspace's own time zone itself; a UTC server avoids double conversions in logs and backups.
- Time sync on (`chrony` or `systemd-timesyncd`). Signed URLs and login tokens fail when the clock
  is wrong.
- Automatic security updates (`unattended-upgrades`), with automatic reboot **off**. Reboots are
  done by hand at a quiet hour, after checking backups.

Kernel settings (in `/etc/sysctl.d/99-omnivo.conf`):

```ini
# Use swap only when memory is really short; Postgres and Valkey are slow from swap
vm.swappiness = 10
# Valkey's background save forks the process; without this the fork can fail under load
vm.overcommit_memory = 1
# Room for many waiting connections in Caddy and the API
net.core.somaxconn = 4096
```

Also:

- **Swap:** an 8 GB swap file, as a safety net, not as extra memory.
- **Transparent huge pages:** set to `madvise` or `never` (Valkey warns about it otherwise).
- **Open file limit:** Docker's default (1,048,576) is enough; check that no host limit lowers it.

### 3.5 Software stack (containers)

Install **Docker Engine** and the **Compose plugin** from Docker's own apt repository (not the
snap, not `docker.io` from Ubuntu). Then run the stack from `infra/staging/` with these changes:

| Service | Image | Change for this server |
| --- | --- | --- |
| `db` | `postgres:17-alpine` | Add the tuning below. Keep it off the public network (no `ports:`). |
| `cache` | `valkey/valkey:8-alpine` | Add `--maxmemory 1gb`; keep `noeviction`. |
| `storage` | `pgsty/minio` | Unchanged. |
| `api` | `omnivo-api` | 2–3 copies (see the note below). Memory limit 1 GB each. |
| `worker` | `omnivo-api` (`node dist/worker.js`) | One copy. Memory limit 1.5 GB. |
| `shop` | **new** | The Astro server (`node dist/server/entry.mjs`). The staging stack is older than the shop (step 26) and does not have it yet: the Dockerfile needs a `shop` target and the Caddyfile needs the shop's sites. |
| `web` | Caddy | Production host names; with a tunnel, the trusted proxies above. |
| `mail` | Mailpit | **Remove** in production. Set `SMTP_URL` to the real email service. |
| `cloudflared` | `cloudflare/cloudflared` | **Add** only for Case B (tunnel). |

Postgres settings for 32 GB RAM and NVMe (pass them as `command: ['postgres', '-c', ...]` or a
mounted `postgresql.conf`):

```ini
shared_buffers = 8GB
effective_cache_size = 20GB
work_mem = 16MB               # per sort or hash, per query: keep it modest
maintenance_work_mem = 1GB
max_connections = 150         # each API copy and the worker keep their own pool
random_page_cost = 1.1        # NVMe: random reads cost almost the same as sequential ones
effective_io_concurrency = 200
wal_compression = on
max_wal_size = 4GB
checkpoint_completion_target = 0.9
shared_preload_libraries = 'pg_stat_statements'   # finds slow queries later
log_min_duration_statement = 500                   # log queries slower than 0.5 s
```

Postgres also needs a bigger `/dev/shm` in Docker (`shm_size: 1gb` on the `db` service), or large
queries fail with "could not resize shared memory segment".

**Several API copies:** run them as `api`, `api-2` (or with `deploy.replicas`) and let Caddy share
the load (`reverse_proxy api:3000 api-2:3000`). Before doing that, the agent must check that the
API keeps no state in memory between requests (sessions, rate limits, caches). Anything like that
must live in Postgres or Valkey first. Until this is checked, run one copy.

**Building the images:** the staging guide builds them on GitHub Actions and pulls them from
GHCR. On a home server it is also fine to build on the server itself, because it is x86-64:
`docker build -f infra/docker/Dockerfile --target api .` and so on. Building uses a lot of CPU and
RAM for a few minutes, so do it at a quiet hour.

### 3.6 Security

- **SSH:** keys only, no passwords, no root login. A `deploy` user for the app.
- **Firewall (`ufw`):** deny everything coming in, then allow only SSH from the local network
  (or only over Tailscale), and 80/443 in Case A. In Case B, no port at all from the internet.
- **Docker bypasses `ufw`.** A `ports:` line in Compose opens that port to the world even when
  `ufw` says no. So only Caddy has `ports:`. The database, Valkey, MinIO and Mailpit must never
  have one. To reach the database from a laptop, use an SSH tunnel.
- **Remote admin:** Tailscale (or WireGuard) for SSH from outside the house. Never forward port 22
  on the router.
- **`fail2ban`** for SSH.
- **Secrets:** made on the server with `openssl rand`, kept in `/srv/omnivo/.env` with mode `600`,
  and a copy in the owner's password manager. Never in Git, never in the chat.
- **Disk encryption (recommended):** LUKS on the data mirror, unlocked by the TPM at boot
  (`systemd-cryptenroll --tpm2-device=auto`), so the server still starts by itself after a power
  cut. A stolen disk is then unreadable. Backups are encrypted too (Part 3.7).
- **Production mode:** `NODE_ENV=production` on every Node container. It turns on secure cookies
  and hides `/docs` and `/openapi.json`.

### 3.7 Backups (the most important part)

Follow 3-2-1: three copies, on two kinds of storage, one away from the house.

| What | How | How often | Where |
| --- | --- | --- | --- |
| Database, full | `pg_dump -Fc` (the staging `backup.sh`) | every night | the USB backup disk and off-site |
| Database, changes | WAL archiving with pgBackRest or WAL-G | continuously (every few minutes) | off-site |
| Files (MinIO bucket) | `mc mirror` | every night | the USB backup disk and off-site |
| `.env` and the Caddy data | copy | after each change | the owner's password manager / off-site |

- **Off-site:** Cloudflare R2 or Backblaze B2 (both cheap per GB). Encrypt before upload
  (pgBackRest and WAL-G can do it; for dumps use `age` or `gpg`).
- **Keep:** 7 daily, 4 weekly, 6 monthly copies.
- **Goal:** lose at most 15 minutes of data (WAL archiving) and be back within 4 hours on any
  other machine.
- **Test a restore every month** on another machine or a scratch container. A backup that was
  never restored is not a backup.

### 3.8 Monitoring and alerts

- **From outside the house:** an uptime check that calls `https://api.<domain>/health` every
  minute (UptimeRobot or Better Stack, free plans) and sends an SMS or a Telegram message. It must
  be outside: a monitor at home cannot tell anyone that the home is offline.
- **On the server:** Netdata, or Prometheus with node_exporter and Grafana. Alerts for:
  - disk over 80% full
  - RAM over 90%, or swap in use for more than 10 minutes
  - CPU over 80% for 15 minutes
  - disk health (`smartmontools`, with `smartd` email alerts), and a failed RAID disk
    (`mdadm --monitor`)
  - the nightly backup did not finish
- **UPS:** connect the UPS by USB and install NUT (`nut`). When the battery is low, it shuts the
  server down cleanly (Postgres stops, nothing is half written).
- **Logs:** the Compose file already cuts each container's log at 10 MB × 5 files.

### 3.9 Load test before going live

Do not trust the user numbers in Part 1 without a test. Before the first real customers:

1. Seed a workspace with realistic data (thousands of products, customers and invoices).
2. Use k6 (or a similar tool) from **another machine on another network**, so the internet line is
   part of the test. Script the common paths: sign in, list invoices, save an invoice, a POS sale,
   open a report, make a PDF.
3. Raise the virtual users step by step until the slowest 5% of requests (p95) pass 500 ms, or
   errors appear.
4. Watch CPU, RAM, disk I/O and the upload line during the test. The first one to hit its limit
   is what to upgrade.
5. Keep the expected real load below 60% of what the test reached.

## 4. Checklist for the setup agent

The agent asks the owner before each step that changes the machine, and never asks for a secret
in the chat. Secrets are made on the server.

1. **Collect the facts** (read-only) and report them:
   - `cat /etc/os-release`, `uname -m` (must be `x86_64`), `lscpu`, `free -h`, `lsblk -o
     NAME,SIZE,TYPE,MODEL,ROTA` (ROTA 0 = SSD), `df -h`, `ip a`.
   - Public IP check: compare `curl -s https://api.ipify.org` with the WAN address the router
     shows. Different, or in `100.64.0.0/10` = CGNAT → Case B (tunnel).
   - Compare the results with Part 1 and list every gap.
2. **Owner decisions to confirm:** Case A or B (Part 3.2); the domain; the email service; the
   off-site backup provider; whether to encrypt the disk.
3. **Base system** (Part 3.4): updates, UTC, time sync, `unattended-upgrades`, the sysctl file,
   swap, transparent huge pages, the `deploy` user, SSH hardening, `ufw`, `fail2ban`, Tailscale.
4. **Docker** from Docker's apt repository, with the Compose plugin; the `deploy` user in the
   `docker` group.
5. **The stack:** take `infra/` from the `staging-deploy` branch into `/srv/omnivo`, then make the
   changes in Part 3.5 (add `shop`, remove `mail`, real `SMTP_URL`, Postgres tuning and
   `shm_size`, Valkey `maxmemory`, memory limits, and `cloudflared` for Case B). Changes to the
   repo's own files are proposed to the owner, who writes them (CLAUDE.md, rule 1).
6. **Secrets:** generate `.env` on the server with `openssl rand -base64 48` for every password and
   secret; mode `600`; tell the owner to copy it into a password manager.
7. **Build or pull the images, run migrations** (`docker compose run --rm migrate`), then
   `docker compose up -d`.
8. **Network:** Case A: router port forwarding and DNS records. Case B: create the tunnel and its
   routes in Cloudflare.
9. **Backups** (Part 3.7): nightly dump and file mirror, WAL archiving, the off-site upload, then
   one full restore test.
10. **Monitoring** (Part 3.8): the outside uptime check, server metrics and alerts, `smartd`,
    `mdadm` alerts, NUT for the UPS.
11. **Check it works:** `/health` answers over HTTPS; sign up and receive the welcome email;
    upload a logo; download a Bangla PDF; the audit log shows the real client IP; reboot the
    server and see everything come back by itself; pull the power plug (on the UPS) and see NUT
    shut down cleanly.
12. **Load test** (Part 3.9) and report the numbers to the owner.

## 5. When to move off the home server

Move to a data center (a VPS in Singapore, or colocation in Dhaka) when any of these is true:

- CPU stays above 70% in working hours, or the database no longer fits in RAM.
- The upload line is full at busy times.
- Customers expect an uptime promise (for example 99.5% a month is about 3.5 hours down).
- More than a handful of paying businesses keep their books on Omnivo.

The same Compose stack runs on a VPS without changes, and the backups from Part 3.7 are how the
data moves: restore them on the new server, point DNS at it, done. The home machine can then stay
as the staging or demo server.
