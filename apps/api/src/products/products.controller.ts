import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { ProductImportsService } from './product-imports.service.js';
import { ProductsService } from './products.service.js';

type Routes = typeof routes.products;
type ImportRoutes = typeof routes.productImports;

@Controller()
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Endpoint(routes.products.list)
  list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return this.products.list(query);
  }

  @Endpoint(routes.products.get)
  get({ params }: RouteInput<Routes['get']>): Promise<RouteResponse<Routes['get']>> {
    return this.products.get(params.id);
  }

  @Endpoint(routes.products.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.products.create(body);
  }

  @Endpoint(routes.products.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.products.update(params.id, body);
  }

  @Endpoint(routes.products.archive)
  archive({
    params,
    body,
  }: RouteInput<Routes['archive']>): Promise<RouteResponse<Routes['archive']>> {
    return this.products.setArchived(params.id, body.version, true);
  }

  @Endpoint(routes.products.restore)
  restore({
    params,
    body,
  }: RouteInput<Routes['restore']>): Promise<RouteResponse<Routes['restore']>> {
    return this.products.setArchived(params.id, body.version, false);
  }

  @Endpoint(routes.products.remove)
  remove({ params, query }: RouteInput<Routes['remove']>): Promise<void> {
    return this.products.remove(params.id, query.version);
  }
}

@Controller()
export class ProductImportsController {
  constructor(private readonly imports: ProductImportsService) {}

  @Endpoint(routes.productImports.create)
  create({
    body,
  }: RouteInput<ImportRoutes['create']>): Promise<RouteResponse<ImportRoutes['create']>> {
    return this.imports.create(body);
  }

  @Endpoint(routes.productImports.start)
  start({
    params,
  }: RouteInput<ImportRoutes['start']>): Promise<RouteResponse<ImportRoutes['start']>> {
    return this.imports.start(params.id);
  }

  @Endpoint(routes.productImports.list)
  list({ query }: RouteInput<ImportRoutes['list']>): Promise<RouteResponse<ImportRoutes['list']>> {
    return this.imports.list(query);
  }

  @Endpoint(routes.productImports.get)
  get({ params }: RouteInput<ImportRoutes['get']>): Promise<RouteResponse<ImportRoutes['get']>> {
    return this.imports.get(params.id);
  }
}
