import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../../common/http/endpoint.js';
import { StorefrontCouponsService } from './coupons.service.js';

type Routes = typeof routes.storefrontCoupons;

// Step 27c: Storefront → Coupons, 6 routes behind storefront.manage (the contract says so; the
// guard reads it). Its own controller, as the contract has its own group, like 26h's. Thin on
// purpose: each one hands its parsed input to the service
@Controller()
export class StorefrontCouponsController {
  constructor(private readonly coupons: StorefrontCouponsService) {}

  @Endpoint(routes.storefrontCoupons.listCoupons)
  listCoupons({
    query,
  }: RouteInput<Routes['listCoupons']>): Promise<RouteResponse<Routes['listCoupons']>> {
    return this.coupons.list(query);
  }

  @Endpoint(routes.storefrontCoupons.getCoupon)
  getCoupon({
    params,
  }: RouteInput<Routes['getCoupon']>): Promise<RouteResponse<Routes['getCoupon']>> {
    return this.coupons.get(params.id);
  }

  @Endpoint(routes.storefrontCoupons.createCoupon)
  createCoupon({
    body,
  }: RouteInput<Routes['createCoupon']>): Promise<RouteResponse<Routes['createCoupon']>> {
    return this.coupons.create(body);
  }

  @Endpoint(routes.storefrontCoupons.updateCoupon)
  updateCoupon({
    params,
    body,
  }: RouteInput<Routes['updateCoupon']>): Promise<RouteResponse<Routes['updateCoupon']>> {
    return this.coupons.update(params.id, body);
  }

  @Endpoint(routes.storefrontCoupons.archiveCoupon)
  archiveCoupon({
    params,
    body,
  }: RouteInput<Routes['archiveCoupon']>): Promise<RouteResponse<Routes['archiveCoupon']>> {
    return this.coupons.setArchived(params.id, body.version, true);
  }

  @Endpoint(routes.storefrontCoupons.restoreCoupon)
  restoreCoupon({
    params,
    body,
  }: RouteInput<Routes['restoreCoupon']>): Promise<RouteResponse<Routes['restoreCoupon']>> {
    return this.coupons.setArchived(params.id, body.version, false);
  }
}
