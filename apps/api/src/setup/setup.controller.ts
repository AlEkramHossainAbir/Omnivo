import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { SetupService } from './setup.service.js';

type Routes = typeof routes.setup;

@Controller()
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Endpoint(routes.setup.get)
  get(): Promise<RouteResponse<Routes['get']>> {
    return this.setup.get();
  }

  @Endpoint(routes.setup.start)
  start({ body }: RouteInput<Routes['start']>): Promise<RouteResponse<Routes['start']>> {
    return this.setup.start(body.industry);
  }

  @Endpoint(routes.setup.retry)
  retry(): Promise<RouteResponse<Routes['retry']>> {
    return this.setup.retry();
  }
}
