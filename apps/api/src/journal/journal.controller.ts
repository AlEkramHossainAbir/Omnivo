import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { JournalService } from './journal.service.js';

type Routes = typeof routes.journal;

@Controller()
export class JournalController {
  constructor(private readonly journal: JournalService) {}

  @Endpoint(routes.journal.list)
  list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return this.journal.list(query);
  }

  @Endpoint(routes.journal.get)
  get({ params }: RouteInput<Routes['get']>): Promise<RouteResponse<Routes['get']>> {
    return this.journal.get(params.id);
  }

  @Endpoint(routes.journal.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.journal.create(body);
  }

  @Endpoint(routes.journal.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.journal.update(params.id, body);
  }

  @Endpoint(routes.journal.remove)
  remove({ params, query }: RouteInput<Routes['remove']>): Promise<void> {
    return this.journal.remove(params.id, query.version);
  }

  @Endpoint(routes.journal.post)
  post({ params, body }: RouteInput<Routes['post']>): Promise<RouteResponse<Routes['post']>> {
    return this.journal.post(params.id, body.version);
  }

  @Endpoint(routes.journal.reverse)
  reverse({
    params,
    body,
  }: RouteInput<Routes['reverse']>): Promise<RouteResponse<Routes['reverse']>> {
    return this.journal.reverse(params.id, body);
  }
}
