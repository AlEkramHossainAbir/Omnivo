# লোকাল dev DB-র অবস্থা — workspace, ব্রাঞ্চ আর সংশ্লিষ্ট তথ্য

> তোলা হয়েছে ২০২৬-০৯-২৯, ধাপ ৬-এর migration (0007 + 0008) চালানোর পরে, লোকাল Docker-এর Postgres
> (`omnivo` DB) থেকে সরাসরি SQL দিয়ে। এটা একটা মুহূর্তের ছবি — পরে সাইনআপ বা ব্রাঞ্চ যোগ করলে এখানে
> আপনা-আপনি বদলাবে না। এতে dev ইউজারদের ইমেইল আছে, তাই commit করার আগে ভেবে নিন।

## সারসংক্ষেপ

| জিনিস | সংখ্যা |
|---|---|
| Workspace (tenant) | ৩টা — সবগুলো চালু, কোনোটা মোছা না |
| ব্রাঞ্চ | ৩টা — প্রতিটা workspace-এ একটা করে "HO · Head office", সবগুলো চালু |
| ইউজার | ৩ জন — প্রত্যেকে একটা করে workspace-এর Owner |
| নিজের মতো বদলানো নম্বরিং ছাঁচ | ০টা — সবাই ডিফল্ট ছাঁচে (`INV-2026-27-0001` ইত্যাদি) |
| আপলোড করা ফাইল | ৫টা — সবই `rahman-garments`-এর লোগো, সবগুলো `ready` |
| audit log রো | ৬টা — সবই `rahman-garments`-এর |

## Workspace

| নাম | slug (ঠিকানা) | tenant id | তৈরি (ঢাকার সময়) | কোথা থেকে |
|---|---|---|---|---|
| Acme Textiles | `acme` | `01a0d2b5-d068-7793-af5b-aa5015a7c0b2` | ২০২৬-০৯-২৪ ১৫:১৮ | `pnpm db:seed` |
| Rahman Garments | `smoke-20096` | `01a0e656-08cf-7c52-9dc5-fabb202d2ad2` | ২০২৬-০৯-২৮ ১০:৪৬ | সাইনআপ (নাম দেখে মনে হয় একটা smoke test) |
| rahman garments | `rahman-garments` | `01a0e6af-f547-72ba-8e8f-02abb0807bd6` | ২০২৬-০৯-২৮ ১২:২৪ | সাইনআপ |

### প্রতিটা workspace-এর সেটিংস (`tenant_settings`)

তিনটাই এখনো শুরুর মানে — কেউ কোম্পানির প্রোফাইল বা আঞ্চলিক সেটিংস সেভ করেনি:

| slug | আইনি নাম | BIN | ফোন | ইমেইল | ঠিকানা | মূল মুদ্রা | অর্থবছর শুরু | টাইমজোন | লোগো | version |
|---|---|---|---|---|---|---|---|---|---|---|
| `acme` | — | — | — | — | — | BDT | জুলাই (৭) | Asia/Dhaka | নেই | ১ |
| `smoke-20096` | — | — | — | — | — | BDT | জুলাই (৭) | Asia/Dhaka | নেই | ১ |
| `rahman-garments` | — | — | — | — | — | BDT | জুলাই (৭) | Asia/Dhaka | আছে | ১ |

- তিনটা workspace-ই ধাপ ৬-এর আগে তৈরি, তাই settings রো এসেছে migration 0008-এর backfill থেকে (DB-র ডিফল্ট মান)।
- `rahman-garments`-এ লোগো পাঁচবার বদলানো হলেও `version` এখনো ১ — এটা ইচ্ছাকৃত: লোগো বসানো আলাদা route
  (`PUT /settings/logo`), যেটা version বাড়ায় না, যাতে লোগো বদলালে খোলা সেটিংস ফর্মে ভুয়া "কেউ বদলেছে" না আসে।

## ব্রাঞ্চ

| workspace | কোড | নাম | ফোন | ঠিকানা | অবস্থা | তৈরি (ঢাকার সময়) | version |
|---|---|---|---|---|---|---|---|
| `acme` | HO | Head office | — | — | চালু | ২০২৬-০৯-২৯ ১৫:৪৭ | ১ |
| `smoke-20096` | HO | Head office | — | — | চালু | ২০২৬-০৯-২৯ ১৫:৪৭ | ১ |
| `rahman-garments` | HO | Head office | — | — | চালু | ২০২৬-০৯-২৯ ১৫:৪৭ | ১ |

- তিনটারই তৈরির সময় একই মিনিটে — সবগুলো `pnpm db:migrate`-এর 0008 backfill থেকে, হাতে যোগ করা না।
- এখন থেকে নতুন সাইনআপ এই "Head office" পায় signup-এর provisioning থেকে (`auth.service.ts`)।
- প্রতিটা workspace-এ এটাই একমাত্র চালু ব্রাঞ্চ, তাই এখন archive করতে চাইলে `branch_last_active` (409) আসবে।

## ইউজার, সদস্যপদ আর রোল

| workspace | নাম | ইমেইল | রোল | ভাষা | থিম | ইউজার তৈরি |
|---|---|---|---|---|---|---|
| `acme` | Acme Admin | admin@acme.omnivo.app | Owner | বাছেনি | system | ২০২৬-০৯-২৪ ১৫:১৮ |
| `smoke-20096` | Test Owner | smoke-20096@example.com | Owner | বাছেনি | system | ২০২৬-০৯-২৮ ১০:৪৬ |
| `rahman-garments` | rahman garments | rahman@gmail.com | Owner | বাছেনি | system | ২০২৬-০৯-২৮ ১২:২৪ |

- কোনো ইউজার একাধিক workspace-এ নেই, তাই কারও সাইডবারে workspace switcher-এর মেনু আসবে না (শুধু তথ্য দেখায়)।
- ভাষা "বাছেনি" (`NULL`) আর থিম `system` — কেউ এখনো user মেনু থেকে ভাষা বা থিম সেভ করেনি।
- `acme`-এর ইউজারের পাসওয়ার্ড নেই (seed শুধু `users`-এ রো বসায়), তাই সেটা দিয়ে লগইন করা যায় না।

### Owner রোলের permission

তিনটা workspace-এর Owner-ই সিস্টেমের সব ৬টা permission পেয়েছে (৩টা আগের, ৩টা ধাপ ৬-এর
`grantOwnerPermissions`-এ):

| permission | কী করতে দেয় |
|---|---|
| `core.user.read` | workspace-এর ইউজার দেখা |
| `core.user.invite` | ইউজার আমন্ত্রণ |
| `core.role.manage` | রোল আর permission ঠিক করা |
| `core.settings.manage` | কোম্পানির প্রোফাইল, আঞ্চলিক সেটিংস আর নম্বরিং বদলানো (ধাপ ৬) |
| `core.branch.manage` | ব্রাঞ্চ যোগ, বদল, archive (ধাপ ৬) |
| `core.audit.read` | audit log দেখা (ধাপ ৬) |

## নম্বরিং

`number_series` টেবিলে কোনো রো নেই — কোনো workspace ছাঁচ বদলায়নি, তাই সবাই contracts-এর
`defaultNumberFormat()`-এর ছাঁচে: অর্থবছর সহ, ৪ অঙ্ক।

| ডকুমেন্ট | ডিফল্ট prefix | আজ তৈরি হলে নম্বর |
|---|---|---|
| Sales invoice | INV | INV-2026-27-0001 |
| Sales order | SO | SO-2026-27-0001 |
| Purchase order | PO | PO-2026-27-0001 |
| Supplier bill | BILL | BILL-2026-27-0001 |
| Goods receipt (GRN) | GRN | GRN-2026-27-0001 |
| Journal voucher | JV | JV-2026-27-0001 |

কোনো ডকুমেন্ট এখনো নম্বর নেয়নি (প্রথম ব্যবহার ধাপ ১০ আর ১৫-এ), তাই কাউন্টারের টেবিলও খালি।

## আপলোড করা ফাইল

সবগুলো `rahman-garments`-এর, সবগুলো `company_logo` আর `ready` (storage-এ আছে, আকার আর ধরন মিলেছে):

| ফাইলের নাম | ধরন | আকার |
|---|---|---|
| Group 1321314675.png | image/png | ৩৬,৮৪৯ বাইট |
| 012.jpg | image/jpeg | ২,১৫,৬৬৭ বাইট |
| Ellipse 1432.png | image/png | ৫,৩৯২ বাইট |
| Group 1321314675.png | image/png | ৩৬,৮৪৯ বাইট |
| 012.jpg | image/jpeg | ২,১৫,৬৬৭ বাইট |

- এখন লোগো হিসেবে বসানো শুধু একটা; বাকি চারটা পুরনো আপলোড, মোছা হয় না। অব্যবহৃত ফাইল পরিষ্কারের job আসবে
  ধাপ ৮-এ (worker)।
- ফাইলগুলো MinIO-তে: http://localhost:9001 → bucket `omnivo` →
  `tenants/01a0e6af-f547-72ba-8e8f-02abb0807bd6/company_logo/…`

## audit log

| workspace | ঘটনা | কতবার |
|---|---|---|
| `rahman-garments` | `auth.signed_in` (লগইন) | ১ |
| `rahman-garments` | `settings.logo_changed` (লোগো বদল) | ৫ |

বাকি দুটো workspace-এ কোনো audit রো নেই — ধাপ ৬-এর আগে audit লেখা হতো না, আর migration-এর পরে সেগুলোতে কেউ
লগইন বা কোনো বদল করেনি।

## আবার চালাতে চাইলে

```bash
pnpm db:psql
```

```sql
SELECT name, slug, created_at FROM tenants ORDER BY created_at;
SELECT t.slug, b.code, b.name, b.archived_at FROM branches b JOIN tenants t ON t.id = b.tenant_id;
```

`pnpm db:psql` superuser হিসেবে ঢোকে, তাই RLS ছাড়াই সব টেন্যান্টের রো দেখায়।
অ্যাপের `omnivo_app` role দিয়ে (`pnpm db:psql:app`) একই query খালি ফল দেবে, কারণ tenant context বসানো নেই।
