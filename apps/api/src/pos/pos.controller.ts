import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { PosRegistersService } from './pos-registers.service.js';
import { PosSalesService } from './pos-sales.service.js';

type Routes = typeof routes.pos;

// No route writes a sale: a sale arrives as a sync command (decision 21)
@Controller()
export class PosController {
  constructor(
    private readonly registers: PosRegistersService,
    private readonly sales: PosSalesService,
  ) {}

  @Endpoint(routes.pos.listRegisters)
  async listRegisters({
    query,
  }: RouteInput<Routes['listRegisters']>): Promise<RouteResponse<Routes['listRegisters']>> {
    return { items: await this.registers.list(query) };
  }

  @Endpoint(routes.pos.getRegister)
  getRegister({
    params,
  }: RouteInput<Routes['getRegister']>): Promise<RouteResponse<Routes['getRegister']>> {
    return this.registers.get(params.id);
  }

  @Endpoint(routes.pos.createRegister)
  createRegister({
    body,
  }: RouteInput<Routes['createRegister']>): Promise<RouteResponse<Routes['createRegister']>> {
    return this.registers.create(body);
  }

  @Endpoint(routes.pos.updateRegister)
  updateRegister({
    params,
    body,
  }: RouteInput<Routes['updateRegister']>): Promise<RouteResponse<Routes['updateRegister']>> {
    return this.registers.update(params.id, body);
  }

  @Endpoint(routes.pos.archiveRegister)
  archiveRegister({
    params,
    body,
  }: RouteInput<Routes['archiveRegister']>): Promise<RouteResponse<Routes['archiveRegister']>> {
    return this.registers.setArchived(params.id, body.version, true);
  }

  @Endpoint(routes.pos.restoreRegister)
  restoreRegister({
    params,
    body,
  }: RouteInput<Routes['restoreRegister']>): Promise<RouteResponse<Routes['restoreRegister']>> {
    return this.registers.setArchived(params.id, body.version, false);
  }

  @Endpoint(routes.pos.claimRegister)
  claimRegister({
    params,
    body,
  }: RouteInput<Routes['claimRegister']>): Promise<RouteResponse<Routes['claimRegister']>> {
    return this.registers.claim(params.id, body.deviceId);
  }

  @Endpoint(routes.pos.releaseRegister)
  releaseRegister({
    params,
    body,
  }: RouteInput<Routes['releaseRegister']>): Promise<RouteResponse<Routes['releaseRegister']>> {
    return this.registers.release(params.id, body.deviceId);
  }

  @Endpoint(routes.pos.listSales)
  listSales({
    query,
  }: RouteInput<Routes['listSales']>): Promise<RouteResponse<Routes['listSales']>> {
    return this.sales.list(query);
  }

  @Endpoint(routes.pos.getSale)
  getSale({ params }: RouteInput<Routes['getSale']>): Promise<RouteResponse<Routes['getSale']>> {
    return this.sales.get(params.id);
  }

  @Endpoint(routes.pos.soldShort)
  soldShort({
    query,
  }: RouteInput<Routes['soldShort']>): Promise<RouteResponse<Routes['soldShort']>> {
    return this.sales.soldShort(query);
  }
}
