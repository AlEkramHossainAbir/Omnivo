import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { LedgerService } from '../journal/ledger.service.js';
import { CustomerGroupsService } from './customer-groups.service.js';
import { CustomersService } from './customers.service.js';

type Routes = typeof routes.customers;
type GroupRoutes = typeof routes.customerGroups;

@Controller()
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly ledgers: LedgerService,
  ) {}

  @Endpoint(routes.customers.list)
  list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return this.customers.list(query);
  }

  @Endpoint(routes.customers.get)
  get({ params }: RouteInput<Routes['get']>): Promise<RouteResponse<Routes['get']>> {
    return this.customers.get(params.id);
  }

  @Endpoint(routes.customers.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.customers.create(body);
  }

  @Endpoint(routes.customers.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.customers.update(params.id, body);
  }

  @Endpoint(routes.customers.archive)
  archive({
    params,
    body,
  }: RouteInput<Routes['archive']>): Promise<RouteResponse<Routes['archive']>> {
    return this.customers.setArchived(params.id, body.version, true);
  }

  @Endpoint(routes.customers.restore)
  restore({
    params,
    body,
  }: RouteInput<Routes['restore']>): Promise<RouteResponse<Routes['restore']>> {
    return this.customers.setArchived(params.id, body.version, false);
  }

  @Endpoint(routes.customers.remove)
  remove({ params, query }: RouteInput<Routes['remove']>): Promise<void> {
    return this.customers.remove(params.id, query.version);
  }

  // The route itself needs sales.customer.balance (the contract's `permission`)
  @Endpoint(routes.customers.statement)
  statement({
    params,
    query,
  }: RouteInput<Routes['statement']>): Promise<RouteResponse<Routes['statement']>> {
    return this.ledgers.statement(params.id, query);
  }
}

@Controller()
export class CustomerGroupsController {
  constructor(private readonly groups: CustomerGroupsService) {}

  @Endpoint(routes.customerGroups.list)
  async list(): Promise<RouteResponse<GroupRoutes['list']>> {
    return { items: await this.groups.list() };
  }

  @Endpoint(routes.customerGroups.create)
  create({
    body,
  }: RouteInput<GroupRoutes['create']>): Promise<RouteResponse<GroupRoutes['create']>> {
    return this.groups.create(body);
  }

  @Endpoint(routes.customerGroups.update)
  update({
    params,
    body,
  }: RouteInput<GroupRoutes['update']>): Promise<RouteResponse<GroupRoutes['update']>> {
    return this.groups.update(params.id, body);
  }

  @Endpoint(routes.customerGroups.remove)
  remove({ params, query }: RouteInput<GroupRoutes['remove']>): Promise<void> {
    return this.groups.remove(params.id, query.version);
  }
}
