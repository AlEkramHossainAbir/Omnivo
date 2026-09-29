import { Controller } from '@nestjs/common';
import { type Preferences, type RouteInput, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { currentPrincipal } from '../common/tenant/tenant-context.js';
import { AuthService } from './auth.service.js';

// নিজের জিনিস বদলানো (ধাপ ৭-এ প্রোফাইল, পাসওয়ার্ড) — কোনো permission লাগে না, শুধু লগইন
@Controller()
export class MeController {
  constructor(private readonly authService: AuthService) {}

  @Endpoint(routes.me.updatePreferences)
  updatePreferences({
    body,
  }: RouteInput<typeof routes.me.updatePreferences>): Promise<Preferences> {
    return this.authService.updatePreferences(currentPrincipal(), body);
  }
}
