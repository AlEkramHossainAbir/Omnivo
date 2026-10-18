import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { LedgerService } from '../journal/ledger.service.js';
import { SupplierGroupsService } from './supplier-groups.service.js';
import { SuppliersService } from './suppliers.service.js';

type Routes = typeof routes.suppliers;
type GroupRoutes = typeof routes.supplierGroups;

@Controller()
export class SuppliersController {
  constructor(
    private readonly suppliers: SuppliersService,
    private readonly ledgers: LedgerService,
  ) {}

  @Endpoint(routes.suppliers.list)
  list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return this.suppliers.list(query);
  }

  @Endpoint(routes.suppliers.get)
  get({ params }: RouteInput<Routes['get']>): Promise<RouteResponse<Routes['get']>> {
    return this.suppliers.get(params.id);
  }

  @Endpoint(routes.suppliers.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.suppliers.create(body);
  }

  @Endpoint(routes.suppliers.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.suppliers.update(params.id, body);
  }

  // "Make supplier too" on a customer's page. Its path is under /customers, its answer a supplier.
  @Endpoint(routes.suppliers.fromCustomer)
  fromCustomer({
    params,
    body,
  }: RouteInput<Routes['fromCustomer']>): Promise<RouteResponse<Routes['fromCustomer']>> {
    return this.suppliers.fromCustomer(params.id, body.version);
  }

  @Endpoint(routes.suppliers.archive)
  archive({
    params,
    body,
  }: RouteInput<Routes['archive']>): Promise<RouteResponse<Routes['archive']>> {
    return this.suppliers.setArchived(params.id, body.version, true);
  }

  @Endpoint(routes.suppliers.restore)
  restore({
    params,
    body,
  }: RouteInput<Routes['restore']>): Promise<RouteResponse<Routes['restore']>> {
    return this.suppliers.setArchived(params.id, body.version, false);
  }

  @Endpoint(routes.suppliers.remove)
  remove({ params, query }: RouteInput<Routes['remove']>): Promise<void> {
    return this.suppliers.remove(params.id, query.version);
  }

  // The route itself needs purchase.supplier.balance (the contract's `permission`)
  @Endpoint(routes.suppliers.statement)
  statement({
    params,
    query,
  }: RouteInput<Routes['statement']>): Promise<RouteResponse<Routes['statement']>> {
    return this.ledgers.statement(params.id, query, 'supplier');
  }
}

@Controller()
export class SupplierGroupsController {
  constructor(private readonly groups: SupplierGroupsService) {}

  @Endpoint(routes.supplierGroups.list)
  async list(): Promise<RouteResponse<GroupRoutes['list']>> {
    return { items: await this.groups.list() };
  }

  @Endpoint(routes.supplierGroups.create)
  create({
    body,
  }: RouteInput<GroupRoutes['create']>): Promise<RouteResponse<GroupRoutes['create']>> {
    return this.groups.create(body);
  }

  @Endpoint(routes.supplierGroups.update)
  update({
    params,
    body,
  }: RouteInput<GroupRoutes['update']>): Promise<RouteResponse<GroupRoutes['update']>> {
    return this.groups.update(params.id, body);
  }

  @Endpoint(routes.supplierGroups.remove)
  remove({ params, query }: RouteInput<GroupRoutes['remove']>): Promise<void> {
    return this.groups.remove(params.id, query.version);
  }
}
