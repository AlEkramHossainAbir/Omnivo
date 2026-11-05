CREATE TABLE "purchase_order_lines" (
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
	"requisition_line_id" uuid,
	"received_quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	"rejected_quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "purchase_order_lines_quantity_check" CHECK ("purchase_order_lines"."quantity" > 0 AND "purchase_order_lines"."factor" > 0 AND "purchase_order_lines"."base_quantity" > 0),
	CONSTRAINT "purchase_order_lines_amounts_check" CHECK ("purchase_order_lines"."unit_price" >= 0 AND "purchase_order_lines"."discount" >= 0 AND ("purchase_order_lines"."discount_type" = 'amount' OR "purchase_order_lines"."discount" <= 100) AND "purchase_order_lines"."net" >= 0 AND "purchase_order_lines"."vat" >= 0 AND "purchase_order_lines"."total" = "purchase_order_lines"."net" + "purchase_order_lines"."vat"),
	CONSTRAINT "purchase_order_lines_tax_rate_check" CHECK ("purchase_order_lines"."tax_rate" >= 0 AND "purchase_order_lines"."tax_rate" < 100),
	CONSTRAINT "purchase_order_lines_received_check" CHECK ("purchase_order_lines"."received_quantity" BETWEEN 0 AND 2 * "purchase_order_lines"."base_quantity" AND "purchase_order_lines"."rejected_quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
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
	"expected_date" date,
	"supplier_id" uuid NOT NULL,
	"supplier_reference" text,
	"warehouse_id" uuid NOT NULL,
	"payment_terms_days" smallint DEFAULT 0 NOT NULL,
	"prices_include_vat" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"note" text,
	"discount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"net" numeric(19, 4) DEFAULT '0' NOT NULL,
	"vat" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total" numeric(19, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "purchase_orders_number_check" CHECK ("purchase_orders"."status" = 'draft' OR "purchase_orders"."number" IS NOT NULL),
	CONSTRAINT "purchase_orders_expected_date_check" CHECK ("purchase_orders"."expected_date" IS NULL OR "purchase_orders"."expected_date" >= "purchase_orders"."date"),
	CONSTRAINT "purchase_orders_terms_check" CHECK ("purchase_orders"."payment_terms_days" BETWEEN 0 AND 365),
	CONSTRAINT "purchase_orders_totals_check" CHECK ("purchase_orders"."discount" >= 0 AND "purchase_orders"."net" >= 0 AND "purchase_orders"."vat" >= 0 AND "purchase_orders"."total" = "purchase_orders"."net" + "purchase_orders"."vat")
);
--> statement-breakpoint
CREATE TABLE "goods_receipt_lines" (
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
	"receipt_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"lot_number" text,
	"expires_on" date,
	"manufactured_on" date,
	"rejected_quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	"rejected_base_quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	"rejection_reason" text,
	"value" numeric(19, 4),
	CONSTRAINT "goods_receipt_lines_quantity_check" CHECK ("goods_receipt_lines"."factor" > 0 AND "goods_receipt_lines"."quantity" >= 0 AND "goods_receipt_lines"."rejected_quantity" >= 0 AND "goods_receipt_lines"."quantity" + "goods_receipt_lines"."rejected_quantity" > 0 AND ("goods_receipt_lines"."quantity" = 0) = ("goods_receipt_lines"."base_quantity" = 0) AND ("goods_receipt_lines"."rejected_quantity" = 0) = ("goods_receipt_lines"."rejected_base_quantity" = 0)),
	CONSTRAINT "goods_receipt_lines_rejection_check" CHECK (("goods_receipt_lines"."rejected_quantity" = 0 OR "goods_receipt_lines"."rejection_reason" IS NOT NULL) AND ("goods_receipt_lines"."rejection_reason" IS NULL OR char_length("goods_receipt_lines"."rejection_reason") BETWEEN 1 AND 200)),
	CONSTRAINT "goods_receipt_lines_value_check" CHECK ("goods_receipt_lines"."value" IS NULL OR "goods_receipt_lines"."value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "goods_receipts" (
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
	"supplier_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"supplier_challan" text,
	"vehicle" text,
	"note" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	CONSTRAINT "goods_receipts_posted_check" CHECK (("goods_receipts"."status" = 'posted') = ("goods_receipts"."number" IS NOT NULL AND "goods_receipts"."posted_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_document_check";--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "over_receipt_percent" numeric(5, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_lines_line_idx" ON "purchase_order_lines" USING btree ("tenant_id","order_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_lines_receipt_target_idx" ON "purchase_order_lines" USING btree ("tenant_id","order_id","id","variant_id");--> statement-breakpoint
CREATE INDEX "purchase_order_lines_variant_idx" ON "purchase_order_lines" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE INDEX "purchase_order_lines_requisition_line_idx" ON "purchase_order_lines" USING btree ("tenant_id","requisition_line_id") WHERE "purchase_order_lines"."requisition_line_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_tenant_id_idx" ON "purchase_orders" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_supplier_id_idx" ON "purchase_orders" USING btree ("tenant_id","supplier_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_tenant_number_idx" ON "purchase_orders" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "purchase_orders_tenant_date_idx" ON "purchase_orders" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "purchase_orders_supplier_idx" ON "purchase_orders" USING btree ("tenant_id","supplier_id","date","id");--> statement-breakpoint
CREATE INDEX "purchase_orders_warehouse_idx" ON "purchase_orders" USING btree ("tenant_id","warehouse_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_open_idx" ON "purchase_orders" USING btree ("tenant_id","warehouse_id") WHERE "purchase_orders"."status" = 'approved';--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipt_lines_line_idx" ON "goods_receipt_lines" USING btree ("tenant_id","receipt_id","line_no");--> statement-breakpoint
CREATE INDEX "goods_receipt_lines_variant_idx" ON "goods_receipt_lines" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE INDEX "goods_receipt_lines_order_line_idx" ON "goods_receipt_lines" USING btree ("tenant_id","order_id","order_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipts_tenant_id_idx" ON "goods_receipts" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipts_order_id_idx" ON "goods_receipts" USING btree ("tenant_id","id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipts_tenant_number_idx" ON "goods_receipts" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "goods_receipts_tenant_date_idx" ON "goods_receipts" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "goods_receipts_supplier_idx" ON "goods_receipts" USING btree ("tenant_id","supplier_id","date","id");--> statement-breakpoint
CREATE INDEX "goods_receipts_order_idx" ON "goods_receipts" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "goods_receipts_warehouse_idx" ON "goods_receipts" USING btree ("tenant_id","warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "requisition_lines_order_target_idx" ON "requisition_lines" USING btree ("tenant_id","id","variant_id");--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."purchase_orders"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_tax_rate_fk" FOREIGN KEY ("tenant_id","tax_rate_id") REFERENCES "public"."tax_rates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_receipt_fk" FOREIGN KEY ("tenant_id","receipt_id","order_id") REFERENCES "public"."goods_receipts"("tenant_id","id","order_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_order_line_fk" FOREIGN KEY ("tenant_id","order_id","order_line_id","variant_id") REFERENCES "public"."purchase_order_lines"("tenant_id","order_id","id","variant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_batch_fk" FOREIGN KEY ("tenant_id","variant_id","batch_id") REFERENCES "public"."batches"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_order_fk" FOREIGN KEY ("tenant_id","supplier_id","order_id") REFERENCES "public"."purchase_orders"("tenant_id","supplier_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_over_receipt_check" CHECK ("tenant_settings"."over_receipt_percent" BETWEEN 0 AND 100);--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_document_check" CHECK (("journal_entries"."source" IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery', 'sales_invoice', 'sales_receipt', 'sales_return', 'sales_credit_note', 'sales_refund', 'purchase_receipt')) = ("journal_entries"."document_id" IS NOT NULL AND "journal_entries"."document_number" IS NOT NULL));