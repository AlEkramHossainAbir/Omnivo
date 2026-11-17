CREATE TABLE "storefront_images" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"failure_code" text,
	"width" integer,
	"height" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "storefront_images_state_check" CHECK (("storefront_images"."status" = 'processing' AND "storefront_images"."failure_code" IS NULL AND "storefront_images"."width" IS NULL AND "storefront_images"."height" IS NULL AND "storefront_images"."processed_at" IS NULL)
        OR ("storefront_images"."status" = 'ready' AND "storefront_images"."failure_code" IS NULL AND "storefront_images"."width" IS NOT NULL AND "storefront_images"."height" IS NOT NULL AND "storefront_images"."processed_at" IS NOT NULL)
        OR ("storefront_images"."status" = 'failed' AND "storefront_images"."failure_code" IS NOT NULL AND "storefront_images"."failure_code" IN ('storefront_image_unreadable', 'storefront_image_too_small', 'storefront_image_too_many_pixels') AND "storefront_images"."width" IS NULL AND "storefront_images"."height" IS NULL AND "storefront_images"."processed_at" IS NOT NULL)),
	CONSTRAINT "storefront_images_size_check" CHECK ("storefront_images"."width" IS NULL OR (
        "storefront_images"."width" >= 200
        AND "storefront_images"."height" >= 200
        AND "storefront_images"."width"::bigint * "storefront_images"."height" <= 40000000))
);
--> statement-breakpoint
ALTER TABLE "storefront_images" ADD CONSTRAINT "storefront_images_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_images" ADD CONSTRAINT "storefront_images_attachment_fk" FOREIGN KEY ("tenant_id","id") REFERENCES "public"."attachments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;