CREATE TABLE "stock_values" (
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	"value" numeric(19, 4) DEFAULT '0' NOT NULL,
	"unit_cost" numeric(19, 4),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_values_key" UNIQUE("tenant_id","variant_id")
);--> statement-breakpoint
CREATE TABLE "stock_accounts" (
	"tenant_id" uuid NOT NULL,
	"use" text NOT NULL,
	"account_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "stock_accounts_pkey" PRIMARY KEY("tenant_id","use")
);--> statement-breakpoint
CREATE TABLE "stock_revaluation_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"revaluation_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"old_unit_cost" numeric(19, 4),
	"old_value" numeric(19, 4) NOT NULL,
	"unit_cost" numeric(19, 4) NOT NULL,
	"new_value" numeric(19, 4) NOT NULL,
	CONSTRAINT "stock_revaluation_lines_values_check" CHECK ("stock_revaluation_lines"."quantity" > 0 AND "stock_revaluation_lines"."unit_cost" >= 0 AND "stock_revaluation_lines"."new_value" >= 0)
);--> statement-breakpoint
CREATE TABLE "stock_revaluations" (
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
	"note" text,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_by" uuid
);--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_quantity_check";--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "document_number" text;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "value" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD COLUMN "unit_cost" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD COLUMN "value" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD COLUMN "value" numeric(19, 4);--> statement-breakpoint
CREATE INDEX "stock_accounts_account_idx" ON "stock_accounts" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_revaluation_lines_line_idx" ON "stock_revaluation_lines" USING btree ("tenant_id","revaluation_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_revaluation_lines_variant_idx" ON "stock_revaluation_lines" USING btree ("tenant_id","revaluation_id","variant_id");--> statement-breakpoint
CREATE INDEX "stock_revaluation_lines_product_idx" ON "stock_revaluation_lines" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_revaluations_tenant_id_idx" ON "stock_revaluations" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_revaluations_tenant_number_idx" ON "stock_revaluations" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "stock_revaluations_tenant_date_idx" ON "stock_revaluations" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "journal_entries_document_idx" ON "journal_entries" USING btree ("tenant_id","document_id") WHERE "journal_entries"."document_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_values" ADD CONSTRAINT "stock_values_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_values" ADD CONSTRAINT "stock_values_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_accounts" ADD CONSTRAINT "stock_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_accounts" ADD CONSTRAINT "stock_accounts_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_revaluation_lines" ADD CONSTRAINT "stock_revaluation_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_revaluation_lines" ADD CONSTRAINT "stock_revaluation_lines_revaluation_fk" FOREIGN KEY ("tenant_id","revaluation_id") REFERENCES "public"."stock_revaluations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_revaluation_lines" ADD CONSTRAINT "stock_revaluation_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_revaluations" ADD CONSTRAINT "stock_revaluations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_document_check" CHECK (("journal_entries"."source" IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation')) = ("journal_entries"."document_id" IS NOT NULL AND "journal_entries"."document_number" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_quantity_check" CHECK (("stock_movements"."kind" = 'revaluation') = ("stock_movements"."quantity" = 0));--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_value_check" CHECK (("stock_adjustment_lines"."unit_cost" IS NULL OR "stock_adjustment_lines"."unit_cost" >= 0) AND ("stock_adjustment_lines"."value" IS NULL OR "stock_adjustment_lines"."value" >= 0));
