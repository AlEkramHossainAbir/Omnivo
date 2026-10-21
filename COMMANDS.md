# Commands

Quick reference for commands used often in this repo. Add to this file as new
important commands come up.

## Run the full stack (db + backend + frontend)

0. Make sure Docker Desktop is running first — `pnpm db:up` needs the daemon.
   If you get `failed to connect to the docker API ... no such file or
   directory`, Docker Desktop isn't started:

   ```sh
   open -a Docker
   ```

   Wait for the whale icon in the menu bar to go steady before continuing.

1. Start infra (Postgres, Valkey cache, Mailpit, MinIO) in Docker, and wait for
   health checks:

   ```sh
   pnpm db:up
   ```

2. Start backend and frontend dev servers together (Turborepo runs both `dev`
   tasks in parallel):

   ```sh
   pnpm dev
   ```

   - API (`@omnivo/api`, NestJS/Fastify): http://localhost:3000
   - App (`@omnivo/app`, Vite/React): http://localhost:5173
   - Kitchen sink (every shared ui component, both themes and languages):
     http://localhost:5173/kitchen-sink — only in `pnpm dev`, needs a signed-in user
   - API docs (Scalar, from the contract registry): http://localhost:3000/docs — dev only
   - MinIO console: http://localhost:9001 (omnivo / omnivo-dev-secret) — uploaded files are under the
     omnivo bucket, tenants/<tenant-id>/…
   - Mailpit (every email the worker sends): http://localhost:8025

   `pnpm dev` also starts the worker (`@omnivo/api:dev:worker` in the log): it sends the emails and runs the
   background jobs. To run it alone: `pnpm --filter @omnivo/api dev:worker`.

   To run the app alone, without the API, Postgres or Docker:

   ```sh
   pnpm dev:mock   # the app alone on MSW mocks — no API, Postgres or Docker needed
   ```

   Mock sign-in: any password works except `wrong-password`; the sign-up address
   `rahman-garments` is already taken.

Stop infra when done:

```sh
pnpm db:down
```

## Database

```sh
pnpm db:up      # start db + cache + mail + storage containers
pnpm db:down    # stop them
pnpm db:psql    # open a psql shell to the omnivo db
pnpm db:psql:app # psql as omnivo_app (NOBYPASSRLS) — RLS applies, use to see isolation
pnpm db:migrate # apply pending migrations (as omnivo_migrator), then sync the permission catalog
pnpm db:seed    # idempotent seed: Acme tenant, admin user, Owner role + permissions
pnpm db:generate --name <name> # new migration from schema changes (never hand-write the SQL)
```

The seeded `admin@acme.omnivo.app` has no password, so it can't sign in. To see
the login flow, create a new workspace from the sign-up page.

## Look at the data

Three ways to see what is in the database.

**Drizzle Studio** (browser UI, already set up in the repo):

```sh
pnpm db:studio   # then open the link it prints, usually https://local.drizzle.studio
```

Studio connects as `omnivo_migrator`. Tenant tables (`roles`, `branches`, `invitations` and so on) have
forced row-level security, so Studio may show them empty. `tenants` and `users` have no RLS and show
normally. To see every row of every workspace, use a client that connects as `postgres`.

**A desktop client** (TablePlus, DBeaver, pgAdmin or the VS Code PostgreSQL extension). The `postgres`
superuser bypasses RLS, so all workspaces are visible. Use it to look, not to edit: edits skip the app's
audit log and permission checks.

| Field    | Value       |
| -------- | ----------- |
| Host     | `localhost` |
| Port     | `5432`      |
| Database | `omnivo`    |
| User     | `postgres`  |
| Password | `postgres`  |

**The terminal** (no install):

```sh
pnpm db:psql   # psql shell as postgres
```

Useful inside psql: `\dt` lists tables, `\d tenants` shows the columns of one table,
`SELECT * FROM tenants;` shows rows, and `\q` quits.

```sh
# the journal: entries per status, and any posted entry that does not balance (should be none)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, e.status, count(*) FROM journal_entries e JOIN tenants t ON t.id = e.tenant_id GROUP BY 1, 2"
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT e.number, sum(l.debit) - sum(l.credit) AS out_by FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id WHERE e.status = 'posted' GROUP BY e.number HAVING sum(l.debit) <> sum(l.credit)"
# exports: per person and status (a 'pending' one older than a minute means the worker is not running)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT u.email, x.report, x.format, x.status, x.created_at FROM report_exports x JOIN users u ON u.id = x.requested_by ORDER BY x.id DESC LIMIT 20"
# closing entries in force (one per closed year)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, e.number, e.date FROM journal_entries e JOIN tenants t ON t.id = e.tenant_id WHERE e.source = 'year_close' AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reversal_of_id = e.id)"
# stock balances that do not match their movements (should print nothing; the trigger keeps them equal)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT b.tenant_id, b.warehouse_id, b.variant_id, b.batch_id, b.quantity, m.total FROM stock_balances b LEFT JOIN LATERAL (SELECT coalesce(sum(quantity), 0) AS total FROM stock_movements m WHERE m.tenant_id = b.tenant_id AND m.warehouse_id = b.warehouse_id AND m.variant_id = b.variant_id AND m.batch_id IS NOT DISTINCT FROM b.batch_id) m ON true WHERE b.quantity <> m.total"
# transfers still on the road, oldest first
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, s.number, s.sent_on FROM stock_transfers s JOIN tenants t ON t.id = s.tenant_id WHERE s.status = 'in_transit' ORDER BY s.sent_on"
# items whose stock_values row differs from its movements (should print nothing; the trigger keeps them equal)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT v.tenant_id, v.variant_id, v.quantity, v.value, m.quantity AS moved, m.value AS moved_value FROM stock_values v LEFT JOIN LATERAL (SELECT coalesce(sum(quantity), 0) AS quantity, coalesce(sum(value), 0) AS value FROM stock_movements m WHERE m.tenant_id = v.tenant_id AND m.variant_id = v.variant_id) m ON true WHERE v.quantity <> m.quantity OR v.value <> m.value"
# stock value per workspace, next to its inventory account's balance (the valuation page's check)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, (SELECT coalesce(sum(value), 0) FROM stock_values v WHERE v.tenant_id = t.id) AS stock, (SELECT coalesce(sum(l.debit - l.credit), 0) FROM journal_lines l JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id WHERE l.tenant_id = t.id AND a.purpose = 'inventory' AND e.status = 'posted') AS inventory_account FROM tenants t"
# confirmed sales orders still waiting for goods, by delivery date (lines_left = goods lines not fully delivered)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, o.number, p.name AS customer, o.delivery_date, count(*) FILTER (WHERE l.delivered_quantity < l.base_quantity) AS lines_left FROM sales_orders o JOIN tenants t ON t.id = o.tenant_id JOIN parties p ON p.tenant_id = o.tenant_id AND p.id = o.customer_id JOIN sales_order_lines l ON l.tenant_id = o.tenant_id AND l.order_id = o.id JOIN products pr ON pr.tenant_id = l.tenant_id AND pr.id = l.product_id WHERE o.status = 'confirmed' AND pr.type = 'goods' GROUP BY t.slug, o.number, p.name, o.delivery_date ORDER BY o.delivery_date NULLS LAST"
# order lines delivered past what was ordered (should print nothing; the API refuses it under a lock)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, o.number, l.line_no, l.base_quantity, l.delivered_quantity FROM sales_order_lines l JOIN sales_orders o ON o.tenant_id = l.tenant_id AND o.id = l.order_id JOIN tenants t ON t.id = l.tenant_id WHERE l.delivered_quantity > l.base_quantity"
# posted deliveries whose goods had a cost but no cost of goods sold entry (should print nothing)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, d.number, d.date FROM deliveries d JOIN tenants t ON t.id = d.tenant_id WHERE d.status = 'posted' AND EXISTS (SELECT 1 FROM delivery_lines l WHERE l.tenant_id = d.tenant_id AND l.delivery_id = d.id AND l.value > 0) AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.tenant_id = d.tenant_id AND e.source = 'sales_delivery' AND e.document_id = d.id)"
# posted invoices not fully paid, oldest due first (overdue = due before today, in the database's date)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, i.number, p.name AS customer, i.due_date, i.total - i.amount_paid AS due, i.due_date < current_date AS overdue FROM invoices i JOIN tenants t ON t.id = i.tenant_id JOIN parties p ON p.tenant_id = i.tenant_id AND p.id = i.customer_id WHERE i.status = 'posted' AND i.amount_paid < i.total ORDER BY i.due_date"
# money receipts with money not yet applied to an invoice or paid back (advances)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, r.number, p.name AS customer, r.date, r.amount - r.applied - r.refunded AS unapplied FROM receipts r JOIN tenants t ON t.id = r.tenant_id JOIN parties p ON p.tenant_id = r.tenant_id AND p.id = r.customer_id WHERE r.status = 'posted' AND r.applied + r.refunded < r.amount ORDER BY r.date"
# invoices whose "paid" differs from their allocations (should print nothing; a trigger keeps them equal)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, i.number, i.amount_paid, coalesce(sum(a.amount), 0) AS allocated FROM invoices i JOIN tenants t ON t.id = i.tenant_id LEFT JOIN receipt_allocations a ON a.tenant_id = i.tenant_id AND a.invoice_id = i.id GROUP BY t.slug, i.id, i.number, i.amount_paid HAVING i.amount_paid <> coalesce(sum(a.amount), 0)"
# posted invoices with an amount but no journal entry (should print nothing)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, i.number, i.date FROM invoices i JOIN tenants t ON t.id = i.tenant_id WHERE i.status = 'posted' AND i.total > 0 AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.tenant_id = i.tenant_id AND e.source = 'sales_invoice' AND e.document_id = i.id)"
# credit notes with money not yet applied or paid back (advances)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, c.number, p.name AS customer, c.date, c.total - c.applied - c.refunded AS unapplied FROM credit_notes c JOIN tenants t ON t.id = c.tenant_id JOIN parties p ON p.tenant_id = c.tenant_id AND p.id = c.customer_id WHERE c.status = 'posted' AND c.applied + c.refunded < c.total ORDER BY c.date"
# challan lines whose "returned" differs from their posted returns (should print nothing)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, d.number, l.line_no, l.returned_quantity, coalesce(sum(r.base_quantity) FILTER (WHERE s.status = 'posted'), 0) AS posted_returns FROM delivery_lines l JOIN deliveries d ON d.tenant_id = l.tenant_id AND d.id = l.delivery_id JOIN tenants t ON t.id = l.tenant_id LEFT JOIN sales_return_lines r ON r.tenant_id = l.tenant_id AND r.delivery_line_id = l.id LEFT JOIN sales_returns s ON s.tenant_id = r.tenant_id AND s.id = r.return_id GROUP BY t.slug, d.number, l.id, l.line_no, l.returned_quantity HAVING l.returned_quantity <> coalesce(sum(r.base_quantity) FILTER (WHERE s.status = 'posted'), 0)"
# invoices whose "credited" differs from their credit note allocations (should print nothing; a trigger keeps them equal)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, i.number, i.amount_credited, coalesce(sum(a.amount), 0) AS allocated FROM invoices i JOIN tenants t ON t.id = i.tenant_id LEFT JOIN credit_note_allocations a ON a.tenant_id = i.tenant_id AND a.invoice_id = i.id GROUP BY t.slug, i.id, i.number, i.amount_credited HAVING i.amount_credited <> coalesce(sum(a.amount), 0)"
# posted returns, credit notes and refunds with money but no journal entry (should print nothing)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, x.source, x.number FROM (SELECT s.tenant_id, s.id, s.number, 'sales_return' AS source FROM sales_returns s WHERE s.status = 'posted' AND EXISTS (SELECT 1 FROM sales_return_lines l WHERE l.tenant_id = s.tenant_id AND l.return_id = s.id AND l.value > 0) UNION ALL SELECT tenant_id, id, number, 'sales_credit_note' FROM credit_notes WHERE status = 'posted' AND total > 0 UNION ALL SELECT tenant_id, id, number, 'sales_refund' FROM refunds) x JOIN tenants t ON t.id = x.tenant_id WHERE NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.tenant_id = x.tenant_id AND e.source = x.source AND e.document_id = x.id)"
# receivable lines posted without a customer, per workspace (from before step 15a; decision 15 of the guide)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, count(*) AS lines, sum(l.debit - l.credit) AS amount FROM journal_lines l JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id JOIN tenants t ON t.id = l.tenant_id WHERE a.purpose = 'accounts_receivable' AND e.status = 'posted' AND l.party_id IS NULL GROUP BY t.slug"
# the 20 customers who owe the most (posted lines only)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, p.code, p.name, sum(l.debit - l.credit) AS balance FROM journal_lines l JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id JOIN parties p ON p.tenant_id = l.tenant_id AND p.id = l.party_id JOIN tenants t ON t.id = l.tenant_id WHERE e.status = 'posted' GROUP BY t.slug, p.code, p.name ORDER BY balance DESC LIMIT 20"
# PDFs per workspace, document kind, language and status (a 'pending' one older than a minute means the worker is not running)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, f.kind, f.language, f.status, count(*) AS files, max(f.created_at) AS last FROM document_files f JOIN tenants t ON t.id = f.tenant_id GROUP BY t.slug, f.kind, f.language, f.status ORDER BY t.slug, f.kind, f.language, f.status"
# the last 20 document emails ('failed' rang the sender's bell)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, e.kind, array_to_string(e.\"to\", ', ') AS \"to\", e.subject, e.status, u.email AS sent_by, e.created_at, e.sent_at FROM document_emails e JOIN tenants t ON t.id = e.tenant_id JOIN users u ON u.id = e.sent_by ORDER BY e.created_at DESC LIMIT 20"
# share links that still work, newest first, with when the customer opened them
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, s.kind, s.language, s.created_at, s.expires_at, s.first_opened_at, s.last_opened_at FROM document_shares s JOIN tenants t ON t.id = s.tenant_id WHERE s.revoked_at IS NULL AND s.expires_at > now() ORDER BY s.created_at DESC"
# customers per document language
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, p.document_language, count(*) AS customers FROM parties p JOIN tenants t ON t.id = p.tenant_id WHERE p.is_customer GROUP BY t.slug, p.document_language ORDER BY t.slug, p.document_language"
# what the company owes each supplier (posted payable lines; a negative amount is an advance paid or a debit note not used yet)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, p.code, p.name, sum(l.credit - l.debit) AS owed FROM journal_lines l JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id JOIN parties p ON p.tenant_id = l.tenant_id AND p.id = l.party_id JOIN tenants t ON t.id = l.tenant_id WHERE a.purpose = 'accounts_payable' AND e.status = 'posted' GROUP BY t.slug, p.code, p.name HAVING sum(l.credit - l.debit) <> 0 ORDER BY t.slug, owed DESC"
# payable amounts posted before step 17a, with no supplier named
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, count(*) AS lines, sum(l.credit - l.debit) AS amount FROM journal_lines l JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id JOIN tenants t ON t.id = l.tenant_id WHERE a.purpose = 'accounts_payable' AND e.status = 'posted' AND l.party_id IS NULL GROUP BY t.slug"
# approval levels per workspace and kind of document
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, r.document, v.position, v.min_amount, ro.name AS role FROM approval_levels v JOIN approval_rules r ON r.tenant_id = v.tenant_id AND r.id = v.rule_id JOIN roles ro ON ro.tenant_id = v.tenant_id AND ro.id = v.role_id JOIN tenants t ON t.id = v.tenant_id ORDER BY t.slug, r.document, v.position"
# documents waiting for approval (requisitions, purchase orders, bills, supplier payments), oldest first, with the step and the role they wait for
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, r.document, coalesce(q.number, po.number, b.number, sp.number) AS number, r.amount, s.position AS step, s.role_name AS waits_for, u.full_name AS submitted_by, r.submitted_at FROM approval_rounds r JOIN tenants t ON t.id = r.tenant_id JOIN users u ON u.id = r.submitted_by JOIN LATERAL (SELECT position, role_name FROM approval_steps x WHERE x.tenant_id = r.tenant_id AND x.round_id = r.id AND x.decision IS NULL ORDER BY position LIMIT 1) s ON true LEFT JOIN requisitions q ON r.document = 'requisition' AND q.tenant_id = r.tenant_id AND q.id = r.document_id LEFT JOIN purchase_orders po ON r.document = 'purchase_order' AND po.tenant_id = r.tenant_id AND po.id = r.document_id LEFT JOIN bills b ON r.document = 'bill' AND b.tenant_id = r.tenant_id AND b.id = r.document_id LEFT JOIN supplier_payments sp ON r.document = 'supplier_payment' AND sp.tenant_id = r.tenant_id AND sp.id = r.document_id WHERE r.status = 'pending' ORDER BY r.submitted_at"
# what approved purchase orders still have to bring, by line, the earliest due first (base unit)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, o.number, s.name AS supplier, o.expected_date, v.sku, l.base_quantity - l.received_quantity AS still_to_come FROM purchase_order_lines l JOIN purchase_orders o ON o.tenant_id = l.tenant_id AND o.id = l.order_id JOIN parties s ON s.tenant_id = o.tenant_id AND s.id = o.supplier_id JOIN products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id JOIN product_variants v ON v.tenant_id = l.tenant_id AND v.id = l.variant_id JOIN tenants t ON t.id = l.tenant_id WHERE o.status = 'approved' AND p.type = 'goods' AND l.received_quantity < l.base_quantity ORDER BY t.slug, o.expected_date NULLS LAST, o.number, l.line_no"
# goods received, not billed, by workspace and branch (posted entries; until 17c it is every posted receipt's value)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, b.name AS branch, sum(l.credit - l.debit) AS not_billed FROM journal_lines l JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id JOIN stock_accounts sa ON sa.tenant_id = l.tenant_id AND sa.account_id = l.account_id AND sa.use = 'received_not_billed' LEFT JOIN branches b ON b.tenant_id = l.tenant_id AND b.id = l.branch_id JOIN tenants t ON t.id = l.tenant_id WHERE e.status = 'posted' GROUP BY t.slug, b.name ORDER BY t.slug, b.name"
# what the gate turned back on posted goods receipts, newest first (in the base unit)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, g.number, s.name AS supplier, v.sku, x.rejected_base_quantity, x.rejection_reason FROM goods_receipt_lines x JOIN goods_receipts g ON g.tenant_id = x.tenant_id AND g.id = x.receipt_id JOIN parties s ON s.tenant_id = g.tenant_id AND s.id = g.supplier_id JOIN product_variants v ON v.tenant_id = x.tenant_id AND v.id = x.variant_id JOIN tenants t ON t.id = x.tenant_id WHERE g.status = 'posted' AND x.rejected_quantity > 0 ORDER BY g.posted_at DESC"
# per workspace: the over-receipt percent and the "goods received not billed" account (empty = the stock accounts job has not run, or 2115 was taken)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, ts.over_receipt_percent, a.code AS not_billed_account, a.name FROM tenants t JOIN tenant_settings ts ON ts.tenant_id = t.id LEFT JOIN stock_accounts sa ON sa.tenant_id = t.id AND sa.use = 'received_not_billed' LEFT JOIN ledger_accounts a ON a.tenant_id = sa.tenant_id AND a.id = sa.account_id ORDER BY t.slug"
# open supplier bills, the oldest due first: what is still owed after payments and debit notes, and how many days late (posted bills only)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, b.number, s.name AS supplier, b.supplier_bill_number, b.due_date, b.total - b.amount_paid - b.amount_debited AS still_owed, greatest(current_date - b.due_date, 0) AS days_late FROM bills b JOIN parties s ON s.tenant_id = b.tenant_id AND s.id = b.supplier_id JOIN tenants t ON t.id = b.tenant_id WHERE b.status = 'posted' AND b.amount_paid + b.amount_debited < b.total ORDER BY t.slug, b.due_date, b.number"
# supplier advances: posted payments with money not applied to a bill or paid back, and the order they were paid against
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, p.number, s.name AS supplier, p.date, p.amount, p.amount - p.applied - p.refunded AS advance, o.number AS against_order FROM supplier_payments p JOIN parties s ON s.tenant_id = p.tenant_id AND s.id = p.supplier_id LEFT JOIN purchase_orders o ON o.tenant_id = p.tenant_id AND o.id = p.order_id JOIN tenants t ON t.id = p.tenant_id WHERE p.status = 'posted' AND p.applied + p.refunded < p.amount ORDER BY t.slug, p.date, p.number"
# posted goods receipt lines not billed yet, oldest first: what was kept is what the next bills should cover (base unit)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, g.number, s.name AS supplier, g.date, v.sku, x.base_quantity, x.returned_quantity, x.base_quantity - x.returned_quantity AS kept FROM goods_receipt_lines x JOIN goods_receipts g ON g.tenant_id = x.tenant_id AND g.id = x.receipt_id JOIN parties s ON s.tenant_id = g.tenant_id AND s.id = g.supplier_id JOIN product_variants v ON v.tenant_id = x.tenant_id AND v.id = x.variant_id JOIN tenants t ON t.id = x.tenant_id WHERE g.status = 'posted' AND NOT x.billed AND x.base_quantity > x.returned_quantity ORDER BY t.slug, g.date, g.number, x.line_no"
# per workspace: the two purchase accounts (empty price difference = Cost of goods sold; empty services = choose one)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, d.code AS price_difference, d.name, sv.code AS purchased_services, sv.name FROM tenants t JOIN tenant_settings ts ON ts.tenant_id = t.id LEFT JOIN ledger_accounts d ON d.tenant_id = t.id AND d.id = ts.purchase_price_difference_account_id LEFT JOIN ledger_accounts sv ON sv.tenant_id = t.id AND sv.id = ts.purchase_services_account_id ORDER BY t.slug"
# debit notes with money not yet applied to a bill or paid back (what the supplier owes the company)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, d.number, s.name AS supplier, d.date, b.number AS bill, d.total - d.applied - d.refunded AS unapplied FROM debit_notes d JOIN parties s ON s.tenant_id = d.tenant_id AND s.id = d.supplier_id LEFT JOIN bills b ON b.tenant_id = d.tenant_id AND b.id = d.bill_id JOIN tenants t ON t.id = d.tenant_id WHERE d.status = 'posted' AND d.applied + d.refunded < d.total ORDER BY t.slug, d.date, d.number"
# goods sent back that no debit note has taken the money off yet (billed lines, and lines from before Omnivo)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, r.number, s.name AS supplier, r.date, v.sku, l.base_quantity - l.debited_quantity AS not_debited, b.number AS bill FROM purchase_return_lines l JOIN purchase_returns r ON r.tenant_id = l.tenant_id AND r.id = l.return_id JOIN parties s ON s.tenant_id = r.tenant_id AND s.id = r.supplier_id JOIN product_variants v ON v.tenant_id = l.tenant_id AND v.id = l.variant_id LEFT JOIN bills b ON b.tenant_id = l.tenant_id AND b.id = l.bill_id JOIN tenants t ON t.id = l.tenant_id WHERE r.status = 'posted' AND (l.bill_id IS NOT NULL OR l.receipt_line_id IS NULL) AND l.debited_quantity < l.base_quantity ORDER BY t.slug, r.date, r.number, l.line_no"
# goods receipt lines whose "returned" differs from their posted returns (should print nothing)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, g.number, x.line_no, x.returned_quantity, coalesce(sum(l.base_quantity) FILTER (WHERE r.status = 'posted'), 0) AS posted_returns FROM goods_receipt_lines x JOIN goods_receipts g ON g.tenant_id = x.tenant_id AND g.id = x.receipt_id JOIN tenants t ON t.id = x.tenant_id LEFT JOIN purchase_return_lines l ON l.tenant_id = x.tenant_id AND l.receipt_line_id = x.id LEFT JOIN purchase_returns r ON r.tenant_id = l.tenant_id AND r.id = l.return_id GROUP BY t.slug, g.number, x.id, x.line_no, x.returned_quantity HAVING x.returned_quantity <> coalesce(sum(l.base_quantity) FILTER (WHERE r.status = 'posted'), 0)"
# posted purchase returns, debit notes and supplier refunds with money but no journal entry (should print nothing)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, x.source, x.number FROM (SELECT r.tenant_id, r.id, r.number, 'purchase_return' AS source FROM purchase_returns r WHERE r.status = 'posted' AND EXISTS (SELECT 1 FROM purchase_return_lines l WHERE l.tenant_id = r.tenant_id AND l.return_id = r.id AND l.value > 0) UNION ALL SELECT tenant_id, id, number, 'purchase_debit_note' FROM debit_notes WHERE status = 'posted' AND total > 0 UNION ALL SELECT tenant_id, id, number, 'purchase_refund' FROM supplier_refunds) x JOIN tenants t ON t.id = x.tenant_id WHERE NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.tenant_id = x.tenant_id AND e.source = x.source AND e.document_id = x.id)"
# devices: whose, which branch, when each last finished a pull (revoked ones too)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, d.name, u.email, b.name AS branch, d.last_sync_at, d.revoked_at FROM devices d JOIN users u ON u.id = d.user_id JOIN branches b ON b.tenant_id = d.tenant_id AND b.id = d.branch_id JOIN tenants t ON t.id = d.tenant_id ORDER BY t.slug, d.last_sync_at DESC NULLS LAST"
# the sync change log per workspace and entity: how many lines, and the oldest (the worker deletes lines older than 30 days every hour)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, c.entity, count(*) AS lines, min(c.created_at) AS oldest FROM sync_changes c JOIN tenants t ON t.id = c.tenant_id GROUP BY t.slug, c.entity ORDER BY t.slug, c.entity"
# write transactions open for more than a minute: every device's pull waits for them (should print nothing)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT pid, usename, now() - xact_start AS open_for, state, left(query, 80) AS query FROM pg_stat_activity WHERE backend_xid IS NOT NULL AND xact_start < now() - interval '1 minute'"
```

## Permission cache (Valkey)

```sh
# list cached permission sets: t:<tenant-id>:perm:<user-id>
docker compose -f infra/docker/docker-compose.yml exec cache valkey-cli --scan --pattern 't:*'
# seconds left before a cached set expires (starts at 600)
docker compose -f infra/docker/docker-compose.yml exec cache valkey-cli ttl 't:<tenant-id>:perm:<user-id>'
```

## Worker and queues (Valkey)

```sh
# waiting outbox rows (should be 0 a second after any click)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT type, created_at FROM outbox_events WHERE published_at IS NULL"
# accounts per workspace (0 = the chart job has not run yet)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, count(a.id) FROM tenants t LEFT JOIN ledger_accounts a ON a.tenant_id = t.id GROUP BY t.slug"
# ask the worker to make a missing chart again (it does nothing if the chart exists)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "INSERT INTO outbox_events (id, tenant_id, type, payload) SELECT gen_random_uuid(), id, 'workspace.chart_requested', '{}' FROM tenants WHERE slug = '<slug>'"
# VAT rates per workspace (0 rates = the VAT rates job has not run yet; defaults is always 1 after it)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, count(r.id) AS rates, count(*) FILTER (WHERE r.is_default) AS defaults FROM tenants t LEFT JOIN tax_rates r ON r.tenant_id = t.id AND r.archived_at IS NULL GROUP BY t.slug"
# ask the worker to make the starting VAT rates again (it does nothing if the workspace has any rate)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "INSERT INTO outbox_events (id, tenant_id, type, payload) SELECT gen_random_uuid(), id, 'workspace.tax_rates_requested', '{}' FROM tenants WHERE slug = '<slug>'"
# BullMQ's keys: bull:<queue>:completed / :failed (sorted sets), bull:<queue>:<job-id> (one job)
docker compose -f infra/docker/docker-compose.yml exec cache valkey-cli zcard bull:email:failed
docker compose -f infra/docker/docker-compose.yml exec cache valkey-cli hget bull:email:<job-id> failedReason
```

## Checks

```sh
pnpm typecheck  # tsc --noEmit across all workspaces
pnpm lint       # eslint .
pnpm format     # prettier --check .
pnpm test       # vitest unit tests across all workspaces (no Docker needed)
pnpm test:integration # API integration tests on Testcontainers (Docker must be running)
pnpm test:tenant-leak # RLS + HTTP-level tenant isolation tests (Docker must be running)
pnpm test:e2e     # Playwright on the MSW mocks, desktop + 390px — no API or Docker needed
pnpm --filter @omnivo/app exec playwright install chromium   # once per machine, before the first test:e2e
pnpm build      # build every package and app
pnpm test:bundle-size # build the app, then fail if first-load JS > 210 KB gz or a route chunk > 105 KB gz
pnpm boundaries # dependency-cruiser on apps/packages
pnpm dedupe --check # fail if the lockfile has duplicate copies (e.g. drizzle-orm)
pnpm gen:openapi  # rewrite packages/contracts/openapi.json from the route registry — commit it
pnpm test:openapi # fail if openapi.json is out of date, and validate it as OpenAPI 3.1
```
