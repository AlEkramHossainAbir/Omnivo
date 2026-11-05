CREATE TABLE "party_bank_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"bank_name" text NOT NULL,
	"branch_name" text,
	"account_name" text NOT NULL,
	"account_number" text NOT NULL,
	"routing_number" text,
	CONSTRAINT "party_bank_accounts_number_check" CHECK ("party_bank_accounts"."account_number" ~ '^[0-9]{6,20}$' AND ("party_bank_accounts"."routing_number" IS NULL OR "party_bank_accounts"."routing_number" ~ '^[0-9]{9}$'))
);
--> statement-breakpoint
CREATE TABLE "supplier_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_levels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"min_amount" numeric(19, 4) NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "approval_levels_position_check" CHECK ("approval_levels"."position" BETWEEN 1 AND 5),
	CONSTRAINT "approval_levels_amount_check" CHECK ("approval_levels"."min_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "approval_rounds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document" text NOT NULL,
	"document_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"submitted_by" uuid NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "approval_rounds_amount_check" CHECK ("approval_rounds"."amount" >= 0),
	CONSTRAINT "approval_rounds_closed_check" CHECK (("approval_rounds"."status" = 'pending') = ("approval_rounds"."closed_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "approval_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"document" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_steps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"min_amount" numeric(19, 4) NOT NULL,
	"role_id" uuid,
	"role_name" text NOT NULL,
	"decision" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"comment" text,
	CONSTRAINT "approval_steps_position_check" CHECK ("approval_steps"."position" BETWEEN 1 AND 5),
	CONSTRAINT "approval_steps_amount_check" CHECK ("approval_steps"."min_amount" >= 0),
	CONSTRAINT "approval_steps_decided_check" CHECK (("approval_steps"."decision" IS NULL AND "approval_steps"."decided_by" IS NULL AND "approval_steps"."decided_at" IS NULL) OR ("approval_steps"."decision" IS NOT NULL AND "approval_steps"."decided_by" IS NOT NULL AND "approval_steps"."decided_at" IS NOT NULL)),
	CONSTRAINT "approval_steps_comment_check" CHECK (("approval_steps"."decision" IS DISTINCT FROM 'rejected' OR "approval_steps"."comment" IS NOT NULL) AND ("approval_steps"."comment" IS NULL OR ("approval_steps"."decision" IS NOT NULL AND char_length("approval_steps"."comment") BETWEEN 1 AND 500)))
);
--> statement-breakpoint
CREATE TABLE "requisition_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requisition_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"factor" numeric(19, 6) NOT NULL,
	"base_quantity" numeric(19, 4) NOT NULL,
	"description" text NOT NULL,
	"estimated_cost" numeric(19, 4) NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	CONSTRAINT "requisition_lines_quantity_check" CHECK ("requisition_lines"."quantity" > 0 AND "requisition_lines"."factor" > 0 AND "requisition_lines"."base_quantity" > 0),
	CONSTRAINT "requisition_lines_amount_check" CHECK ("requisition_lines"."estimated_cost" >= 0 AND "requisition_lines"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "requisitions" (
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
	"needed_by" date,
	"warehouse_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"note" text,
	"requested_by" uuid NOT NULL,
	CONSTRAINT "requisitions_needed_by_check" CHECK ("requisitions"."needed_by" IS NULL OR "requisitions"."needed_by" >= "requisitions"."date"),
	CONSTRAINT "requisitions_amount_check" CHECK ("requisitions"."amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "parties" DROP CONSTRAINT "parties_terms_check";--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "supplier_group_id" uuid;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "supplier_payment_terms_days" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "party_bank_accounts_party_id_idx" ON "party_bank_accounts" USING btree ("tenant_id","party_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_groups_tenant_name_idx" ON "supplier_groups" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_groups_tenant_id_idx" ON "supplier_groups" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_levels_position_idx" ON "approval_levels" USING btree ("tenant_id","rule_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_levels_role_idx" ON "approval_levels" USING btree ("tenant_id","rule_id","role_id");--> statement-breakpoint
CREATE INDEX "approval_levels_tenant_role_idx" ON "approval_levels" USING btree ("tenant_id","role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_rounds_tenant_id_idx" ON "approval_rounds" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_rounds_pending_idx" ON "approval_rounds" USING btree ("tenant_id","document","document_id") WHERE "approval_rounds"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "approval_rounds_document_idx" ON "approval_rounds" USING btree ("tenant_id","document","document_id","submitted_at");--> statement-breakpoint
CREATE INDEX "approval_rounds_waiting_idx" ON "approval_rounds" USING btree ("tenant_id","submitted_at","id") WHERE "approval_rounds"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "approval_rules_tenant_document_idx" ON "approval_rules" USING btree ("tenant_id","document");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_rules_tenant_id_idx" ON "approval_rules" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_steps_position_idx" ON "approval_steps" USING btree ("tenant_id","round_id","position");--> statement-breakpoint
CREATE INDEX "approval_steps_open_role_idx" ON "approval_steps" USING btree ("tenant_id","role_id","round_id") WHERE "approval_steps"."decision" IS NULL;--> statement-breakpoint
CREATE INDEX "approval_steps_tenant_role_idx" ON "approval_steps" USING btree ("tenant_id","role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "requisition_lines_line_idx" ON "requisition_lines" USING btree ("tenant_id","requisition_id","line_no");--> statement-breakpoint
CREATE INDEX "requisition_lines_variant_idx" ON "requisition_lines" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "requisitions_tenant_id_idx" ON "requisitions" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "requisitions_tenant_number_idx" ON "requisitions" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "requisitions_tenant_date_idx" ON "requisitions" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "requisitions_warehouse_idx" ON "requisitions" USING btree ("tenant_id","warehouse_id","date","id");--> statement-breakpoint
CREATE INDEX "parties_supplier_name_idx" ON "parties" USING btree ("tenant_id",lower("name"),"id") WHERE "parties"."is_supplier";--> statement-breakpoint
CREATE INDEX "parties_supplier_updated_idx" ON "parties" USING btree ("tenant_id","updated_at","id") WHERE "parties"."is_supplier";--> statement-breakpoint
CREATE INDEX "parties_tenant_supplier_group_idx" ON "parties" USING btree ("tenant_id","supplier_group_id");--> statement-breakpoint
ALTER TABLE "party_bank_accounts" ADD CONSTRAINT "party_bank_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_bank_accounts" ADD CONSTRAINT "party_bank_accounts_party_fk" FOREIGN KEY ("tenant_id","party_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_groups" ADD CONSTRAINT "supplier_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_levels" ADD CONSTRAINT "approval_levels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_levels" ADD CONSTRAINT "approval_levels_rule_fk" FOREIGN KEY ("tenant_id","rule_id") REFERENCES "public"."approval_rules"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_levels" ADD CONSTRAINT "approval_levels_role_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "public"."roles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_rounds" ADD CONSTRAINT "approval_rounds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_rounds" ADD CONSTRAINT "approval_rounds_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_round_fk" FOREIGN KEY ("tenant_id","round_id") REFERENCES "public"."approval_rounds"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisition_lines" ADD CONSTRAINT "requisition_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisition_lines" ADD CONSTRAINT "requisition_lines_requisition_fk" FOREIGN KEY ("tenant_id","requisition_id") REFERENCES "public"."requisitions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisition_lines" ADD CONSTRAINT "requisition_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisition_lines" ADD CONSTRAINT "requisition_lines_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_supplier_group_fk" FOREIGN KEY ("tenant_id","supplier_group_id") REFERENCES "public"."supplier_groups"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_customer_side_check" CHECK ("parties"."is_customer" OR ("parties"."customer_group_id" IS NULL AND "parties"."payment_terms_days" = 0 AND "parties"."credit_limit" IS NULL AND "parties"."price_list_id" IS NULL));--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_supplier_side_check" CHECK ("parties"."is_supplier" OR ("parties"."supplier_group_id" IS NULL AND "parties"."supplier_payment_terms_days" = 0));--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_terms_check" CHECK ("parties"."payment_terms_days" BETWEEN 0 AND 365 AND "parties"."supplier_payment_terms_days" BETWEEN 0 AND 365);