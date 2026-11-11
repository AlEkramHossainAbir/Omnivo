CREATE TABLE "report_schedule_recipients" (
	"tenant_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "report_schedule_recipients_pkey" PRIMARY KEY("tenant_id","schedule_id","user_id"),
	CONSTRAINT "report_schedule_recipients_position_check" CHECK ("report_schedule_recipients"."position" BETWEEN 1 AND 10)
);
--> statement-breakpoint
CREATE TABLE "report_schedules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"tenant_id" uuid NOT NULL,
	"report" text NOT NULL,
	"format" text NOT NULL,
	"frequency" text NOT NULL,
	"hour" smallint NOT NULL,
	"weekday" smallint,
	"day_of_month" smallint,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"paused_reason" text,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	CONSTRAINT "report_schedules_hour_check" CHECK ("report_schedules"."hour" BETWEEN 0 AND 23),
	CONSTRAINT "report_schedules_weekday_check" CHECK (("report_schedules"."frequency" = 'weekly') = ("report_schedules"."weekday" IS NOT NULL) AND ("report_schedules"."weekday" IS NULL OR "report_schedules"."weekday" BETWEEN 0 AND 6)),
	CONSTRAINT "report_schedules_day_of_month_check" CHECK (("report_schedules"."frequency" = 'monthly') = ("report_schedules"."day_of_month" IS NOT NULL) AND ("report_schedules"."day_of_month" IS NULL OR "report_schedules"."day_of_month" BETWEEN 1 AND 28)),
	CONSTRAINT "report_schedules_status_check" CHECK (("report_schedules"."status" = 'paused') = ("report_schedules"."paused_reason" IS NOT NULL) AND ("report_schedules"."status" = 'active') = ("report_schedules"."next_run_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "report_schedule_recipients_position_idx" ON "report_schedule_recipients" USING btree ("tenant_id","schedule_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "report_schedules_tenant_id_idx" ON "report_schedules" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "report_schedules_due_idx" ON "report_schedules" USING btree ("next_run_at") WHERE "report_schedules"."next_run_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "stock_movements_date_idx" ON "stock_movements" USING btree ("tenant_id","date");--> statement-breakpoint
ALTER TABLE "report_schedule_recipients" ADD CONSTRAINT "report_schedule_recipients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedule_recipients" ADD CONSTRAINT "report_schedule_recipients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedule_recipients" ADD CONSTRAINT "report_schedule_recipients_schedule_fk" FOREIGN KEY ("tenant_id","schedule_id") REFERENCES "public"."report_schedules"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;