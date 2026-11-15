CREATE TABLE "storefront_banners" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"href" text NOT NULL,
	"desktop_image" jsonb NOT NULL,
	"phone_image" jsonb NOT NULL,
	"headline" text,
	"line" text,
	"eyebrow" text,
	"button_label" text,
	"background_color" text,
	"panel_color" text,
	"button_color" text,
	"button_text_color" text,
	CONSTRAINT "storefront_banners_href_check" CHECK ("storefront_banners"."href" ~ '^(/([^/]|$)|https://)'),
	CONSTRAINT "storefront_banners_images_check" CHECK (jsonb_typeof("storefront_banners"."desktop_image") = 'object' AND jsonb_typeof("storefront_banners"."phone_image") = 'object'),
	CONSTRAINT "storefront_banners_hero_check" CHECK (("storefront_banners"."kind" = 'hero' AND num_nonnulls("storefront_banners"."headline", "storefront_banners"."button_label", "storefront_banners"."background_color", "storefront_banners"."panel_color", "storefront_banners"."button_color", "storefront_banners"."button_text_color") = 6)
        OR ("storefront_banners"."kind" = 'image' AND num_nonnulls("storefront_banners"."headline", "storefront_banners"."line", "storefront_banners"."eyebrow", "storefront_banners"."button_label", "storefront_banners"."background_color", "storefront_banners"."panel_color", "storefront_banners"."button_color", "storefront_banners"."button_text_color") = 0)),
	CONSTRAINT "storefront_banners_colors_check" CHECK ("storefront_banners"."background_color" ~ '^#[0-9a-fA-F]{6}$' AND "storefront_banners"."panel_color" ~ '^#[0-9a-fA-F]{6}$' AND "storefront_banners"."button_color" ~ '^#[0-9a-fA-F]{6}$' AND "storefront_banners"."button_text_color" ~ '^#[0-9a-fA-F]{6}$')
);--> statement-breakpoint
CREATE TABLE "storefront_categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"tenant_id" uuid NOT NULL,
	"parent_id" uuid,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "storefront_categories_parent_not_self" CHECK ("storefront_categories"."parent_id" <> "storefront_categories"."id"),
	CONSTRAINT "storefront_categories_slug_check" CHECK ("storefront_categories"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("storefront_categories"."slug") <= 100)
);--> statement-breakpoint
CREATE TABLE "storefront_collection_items" (
	"tenant_id" uuid NOT NULL,
	"collection_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	CONSTRAINT "storefront_collection_items_pkey" PRIMARY KEY("tenant_id","collection_id","listing_id"),
	CONSTRAINT "storefront_collection_items_position_check" CHECK ("storefront_collection_items"."position" >= 1)
);--> statement-breakpoint
CREATE TABLE "storefront_collections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"icon" text
);--> statement-breakpoint
CREATE TABLE "storefront_home_blocks" (
	"tenant_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"banner_id" uuid,
	"collection_id" uuid,
	CONSTRAINT "storefront_home_blocks_pkey" PRIMARY KEY("tenant_id","position"),
	CONSTRAINT "storefront_home_blocks_one_check" CHECK (num_nonnulls("storefront_home_blocks"."banner_id", "storefront_home_blocks"."collection_id") = 1),
	CONSTRAINT "storefront_home_blocks_position_check" CHECK ("storefront_home_blocks"."position" >= 1)
);--> statement-breakpoint
CREATE TABLE "storefront_listings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"pack_size" text DEFAULT '' NOT NULL,
	"price_override" numeric(19, 4),
	"sale_kind" text,
	"sale_value" numeric(19, 4),
	"sale_starts_at" timestamp with time zone,
	"sale_ends_at" timestamp with time zone,
	"badges" text[] DEFAULT '{}'::text[] NOT NULL,
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"description_sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seo_title" text,
	"seo_description" text,
	"published_at" timestamp with time zone,
	CONSTRAINT "storefront_listings_slug_check" CHECK ("storefront_listings"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("storefront_listings"."slug") <= 100),
	CONSTRAINT "storefront_listings_price_check" CHECK ("storefront_listings"."price_override" IS NULL OR "storefront_listings"."price_override" > 0),
	CONSTRAINT "storefront_listings_sale_check" CHECK (("storefront_listings"."sale_kind" IS NULL) = ("storefront_listings"."sale_value" IS NULL)
        AND ("storefront_listings"."sale_kind" IS NOT NULL OR ("storefront_listings"."sale_starts_at" IS NULL AND "storefront_listings"."sale_ends_at" IS NULL))
        AND ("storefront_listings"."sale_value" IS NULL OR "storefront_listings"."sale_value" > 0)
        AND ("storefront_listings"."sale_kind" IS DISTINCT FROM 'percent' OR ("storefront_listings"."sale_value" = trunc("storefront_listings"."sale_value") AND "storefront_listings"."sale_value" <= 99))
        AND ("storefront_listings"."sale_starts_at" IS NULL OR "storefront_listings"."sale_ends_at" IS NULL OR "storefront_listings"."sale_starts_at" < "storefront_listings"."sale_ends_at")),
	CONSTRAINT "storefront_listings_images_check" CHECK (jsonb_typeof("storefront_listings"."images") = 'array' AND CASE WHEN jsonb_typeof("storefront_listings"."images") = 'array' THEN jsonb_array_length("storefront_listings"."images") END <= 4),
	CONSTRAINT "storefront_listings_published_check" CHECK ("storefront_listings"."published_at" IS NULL OR CASE WHEN jsonb_typeof("storefront_listings"."images") = 'array' THEN jsonb_array_length("storefront_listings"."images") END >= 1),
	CONSTRAINT "storefront_listings_sections_check" CHECK (jsonb_typeof("storefront_listings"."description_sections") = 'array' AND CASE WHEN jsonb_typeof("storefront_listings"."description_sections") = 'array' THEN jsonb_array_length("storefront_listings"."description_sections") END <= 12),
	CONSTRAINT "storefront_listings_seo_check" CHECK (coalesce(char_length("storefront_listings"."seo_title"), 1) BETWEEN 1 AND 120 AND coalesce(char_length("storefront_listings"."seo_description"), 0) <= 300)
);--> statement-breakpoint
CREATE TABLE "storefront_pages" (
	"tenant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"sections" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "storefront_pages_pkey" PRIMARY KEY("tenant_id","slug"),
	CONSTRAINT "storefront_pages_sections_check" CHECK (jsonb_typeof("storefront_pages"."sections") = 'array' AND CASE WHEN jsonb_typeof("storefront_pages"."sections") = 'array' THEN jsonb_array_length("storefront_pages"."sections") END BETWEEN 1 AND 12)
);--> statement-breakpoint
CREATE TABLE "storefront_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"subdomain" text NOT NULL,
	"name" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"logo_image_id" uuid,
	"brand_color" text DEFAULT '#005859' NOT NULL,
	"accent_color" text DEFAULT '#b8ef69' NOT NULL,
	"hotline" text NOT NULL,
	"address" text NOT NULL,
	"facebook_url" text,
	"instagram_url" text,
	"x_url" text,
	"linkedin_url" text,
	"default_warehouse_id" uuid,
	"delivery_zones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"free_delivery_from" numeric(19, 4),
	"minimum_order" numeric(19, 4),
	"payment_methods" text[] DEFAULT '{cod}'::text[] NOT NULL,
	"launched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "storefront_settings_subdomain_check" CHECK ("storefront_settings"."subdomain" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
	CONSTRAINT "storefront_settings_colors_check" CHECK ("storefront_settings"."brand_color" ~ '^#[0-9a-fA-F]{6}$' AND "storefront_settings"."accent_color" ~ '^#[0-9a-fA-F]{6}$'),
	CONSTRAINT "storefront_settings_social_check" CHECK (coalesce("storefront_settings"."facebook_url", 'https://') LIKE 'https://%' AND coalesce("storefront_settings"."instagram_url", 'https://') LIKE 'https://%' AND coalesce("storefront_settings"."x_url", 'https://') LIKE 'https://%' AND coalesce("storefront_settings"."linkedin_url", 'https://') LIKE 'https://%'),
	CONSTRAINT "storefront_settings_zones_check" CHECK (jsonb_typeof("storefront_settings"."delivery_zones") = 'array' AND CASE WHEN jsonb_typeof("storefront_settings"."delivery_zones") = 'array' THEN jsonb_array_length("storefront_settings"."delivery_zones") END <= 6),
	CONSTRAINT "storefront_settings_amounts_check" CHECK (coalesce("storefront_settings"."free_delivery_from", 1) > 0 AND coalesce("storefront_settings"."minimum_order", 1) > 0),
	CONSTRAINT "storefront_settings_payment_check" CHECK (cardinality("storefront_settings"."payment_methods") >= 1),
	CONSTRAINT "storefront_settings_launch_check" CHECK ("storefront_settings"."launched_at" IS NULL OR ("storefront_settings"."default_warehouse_id" IS NOT NULL AND CASE WHEN jsonb_typeof("storefront_settings"."delivery_zones") = 'array' THEN jsonb_array_length("storefront_settings"."delivery_zones") END >= 1))
);--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_banners_tenant_id_idx" ON "storefront_banners" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_banners_hero_idx" ON "storefront_banners" USING btree ("tenant_id") WHERE "storefront_banners"."kind" = 'hero';--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_categories_slug_idx" ON "storefront_categories" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_categories_sibling_name_idx" ON "storefront_categories" USING btree ("tenant_id",coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_categories_tenant_id_idx" ON "storefront_categories" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "storefront_categories_tenant_parent_idx" ON "storefront_categories" USING btree ("tenant_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_collection_items_position_idx" ON "storefront_collection_items" USING btree ("tenant_id","collection_id","position");--> statement-breakpoint
CREATE INDEX "storefront_collection_items_listing_idx" ON "storefront_collection_items" USING btree ("tenant_id","listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_collections_tenant_id_idx" ON "storefront_collections" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_home_blocks_banner_idx" ON "storefront_home_blocks" USING btree ("tenant_id","banner_id") WHERE "storefront_home_blocks"."banner_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_home_blocks_collection_idx" ON "storefront_home_blocks" USING btree ("tenant_id","collection_id") WHERE "storefront_home_blocks"."collection_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_listings_slug_idx" ON "storefront_listings" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_listings_variant_idx" ON "storefront_listings" USING btree ("tenant_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_listings_tenant_id_idx" ON "storefront_listings" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "storefront_listings_product_idx" ON "storefront_listings" USING btree ("tenant_id","product_id");--> statement-breakpoint
CREATE INDEX "storefront_listings_category_idx" ON "storefront_listings" USING btree ("tenant_id","category_id");--> statement-breakpoint
CREATE INDEX "storefront_listings_published_idx" ON "storefront_listings" USING btree ("tenant_id","published_at" DESC NULLS LAST) WHERE "storefront_listings"."published_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_settings_subdomain_idx" ON "storefront_settings" USING btree ("subdomain");--> statement-breakpoint
ALTER TABLE "storefront_banners" ADD CONSTRAINT "storefront_banners_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_categories" ADD CONSTRAINT "storefront_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_categories" ADD CONSTRAINT "storefront_categories_parent_fk" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."storefront_categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_collection_items" ADD CONSTRAINT "storefront_collection_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_collection_items" ADD CONSTRAINT "storefront_collection_items_collection_fk" FOREIGN KEY ("tenant_id","collection_id") REFERENCES "public"."storefront_collections"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_collection_items" ADD CONSTRAINT "storefront_collection_items_listing_fk" FOREIGN KEY ("tenant_id","listing_id") REFERENCES "public"."storefront_listings"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_collections" ADD CONSTRAINT "storefront_collections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_home_blocks" ADD CONSTRAINT "storefront_home_blocks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_home_blocks" ADD CONSTRAINT "storefront_home_blocks_banner_fk" FOREIGN KEY ("tenant_id","banner_id") REFERENCES "public"."storefront_banners"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_home_blocks" ADD CONSTRAINT "storefront_home_blocks_collection_fk" FOREIGN KEY ("tenant_id","collection_id") REFERENCES "public"."storefront_collections"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_listings" ADD CONSTRAINT "storefront_listings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_listings" ADD CONSTRAINT "storefront_listings_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_listings" ADD CONSTRAINT "storefront_listings_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."storefront_categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_pages" ADD CONSTRAINT "storefront_pages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_settings" ADD CONSTRAINT "storefront_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_settings" ADD CONSTRAINT "storefront_settings_warehouse_fk" FOREIGN KEY ("tenant_id","default_warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;