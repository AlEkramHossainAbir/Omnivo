import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../../common/http/endpoint.js';
import { StorefrontPaymentGatewayService } from './payment-gateway.service.js';

type Routes = typeof routes.storefrontPayments;

// Step 27d: Shop settings → Payment. The contract names the permission (storefront.manage) and
// the guard checks it before any of these runs
@Controller()
export class StorefrontPaymentsController {
  constructor(private readonly gateways: StorefrontPaymentGatewayService) {}

  @Endpoint(routes.storefrontPayments.getPaymentGateway)
  getPaymentGateway(): Promise<RouteResponse<Routes['getPaymentGateway']>> {
    return this.gateways.setup();
  }

  @Endpoint(routes.storefrontPayments.createPaymentGateway)
  createPaymentGateway({
    body,
  }: RouteInput<Routes['createPaymentGateway']>): Promise<
    RouteResponse<Routes['createPaymentGateway']>
  > {
    return this.gateways.create(body);
  }

  @Endpoint(routes.storefrontPayments.updatePaymentGateway)
  updatePaymentGateway({
    body,
  }: RouteInput<Routes['updatePaymentGateway']>): Promise<
    RouteResponse<Routes['updatePaymentGateway']>
  > {
    return this.gateways.update(body);
  }

  @Endpoint(routes.storefrontPayments.testPaymentGateway)
  testPaymentGateway(): Promise<RouteResponse<Routes['testPaymentGateway']>> {
    return this.gateways.test();
  }
}
