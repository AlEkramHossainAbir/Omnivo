CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"number" text,
	"date" date NOT NULL,
	"narration" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"reversal_of_id" uuid,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	CONSTRAINT "journal_entries_posted_check" CHECK (("journal_entries"."status" = 'posted') = ("journal_entries"."number" IS NOT NULL AND "journal_entries"."posted_at" IS NOT NULL)),
	CONSTRAINT "journal_entries_reversal_check" CHECK (("journal_entries"."source" = 'reversal') = ("journal_entries"."reversal_of_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"account_id" uuid NOT NULL,
	"branch_id" uuid,
	"description" text,
	"debit" numeric(19, 4) DEFAULT '0' NOT NULL,
	"credit" numeric(19, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "journal_lines_one_side" CHECK ("journal_lines"."debit" >= 0 AND "journal_lines"."credit" >= 0 AND ("journal_lines"."debit" = 0) <> ("journal_lines"."credit" = 0))
);
--> statement-breakpoint
CREATE TABLE "period_locks" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"lock_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_tenant_id_idx" ON "journal_entries" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversal_fk" FOREIGN KEY ("tenant_id","reversal_of_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_fk" FOREIGN KEY ("tenant_id","entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_locks" ADD CONSTRAINT "period_locks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_tenant_number_idx" ON "journal_entries" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "journal_entries_tenant_date_idx" ON "journal_entries" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_tenant_reversal_idx" ON "journal_entries" USING btree ("tenant_id","reversal_of_id") WHERE "journal_entries"."reversal_of_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_lines_entry_line_idx" ON "journal_lines" USING btree ("tenant_id","entry_id","line_no");--> statement-breakpoint
CREATE INDEX "journal_lines_tenant_account_idx" ON "journal_lines" USING btree ("tenant_id","account_id");