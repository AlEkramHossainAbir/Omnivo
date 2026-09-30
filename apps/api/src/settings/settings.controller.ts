import { Controller } from '@nestjs/common';
import { type RouteInput, routes, type Settings } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { SettingsService } from './settings.service.js';

@Controller()
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  // পড়তে কোনো permission লাগে না: টাইমজোন, অর্থবছর আর মুদ্রা সবার স্ক্রিনেই লাগে (তারিখ, টাকা দেখানো)
  @Endpoint(routes.settings.get)
  get(): Promise<Settings> {
    return this.settings.get();
  }

  @Endpoint(routes.settings.update)
  update({ body }: RouteInput<typeof routes.settings.update>): Promise<Settings> {
    return this.settings.update(body);
  }

  @Endpoint(routes.settings.setLogo)
  setLogo({ body }: RouteInput<typeof routes.settings.setLogo>): Promise<Settings> {
    return this.settings.setLogo(body.attachmentId);
  }
}
