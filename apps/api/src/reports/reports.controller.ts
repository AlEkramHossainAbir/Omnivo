import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { FiscalYearsService } from './fiscal-years.service.js';
import { ReportExportsService } from './report-exports.service.js';
import { ReportsService } from './reports.service.js';
import { TradeReportsService } from './trade-reports.service.js';

type Reports = typeof routes.reports;
type Trade = typeof routes.tradeReports;
type Aging = typeof routes.aging;
type Years = typeof routes.fiscalYears;
type Exports = typeof routes.reportExports;

@Controller()
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly years: FiscalYearsService,
    private readonly exports: ReportExportsService,
    private readonly trade: TradeReportsService,
  ) {}

  @Endpoint(routes.reports.trialBalance)
  trialBalance({
    query,
  }: RouteInput<Reports['trialBalance']>): Promise<RouteResponse<Reports['trialBalance']>> {
    return this.reports.trialBalance(query);
  }

  @Endpoint(routes.reports.profitAndLoss)
  profitAndLoss({
    query,
  }: RouteInput<Reports['profitAndLoss']>): Promise<RouteResponse<Reports['profitAndLoss']>> {
    return this.reports.profitAndLoss(query);
  }

  @Endpoint(routes.reports.balanceSheet)
  balanceSheet({
    query,
  }: RouteInput<Reports['balanceSheet']>): Promise<RouteResponse<Reports['balanceSheet']>> {
    return this.reports.balanceSheet(query);
  }

  @Endpoint(routes.tradeReports.sales)
  sales({ query }: RouteInput<Trade['sales']>): Promise<RouteResponse<Trade['sales']>> {
    return this.trade.sales(query);
  }

  @Endpoint(routes.tradeReports.purchases)
  purchases({ query }: RouteInput<Trade['purchases']>): Promise<RouteResponse<Trade['purchases']>> {
    return this.trade.purchases(query);
  }

  @Endpoint(routes.aging.receivables)
  receivables({
    query,
  }: RouteInput<Aging['receivables']>): Promise<RouteResponse<Aging['receivables']>> {
    return this.trade.receivables(query);
  }

  @Endpoint(routes.aging.receivablesOf)
  receivablesOf({
    params,
    query,
  }: RouteInput<Aging['receivablesOf']>): Promise<RouteResponse<Aging['receivablesOf']>> {
    return this.trade.receivablesOf(params.customerId, query.asOf);
  }

  @Endpoint(routes.aging.payables)
  payables({ query }: RouteInput<Aging['payables']>): Promise<RouteResponse<Aging['payables']>> {
    return this.trade.payables(query);
  }

  @Endpoint(routes.aging.payablesOf)
  payablesOf({
    params,
    query,
  }: RouteInput<Aging['payablesOf']>): Promise<RouteResponse<Aging['payablesOf']>> {
    return this.trade.payablesOf(params.supplierId, query.asOf);
  }

  @Endpoint(routes.fiscalYears.list)
  listYears(): Promise<RouteResponse<Years['list']>> {
    return this.years.list();
  }

  @Endpoint(routes.fiscalYears.close)
  closeYear({ body }: RouteInput<Years['close']>): Promise<RouteResponse<Years['close']>> {
    return this.years.close(body.end);
  }

  @Endpoint(routes.fiscalYears.reopen)
  reopenYear({ body }: RouteInput<Years['reopen']>): Promise<RouteResponse<Years['reopen']>> {
    return this.years.reopen(body.end);
  }

  @Endpoint(routes.reportExports.create)
  createExport({ body }: RouteInput<Exports['create']>): Promise<RouteResponse<Exports['create']>> {
    return this.exports.create(body);
  }

  @Endpoint(routes.reportExports.list)
  listExports({ query }: RouteInput<Exports['list']>): Promise<RouteResponse<Exports['list']>> {
    return this.exports.list(query);
  }

  @Endpoint(routes.reportExports.download)
  async downloadExport({
    params,
  }: RouteInput<Exports['download']>): Promise<RouteResponse<Exports['download']>> {
    const signed = await this.exports.download(params.id);
    return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
  }
}
