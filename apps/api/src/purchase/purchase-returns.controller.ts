import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { DebitNotesService } from './debit-notes.service.js';
import { PurchaseReturnsService } from './purchase-returns.service.js';
import { SupplierRefundsService } from './supplier-refunds.service.js';

type ReturnRoutes = typeof routes.purchaseReturns;
type DebitNoteRoutes = typeof routes.debitNotes;
type RefundRoutes = typeof routes.supplierRefunds;

// Step 17d. Each method only moves the route's parts into the service. The permissions are in the
// contract's routes: purchase.return.manage, purchase.debit_note.manage and purchase.refund.manage,
// none for reading.
@Controller()
export class PurchaseReturnsController {
  constructor(private readonly returns: PurchaseReturnsService) {}

  @Endpoint(routes.purchaseReturns.list)
  list({ query }: RouteInput<ReturnRoutes['list']>): Promise<RouteResponse<ReturnRoutes['list']>> {
    return this.returns.list(query);
  }

  @Endpoint(routes.purchaseReturns.get)
  get({ params }: RouteInput<ReturnRoutes['get']>): Promise<RouteResponse<ReturnRoutes['get']>> {
    return this.returns.get(params.id);
  }

  @Endpoint(routes.purchaseReturns.create)
  create({
    body,
  }: RouteInput<ReturnRoutes['create']>): Promise<RouteResponse<ReturnRoutes['create']>> {
    return this.returns.create(body);
  }

  @Endpoint(routes.purchaseReturns.update)
  update({
    params,
    body,
  }: RouteInput<ReturnRoutes['update']>): Promise<RouteResponse<ReturnRoutes['update']>> {
    return this.returns.update(params.id, body);
  }

  @Endpoint(routes.purchaseReturns.remove)
  remove({ params, query }: RouteInput<ReturnRoutes['remove']>): Promise<void> {
    return this.returns.remove(params.id, query.version);
  }

  @Endpoint(routes.purchaseReturns.post)
  post({
    params,
    body,
  }: RouteInput<ReturnRoutes['post']>): Promise<RouteResponse<ReturnRoutes['post']>> {
    return this.returns.post(params.id, body.version);
  }
}

@Controller()
export class DebitNotesController {
  constructor(private readonly debitNotes: DebitNotesService) {}

  @Endpoint(routes.debitNotes.list)
  list({
    query,
  }: RouteInput<DebitNoteRoutes['list']>): Promise<RouteResponse<DebitNoteRoutes['list']>> {
    return this.debitNotes.list(query);
  }

  @Endpoint(routes.debitNotes.get)
  get({
    params,
  }: RouteInput<DebitNoteRoutes['get']>): Promise<RouteResponse<DebitNoteRoutes['get']>> {
    return this.debitNotes.get(params.id);
  }

  @Endpoint(routes.debitNotes.create)
  create({
    body,
  }: RouteInput<DebitNoteRoutes['create']>): Promise<RouteResponse<DebitNoteRoutes['create']>> {
    return this.debitNotes.create(body);
  }

  @Endpoint(routes.debitNotes.update)
  update({
    params,
    body,
  }: RouteInput<DebitNoteRoutes['update']>): Promise<RouteResponse<DebitNoteRoutes['update']>> {
    return this.debitNotes.update(params.id, body);
  }

  @Endpoint(routes.debitNotes.remove)
  remove({ params, query }: RouteInput<DebitNoteRoutes['remove']>): Promise<void> {
    return this.debitNotes.remove(params.id, query.version);
  }

  @Endpoint(routes.debitNotes.post)
  post({
    params,
    body,
  }: RouteInput<DebitNoteRoutes['post']>): Promise<RouteResponse<DebitNoteRoutes['post']>> {
    return this.debitNotes.post(params.id, body.version);
  }

  @Endpoint(routes.debitNotes.allocate)
  allocate({
    params,
    body,
  }: RouteInput<DebitNoteRoutes['allocate']>): Promise<RouteResponse<DebitNoteRoutes['allocate']>> {
    return this.debitNotes.allocate(params.id, body);
  }
}

@Controller()
export class SupplierRefundsController {
  constructor(private readonly refunds: SupplierRefundsService) {}

  @Endpoint(routes.supplierRefunds.list)
  list({ query }: RouteInput<RefundRoutes['list']>): Promise<RouteResponse<RefundRoutes['list']>> {
    return this.refunds.list(query);
  }

  @Endpoint(routes.supplierRefunds.get)
  get({ params }: RouteInput<RefundRoutes['get']>): Promise<RouteResponse<RefundRoutes['get']>> {
    return this.refunds.get(params.id);
  }

  @Endpoint(routes.supplierRefunds.create)
  create({
    body,
  }: RouteInput<RefundRoutes['create']>): Promise<RouteResponse<RefundRoutes['create']>> {
    return this.refunds.create(body);
  }

  @Endpoint(routes.supplierRefunds.void)
  void({
    params,
    body,
  }: RouteInput<RefundRoutes['void']>): Promise<RouteResponse<RefundRoutes['void']>> {
    return this.refunds.void(params.id, body);
  }
}
