import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { BranchesService } from './branches.service.js';

type Routes = typeof routes.branches;

// পড়তে permission লাগে না: ব্রাঞ্চের তালিকা পরে প্রায় প্রতিটা ফর্মের drop-down-এ (কোন ব্রাঞ্চের ইনভয়েস)
@Controller()
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Endpoint(routes.branches.list)
  async list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return { items: await this.branches.list(query.status) };
  }

  @Endpoint(routes.branches.get)
  get({ params }: RouteInput<Routes['get']>): Promise<RouteResponse<Routes['get']>> {
    return this.branches.get(params.id);
  }

  @Endpoint(routes.branches.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.branches.create(body);
  }

  @Endpoint(routes.branches.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.branches.update(params.id, body);
  }

  @Endpoint(routes.branches.archive)
  archive({
    params,
    body,
  }: RouteInput<Routes['archive']>): Promise<RouteResponse<Routes['archive']>> {
    return this.branches.archive(params.id, body.version);
  }

  @Endpoint(routes.branches.restore)
  restore({
    params,
    body,
  }: RouteInput<Routes['restore']>): Promise<RouteResponse<Routes['restore']>> {
    return this.branches.restore(params.id, body.version);
  }
}
