import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { CustomFieldsService } from './custom-fields.service.js';

type Routes = typeof routes.customFields;

@Controller()
export class CustomFieldsController {
  constructor(private readonly fields: CustomFieldsService) {}

  @Endpoint(routes.customFields.list)
  async list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return { items: await this.fields.list(query.entity) };
  }

  @Endpoint(routes.customFields.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.fields.create(body);
  }

  @Endpoint(routes.customFields.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.fields.update(params.id, body);
  }

  @Endpoint(routes.customFields.archive)
  archive({
    params,
    body,
  }: RouteInput<Routes['archive']>): Promise<RouteResponse<Routes['archive']>> {
    return this.fields.setArchived(params.id, body.version, true);
  }

  @Endpoint(routes.customFields.restore)
  restore({
    params,
    body,
  }: RouteInput<Routes['restore']>): Promise<RouteResponse<Routes['restore']>> {
    return this.fields.setArchived(params.id, body.version, false);
  }
}
