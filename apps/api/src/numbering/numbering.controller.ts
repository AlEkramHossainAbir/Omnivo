import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { NumberingService } from './numbering.service.js';

type Routes = typeof routes.numberSeries;

@Controller()
export class NumberingController {
  constructor(private readonly numbering: NumberingService) {}

  @Endpoint(routes.numberSeries.list)
  async list(): Promise<RouteResponse<Routes['list']>> {
    return { items: await this.numbering.list() };
  }

  @Endpoint(routes.numberSeries.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.numbering.update(params.documentType, body);
  }
}
