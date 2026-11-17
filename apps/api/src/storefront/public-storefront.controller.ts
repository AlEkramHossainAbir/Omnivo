import { Controller, Header } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { PublicStorefrontService } from './public-storefront.service.js';
import { ShopHost } from './shop-host.decorator.js';

type Routes = typeof routes.publicStorefront;

// Step 26f: /public/v1, the shop's server's way into the ERP (no login). Every answer is no-store
// (the 26f.3 decision): a cache in front of the API keys an answer by its address, not by the
// X-Shop-Host header, so it could hand one shop's page to another. The shop's server keeps its own
// short cache, per host (26f.5).
@Controller()
export class PublicStorefrontController {
  constructor(private readonly storefront: PublicStorefrontService) {}

  @Endpoint(routes.publicStorefront.shop)
  @Header('Cache-Control', 'no-store')
  shop(@ShopHost() host: string | undefined): Promise<RouteResponse<Routes['shop']>> {
    return this.storefront.shop(host);
  }

  @Endpoint(routes.publicStorefront.categories)
  @Header('Cache-Control', 'no-store')
  categories(@ShopHost() host: string | undefined): Promise<RouteResponse<Routes['categories']>> {
    return this.storefront.categories(host);
  }

  @Endpoint(routes.publicStorefront.home)
  @Header('Cache-Control', 'no-store')
  home(@ShopHost() host: string | undefined): Promise<RouteResponse<Routes['home']>> {
    return this.storefront.home(host);
  }

  @Endpoint(routes.publicStorefront.listings)
  @Header('Cache-Control', 'no-store')
  listings(
    { query }: RouteInput<Routes['listings']>,
    @ShopHost() host: string | undefined,
  ): Promise<RouteResponse<Routes['listings']>> {
    return this.storefront.listings(host, query);
  }

  @Endpoint(routes.publicStorefront.product)
  @Header('Cache-Control', 'no-store')
  product(
    { params }: RouteInput<Routes['product']>,
    @ShopHost() host: string | undefined,
  ): Promise<RouteResponse<Routes['product']>> {
    return this.storefront.product(host, params.slug);
  }

  @Endpoint(routes.publicStorefront.quote)
  @Header('Cache-Control', 'no-store')
  quote(
    { body }: RouteInput<Routes['quote']>,
    @ShopHost() host: string | undefined,
  ): Promise<RouteResponse<Routes['quote']>> {
    return this.storefront.quote(host, body);
  }

  @Endpoint(routes.publicStorefront.checkoutSettings)
  @Header('Cache-Control', 'no-store')
  checkoutSettings(
    @ShopHost() host: string | undefined,
  ): Promise<RouteResponse<Routes['checkoutSettings']>> {
    return this.storefront.checkoutSettings(host);
  }

  @Endpoint(routes.publicStorefront.textPage)
  @Header('Cache-Control', 'no-store')
  textPage(
    { params }: RouteInput<Routes['textPage']>,
    @ShopHost() host: string | undefined,
  ): Promise<RouteResponse<Routes['textPage']>> {
    return this.storefront.textPage(host, params.slug);
  }
}
