import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { FiscalYearsService } from './fiscal-years.service.js';
import { ReportExportsService } from './report-exports.service.js';
import { ReportsService } from './reports.service.js';

type Reports = typeof routes.reports;
type Years = typeof routes.fiscalYears;
type Exports = typeof routes.reportExports;

@Controller()
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly years: FiscalYearsService,
    private readonly exports: ReportExportsService,
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
