import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { ReportSchedulesService } from './report-schedules.service.js';

type Schedules = typeof routes.reportSchedules;

// Step 21c: the scheduled report emails. Every route needs core.report.schedule; the service checks
// the report's own permission too.
@Controller()
export class ReportSchedulesController {
  constructor(private readonly schedules: ReportSchedulesService) {}

  @Endpoint(routes.reportSchedules.list)
  list(): Promise<RouteResponse<Schedules['list']>> {
    return this.schedules.list();
  }

  @Endpoint(routes.reportSchedules.candidates)
  candidates({
    query,
  }: RouteInput<Schedules['candidates']>): Promise<RouteResponse<Schedules['candidates']>> {
    return this.schedules.candidates(query.report);
  }

  @Endpoint(routes.reportSchedules.create)
  create({ body }: RouteInput<Schedules['create']>): Promise<RouteResponse<Schedules['create']>> {
    return this.schedules.create(body);
  }

  @Endpoint(routes.reportSchedules.update)
  update({
    params,
    body,
  }: RouteInput<Schedules['update']>): Promise<RouteResponse<Schedules['update']>> {
    return this.schedules.update(params.id, body);
  }

  @Endpoint(routes.reportSchedules.pause)
  pause({
    params,
    body,
  }: RouteInput<Schedules['pause']>): Promise<RouteResponse<Schedules['pause']>> {
    return this.schedules.pause(params.id, body.version);
  }

  @Endpoint(routes.reportSchedules.resume)
  resume({
    params,
    body,
  }: RouteInput<Schedules['resume']>): Promise<RouteResponse<Schedules['resume']>> {
    return this.schedules.resume(params.id, body.version);
  }

  @Endpoint(routes.reportSchedules.remove)
  remove({ params }: RouteInput<Schedules['remove']>): Promise<void> {
    return this.schedules.remove(params.id);
  }
}
