import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { AccountsService } from './accounts.service.js';

type Routes = typeof routes.accounts;

@Controller()
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Endpoint(routes.accounts.list)
  async list(): Promise<RouteResponse<Routes['list']>> {
    return { items: await this.accounts.list() };
  }

  @Endpoint(routes.accounts.get)
  get({ params }: RouteInput<Routes['get']>): Promise<RouteResponse<Routes['get']>> {
    return this.accounts.get(params.id);
  }

  @Endpoint(routes.accounts.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.accounts.create(body);
  }

  @Endpoint(routes.accounts.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.accounts.update(params.id, body);
  }

  @Endpoint(routes.accounts.archive)
  archive({
    params,
    body,
  }: RouteInput<Routes['archive']>): Promise<RouteResponse<Routes['archive']>> {
    return this.accounts.archive(params.id, body.version);
  }

  @Endpoint(routes.accounts.restore)
  restore({
    params,
    body,
  }: RouteInput<Routes['restore']>): Promise<RouteResponse<Routes['restore']>> {
    return this.accounts.restore(params.id, body.version);
  }

  @Endpoint(routes.accounts.remove)
  remove({ params, query }: RouteInput<Routes['remove']>): Promise<void> {
    return this.accounts.remove(params.id, query.version);
  }
}
