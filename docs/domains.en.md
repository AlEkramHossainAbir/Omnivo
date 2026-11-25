# Domains and addresses

Every web address that Omnivo uses, in one place. Nothing on this page is a secret, so it is safe
in this public repository. The server's IP address, its SSH port and its users are left out on
purpose. They are in the VPS access sheet and in the `myvps` entry of `~/.ssh/config` on your Mac.

## The domain

| | |
| --- | --- |
| Domain | `omnivosoft.com` |
| Bought | 12 Nov 2026, at Cloudflare (Cloudflare Registrar) |
| Paid until | **12 Nov 2027**. Cloudflare renews it by itself if auto-renew is on and the card works. Check in the Cloudflare dashboard → **Domain Registration** |
| DNS | Cloudflare (name servers `drake.ns.cloudflare.com` and `tara.ns.cloudflare.com`) |
| Email on the domain | None yet: no `MX` record, so nobody can send email *to* `@omnivosoft.com` |

## Live addresses

The home VPS runs two separate stacks, each with its own database, files and mail (see
[vps-deploy.en.md](vps-deploy.en.md)). Production reaches the server through the Cloudflare Tunnel
named `omnivo`, the demo through `omnivo-demo`. Each address is a proxied `CNAME` to its tunnel
(`<tunnel id>.cfargotunnel.com`), made by `cloudflared tunnel route dns` or by hand in Cloudflare's
DNS page.

### Production (deployed from `main`)

| Address | What it is | Who uses it |
| --- | --- | --- |
| `https://app.omnivosoft.com` | The ERP app (the PWA) | Customers |
| `https://api.omnivosoft.com` | The API. `https://api.omnivosoft.com/health` answers `{"status":"ok"}` | The app (built into it) |
| `https://files.omnivosoft.com` | File storage (MinIO): logos, imports, PDFs, through signed links | The browser, by itself |
| `https://mail.omnivosoft.com` | Mailpit: every email production sends lands here; nothing is really sent yet | You (user `tester`) |
| `https://shop.omnivosoft.com` | The online shop (`apps/shop`) as a **demo**: mock products and prices, orders kept in memory only (a deploy forgets them), the phone code is always `123456` and no SMS is sent | You and the designer |

### Demo (deployed from `dev`)

| Address | What it is | Who uses it |
| --- | --- | --- |
| `https://demo.omnivosoft.com` | The ERP app, with every change pushed to `dev`, on its own test database | You and testers |
| `https://demo-api.omnivosoft.com` | The demo's API | The demo app (built into it) |
| `https://demo-files.omnivosoft.com` | The demo's file storage | The browser, by itself |
| `https://demo-mail.omnivosoft.com` | The demo's Mailpit | You and testers (user `tester`) |
| `https://demo-shop.omnivosoft.com` | The mock shop of the `dev` code | You, testers and the designer |

The names are one level below the domain. Cloudflare's free HTTPS certificate covers
`*.omnivosoft.com` only, so `api.demo.omnivosoft.com` (two levels) would show a certificate
error. That is why the demo's names are `demo-api`, `demo-files` and so on.

The API addresses are also built into the apps and the server settings:

- `https://api.omnivosoft.com` is the GitHub repository variable `PRODUCTION_API_URL`, and
  `https://demo-api.omnivosoft.com` is `DEMO_API_URL`. Each is built into its app's JavaScript, so
  changing one needs a new build.
- Each stack's `.env` (`/srv/omnivo/.env`, `/srv/omnivo-demo/.env`) has `APP_HOST`, `API_HOST`,
  `FILES_HOST`, `MAIL_HOST` and `SHOP_HOST`.
- Renaming an address means: a new tunnel route in Cloudflare, the `.env` line, the GitHub
  variable, and a new deploy. Do all of them together.

## Free for later

| Address | Planned use |
| --- | --- |
| `https://omnivosoft.com` and `www.omnivosoft.com` | The marketing website (step 22) |
| A tenant's own domain (`shop.acme.com`) | The real online shop, once step 26's public API exists. `shop.omnivosoft.com` is the demo until then |
| New server for production | Production on a server of its own, apart from the demo, when many real customers keep their books here |

## Accounts behind the addresses

| Service | Where | What it holds |
| --- | --- | --- |
| Cloudflare | `dash.cloudflare.com` | The domain, its DNS records, HTTPS, and the tunnels (**Zero Trust → Networks → Tunnels → omnivo** and **omnivo-demo**) |
| GitHub | `github.com/AlEkramHossainAbir/Omnivo` | The code, CI and the deploys (**Actions**), the deploy secrets (repository secrets `VPS_*`), the `demo` and `production` environments |
| GitHub Container Registry | `ghcr.io/alekramhossainabir/omnivo-api`, `omnivo-migrate`, `omnivo-web`, `omnivo-shop` | The built images the server runs |
| The VPS | The VPS access sheet (not in the repo) | The server itself. Only SSH is open |

## When something changes

- **The home IP changes:** the addresses above keep working, because the tunnels connect out by
  themselves. Only the automatic deploys stop. See "When the home IP changes" in
  [vps-deploy.en.md](vps-deploy.en.md).
- **A new address is needed:** the tunnels' routes are managed from the server, not the Cloudflare
  dashboard. See "A new address on the tunnel" in [vps-deploy.en.md](vps-deploy.en.md).
- **Real email:** add the sending service's `SPF`, `DKIM` and `DMARC` records in Cloudflare's DNS.
