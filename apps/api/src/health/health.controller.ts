import { Controller } from '@nestjs/common';
import { type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';

@Controller()
export class HealthController {
  // public চুক্তি থেকে — আলাদা @Public() লাগে না
  @Endpoint(routes.health.check)
  check(): RouteResponse<typeof routes.health.check> {
    return { status: 'ok' };
  }
}
