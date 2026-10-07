CREATE TABLE "tax_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"rate" numeric(5, 2) NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "tax_rates_rate_check" CHECK ("tax_rates"."rate" >= 0 AND "tax_rates"."rate" < 100),
	CONSTRAINT "tax_rates_kind_rate_check" CHECK (("tax_rates"."kind" IN ('standard', 'reduced')) = ("tax_rates"."rate" > 0)),
	CONSTRAINT "tax_rates_default_active" CHECK (NOT "tax_rates"."is_default" OR "tax_rates"."archived_at" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "price_list_items" (
	"tenant_id" uuid NOT NULL,
	"price_list_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"price" numeric(19, 4) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "price_list_items_pkey" PRIMARY KEY("tenant_id","price_list_id","variant_id","unit_id"),
	CONSTRAINT "price_list_items_price_check" CHECK ("price_list_items"."price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "price_lists" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customer_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parties" (
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
	"is_customer" boolean DEFAULT false NOT NULL,
	"is_supplier" boolean DEFAULT false NOT NULL,
	"customer_group_id" uuid,
	"contact_person" text,
	"phone" text,
	"email" text,
	"bin" text,
	"payment_terms_days" smallint DEFAULT 0 NOT NULL,
	"credit_limit" numeric(19, 4),
	"price_list_id" uuid,
	"notes" text,
	"archived_at" timestamp with time zone,
	CONSTRAINT "parties_role_check" CHECK ("parties"."is_customer" OR "parties"."is_supplier"),
	CONSTRAINT "parties_terms_check" CHECK ("parties"."payment_terms_days" BETWEEN 0 AND 365),
	CONSTRAINT "parties_credit_limit_check" CHECK ("parties"."credit_limit" IS NULL OR "parties"."credit_limit" >= 0)
);
--> statement-breakpoint
CREATE TABLE "party_addresses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"position" smallint NOT NULL,
	"label" text,
	"address" text NOT NULL,
	"phone" text
);
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "prices_include_vat" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "party_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "tax_rate_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "tax_rates_tenant_name_idx" ON "tax_rates" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "tax_rates_tenant_id_idx" ON "tax_rates" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_rates_tenant_default_idx" ON "tax_rates" USING btree ("tenant_id") WHERE "tax_rates"."is_default";--> statement-breakpoint
CREATE INDEX "price_list_items_list_product_idx" ON "price_list_items" USING btree ("tenant_id","price_list_id","product_id");--> statement-breakpoint
CREATE INDEX "price_list_items_variant_idx" ON "price_list_items" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE INDEX "price_list_items_unit_idx" ON "price_list_items" USING btree ("tenant_id","unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_tenant_name_idx" ON "price_lists" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_tenant_id_idx" ON "price_lists" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_groups_tenant_name_idx" ON "customer_groups" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "customer_groups_tenant_id_idx" ON "customer_groups" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "parties_tenant_code_idx" ON "parties" USING btree ("tenant_id",lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "parties_tenant_id_idx" ON "parties" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "parties_customer_name_idx" ON "parties" USING btree ("tenant_id",lower("name"),"id") WHERE "parties"."is_customer";--> statement-breakpoint
CREATE INDEX "parties_customer_updated_idx" ON "parties" USING btree ("tenant_id","updated_at","id") WHERE "parties"."is_customer";--> statement-breakpoint
CREATE INDEX "parties_tenant_group_idx" ON "parties" USING btree ("tenant_id","customer_group_id");--> statement-breakpoint
CREATE INDEX "parties_tenant_price_list_idx" ON "parties" USING btree ("tenant_id","price_list_id");--> statement-breakpoint
CREATE UNIQUE INDEX "party_addresses_party_id_idx" ON "party_addresses" USING btree ("tenant_id","party_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "party_addresses_billing_idx" ON "party_addresses" USING btree ("tenant_id","party_id") WHERE "party_addresses"."kind" = 'billing';--> statement-breakpoint
CREATE INDEX "journal_lines_tenant_party_idx" ON "journal_lines" USING btree ("tenant_id","party_id") WHERE "journal_lines"."party_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "products_tenant_tax_rate_idx" ON "products" USING btree ("tenant_id","tax_rate_id");--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_list_fk" FOREIGN KEY ("tenant_id","price_list_id") REFERENCES "public"."price_lists"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_groups" ADD CONSTRAINT "customer_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_customer_group_fk" FOREIGN KEY ("tenant_id","customer_group_id") REFERENCES "public"."customer_groups"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_price_list_fk" FOREIGN KEY ("tenant_id","price_list_id") REFERENCES "public"."price_lists"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_addresses" ADD CONSTRAINT "party_addresses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_addresses" ADD CONSTRAINT "party_addresses_party_fk" FOREIGN KEY ("tenant_id","party_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_party_fk" FOREIGN KEY ("tenant_id","party_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tax_rate_fk" FOREIGN KEY ("tenant_id","tax_rate_id") REFERENCES "public"."tax_rates"("tenant_id","id") ON DELETE no action ON UPDATE no action;
