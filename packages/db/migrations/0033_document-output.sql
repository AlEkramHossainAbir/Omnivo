CREATE TABLE "document_emails" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"document_id" uuid NOT NULL,
	"language" text NOT NULL,
	"to" text[] NOT NULL,
	"cc" text[] DEFAULT '{}'::text[] NOT NULL,
	"subject" text NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sent_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "document_emails_recipients_check" CHECK (cardinality("document_emails"."to") BETWEEN 1 AND 5 AND cardinality("document_emails"."cc") <= 5),
	CONSTRAINT "document_emails_text_check" CHECK (char_length("document_emails"."subject") BETWEEN 1 AND 200 AND char_length("document_emails"."message") <= 5000),
	CONSTRAINT "document_emails_sent_check" CHECK (("document_emails"."status" = 'sent') = ("document_emails"."sent_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "document_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"document_id" uuid NOT NULL,
	"language" text NOT NULL,
	"fingerprint" text NOT NULL,
	"model" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" uuid,
	"file_name" text,
	"content_type" text,
	"size_bytes" integer,
	"storage_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "document_files_ready_check" CHECK ("document_files"."status" <> 'ready' OR ("document_files"."file_name" IS NOT NULL AND "document_files"."content_type" IS NOT NULL AND "document_files"."size_bytes" IS NOT NULL AND "document_files"."storage_key" IS NOT NULL AND "document_files"."finished_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "document_shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"document_id" uuid NOT NULL,
	"language" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"first_opened_at" timestamp with time zone,
	"last_opened_at" timestamp with time zone,
	CONSTRAINT "document_shares_expiry_check" CHECK ("document_shares"."expires_at" > "document_shares"."created_at"),
	CONSTRAINT "document_shares_opened_check" CHECK (("document_shares"."first_opened_at" IS NULL) = ("document_shares"."last_opened_at" IS NULL) AND ("document_shares"."first_opened_at" IS NULL OR "document_shares"."first_opened_at" <= "document_shares"."last_opened_at"))
);
--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "document_language" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_emails" ADD CONSTRAINT "document_emails_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_emails" ADD CONSTRAINT "document_emails_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_shares" ADD CONSTRAINT "document_shares_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_shares" ADD CONSTRAINT "document_shares_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_emails_document_idx" ON "document_emails" USING btree ("tenant_id","kind","document_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_files_look_idx" ON "document_files" USING btree ("tenant_id","kind","document_id","language","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "document_shares_token_hash_idx" ON "document_shares" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "document_shares_document_idx" ON "document_shares" USING btree ("tenant_id","kind","document_id","id");