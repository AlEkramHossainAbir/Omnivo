CREATE TABLE "deliveries" (
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
	"customer_id" uuid NOT NULL,
	"order_id" uuid,
	"warehouse_id" uuid NOT NULL,
	"shipping_address_id" uuid,
	"shipping_address" text,
	"vehicle" text,
	"note" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	CONSTRAINT "deliveries_posted_check" CHECK (("deliveries"."status" = 'posted') = ("deliveries"."number" IS NOT NULL AND "deliveries"."posted_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "delivery_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"factor" numeric(19, 6) NOT NULL,
	"base_quantity" numeric(19, 4) NOT NULL,
	"batch_id" uuid,
	"serial_numbers" text[] DEFAULT '{}'::text[] NOT NULL,
	"delivery_id" uuid NOT NULL,
	"order_line_id" uuid,
	"value" numeric(19, 4),
	CONSTRAINT "delivery_lines_quantity_check" CHECK ("delivery_lines"."quantity" > 0 AND "delivery_lines"."factor" > 0 AND "delivery_lines"."base_quantity" > 0),
	CONSTRAINT "delivery_lines_value_check" CHECK ("delivery_lines"."value" IS NULL OR "delivery_lines"."value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "quotation_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"factor" numeric(19, 6) NOT NULL,
	"base_quantity" numeric(19, 4) NOT NULL,
	"description" text NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"discount_type" text NOT NULL,
	"discount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"tax_rate_id" uuid NOT NULL,
	"tax_rate_name" text NOT NULL,
	"tax_rate_kind" text NOT NULL,
	"tax_rate" numeric(5, 2) NOT NULL,
	"net" numeric(19, 4) NOT NULL,
	"vat" numeric(19, 4) NOT NULL,
	"total" numeric(19, 4) NOT NULL,
	"quotation_id" uuid NOT NULL,
	CONSTRAINT "quotation_lines_quantity_check" CHECK ("quotation_lines"."quantity" > 0 AND "quotation_lines"."factor" > 0 AND "quotation_lines"."base_quantity" > 0),
	CONSTRAINT "quotation_lines_amounts_check" CHECK ("quotation_lines"."unit_price" >= 0 AND "quotation_lines"."discount" >= 0 AND ("quotation_lines"."discount_type" = 'amount' OR "quotation_lines"."discount" <= 100) AND "quotation_lines"."net" >= 0 AND "quotation_lines"."vat" >= 0 AND "quotation_lines"."total" = "quotation_lines"."net" + "quotation_lines"."vat"),
	CONSTRAINT "quotation_lines_tax_rate_check" CHECK ("quotation_lines"."tax_rate" >= 0 AND "quotation_lines"."tax_rate" < 100)
);
--> statement-breakpoint
CREATE TABLE "quotations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"date" date NOT NULL,
	"valid_until" date,
	"customer_id" uuid NOT NULL,
	"prices_include_vat" boolean NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"note" text,
	"discount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"net" numeric(19, 4) DEFAULT '0' NOT NULL,
	"vat" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total" numeric(19, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "quotations_valid_until_check" CHECK ("quotations"."valid_until" IS NULL OR "quotations"."valid_until" >= "quotations"."date"),
	CONSTRAINT "quotations_totals_check" CHECK ("quotations"."discount" >= 0 AND "quotations"."net" >= 0 AND "quotations"."vat" >= 0 AND "quotations"."total" = "quotations"."net" + "quotations"."vat")
);
--> statement-breakpoint
CREATE TABLE "sales_order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"factor" numeric(19, 6) NOT NULL,
	"base_quantity" numeric(19, 4) NOT NULL,
	"description" text NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"discount_type" text NOT NULL,
	"discount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"tax_rate_id" uuid NOT NULL,
	"tax_rate_name" text NOT NULL,
	"tax_rate_kind" text NOT NULL,
	"tax_rate" numeric(5, 2) NOT NULL,
	"net" numeric(19, 4) NOT NULL,
	"vat" numeric(19, 4) NOT NULL,
	"total" numeric(19, 4) NOT NULL,
	"order_id" uuid NOT NULL,
	"delivered_quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "sales_order_lines_quantity_check" CHECK ("sales_order_lines"."quantity" > 0 AND "sales_order_lines"."factor" > 0 AND "sales_order_lines"."base_quantity" > 0),
	CONSTRAINT "sales_order_lines_amounts_check" CHECK ("sales_order_lines"."unit_price" >= 0 AND "sales_order_lines"."discount" >= 0 AND ("sales_order_lines"."discount_type" = 'amount' OR "sales_order_lines"."discount" <= 100) AND "sales_order_lines"."net" >= 0 AND "sales_order_lines"."vat" >= 0 AND "sales_order_lines"."total" = "sales_order_lines"."net" + "sales_order_lines"."vat"),
	CONSTRAINT "sales_order_lines_tax_rate_check" CHECK ("sales_order_lines"."tax_rate" >= 0 AND "sales_order_lines"."tax_rate" < 100),
	CONSTRAINT "sales_order_lines_delivered_check" CHECK ("sales_order_lines"."delivered_quantity" BETWEEN 0 AND "sales_order_lines"."base_quantity")
);
--> statement-breakpoint
CREATE TABLE "sales_orders" (
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
	"delivery_date" date,
	"customer_id" uuid NOT NULL,
	"customer_reference" text,
	"warehouse_id" uuid NOT NULL,
	"shipping_address_id" uuid,
	"shipping_address" text,
	"quotation_id" uuid,
	"prices_include_vat" boolean NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"note" text,
	"discount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"net" numeric(19, 4) DEFAULT '0' NOT NULL,
	"vat" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	CONSTRAINT "sales_orders_confirmed_check" CHECK (("sales_orders"."status" = 'draft') = ("sales_orders"."confirmed_at" IS NULL) AND ("sales_orders"."status" = 'draft' OR "sales_orders"."number" IS NOT NULL)),
	CONSTRAINT "sales_orders_delivery_date_check" CHECK ("sales_orders"."delivery_date" IS NULL OR "sales_orders"."delivery_date" >= "sales_orders"."date"),
	CONSTRAINT "sales_orders_totals_check" CHECK ("sales_orders"."discount" >= 0 AND "sales_orders"."net" >= 0 AND "sales_orders"."vat" >= 0 AND "sales_orders"."total" = "sales_orders"."net" + "sales_orders"."vat")
);
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_document_check";--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_tenant_id_idx" ON "deliveries" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_tenant_number_idx" ON "deliveries" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "deliveries_tenant_date_idx" ON "deliveries" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "deliveries_customer_idx" ON "deliveries" USING btree ("tenant_id","customer_id","date","id");--> statement-breakpoint
CREATE INDEX "deliveries_order_idx" ON "deliveries" USING btree ("tenant_id","order_id") WHERE "deliveries"."order_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "deliveries_warehouse_idx" ON "deliveries" USING btree ("tenant_id","warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_lines_line_idx" ON "delivery_lines" USING btree ("tenant_id","delivery_id","line_no");--> statement-breakpoint
CREATE INDEX "delivery_lines_variant_idx" ON "delivery_lines" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE INDEX "delivery_lines_order_line_idx" ON "delivery_lines" USING btree ("tenant_id","order_line_id") WHERE "delivery_lines"."order_line_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "quotation_lines_line_idx" ON "quotation_lines" USING btree ("tenant_id","quotation_id","line_no");--> statement-breakpoint
CREATE INDEX "quotation_lines_variant_idx" ON "quotation_lines" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quotations_tenant_id_idx" ON "quotations" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "quotations_tenant_number_idx" ON "quotations" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "quotations_tenant_date_idx" ON "quotations" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "quotations_customer_idx" ON "quotations" USING btree ("tenant_id","customer_id","date","id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_order_lines_line_idx" ON "sales_order_lines" USING btree ("tenant_id","order_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_order_lines_tenant_id_idx" ON "sales_order_lines" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "sales_order_lines_variant_idx" ON "sales_order_lines" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_orders_tenant_id_idx" ON "sales_orders" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_orders_customer_id_idx" ON "sales_orders" USING btree ("tenant_id","customer_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_orders_tenant_number_idx" ON "sales_orders" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_orders_quotation_idx" ON "sales_orders" USING btree ("tenant_id","quotation_id");--> statement-breakpoint
CREATE INDEX "sales_orders_tenant_date_idx" ON "sales_orders" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "sales_orders_customer_idx" ON "sales_orders" USING btree ("tenant_id","customer_id","date","id");--> statement-breakpoint
CREATE INDEX "sales_orders_open_idx" ON "sales_orders" USING btree ("tenant_id","warehouse_id") WHERE "sales_orders"."status" = 'confirmed';--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_order_fk" FOREIGN KEY ("tenant_id","customer_id","order_id") REFERENCES "public"."sales_orders"("tenant_id","customer_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD CONSTRAINT "delivery_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD CONSTRAINT "delivery_lines_delivery_fk" FOREIGN KEY ("tenant_id","delivery_id") REFERENCES "public"."deliveries"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD CONSTRAINT "delivery_lines_order_line_fk" FOREIGN KEY ("tenant_id","order_line_id") REFERENCES "public"."sales_order_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD CONSTRAINT "delivery_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD CONSTRAINT "delivery_lines_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD CONSTRAINT "delivery_lines_batch_fk" FOREIGN KEY ("tenant_id","variant_id","batch_id") REFERENCES "public"."batches"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_quotation_fk" FOREIGN KEY ("tenant_id","quotation_id") REFERENCES "public"."quotations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_tax_rate_fk" FOREIGN KEY ("tenant_id","tax_rate_id") REFERENCES "public"."tax_rates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."sales_orders"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_tax_rate_fk" FOREIGN KEY ("tenant_id","tax_rate_id") REFERENCES "public"."tax_rates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_quotation_fk" FOREIGN KEY ("tenant_id","quotation_id") REFERENCES "public"."quotations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_document_check" CHECK (("journal_entries"."source" IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery')) = ("journal_entries"."document_id" IS NOT NULL AND "journal_entries"."document_number" IS NOT NULL));