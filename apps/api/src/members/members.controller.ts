import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { MembersService } from './members.service.js';

type Routes = typeof routes.members;

@Controller()
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Endpoint(routes.members.list)
  list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return this.members.list(query);
  }

  @Endpoint(routes.members.updateRoles)
  updateRoles({
    params,
    body,
  }: RouteInput<Routes['updateRoles']>): Promise<RouteResponse<Routes['updateRoles']>> {
    return this.members.updateRoles(params.id, body.roleIds, body.version);
  }

  @Endpoint(routes.members.remove)
  remove({ params, query }: RouteInput<Routes['remove']>): Promise<void> {
    return this.members.remove(params.id, query.version);
  }
}
