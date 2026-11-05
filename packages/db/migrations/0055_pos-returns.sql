CREATE TABLE "pos_return_line_batches" (
	"tenant_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"sale_line_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	CONSTRAINT "pos_return_line_batches_pkey" PRIMARY KEY("tenant_id","line_id","batch_id"),
	CONSTRAINT "pos_return_line_batches_quantity_check" CHECK ("pos_return_line_batches"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "pos_return_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"return_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"sale_line_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"base_quantity" numeric(19, 4) NOT NULL,
	"net" numeric(19, 4) NOT NULL,
	"vat" numeric(19, 4) NOT NULL,
	"total" numeric(19, 4) NOT NULL,
	"value" numeric(19, 4) NOT NULL,
	"serial_numbers" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "pos_return_lines_quantity_check" CHECK ("pos_return_lines"."quantity" > 0 AND "pos_return_lines"."base_quantity" > 0),
	CONSTRAINT "pos_return_lines_amounts_check" CHECK ("pos_return_lines"."net" >= 0 AND "pos_return_lines"."vat" >= 0 AND "pos_return_lines"."total" = "pos_return_lines"."net" + "pos_return_lines"."vat" AND "pos_return_lines"."value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pos_return_refunds" (
	"tenant_id" uuid NOT NULL,
	"return_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"method" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"reference" text,
	"account_id" uuid NOT NULL,
	CONSTRAINT "pos_return_refunds_pkey" PRIMARY KEY("tenant_id","return_id","line_no"),
	CONSTRAINT "pos_return_refunds_method_check" CHECK ("pos_return_refunds"."method" IN ('cash', 'card', 'bkash', 'nagad', 'exchange')),
	CONSTRAINT "pos_return_refunds_amount_check" CHECK ("pos_return_refunds"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "pos_returns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"number" text NOT NULL,
	"date" date NOT NULL,
	"returned_at" timestamp with time zone NOT NULL,
	"sale_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"net" numeric(19, 4) NOT NULL,
	"vat" numeric(19, 4) NOT NULL,
	"total" numeric(19, 4) NOT NULL,
	"note" text,
	"outside_window" boolean DEFAULT false NOT NULL,
	CONSTRAINT "pos_returns_sequence_check" CHECK ("pos_returns"."sequence" >= 1),
	CONSTRAINT "pos_returns_totals_check" CHECK ("pos_returns"."net" >= 0 AND "pos_returns"."vat" >= 0 AND "pos_returns"."total" = "pos_returns"."net" + "pos_returns"."vat")
);
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_document_check";--> statement-breakpoint
ALTER TABLE "pos_registers" DROP CONSTRAINT "pos_registers_last_number_check";--> statement-breakpoint
ALTER TABLE "pos_sale_payments" DROP CONSTRAINT "pos_sale_payments_method_check";--> statement-breakpoint
ALTER TABLE "pos_registers" ADD COLUMN "exchange_account_id" uuid;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD COLUMN "return_days" smallint DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD COLUMN "last_return_number" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_sale_payments" ADD COLUMN "return_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "pos_return_lines_line_idx" ON "pos_return_lines" USING btree ("tenant_id","return_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_return_lines_sale_line_idx" ON "pos_return_lines" USING btree ("tenant_id","return_id","sale_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_return_lines_batch_key_idx" ON "pos_return_lines" USING btree ("tenant_id","id","sale_line_id");--> statement-breakpoint
CREATE INDEX "pos_return_lines_returned_idx" ON "pos_return_lines" USING btree ("tenant_id","sale_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_return_refunds_exchange_idx" ON "pos_return_refunds" USING btree ("tenant_id","return_id") WHERE "pos_return_refunds"."method" = 'exchange';--> statement-breakpoint
CREATE INDEX "pos_return_refunds_account_idx" ON "pos_return_refunds" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_returns_tenant_id_idx" ON "pos_returns" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_returns_tenant_number_idx" ON "pos_returns" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_returns_register_sequence_idx" ON "pos_returns" USING btree ("tenant_id","register_id","sequence");--> statement-breakpoint
CREATE INDEX "pos_returns_tenant_date_idx" ON "pos_returns" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "pos_returns_register_idx" ON "pos_returns" USING btree ("tenant_id","register_id","date","id");--> statement-breakpoint
CREATE INDEX "pos_returns_sale_idx" ON "pos_returns" USING btree ("tenant_id","sale_id");--> statement-breakpoint
CREATE INDEX "pos_returns_shift_idx" ON "pos_returns" USING btree ("tenant_id","shift_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_sale_payments_return_idx" ON "pos_sale_payments" USING btree ("tenant_id","return_id") WHERE "pos_sale_payments"."return_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_return_line_batches" ADD CONSTRAINT "pos_return_line_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_return_line_batches" ADD CONSTRAINT "pos_return_line_batches_line_fk" FOREIGN KEY ("tenant_id","line_id","sale_line_id") REFERENCES "public"."pos_return_lines"("tenant_id","id","sale_line_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_return_line_batches" ADD CONSTRAINT "pos_return_line_batches_sale_batch_fk" FOREIGN KEY ("tenant_id","sale_line_id","batch_id") REFERENCES "public"."pos_sale_line_batches"("tenant_id","line_id","batch_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_return_lines" ADD CONSTRAINT "pos_return_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_return_lines" ADD CONSTRAINT "pos_return_lines_return_fk" FOREIGN KEY ("tenant_id","return_id") REFERENCES "public"."pos_returns"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_return_lines" ADD CONSTRAINT "pos_return_lines_sale_line_fk" FOREIGN KEY ("tenant_id","variant_id","sale_line_id") REFERENCES "public"."pos_sale_lines"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_return_refunds" ADD CONSTRAINT "pos_return_refunds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_return_refunds" ADD CONSTRAINT "pos_return_refunds_return_fk" FOREIGN KEY ("tenant_id","return_id") REFERENCES "public"."pos_returns"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_return_refunds" ADD CONSTRAINT "pos_return_refunds_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_register_fk" FOREIGN KEY ("tenant_id","register_id") REFERENCES "public"."pos_registers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_shift_fk" FOREIGN KEY ("tenant_id","shift_id","register_id","device_id") REFERENCES "public"."pos_shifts"("tenant_id","id","register_id","device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_sale_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."pos_sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_exchange_account_fk" FOREIGN KEY ("tenant_id","exchange_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_payments" ADD CONSTRAINT "pos_sale_payments_return_fk" FOREIGN KEY ("tenant_id","return_id") REFERENCES "public"."pos_returns"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_document_check" CHECK (("journal_entries"."source" IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery', 'sales_invoice', 'sales_receipt', 'sales_return', 'sales_credit_note', 'sales_refund', 'purchase_receipt', 'purchase_bill', 'purchase_payment', 'purchase_return', 'purchase_debit_note', 'purchase_refund', 'pos_sale', 'pos_shift', 'pos_return')) = ("journal_entries"."document_id" IS NOT NULL AND "journal_entries"."document_number" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_return_days_check" CHECK ("pos_registers"."return_days" BETWEEN 0 AND 365);--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_last_number_check" CHECK ("pos_registers"."last_number" >= 0 AND "pos_registers"."last_return_number" >= 0);--> statement-breakpoint
ALTER TABLE "pos_sale_payments" ADD CONSTRAINT "pos_sale_payments_method_check" CHECK ("pos_sale_payments"."method" IN ('cash', 'card', 'bkash', 'nagad', 'exchange') AND ("pos_sale_payments"."method" = 'exchange') = ("pos_sale_payments"."return_id" IS NOT NULL));