CREATE TABLE "sync_commands" (
	"id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"status" text NOT NULL,
	"notices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_commands_pkey" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "sync_commands_status_check" CHECK ("sync_commands"."status" IN ('accepted', 'rejected')),
	CONSTRAINT "sync_commands_error_check" CHECK (("sync_commands"."status" = 'rejected') = ("sync_commands"."error" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "device_id" uuid;--> statement-breakpoint
-- Moved up by hand: the FK below needs this unique index to exist already
CREATE UNIQUE INDEX "devices_tenant_id_idx" ON "devices" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "sync_commands" ADD CONSTRAINT "sync_commands_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_commands" ADD CONSTRAINT "sync_commands_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_commands_created_idx" ON "sync_commands" USING btree ("created_at");