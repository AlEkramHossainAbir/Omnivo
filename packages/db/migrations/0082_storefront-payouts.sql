CREATE TABLE "storefront_payout_lines" (
	"tenant_id" uuid NOT NULL,
	"payout_id" uuid NOT NULL,
	"courier_account_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"collected" numeric(19, 4) NOT NULL,
	"charge" numeric(19, 4) NOT NULL,
	"courier_charge" numeric(19, 4),
	"receipt_id" uuid,
	CONSTRAINT "storefront_payout_lines_pkey" PRIMARY KEY("tenant_id","payout_id","shipment_id"),
	CONSTRAINT "storefront_payout_lines_kind_check" CHECK ("storefront_payout_lines"."kind" IN ('cod', 'charge')),
	CONSTRAINT "storefront_payout_lines_amounts_check" CHECK ("storefront_payout_lines"."collected" >= 0 AND "storefront_payout_lines"."collected" = round("storefront_payout_lines"."collected", 2)
        AND "storefront_payout_lines"."charge" >= 0 AND "storefront_payout_lines"."charge" = round("storefront_payout_lines"."charge", 2)
        AND ("storefront_payout_lines"."courier_charge" IS NULL OR ("storefront_payout_lines"."courier_charge" >= 0
          AND "storefront_payout_lines"."courier_charge" = round("storefront_payout_lines"."courier_charge", 2)))),
	CONSTRAINT "storefront_payout_lines_shape_check" CHECK (CASE "storefront_payout_lines"."kind"
          WHEN 'cod' THEN "storefront_payout_lines"."receipt_id" IS NOT NULL AND "storefront_payout_lines"."collected" > 0
          ELSE "storefront_payout_lines"."receipt_id" IS NULL AND "storefront_payout_lines"."collected" = 0 AND "storefront_payout_lines"."charge" > 0
        END)
);
--> statement-breakpoint
CREATE TABLE "storefront_payouts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"number" text NOT NULL,
	"date" date NOT NULL,
	"courier_account_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"cod_account_id" uuid NOT NULL,
	"charge_account_id" uuid,
	"branch_id" uuid NOT NULL,
	"reference" text,
	"note" text,
	"collected" numeric(19, 4) NOT NULL,
	"charges" numeric(19, 4) NOT NULL,
	"net" numeric(19, 4) NOT NULL,
	"status" text DEFAULT 'posted' NOT NULL,
	"void_date" date,
	"void_reason" text,
	CONSTRAINT "storefront_payouts_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "storefront_payouts_account_key" UNIQUE("tenant_id","courier_account_id","id"),
	CONSTRAINT "storefront_payouts_number_key" UNIQUE("tenant_id","number"),
	CONSTRAINT "storefront_payouts_status_check" CHECK ("storefront_payouts"."status" IN ('posted', 'voided')),
	CONSTRAINT "storefront_payouts_amounts_check" CHECK ("storefront_payouts"."collected" >= 0 AND "storefront_payouts"."collected" = round("storefront_payouts"."collected", 2)
        AND "storefront_payouts"."charges" >= 0 AND "storefront_payouts"."charges" = round("storefront_payouts"."charges", 2)
        AND "storefront_payouts"."net" = "storefront_payouts"."collected" - "storefront_payouts"."charges" AND "storefront_payouts"."net" >= 0
        AND ("storefront_payouts"."charges" = 0 OR "storefront_payouts"."charge_account_id" IS NOT NULL)),
	CONSTRAINT "storefront_payouts_accounts_check" CHECK ("storefront_payouts"."bank_account_id" <> "storefront_payouts"."cod_account_id"
        AND ("storefront_payouts"."charge_account_id" IS NULL OR ("storefront_payouts"."charge_account_id" <> "storefront_payouts"."cod_account_id"
          AND "storefront_payouts"."charge_account_id" <> "storefront_payouts"."bank_account_id"))),
	CONSTRAINT "storefront_payouts_text_check" CHECK (("storefront_payouts"."reference" IS NULL OR char_length("storefront_payouts"."reference") BETWEEN 1 AND 60)
        AND ("storefront_payouts"."note" IS NULL OR char_length("storefront_payouts"."note") BETWEEN 1 AND 300)),
	CONSTRAINT "storefront_payouts_void_check" CHECK (("storefront_payouts"."status" = 'voided') = ("storefront_payouts"."void_date" IS NOT NULL AND "storefront_payouts"."void_reason" IS NOT NULL)
        AND ("storefront_payouts"."void_date" IS NULL OR "storefront_payouts"."void_date" >= "storefront_payouts"."date")
        AND ("storefront_payouts"."void_reason" IS NULL OR char_length("storefront_payouts"."void_reason") BETWEEN 1 AND 200))
);
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_document_check";--> statement-breakpoint
DROP INDEX "storefront_shipments_cod_idx";--> statement-breakpoint
ALTER TABLE "courier_accounts" ADD COLUMN "payout_csv_map" jsonb;--> statement-breakpoint
ALTER TABLE "storefront_shipments" ADD COLUMN "payout_id" uuid;--> statement-breakpoint
ALTER TABLE "storefront_shipments" ADD CONSTRAINT "storefront_shipments_account_key" UNIQUE("tenant_id","courier_account_id","id");--> statement-breakpoint
ALTER TABLE "storefront_payout_lines" ADD CONSTRAINT "storefront_payout_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payout_lines" ADD CONSTRAINT "storefront_payout_lines_payout_fk" FOREIGN KEY ("tenant_id","courier_account_id","payout_id") REFERENCES "public"."storefront_payouts"("tenant_id","courier_account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payout_lines" ADD CONSTRAINT "storefront_payout_lines_shipment_fk" FOREIGN KEY ("tenant_id","courier_account_id","shipment_id") REFERENCES "public"."storefront_shipments"("tenant_id","courier_account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payout_lines" ADD CONSTRAINT "storefront_payout_lines_receipt_fk" FOREIGN KEY ("tenant_id","receipt_id") REFERENCES "public"."receipts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payouts" ADD CONSTRAINT "storefront_payouts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payouts" ADD CONSTRAINT "storefront_payouts_courier_account_fk" FOREIGN KEY ("tenant_id","courier_account_id") REFERENCES "public"."courier_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payouts" ADD CONSTRAINT "storefront_payouts_bank_account_fk" FOREIGN KEY ("tenant_id","bank_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payouts" ADD CONSTRAINT "storefront_payouts_cod_account_fk" FOREIGN KEY ("tenant_id","cod_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payouts" ADD CONSTRAINT "storefront_payouts_charge_account_fk" FOREIGN KEY ("tenant_id","charge_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payouts" ADD CONSTRAINT "storefront_payouts_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storefront_payouts_date_idx" ON "storefront_payouts" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "storefront_payouts_account_idx" ON "storefront_payouts" USING btree ("tenant_id","courier_account_id","date","id");--> statement-breakpoint
ALTER TABLE "storefront_shipments" ADD CONSTRAINT "storefront_shipments_payout_fk" FOREIGN KEY ("tenant_id","courier_account_id","payout_id") REFERENCES "public"."storefront_payouts"("tenant_id","courier_account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storefront_shipments_payable_idx" ON "storefront_shipments" USING btree ("tenant_id","courier_account_id") WHERE "storefront_shipments"."payout_id" IS NULL AND ("storefront_shipments"."receipt_id" IS NOT NULL OR "storefront_shipments"."courier_charge" IS NOT NULL);--> statement-breakpoint
CREATE INDEX "storefront_shipments_payout_idx" ON "storefront_shipments" USING btree ("tenant_id","payout_id") WHERE "storefront_shipments"."payout_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_document_check" CHECK (("journal_entries"."source" IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery', 'sales_return', 'purchase_receipt', 'purchase_return', 'pos_sale', 'pos_return', 'sales_invoice', 'sales_receipt', 'sales_credit_note', 'sales_refund', 'purchase_bill', 'purchase_payment', 'purchase_debit_note', 'purchase_refund', 'pos_shift', 'storefront_payout')) = ("journal_entries"."document_id" IS NOT NULL AND "journal_entries"."document_number" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "courier_accounts" ADD CONSTRAINT "courier_accounts_payout_csv_map_check" CHECK ("courier_accounts"."payout_csv_map" IS NULL OR (jsonb_typeof("courier_accounts"."payout_csv_map") = 'object'
        AND octet_length("courier_accounts"."payout_csv_map"::text) <= 1024));