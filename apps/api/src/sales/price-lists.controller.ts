import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { PriceListsService } from './price-lists.service.js';

type Routes = typeof routes.priceLists;

@Controller()
export class PriceListsController {
  constructor(private readonly priceLists: PriceListsService) {}

  @Endpoint(routes.priceLists.list)
  async list(): Promise<RouteResponse<Routes['list']>> {
    return { items: await this.priceLists.list() };
  }

  @Endpoint(routes.priceLists.get)
  get({ params }: RouteInput<Routes['get']>): Promise<RouteResponse<Routes['get']>> {
    return this.priceLists.get(params.id);
  }

  @Endpoint(routes.priceLists.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.priceLists.create(body);
  }

  @Endpoint(routes.priceLists.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.priceLists.update(params.id, body);
  }

  @Endpoint(routes.priceLists.archive)
  archive({
    params,
    body,
  }: RouteInput<Routes['archive']>): Promise<RouteResponse<Routes['archive']>> {
    return this.priceLists.setArchived(params.id, body.version, true);
  }

  @Endpoint(routes.priceLists.restore)
  restore({
    params,
    body,
  }: RouteInput<Routes['restore']>): Promise<RouteResponse<Routes['restore']>> {
    return this.priceLists.setArchived(params.id, body.version, false);
  }

  @Endpoint(routes.priceLists.items)
  items({ params, query }: RouteInput<Routes['items']>): Promise<RouteResponse<Routes['items']>> {
    return this.priceLists.items(params.id, query);
  }

  @Endpoint(routes.priceLists.setItems)
  setItems({
    params,
    body,
  }: RouteInput<Routes['setItems']>): Promise<RouteResponse<Routes['setItems']>> {
    return this.priceLists.setItems(params.id, body);
  }
}
