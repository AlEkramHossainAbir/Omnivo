CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"parent_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"is_group" boolean DEFAULT false NOT NULL,
	"purpose" text,
	"description" text,
	"archived_at" timestamp with time zone,
	CONSTRAINT "ledger_accounts_parent_not_self" CHECK ("ledger_accounts"."parent_id" <> "ledger_accounts"."id"),
	CONSTRAINT "ledger_accounts_top_is_group" CHECK ("ledger_accounts"."parent_id" IS NOT NULL OR "ledger_accounts"."is_group"),
	CONSTRAINT "ledger_accounts_purpose_not_group" CHECK ("ledger_accounts"."purpose" IS NULL OR NOT "ledger_accounts"."is_group")
);
--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_tenant_code_idx" ON "ledger_accounts" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_tenant_id_idx" ON "ledger_accounts" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_tenant_id_type_idx" ON "ledger_accounts" USING btree ("tenant_id","id","type");--> statement-breakpoint
CREATE INDEX "ledger_accounts_tenant_parent_idx" ON "ledger_accounts" USING btree ("tenant_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_tenant_root_idx" ON "ledger_accounts" USING btree ("tenant_id","type") WHERE "ledger_accounts"."parent_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_tenant_purpose_idx" ON "ledger_accounts" USING btree ("tenant_id","purpose") WHERE "ledger_accounts"."purpose" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_parent_fk" FOREIGN KEY ("tenant_id","parent_id","type") REFERENCES "public"."ledger_accounts"("tenant_id","id","type") ON DELETE no action ON UPDATE no action;