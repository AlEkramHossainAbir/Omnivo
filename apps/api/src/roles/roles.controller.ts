import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { RolesService } from './roles.service.js';

type Routes = typeof routes.roles;

// permission চুক্তিতে (routes.roles.*.permission) — এখানে শুধু ইনপুট থেকে service-এ
@Controller()
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Endpoint(routes.roles.list)
  async list(): Promise<RouteResponse<Routes['list']>> {
    return { items: await this.roles.list() };
  }

  @Endpoint(routes.roles.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.roles.create(body);
  }

  @Endpoint(routes.roles.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.roles.update(params.id, body);
  }

  @Endpoint(routes.roles.remove)
  remove({ params, query }: RouteInput<Routes['remove']>): Promise<void> {
    return this.roles.remove(params.id, query.version);
  }

  @Endpoint(routes.roles.updateMatrix)
  async updateMatrix({
    body,
  }: RouteInput<Routes['updateMatrix']>): Promise<RouteResponse<Routes['updateMatrix']>> {
    return { items: await this.roles.updateMatrix(body) };
  }
}
