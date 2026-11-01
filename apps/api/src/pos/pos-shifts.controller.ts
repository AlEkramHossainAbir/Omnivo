import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { PosCashReasonsService } from './pos-cash-reasons.service.js';
import { PosShiftsService } from './pos-shifts.service.js';

type Routes = typeof routes.posShifts;

// Step 20b. No route opens, moves cash in or closes a shift at the counter: those arrive as sync
// commands (decision 25). The managers read the shifts and close a stuck one here.
@Controller()
export class PosShiftsController {
  constructor(
    private readonly reasons: PosCashReasonsService,
    private readonly shifts: PosShiftsService,
  ) {}

  @Endpoint(routes.posShifts.listCashReasons)
  async listCashReasons({
    query,
  }: RouteInput<Routes['listCashReasons']>): Promise<RouteResponse<Routes['listCashReasons']>> {
    return { items: await this.reasons.list(query) };
  }

  @Endpoint(routes.posShifts.createCashReason)
  createCashReason({
    body,
  }: RouteInput<Routes['createCashReason']>): Promise<RouteResponse<Routes['createCashReason']>> {
    return this.reasons.create(body);
  }

  @Endpoint(routes.posShifts.updateCashReason)
  updateCashReason({
    params,
    body,
  }: RouteInput<Routes['updateCashReason']>): Promise<RouteResponse<Routes['updateCashReason']>> {
    return this.reasons.update(params.id, body);
  }

  @Endpoint(routes.posShifts.archiveCashReason)
  archiveCashReason({
    params,
    body,
  }: RouteInput<Routes['archiveCashReason']>): Promise<RouteResponse<Routes['archiveCashReason']>> {
    return this.reasons.setArchived(params.id, body.version, true);
  }

  @Endpoint(routes.posShifts.restoreCashReason)
  restoreCashReason({
    params,
    body,
  }: RouteInput<Routes['restoreCashReason']>): Promise<RouteResponse<Routes['restoreCashReason']>> {
    return this.reasons.setArchived(params.id, body.version, false);
  }

  @Endpoint(routes.posShifts.listShifts)
  listShifts({
    query,
  }: RouteInput<Routes['listShifts']>): Promise<RouteResponse<Routes['listShifts']>> {
    return this.shifts.list(query);
  }

  @Endpoint(routes.posShifts.getShift)
  getShift({ params }: RouteInput<Routes['getShift']>): Promise<RouteResponse<Routes['getShift']>> {
    return this.shifts.get(params.id);
  }

  @Endpoint(routes.posShifts.closeWithoutCount)
  closeWithoutCount({
    params,
    body,
  }: RouteInput<Routes['closeWithoutCount']>): Promise<RouteResponse<Routes['closeWithoutCount']>> {
    return this.shifts.closeWithoutCount(params.id, body);
  }
}
