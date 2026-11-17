import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../../common/http/endpoint.js';
import { StorefrontCategoriesService } from './categories.service.js';
import { StorefrontImagesService } from './images.service.js';
import { StorefrontListingsService } from './listings.service.js';
import { StorefrontSettingsService } from './settings.service.js';

type Routes = typeof routes.storefront;

// Step 26g: the Storefront menu's 20 routes, all behind storefront.manage (the contract says so;
// the guard reads it). Thin on purpose: each one hands its parsed input to a service
@Controller()
export class StorefrontAdminController {
  constructor(
    private readonly settings: StorefrontSettingsService,
    private readonly categories: StorefrontCategoriesService,
    private readonly images: StorefrontImagesService,
    private readonly listings: StorefrontListingsService,
  ) {}

  @Endpoint(routes.storefront.getSettings)
  getSettings(): Promise<RouteResponse<Routes['getSettings']>> {
    return this.settings.setup();
  }

  @Endpoint(routes.storefront.createSettings)
  createSettings({
    body,
  }: RouteInput<Routes['createSettings']>): Promise<RouteResponse<Routes['createSettings']>> {
    return this.settings.create(body);
  }

  @Endpoint(routes.storefront.updateSettings)
  updateSettings({
    body,
  }: RouteInput<Routes['updateSettings']>): Promise<RouteResponse<Routes['updateSettings']>> {
    return this.settings.update(body);
  }

  @Endpoint(routes.storefront.launch)
  launch({ body }: RouteInput<Routes['launch']>): Promise<RouteResponse<Routes['launch']>> {
    return this.settings.launch(body.version);
  }

  @Endpoint(routes.storefront.listCategories)
  async listCategories(): Promise<RouteResponse<Routes['listCategories']>> {
    return { items: await this.categories.list() };
  }

  @Endpoint(routes.storefront.createCategory)
  createCategory({
    body,
  }: RouteInput<Routes['createCategory']>): Promise<RouteResponse<Routes['createCategory']>> {
    return this.categories.create(body);
  }

  @Endpoint(routes.storefront.updateCategory)
  updateCategory({
    params,
    body,
  }: RouteInput<Routes['updateCategory']>): Promise<RouteResponse<Routes['updateCategory']>> {
    return this.categories.update(params.id, body);
  }

  @Endpoint(routes.storefront.moveCategory)
  async moveCategory({
    params,
    body,
  }: RouteInput<Routes['moveCategory']>): Promise<RouteResponse<Routes['moveCategory']>> {
    return { items: await this.categories.move(params.id, body.direction, body.version) };
  }

  @Endpoint(routes.storefront.deleteCategory)
  deleteCategory({ params, query }: RouteInput<Routes['deleteCategory']>): Promise<void> {
    return this.categories.remove(params.id, query.version);
  }

  @Endpoint(routes.storefront.createUpload)
  createUpload({
    body,
  }: RouteInput<Routes['createUpload']>): Promise<RouteResponse<Routes['createUpload']>> {
    return this.images.createUpload(body);
  }

  @Endpoint(routes.storefront.completeUpload)
  completeUpload({
    params,
  }: RouteInput<Routes['completeUpload']>): Promise<RouteResponse<Routes['completeUpload']>> {
    return this.images.complete(params.id);
  }

  @Endpoint(routes.storefront.getUpload)
  getUpload({
    params,
  }: RouteInput<Routes['getUpload']>): Promise<RouteResponse<Routes['getUpload']>> {
    return this.images.get(params.id);
  }

  @Endpoint(routes.storefront.listListings)
  listListings({
    query,
  }: RouteInput<Routes['listListings']>): Promise<RouteResponse<Routes['listListings']>> {
    return this.listings.list(query);
  }

  @Endpoint(routes.storefront.listCandidates)
  listCandidates({
    query,
  }: RouteInput<Routes['listCandidates']>): Promise<RouteResponse<Routes['listCandidates']>> {
    return this.listings.candidates(query);
  }

  @Endpoint(routes.storefront.createListing)
  createListing({
    body,
  }: RouteInput<Routes['createListing']>): Promise<RouteResponse<Routes['createListing']>> {
    return this.listings.create(body);
  }

  @Endpoint(routes.storefront.getListing)
  getListing({
    params,
  }: RouteInput<Routes['getListing']>): Promise<RouteResponse<Routes['getListing']>> {
    return this.listings.get(params.id);
  }

  @Endpoint(routes.storefront.updateListing)
  updateListing({
    params,
    body,
  }: RouteInput<Routes['updateListing']>): Promise<RouteResponse<Routes['updateListing']>> {
    return this.listings.update(params.id, body);
  }

  @Endpoint(routes.storefront.publishListing)
  publishListing({
    params,
    body,
  }: RouteInput<Routes['publishListing']>): Promise<RouteResponse<Routes['publishListing']>> {
    return this.listings.publish(params.id, body.version);
  }

  @Endpoint(routes.storefront.unpublishListing)
  unpublishListing({
    params,
    body,
  }: RouteInput<Routes['unpublishListing']>): Promise<RouteResponse<Routes['unpublishListing']>> {
    return this.listings.unpublish(params.id, body.version);
  }

  @Endpoint(routes.storefront.deleteListing)
  deleteListing({ params, query }: RouteInput<Routes['deleteListing']>): Promise<void> {
    return this.listings.remove(params.id, query.version);
  }
}
