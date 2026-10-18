import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { ApprovalsService } from './approvals.service.js';

type RuleRoutes = typeof routes.approvalRules;
type Routes = typeof routes.approvals;

@Controller()
export class ApprovalRulesController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Endpoint(routes.approvalRules.list)
  list(): Promise<RouteResponse<RuleRoutes['list']>> {
    return this.approvals.listRules();
  }

  // core.settings.manage (the contract's `permission`): the levels are a workspace setting
  @Endpoint(routes.approvalRules.update)
  update({
    params,
    body,
  }: RouteInput<RuleRoutes['update']>): Promise<RouteResponse<RuleRoutes['update']>> {
    return this.approvals.saveRule(params.document, body);
  }
}

// No route permission on any of these (decision 16): holding the waiting step's role, or being an
// Owner, is the right, and ApprovalsService checks it against the document
@Controller()
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Endpoint(routes.approvals.waiting)
  waiting({ query }: RouteInput<Routes['waiting']>): Promise<RouteResponse<Routes['waiting']>> {
    return this.approvals.waiting(query);
  }

  @Endpoint(routes.approvals.waitingCount)
  waitingCount(): Promise<RouteResponse<Routes['waitingCount']>> {
    return this.approvals.waitingCount();
  }

  @Endpoint(routes.approvals.approve)
  approve({ params, body }: RouteInput<Routes['approve']>): Promise<void> {
    return this.approvals.decide(params.document, params.id, 'approved', body);
  }

  @Endpoint(routes.approvals.reject)
  reject({ params, body }: RouteInput<Routes['reject']>): Promise<void> {
    return this.approvals.decide(params.document, params.id, 'rejected', body);
  }
}
