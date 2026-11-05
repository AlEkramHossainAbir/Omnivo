CREATE TABLE "warehouses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reorder_levels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"min_quantity" numeric(19, 4) NOT NULL,
	"reorder_quantity" numeric(19, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "reorder_levels_min_check" CHECK ("reorder_levels"."min_quantity" >= 0),
	CONSTRAINT "reorder_levels_quantity_check" CHECK ("reorder_levels"."reorder_quantity" IS NULL OR "reorder_levels"."reorder_quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "stock_balances" (
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"batch_id" uuid,
	"quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_balances_key" UNIQUE NULLS NOT DISTINCT("tenant_id","warehouse_id","variant_id","batch_id")
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"date" date NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"batch_id" uuid,
	"serial_id" uuid,
	"quantity" numeric(19, 4) NOT NULL,
	"kind" text NOT NULL,
	"document_id" uuid NOT NULL,
	"document_number" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "stock_movements_quantity_check" CHECK ("stock_movements"."quantity" <> 0),
	CONSTRAINT "stock_movements_serial_check" CHECK ("stock_movements"."serial_id" IS NULL OR "stock_movements"."quantity" IN (1, -1))
);
--> statement-breakpoint
CREATE TABLE "stock_adjustment_lines" (
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
	"adjustment_id" uuid NOT NULL,
	"lot_number" text,
	"expires_on" date,
	"manufactured_on" date,
	CONSTRAINT "stock_adjustment_lines_quantity_check" CHECK ("stock_adjustment_lines"."quantity" > 0 AND "stock_adjustment_lines"."factor" > 0 AND "stock_adjustment_lines"."base_quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "stock_adjustments" (
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
	"warehouse_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	CONSTRAINT "stock_adjustments_posted_check" CHECK (("stock_adjustments"."status" = 'posted') = ("stock_adjustments"."number" IS NOT NULL AND "stock_adjustments"."posted_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "stock_transfer_lines" (
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
	"transfer_id" uuid NOT NULL,
	"received_quantity" numeric(19, 4),
	"received_serial_numbers" text[],
	CONSTRAINT "stock_transfer_lines_quantity_check" CHECK ("stock_transfer_lines"."quantity" > 0 AND "stock_transfer_lines"."factor" > 0 AND "stock_transfer_lines"."base_quantity" > 0),
	CONSTRAINT "stock_transfer_lines_received_check" CHECK ("stock_transfer_lines"."received_quantity" IS NULL OR "stock_transfer_lines"."received_quantity" BETWEEN 0 AND "stock_transfer_lines"."base_quantity")
);
--> statement-breakpoint
CREATE TABLE "stock_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"number" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"from_warehouse_id" uuid NOT NULL,
	"to_warehouse_id" uuid NOT NULL,
	"sent_on" date NOT NULL,
	"received_on" date,
	"note" text,
	"sent_at" timestamp with time zone,
	"sent_by" uuid,
	"received_at" timestamp with time zone,
	"received_by" uuid,
	CONSTRAINT "stock_transfers_places_check" CHECK ("stock_transfers"."from_warehouse_id" <> "stock_transfers"."to_warehouse_id"),
	CONSTRAINT "stock_transfers_sent_check" CHECK (("stock_transfers"."status" <> 'draft') = ("stock_transfers"."number" IS NOT NULL AND "stock_transfers"."sent_at" IS NOT NULL)),
	CONSTRAINT "stock_transfers_received_check" CHECK (("stock_transfers"."status" = 'received') = ("stock_transfers"."received_on" IS NOT NULL AND "stock_transfers"."received_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "allow_negative_stock" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "serials" ADD COLUMN "warehouse_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "warehouses_tenant_code_idx" ON "warehouses" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouses_tenant_id_idx" ON "warehouses" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "warehouses_tenant_branch_idx" ON "warehouses" USING btree ("tenant_id","branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reorder_levels_key_idx" ON "reorder_levels" USING btree ("tenant_id","warehouse_id","variant_id");--> statement-breakpoint
CREATE INDEX "reorder_levels_variant_idx" ON "reorder_levels" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE INDEX "stock_balances_variant_idx" ON "stock_balances" USING btree ("tenant_id","variant_id");--> statement-breakpoint
CREATE INDEX "stock_movements_variant_date_idx" ON "stock_movements" USING btree ("tenant_id","variant_id","date","id");--> statement-breakpoint
CREATE INDEX "stock_movements_product_idx" ON "stock_movements" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE INDEX "stock_movements_warehouse_idx" ON "stock_movements" USING btree ("tenant_id","warehouse_id");--> statement-breakpoint
CREATE INDEX "stock_movements_document_idx" ON "stock_movements" USING btree ("tenant_id","document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_adjustment_lines_line_idx" ON "stock_adjustment_lines" USING btree ("tenant_id","adjustment_id","line_no");--> statement-breakpoint
CREATE INDEX "stock_adjustment_lines_variant_idx" ON "stock_adjustment_lines" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_adjustments_tenant_id_idx" ON "stock_adjustments" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_adjustments_tenant_number_idx" ON "stock_adjustments" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "stock_adjustments_tenant_date_idx" ON "stock_adjustments" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "stock_adjustments_tenant_warehouse_idx" ON "stock_adjustments" USING btree ("tenant_id","warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_transfer_lines_line_idx" ON "stock_transfer_lines" USING btree ("tenant_id","transfer_id","line_no");--> statement-breakpoint
CREATE INDEX "stock_transfer_lines_variant_idx" ON "stock_transfer_lines" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_transfers_tenant_id_idx" ON "stock_transfers" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_transfers_tenant_number_idx" ON "stock_transfers" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "stock_transfers_tenant_date_idx" ON "stock_transfers" USING btree ("tenant_id","sent_on","id");--> statement-breakpoint
CREATE INDEX "stock_transfers_in_transit_idx" ON "stock_transfers" USING btree ("tenant_id","to_warehouse_id") WHERE "stock_transfers"."status" = 'in_transit';--> statement-breakpoint
CREATE INDEX "stock_transfers_from_idx" ON "stock_transfers" USING btree ("tenant_id","from_warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "batches_variant_id_idx" ON "batches" USING btree ("tenant_id","variant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "serials_variant_id_idx" ON "serials" USING btree ("tenant_id","variant_id","id");--> statement-breakpoint
CREATE INDEX "serials_warehouse_idx" ON "serials" USING btree ("tenant_id","warehouse_id","variant_id");--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reorder_levels" ADD CONSTRAINT "reorder_levels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reorder_levels" ADD CONSTRAINT "reorder_levels_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reorder_levels" ADD CONSTRAINT "reorder_levels_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_batch_fk" FOREIGN KEY ("tenant_id","variant_id","batch_id") REFERENCES "public"."batches"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_batch_fk" FOREIGN KEY ("tenant_id","variant_id","batch_id") REFERENCES "public"."batches"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_serial_fk" FOREIGN KEY ("tenant_id","variant_id","serial_id") REFERENCES "public"."serials"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_adjustment_fk" FOREIGN KEY ("tenant_id","adjustment_id") REFERENCES "public"."stock_adjustments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_batch_fk" FOREIGN KEY ("tenant_id","variant_id","batch_id") REFERENCES "public"."batches"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_transfer_fk" FOREIGN KEY ("tenant_id","transfer_id") REFERENCES "public"."stock_transfers"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_batch_fk" FOREIGN KEY ("tenant_id","variant_id","batch_id") REFERENCES "public"."batches"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_fk" FOREIGN KEY ("tenant_id","from_warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_fk" FOREIGN KEY ("tenant_id","to_warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serials" ADD CONSTRAINT "serials_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;