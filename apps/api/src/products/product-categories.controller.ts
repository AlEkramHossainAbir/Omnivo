import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { ProductCategoriesService } from './product-categories.service.js';

type Routes = typeof routes.productCategories;

@Controller()
export class ProductCategoriesController {
  constructor(private readonly categories: ProductCategoriesService) {}

  @Endpoint(routes.productCategories.list)
  async list(): Promise<RouteResponse<Routes['list']>> {
    return { items: await this.categories.list() };
  }

  @Endpoint(routes.productCategories.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.categories.create(body);
  }

  @Endpoint(routes.productCategories.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.categories.update(params.id, body);
  }

  @Endpoint(routes.productCategories.remove)
  remove({ params, query }: RouteInput<Routes['remove']>): Promise<void> {
    return this.categories.remove(params.id, query.version);
  }
}
