import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { DevicesService } from './devices.service.js';

type Routes = typeof routes.devices;

// Step 18c. Only the workspace list has a permission on its route (core.device.manage). Rename,
// move and revoke check in the service whether the device is the person's own (decision 5).
@Controller()
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Endpoint(routes.devices.mine)
  mine(): Promise<RouteResponse<Routes['mine']>> {
    return this.devices.mine();
  }

  @Endpoint(routes.devices.list)
  list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return this.devices.list(query);
  }

  @Endpoint(routes.devices.rename)
  rename({ params, body }: RouteInput<Routes['rename']>): Promise<RouteResponse<Routes['rename']>> {
    return this.devices.rename(params.id, body);
  }

  @Endpoint(routes.devices.move)
  move({ params, body }: RouteInput<Routes['move']>): Promise<RouteResponse<Routes['move']>> {
    return this.devices.move(params.id, body);
  }

  @Endpoint(routes.devices.revoke)
  revoke({ params }: RouteInput<Routes['revoke']>): Promise<RouteResponse<Routes['revoke']>> {
    return this.devices.revoke(params.id);
  }
}
