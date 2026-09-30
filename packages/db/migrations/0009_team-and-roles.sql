CREATE TABLE "invitation_roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"invitation_id" uuid NOT NULL,
	"role_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
-- composite FK-এর target index আগে লাগবে (0003, 0007-এর মতো), তাই drizzle-kit-এর ক্রম হাতে বদলানো
CREATE UNIQUE INDEX "invitations_tenant_id_idx" ON "invitations" USING btree ("tenant_id","id");--> statement-breakpoint
DROP INDEX "roles_tenant_name_idx";--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "kind" text DEFAULT 'custom' NOT NULL;--> statement-breakpoint
ALTER TABLE "invitation_roles" ADD CONSTRAINT "invitation_roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_roles" ADD CONSTRAINT "invitation_roles_invitation_fk" FOREIGN KEY ("tenant_id","invitation_id") REFERENCES "public"."invitations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_roles" ADD CONSTRAINT "invitation_roles_role_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "public"."roles"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_roles_tenant_invitation_role_idx" ON "invitation_roles" USING btree ("tenant_id","invitation_id","role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_hash_idx" ON "invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_tenant_email_open_idx" ON "invitations" USING btree ("tenant_id","email") WHERE "invitations"."accepted_at" IS NULL AND "invitations"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "roles_tenant_owner_idx" ON "roles" USING btree ("tenant_id") WHERE "roles"."kind" = 'owner';--> statement-breakpoint
CREATE UNIQUE INDEX "roles_tenant_name_idx" ON "roles" USING btree ("tenant_id",lower("name"));