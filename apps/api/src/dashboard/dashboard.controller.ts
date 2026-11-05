import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { DashboardService } from './dashboard.service.js';

type Routes = typeof routes.dashboard;

@Controller()
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Endpoint(routes.dashboard.get)
  get({ query }: RouteInput<Routes['get']>): Promise<RouteResponse<Routes['get']>> {
    return this.dashboard.get(query);
  }
}
