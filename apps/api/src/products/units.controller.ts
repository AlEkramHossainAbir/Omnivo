import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { UnitsService } from './units.service.js';

type Routes = typeof routes.units;

@Controller()
export class UnitsController {
  constructor(private readonly units: UnitsService) {}

  @Endpoint(routes.units.list)
  async list(): Promise<RouteResponse<Routes['list']>> {
    return { items: await this.units.list() };
  }

  @Endpoint(routes.units.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.units.create(body);
  }

  @Endpoint(routes.units.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.units.update(params.id, body);
  }

  @Endpoint(routes.units.archive)
  archive({
    params,
    body,
  }: RouteInput<Routes['archive']>): Promise<RouteResponse<Routes['archive']>> {
    return this.units.setArchived(params.id, body.version, true);
  }

  @Endpoint(routes.units.restore)
  restore({
    params,
    body,
  }: RouteInput<Routes['restore']>): Promise<RouteResponse<Routes['restore']>> {
    return this.units.setArchived(params.id, body.version, false);
  }

  @Endpoint(routes.units.remove)
  remove({ params, query }: RouteInput<Routes['remove']>): Promise<void> {
    return this.units.remove(params.id, query.version);
  }
}
