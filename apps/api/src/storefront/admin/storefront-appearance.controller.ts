import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../../common/http/endpoint.js';
import { StorefrontAppearanceService } from './appearance.service.js';
import { StorefrontCollectionsService } from './collections.service.js';
import { StorefrontPagesService } from './pages.service.js';

type Routes = typeof routes.storefrontAppearance;

// Step 26h: Appearance and the text pages, 16 routes behind storefront.manage (the contract says
// so; the guard reads it). Its own controller, as the contract has its own group: 26g's
// controller stays as it was. Thin on purpose, like that one
@Controller()
export class StorefrontAppearanceController {
  constructor(
    private readonly appearance: StorefrontAppearanceService,
    private readonly collections: StorefrontCollectionsService,
    private readonly pages: StorefrontPagesService,
  ) {}

  @Endpoint(routes.storefrontAppearance.getAppearance)
  getAppearance(): Promise<RouteResponse<Routes['getAppearance']>> {
    return this.appearance.get();
  }

  @Endpoint(routes.storefrontAppearance.updateTheme)
  updateTheme({
    body,
  }: RouteInput<Routes['updateTheme']>): Promise<RouteResponse<Routes['updateTheme']>> {
    return this.appearance.updateTheme(body);
  }

  @Endpoint(routes.storefrontAppearance.saveHero)
  saveHero({ body }: RouteInput<Routes['saveHero']>): Promise<RouteResponse<Routes['saveHero']>> {
    return this.appearance.saveHero(body);
  }

  @Endpoint(routes.storefrontAppearance.deleteHero)
  deleteHero({ query }: RouteInput<Routes['deleteHero']>): Promise<void> {
    return this.appearance.deleteHero(query.version);
  }

  @Endpoint(routes.storefrontAppearance.createBanner)
  createBanner({
    body,
  }: RouteInput<Routes['createBanner']>): Promise<RouteResponse<Routes['createBanner']>> {
    return this.appearance.createBanner(body);
  }

  @Endpoint(routes.storefrontAppearance.updateBanner)
  updateBanner({
    params,
    body,
  }: RouteInput<Routes['updateBanner']>): Promise<RouteResponse<Routes['updateBanner']>> {
    return this.appearance.updateBanner(params.id, body);
  }

  @Endpoint(routes.storefrontAppearance.deleteBanner)
  deleteBanner({ params, query }: RouteInput<Routes['deleteBanner']>): Promise<void> {
    return this.appearance.deleteBanner(params.id, query.version);
  }

  @Endpoint(routes.storefrontAppearance.getCollection)
  getCollection({
    params,
  }: RouteInput<Routes['getCollection']>): Promise<RouteResponse<Routes['getCollection']>> {
    return this.collections.get(params.id);
  }

  @Endpoint(routes.storefrontAppearance.createCollection)
  createCollection({
    body,
  }: RouteInput<Routes['createCollection']>): Promise<RouteResponse<Routes['createCollection']>> {
    return this.collections.create(body);
  }

  @Endpoint(routes.storefrontAppearance.updateCollection)
  updateCollection({
    params,
    body,
  }: RouteInput<Routes['updateCollection']>): Promise<RouteResponse<Routes['updateCollection']>> {
    return this.collections.update(params.id, body);
  }

  @Endpoint(routes.storefrontAppearance.deleteCollection)
  deleteCollection({ params, query }: RouteInput<Routes['deleteCollection']>): Promise<void> {
    return this.collections.remove(params.id, query.version);
  }

  @Endpoint(routes.storefrontAppearance.moveHomeBlock)
  moveHomeBlock({
    body,
  }: RouteInput<Routes['moveHomeBlock']>): Promise<RouteResponse<Routes['moveHomeBlock']>> {
    return this.appearance.moveBlock(body);
  }

  @Endpoint(routes.storefrontAppearance.listPages)
  listPages(): Promise<RouteResponse<Routes['listPages']>> {
    return this.pages.list();
  }

  @Endpoint(routes.storefrontAppearance.getPage)
  getPage({ params }: RouteInput<Routes['getPage']>): Promise<RouteResponse<Routes['getPage']>> {
    return this.pages.get(params.slug);
  }

  @Endpoint(routes.storefrontAppearance.savePage)
  savePage({
    params,
    body,
  }: RouteInput<Routes['savePage']>): Promise<RouteResponse<Routes['savePage']>> {
    return this.pages.save(params.slug, body);
  }

  @Endpoint(routes.storefrontAppearance.deletePage)
  deletePage({ params, query }: RouteInput<Routes['deletePage']>): Promise<void> {
    return this.pages.remove(params.slug, query.version);
  }
}
