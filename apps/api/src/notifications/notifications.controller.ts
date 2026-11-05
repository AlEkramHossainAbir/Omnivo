import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { NotificationsService } from './notifications.service.js';

type Routes = typeof routes.notifications;

@Controller()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Endpoint(routes.notifications.list)
  list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return this.notifications.list(query);
  }

  @Endpoint(routes.notifications.unreadCount)
  async unreadCount(): Promise<RouteResponse<Routes['unreadCount']>> {
    return { count: await this.notifications.unreadCount() };
  }

  @Endpoint(routes.notifications.markRead)
  markRead({ params }: RouteInput<Routes['markRead']>): Promise<void> {
    return this.notifications.markRead(params.id);
  }

  @Endpoint(routes.notifications.markAllRead)
  markAllRead(): Promise<void> {
    return this.notifications.markAllRead();
  }
}
