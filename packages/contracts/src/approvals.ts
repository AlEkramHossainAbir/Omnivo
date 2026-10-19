import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText } from './fields.js';
import { defineRoute } from './http.js';
import { roleRefSchema } from './members.js';
import { compareMoney, isMoneyAmount } from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';

// An approval (step 17a, you chose this): per kind of document, an ordered list of levels. Each
// level has an amount and a role. A document needs every level whose amount it reaches, one after
// another: "a requisition from ৳50,000 needs the Purchase manager, from ৳5,00,000 also the Owner".
// Anyone with the level's role may approve it, and an Owner may approve any level. Nobody approves
// their own document, except an Owner: the Owner answers to nobody, so the Owner's own document is
// approved when it is submitted.

// The documents that can need an approval. Each guide adds its own: 17a the requisition, 17b the
// purchase order, 17c the bill and the supplier payment.
export const APPROVAL_DOCUMENTS = ['requisition', 'purchase_order'] as const;
export type ApprovalDocument = (typeof APPROVAL_DOCUMENTS)[number];

export function isApprovalDocument(value: string): value is ApprovalDocument {
  return APPROVAL_DOCUMENTS.some((document) => document === value);
}

// More than five signatures on one purchase is a process nobody follows
export const MAX_APPROVAL_LEVELS = 5;

// ---------------------------------------------------------------------------------------------
// The rules (Settings → Approvals)

export const approvalLevelSchema = z.object({
  // A document whose amount is at least this needs the level. "0.0000" = every document.
  minAmount: z.string(),
  role: roleRefSchema,
});
export type ApprovalLevel = z.infer<typeof approvalLevelSchema>;

export const approvalRuleSchema = z.object({
  // z.string(), not the enum: a newer server's new document must not break an older client
  document: z.string(),
  // In order: the first one approves first. Empty = documents of this kind need no approval.
  levels: z.array(approvalLevelSchema),
  // 0 = the workspace never saved levels for this kind (no row yet)
  version: z.number().int().min(0),
  updatedAt: z.iso.datetime().nullable(),
});
export type ApprovalRule = z.infer<typeof approvalRuleSchema>;

// One rule per kind of document, in APPROVAL_DOCUMENTS order
export const approvalRuleListSchema = z.object({ items: z.array(approvalRuleSchema) });
export type ApprovalRuleList = z.infer<typeof approvalRuleListSchema>;

// The amount a level starts at: "0" is a real amount (every document). Any number of decimals up to
// 4, like every amount, though a person types whole taka here.
const minAmountSchema = z
  .string()
  .trim()
  .refine((value) => value !== '', errorCode('required'))
  .refine((value) => value === '' || isMoneyAmount(value), errorCode('money_format'));

export const approvalRuleInputSchema = z
  .object({
    levels: z
      .array(
        z.object({
          minAmount: minAmountSchema,
          roleId: z.uuid(errorCode('approval_role_invalid')),
        }),
      )
      .max(MAX_APPROVAL_LEVELS),
    // The version the page was opened with (0 when it had no levels yet)
    version: z.number().int().min(0),
  })
  // The levels read from top to bottom, each from a bigger (or the same) amount than the one above:
  // a level that starts lower than the one before it would make the order mean nothing. And a role
  // once: the same people would approve the same document twice.
  .superRefine((input, ctx) => {
    const roles = new Set<string>();
    input.levels.forEach((level, index) => {
      const previous = input.levels[index - 1];
      if (
        previous !== undefined &&
        isMoneyAmount(previous.minAmount) &&
        isMoneyAmount(level.minAmount) &&
        compareMoney(level.minAmount, previous.minAmount) < 0
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['levels', index, 'minAmount'],
          message: errorCode('approval_level_order'),
        });
      }
      if (roles.has(level.roleId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['levels', index, 'roleId'],
          message: errorCode('approval_role_twice'),
        });
      }
      roles.add(level.roleId);
    });
  });
export type ApprovalRuleInput = z.infer<typeof approvalRuleInputSchema>;
export type ApprovalRuleFormValues = z.input<typeof approvalRuleInputSchema>;

// The levels a document of this amount needs, in order. The server copies them onto the document
// when it is submitted; the form uses the same function to say "Needs 2 approvals" before that.
export function levelsFor<L extends { minAmount: string }>(
  levels: readonly L[],
  amount: string,
): L[] {
  return levels.filter((level) => compareMoney(amount, level.minAmount) >= 0);
}

// ---------------------------------------------------------------------------------------------
// A document's approval: one round per time it was submitted

// pending: waiting for a step · approved: every step approved (or none was needed) · rejected: a
// step said no, the document went back to draft · reopened: taken back to draft by its writer while
// pending, or reopened after it was approved
export const APPROVAL_ROUND_STATUSES = ['pending', 'approved', 'rejected', 'reopened'] as const;
export type ApprovalRoundStatus = (typeof APPROVAL_ROUND_STATUSES)[number];

export const APPROVAL_DECISIONS = ['approved', 'rejected'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

const personSchema = z.object({ id: z.uuid(), name: z.string() });

// One level as it was copied onto the round when the document was submitted. A later change in
// Settings does not touch it.
export const approvalStepSchema = z.object({
  // 1, 2, 3: the order the steps are decided in
  position: z.number().int().min(1),
  minAmount: z.string(),
  // The level's role. Its id is null once the role was deleted: the name it had stays, so the
  // history still says who it was for. (A role a waiting step needs cannot be deleted.)
  role: z.object({ id: z.uuid().nullable(), name: z.string() }),
  // null = not decided yet: the step waiting now, or one after it
  decision: z.enum(APPROVAL_DECISIONS).nullable(),
  decidedBy: personSchema.nullable(),
  decidedAt: z.iso.datetime().nullable(),
  // Why it was rejected (always there), or a note with an approval
  comment: z.string().nullable(),
});
export type ApprovalStep = z.infer<typeof approvalStepSchema>;

export const approvalRoundSchema = z.object({
  id: z.uuid(),
  status: z.enum(APPROVAL_ROUND_STATUSES),
  // The document's amount when it was submitted: what chose the steps
  amount: z.string(),
  submittedBy: personSchema,
  submittedAt: z.iso.datetime(),
  // When it was approved, rejected or reopened; null while pending
  closedAt: z.iso.datetime().nullable(),
  // Empty when no level applied: approved at once
  steps: z.array(approvalStepSchema),
});
export type ApprovalRound = z.infer<typeof approvalRoundSchema>;

export const documentApprovalSchema = z.object({
  // Newest first: the first one is the round now (or the last one)
  rounds: z.array(approvalRoundSchema),
  // The reader may approve or reject the step that is waiting now
  canDecide: z.boolean(),
});
export type DocumentApproval = z.infer<typeof documentApprovalSchema>;

// The step a pending round waits for: the first one without a decision
export function waitingStep(round: ApprovalRound): ApprovalStep | null {
  if (round.status !== 'pending') return null;
  return round.steps.find((step) => step.decision === null) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Deciding

const documentParamsSchema = z.object({
  document: z.enum(APPROVAL_DOCUMENTS),
  id: z.uuid(),
});

// The round the page showed. If the document was reopened and submitted again since, the person
// would be approving something they never saw: the server answers approval_not_pending.
export const approveInputSchema = z.object({
  roundId: z.uuid(),
  comment: optionalText(500),
});
export type ApproveInput = z.infer<typeof approveInputSchema>;

// A rejection always says why, so the writer knows what to change
export const rejectInputSchema = z.object({
  roundId: z.uuid(),
  comment: z.string().trim().min(2, errorCode('approval_comment_required')).max(500),
});
export type RejectInput = z.infer<typeof rejectInputSchema>;
export type RejectFormValues = z.input<typeof rejectInputSchema>;

// ---------------------------------------------------------------------------------------------
// What waits for me

export const waitingApprovalSchema = z.object({
  // An ApprovalDocument kind; z.string() for the same reason as the rule's
  document: z.string(),
  id: z.uuid(),
  number: z.string(),
  date: z.iso.date(),
  // What the document is about, for the list: the warehouse of a requisition, the supplier of an
  // order (17b)
  subject: z.string(),
  amount: z.string(),
  submittedBy: personSchema,
  submittedAt: z.iso.datetime(),
  roundId: z.uuid(),
  // "Step 2 of 3"
  position: z.number().int().min(1),
  stepCount: z.number().int().min(1),
});
export type WaitingApproval = z.infer<typeof waitingApprovalSchema>;

export const waitingApprovalPageSchema = pageOf(waitingApprovalSchema);
export type WaitingApprovalPage = z.infer<typeof waitingApprovalPageSchema>;

export const waitingCountSchema = z.object({ count: z.number().int().min(0) });

// Reading the rules needs no permission, like the roles: a requisition form says which approvals
// it will need. Changing them is a workspace setting. Deciding needs no permission either: the
// level's role (or being an Owner) is the right, checked by the server.
export const approvalRuleRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/approval-rules',
    summary: 'The approval levels of every kind of document that can need one',
    auth: 'bearer',
    status: 200,
    response: approvalRuleListSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/approval-rules/:document',
    summary: 'Replace the approval levels of one kind of document',
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 200,
    params: z.object({ document: z.enum(APPROVAL_DOCUMENTS) }),
    body: approvalRuleInputSchema,
    response: approvalRuleSchema,
  }),
};

export const approvalRoutes = {
  waiting: defineRoute({
    method: 'GET',
    path: '/approvals/waiting',
    summary: 'Documents waiting for a step the signed-in person may approve, oldest first',
    auth: 'bearer',
    status: 200,
    query: pageQuerySchema,
    response: waitingApprovalPageSchema,
  }),
  // The navigation's count, polled with the bell: a tiny call of its own
  waitingCount: defineRoute({
    method: 'GET',
    path: '/approvals/waiting/count',
    summary: 'How many documents wait for the signed-in person',
    auth: 'bearer',
    status: 200,
    response: waitingCountSchema,
  }),
  approve: defineRoute({
    method: 'POST',
    path: '/approvals/:document/:id/approve',
    summary: 'Approve the step a document waits for',
    auth: 'bearer',
    status: 204,
    params: documentParamsSchema,
    body: approveInputSchema,
    response: z.void(),
  }),
  reject: defineRoute({
    method: 'POST',
    path: '/approvals/:document/:id/reject',
    summary: 'Reject a document: it goes back to draft with the reason',
    auth: 'bearer',
    status: 204,
    params: documentParamsSchema,
    body: rejectInputSchema,
    response: z.void(),
  }),
};
