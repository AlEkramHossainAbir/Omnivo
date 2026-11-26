import { Controller, Headers } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../../common/http/endpoint.js';
import { CourierAccountsService } from './courier-accounts.service.js';
import { CourierWebhooks } from './courier-webhooks.js';

type Routes = typeof routes.shipping;

// Step 28a: Storefront → Shop couriers, and the courier's webhook. The accounts' routes need
// storefront.manage (the contract says so and the guard checks it); the webhook is public, and
// CourierWebhooks checks the account's token before it reads anything (decision 8)
@Controller()
export class CourierAccountsController {
  constructor(
    private readonly accounts: CourierAccountsService,
    private readonly webhooks: CourierWebhooks,
  ) {}

  @Endpoint(routes.shipping.getCouriers)
  getCouriers(): Promise<RouteResponse<Routes['getCouriers']>> {
    return this.accounts.setup();
  }

  @Endpoint(routes.shipping.createCourier)
  createCourier({
    body,
  }: RouteInput<Routes['createCourier']>): Promise<RouteResponse<Routes['createCourier']>> {
    return this.accounts.create(body);
  }

  // Declared before updateCourier only for reading order: the two have different methods on
  // /storefront/couriers and /storefront/couriers/:id, so Nest never mixes them up
  @Endpoint(routes.shipping.setDefaultCourier)
  setDefaultCourier({
    body,
  }: RouteInput<Routes['setDefaultCourier']>): Promise<RouteResponse<Routes['setDefaultCourier']>> {
    return this.accounts.setDefault(body.accountId);
  }

  @Endpoint(routes.shipping.updateCourier)
  updateCourier({
    params,
    body,
  }: RouteInput<Routes['updateCourier']>): Promise<RouteResponse<Routes['updateCourier']>> {
    return this.accounts.update(params.id, body);
  }

  @Endpoint(routes.shipping.testCourier)
  testCourier({
    params,
  }: RouteInput<Routes['testCourier']>): Promise<RouteResponse<Routes['testCourier']>> {
    return this.accounts.test(params.id);
  }

  @Endpoint(routes.shipping.renewCourierWebhookToken)
  renewCourierWebhookToken({
    params,
    body,
  }: RouteInput<Routes['renewCourierWebhookToken']>): Promise<
    RouteResponse<Routes['renewCourierWebhookToken']>
  > {
    return this.accounts.renewToken(params.id, body.version);
  }

  @Endpoint(routes.shipping.archiveCourier)
  archiveCourier({
    params,
    body,
  }: RouteInput<Routes['archiveCourier']>): Promise<RouteResponse<Routes['archiveCourier']>> {
    return this.accounts.archive(params.id, body.version);
  }

  @Endpoint(routes.shipping.restoreCourier)
  restoreCourier({
    params,
    body,
  }: RouteInput<Routes['restoreCourier']>): Promise<RouteResponse<Routes['restoreCourier']>> {
    return this.accounts.restore(params.id, body.version);
  }

  // The body is the contract's loose one (any object passes, decision 22). The header is read
  // with Nest's own decorator: it is not part of the contract's input
  @Endpoint(routes.shipping.steadfastWebhook)
  async steadfastWebhook(
    { params, body }: RouteInput<Routes['steadfastWebhook']>,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<RouteResponse<Routes['steadfastWebhook']>> {
    await this.webhooks.receive('steadfast', params.id, authorization, body);
    return { status: 'success', message: 'Received' };
  }
}
