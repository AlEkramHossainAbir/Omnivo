CREATE TABLE "membership_roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"role_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_role_id_roles_id_fk";
--> statement-breakpoint
DROP INDEX "memberships_tenant_idx";--> statement-breakpoint
DROP INDEX "roles_tenant_idx";--> statement-breakpoint
DROP INDEX "role_permissions_tenant_idx";--> statement-breakpoint
DROP INDEX "role_permissions_role_permission_idx";--> statement-breakpoint
DROP INDEX "audit_logs_tenant_idx";--> statement-breakpoint
-- composite FK-এর target index আগে লাগবে, তাই drizzle-kit-এর ক্রম হাতে বদলানো
CREATE UNIQUE INDEX "memberships_tenant_id_idx" ON "memberships" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_tenant_id_idx" ON "roles" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_role_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "public"."roles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "membership_roles_tenant_membership_role_idx" ON "membership_roles" USING btree ("tenant_id","membership_id","role_id");--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "public"."roles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_permissions_tenant_role_permission_idx" ON "role_permissions" USING btree ("tenant_id","role_id","permission_id");--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_created_idx" ON "audit_logs" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "audit_logs" DROP COLUMN "created_by";--> statement-breakpoint
ALTER TABLE "audit_logs" DROP COLUMN "updated_at";--> statement-breakpoint
ALTER TABLE "audit_logs" DROP COLUMN "updated_by";--> statement-breakpoint
ALTER TABLE "audit_logs" DROP COLUMN "version";--> statement-breakpoint
ALTER TABLE "audit_logs" DROP COLUMN "deleted_at";