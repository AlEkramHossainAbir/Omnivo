CREATE TABLE "pos_cash_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"reason_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"note" text,
	"date" date NOT NULL,
	"moved_at" timestamp with time zone NOT NULL,
	"account_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	CONSTRAINT "pos_cash_movements_amount_check" CHECK ("pos_cash_movements"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "pos_cash_reasons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"direction" text NOT NULL,
	"account_id" uuid NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "pos_cash_reasons_direction_check" CHECK ("pos_cash_reasons"."direction" IN ('in', 'out'))
);
--> statement-breakpoint
CREATE TABLE "pos_shifts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"number" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"opening_date" date NOT NULL,
	"opening_notes" jsonb,
	"opening_cash" numeric(19, 4) NOT NULL,
	"opening_compared_with" numeric(19, 4),
	"float_reason_id" uuid,
	"opening_entry_id" uuid,
	"closed_at" timestamp with time zone,
	"closing_date" date,
	"closing_notes" jsonb,
	"counted_cash" numeric(19, 4),
	"device_expected" numeric(19, 4),
	"held_dropped" smallint,
	"expected_cash" numeric(19, 4),
	"closing_entry_id" uuid,
	"closed_by" uuid,
	CONSTRAINT "pos_shifts_sequence_check" CHECK ("pos_shifts"."sequence" >= 1),
	CONSTRAINT "pos_shifts_status_check" CHECK (("pos_shifts"."status" = 'open' AND "pos_shifts"."closed_at" IS NULL AND "pos_shifts"."closing_date" IS NULL AND "pos_shifts"."closing_notes" IS NULL AND "pos_shifts"."counted_cash" IS NULL AND "pos_shifts"."device_expected" IS NULL AND "pos_shifts"."held_dropped" IS NULL AND "pos_shifts"."expected_cash" IS NULL AND "pos_shifts"."closing_entry_id" IS NULL AND "pos_shifts"."closed_by" IS NULL)
      OR ("pos_shifts"."status" = 'closed' AND "pos_shifts"."closed_at" IS NOT NULL AND "pos_shifts"."closing_date" IS NOT NULL AND "pos_shifts"."counted_cash" IS NOT NULL AND "pos_shifts"."device_expected" IS NOT NULL AND "pos_shifts"."held_dropped" IS NOT NULL AND "pos_shifts"."expected_cash" IS NOT NULL AND "pos_shifts"."closed_by" IS NULL)
      OR ("pos_shifts"."status" = 'closed_without_count' AND "pos_shifts"."closed_at" IS NOT NULL AND "pos_shifts"."closing_date" IS NULL AND "pos_shifts"."closing_notes" IS NULL AND "pos_shifts"."counted_cash" IS NULL AND "pos_shifts"."device_expected" IS NULL AND "pos_shifts"."held_dropped" IS NULL AND "pos_shifts"."expected_cash" IS NOT NULL AND "pos_shifts"."closing_entry_id" IS NULL AND "pos_shifts"."closed_by" IS NOT NULL)),
	CONSTRAINT "pos_shifts_cash_check" CHECK ("pos_shifts"."opening_cash" >= 0 AND "pos_shifts"."counted_cash" >= 0 AND "pos_shifts"."held_dropped" BETWEEN 0 AND 20),
	CONSTRAINT "pos_shifts_notes_check" CHECK (jsonb_typeof("pos_shifts"."opening_notes") = 'object' AND jsonb_typeof("pos_shifts"."closing_notes") = 'object'),
	CONSTRAINT "pos_shifts_float_check" CHECK ("pos_shifts"."float_reason_id" IS NULL OR "pos_shifts"."opening_compared_with" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_document_check";--> statement-breakpoint
ALTER TABLE "pos_registers" ADD COLUMN "over_short_account_id" uuid;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD COLUMN "variance_alert" numeric(12, 0) DEFAULT '500' NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD COLUMN "lock_after" text DEFAULT '5' NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD COLUMN "shift_id" uuid;--> statement-breakpoint
CREATE INDEX "pos_cash_movements_shift_idx" ON "pos_cash_movements" USING btree ("tenant_id","shift_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_cash_movements_entry_idx" ON "pos_cash_movements" USING btree ("tenant_id","entry_id");--> statement-breakpoint
CREATE INDEX "pos_cash_movements_account_idx" ON "pos_cash_movements" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_cash_reasons_tenant_name_idx" ON "pos_cash_reasons" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "pos_cash_reasons_tenant_id_idx" ON "pos_cash_reasons" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_cash_reasons_direction_idx" ON "pos_cash_reasons" USING btree ("tenant_id","id","direction");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_shifts_tenant_id_idx" ON "pos_shifts" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_shifts_sale_key_idx" ON "pos_shifts" USING btree ("tenant_id","id","register_id","device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_shifts_register_sequence_idx" ON "pos_shifts" USING btree ("tenant_id","register_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_shifts_tenant_number_idx" ON "pos_shifts" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_shifts_register_open_idx" ON "pos_shifts" USING btree ("tenant_id","register_id") WHERE "pos_shifts"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "pos_shifts_device_open_idx" ON "pos_shifts" USING btree ("tenant_id","device_id") WHERE "pos_shifts"."status" = 'open';--> statement-breakpoint
CREATE INDEX "pos_shifts_tenant_opened_idx" ON "pos_shifts" USING btree ("tenant_id","opened_at","id");--> statement-breakpoint
CREATE INDEX "pos_shifts_register_opened_idx" ON "pos_shifts" USING btree ("tenant_id","register_id","opened_at","id");--> statement-breakpoint
CREATE INDEX "pos_sales_shift_idx" ON "pos_sales" USING btree ("tenant_id","shift_id") WHERE "pos_sales"."shift_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_cash_movements" ADD CONSTRAINT "pos_cash_movements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_cash_movements" ADD CONSTRAINT "pos_cash_movements_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."pos_shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_cash_movements" ADD CONSTRAINT "pos_cash_movements_reason_fk" FOREIGN KEY ("tenant_id","reason_id","direction") REFERENCES "public"."pos_cash_reasons"("tenant_id","id","direction") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_cash_movements" ADD CONSTRAINT "pos_cash_movements_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_cash_movements" ADD CONSTRAINT "pos_cash_movements_entry_fk" FOREIGN KEY ("tenant_id","entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_cash_reasons" ADD CONSTRAINT "pos_cash_reasons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_cash_reasons" ADD CONSTRAINT "pos_cash_reasons_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_register_fk" FOREIGN KEY ("tenant_id","register_id") REFERENCES "public"."pos_registers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_float_reason_fk" FOREIGN KEY ("tenant_id","float_reason_id") REFERENCES "public"."pos_cash_reasons"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_opening_entry_fk" FOREIGN KEY ("tenant_id","opening_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_closing_entry_fk" FOREIGN KEY ("tenant_id","closing_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_over_short_account_fk" FOREIGN KEY ("tenant_id","over_short_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_shift_fk" FOREIGN KEY ("tenant_id","shift_id","register_id","device_id") REFERENCES "public"."pos_shifts"("tenant_id","id","register_id","device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_document_check" CHECK (("journal_entries"."source" IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery', 'sales_invoice', 'sales_receipt', 'sales_return', 'sales_credit_note', 'sales_refund', 'purchase_receipt', 'purchase_bill', 'purchase_payment', 'purchase_return', 'purchase_debit_note', 'purchase_refund', 'pos_sale', 'pos_shift')) = ("journal_entries"."document_id" IS NOT NULL AND "journal_entries"."document_number" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_variance_alert_check" CHECK ("pos_registers"."variance_alert" >= 0);--> statement-breakpoint
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_lock_after_check" CHECK ("pos_registers"."lock_after" IN ('off', '2', '5', '10', '15'));
