import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { WarehousesService } from './warehouses.service.js';

type Routes = typeof routes.warehouses;

@Controller()
export class WarehousesController {
  constructor(private readonly warehouses: WarehousesService) {}

  @Endpoint(routes.warehouses.list)
  async list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return { items: await this.warehouses.list(query.status) };
  }

  @Endpoint(routes.warehouses.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.warehouses.create(body);
  }

  @Endpoint(routes.warehouses.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.warehouses.update(params.id, body);
  }

  @Endpoint(routes.warehouses.archive)
  archive({
    params,
    body,
  }: RouteInput<Routes['archive']>): Promise<RouteResponse<Routes['archive']>> {
    return this.warehouses.setArchived(params.id, body.version, true);
  }

  @Endpoint(routes.warehouses.restore)
  restore({
    params,
    body,
  }: RouteInput<Routes['restore']>): Promise<RouteResponse<Routes['restore']>> {
    return this.warehouses.setArchived(params.id, body.version, false);
  }
}
