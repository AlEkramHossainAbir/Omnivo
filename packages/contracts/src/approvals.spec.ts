import { describe, expect, it } from 'vitest';

import {
  type ApprovalRound,
  approvalRuleInputSchema,
  levelsFor,
  rejectInputSchema,
  waitingStep,
} from './approvals.js';

const MANAGER = '01920000-0000-7000-8000-000000000001';
const OWNER = '01920000-0000-7000-8000-000000000002';
const ROUND = '01920000-0000-7000-8000-000000000003';

describe('approval rule input', () => {
  it('takes levels from a bigger or the same amount, each role once', () => {
    const result = approvalRuleInputSchema.safeParse({
      levels: [
        { minAmount: '50000', roleId: MANAGER },
        { minAmount: '500000', roleId: OWNER },
      ],
      version: 0,
    });
    expect(result.success).toBe(true);
  });

  it('refuses a level that starts lower than the one above it, and a role twice', () => {
    const result = approvalRuleInputSchema.safeParse({
      levels: [
        { minAmount: '500000', roleId: MANAGER },
        { minAmount: '50000', roleId: MANAGER },
      ],
      version: 3,
    });
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['levels', 1, 'minAmount'],
        message: 'approval_level_order',
      }),
      expect.objectContaining({ path: ['levels', 1, 'roleId'], message: 'approval_role_twice' }),
    ]);
  });

  it('takes "0" as a real amount (every document) but not an empty box', () => {
    expect(
      approvalRuleInputSchema.safeParse({
        levels: [{ minAmount: '0', roleId: MANAGER }],
        version: 0,
      }).success,
    ).toBe(true);
    expect(
      approvalRuleInputSchema.safeParse({
        levels: [{ minAmount: ' ', roleId: MANAGER }],
        version: 0,
      }).error?.issues[0]?.message,
    ).toBe('required');
  });

  it('takes no levels at all: documents of this kind need no approval', () => {
    expect(approvalRuleInputSchema.parse({ levels: [], version: 2 }).levels).toEqual([]);
  });
});

describe('levelsFor', () => {
  const levels = [
    { minAmount: '0.0000', name: 'store' },
    { minAmount: '50000.0000', name: 'manager' },
    { minAmount: '500000.0000', name: 'owner' },
  ];

  it('picks every level the amount reaches, an amount equal to the start included', () => {
    expect(levelsFor(levels, '49999.9900').map((level) => level.name)).toEqual(['store']);
    expect(levelsFor(levels, '50000.0000').map((level) => level.name)).toEqual([
      'store',
      'manager',
    ]);
    expect(levelsFor(levels, '1842600.5000')).toHaveLength(3);
  });

  it('needs nothing when no level starts low enough', () => {
    expect(levelsFor(levels.slice(1), '1200.0000')).toEqual([]);
  });
});

describe('waitingStep', () => {
  const step = {
    minAmount: '0.0000',
    role: { id: MANAGER, name: 'Purchase manager' },
    decidedBy: null,
    decidedAt: null,
    comment: null,
  };
  const round: ApprovalRound = {
    id: ROUND,
    status: 'pending',
    amount: '600000.0000',
    submittedBy: { id: OWNER, name: 'Nusrat Jahan' },
    submittedAt: '2026-10-15T04:00:00.000Z',
    closedAt: null,
    steps: [
      {
        ...step,
        position: 1,
        decision: 'approved',
        decidedBy: { id: MANAGER, name: 'Rafiq' },
        decidedAt: '2026-10-15T05:00:00.000Z',
      },
      { ...step, position: 2, decision: null },
    ],
  };

  it('is the first step without a decision while the round is pending', () => {
    expect(waitingStep(round)?.position).toBe(2);
  });

  it('is nothing once the round is closed', () => {
    expect(waitingStep({ ...round, status: 'rejected' })).toBeNull();
  });
});

describe('reject input', () => {
  it('needs a reason', () => {
    expect(rejectInputSchema.safeParse({ roundId: ROUND, comment: ' ' }).error?.issues).toEqual([
      expect.objectContaining({ path: ['comment'], message: 'approval_comment_required' }),
    ]);
  });
});
