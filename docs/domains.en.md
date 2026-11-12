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

## Live addresses (demo / staging server)

All five run on the home VPS and reach it through the Cloudflare Tunnel named `omnivo`. Each one is
a proxied `CNAME` to the tunnel (`<tunnel id>.cfargotunnel.com`), made by
`cloudflared tunnel route dns` or by hand in Cloudflare's DNS page.

| Address | What it is | Who uses it |
| --- | --- | --- |
| `https://app.omnivosoft.com` | The ERP app (the PWA) | Customers and testers |
| `https://api.omnivosoft.com` | The API. `https://api.omnivosoft.com/health` answers `{"status":"ok"}` | The app (built into it) |
| `https://files.omnivosoft.com` | File storage (MinIO): logos, imports, PDFs, through signed links | The browser, by itself |
| `https://mail.omnivosoft.com` | Mailpit: every email the server sends lands here; nothing is really sent | You and testers (user `tester`) |
| `https://shop.omnivosoft.com` | The online shop (`apps/shop`) as a **demo**: mock products and prices, orders kept in memory only (a deploy forgets them), the phone code is always `123456` and no SMS is sent | You, testers and the designer |

The names are one level below the domain. Cloudflare's free HTTPS certificate covers
`*.omnivosoft.com` only, so `app.demo.omnivosoft.com` (two levels) would show a certificate
error.

`app` and `api` are also built into the app and the server settings:

- `https://api.omnivosoft.com` is the GitHub repository variable `STAGING_API_URL`. It is built into
  the app's JavaScript, so changing it needs a new build.
- The server's `/srv/omnivo/.env` has `APP_HOST`, `API_HOST`, `FILES_HOST`, `MAIL_HOST` and
  `SHOP_HOST`.
- Renaming an address means: a new tunnel route in Cloudflare, the `.env` line, the GitHub
  variable, and a new deploy. Do all of them together.

## Free for later

| Address | Planned use |
| --- | --- |
| `https://omnivosoft.com` and `www.omnivosoft.com` | The marketing website (step 22) |
| A tenant's own domain (`shop.acme.com`) | The real online shop, once step 26's public API exists. `shop.omnivosoft.com` is the demo until then |
| New names for production | A real production server, separate from this demo, when real customers keep their books here |

## Accounts behind the addresses

| Service | Where | What it holds |
| --- | --- | --- |
| Cloudflare | `dash.cloudflare.com` | The domain, its DNS records, HTTPS, and the tunnel (**Zero Trust → Networks → Tunnels → omnivo**) |
| GitHub | `github.com/AlEkramHossainAbir/Omnivo` | The code, CI and the deploys (**Actions**), the `staging` environment's secrets |
| GitHub Container Registry | `ghcr.io/alekramhossainabir/omnivo-api`, `omnivo-migrate`, `omnivo-web`, `omnivo-shop` | The built images the server runs |
| The VPS | The VPS access sheet (not in the repo) | The server itself. Only SSH is open |

## When something changes

- **The home IP changes:** the addresses above keep working, because the tunnel connects out by
  itself. Only the automatic deploys stop. See "When the home IP changes" in
  [vps-deploy.en.md](vps-deploy.en.md).
- **A new address is needed:** the tunnel's routes are managed from the server, not the Cloudflare
  dashboard. See "A new address on the tunnel" in [vps-deploy.en.md](vps-deploy.en.md).
- **Real email:** add the sending service's `SPF`, `DKIM` and `DMARC` records in Cloudflare's DNS.
