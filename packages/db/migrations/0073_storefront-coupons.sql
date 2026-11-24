CREATE TABLE "storefront_coupons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"discount_kind" text NOT NULL,
	"discount_value" numeric(19, 4) NOT NULL,
	"up_to" numeric(19, 4),
	"minimum" numeric(19, 4),
	"starts_on" date,
	"last_day" date,
	"usage_limit" integer,
	"one_per_phone" boolean DEFAULT false NOT NULL,
	"first_ordered_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	CONSTRAINT "storefront_coupons_code_key" UNIQUE("tenant_id","code"),
	CONSTRAINT "storefront_coupons_order_key" UNIQUE("tenant_id","id","code"),
	CONSTRAINT "storefront_coupons_code_check" CHECK ("storefront_coupons"."code" ~ '^[A-Z0-9-]{1,20}$'),
	CONSTRAINT "storefront_coupons_discount_check" CHECK ("storefront_coupons"."discount_value" > 0
        AND CASE "storefront_coupons"."discount_kind"
          WHEN 'percent' THEN "storefront_coupons"."discount_value" = trunc("storefront_coupons"."discount_value") AND "storefront_coupons"."discount_value" <= 99
          ELSE "storefront_coupons"."discount_value" = round("storefront_coupons"."discount_value", 2) AND "storefront_coupons"."up_to" IS NULL END
        AND ("storefront_coupons"."up_to" IS NULL OR ("storefront_coupons"."up_to" > 0 AND "storefront_coupons"."up_to" = round("storefront_coupons"."up_to", 2)))
        AND ("storefront_coupons"."minimum" IS NULL OR ("storefront_coupons"."minimum" > 0 AND "storefront_coupons"."minimum" = round("storefront_coupons"."minimum", 2)))),
	CONSTRAINT "storefront_coupons_days_check" CHECK ("storefront_coupons"."starts_on" IS NULL OR "storefront_coupons"."last_day" IS NULL OR "storefront_coupons"."last_day" >= "storefront_coupons"."starts_on"),
	CONSTRAINT "storefront_coupons_usage_limit_check" CHECK ("storefront_coupons"."usage_limit" IS NULL OR "storefront_coupons"."usage_limit" BETWEEN 1 AND 1000000)
);
--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD COLUMN "coupon_id" uuid;--> statement-breakpoint
ALTER TABLE "storefront_coupons" ADD CONSTRAINT "storefront_coupons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storefront_coupons_list_idx" ON "storefront_coupons" USING btree ("tenant_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD CONSTRAINT "storefront_orders_coupon_fk" FOREIGN KEY ("tenant_id","coupon_id","coupon_code") REFERENCES "public"."storefront_coupons"("tenant_id","id","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storefront_orders_coupon_idx" ON "storefront_orders" USING btree ("tenant_id","coupon_id","status","created_at") WHERE "storefront_orders"."coupon_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD CONSTRAINT "storefront_orders_coupon_check" CHECK (("storefront_orders"."coupon_id" IS NULL) = ("storefront_orders"."coupon_code" IS NULL)
        AND ("storefront_orders"."coupon_id" IS NOT NULL OR "storefront_orders"."discount" = 0));