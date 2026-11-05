CREATE TABLE "account_day_totals" (
	"tenant_id" uuid NOT NULL,
	"day" date NOT NULL,
	"account_id" uuid NOT NULL,
	"branch_id" uuid,
	"closing" boolean NOT NULL,
	"debit" numeric(19, 4) DEFAULT '0' NOT NULL,
	"credit" numeric(19, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "account_day_totals_key" UNIQUE NULLS NOT DISTINCT("tenant_id","account_id","day","branch_id","closing"),
	CONSTRAINT "account_day_totals_not_negative" CHECK ("account_day_totals"."debit" >= 0 AND "account_day_totals"."credit" >= 0)
);
--> statement-breakpoint
ALTER TABLE "account_day_totals" ADD CONSTRAINT "account_day_totals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_day_totals" ADD CONSTRAINT "account_day_totals_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_day_totals" ADD CONSTRAINT "account_day_totals_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;