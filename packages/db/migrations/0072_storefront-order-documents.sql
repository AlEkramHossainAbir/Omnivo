ALTER TABLE "storefront_settings" ADD COLUMN "delivery_product_id" uuid;--> statement-breakpoint
ALTER TABLE "storefront_settings" ADD COLUMN "delivery_variant_id" uuid;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD COLUMN "sales_order_id" uuid;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD COLUMN "delivery_id" uuid;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD COLUMN "invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD COLUMN "sales_return_id" uuid;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD COLUMN "document_error" text;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "storefront_settings" ADD CONSTRAINT "storefront_settings_delivery_variant_fk" FOREIGN KEY ("tenant_id","delivery_product_id","delivery_variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD CONSTRAINT "storefront_orders_sales_order_fk" FOREIGN KEY ("tenant_id","sales_order_id") REFERENCES "public"."sales_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD CONSTRAINT "storefront_orders_delivery_fk" FOREIGN KEY ("tenant_id","delivery_id") REFERENCES "public"."deliveries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD CONSTRAINT "storefront_orders_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD CONSTRAINT "storefront_orders_sales_return_fk" FOREIGN KEY ("tenant_id","sales_return_id") REFERENCES "public"."sales_returns"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storefront_orders_list_idx" ON "storefront_orders" USING btree ("tenant_id","status","confirmed_at" DESC NULLS LAST) WHERE "storefront_orders"."status" <> 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_orders_sales_order_idx" ON "storefront_orders" USING btree ("tenant_id","sales_order_id") WHERE "storefront_orders"."sales_order_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_orders_delivery_idx" ON "storefront_orders" USING btree ("tenant_id","delivery_id") WHERE "storefront_orders"."delivery_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_orders_invoice_idx" ON "storefront_orders" USING btree ("tenant_id","invoice_id") WHERE "storefront_orders"."invoice_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_orders_sales_return_idx" ON "storefront_orders" USING btree ("tenant_id","sales_return_id") WHERE "storefront_orders"."sales_return_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "storefront_settings" ADD CONSTRAINT "storefront_settings_delivery_check" CHECK (("storefront_settings"."delivery_product_id" IS NULL) = ("storefront_settings"."delivery_variant_id" IS NULL));--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD CONSTRAINT "storefront_orders_documents_check" CHECK (("storefront_orders"."delivery_id" IS NULL OR "storefront_orders"."sales_order_id" IS NOT NULL)
        AND ("storefront_orders"."invoice_id" IS NULL OR "storefront_orders"."delivery_id" IS NOT NULL)
        AND ("storefront_orders"."sales_return_id" IS NULL OR ("storefront_orders"."delivery_id" IS NOT NULL AND "storefront_orders"."status" = 'cancelled'))
        AND ("storefront_orders"."status" NOT IN ('packed', 'shipped', 'delivered') OR "storefront_orders"."delivery_id" IS NOT NULL)
        AND ("storefront_orders"."status" <> 'delivered' OR "storefront_orders"."invoice_id" IS NOT NULL)
        AND ("storefront_orders"."status" <> 'cancelled' OR "storefront_orders"."packed_at" IS NULL OR "storefront_orders"."sales_return_id" IS NOT NULL)
        AND ("storefront_orders"."status" <> 'pending' OR num_nonnulls("storefront_orders"."sales_order_id", "storefront_orders"."document_error") = 0));--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD CONSTRAINT "storefront_orders_document_error_check" CHECK ("storefront_orders"."document_error" IS NULL OR ("storefront_orders"."sales_order_id" IS NULL
        AND "storefront_orders"."document_error" ~ '^[a-z][a-z0-9_]{0,63}$'));--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD CONSTRAINT "storefront_orders_cancel_reason_check" CHECK ("storefront_orders"."cancel_reason" IS NULL OR ("storefront_orders"."status" = 'cancelled'
        AND char_length("storefront_orders"."cancel_reason") BETWEEN 1 AND 200));