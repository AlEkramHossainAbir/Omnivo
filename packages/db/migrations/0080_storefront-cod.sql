ALTER TABLE "storefront_orders" DROP CONSTRAINT "storefront_orders_documents_check";--> statement-breakpoint
ALTER TABLE "courier_accounts" ADD COLUMN "cod_account_id" uuid;--> statement-breakpoint
ALTER TABLE "courier_accounts" ADD COLUMN "charge_account_id" uuid;--> statement-breakpoint
ALTER TABLE "storefront_shipments" ADD COLUMN "collected_amount" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "storefront_shipments" ADD COLUMN "courier_charge" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "storefront_shipments" ADD COLUMN "receipt_id" uuid;--> statement-breakpoint
ALTER TABLE "storefront_shipments" ADD COLUMN "receipt_error" text;--> statement-breakpoint
ALTER TABLE "courier_accounts" ADD CONSTRAINT "courier_accounts_cod_account_fk" FOREIGN KEY ("tenant_id","cod_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_accounts" ADD CONSTRAINT "courier_accounts_charge_account_fk" FOREIGN KEY ("tenant_id","charge_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_shipments" ADD CONSTRAINT "storefront_shipments_receipt_fk" FOREIGN KEY ("tenant_id","receipt_id") REFERENCES "public"."receipts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_shipments_receipt_idx" ON "storefront_shipments" USING btree ("tenant_id","receipt_id") WHERE "storefront_shipments"."receipt_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "storefront_shipments_cod_idx" ON "storefront_shipments" USING btree ("tenant_id","courier_account_id") WHERE "storefront_shipments"."receipt_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD CONSTRAINT "storefront_orders_documents_check" CHECK (("storefront_orders"."delivery_id" IS NULL OR "storefront_orders"."sales_order_id" IS NOT NULL)
        AND ("storefront_orders"."invoice_id" IS NULL OR "storefront_orders"."delivery_id" IS NOT NULL)
        AND ("storefront_orders"."sales_return_id" IS NULL OR ("storefront_orders"."delivery_id" IS NOT NULL
          AND "storefront_orders"."status" IN ('cancelled', 'delivered', 'returned')))
        AND ("storefront_orders"."status" <> 'returned' OR ("storefront_orders"."sales_return_id" IS NOT NULL AND "storefront_orders"."invoice_id" IS NULL))
        AND ("storefront_orders"."status" NOT IN ('packed', 'shipped', 'delivered') OR "storefront_orders"."delivery_id" IS NOT NULL)
        AND ("storefront_orders"."status" <> 'delivered' OR "storefront_orders"."invoice_id" IS NOT NULL)
        AND ("storefront_orders"."status" <> 'cancelled' OR "storefront_orders"."packed_at" IS NULL OR "storefront_orders"."sales_return_id" IS NOT NULL)
        AND ("storefront_orders"."status" <> 'pending' OR num_nonnulls("storefront_orders"."sales_order_id", "storefront_orders"."document_error") = 0));--> statement-breakpoint
ALTER TABLE "courier_accounts" ADD CONSTRAINT "courier_accounts_money_accounts_check" CHECK ("courier_accounts"."cod_account_id" IS NULL OR "courier_accounts"."charge_account_id" IS NULL
        OR "courier_accounts"."cod_account_id" <> "courier_accounts"."charge_account_id");--> statement-breakpoint
ALTER TABLE "storefront_shipments" ADD CONSTRAINT "storefront_shipments_cod_check" CHECK (("storefront_shipments"."collected_amount" IS NULL OR ("storefront_shipments"."collected_amount" >= 0
          AND "storefront_shipments"."collected_amount" = round("storefront_shipments"."collected_amount", 2)
          AND "storefront_shipments"."collected_amount" <= "storefront_shipments"."cod_amount"))
        AND ("storefront_shipments"."courier_charge" IS NULL OR ("storefront_shipments"."courier_charge" >= 0
          AND "storefront_shipments"."courier_charge" = round("storefront_shipments"."courier_charge", 2)))
        AND ("storefront_shipments"."receipt_id" IS NULL OR coalesce("storefront_shipments"."collected_amount", 0) > 0)
        AND num_nonnulls("storefront_shipments"."receipt_id", "storefront_shipments"."receipt_error") <= 1
        AND ("storefront_shipments"."receipt_error" IS NULL OR "storefront_shipments"."receipt_error" ~ '^[a-z][a-z0-9_]{0,63}$')
        AND ("storefront_shipments"."status" NOT IN ('booking', 'booking_failed')
          OR num_nonnulls("storefront_shipments"."collected_amount", "storefront_shipments"."courier_charge", "storefront_shipments"."receipt_id", "storefront_shipments"."receipt_error") = 0));