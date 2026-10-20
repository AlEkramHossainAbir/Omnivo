CREATE TABLE "purchase_return_lines" (
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
	"receipt_line_id" uuid,
	"bill_id" uuid,
	"bill_line_id" uuid,
	"value" numeric(19, 4),
	"debited_quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "purchase_return_lines_quantity_check" CHECK ("purchase_return_lines"."quantity" > 0 AND "purchase_return_lines"."factor" > 0 AND "purchase_return_lines"."base_quantity" > 0),
	CONSTRAINT "purchase_return_lines_value_check" CHECK ("purchase_return_lines"."value" IS NULL OR "purchase_return_lines"."value" >= 0),
	CONSTRAINT "purchase_return_lines_billed_check" CHECK (("purchase_return_lines"."bill_id" IS NULL) = ("purchase_return_lines"."bill_line_id" IS NULL) AND ("purchase_return_lines"."bill_line_id" IS NULL OR "purchase_return_lines"."receipt_line_id" IS NOT NULL)),
	CONSTRAINT "purchase_return_lines_debited_check" CHECK ("purchase_return_lines"."debited_quantity" BETWEEN 0 AND "purchase_return_lines"."base_quantity" AND ("purchase_return_lines"."bill_line_id" IS NOT NULL OR "purchase_return_lines"."receipt_line_id" IS NULL OR "purchase_return_lines"."debited_quantity" = 0))
);
--> statement-breakpoint
CREATE TABLE "purchase_returns" (
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
	"warehouse_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	CONSTRAINT "purchase_returns_posted_check" CHECK (("purchase_returns"."status" = 'posted') = ("purchase_returns"."number" IS NOT NULL AND "purchase_returns"."posted_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "debit_note_allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"debit_note_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	CONSTRAINT "debit_note_allocations_amount_check" CHECK ("debit_note_allocations"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "debit_note_expenses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"debit_note_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"bill_expense_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"tax_rate_id" uuid NOT NULL,
	"tax_rate_name" text NOT NULL,
	"tax_rate_kind" text NOT NULL,
	"tax_rate" numeric(5, 2) NOT NULL,
	"net" numeric(19, 4) NOT NULL,
	"vat" numeric(19, 4) NOT NULL,
	"total" numeric(19, 4) NOT NULL,
	CONSTRAINT "debit_note_expenses_amounts_check" CHECK ("debit_note_expenses"."amount" > 0 AND "debit_note_expenses"."net" >= 0 AND "debit_note_expenses"."vat" >= 0 AND "debit_note_expenses"."total" = "debit_note_expenses"."net" + "debit_note_expenses"."vat"),
	CONSTRAINT "debit_note_expenses_tax_rate_check" CHECK ("debit_note_expenses"."tax_rate" >= 0 AND "debit_note_expenses"."tax_rate" < 100)
);
--> statement-breakpoint
CREATE TABLE "debit_note_lines" (
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
	"debit_note_id" uuid NOT NULL,
	"bill_id" uuid,
	"bill_line_id" uuid,
	"return_line_id" uuid,
	CONSTRAINT "debit_note_lines_quantity_check" CHECK ("debit_note_lines"."quantity" > 0 AND "debit_note_lines"."factor" > 0 AND "debit_note_lines"."base_quantity" > 0),
	CONSTRAINT "debit_note_lines_amounts_check" CHECK ("debit_note_lines"."unit_price" >= 0 AND "debit_note_lines"."discount" >= 0 AND ("debit_note_lines"."discount_type" = 'amount' OR "debit_note_lines"."discount" <= 100) AND "debit_note_lines"."net" >= 0 AND "debit_note_lines"."vat" >= 0 AND "debit_note_lines"."total" = "debit_note_lines"."net" + "debit_note_lines"."vat"),
	CONSTRAINT "debit_note_lines_tax_rate_check" CHECK ("debit_note_lines"."tax_rate" >= 0 AND "debit_note_lines"."tax_rate" < 100),
	CONSTRAINT "debit_note_lines_source_check" CHECK (("debit_note_lines"."bill_id" IS NULL) = ("debit_note_lines"."bill_line_id" IS NULL) AND ("debit_note_lines"."bill_line_id" IS NOT NULL OR "debit_note_lines"."return_line_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "debit_notes" (
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
	"bill_id" uuid,
	"branch_id" uuid NOT NULL,
	"prices_include_vat" boolean NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"supplier_credit_number" text,
	"supplier_credit_date" date,
	"note" text,
	"discount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"net" numeric(19, 4) DEFAULT '0' NOT NULL,
	"vat" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"applied" numeric(19, 4) DEFAULT '0' NOT NULL,
	"refunded" numeric(19, 4) DEFAULT '0' NOT NULL,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	CONSTRAINT "debit_notes_posted_check" CHECK (("debit_notes"."status" = 'posted') = ("debit_notes"."number" IS NOT NULL AND "debit_notes"."posted_at" IS NOT NULL)),
	CONSTRAINT "debit_notes_totals_check" CHECK ("debit_notes"."discount" >= 0 AND "debit_notes"."net" >= 0 AND "debit_notes"."vat" >= 0 AND "debit_notes"."total" = "debit_notes"."net" + "debit_notes"."vat"),
	CONSTRAINT "debit_notes_supplier_credit_check" CHECK (("debit_notes"."supplier_credit_number" IS NULL OR char_length("debit_notes"."supplier_credit_number") BETWEEN 1 AND 40) AND ("debit_notes"."supplier_credit_date" IS NULL OR "debit_notes"."supplier_credit_number" IS NOT NULL)),
	CONSTRAINT "debit_notes_money_check" CHECK ("debit_notes"."applied" >= 0 AND "debit_notes"."refunded" >= 0 AND "debit_notes"."applied" + "debit_notes"."refunded" <= "debit_notes"."total" AND ("debit_notes"."status" = 'posted' OR ("debit_notes"."applied" = 0 AND "debit_notes"."refunded" = 0)))
);
--> statement-breakpoint
CREATE TABLE "supplier_refunds" (
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
	"supplier_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"account_id" uuid NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"branch_id" uuid NOT NULL,
	"note" text,
	"debit_note_id" uuid,
	"payment_id" uuid,
	"status" text DEFAULT 'posted' NOT NULL,
	"void_date" date,
	"void_reason" text,
	CONSTRAINT "supplier_refunds_amount_check" CHECK ("supplier_refunds"."amount" > 0),
	CONSTRAINT "supplier_refunds_source_check" CHECK (("supplier_refunds"."debit_note_id" IS NULL) <> ("supplier_refunds"."payment_id" IS NULL)),
	CONSTRAINT "supplier_refunds_void_check" CHECK (("supplier_refunds"."status" = 'voided') = ("supplier_refunds"."void_date" IS NOT NULL AND "supplier_refunds"."void_reason" IS NOT NULL) AND ("supplier_refunds"."void_date" IS NULL OR "supplier_refunds"."void_date" >= "supplier_refunds"."date") AND ("supplier_refunds"."void_reason" IS NULL OR char_length("supplier_refunds"."void_reason") BETWEEN 1 AND 200))
);
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_document_check";--> statement-breakpoint
ALTER TABLE "bills" DROP CONSTRAINT "bills_paid_check";--> statement-breakpoint
ALTER TABLE "supplier_payments" DROP CONSTRAINT "supplier_payments_amount_check";--> statement-breakpoint
DROP INDEX "goods_receipt_lines_to_bill_idx";--> statement-breakpoint
DROP INDEX "bills_open_supplier_idx";--> statement-breakpoint
DROP INDEX "bills_open_due_idx";--> statement-breakpoint
DROP INDEX "supplier_payments_unapplied_idx";--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD COLUMN "returned_quantity" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_expenses" ADD COLUMN "debited" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD COLUMN "debited" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "amount_debited" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "debit_note_total" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD COLUMN "refunded" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_return_lines_line_idx" ON "purchase_return_lines" USING btree ("tenant_id","return_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_return_lines_variant_target_idx" ON "purchase_return_lines" USING btree ("tenant_id","id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_return_lines_bill_line_id_idx" ON "purchase_return_lines" USING btree ("tenant_id","bill_line_id","id");--> statement-breakpoint
CREATE INDEX "purchase_return_lines_variant_idx" ON "purchase_return_lines" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE INDEX "purchase_return_lines_receipt_line_idx" ON "purchase_return_lines" USING btree ("tenant_id","receipt_line_id") WHERE "purchase_return_lines"."receipt_line_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_returns_tenant_id_idx" ON "purchase_returns" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_returns_tenant_number_idx" ON "purchase_returns" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "purchase_returns_tenant_date_idx" ON "purchase_returns" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "purchase_returns_supplier_idx" ON "purchase_returns" USING btree ("tenant_id","supplier_id","date","id");--> statement-breakpoint
CREATE INDEX "purchase_returns_warehouse_idx" ON "purchase_returns" USING btree ("tenant_id","warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "debit_note_allocations_pair_idx" ON "debit_note_allocations" USING btree ("tenant_id","debit_note_id","bill_id");--> statement-breakpoint
CREATE INDEX "debit_note_allocations_bill_idx" ON "debit_note_allocations" USING btree ("tenant_id","bill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "debit_note_expenses_expense_idx" ON "debit_note_expenses" USING btree ("tenant_id","debit_note_id","bill_expense_id");--> statement-breakpoint
CREATE INDEX "debit_note_expenses_bill_expense_idx" ON "debit_note_expenses" USING btree ("tenant_id","bill_id","bill_expense_id");--> statement-breakpoint
CREATE UNIQUE INDEX "debit_note_lines_line_idx" ON "debit_note_lines" USING btree ("tenant_id","debit_note_id","line_no");--> statement-breakpoint
CREATE INDEX "debit_note_lines_variant_idx" ON "debit_note_lines" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE INDEX "debit_note_lines_bill_line_idx" ON "debit_note_lines" USING btree ("tenant_id","bill_id","bill_line_id") WHERE "debit_note_lines"."bill_line_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "debit_note_lines_return_line_idx" ON "debit_note_lines" USING btree ("tenant_id","return_line_id") WHERE "debit_note_lines"."return_line_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "debit_notes_tenant_id_idx" ON "debit_notes" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "debit_notes_supplier_id_idx" ON "debit_notes" USING btree ("tenant_id","supplier_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "debit_notes_bill_id_idx" ON "debit_notes" USING btree ("tenant_id","bill_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "debit_notes_tenant_number_idx" ON "debit_notes" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "debit_notes_tenant_date_idx" ON "debit_notes" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "debit_notes_supplier_idx" ON "debit_notes" USING btree ("tenant_id","supplier_id","date","id");--> statement-breakpoint
CREATE INDEX "debit_notes_unapplied_idx" ON "debit_notes" USING btree ("tenant_id","supplier_id","date","id") WHERE "debit_notes"."status" = 'posted' AND "debit_notes"."applied" + "debit_notes"."refunded" < "debit_notes"."total";--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_refunds_tenant_id_idx" ON "supplier_refunds" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_refunds_tenant_number_idx" ON "supplier_refunds" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "supplier_refunds_tenant_date_idx" ON "supplier_refunds" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "supplier_refunds_supplier_idx" ON "supplier_refunds" USING btree ("tenant_id","supplier_id","date","id");--> statement-breakpoint
CREATE INDEX "supplier_refunds_account_idx" ON "supplier_refunds" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE INDEX "supplier_refunds_debit_note_idx" ON "supplier_refunds" USING btree ("tenant_id","debit_note_id") WHERE "supplier_refunds"."debit_note_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "supplier_refunds_payment_idx" ON "supplier_refunds" USING btree ("tenant_id","payment_id") WHERE "supplier_refunds"."payment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bill_expenses_bill_id_idx" ON "bill_expenses" USING btree ("tenant_id","bill_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "bill_lines_variant_target_idx" ON "bill_lines" USING btree ("tenant_id","bill_id","id","variant_id");--> statement-breakpoint
CREATE INDEX "goods_receipt_lines_to_bill_idx" ON "goods_receipt_lines" USING btree ("tenant_id","receipt_id") WHERE NOT "goods_receipt_lines"."billed" AND "goods_receipt_lines"."returned_quantity" < "goods_receipt_lines"."base_quantity";--> statement-breakpoint
CREATE INDEX "bills_open_supplier_idx" ON "bills" USING btree ("tenant_id","supplier_id","due_date","id") WHERE "bills"."status" = 'posted' AND "bills"."amount_paid" + "bills"."amount_debited" < "bills"."total";--> statement-breakpoint
CREATE INDEX "bills_open_due_idx" ON "bills" USING btree ("tenant_id","due_date","id") WHERE "bills"."status" = 'posted' AND "bills"."amount_paid" + "bills"."amount_debited" < "bills"."total";--> statement-breakpoint
CREATE INDEX "supplier_payments_unapplied_idx" ON "supplier_payments" USING btree ("tenant_id","supplier_id","date","id") WHERE "supplier_payments"."status" = 'posted' AND "supplier_payments"."applied" + "supplier_payments"."refunded" < "supplier_payments"."amount";--> statement-breakpoint
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_return_fk" FOREIGN KEY ("tenant_id","return_id") REFERENCES "public"."purchase_returns"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_receipt_line_fk" FOREIGN KEY ("tenant_id","receipt_line_id","variant_id") REFERENCES "public"."goods_receipt_lines"("tenant_id","id","variant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_bill_line_fk" FOREIGN KEY ("tenant_id","bill_id","bill_line_id","variant_id") REFERENCES "public"."bill_lines"("tenant_id","bill_id","id","variant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_batch_fk" FOREIGN KEY ("tenant_id","variant_id","batch_id") REFERENCES "public"."batches"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_note_allocations" ADD CONSTRAINT "debit_note_allocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_note_allocations" ADD CONSTRAINT "debit_note_allocations_debit_note_fk" FOREIGN KEY ("tenant_id","supplier_id","debit_note_id") REFERENCES "public"."debit_notes"("tenant_id","supplier_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_note_allocations" ADD CONSTRAINT "debit_note_allocations_bill_fk" FOREIGN KEY ("tenant_id","supplier_id","bill_id") REFERENCES "public"."bills"("tenant_id","supplier_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_note_expenses" ADD CONSTRAINT "debit_note_expenses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_note_expenses" ADD CONSTRAINT "debit_note_expenses_debit_note_fk" FOREIGN KEY ("tenant_id","bill_id","debit_note_id") REFERENCES "public"."debit_notes"("tenant_id","bill_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_note_expenses" ADD CONSTRAINT "debit_note_expenses_bill_expense_fk" FOREIGN KEY ("tenant_id","bill_id","bill_expense_id") REFERENCES "public"."bill_expenses"("tenant_id","bill_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_note_expenses" ADD CONSTRAINT "debit_note_expenses_tax_rate_fk" FOREIGN KEY ("tenant_id","tax_rate_id") REFERENCES "public"."tax_rates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_note_lines" ADD CONSTRAINT "debit_note_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_note_lines" ADD CONSTRAINT "debit_note_lines_debit_note_id_fk" FOREIGN KEY ("tenant_id","debit_note_id") REFERENCES "public"."debit_notes"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_note_lines" ADD CONSTRAINT "debit_note_lines_debit_note_fk" FOREIGN KEY ("tenant_id","bill_id","debit_note_id") REFERENCES "public"."debit_notes"("tenant_id","bill_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_note_lines" ADD CONSTRAINT "debit_note_lines_bill_line_fk" FOREIGN KEY ("tenant_id","bill_id","bill_line_id","variant_id") REFERENCES "public"."bill_lines"("tenant_id","bill_id","id","variant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_note_lines" ADD CONSTRAINT "debit_note_lines_return_line_fk" FOREIGN KEY ("tenant_id","return_line_id","variant_id") REFERENCES "public"."purchase_return_lines"("tenant_id","id","variant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_note_lines" ADD CONSTRAINT "debit_note_lines_return_bill_line_fk" FOREIGN KEY ("tenant_id","bill_line_id","return_line_id") REFERENCES "public"."purchase_return_lines"("tenant_id","bill_line_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_note_lines" ADD CONSTRAINT "debit_note_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_note_lines" ADD CONSTRAINT "debit_note_lines_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_note_lines" ADD CONSTRAINT "debit_note_lines_tax_rate_fk" FOREIGN KEY ("tenant_id","tax_rate_id") REFERENCES "public"."tax_rates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_bill_fk" FOREIGN KEY ("tenant_id","supplier_id","bill_id") REFERENCES "public"."bills"("tenant_id","supplier_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_refunds" ADD CONSTRAINT "supplier_refunds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_refunds" ADD CONSTRAINT "supplier_refunds_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_refunds" ADD CONSTRAINT "supplier_refunds_debit_note_fk" FOREIGN KEY ("tenant_id","supplier_id","debit_note_id") REFERENCES "public"."debit_notes"("tenant_id","supplier_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_refunds" ADD CONSTRAINT "supplier_refunds_payment_fk" FOREIGN KEY ("tenant_id","supplier_id","payment_id") REFERENCES "public"."supplier_payments"("tenant_id","supplier_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_refunds" ADD CONSTRAINT "supplier_refunds_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_refunds" ADD CONSTRAINT "supplier_refunds_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_document_check" CHECK (("journal_entries"."source" IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery', 'sales_invoice', 'sales_receipt', 'sales_return', 'sales_credit_note', 'sales_refund', 'purchase_receipt', 'purchase_bill', 'purchase_payment', 'purchase_return', 'purchase_debit_note', 'purchase_refund')) = ("journal_entries"."document_id" IS NOT NULL AND "journal_entries"."document_number" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_returned_check" CHECK ("goods_receipt_lines"."returned_quantity" BETWEEN 0 AND "goods_receipt_lines"."base_quantity");--> statement-breakpoint
ALTER TABLE "bill_expenses" ADD CONSTRAINT "bill_expenses_debited_check" CHECK ("bill_expenses"."debited" BETWEEN 0 AND "bill_expenses"."total");--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_debited_check" CHECK ("bill_lines"."debited" BETWEEN 0 AND "bill_lines"."total");--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_debited_check" CHECK ("bills"."debit_note_total" >= 0 AND "bills"."debit_note_total" <= "bills"."total" AND ("bills"."status" = 'posted' OR "bills"."debit_note_total" = 0));--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_paid_check" CHECK ("bills"."amount_paid" >= 0 AND "bills"."amount_debited" >= 0 AND "bills"."amount_paid" + "bills"."amount_debited" <= "bills"."total" AND ("bills"."status" = 'posted' OR ("bills"."amount_paid" = 0 AND "bills"."amount_debited" = 0)));--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_amount_check" CHECK ("supplier_payments"."amount" > 0 AND "supplier_payments"."applied" >= 0 AND "supplier_payments"."refunded" >= 0 AND "supplier_payments"."applied" + "supplier_payments"."refunded" <= "supplier_payments"."amount" AND ("supplier_payments"."status" = 'posted' OR "supplier_payments"."refunded" = 0));