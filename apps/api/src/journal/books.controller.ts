import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { LedgerService } from './ledger.service.js';
import { OpeningBalancesService } from './opening-balances.service.js';
import { PeriodLockService } from './period-lock.service.js';

// Everything around the journal that is not one entry: an account's ledger, the opening
// balances and the lock date
@Controller()
export class BooksController {
  constructor(
    private readonly ledgers: LedgerService,
    private readonly openingBalances: OpeningBalancesService,
    private readonly periodLock: PeriodLockService,
  ) {}

  @Endpoint(routes.ledger.get)
  ledger({
    params,
    query,
  }: RouteInput<typeof routes.ledger.get>): Promise<RouteResponse<typeof routes.ledger.get>> {
    return this.ledgers.ledger(params.id, query);
  }

  @Endpoint(routes.openingBalances.get)
  getOpeningBalances(): Promise<RouteResponse<typeof routes.openingBalances.get>> {
    return this.openingBalances.get();
  }

  @Endpoint(routes.openingBalances.save)
  saveOpeningBalances({
    body,
  }: RouteInput<typeof routes.openingBalances.save>): Promise<
    RouteResponse<typeof routes.openingBalances.save>
  > {
    return this.openingBalances.save(body);
  }

  @Endpoint(routes.periodLock.get)
  getPeriodLock(): Promise<RouteResponse<typeof routes.periodLock.get>> {
    return this.periodLock.get();
  }

  @Endpoint(routes.periodLock.update)
  updatePeriodLock({
    body,
  }: RouteInput<typeof routes.periodLock.update>): Promise<
    RouteResponse<typeof routes.periodLock.update>
  > {
    return this.periodLock.update(body);
  }
}
