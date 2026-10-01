import { z } from 'zod';

import { accountRoutes } from './accounts.js';
import { attachmentRoutes } from './attachments.js';
import { auditRoutes } from './audit.js';
import { authRoutes } from './auth.js';
import { branchRoutes } from './branches.js';
import { defineRoute } from './http.js';
import { invitationRoutes } from './invitations.js';
import { journalRoutes, ledgerRoutes, openingBalanceRoutes, periodLockRoutes } from './journal.js';
import { memberRoutes } from './members.js';
import { notificationRoutes } from './notifications.js';
import { numberSeriesRoutes } from './numbering.js';
import { meRoutes } from './preferences.js';
import { fiscalYearRoutes, reportExportRoutes, reportRoutes } from './reports.js';
import { roleRoutes } from './roles.js';
import { settingsRoutes } from './settings.js';
import { setupRoutes } from './setup.js';

export const healthRoutes = {
  check: defineRoute({
    method: 'GET',
    path: '/health',
    summary: 'Liveness check',
    auth: 'public',
    status: 200,
    response: z.object({ status: z.literal('ok') }),
  }),
};

// API-র প্রতিটা endpoint এখানে। নতুন মডিউল = এখানে এক লাইন; API-র টেস্ট দেখে যে Nest-এর রুট আর
// এই তালিকা হুবহু মেলে, আর OpenAPI স্পেক এই তালিকা থেকেই লেখা হয়
export const routes = {
  health: healthRoutes,
  auth: authRoutes,
  me: meRoutes,
  members: memberRoutes,
  invitations: invitationRoutes,
  roles: roleRoutes,
  settings: settingsRoutes,
  branches: branchRoutes,
  numberSeries: numberSeriesRoutes,
  audit: auditRoutes,
  attachments: attachmentRoutes,
  setup: setupRoutes,
  notifications: notificationRoutes,
  accounts: accountRoutes,
  journal: journalRoutes,
  ledger: ledgerRoutes,
  openingBalances: openingBalanceRoutes,
  periodLock: periodLockRoutes,
  reports: reportRoutes,
  fiscalYears: fiscalYearRoutes,
  reportExports: reportExportRoutes,
};
