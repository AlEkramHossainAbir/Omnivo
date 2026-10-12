CREATE TABLE "sales_return_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"factor" numeric(19, 6) NOT NULL,
	"base_quantity" numeric(19, 4) NOT NULL,
	"batch_id" uuid,
	"serial_numbers" text[] DEFAULT '{}'::text[] NOT NULL,
	"return_id" uuid NOT NULL,
	"delivery_line_id" uuid,
	"invoice_id" uuid,
	"invoice_line_id" uuid,
	"value" numeric(19, 4),
	"credited_quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "sales_return_lines_quantity_check" CHECK ("sales_return_lines"."quantity" > 0 AND "sales_return_lines"."factor" > 0 AND "sales_return_lines"."base_quantity" > 0),
	CONSTRAINT "sales_return_lines_value_check" CHECK ("sales_return_lines"."value" IS NULL OR "sales_return_lines"."value" >= 0),
	CONSTRAINT "sales_return_lines_billed_check" CHECK (("sales_return_lines"."invoice_id" IS NULL) = ("sales_return_lines"."invoice_line_id" IS NULL) AND ("sales_return_lines"."invoice_line_id" IS NULL OR "sales_return_lines"."delivery_line_id" IS NOT NULL)),
	CONSTRAINT "sales_return_lines_credited_check" CHECK ("sales_return_lines"."credited_quantity" BETWEEN 0 AND "sales_return_lines"."base_quantity" AND ("sales_return_lines"."invoice_line_id" IS NOT NULL OR "sales_return_lines"."credited_quantity" = 0))
);
--> statement-breakpoint
CREATE TABLE "sales_returns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"number" text,
	"date" date NOT NULL,
	"customer_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	CONSTRAINT "sales_returns_posted_check" CHECK (("sales_returns"."status" = 'posted') = ("sales_returns"."number" IS NOT NULL AND "sales_returns"."posted_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "credit_note_allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	CONSTRAINT "credit_note_allocations_amount_check" CHECK ("credit_note_allocations"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "credit_note_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"factor" numeric(19, 6) NOT NULL,
	"base_quantity" numeric(19, 4) NOT NULL,
	"description" text NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"discount_type" text NOT NULL,
	"discount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"tax_rate_id" uuid NOT NULL,
	"tax_rate_name" text NOT NULL,
	"tax_rate_kind" text NOT NULL,
	"tax_rate" numeric(5, 2) NOT NULL,
	"net" numeric(19, 4) NOT NULL,
	"vat" numeric(19, 4) NOT NULL,
	"total" numeric(19, 4) NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"invoice_line_id" uuid NOT NULL,
	"return_line_id" uuid,
	CONSTRAINT "credit_note_lines_quantity_check" CHECK ("credit_note_lines"."quantity" > 0 AND "credit_note_lines"."factor" > 0 AND "credit_note_lines"."base_quantity" > 0),
	CONSTRAINT "credit_note_lines_amounts_check" CHECK ("credit_note_lines"."unit_price" >= 0 AND "credit_note_lines"."discount" >= 0 AND ("credit_note_lines"."discount_type" = 'amount' OR "credit_note_lines"."discount" <= 100) AND "credit_note_lines"."net" >= 0 AND "credit_note_lines"."vat" >= 0 AND "credit_note_lines"."total" = "credit_note_lines"."net" + "credit_note_lines"."vat"),
	CONSTRAINT "credit_note_lines_tax_rate_check" CHECK ("credit_note_lines"."tax_rate" >= 0 AND "credit_note_lines"."tax_rate" < 100)
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"number" text,
	"date" date NOT NULL,
	"customer_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"note" text,
	"discount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"net" numeric(19, 4) DEFAULT '0' NOT NULL,
	"vat" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"applied" numeric(19, 4) DEFAULT '0' NOT NULL,
	"refunded" numeric(19, 4) DEFAULT '0' NOT NULL,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	CONSTRAINT "credit_notes_posted_check" CHECK (("credit_notes"."status" = 'posted') = ("credit_notes"."number" IS NOT NULL AND "credit_notes"."posted_at" IS NOT NULL)),
	CONSTRAINT "credit_notes_totals_check" CHECK ("credit_notes"."discount" >= 0 AND "credit_notes"."net" >= 0 AND "credit_notes"."vat" >= 0 AND "credit_notes"."total" = "credit_notes"."net" + "credit_notes"."vat"),
	CONSTRAINT "credit_notes_money_check" CHECK ("credit_notes"."applied" >= 0 AND "credit_notes"."refunded" >= 0 AND "credit_notes"."applied" + "credit_notes"."refunded" <= "credit_notes"."total" AND ("credit_notes"."status" = 'posted' OR ("credit_notes"."applied" = 0 AND "credit_notes"."refunded" = 0)))
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"date" date NOT NULL,
	"customer_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"account_id" uuid NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"branch_id" uuid NOT NULL,
	"note" text,
	"receipt_id" uuid,
	"credit_note_id" uuid,
	"status" text DEFAULT 'posted' NOT NULL,
	"void_date" date,
	"void_reason" text,
	CONSTRAINT "refunds_amount_check" CHECK ("refunds"."amount" > 0),
	CONSTRAINT "refunds_source_check" CHECK (("refunds"."receipt_id" IS NULL) <> ("refunds"."credit_note_id" IS NULL)),
	CONSTRAINT "refunds_void_check" CHECK (("refunds"."status" = 'voided') = ("refunds"."void_date" IS NOT NULL AND "refunds"."void_reason" IS NOT NULL) AND ("refunds"."void_date" IS NULL OR "refunds"."void_date" >= "refunds"."date"))
);
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_document_check";--> statement-breakpoint
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_paid_check";--> statement-breakpoint
ALTER TABLE "receipts" DROP CONSTRAINT "receipts_amount_check";--> statement-breakpoint
ALTER TABLE "receipts" DROP CONSTRAINT "receipts_void_check";--> statement-breakpoint
DROP INDEX "delivery_lines_to_invoice_idx";--> statement-breakpoint
DROP INDEX "invoices_open_customer_idx";--> statement-breakpoint
DROP INDEX "invoices_open_due_idx";--> statement-breakpoint
DROP INDEX "receipts_unapplied_idx";--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "sales_returns_account_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD COLUMN "returned_quantity" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "credited" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "amount_credited" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "credit_note_total" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "refunded" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_return_lines_line_idx" ON "sales_return_lines" USING btree ("tenant_id","return_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_return_lines_invoice_line_id_idx" ON "sales_return_lines" USING btree ("tenant_id","invoice_line_id","id");--> statement-breakpoint
CREATE INDEX "sales_return_lines_variant_idx" ON "sales_return_lines" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE INDEX "sales_return_lines_delivery_line_idx" ON "sales_return_lines" USING btree ("tenant_id","delivery_line_id") WHERE "sales_return_lines"."delivery_line_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_returns_tenant_id_idx" ON "sales_returns" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_returns_tenant_number_idx" ON "sales_returns" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "sales_returns_tenant_date_idx" ON "sales_returns" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "sales_returns_customer_idx" ON "sales_returns" USING btree ("tenant_id","customer_id","date","id");--> statement-breakpoint
CREATE INDEX "sales_returns_warehouse_idx" ON "sales_returns" USING btree ("tenant_id","warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_note_allocations_pair_idx" ON "credit_note_allocations" USING btree ("tenant_id","credit_note_id","invoice_id");--> statement-breakpoint
CREATE INDEX "credit_note_allocations_invoice_idx" ON "credit_note_allocations" USING btree ("tenant_id","invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_note_lines_line_idx" ON "credit_note_lines" USING btree ("tenant_id","credit_note_id","line_no");--> statement-breakpoint
CREATE INDEX "credit_note_lines_variant_idx" ON "credit_note_lines" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE INDEX "credit_note_lines_invoice_line_idx" ON "credit_note_lines" USING btree ("tenant_id","invoice_id","invoice_line_id");--> statement-breakpoint
CREATE INDEX "credit_note_lines_return_line_idx" ON "credit_note_lines" USING btree ("tenant_id","return_line_id") WHERE "credit_note_lines"."return_line_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_notes_tenant_id_idx" ON "credit_notes" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_notes_customer_id_idx" ON "credit_notes" USING btree ("tenant_id","customer_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_notes_invoice_id_idx" ON "credit_notes" USING btree ("tenant_id","invoice_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_notes_tenant_number_idx" ON "credit_notes" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "credit_notes_tenant_date_idx" ON "credit_notes" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "credit_notes_customer_idx" ON "credit_notes" USING btree ("tenant_id","customer_id","date","id");--> statement-breakpoint
CREATE INDEX "credit_notes_unapplied_idx" ON "credit_notes" USING btree ("tenant_id","customer_id","date","id") WHERE "credit_notes"."status" = 'posted' AND "credit_notes"."applied" + "credit_notes"."refunded" < "credit_notes"."total";--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_tenant_id_idx" ON "refunds" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_tenant_number_idx" ON "refunds" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "refunds_tenant_date_idx" ON "refunds" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "refunds_customer_idx" ON "refunds" USING btree ("tenant_id","customer_id","date","id");--> statement-breakpoint
CREATE INDEX "refunds_account_idx" ON "refunds" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE INDEX "refunds_receipt_idx" ON "refunds" USING btree ("tenant_id","receipt_id") WHERE "refunds"."receipt_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "refunds_credit_note_idx" ON "refunds" USING btree ("tenant_id","credit_note_id") WHERE "refunds"."credit_note_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_lines_invoice_id_idx" ON "invoice_lines" USING btree ("tenant_id","invoice_id","id");--> statement-breakpoint
CREATE INDEX "delivery_lines_to_invoice_idx" ON "delivery_lines" USING btree ("tenant_id","delivery_id") WHERE NOT "delivery_lines"."invoiced" AND "delivery_lines"."returned_quantity" < "delivery_lines"."base_quantity";--> statement-breakpoint
CREATE INDEX "invoices_open_customer_idx" ON "invoices" USING btree ("tenant_id","customer_id","due_date","id") WHERE "invoices"."status" = 'posted' AND "invoices"."amount_paid" + "invoices"."amount_credited" < "invoices"."total";--> statement-breakpoint
CREATE INDEX "invoices_open_due_idx" ON "invoices" USING btree ("tenant_id","due_date","id") WHERE "invoices"."status" = 'posted' AND "invoices"."amount_paid" + "invoices"."amount_credited" < "invoices"."total";--> statement-breakpoint
CREATE INDEX "receipts_unapplied_idx" ON "receipts" USING btree ("tenant_id","customer_id","date","id") WHERE "receipts"."status" = 'posted' AND "receipts"."applied" + "receipts"."refunded" < "receipts"."amount";--> statement-breakpoint
ALTER TABLE "sales_return_lines" ADD CONSTRAINT "sales_return_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_lines" ADD CONSTRAINT "sales_return_lines_return_fk" FOREIGN KEY ("tenant_id","return_id") REFERENCES "public"."sales_returns"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_lines" ADD CONSTRAINT "sales_return_lines_delivery_line_fk" FOREIGN KEY ("tenant_id","delivery_line_id") REFERENCES "public"."delivery_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_lines" ADD CONSTRAINT "sales_return_lines_invoice_line_fk" FOREIGN KEY ("tenant_id","invoice_id","invoice_line_id") REFERENCES "public"."invoice_lines"("tenant_id","invoice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_lines" ADD CONSTRAINT "sales_return_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_lines" ADD CONSTRAINT "sales_return_lines_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_lines" ADD CONSTRAINT "sales_return_lines_batch_fk" FOREIGN KEY ("tenant_id","variant_id","batch_id") REFERENCES "public"."batches"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_allocations" ADD CONSTRAINT "credit_note_allocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_allocations" ADD CONSTRAINT "credit_note_allocations_credit_note_fk" FOREIGN KEY ("tenant_id","customer_id","credit_note_id") REFERENCES "public"."credit_notes"("tenant_id","customer_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_allocations" ADD CONSTRAINT "credit_note_allocations_invoice_fk" FOREIGN KEY ("tenant_id","customer_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","customer_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_credit_note_fk" FOREIGN KEY ("tenant_id","invoice_id","credit_note_id") REFERENCES "public"."credit_notes"("tenant_id","invoice_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_invoice_line_fk" FOREIGN KEY ("tenant_id","invoice_id","invoice_line_id") REFERENCES "public"."invoice_lines"("tenant_id","invoice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_return_line_fk" FOREIGN KEY ("tenant_id","invoice_line_id","return_line_id") REFERENCES "public"."sales_return_lines"("tenant_id","invoice_line_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_tax_rate_fk" FOREIGN KEY ("tenant_id","tax_rate_id") REFERENCES "public"."tax_rates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_fk" FOREIGN KEY ("tenant_id","customer_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","customer_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_receipt_fk" FOREIGN KEY ("tenant_id","customer_id","receipt_id") REFERENCES "public"."receipts"("tenant_id","customer_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_credit_note_fk" FOREIGN KEY ("tenant_id","customer_id","credit_note_id") REFERENCES "public"."credit_notes"("tenant_id","customer_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_sales_returns_account_fk" FOREIGN KEY ("tenant_id","sales_returns_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_document_check" CHECK (("journal_entries"."source" IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery', 'sales_invoice', 'sales_receipt', 'sales_return', 'sales_credit_note', 'sales_refund')) = ("journal_entries"."document_id" IS NOT NULL AND "journal_entries"."document_number" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD CONSTRAINT "delivery_lines_returned_check" CHECK ("delivery_lines"."returned_quantity" BETWEEN 0 AND "delivery_lines"."base_quantity");--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_credited_check" CHECK ("invoice_lines"."credited" BETWEEN 0 AND "invoice_lines"."total");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_credited_check" CHECK ("invoices"."credit_note_total" >= 0 AND "invoices"."credit_note_total" <= "invoices"."total" AND ("invoices"."status" = 'posted' OR "invoices"."credit_note_total" = 0));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_paid_check" CHECK ("invoices"."amount_paid" >= 0 AND "invoices"."amount_credited" >= 0 AND "invoices"."amount_paid" + "invoices"."amount_credited" <= "invoices"."total" AND ("invoices"."status" = 'posted' OR ("invoices"."amount_paid" = 0 AND "invoices"."amount_credited" = 0)));--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_amount_check" CHECK ("receipts"."amount" > 0 AND "receipts"."applied" >= 0 AND "receipts"."refunded" >= 0 AND "receipts"."applied" + "receipts"."refunded" <= "receipts"."amount");--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_void_check" CHECK (("receipts"."status" = 'voided') = ("receipts"."void_date" IS NOT NULL AND "receipts"."void_reason" IS NOT NULL) AND ("receipts"."status" = 'posted' OR ("receipts"."applied" = 0 AND "receipts"."refunded" = 0)) AND ("receipts"."void_date" IS NULL OR "receipts"."void_date" >= "receipts"."date"));