CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"legal_name" text,
	"bin" text,
	"phone" text,
	"email" text,
	"address" text,
	"base_currency" text DEFAULT 'BDT' NOT NULL,
	"fiscal_year_start_month" smallint DEFAULT 7 NOT NULL,
	"timezone" text DEFAULT 'Asia/Dhaka' NOT NULL,
	"logo_attachment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "tenant_settings_fiscal_month_check" CHECK ("tenant_settings"."fiscal_year_start_month" BETWEEN 1 AND 12)
);
--> statement-breakpoint
CREATE TABLE "branches" (
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
	"phone" text,
	"address" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "number_series" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_type" text NOT NULL,
	"prefix" text NOT NULL,
	"year_style" text NOT NULL,
	"padding" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "number_series_padding_check" CHECK ("number_series"."padding" BETWEEN 3 AND 8)
);
--> statement-breakpoint
CREATE TABLE "number_series_counters" (
	"tenant_id" uuid NOT NULL,
	"document_type" text NOT NULL,
	"period" text NOT NULL,
	"last_value" bigint NOT NULL,
	CONSTRAINT "number_series_counters_tenant_id_document_type_period_pk" PRIMARY KEY("tenant_id","document_type","period")
);
--> statement-breakpoint
DROP INDEX "audit_logs_tenant_created_idx";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "theme" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "ip_address" "inet";--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- composite FK-এর target index আগে লাগবে, তাই drizzle-kit-এর ক্রম হাতে বদলানো (0003-এর মতো)
CREATE UNIQUE INDEX "attachments_tenant_id_idx" ON "attachments" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_logo_fk" FOREIGN KEY ("tenant_id","logo_attachment_id") REFERENCES "public"."attachments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series_counters" ADD CONSTRAINT "number_series_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_storage_key_idx" ON "attachments" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "branches_tenant_code_idx" ON "branches" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "branches_tenant_id_idx" ON "branches" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "number_series_tenant_type_idx" ON "number_series" USING btree ("tenant_id","document_type");--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_created_id_idx" ON "audit_logs" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_entity_idx" ON "audit_logs" USING btree ("tenant_id","entity_type","entity_id","created_at","id");