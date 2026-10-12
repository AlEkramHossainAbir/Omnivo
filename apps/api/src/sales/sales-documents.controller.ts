import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { CreditNotesService } from './credit-notes.service.js';
import { DeliveriesService } from './deliveries.service.js';
import { InvoicesService } from './invoices.service.js';
import { PriceLookupService } from './price-lookup.service.js';
import { QuotationsService } from './quotations.service.js';
import { ReceiptsService } from './receipts.service.js';
import { RefundsService } from './refunds.service.js';
import { SalesOrdersService } from './sales-orders.service.js';
import { SalesReturnsService } from './sales-returns.service.js';

type PriceRoutes = typeof routes.salesPrices;
type QuotationRoutes = typeof routes.quotations;
type OrderRoutes = typeof routes.salesOrders;
type DeliveryRoutes = typeof routes.deliveries;
type InvoiceRoutes = typeof routes.invoices;
type ReceiptRoutes = typeof routes.receipts;
type ReturnRoutes = typeof routes.salesReturns;
type CreditNoteRoutes = typeof routes.creditNotes;
type RefundRoutes = typeof routes.refunds;

@Controller()
export class SalesPricesController {
  constructor(private readonly prices: PriceLookupService) {}

  @Endpoint(routes.salesPrices.lookup)
  lookup({
    body,
  }: RouteInput<PriceRoutes['lookup']>): Promise<RouteResponse<PriceRoutes['lookup']>> {
    return this.prices.lookup(body);
  }
}

@Controller()
export class QuotationsController {
  constructor(private readonly quotations: QuotationsService) {}

  @Endpoint(routes.quotations.list)
  list({
    query,
  }: RouteInput<QuotationRoutes['list']>): Promise<RouteResponse<QuotationRoutes['list']>> {
    return this.quotations.list(query);
  }

  @Endpoint(routes.quotations.get)
  get({
    params,
  }: RouteInput<QuotationRoutes['get']>): Promise<RouteResponse<QuotationRoutes['get']>> {
    return this.quotations.get(params.id);
  }

  @Endpoint(routes.quotations.create)
  create({
    body,
  }: RouteInput<QuotationRoutes['create']>): Promise<RouteResponse<QuotationRoutes['create']>> {
    return this.quotations.create(body);
  }

  @Endpoint(routes.quotations.update)
  update({
    params,
    body,
  }: RouteInput<QuotationRoutes['update']>): Promise<RouteResponse<QuotationRoutes['update']>> {
    return this.quotations.update(params.id, body);
  }

  @Endpoint(routes.quotations.remove)
  remove({ params, query }: RouteInput<QuotationRoutes['remove']>): Promise<void> {
    return this.quotations.remove(params.id, query.version);
  }

  @Endpoint(routes.quotations.decline)
  decline({
    params,
    body,
  }: RouteInput<QuotationRoutes['decline']>): Promise<RouteResponse<QuotationRoutes['decline']>> {
    return this.quotations.decline(params.id, body.version);
  }

  @Endpoint(routes.quotations.reopen)
  reopen({
    params,
    body,
  }: RouteInput<QuotationRoutes['reopen']>): Promise<RouteResponse<QuotationRoutes['reopen']>> {
    return this.quotations.reopen(params.id, body.version);
  }
}

@Controller()
export class SalesOrdersController {
  constructor(private readonly orders: SalesOrdersService) {}

  @Endpoint(routes.salesOrders.list)
  list({ query }: RouteInput<OrderRoutes['list']>): Promise<RouteResponse<OrderRoutes['list']>> {
    return this.orders.list(query);
  }

  @Endpoint(routes.salesOrders.get)
  get({ params }: RouteInput<OrderRoutes['get']>): Promise<RouteResponse<OrderRoutes['get']>> {
    return this.orders.get(params.id);
  }

  @Endpoint(routes.salesOrders.create)
  create({
    body,
  }: RouteInput<OrderRoutes['create']>): Promise<RouteResponse<OrderRoutes['create']>> {
    return this.orders.create(body);
  }

  @Endpoint(routes.salesOrders.update)
  update({
    params,
    body,
  }: RouteInput<OrderRoutes['update']>): Promise<RouteResponse<OrderRoutes['update']>> {
    return this.orders.update(params.id, body);
  }

  @Endpoint(routes.salesOrders.remove)
  remove({ params, query }: RouteInput<OrderRoutes['remove']>): Promise<void> {
    return this.orders.remove(params.id, query.version);
  }

  @Endpoint(routes.salesOrders.confirm)
  confirm({
    params,
    body,
  }: RouteInput<OrderRoutes['confirm']>): Promise<RouteResponse<OrderRoutes['confirm']>> {
    return this.orders.confirm(params.id, body);
  }

  @Endpoint(routes.salesOrders.reopen)
  reopen({
    params,
    body,
  }: RouteInput<OrderRoutes['reopen']>): Promise<RouteResponse<OrderRoutes['reopen']>> {
    return this.orders.reopen(params.id, body.version);
  }

  @Endpoint(routes.salesOrders.close)
  close({
    params,
    body,
  }: RouteInput<OrderRoutes['close']>): Promise<RouteResponse<OrderRoutes['close']>> {
    return this.orders.close(params.id, body.version);
  }

  @Endpoint(routes.salesOrders.cancel)
  cancel({
    params,
    body,
  }: RouteInput<OrderRoutes['cancel']>): Promise<RouteResponse<OrderRoutes['cancel']>> {
    return this.orders.cancel(params.id, body.version);
  }
}

@Controller()
export class DeliveriesController {
  constructor(private readonly deliveries: DeliveriesService) {}

  @Endpoint(routes.deliveries.list)
  list({
    query,
  }: RouteInput<DeliveryRoutes['list']>): Promise<RouteResponse<DeliveryRoutes['list']>> {
    return this.deliveries.list(query);
  }

  @Endpoint(routes.deliveries.get)
  get({
    params,
  }: RouteInput<DeliveryRoutes['get']>): Promise<RouteResponse<DeliveryRoutes['get']>> {
    return this.deliveries.get(params.id);
  }

  @Endpoint(routes.deliveries.create)
  create({
    body,
  }: RouteInput<DeliveryRoutes['create']>): Promise<RouteResponse<DeliveryRoutes['create']>> {
    return this.deliveries.create(body);
  }

  @Endpoint(routes.deliveries.update)
  update({
    params,
    body,
  }: RouteInput<DeliveryRoutes['update']>): Promise<RouteResponse<DeliveryRoutes['update']>> {
    return this.deliveries.update(params.id, body);
  }

  @Endpoint(routes.deliveries.remove)
  remove({ params, query }: RouteInput<DeliveryRoutes['remove']>): Promise<void> {
    return this.deliveries.remove(params.id, query.version);
  }

  @Endpoint(routes.deliveries.post)
  post({
    params,
    body,
  }: RouteInput<DeliveryRoutes['post']>): Promise<RouteResponse<DeliveryRoutes['post']>> {
    return this.deliveries.post(params.id, body.version);
  }
}

@Controller()
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Endpoint(routes.invoices.list)
  list({
    query,
  }: RouteInput<InvoiceRoutes['list']>): Promise<RouteResponse<InvoiceRoutes['list']>> {
    return this.invoices.list(query);
  }

  @Endpoint(routes.invoices.get)
  get({ params }: RouteInput<InvoiceRoutes['get']>): Promise<RouteResponse<InvoiceRoutes['get']>> {
    return this.invoices.get(params.id);
  }

  @Endpoint(routes.invoices.create)
  create({
    body,
  }: RouteInput<InvoiceRoutes['create']>): Promise<RouteResponse<InvoiceRoutes['create']>> {
    return this.invoices.create(body);
  }

  @Endpoint(routes.invoices.update)
  update({
    params,
    body,
  }: RouteInput<InvoiceRoutes['update']>): Promise<RouteResponse<InvoiceRoutes['update']>> {
    return this.invoices.update(params.id, body);
  }

  @Endpoint(routes.invoices.remove)
  remove({ params, query }: RouteInput<InvoiceRoutes['remove']>): Promise<void> {
    return this.invoices.remove(params.id, query.version);
  }

  @Endpoint(routes.invoices.post)
  post({
    params,
    body,
  }: RouteInput<InvoiceRoutes['post']>): Promise<RouteResponse<InvoiceRoutes['post']>> {
    return this.invoices.post(params.id, body);
  }
}

@Controller()
export class ReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  @Endpoint(routes.receipts.list)
  list({
    query,
  }: RouteInput<ReceiptRoutes['list']>): Promise<RouteResponse<ReceiptRoutes['list']>> {
    return this.receipts.list(query);
  }

  @Endpoint(routes.receipts.get)
  get({ params }: RouteInput<ReceiptRoutes['get']>): Promise<RouteResponse<ReceiptRoutes['get']>> {
    return this.receipts.get(params.id);
  }

  @Endpoint(routes.receipts.create)
  create({
    body,
  }: RouteInput<ReceiptRoutes['create']>): Promise<RouteResponse<ReceiptRoutes['create']>> {
    return this.receipts.create(body);
  }

  @Endpoint(routes.receipts.allocate)
  allocate({
    params,
    body,
  }: RouteInput<ReceiptRoutes['allocate']>): Promise<RouteResponse<ReceiptRoutes['allocate']>> {
    return this.receipts.allocate(params.id, body);
  }

  @Endpoint(routes.receipts.void)
  void({
    params,
    body,
  }: RouteInput<ReceiptRoutes['void']>): Promise<RouteResponse<ReceiptRoutes['void']>> {
    return this.receipts.void(params.id, body);
  }
}

@Controller()
export class SalesReturnsController {
  constructor(private readonly returns: SalesReturnsService) {}

  @Endpoint(routes.salesReturns.list)
  list({ query }: RouteInput<ReturnRoutes['list']>): Promise<RouteResponse<ReturnRoutes['list']>> {
    return this.returns.list(query);
  }

  @Endpoint(routes.salesReturns.get)
  get({ params }: RouteInput<ReturnRoutes['get']>): Promise<RouteResponse<ReturnRoutes['get']>> {
    return this.returns.get(params.id);
  }

  @Endpoint(routes.salesReturns.create)
  create({
    body,
  }: RouteInput<ReturnRoutes['create']>): Promise<RouteResponse<ReturnRoutes['create']>> {
    return this.returns.create(body);
  }

  @Endpoint(routes.salesReturns.update)
  update({
    params,
    body,
  }: RouteInput<ReturnRoutes['update']>): Promise<RouteResponse<ReturnRoutes['update']>> {
    return this.returns.update(params.id, body);
  }

  @Endpoint(routes.salesReturns.remove)
  remove({ params, query }: RouteInput<ReturnRoutes['remove']>): Promise<void> {
    return this.returns.remove(params.id, query.version);
  }

  @Endpoint(routes.salesReturns.post)
  post({
    params,
    body,
  }: RouteInput<ReturnRoutes['post']>): Promise<RouteResponse<ReturnRoutes['post']>> {
    return this.returns.post(params.id, body.version);
  }
}

@Controller()
export class CreditNotesController {
  constructor(private readonly creditNotes: CreditNotesService) {}

  @Endpoint(routes.creditNotes.list)
  list({
    query,
  }: RouteInput<CreditNoteRoutes['list']>): Promise<RouteResponse<CreditNoteRoutes['list']>> {
    return this.creditNotes.list(query);
  }

  @Endpoint(routes.creditNotes.get)
  get({
    params,
  }: RouteInput<CreditNoteRoutes['get']>): Promise<RouteResponse<CreditNoteRoutes['get']>> {
    return this.creditNotes.get(params.id);
  }

  @Endpoint(routes.creditNotes.create)
  create({
    body,
  }: RouteInput<CreditNoteRoutes['create']>): Promise<RouteResponse<CreditNoteRoutes['create']>> {
    return this.creditNotes.create(body);
  }

  @Endpoint(routes.creditNotes.update)
  update({
    params,
    body,
  }: RouteInput<CreditNoteRoutes['update']>): Promise<RouteResponse<CreditNoteRoutes['update']>> {
    return this.creditNotes.update(params.id, body);
  }

  @Endpoint(routes.creditNotes.remove)
  remove({ params, query }: RouteInput<CreditNoteRoutes['remove']>): Promise<void> {
    return this.creditNotes.remove(params.id, query.version);
  }

  @Endpoint(routes.creditNotes.post)
  post({
    params,
    body,
  }: RouteInput<CreditNoteRoutes['post']>): Promise<RouteResponse<CreditNoteRoutes['post']>> {
    return this.creditNotes.post(params.id, body.version);
  }

  @Endpoint(routes.creditNotes.allocate)
  allocate({
    params,
    body,
  }: RouteInput<CreditNoteRoutes['allocate']>): Promise<
    RouteResponse<CreditNoteRoutes['allocate']>
  > {
    return this.creditNotes.allocate(params.id, body);
  }
}

@Controller()
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Endpoint(routes.refunds.list)
  list({ query }: RouteInput<RefundRoutes['list']>): Promise<RouteResponse<RefundRoutes['list']>> {
    return this.refunds.list(query);
  }

  @Endpoint(routes.refunds.get)
  get({ params }: RouteInput<RefundRoutes['get']>): Promise<RouteResponse<RefundRoutes['get']>> {
    return this.refunds.get(params.id);
  }

  @Endpoint(routes.refunds.create)
  create({
    body,
  }: RouteInput<RefundRoutes['create']>): Promise<RouteResponse<RefundRoutes['create']>> {
    return this.refunds.create(body);
  }

  @Endpoint(routes.refunds.void)
  void({
    params,
    body,
  }: RouteInput<RefundRoutes['void']>): Promise<RouteResponse<RefundRoutes['void']>> {
    return this.refunds.void(params.id, body);
  }
}
