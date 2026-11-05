import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { BillsService } from './bills.service.js';
import { PurchaseAccountsService } from './purchase-accounts.service.js';
import { SupplierPaymentsService } from './supplier-payments.service.js';

type BillRoutes = typeof routes.bills;
type PaymentRoutes = typeof routes.supplierPayments;
type AccountRoutes = typeof routes.purchaseAccounts;

// Step 17c. Each method only moves the route's parts into the service. The permissions are in the
// contract's routes: purchase.bill.manage for a bill, purchase.payment.manage for a payment, none
// for reading; core.settings.manage for Settings → Purchase.
@Controller()
export class BillsController {
  constructor(private readonly bills: BillsService) {}

  @Endpoint(routes.bills.list)
  list({ query }: RouteInput<BillRoutes['list']>): Promise<RouteResponse<BillRoutes['list']>> {
    return this.bills.list(query);
  }

  @Endpoint(routes.bills.get)
  get({ params }: RouteInput<BillRoutes['get']>): Promise<RouteResponse<BillRoutes['get']>> {
    return this.bills.get(params.id);
  }

  @Endpoint(routes.bills.create)
  create({ body }: RouteInput<BillRoutes['create']>): Promise<RouteResponse<BillRoutes['create']>> {
    return this.bills.create(body);
  }

  @Endpoint(routes.bills.update)
  update({
    params,
    body,
  }: RouteInput<BillRoutes['update']>): Promise<RouteResponse<BillRoutes['update']>> {
    return this.bills.update(params.id, body);
  }

  @Endpoint(routes.bills.remove)
  remove({ params, query }: RouteInput<BillRoutes['remove']>): Promise<void> {
    return this.bills.remove(params.id, query.version);
  }

  @Endpoint(routes.bills.submit)
  submit({
    params,
    body,
  }: RouteInput<BillRoutes['submit']>): Promise<RouteResponse<BillRoutes['submit']>> {
    return this.bills.submit(params.id, body.version);
  }

  @Endpoint(routes.bills.reopen)
  reopen({
    params,
    body,
  }: RouteInput<BillRoutes['reopen']>): Promise<RouteResponse<BillRoutes['reopen']>> {
    return this.bills.reopen(params.id, body.version);
  }

  @Endpoint(routes.bills.cancel)
  cancel({
    params,
    body,
  }: RouteInput<BillRoutes['cancel']>): Promise<RouteResponse<BillRoutes['cancel']>> {
    return this.bills.cancel(params.id, body.version);
  }
}

@Controller()
export class SupplierPaymentsController {
  constructor(private readonly payments: SupplierPaymentsService) {}

  @Endpoint(routes.supplierPayments.list)
  list({
    query,
  }: RouteInput<PaymentRoutes['list']>): Promise<RouteResponse<PaymentRoutes['list']>> {
    return this.payments.list(query);
  }

  @Endpoint(routes.supplierPayments.get)
  get({ params }: RouteInput<PaymentRoutes['get']>): Promise<RouteResponse<PaymentRoutes['get']>> {
    return this.payments.get(params.id);
  }

  @Endpoint(routes.supplierPayments.create)
  create({
    body,
  }: RouteInput<PaymentRoutes['create']>): Promise<RouteResponse<PaymentRoutes['create']>> {
    return this.payments.create(body);
  }

  @Endpoint(routes.supplierPayments.update)
  update({
    params,
    body,
  }: RouteInput<PaymentRoutes['update']>): Promise<RouteResponse<PaymentRoutes['update']>> {
    return this.payments.update(params.id, body);
  }

  @Endpoint(routes.supplierPayments.remove)
  remove({ params, query }: RouteInput<PaymentRoutes['remove']>): Promise<void> {
    return this.payments.remove(params.id, query.version);
  }

  @Endpoint(routes.supplierPayments.submit)
  submit({
    params,
    body,
  }: RouteInput<PaymentRoutes['submit']>): Promise<RouteResponse<PaymentRoutes['submit']>> {
    return this.payments.submit(params.id, body.version);
  }

  @Endpoint(routes.supplierPayments.reopen)
  reopen({
    params,
    body,
  }: RouteInput<PaymentRoutes['reopen']>): Promise<RouteResponse<PaymentRoutes['reopen']>> {
    return this.payments.reopen(params.id, body.version);
  }

  @Endpoint(routes.supplierPayments.cancel)
  cancel({
    params,
    body,
  }: RouteInput<PaymentRoutes['cancel']>): Promise<RouteResponse<PaymentRoutes['cancel']>> {
    return this.payments.cancel(params.id, body.version);
  }

  @Endpoint(routes.supplierPayments.allocate)
  allocate({
    params,
    body,
  }: RouteInput<PaymentRoutes['allocate']>): Promise<RouteResponse<PaymentRoutes['allocate']>> {
    return this.payments.allocate(params.id, body);
  }

  @Endpoint(routes.supplierPayments.void)
  void({
    params,
    body,
  }: RouteInput<PaymentRoutes['void']>): Promise<RouteResponse<PaymentRoutes['void']>> {
    return this.payments.void(params.id, body);
  }
}

// Settings → Purchase, like Settings → Sales's SalesAccountsController
@Controller()
export class PurchaseAccountsController {
  constructor(private readonly accounts: PurchaseAccountsService) {}

  @Endpoint(routes.purchaseAccounts.get)
  get(): Promise<RouteResponse<AccountRoutes['get']>> {
    return this.accounts.get();
  }

  @Endpoint(routes.purchaseAccounts.update)
  update({
    body,
  }: RouteInput<AccountRoutes['update']>): Promise<RouteResponse<AccountRoutes['update']>> {
    return this.accounts.update(body);
  }
}
