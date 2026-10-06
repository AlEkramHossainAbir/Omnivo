import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { StockAdjustmentsService } from './stock-adjustments.service.js';
import { StockTransfersService } from './stock-transfers.service.js';
import { StockService } from './stock.service.js';

type Routes = typeof routes.stock;
type AdjustmentRoutes = typeof routes.stockAdjustments;
type TransferRoutes = typeof routes.stockTransfers;

@Controller()
export class StockController {
  constructor(private readonly stock: StockService) {}

  @Endpoint(routes.stock.list)
  list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return this.stock.list(query);
  }

  @Endpoint(routes.stock.card)
  card({ params }: RouteInput<Routes['card']>): Promise<RouteResponse<Routes['card']>> {
    return this.stock.card(params.id);
  }

  @Endpoint(routes.stock.movements)
  movements({
    params,
    query,
  }: RouteInput<Routes['movements']>): Promise<RouteResponse<Routes['movements']>> {
    return this.stock.movements(params.id, query);
  }

  @Endpoint(routes.stock.batches)
  batches({ query }: RouteInput<Routes['batches']>): Promise<RouteResponse<Routes['batches']>> {
    return this.stock.batches(query);
  }

  @Endpoint(routes.stock.reorder)
  reorder({ query }: RouteInput<Routes['reorder']>): Promise<RouteResponse<Routes['reorder']>> {
    return this.stock.reorder(query);
  }

  @Endpoint(routes.stock.valuation)
  valuation({
    query,
  }: RouteInput<Routes['valuation']>): Promise<RouteResponse<Routes['valuation']>> {
    return this.stock.valuation(query);
  }

  @Endpoint(routes.stock.valuationSummary)
  valuationSummary(): Promise<RouteResponse<Routes['valuationSummary']>> {
    return this.stock.valuationSummary();
  }

  @Endpoint(routes.stock.setReorderLevel)
  setReorderLevel({
    body,
  }: RouteInput<Routes['setReorderLevel']>): Promise<RouteResponse<Routes['setReorderLevel']>> {
    return this.stock.setReorderLevel(body);
  }
}

@Controller()
export class StockAdjustmentsController {
  constructor(private readonly adjustments: StockAdjustmentsService) {}

  @Endpoint(routes.stockAdjustments.list)
  list({
    query,
  }: RouteInput<AdjustmentRoutes['list']>): Promise<RouteResponse<AdjustmentRoutes['list']>> {
    return this.adjustments.list(query);
  }

  @Endpoint(routes.stockAdjustments.get)
  get({
    params,
  }: RouteInput<AdjustmentRoutes['get']>): Promise<RouteResponse<AdjustmentRoutes['get']>> {
    return this.adjustments.get(params.id);
  }

  @Endpoint(routes.stockAdjustments.create)
  create({
    body,
  }: RouteInput<AdjustmentRoutes['create']>): Promise<RouteResponse<AdjustmentRoutes['create']>> {
    return this.adjustments.create(body);
  }

  @Endpoint(routes.stockAdjustments.update)
  update({
    params,
    body,
  }: RouteInput<AdjustmentRoutes['update']>): Promise<RouteResponse<AdjustmentRoutes['update']>> {
    return this.adjustments.update(params.id, body);
  }

  @Endpoint(routes.stockAdjustments.remove)
  remove({ params, query }: RouteInput<AdjustmentRoutes['remove']>): Promise<void> {
    return this.adjustments.remove(params.id, query.version);
  }

  @Endpoint(routes.stockAdjustments.post)
  post({
    params,
    body,
  }: RouteInput<AdjustmentRoutes['post']>): Promise<RouteResponse<AdjustmentRoutes['post']>> {
    return this.adjustments.post(params.id, body.version);
  }
}

@Controller()
export class StockTransfersController {
  constructor(private readonly transfers: StockTransfersService) {}

  @Endpoint(routes.stockTransfers.list)
  list({
    query,
  }: RouteInput<TransferRoutes['list']>): Promise<RouteResponse<TransferRoutes['list']>> {
    return this.transfers.list(query);
  }

  @Endpoint(routes.stockTransfers.get)
  get({
    params,
  }: RouteInput<TransferRoutes['get']>): Promise<RouteResponse<TransferRoutes['get']>> {
    return this.transfers.get(params.id);
  }

  @Endpoint(routes.stockTransfers.create)
  create({
    body,
  }: RouteInput<TransferRoutes['create']>): Promise<RouteResponse<TransferRoutes['create']>> {
    return this.transfers.create(body);
  }

  @Endpoint(routes.stockTransfers.update)
  update({
    params,
    body,
  }: RouteInput<TransferRoutes['update']>): Promise<RouteResponse<TransferRoutes['update']>> {
    return this.transfers.update(params.id, body);
  }

  @Endpoint(routes.stockTransfers.remove)
  remove({ params, query }: RouteInput<TransferRoutes['remove']>): Promise<void> {
    return this.transfers.remove(params.id, query.version);
  }

  @Endpoint(routes.stockTransfers.send)
  send({
    params,
    body,
  }: RouteInput<TransferRoutes['send']>): Promise<RouteResponse<TransferRoutes['send']>> {
    return this.transfers.send(params.id, body.version);
  }

  @Endpoint(routes.stockTransfers.receive)
  receive({
    params,
    body,
  }: RouteInput<TransferRoutes['receive']>): Promise<RouteResponse<TransferRoutes['receive']>> {
    return this.transfers.receive(params.id, body);
  }
}
