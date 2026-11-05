CREATE TABLE "units" (
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
	"dimension" text NOT NULL,
	"ratio" numeric(19, 6),
	"decimals" smallint DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "units_ratio_check" CHECK ("units"."ratio" IS NULL OR "units"."ratio" > 0),
	CONSTRAINT "units_decimals_check" CHECK ("units"."decimals" BETWEEN 0 AND 4)
);
--> statement-breakpoint
CREATE TABLE "product_categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	CONSTRAINT "product_categories_parent_not_self" CHECK ("product_categories"."parent_id" <> "product_categories"."id")
);
--> statement-breakpoint
CREATE TABLE "custom_field_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" text NOT NULL,
	"options" text[] DEFAULT '{}'::text[] NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "custom_field_definitions_select_check" CHECK ("custom_field_definitions"."type" <> 'select' OR cardinality("custom_field_definitions"."options") > 0)
);
--> statement-breakpoint
CREATE TABLE "product_barcodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_id" uuid
);
--> statement-breakpoint
CREATE TABLE "product_units" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"factor" numeric(19, 6) NOT NULL,
	"is_sales_default" boolean DEFAULT false NOT NULL,
	"is_purchase_default" boolean DEFAULT false NOT NULL,
	CONSTRAINT "product_units_factor_check" CHECK ("product_units"."factor" > 0)
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"sku" text NOT NULL,
	"option_values" text[] DEFAULT '{}'::text[] NOT NULL,
	"sale_price" numeric(19, 4),
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_variants_price_check" CHECK ("product_variants"."sale_price" IS NULL OR "product_variants"."sale_price" >= 0),
	CONSTRAINT "product_variants_values_check" CHECK (cardinality("product_variants"."option_values") <= 3)
);
--> statement-breakpoint
CREATE TABLE "products" (
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
	"type" text DEFAULT 'goods' NOT NULL,
	"category_id" uuid,
	"description" text,
	"base_unit_id" uuid NOT NULL,
	"tracking" text DEFAULT 'none' NOT NULL,
	"has_expiry" boolean DEFAULT false NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "products_service_untracked" CHECK ("products"."type" = 'goods' OR "products"."tracking" = 'none'),
	CONSTRAINT "products_expiry_needs_batch" CHECK (NOT "products"."has_expiry" OR "products"."tracking" = 'batch'),
	CONSTRAINT "products_options_array" CHECK (jsonb_typeof("products"."options") = 'array'),
	CONSTRAINT "products_custom_fields_object" CHECK (jsonb_typeof("products"."custom_fields") = 'object')
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"lot_number" text NOT NULL,
	"manufactured_on" date,
	"expires_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "batches_dates_check" CHECK ("batches"."manufactured_on" IS NULL OR "batches"."expires_on" IS NULL OR "batches"."expires_on" > "batches"."manufactured_on")
);
--> statement-breakpoint
CREATE TABLE "serials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"serial_number" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "product_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"file_name" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"status" text DEFAULT 'uploading' NOT NULL,
	"row_count" integer,
	"product_count" integer,
	"error_count" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "product_imports_finished_check" CHECK (("product_imports"."status" IN ('done', 'failed')) = ("product_imports"."finished_at" IS NOT NULL)),
	CONSTRAINT "product_imports_done_check" CHECK ("product_imports"."status" <> 'done' OR "product_imports"."product_count" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "units_tenant_code_idx" ON "units" USING btree ("tenant_id",lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "units_tenant_id_idx" ON "units" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_categories_sibling_name_idx" ON "product_categories" USING btree ("tenant_id",coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "product_categories_tenant_id_idx" ON "product_categories" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "product_categories_tenant_parent_idx" ON "product_categories" USING btree ("tenant_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_definitions_key_idx" ON "custom_field_definitions" USING btree ("tenant_id","entity","key");--> statement-breakpoint
CREATE UNIQUE INDEX "product_barcodes_tenant_code_idx" ON "product_barcodes" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "product_barcodes_product_idx" ON "product_barcodes" USING btree ("tenant_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_units_product_unit_idx" ON "product_units" USING btree ("tenant_id","product_id","unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_units_sales_default_idx" ON "product_units" USING btree ("tenant_id","product_id") WHERE "product_units"."is_sales_default";--> statement-breakpoint
CREATE UNIQUE INDEX "product_units_purchase_default_idx" ON "product_units" USING btree ("tenant_id","product_id") WHERE "product_units"."is_purchase_default";--> statement-breakpoint
CREATE INDEX "product_units_tenant_unit_idx" ON "product_units" USING btree ("tenant_id","unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_tenant_sku_idx" ON "product_variants" USING btree ("tenant_id",lower("sku"));--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_product_id_idx" ON "product_variants" USING btree ("tenant_id","product_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_values_idx" ON "product_variants" USING btree ("tenant_id","product_id","option_values");--> statement-breakpoint
CREATE UNIQUE INDEX "products_tenant_code_idx" ON "products" USING btree ("tenant_id",lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "products_tenant_id_idx" ON "products" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "products_tenant_name_idx" ON "products" USING btree ("tenant_id",lower("name"),"id");--> statement-breakpoint
CREATE INDEX "products_tenant_updated_idx" ON "products" USING btree ("tenant_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "products_tenant_category_idx" ON "products" USING btree ("tenant_id","category_id");--> statement-breakpoint
CREATE INDEX "products_tenant_base_unit_idx" ON "products" USING btree ("tenant_id","base_unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "batches_variant_lot_idx" ON "batches" USING btree ("tenant_id","variant_id",lower("lot_number"));--> statement-breakpoint
CREATE UNIQUE INDEX "serials_variant_number_idx" ON "serials" USING btree ("tenant_id","variant_id","serial_number");--> statement-breakpoint
CREATE INDEX "product_imports_tenant_id_idx" ON "product_imports" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_parent_fk" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."product_categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_unit_fk" FOREIGN KEY ("tenant_id","product_id","unit_id") REFERENCES "public"."product_units"("tenant_id","product_id","unit_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_units" ADD CONSTRAINT "product_units_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_units" ADD CONSTRAINT "product_units_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_units" ADD CONSTRAINT "product_units_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."product_categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_base_unit_fk" FOREIGN KEY ("tenant_id","base_unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serials" ADD CONSTRAINT "serials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serials" ADD CONSTRAINT "serials_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_imports" ADD CONSTRAINT "product_imports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_imports" ADD CONSTRAINT "product_imports_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;