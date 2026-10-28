CREATE TABLE "pos_registers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"cash_account_id" uuid NOT NULL,
	"card_account_id" uuid,
	"bkash_account_id" uuid,
	"nagad_account_id" uuid,
	"max_discount_percent" numeric(5, 2) DEFAULT '0' NOT NULL,
	"paper_width" text NOT NULL,
	"receipt_footer" text,
	"device_id" uuid,
	"last_number" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "pos_registers_code_check" CHECK ("pos_registers"."code" ~ '^[A-Z][A-Z0-9]{1,7}$'),
	CONSTRAINT "pos_registers_discount_check" CHECK ("pos_registers"."max_discount_percent" BETWEEN 0 AND 100),
	CONSTRAINT "pos_registers_paper_check" CHECK ("pos_registers"."paper_width" IN ('58', '80')),
	CONSTRAINT "pos_registers_last_number_check" CHECK ("pos_registers"."last_number" >= 0),
	CONSTRAINT "pos_registers_archived_check" CHECK ("pos_registers"."archived_at" IS NULL OR "pos_registers"."device_id" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "pos_sale_line_batches" (
	"tenant_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	CONSTRAINT "pos_sale_line_batches_pkey" PRIMARY KEY("tenant_id","line_id","batch_id"),
	CONSTRAINT "pos_sale_line_batches_quantity_check" CHECK ("pos_sale_line_batches"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "pos_sale_lines" (
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
	"sale_id" uuid NOT NULL,
	"starting_price" numeric(19, 4),
	"bill_discount" numeric(19, 4) NOT NULL,
	"batch_id" uuid,
	"serial_numbers" text[] DEFAULT '{}'::text[] NOT NULL,
	"value" numeric(19, 4) NOT NULL,
	"short_quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	"short_serials" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "pos_sale_lines_quantity_check" CHECK ("pos_sale_lines"."quantity" > 0 AND "pos_sale_lines"."factor" > 0 AND "pos_sale_lines"."base_quantity" > 0),
	CONSTRAINT "pos_sale_lines_amounts_check" CHECK ("pos_sale_lines"."unit_price" >= 0 AND "pos_sale_lines"."discount" >= 0 AND ("pos_sale_lines"."discount_type" = 'amount' OR "pos_sale_lines"."discount" <= 100) AND "pos_sale_lines"."bill_discount" >= 0 AND "pos_sale_lines"."net" >= 0 AND "pos_sale_lines"."vat" >= 0 AND "pos_sale_lines"."total" = "pos_sale_lines"."net" + "pos_sale_lines"."vat"),
	CONSTRAINT "pos_sale_lines_starting_price_check" CHECK ("pos_sale_lines"."starting_price" IS NULL OR "pos_sale_lines"."starting_price" >= 0),
	CONSTRAINT "pos_sale_lines_tax_rate_check" CHECK ("pos_sale_lines"."tax_rate" >= 0 AND "pos_sale_lines"."tax_rate" < 100),
	CONSTRAINT "pos_sale_lines_value_check" CHECK ("pos_sale_lines"."value" >= 0),
	CONSTRAINT "pos_sale_lines_short_check" CHECK ("pos_sale_lines"."short_quantity" BETWEEN 0 AND "pos_sale_lines"."base_quantity" AND "pos_sale_lines"."short_serials" <@ "pos_sale_lines"."serial_numbers")
);
--> statement-breakpoint
CREATE TABLE "pos_sale_payments" (
	"tenant_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"method" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"reference" text,
	"account_id" uuid NOT NULL,
	CONSTRAINT "pos_sale_payments_pkey" PRIMARY KEY("tenant_id","sale_id","line_no"),
	CONSTRAINT "pos_sale_payments_method_check" CHECK ("pos_sale_payments"."method" IN ('cash', 'card', 'bkash', 'nagad')),
	CONSTRAINT "pos_sale_payments_amount_check" CHECK ("pos_sale_payments"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "pos_sales" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"number" text NOT NULL,
	"date" date NOT NULL,
	"sold_at" timestamp with time zone NOT NULL,
	"customer_id" uuid,
	"warehouse_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"prices_include_vat" boolean NOT NULL,
	"bill_discount_type" text NOT NULL,
	"bill_discount" numeric(19, 4) NOT NULL,
	"bill_discount_amount" numeric(19, 4) NOT NULL,
	"discount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"net" numeric(19, 4) DEFAULT '0' NOT NULL,
	"vat" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"paid" numeric(19, 4) NOT NULL,
	CONSTRAINT "pos_sales_sequence_check" CHECK ("pos_sales"."sequence" >= 1),
	CONSTRAINT "pos_sales_bill_discount_check" CHECK ("pos_sales"."bill_discount" >= 0 AND ("pos_sales"."bill_discount_type" = 'amount' OR "pos_sales"."bill_discount" <= 100) AND "pos_sales"."bill_discount_amount" >= 0),
	CONSTRAINT "pos_sales_totals_check" CHECK ("pos_sales"."discount" >= 0 AND "pos_sales"."net" >= 0 AND "pos_sales"."vat" >= 0 AND "pos_sales"."total" = "pos_sales"."net" + "pos_sales"."vat" AND "pos_sales"."paid" >= "pos_sales"."total")
);
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_document_check";--> statement-breakpoint
CREATE UNIQUE INDEX "pos_registers_tenant_code_idx" ON "pos_registers" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_registers_tenant_id_idx" ON "pos_registers" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "pos_registers_warehouse_idx" ON "pos_registers" USING btree ("tenant_id","warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_registers_device_idx" ON "pos_registers" USING btree ("tenant_id","device_id") WHERE "pos_registers"."device_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pos_sale_lines_line_idx" ON "pos_sale_lines" USING btree ("tenant_id","sale_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_sale_lines_variant_id_idx" ON "pos_sale_lines" USING btree ("tenant_id","variant_id","id");--> statement-breakpoint
CREATE INDEX "pos_sale_lines_variant_idx" ON "pos_sale_lines" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE INDEX "pos_sale_lines_short_idx" ON "pos_sale_lines" USING btree ("tenant_id","sale_id") WHERE "pos_sale_lines"."short_quantity" > 0 OR cardinality("pos_sale_lines"."short_serials") > 0;--> statement-breakpoint
CREATE INDEX "pos_sale_payments_account_idx" ON "pos_sale_payments" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_sales_tenant_id_idx" ON "pos_sales" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_sales_tenant_number_idx" ON "pos_sales" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_sales_register_sequence_idx" ON "pos_sales" USING btree ("tenant_id","register_id","sequence");--> statement-breakpoint
CREATE INDEX "pos_sales_tenant_date_idx" ON "pos_sales" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "pos_sales_register_idx" ON "pos_sales" USING btree ("tenant_id","register_id","date","id");--> statement-breakpoint
CREATE INDEX "pos_sales_customer_idx" ON "pos_sales" USING btree ("tenant_id","customer_id","date","id") WHERE "pos_sales"."customer_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_cash_account_fk" FOREIGN KEY ("tenant_id","cash_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_card_account_fk" FOREIGN KEY ("tenant_id","card_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_bkash_account_fk" FOREIGN KEY ("tenant_id","bkash_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_nagad_account_fk" FOREIGN KEY ("tenant_id","nagad_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_line_batches" ADD CONSTRAINT "pos_sale_line_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_line_batches" ADD CONSTRAINT "pos_sale_line_batches_line_fk" FOREIGN KEY ("tenant_id","variant_id","line_id") REFERENCES "public"."pos_sale_lines"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_line_batches" ADD CONSTRAINT "pos_sale_line_batches_batch_fk" FOREIGN KEY ("tenant_id","variant_id","batch_id") REFERENCES "public"."batches"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_lines" ADD CONSTRAINT "pos_sale_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_lines" ADD CONSTRAINT "pos_sale_lines_sale_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."pos_sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_lines" ADD CONSTRAINT "pos_sale_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_lines" ADD CONSTRAINT "pos_sale_lines_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_lines" ADD CONSTRAINT "pos_sale_lines_tax_rate_fk" FOREIGN KEY ("tenant_id","tax_rate_id") REFERENCES "public"."tax_rates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_lines" ADD CONSTRAINT "pos_sale_lines_batch_fk" FOREIGN KEY ("tenant_id","variant_id","batch_id") REFERENCES "public"."batches"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_payments" ADD CONSTRAINT "pos_sale_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_payments" ADD CONSTRAINT "pos_sale_payments_sale_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."pos_sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_payments" ADD CONSTRAINT "pos_sale_payments_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_register_fk" FOREIGN KEY ("tenant_id","register_id") REFERENCES "public"."pos_registers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_document_check" CHECK (("journal_entries"."source" IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery', 'sales_invoice', 'sales_receipt', 'sales_return', 'sales_credit_note', 'sales_refund', 'purchase_receipt', 'purchase_bill', 'purchase_payment', 'purchase_return', 'purchase_debit_note', 'purchase_refund', 'pos_sale')) = ("journal_entries"."document_id" IS NOT NULL AND "journal_entries"."document_number" IS NOT NULL));