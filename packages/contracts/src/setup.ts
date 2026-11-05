import { z } from 'zod';

import { defineRoute } from './http.js';

// The kinds of business Omnivo sets a workspace up for. The choice picks the starting roles now,
// and the chart of accounts from step 9. 'other' gets a small general set.
export const INDUSTRIES = [
  'garments',
  'pharma',
  'distribution',
  'manufacturing',
  'retail',
  'other',
] as const;
export type Industry = (typeof INDUSTRIES)[number];

export function isIndustry(value: string): value is Industry {
  return INDUSTRIES.some((industry) => industry === value);
}

// pending      = the owner has not picked a business type yet (the app shows the wizard)
// provisioning = the background job is creating the starting data
// ready        = done
// failed       = the job gave up after its retries; the owner can retry
export const SETUP_STATUSES = ['pending', 'provisioning', 'ready', 'failed'] as const;
export type SetupStatus = (typeof SETUP_STATUSES)[number];

export const setupSchema = z.object({
  status: z.enum(SETUP_STATUSES),
  industry: z.enum(INDUSTRIES).nullable(),
});
export type Setup = z.infer<typeof setupSchema>;

export const startSetupInputSchema = z.object({ industry: z.enum(INDUSTRIES) });
export type StartSetupInput = z.infer<typeof startSetupInputSchema>;

export const setupRoutes = {
  // Any member may read it: the wizard polls it while the job runs
  get: defineRoute({
    method: 'GET',
    path: '/setup',
    summary: 'Where the workspace setup is: pending, provisioning, ready or failed',
    auth: 'bearer',
    status: 200,
    response: setupSchema,
  }),
  start: defineRoute({
    method: 'POST',
    path: '/setup',
    summary: 'Pick the business type and start the background setup job',
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 200,
    body: startSetupInputSchema,
    response: setupSchema,
  }),
  retry: defineRoute({
    method: 'POST',
    path: '/setup/retry',
    summary: 'Run the setup job again after it failed',
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 200,
    response: setupSchema,
  }),
};
