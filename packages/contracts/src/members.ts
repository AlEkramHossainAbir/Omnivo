import { z } from 'zod';

import { defineRoute } from './http.js';
import { pageOf, pageQuerySchema } from './pagination.js';

export const memberSchema = z.object({
  membershipId: z.uuid(),
  userId: z.uuid(),
  fullName: z.string(),
  email: z.string(),
  roles: z.array(z.string()),
});
export type Member = z.infer<typeof memberSchema>;

// সার্ভার যেভাবে সাজাতে পারে শুধু সেগুলো — "-" মানে উল্টো ক্রম (JSON:API-র প্রচলিত রূপ)
export const MEMBER_SORTS = ['name', '-name'] as const;
export type MemberSort = (typeof MEMBER_SORTS)[number];

export const memberListQuerySchema = pageQuerySchema.extend({
  sort: z.enum(MEMBER_SORTS).default('name'),
});

export const memberPageSchema = pageOf(memberSchema);
export type MemberPage = z.infer<typeof memberPageSchema>;

export const memberRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/members',
    summary: 'People with access to the active workspace, one page at a time',
    auth: 'bearer',
    status: 200,
    query: memberListQuerySchema,
    response: memberPageSchema,
  }),
};
