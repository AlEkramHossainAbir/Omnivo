CREATE TABLE "courier_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"courier" text NOT NULL,
	"archived_at" timestamp with time zone,
	"is_default" boolean DEFAULT false NOT NULL,
	"keys_sealed" "bytea",
	"key_version" smallint,
	"webhook_token_hash" text,
	"last_webhook_at" timestamp with time zone,
	"last_tested_at" timestamp with time zone,
	"last_test_problem" text,
	CONSTRAINT "courier_accounts_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "courier_accounts_values_check" CHECK ("courier_accounts"."provider" IN ('steadfast', 'manual')
        AND "courier_accounts"."courier" IN ('pathao', 'steadfast', 'redx', 'ecourier', 'paperfly')
        AND ("courier_accounts"."last_test_problem" IS NULL OR "courier_accounts"."last_test_problem" IN ('rejected', 'unreachable'))),
	CONSTRAINT "courier_accounts_courier_check" CHECK ("courier_accounts"."provider" = 'manual' OR ("courier_accounts"."provider", "courier_accounts"."courier") IN (('steadfast', 'steadfast'))),
	CONSTRAINT "courier_accounts_name_check" CHECK (char_length("courier_accounts"."name") BETWEEN 1 AND 60),
	CONSTRAINT "courier_accounts_secrets_check" CHECK (CASE "courier_accounts"."provider"
          WHEN 'manual' THEN num_nonnulls("courier_accounts"."keys_sealed", "courier_accounts"."key_version",
            "courier_accounts"."webhook_token_hash", "courier_accounts"."last_webhook_at", "courier_accounts"."last_tested_at",
            "courier_accounts"."last_test_problem") = 0
          ELSE num_nonnulls("courier_accounts"."keys_sealed", "courier_accounts"."key_version", "courier_accounts"."webhook_token_hash") = 3
            AND octet_length("courier_accounts"."keys_sealed") BETWEEN 29 AND 540
            AND "courier_accounts"."key_version" >= 1
            AND "courier_accounts"."webhook_token_hash" ~ '^[0-9a-f]{64}$'
        END),
	CONSTRAINT "courier_accounts_test_check" CHECK ("courier_accounts"."last_test_problem" IS NULL OR "courier_accounts"."last_tested_at" IS NOT NULL),
	CONSTRAINT "courier_accounts_default_check" CHECK (NOT "courier_accounts"."is_default" OR ("courier_accounts"."provider" <> 'manual' AND "courier_accounts"."archived_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "storefront_shipment_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"status" text,
	"note" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"event_key" text NOT NULL,
	"raw" jsonb,
	CONSTRAINT "storefront_shipment_events_key" UNIQUE("tenant_id","shipment_id","event_key"),
	CONSTRAINT "storefront_shipment_events_values_check" CHECK (("storefront_shipment_events"."status" IS NULL OR "storefront_shipment_events"."status" IN ('booked', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'partly_delivered', 'on_hold', 'returning', 'returned', 'cancelled'))
        AND "storefront_shipment_events"."source" IN ('booking', 'member', 'webhook', 'poll')
        AND ("storefront_shipment_events"."status" IS NOT NULL OR "storefront_shipment_events"."raw" IS NOT NULL)),
	CONSTRAINT "storefront_shipment_events_text_check" CHECK (("storefront_shipment_events"."note" IS NULL OR char_length("storefront_shipment_events"."note") BETWEEN 1 AND 300)
        AND "storefront_shipment_events"."event_key" ~ '^[0-9a-f]{64}$'
        AND ("storefront_shipment_events"."raw" IS NULL OR octet_length("storefront_shipment_events"."raw"::text) <= 8192))
);
--> statement-breakpoint
CREATE TABLE "storefront_shipments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"order_id" uuid NOT NULL,
	"courier_account_id" uuid NOT NULL,
	"parcel_no" smallint NOT NULL,
	"invoice" text NOT NULL,
	"courier" text NOT NULL,
	"status" text DEFAULT 'booking' NOT NULL,
	"consignment_id" text,
	"tracking_code" text,
	"tracking_url" text,
	"cod_amount" numeric(19, 4) NOT NULL,
	"booked_at" timestamp with time zone,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"error" text,
	"error_detail" text,
	"last_synced_at" timestamp with time zone,
	CONSTRAINT "storefront_shipments_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "storefront_shipments_parcel_key" UNIQUE("tenant_id","order_id","parcel_no"),
	CONSTRAINT "storefront_shipments_invoice_key" UNIQUE("tenant_id","courier_account_id","invoice"),
	CONSTRAINT "storefront_shipments_values_check" CHECK ("storefront_shipments"."status" IN ('booking', 'booking_failed', 'booked', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'partly_delivered', 'on_hold', 'returning', 'returned', 'cancelled')
        AND "storefront_shipments"."courier" IN ('pathao', 'steadfast', 'redx', 'ecourier', 'paperfly')),
	CONSTRAINT "storefront_shipments_parcel_check" CHECK ("storefront_shipments"."parcel_no" BETWEEN 1 AND 5),
	CONSTRAINT "storefront_shipments_status_check" CHECK (CASE WHEN "storefront_shipments"."status" IN ('booking', 'booking_failed')
          THEN num_nonnulls("storefront_shipments"."consignment_id", "storefront_shipments"."tracking_code", "storefront_shipments"."tracking_url", "storefront_shipments"."booked_at") = 0
          ELSE num_nonnulls("storefront_shipments"."tracking_code", "storefront_shipments"."booked_at") = 2
            AND num_nonnulls("storefront_shipments"."error", "storefront_shipments"."error_detail") = 0
        END
        AND ("storefront_shipments"."status" <> 'booking_failed' OR "storefront_shipments"."error" IS NOT NULL)),
	CONSTRAINT "storefront_shipments_text_check" CHECK (("storefront_shipments"."tracking_code" IS NULL OR "storefront_shipments"."tracking_code" ~ '^[A-Z0-9-]{1,64}$')
        AND ("storefront_shipments"."consignment_id" IS NULL OR char_length("storefront_shipments"."consignment_id") BETWEEN 1 AND 64)
        AND ("storefront_shipments"."tracking_url" IS NULL OR ("storefront_shipments"."tracking_url" LIKE 'https://%' AND char_length("storefront_shipments"."tracking_url") <= 300))
        AND ("storefront_shipments"."error" IS NULL OR "storefront_shipments"."error" ~ '^[a-z][a-z0-9_]{0,63}$')
        AND ("storefront_shipments"."error_detail" IS NULL OR char_length("storefront_shipments"."error_detail") BETWEEN 1 AND 300)),
	CONSTRAINT "storefront_shipments_amounts_check" CHECK ("storefront_shipments"."cod_amount" >= 0 AND "storefront_shipments"."cod_amount" = round("storefront_shipments"."cod_amount", 2)
        AND "storefront_shipments"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "courier_accounts" ADD CONSTRAINT "courier_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_shipment_events" ADD CONSTRAINT "storefront_shipment_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_shipment_events" ADD CONSTRAINT "storefront_shipment_events_shipment_fk" FOREIGN KEY ("tenant_id","shipment_id") REFERENCES "public"."storefront_shipments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_shipments" ADD CONSTRAINT "storefront_shipments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_shipments" ADD CONSTRAINT "storefront_shipments_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."storefront_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_shipments" ADD CONSTRAINT "storefront_shipments_account_fk" FOREIGN KEY ("tenant_id","courier_account_id") REFERENCES "public"."courier_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "courier_accounts_default_idx" ON "courier_accounts" USING btree ("tenant_id") WHERE "courier_accounts"."is_default";--> statement-breakpoint
CREATE INDEX "storefront_shipment_events_shipment_idx" ON "storefront_shipment_events" USING btree ("tenant_id","shipment_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_shipments_consignment_idx" ON "storefront_shipments" USING btree ("tenant_id","courier_account_id","consignment_id") WHERE "storefront_shipments"."consignment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_shipments_open_idx" ON "storefront_shipments" USING btree ("tenant_id","order_id") WHERE "storefront_shipments"."status" IN ('booking', 'booked', 'picked_up', 'in_transit', 'out_for_delivery', 'on_hold', 'returning');--> statement-breakpoint
CREATE INDEX "storefront_shipments_poll_idx" ON "storefront_shipments" USING btree ("tenant_id","last_synced_at") WHERE "storefront_shipments"."status" IN ('booking', 'booked', 'picked_up', 'in_transit', 'out_for_delivery', 'on_hold', 'returning');