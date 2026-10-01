CREATE TABLE "report_exports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"report" text NOT NULL,
	"format" text NOT NULL,
	"query" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"file_name" text,
	"content_type" text,
	"size_bytes" integer,
	"storage_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "report_exports_ready_check" CHECK ("report_exports"."status" <> 'ready' OR ("report_exports"."file_name" IS NOT NULL AND "report_exports"."content_type" IS NOT NULL AND "report_exports"."size_bytes" IS NOT NULL AND "report_exports"."storage_key" IS NOT NULL AND "report_exports"."finished_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_exports_tenant_user_idx" ON "report_exports" USING btree ("tenant_id","requested_by","id");