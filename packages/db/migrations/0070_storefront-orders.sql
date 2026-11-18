CREATE TABLE "storefront_order_counters" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"last_value" integer NOT NULL,
	CONSTRAINT "storefront_order_counters_value_check" CHECK ("storefront_order_counters"."last_value" BETWEEN 1 AND 999999999)
);
--> statement-breakpoint
CREATE TABLE "storefront_order_lines" (
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"listing_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"pack_size" text NOT NULL,
	"image" jsonb NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"line_total" numeric(19, 4) NOT NULL,
	CONSTRAINT "storefront_order_lines_pkey" PRIMARY KEY("tenant_id","order_id","position"),
	CONSTRAINT "storefront_order_lines_position_check" CHECK ("storefront_order_lines"."position" BETWEEN 1 AND 50),
	CONSTRAINT "storefront_order_lines_quantity_check" CHECK ("storefront_order_lines"."quantity" BETWEEN 1 AND 99),
	CONSTRAINT "storefront_order_lines_amounts_check" CHECK ("storefront_order_lines"."unit_price" > 0 AND "storefront_order_lines"."line_total" > 0),
	CONSTRAINT "storefront_order_lines_text_check" CHECK (char_length("storefront_order_lines"."slug") >= 1 AND char_length("storefront_order_lines"."name") >= 1 AND jsonb_typeof("storefront_order_lines"."image") = 'object')
);
--> statement-breakpoint
CREATE TABLE "storefront_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_no" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"customer_name" text NOT NULL,
	"phone" text NOT NULL,
	"address" text NOT NULL,
	"zone_id" text NOT NULL,
	"zone_name" text NOT NULL,
	"payment_method" text NOT NULL,
	"subtotal" numeric(19, 4) NOT NULL,
	"discount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"coupon_code" text,
	"delivery_charge" numeric(19, 4) NOT NULL,
	"total" numeric(19, 4) NOT NULL,
	"order_token_hash" text NOT NULL,
	"tracking_token_hash" text,
	"code_hash" text,
	"code_expires_at" timestamp with time zone,
	"code_sent_at" timestamp with time zone,
	"code_sends" smallint,
	"code_tries_left" smallint,
	"confirmed_at" timestamp with time zone,
	"packed_at" timestamp with time zone,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"returned_at" timestamp with time zone,
	CONSTRAINT "storefront_orders_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "storefront_orders_order_no_check" CHECK ("storefront_orders"."order_no" IS NULL OR "storefront_orders"."order_no" ~ '^W-[0-9]{6,9}$'),
	CONSTRAINT "storefront_orders_phone_check" CHECK ("storefront_orders"."phone" ~ '^01[3-9][0-9]{8}$'),
	CONSTRAINT "storefront_orders_text_check" CHECK (char_length("storefront_orders"."customer_name") BETWEEN 1 AND 80
        AND char_length("storefront_orders"."address") BETWEEN 10 AND 300
        AND char_length("storefront_orders"."zone_id") BETWEEN 1 AND 32
        AND char_length("storefront_orders"."zone_name") >= 1),
	CONSTRAINT "storefront_orders_amounts_check" CHECK ("storefront_orders"."subtotal" > 0 AND "storefront_orders"."discount" >= 0 AND "storefront_orders"."discount" <= "storefront_orders"."subtotal"
        AND "storefront_orders"."delivery_charge" >= 0
        AND "storefront_orders"."total" = "storefront_orders"."subtotal" - "storefront_orders"."discount" + "storefront_orders"."delivery_charge"),
	CONSTRAINT "storefront_orders_hashes_check" CHECK ("storefront_orders"."order_token_hash" ~ '^[0-9a-f]{64}$'
        AND ("storefront_orders"."tracking_token_hash" IS NULL OR "storefront_orders"."tracking_token_hash" ~ '^[0-9a-f]{64}$')
        AND ("storefront_orders"."code_hash" IS NULL OR "storefront_orders"."code_hash" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "storefront_orders_pending_check" CHECK (("storefront_orders"."status" = 'pending'
          AND num_nonnulls("storefront_orders"."code_hash", "storefront_orders"."code_expires_at", "storefront_orders"."code_sent_at", "storefront_orders"."code_sends", "storefront_orders"."code_tries_left") = 5
          AND num_nonnulls("storefront_orders"."order_no", "storefront_orders"."tracking_token_hash", "storefront_orders"."confirmed_at") = 0)
        OR ("storefront_orders"."status" <> 'pending'
          AND num_nonnulls("storefront_orders"."code_hash", "storefront_orders"."code_expires_at", "storefront_orders"."code_sent_at", "storefront_orders"."code_sends", "storefront_orders"."code_tries_left") = 0
          AND num_nonnulls("storefront_orders"."order_no", "storefront_orders"."tracking_token_hash", "storefront_orders"."confirmed_at") = 3)),
	CONSTRAINT "storefront_orders_code_check" CHECK ("storefront_orders"."code_sends" IS NULL OR (
        "storefront_orders"."code_sends" BETWEEN 1 AND 3
        AND "storefront_orders"."code_tries_left" BETWEEN 1 AND 5
        AND "storefront_orders"."code_expires_at" > "storefront_orders"."code_sent_at")),
	CONSTRAINT "storefront_orders_steps_check" CHECK (CASE "storefront_orders"."status"
          WHEN 'packed' THEN "storefront_orders"."packed_at" IS NOT NULL
          WHEN 'shipped' THEN "storefront_orders"."shipped_at" IS NOT NULL
          WHEN 'delivered' THEN "storefront_orders"."delivered_at" IS NOT NULL
          ELSE true END
        AND ("storefront_orders"."status" = 'cancelled') = ("storefront_orders"."cancelled_at" IS NOT NULL)
        AND ("storefront_orders"."status" = 'returned') = ("storefront_orders"."returned_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "storefront_stock_holds" (
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "storefront_stock_holds_pkey" PRIMARY KEY("tenant_id","order_id","variant_id"),
	CONSTRAINT "storefront_stock_holds_quantity_check" CHECK ("storefront_stock_holds"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "storefront_order_counters" ADD CONSTRAINT "storefront_order_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_order_lines" ADD CONSTRAINT "storefront_order_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_order_lines" ADD CONSTRAINT "storefront_order_lines_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."storefront_orders"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_order_lines" ADD CONSTRAINT "storefront_order_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD CONSTRAINT "storefront_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_stock_holds" ADD CONSTRAINT "storefront_stock_holds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_stock_holds" ADD CONSTRAINT "storefront_stock_holds_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."storefront_orders"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_stock_holds" ADD CONSTRAINT "storefront_stock_holds_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_stock_holds" ADD CONSTRAINT "storefront_stock_holds_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_order_lines_listing_idx" ON "storefront_order_lines" USING btree ("tenant_id","order_id","listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_orders_order_no_idx" ON "storefront_orders" USING btree ("tenant_id","order_no");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_orders_order_token_idx" ON "storefront_orders" USING btree ("tenant_id","order_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_orders_tracking_token_idx" ON "storefront_orders" USING btree ("tenant_id","tracking_token_hash") WHERE "storefront_orders"."tracking_token_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "storefront_orders_pending_idx" ON "storefront_orders" USING btree ("created_at") WHERE "storefront_orders"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "storefront_stock_holds_variant_idx" ON "storefront_stock_holds" USING btree ("tenant_id","warehouse_id","variant_id");