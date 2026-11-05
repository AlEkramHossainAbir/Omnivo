CREATE TABLE "bill_expenses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"account_id" uuid NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"tax_rate_id" uuid NOT NULL,
	"tax_rate_name" text NOT NULL,
	"tax_rate_kind" text NOT NULL,
	"tax_rate" numeric(5, 2) NOT NULL,
	"net" numeric(19, 4) NOT NULL,
	"vat" numeric(19, 4) NOT NULL,
	"total" numeric(19, 4) NOT NULL,
	CONSTRAINT "bill_expenses_description_check" CHECK (char_length("bill_expenses"."description") BETWEEN 2 AND 300),
	CONSTRAINT "bill_expenses_amounts_check" CHECK ("bill_expenses"."amount" > 0 AND "bill_expenses"."net" >= 0 AND "bill_expenses"."vat" >= 0 AND "bill_expenses"."total" = "bill_expenses"."net" + "bill_expenses"."vat"),
	CONSTRAINT "bill_expenses_tax_rate_check" CHECK ("bill_expenses"."tax_rate" >= 0 AND "bill_expenses"."tax_rate" < 100)
);
--> statement-breakpoint
CREATE TABLE "bill_lines" (
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
	"bill_id" uuid NOT NULL,
	"receipt_line_id" uuid,
	"order_line_id" uuid,
	"account_id" uuid,
	"lot_number" text,
	"expires_on" date,
	"manufactured_on" date,
	"serial_numbers" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "bill_lines_quantity_check" CHECK ("bill_lines"."quantity" > 0 AND "bill_lines"."factor" > 0 AND "bill_lines"."base_quantity" > 0),
	CONSTRAINT "bill_lines_amounts_check" CHECK ("bill_lines"."unit_price" >= 0 AND "bill_lines"."discount" >= 0 AND ("bill_lines"."discount_type" = 'amount' OR "bill_lines"."discount" <= 100) AND "bill_lines"."net" >= 0 AND "bill_lines"."vat" >= 0 AND "bill_lines"."total" = "bill_lines"."net" + "bill_lines"."vat"),
	CONSTRAINT "bill_lines_tax_rate_check" CHECK ("bill_lines"."tax_rate" >= 0 AND "bill_lines"."tax_rate" < 100),
	CONSTRAINT "bill_lines_source_check" CHECK (("bill_lines"."receipt_line_id" IS NULL OR "bill_lines"."account_id" IS NULL) AND ("bill_lines"."order_line_id" IS NULL OR ("bill_lines"."lot_number" IS NULL AND "bill_lines"."expires_on" IS NULL AND "bill_lines"."manufactured_on" IS NULL AND cardinality("bill_lines"."serial_numbers") = 0)))
);
--> statement-breakpoint
CREATE TABLE "bills" (
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
	"supplier_id" uuid NOT NULL,
	"supplier_bill_number" text NOT NULL,
	"mushak_number" text,
	"mushak_date" date,
	"branch_id" uuid NOT NULL,
	"warehouse_id" uuid,
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
	CONSTRAINT "bills_number_check" CHECK ("bills"."status" = 'draft' OR "bills"."number" IS NOT NULL),
	CONSTRAINT "bills_posted_check" CHECK (("bills"."status" = 'posted') = ("bills"."posted_at" IS NOT NULL)),
	CONSTRAINT "bills_due_date_check" CHECK ("bills"."due_date" >= "bills"."date"),
	CONSTRAINT "bills_supplier_number_check" CHECK (char_length(btrim("bills"."supplier_bill_number")) BETWEEN 1 AND 40 AND ("bills"."mushak_number" IS NULL OR char_length("bills"."mushak_number") BETWEEN 1 AND 40) AND ("bills"."mushak_date" IS NULL OR "bills"."mushak_number" IS NOT NULL)),
	CONSTRAINT "bills_totals_check" CHECK ("bills"."discount" >= 0 AND "bills"."net" >= 0 AND "bills"."vat" >= 0 AND "bills"."total" = "bills"."net" + "bills"."vat"),
	CONSTRAINT "bills_paid_check" CHECK ("bills"."amount_paid" >= 0 AND "bills"."amount_paid" <= "bills"."total" AND ("bills"."status" = 'posted' OR "bills"."amount_paid" = 0))
);
--> statement-breakpoint
CREATE TABLE "supplier_payment_allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	CONSTRAINT "supplier_payment_allocations_amount_check" CHECK ("supplier_payment_allocations"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "supplier_payments" (
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
	"supplier_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"applied" numeric(19, 4) DEFAULT '0' NOT NULL,
	"account_id" uuid NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"supplier_bank_account_id" uuid,
	"branch_id" uuid NOT NULL,
	"order_id" uuid,
	"note" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"void_date" date,
	"void_reason" text,
	CONSTRAINT "supplier_payments_number_check" CHECK ("supplier_payments"."status" = 'draft' OR "supplier_payments"."number" IS NOT NULL),
	CONSTRAINT "supplier_payments_posted_check" CHECK (("supplier_payments"."status" IN ('posted', 'voided')) = ("supplier_payments"."posted_at" IS NOT NULL)),
	CONSTRAINT "supplier_payments_amount_check" CHECK ("supplier_payments"."amount" > 0 AND "supplier_payments"."applied" >= 0 AND "supplier_payments"."applied" <= "supplier_payments"."amount"),
	CONSTRAINT "supplier_payments_void_check" CHECK (("supplier_payments"."status" = 'voided') = ("supplier_payments"."void_date" IS NOT NULL AND "supplier_payments"."void_reason" IS NOT NULL) AND ("supplier_payments"."status" <> 'voided' OR "supplier_payments"."applied" = 0) AND ("supplier_payments"."void_date" IS NULL OR "supplier_payments"."void_date" >= "supplier_payments"."date") AND ("supplier_payments"."void_reason" IS NULL OR char_length("supplier_payments"."void_reason") BETWEEN 1 AND 200))
);
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_document_check";--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ALTER COLUMN "order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ALTER COLUMN "order_line_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "goods_receipts" ALTER COLUMN "order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "purchase_price_difference_account_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "purchase_services_account_id" uuid;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD COLUMN "billed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD COLUMN "bill_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "bill_expenses_line_idx" ON "bill_expenses" USING btree ("tenant_id","bill_id","line_no");--> statement-breakpoint
CREATE INDEX "bill_expenses_account_idx" ON "bill_expenses" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bill_lines_line_idx" ON "bill_lines" USING btree ("tenant_id","bill_id","line_no");--> statement-breakpoint
CREATE INDEX "bill_lines_variant_idx" ON "bill_lines" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE INDEX "bill_lines_receipt_line_idx" ON "bill_lines" USING btree ("tenant_id","receipt_line_id") WHERE "bill_lines"."receipt_line_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "bill_lines_order_line_idx" ON "bill_lines" USING btree ("tenant_id","order_line_id") WHERE "bill_lines"."order_line_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "bill_lines_account_idx" ON "bill_lines" USING btree ("tenant_id","account_id") WHERE "bill_lines"."account_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bills_tenant_id_idx" ON "bills" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "bills_supplier_id_idx" ON "bills" USING btree ("tenant_id","supplier_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "bills_tenant_number_idx" ON "bills" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "bills_supplier_bill_number_idx" ON "bills" USING btree ("tenant_id","supplier_id",lower(btrim("supplier_bill_number"))) WHERE "bills"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "bills_tenant_date_idx" ON "bills" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "bills_supplier_idx" ON "bills" USING btree ("tenant_id","supplier_id","date","id");--> statement-breakpoint
CREATE INDEX "bills_open_supplier_idx" ON "bills" USING btree ("tenant_id","supplier_id","due_date","id") WHERE "bills"."status" = 'posted' AND "bills"."amount_paid" < "bills"."total";--> statement-breakpoint
CREATE INDEX "bills_open_due_idx" ON "bills" USING btree ("tenant_id","due_date","id") WHERE "bills"."status" = 'posted' AND "bills"."amount_paid" < "bills"."total";--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_payment_allocations_pair_idx" ON "supplier_payment_allocations" USING btree ("tenant_id","payment_id","bill_id");--> statement-breakpoint
CREATE INDEX "supplier_payment_allocations_bill_idx" ON "supplier_payment_allocations" USING btree ("tenant_id","bill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_payments_tenant_id_idx" ON "supplier_payments" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_payments_supplier_id_idx" ON "supplier_payments" USING btree ("tenant_id","supplier_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_payments_tenant_number_idx" ON "supplier_payments" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "supplier_payments_tenant_date_idx" ON "supplier_payments" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "supplier_payments_supplier_idx" ON "supplier_payments" USING btree ("tenant_id","supplier_id","date","id");--> statement-breakpoint
CREATE INDEX "supplier_payments_unapplied_idx" ON "supplier_payments" USING btree ("tenant_id","supplier_id","date","id") WHERE "supplier_payments"."status" = 'posted' AND "supplier_payments"."applied" < "supplier_payments"."amount";--> statement-breakpoint
CREATE INDEX "supplier_payments_order_idx" ON "supplier_payments" USING btree ("tenant_id","order_id") WHERE "supplier_payments"."order_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "supplier_payments_account_idx" ON "supplier_payments" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE INDEX "supplier_payments_bank_account_idx" ON "supplier_payments" USING btree ("tenant_id","supplier_bank_account_id") WHERE "supplier_payments"."supplier_bank_account_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_lines_bill_target_idx" ON "purchase_order_lines" USING btree ("tenant_id","id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipt_lines_bill_target_idx" ON "goods_receipt_lines" USING btree ("tenant_id","id","variant_id");--> statement-breakpoint
CREATE INDEX "goods_receipt_lines_to_bill_idx" ON "goods_receipt_lines" USING btree ("tenant_id","receipt_id") WHERE NOT "goods_receipt_lines"."billed" AND "goods_receipt_lines"."quantity" > 0;--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipts_bill_idx" ON "goods_receipts" USING btree ("tenant_id","bill_id") WHERE "goods_receipts"."bill_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_expenses" ADD CONSTRAINT "bill_expenses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_expenses" ADD CONSTRAINT "bill_expenses_bill_fk" FOREIGN KEY ("tenant_id","bill_id") REFERENCES "public"."bills"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_expenses" ADD CONSTRAINT "bill_expenses_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_expenses" ADD CONSTRAINT "bill_expenses_tax_rate_fk" FOREIGN KEY ("tenant_id","tax_rate_id") REFERENCES "public"."tax_rates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_bill_fk" FOREIGN KEY ("tenant_id","bill_id") REFERENCES "public"."bills"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_receipt_line_fk" FOREIGN KEY ("tenant_id","receipt_line_id","variant_id") REFERENCES "public"."goods_receipt_lines"("tenant_id","id","variant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_tax_rate_fk" FOREIGN KEY ("tenant_id","tax_rate_id") REFERENCES "public"."tax_rates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_payment_fk" FOREIGN KEY ("tenant_id","supplier_id","payment_id") REFERENCES "public"."supplier_payments"("tenant_id","supplier_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_bill_fk" FOREIGN KEY ("tenant_id","supplier_id","bill_id") REFERENCES "public"."bills"("tenant_id","supplier_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_order_fk" FOREIGN KEY ("tenant_id","supplier_id","order_id") REFERENCES "public"."purchase_orders"("tenant_id","supplier_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_price_difference_account_fk" FOREIGN KEY ("tenant_id","purchase_price_difference_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_services_account_fk" FOREIGN KEY ("tenant_id","purchase_services_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_receipt_id_fk" FOREIGN KEY ("tenant_id","receipt_id") REFERENCES "public"."goods_receipts"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_bill_fk" FOREIGN KEY ("tenant_id","supplier_id","bill_id") REFERENCES "public"."bills"("tenant_id","supplier_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_document_check" CHECK (("journal_entries"."source" IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery', 'sales_invoice', 'sales_receipt', 'sales_return', 'sales_credit_note', 'sales_refund', 'purchase_receipt', 'purchase_bill', 'purchase_payment')) = ("journal_entries"."document_id" IS NOT NULL AND "journal_entries"."document_number" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_order_check" CHECK (("goods_receipt_lines"."order_id" IS NULL) = ("goods_receipt_lines"."order_line_id" IS NULL));--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_billed_check" CHECK (NOT "goods_receipt_lines"."billed" OR "goods_receipt_lines"."quantity" > 0);--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_source_check" CHECK (("goods_receipts"."order_id" IS NULL) <> ("goods_receipts"."bill_id" IS NULL));