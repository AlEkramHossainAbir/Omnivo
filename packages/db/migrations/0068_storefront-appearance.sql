ALTER TABLE "storefront_collection_items" DROP CONSTRAINT "storefront_collection_items_position_check";--> statement-breakpoint
ALTER TABLE "storefront_home_blocks" DROP CONSTRAINT "storefront_home_blocks_position_check";--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_images_tenant_id_idx" ON "storefront_images" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "storefront_categories" ADD CONSTRAINT "storefront_categories_slug_reserved_check" CHECK ("storefront_categories"."slug" <> 'all');--> statement-breakpoint
ALTER TABLE "storefront_collection_items" ADD CONSTRAINT "storefront_collection_items_position_check" CHECK ("storefront_collection_items"."position" BETWEEN 1 AND 24);--> statement-breakpoint
ALTER TABLE "storefront_home_blocks" ADD CONSTRAINT "storefront_home_blocks_position_check" CHECK ("storefront_home_blocks"."position" BETWEEN 1 AND 12);