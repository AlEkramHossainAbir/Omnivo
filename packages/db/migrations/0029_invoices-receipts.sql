CREATE TABLE "invoice_lines" (
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
	"invoice_id" uuid NOT NULL,
	"delivery_line_id" uuid,
	"order_line_id" uuid,
	"batch_id" uuid,
	"serial_numbers" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "invoice_lines_quantity_check" CHECK ("invoice_lines"."quantity" > 0 AND "invoice_lines"."factor" > 0 AND "invoice_lines"."base_quantity" > 0),
	CONSTRAINT "invoice_lines_amounts_check" CHECK ("invoice_lines"."unit_price" >= 0 AND "invoice_lines"."discount" >= 0 AND ("invoice_lines"."discount_type" = 'amount' OR "invoice_lines"."discount" <= 100) AND "invoice_lines"."net" >= 0 AND "invoice_lines"."vat" >= 0 AND "invoice_lines"."total" = "invoice_lines"."net" + "invoice_lines"."vat"),
	CONSTRAINT "invoice_lines_tax_rate_check" CHECK ("invoice_lines"."tax_rate" >= 0 AND "invoice_lines"."tax_rate" < 100)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
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
	"due_date" date NOT NULL,
	"customer_id" uuid NOT NULL,
	"customer_reference" text,
	"branch_id" uuid NOT NULL,
	"warehouse_id" uuid,
	"billing_address" text,
	"prices_include_vat" boolean NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"note" text,
	"discount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"net" numeric(19, 4) DEFAULT '0' NOT NULL,
	"vat" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"amount_paid" numeric(19, 4) DEFAULT '0' NOT NULL,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	CONSTRAINT "invoices_posted_check" CHECK (("invoices"."status" = 'posted') = ("invoices"."number" IS NOT NULL AND "invoices"."posted_at" IS NOT NULL)),
	CONSTRAINT "invoices_due_date_check" CHECK ("invoices"."due_date" >= "invoices"."date"),
	CONSTRAINT "invoices_totals_check" CHECK ("invoices"."discount" >= 0 AND "invoices"."net" >= 0 AND "invoices"."vat" >= 0 AND "invoices"."total" = "invoices"."net" + "invoices"."vat"),
	CONSTRAINT "invoices_paid_check" CHECK ("invoices"."amount_paid" >= 0 AND "invoices"."amount_paid" <= "invoices"."total" AND ("invoices"."status" = 'posted' OR "invoices"."amount_paid" = 0))
);
--> statement-breakpoint
CREATE TABLE "receipt_allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	CONSTRAINT "receipt_allocations_amount_check" CHECK ("receipt_allocations"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "receipts" (
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
	"applied" numeric(19, 4) DEFAULT '0' NOT NULL,
	"account_id" uuid NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"branch_id" uuid NOT NULL,
	"note" text,
	"status" text DEFAULT 'posted' NOT NULL,
	"void_date" date,
	"void_reason" text,
	CONSTRAINT "receipts_amount_check" CHECK ("receipts"."amount" > 0 AND "receipts"."applied" >= 0 AND "receipts"."applied" <= "receipts"."amount"),
	CONSTRAINT "receipts_void_check" CHECK (("receipts"."status" = 'voided') = ("receipts"."void_date" IS NOT NULL AND "receipts"."void_reason" IS NOT NULL) AND ("receipts"."status" = 'posted' OR "receipts"."applied" = 0) AND ("receipts"."void_date" IS NULL OR "receipts"."void_date" >= "receipts"."date"))
);
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_document_check";--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD COLUMN "holds_money" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD COLUMN "invoiced" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD COLUMN "invoiced_quantity" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_lines_line_idx" ON "invoice_lines" USING btree ("tenant_id","invoice_id","line_no");--> statement-breakpoint
CREATE INDEX "invoice_lines_variant_idx" ON "invoice_lines" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE INDEX "invoice_lines_delivery_line_idx" ON "invoice_lines" USING btree ("tenant_id","delivery_line_id") WHERE "invoice_lines"."delivery_line_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "invoice_lines_order_line_idx" ON "invoice_lines" USING btree ("tenant_id","order_line_id") WHERE "invoice_lines"."order_line_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_tenant_id_idx" ON "invoices" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_customer_id_idx" ON "invoices" USING btree ("tenant_id","customer_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_tenant_number_idx" ON "invoices" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "invoices_tenant_date_idx" ON "invoices" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "invoices_customer_idx" ON "invoices" USING btree ("tenant_id","customer_id","date","id");--> statement-breakpoint
CREATE INDEX "invoices_open_customer_idx" ON "invoices" USING btree ("tenant_id","customer_id","due_date","id") WHERE "invoices"."status" = 'posted' AND "invoices"."amount_paid" < "invoices"."total";--> statement-breakpoint
CREATE INDEX "invoices_open_due_idx" ON "invoices" USING btree ("tenant_id","due_date","id") WHERE "invoices"."status" = 'posted' AND "invoices"."amount_paid" < "invoices"."total";--> statement-breakpoint
CREATE UNIQUE INDEX "receipt_allocations_pair_idx" ON "receipt_allocations" USING btree ("tenant_id","receipt_id","invoice_id");--> statement-breakpoint
CREATE INDEX "receipt_allocations_invoice_idx" ON "receipt_allocations" USING btree ("tenant_id","invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_tenant_id_idx" ON "receipts" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_customer_id_idx" ON "receipts" USING btree ("tenant_id","customer_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_tenant_number_idx" ON "receipts" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "receipts_tenant_date_idx" ON "receipts" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "receipts_customer_idx" ON "receipts" USING btree ("tenant_id","customer_id","date","id");--> statement-breakpoint
CREATE INDEX "receipts_unapplied_idx" ON "receipts" USING btree ("tenant_id","customer_id","date","id") WHERE "receipts"."status" = 'posted' AND "receipts"."applied" < "receipts"."amount";--> statement-breakpoint
CREATE INDEX "receipts_account_idx" ON "receipts" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_lines_tenant_id_idx" ON "delivery_lines" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "delivery_lines_to_invoice_idx" ON "delivery_lines" USING btree ("tenant_id","delivery_id") WHERE NOT "delivery_lines"."invoiced";--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_delivery_line_fk" FOREIGN KEY ("tenant_id","delivery_line_id") REFERENCES "public"."delivery_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_order_line_fk" FOREIGN KEY ("tenant_id","order_line_id") REFERENCES "public"."sales_order_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_tax_rate_fk" FOREIGN KEY ("tenant_id","tax_rate_id") REFERENCES "public"."tax_rates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_batch_fk" FOREIGN KEY ("tenant_id","variant_id","batch_id") REFERENCES "public"."batches"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_allocations" ADD CONSTRAINT "receipt_allocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_allocations" ADD CONSTRAINT "receipt_allocations_receipt_fk" FOREIGN KEY ("tenant_id","customer_id","receipt_id") REFERENCES "public"."receipts"("tenant_id","customer_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_allocations" ADD CONSTRAINT "receipt_allocations_invoice_fk" FOREIGN KEY ("tenant_id","customer_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","customer_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_money_type" CHECK (NOT "ledger_accounts"."holds_money" OR "ledger_accounts"."type" = 'asset');--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_document_check" CHECK (("journal_entries"."source" IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery', 'sales_invoice', 'sales_receipt')) = ("journal_entries"."document_id" IS NOT NULL AND "journal_entries"."document_number" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_invoiced_check" CHECK ("sales_order_lines"."invoiced_quantity" BETWEEN 0 AND "sales_order_lines"."base_quantity");
