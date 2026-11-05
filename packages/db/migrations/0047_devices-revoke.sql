ALTER TABLE "devices" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "revoked_by" uuid;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_revoked_by_check" CHECK ("devices"."revoked_by" IS NULL OR "devices"."revoked_at" IS NOT NULL);