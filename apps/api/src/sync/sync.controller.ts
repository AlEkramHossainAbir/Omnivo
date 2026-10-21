import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { DevicesService } from './devices.service.js';
import { SyncService } from './sync.service.js';

type Routes = typeof routes.sync;

// No permission on either route (decision 21): every member may work offline, and a pull sends
// only what every member may read anyway
@Controller()
export class SyncController {
  constructor(
    private readonly devices: DevicesService,
    private readonly sync: SyncService,
  ) {}

  @Endpoint(routes.sync.registerDevice)
  registerDevice({
    body,
  }: RouteInput<Routes['registerDevice']>): Promise<RouteResponse<Routes['registerDevice']>> {
    return this.devices.register(body);
  }

  @Endpoint(routes.sync.pull)
  pull({ query }: RouteInput<Routes['pull']>): Promise<RouteResponse<Routes['pull']>> {
    return this.sync.pull(query);
  }
}
