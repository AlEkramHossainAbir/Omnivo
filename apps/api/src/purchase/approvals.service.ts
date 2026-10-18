import { Inject, Injectable } from '@nestjs/common';
import {
  APPROVAL_DOCUMENTS,
  type ApprovalDecision,
  type ApprovalDocument,
  type ApprovalRound,
  type ApprovalRule,
  type ApprovalRuleInput,
  type ApprovalRuleList,
  type DocumentApproval,
  levelsFor,
  type NotificationType,
  type WaitingApprovalPage,
} from '@omnivo/contracts';
import {
  approvalLevels,
  approvalRounds,
  approvalRules,
  approvalSteps,
  membershipRoles,
  memberships,
  roles,
  users,
} from '@omnivo/db';
import { and, asc, desc, eq, inArray, isNull, ne, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { isForeignKeyViolation, isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { notify } from '../notifications/notify.js';
import {
  APPROVAL_TARGETS,
  type ApprovalStatus,
  type ApprovalSubject,
} from './approval-documents.js';

type RoundRow = typeof approvalRounds.$inferSelect;
type StepRow = typeof approvalSteps.$inferSelect;

const decider = alias(users, 'decider');

// The waiting list's position: when the round was submitted (as text: a Date would round the
// microseconds away), then its id
const cursorSchema = z.tuple([z.string(), z.uuid()]);

// The step a round waits for: undecided, with no undecided step before it (contracts'
// waitingStep(), in SQL). By the table's name: inside the subquery a bare column would be its own.
const isWaitingStep = sql`${approvalSteps.decision} IS NULL AND NOT EXISTS (
  SELECT 1 FROM approval_steps earlier
   WHERE earlier.tenant_id = approval_steps.tenant_id AND earlier.round_id = approval_steps.round_id
     AND earlier.decision IS NULL AND earlier.position < approval_steps.position)`;

const stepCount = sql<number>`(
  SELECT count(*)::int FROM approval_steps every
   WHERE every.tenant_id = approval_rounds.tenant_id AND every.round_id = approval_rounds.id
)`;

// The roles of the person asking, read in the transaction and not from the permission cache: who
// may decide is checked against what the person holds now, not ten minutes ago
interface MyRoles {
  roleIds: Set<string>;
  owner: boolean;
}

// What a level reads like in the audit log: "Purchase manager from 50000.0000"
function describeLevels(levels: ApprovalRule['levels']): string | null {
  if (levels.length === 0) return null;
  return levels.map((level) => `${level.role.name} from ${level.minAmount}`).join('; ');
}

function notPending(): AppError {
  return new AppError(
    409,
    'approval_not_pending',
    'This document is no longer waiting for this approval. Reload it to see where it is now.',
  );
}

// The approvals engine (step 17a). One service for every kind of document (decision 16): the
// rules in Settings, the rounds and steps of each document, the waiting list and the bell. A
// document's own service calls submit(), reopen() and history() inside its transaction; the
// decisions come straight from the /approvals routes.
@Injectable()
export class ApprovalsService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  // ---------------------------------------------------------------------------------------------
  // The rules

  listRules(): Promise<ApprovalRuleList> {
    return this.withTenant(async (tx) => {
      const items: ApprovalRule[] = [];
      for (const document of APPROVAL_DOCUMENTS) items.push(await this.readRule(tx, document));
      return { items };
    });
  }

  // The levels sent replace the ones the kind had. Documents already waiting keep the levels they
  // were submitted with (decision 13): their steps are copies.
  async saveRule(document: ApprovalDocument, input: ApprovalRuleInput): Promise<ApprovalRule> {
    try {
      return await this.withTenant(async (tx) => {
        const tenantId = getTenantId();
        const userId = currentPrincipal().userId;
        // FOR UPDATE: two people saving the levels take turns. No row yet = version 0, and two
        // first saves at once both insert: the unique index refuses the second (caught below).
        const [rule] = await tx
          .select()
          .from(approvalRules)
          .where(and(eq(approvalRules.tenantId, tenantId), eq(approvalRules.document, document)))
          .for('update');
        if ((rule?.version ?? 0) !== input.version) throw versionConflict();
        await this.checkRoles(tx, input.levels);
        const before = await this.readRule(tx, document);

        let ruleId: string;
        if (rule) {
          ruleId = rule.id;
          await tx
            .update(approvalRules)
            .set({ version: sql`${approvalRules.version} + 1`, updatedBy: userId })
            .where(and(eq(approvalRules.tenantId, tenantId), eq(approvalRules.id, rule.id)));
          await tx
            .delete(approvalLevels)
            .where(and(eq(approvalLevels.tenantId, tenantId), eq(approvalLevels.ruleId, rule.id)));
        } else {
          const [row] = await tx
            .insert(approvalRules)
            .values({ tenantId, document, createdBy: userId, updatedBy: userId })
            .returning({ id: approvalRules.id });
          if (!row) throw new Error('Approval rule insert returned no row');
          ruleId = row.id;
        }
        if (input.levels.length > 0) {
          await tx.insert(approvalLevels).values(
            input.levels.map((level, index) => ({
              tenantId,
              ruleId,
              position: index + 1,
              minAmount: level.minAmount,
              roleId: level.roleId,
            })),
          );
        }

        const after = await this.readRule(tx, document);
        await audit(tx, {
          action: 'approval_rules.changed',
          entityType: 'workspace',
          entityId: tenantId,
          changes: diff(
            { [document]: describeLevels(before.levels) },
            { [document]: describeLevels(after.levels) },
          ),
        });
        return after;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'approval_rules_tenant_document_idx')) throw versionConflict();
      // A role deleted between the check and the insert
      if (isForeignKeyViolation(error, 'approval_levels_role_fk')) {
        throw new AppError(409, 'approval_role_invalid', 'One of the roles was just deleted.');
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // A document's rounds: called by the document's service, inside its transaction, after it
  // locked the document (APPROVAL_TARGETS' lock order)

  // A new round with the levels the amount reaches (decision 13). It is approved at once when no
  // level applies, or when an Owner submits (decision 14): the Owner's steps are written already
  // approved, by the Owner, so the history says so. The document always passes through pending,
  // even then (decision 26). Returns the status the document ends in.
  async submit(
    tx: Transaction,
    document: ApprovalDocument,
    id: string,
    amount: string,
  ): Promise<ApprovalStatus> {
    const tenantId = getTenantId();
    const me = currentPrincipal().userId;
    const target = APPROVAL_TARGETS[document];
    const levels = levelsFor(await this.levelRows(tx, document), amount);
    const { owner } = await this.myRoles(tx);
    const now = new Date();

    const [round] = await tx
      .insert(approvalRounds)
      .values({ tenantId, document, documentId: id, amount, submittedBy: me })
      .returning();
    if (!round) throw new Error('Approval round insert returned no row');
    const steps =
      levels.length === 0
        ? []
        : await tx
            .insert(approvalSteps)
            .values(
              levels.map((level, index) => ({
                tenantId,
                roundId: round.id,
                position: index + 1,
                minAmount: level.minAmount,
                roleId: level.roleId,
                roleName: level.roleName,
                ...(owner ? { decision: 'approved' as const, decidedBy: me, decidedAt: now } : {}),
              })),
            )
            .returning();
    await target.setStatus(tx, id, 'pending');

    const approved = owner || steps.length === 0;
    if (approved) {
      await this.close(tx, round.id, 'approved', now);
      await target.setStatus(tx, id, 'approved');
    } else {
      const [first] = steps;
      if (first) await this.ring(tx, document, id, first, 'approval.requested', round);
    }
    await audit(tx, {
      action: 'approval.submitted',
      entityType: target.entityType,
      entityId: id,
      changes: created({ amount, steps: steps.length, status: approved ? 'approved' : 'pending' }),
    });
    return approved ? 'approved' : 'pending';
  }

  // Back to draft. A pending round ends as reopened; an approved one stays approved (it was), and
  // the next submit starts a new round from the first level (decision 6).
  async reopen(
    tx: Transaction,
    document: ApprovalDocument,
    id: string,
    from: 'pending' | 'approved',
  ): Promise<void> {
    const target = APPROVAL_TARGETS[document];
    if (from === 'pending') {
      const round = await this.pendingRound(tx, document, id);
      if (round) await this.close(tx, round.id, 'reopened', new Date());
    }
    await target.setStatus(tx, id, 'draft');
    await audit(tx, {
      action: 'approval.reopened',
      entityType: target.entityType,
      entityId: id,
      changes: diff({ status: from }, { status: 'draft' }),
    });
  }

  // Every round of a document, newest first, and whether the reader may decide the waiting step
  async history(
    tx: Transaction,
    document: ApprovalDocument,
    id: string,
  ): Promise<DocumentApproval> {
    const tenantId = getTenantId();
    const roundRows = await tx
      .select({ round: approvalRounds, submittedByName: users.fullName })
      .from(approvalRounds)
      .innerJoin(users, eq(users.id, approvalRounds.submittedBy))
      .where(
        and(
          eq(approvalRounds.tenantId, tenantId),
          eq(approvalRounds.document, document),
          eq(approvalRounds.documentId, id),
        ),
      )
      .orderBy(desc(approvalRounds.submittedAt), desc(approvalRounds.id));
    const roundIds = roundRows.map((row) => row.round.id);
    const stepRows =
      roundIds.length === 0
        ? []
        : await tx
            .select({ step: approvalSteps, decidedByName: decider.fullName })
            .from(approvalSteps)
            .leftJoin(decider, eq(decider.id, approvalSteps.decidedBy))
            .where(
              and(eq(approvalSteps.tenantId, tenantId), inArray(approvalSteps.roundId, roundIds)),
            )
            .orderBy(asc(approvalSteps.position));

    const rounds: ApprovalRound[] = roundRows.map(({ round, submittedByName }) => ({
      id: round.id,
      status: round.status,
      amount: round.amount,
      submittedBy: { id: round.submittedBy, name: submittedByName },
      submittedAt: round.submittedAt.toISOString(),
      closedAt: round.closedAt?.toISOString() ?? null,
      steps: stepRows
        .filter(({ step }) => step.roundId === round.id)
        .map(({ step, decidedByName }) => ({
          position: step.position,
          minAmount: step.minAmount,
          role: { id: step.roleId, name: step.roleName },
          decision: step.decision,
          decidedBy:
            step.decidedBy !== null && decidedByName !== null
              ? { id: step.decidedBy, name: decidedByName }
              : null,
          decidedAt: step.decidedAt?.toISOString() ?? null,
          comment: step.comment,
        })),
    }));

    const [newest] = rounds;
    const waiting =
      newest?.status === 'pending'
        ? newest.steps.find((step) => step.decision === null)
        : undefined;
    const canDecide =
      newest !== undefined &&
      waiting !== undefined &&
      this.mayDecide(await this.myRoles(tx), newest.submittedBy.id, waiting.role.id);
    return { rounds, canDecide };
  }

  // ---------------------------------------------------------------------------------------------
  // Deciding (the /approvals routes)

  // Approve or reject the step a document waits for. roundId is the round the page showed
  // (decision 16): if the document was reopened or decided since, the answer is
  // approval_not_pending and nothing changes.
  decide(
    document: ApprovalDocument,
    id: string,
    decision: ApprovalDecision,
    input: { roundId: string; comment: string | null },
  ): Promise<void> {
    return this.withTenant(async (tx) => {
      const tenantId = getTenantId();
      const me = currentPrincipal().userId;
      const target = APPROVAL_TARGETS[document];
      // The document first, then the round: the same order as submit and reopen
      if (!(await target.lock(tx, id))) throw notFound('Document');
      const [round] = await tx
        .select()
        .from(approvalRounds)
        .where(
          and(
            eq(approvalRounds.tenantId, tenantId),
            eq(approvalRounds.id, input.roundId),
            eq(approvalRounds.document, document),
            eq(approvalRounds.documentId, id),
          ),
        )
        .for('update');
      if (round?.status !== 'pending') throw notPending();
      const steps = await tx
        .select()
        .from(approvalSteps)
        .where(and(eq(approvalSteps.tenantId, tenantId), eq(approvalSteps.roundId, round.id)))
        .orderBy(asc(approvalSteps.position));
      const step = steps.find((row) => row.decision === null);
      // A pending round always has an undecided step; a round with none was closed at submit
      if (!step) throw notPending();

      const mine = await this.myRoles(tx);
      if (!mine.owner && round.submittedBy === me) {
        throw new AppError(
          403,
          'approval_own_document',
          'You submitted this document, so someone else approves it.',
        );
      }
      if (!this.mayDecide(mine, round.submittedBy, step.roleId)) {
        throw new AppError(
          403,
          'approval_not_allowed',
          `This step needs the ${step.roleName} role, or an Owner.`,
        );
      }

      const now = new Date();
      await tx
        .update(approvalSteps)
        .set({ decision, decidedBy: me, decidedAt: now, comment: input.comment })
        .where(and(eq(approvalSteps.tenantId, tenantId), eq(approvalSteps.id, step.id)));
      await audit(tx, {
        action: decision === 'approved' ? 'approval.approved' : 'approval.rejected',
        entityType: target.entityType,
        entityId: id,
        changes: created({
          step: `${String(step.position)} of ${String(steps.length)}`,
          role: step.roleName,
          comment: input.comment,
        }),
      });

      const next = steps.find((row) => row.position > step.position && row.decision === null);
      if (decision === 'rejected') {
        // The steps after it stay undecided; the round's status says why (decision 15)
        await this.close(tx, round.id, 'rejected', now);
        await target.setStatus(tx, id, 'draft');
        await this.ring(tx, document, id, step, 'approval.rejected', round);
      } else if (next) {
        // A step in the middle rings only the next level (decision 18)
        await this.ring(tx, document, id, next, 'approval.requested', round);
      } else {
        await this.close(tx, round.id, 'approved', now);
        await target.setStatus(tx, id, 'approved');
        await this.ring(tx, document, id, step, 'approval.approved', round);
      }
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Waiting for me (decision 17)

  // The documents whose waiting step the reader may decide, oldest first: the longest wait on top
  waiting(query: { limit: number; cursor?: string | undefined }): Promise<WaitingApprovalPage> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const mine = await this.myRoles(tx);
      const condition = this.waitingFor(mine);
      if (condition === null) return { items: [], nextCursor: null };
      const rows = await tx
        .select({
          round: approvalRounds,
          position: approvalSteps.position,
          stepCount,
          submittedByName: users.fullName,
          sortKey: sql<string>`${approvalRounds.submittedAt}::text`,
        })
        .from(approvalRounds)
        .innerJoin(
          approvalSteps,
          and(
            eq(approvalSteps.tenantId, approvalRounds.tenantId),
            eq(approvalSteps.roundId, approvalRounds.id),
            isWaitingStep,
          ),
        )
        .innerJoin(users, eq(users.id, approvalRounds.submittedBy))
        .where(
          and(
            eq(approvalRounds.tenantId, getTenantId()),
            eq(approvalRounds.status, 'pending'),
            condition,
            after === undefined
              ? undefined
              : sql`(${approvalRounds.submittedAt}, ${approvalRounds.id}) > (${after[0]}::timestamptz, ${after[1]}::uuid)`,
          ),
        )
        .orderBy(asc(approvalRounds.submittedAt), asc(approvalRounds.id))
        .limit(query.limit + 1);
      const page = toPage(rows, query.limit, (last) => [last.sortKey, last.round.id]);

      // Each kind's number, date and subject: one query per kind on this page
      const idsOf = new Map<ApprovalDocument, string[]>();
      for (const { round } of page.items) {
        idsOf.set(round.document, [...(idsOf.get(round.document) ?? []), round.documentId]);
      }
      const subjects = new Map<string, ApprovalSubject>();
      for (const [document, ids] of idsOf) {
        const found = await APPROVAL_TARGETS[document].describe(tx, ids);
        for (const [id, subject] of found) subjects.set(`${document}:${id}`, subject);
      }
      return {
        items: page.items.flatMap(({ round, position, stepCount: count, submittedByName }) => {
          const subject = subjects.get(`${round.document}:${round.documentId}`);
          if (!subject) return [];
          return [
            {
              document: round.document,
              id: round.documentId,
              ...subject,
              amount: round.amount,
              submittedBy: { id: round.submittedBy, name: submittedByName },
              submittedAt: round.submittedAt.toISOString(),
              roundId: round.id,
              position,
              stepCount: count,
            },
          ];
        }),
        nextCursor: page.nextCursor,
      };
    });
  }

  waitingCount(): Promise<{ count: number }> {
    return this.withTenant(async (tx) => {
      const condition = this.waitingFor(await this.myRoles(tx));
      if (condition === null) return { count: 0 };
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(approvalRounds)
        .innerJoin(
          approvalSteps,
          and(
            eq(approvalSteps.tenantId, approvalRounds.tenantId),
            eq(approvalSteps.roundId, approvalRounds.id),
            isWaitingStep,
          ),
        )
        .where(
          and(
            eq(approvalRounds.tenantId, getTenantId()),
            eq(approvalRounds.status, 'pending'),
            condition,
          ),
        );
      return { count: row?.count ?? 0 };
    });
  }

  // ---------------------------------------------------------------------------------------------

  // An Owner may decide any step (decision 5), even of a document they submitted as someone else
  // before becoming Owner. Anyone else needs the step's role, and not their own document
  // (decision 14). A step whose role was deleted (null) is left to an Owner.
  private mayDecide(mine: MyRoles, submittedBy: string, roleId: string | null): boolean {
    if (mine.owner) return true;
    return roleId !== null && mine.roleIds.has(roleId) && submittedBy !== currentPrincipal().userId;
  }

  // mayDecide() as a condition on the waiting step; null = nothing can match (no roles at all)
  private waitingFor(mine: MyRoles): SQL | undefined | null {
    if (mine.owner) return undefined;
    if (mine.roleIds.size === 0) return null;
    return and(
      inArray(approvalSteps.roleId, [...mine.roleIds]),
      ne(approvalRounds.submittedBy, currentPrincipal().userId),
    );
  }

  private async myRoles(tx: Transaction): Promise<MyRoles> {
    const rows = await tx
      .select({ id: roles.id, kind: roles.kind })
      .from(membershipRoles)
      .innerJoin(
        roles,
        and(eq(roles.tenantId, membershipRoles.tenantId), eq(roles.id, membershipRoles.roleId)),
      )
      .where(
        and(
          eq(membershipRoles.tenantId, getTenantId()),
          eq(membershipRoles.membershipId, currentPrincipal().membershipId),
        ),
      );
    return {
      roleIds: new Set(rows.map((row) => row.id)),
      owner: rows.some((row) => row.kind === 'owner'),
    };
  }

  // The bell (decision 18). approval.requested goes to the people who hold the step's role; when
  // nobody does (or the role was deleted), to the Owners, who may decide any level, so a document
  // never waits without anyone knowing. approved / rejected go to the person who submitted it.
  // Nobody is told about what they did themselves. The event id makes each one once per person:
  // the step for a request, the round for its end.
  private async ring(
    tx: Transaction,
    document: ApprovalDocument,
    id: string,
    step: StepRow,
    type: NotificationType,
    round: RoundRow,
  ): Promise<void> {
    const me = currentPrincipal().userId;
    const recipients =
      type === 'approval.requested' ? await this.approversOf(tx, step.roleId) : [round.submittedBy];
    const subject = (await APPROVAL_TARGETS[document].describe(tx, [id])).get(id);
    if (!subject) return;
    for (const userId of new Set(recipients)) {
      if (userId === me || (type === 'approval.requested' && userId === round.submittedBy)) {
        continue;
      }
      await notify(tx, {
        userId,
        type,
        params: { document, id, number: subject.number },
        eventId: type === 'approval.requested' ? step.id : round.id,
      });
    }
  }

  private async approversOf(tx: Transaction, roleId: string | null): Promise<string[]> {
    const tenantId = getTenantId();
    const holders = (role: SQL) =>
      tx
        .selectDistinct({ userId: memberships.userId })
        .from(membershipRoles)
        .innerJoin(
          memberships,
          and(
            eq(memberships.tenantId, membershipRoles.tenantId),
            eq(memberships.id, membershipRoles.membershipId),
          ),
        )
        .innerJoin(
          roles,
          and(eq(roles.tenantId, membershipRoles.tenantId), eq(roles.id, membershipRoles.roleId)),
        )
        .where(and(eq(membershipRoles.tenantId, tenantId), isNull(memberships.deletedAt), role));
    const found = roleId === null ? [] : await holders(eq(roles.id, roleId));
    const people = found.length > 0 ? found : await holders(eq(roles.kind, 'owner'));
    return people.map((row) => row.userId);
  }

  private async close(
    tx: Transaction,
    roundId: string,
    status: 'approved' | 'rejected' | 'reopened',
    at: Date,
  ): Promise<void> {
    await tx
      .update(approvalRounds)
      .set({ status, closedAt: at })
      .where(and(eq(approvalRounds.tenantId, getTenantId()), eq(approvalRounds.id, roundId)));
  }

  private async pendingRound(
    tx: Transaction,
    document: ApprovalDocument,
    id: string,
  ): Promise<RoundRow | undefined> {
    const [round] = await tx
      .select()
      .from(approvalRounds)
      .where(
        and(
          eq(approvalRounds.tenantId, getTenantId()),
          eq(approvalRounds.document, document),
          eq(approvalRounds.documentId, id),
          eq(approvalRounds.status, 'pending'),
        ),
      )
      .for('update');
    return round;
  }

  // The levels of a kind with their roles' names now: what a new round copies
  private levelRows(tx: Transaction, document: ApprovalDocument) {
    return tx
      .select({
        minAmount: approvalLevels.minAmount,
        roleId: approvalLevels.roleId,
        roleName: roles.name,
      })
      .from(approvalLevels)
      .innerJoin(
        approvalRules,
        and(
          eq(approvalRules.tenantId, approvalLevels.tenantId),
          eq(approvalRules.id, approvalLevels.ruleId),
        ),
      )
      .innerJoin(
        roles,
        and(eq(roles.tenantId, approvalLevels.tenantId), eq(roles.id, approvalLevels.roleId)),
      )
      .where(and(eq(approvalLevels.tenantId, getTenantId()), eq(approvalRules.document, document)))
      .orderBy(asc(approvalLevels.position));
  }

  private async readRule(tx: Transaction, document: ApprovalDocument): Promise<ApprovalRule> {
    const [rule] = await tx
      .select()
      .from(approvalRules)
      .where(and(eq(approvalRules.tenantId, getTenantId()), eq(approvalRules.document, document)));
    if (!rule) return { document, levels: [], version: 0, updatedAt: null };
    const levels = await this.levelRows(tx, document);
    return {
      document,
      levels: levels.map((level) => ({
        minAmount: level.minAmount,
        role: { id: level.roleId, name: level.roleName },
      })),
      version: rule.version,
      updatedAt: rule.updatedAt.toISOString(),
    };
  }

  // Every role must be one of this workspace's, each error under its own row
  private async checkRoles(tx: Transaction, levels: ApprovalRuleInput['levels']): Promise<void> {
    const ids = [...new Set(levels.map((level) => level.roleId))];
    const found =
      ids.length === 0
        ? []
        : await tx
            .select({ id: roles.id })
            .from(roles)
            .where(and(eq(roles.tenantId, getTenantId()), inArray(roles.id, ids)));
    const known = new Set(found.map((row) => row.id));
    const invalid = levels.flatMap((level, index) => (known.has(level.roleId) ? [] : [index]));
    if (invalid.length > 0) {
      throw new AppError(409, 'approval_role_invalid', 'Pick a role of this workspace.', {
        fieldErrors: Object.fromEntries(
          invalid.map((index) => [`levels.${String(index)}.roleId`, ['approval_role_invalid']]),
        ),
      });
    }
  }
}
