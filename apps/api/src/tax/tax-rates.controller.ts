import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { TaxRatesService } from './tax-rates.service.js';

type Routes = typeof routes.taxRates;

@Controller()
export class TaxRatesController {
  constructor(private readonly taxRates: TaxRatesService) {}

  @Endpoint(routes.taxRates.list)
  async list(): Promise<RouteResponse<Routes['list']>> {
    return { items: await this.taxRates.list() };
  }

  @Endpoint(routes.taxRates.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.taxRates.create(body);
  }

  @Endpoint(routes.taxRates.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.taxRates.update(params.id, body);
  }

  @Endpoint(routes.taxRates.archive)
  archive({
    params,
    body,
  }: RouteInput<Routes['archive']>): Promise<RouteResponse<Routes['archive']>> {
    return this.taxRates.setArchived(params.id, body.version, true);
  }

  @Endpoint(routes.taxRates.restore)
  restore({
    params,
    body,
  }: RouteInput<Routes['restore']>): Promise<RouteResponse<Routes['restore']>> {
    return this.taxRates.setArchived(params.id, body.version, false);
  }
}
