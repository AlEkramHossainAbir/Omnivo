import { APPROVAL_DECISIONS, APPROVAL_DOCUMENTS, APPROVAL_ROUND_STATUSES } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { roles } from './roles.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

// Step 17a: approvals. Two tables say what a kind of document needs (the rule and its levels, set
// in Settings), and two record what happened to one document (its rounds and their steps). The
// rules on what may change when live in migration 0036.

// ---------------------------------------------------------------------------------------------
// The rule of a kind of document

// One row per kind of document that was ever set up. No row = no levels = no approval (the
// contract's version 0). Saving the levels changes the row's version, so two people editing the
// levels at once cannot overwrite each other.
export const approvalRules = pgTable(
  'approval_rules',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    document: text('document', { enum: APPROVAL_DOCUMENTS }).notNull(),
  },
  (table) => [
    uniqueIndex('approval_rules_tenant_document_idx').on(table.tenantId, table.document),
    uniqueIndex('approval_rules_tenant_id_idx').on(table.tenantId, table.id),
  ],
);

// "From ৳50,000: Purchase manager". A save replaces all of a rule's levels.
export const approvalLevels = pgTable(
  'approval_levels',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    ruleId: uuid('rule_id').notNull(),
    // 1 = decided first
    position: smallint('position').notNull(),
    // The level applies to a document of this amount or more; 0 = every document
    minAmount: numeric('min_amount', { precision: 19, scale: 4 }).notNull(),
    roleId: uuid('role_id').notNull(),
  },
  (table) => [
    uniqueIndex('approval_levels_position_idx').on(table.tenantId, table.ruleId, table.position),
    // The contract's approval_role_twice again: one role decides once per document
    uniqueIndex('approval_levels_role_idx').on(table.tenantId, table.ruleId, table.roleId),
    // The role FK's check when a role is deleted
    index('approval_levels_tenant_role_idx').on(table.tenantId, table.roleId),
    foreignKey({
      name: 'approval_levels_rule_fk',
      columns: [table.tenantId, table.ruleId],
      foreignColumns: [approvalRules.tenantId, approvalRules.id],
    }).onDelete('cascade'),
    // No ON DELETE: a role a level names cannot be deleted (role_in_use)
    foreignKey({
      name: 'approval_levels_role_fk',
      columns: [table.tenantId, table.roleId],
      foreignColumns: [roles.tenantId, roles.id],
    }),
    // 5 = the contract's MAX_APPROVAL_LEVELS; with the unique position, a rule never has more
    check('approval_levels_position_check', sql`${table.position} BETWEEN 1 AND 5`),
    check('approval_levels_amount_check', sql`${table.minAmount} >= 0`),
  ],
);

// ---------------------------------------------------------------------------------------------
// What happened to one document

// One row each time a document is submitted (decision 15). document_id has no foreign key: it
// points into a different table for each kind (requisitions now, purchase orders in 17b). A
// document that was ever submitted is never deleted (its own guard), so the id never dangles.
export const approvalRounds = pgTable(
  'approval_rounds',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    document: text('document', { enum: APPROVAL_DOCUMENTS }).notNull(),
    documentId: uuid('document_id').notNull(),
    status: text('status', { enum: APPROVAL_ROUND_STATUSES }).notNull().default('pending'),
    // The document's amount when it was submitted: the amount its levels were chosen by
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    submittedBy: uuid('submitted_by')
      .notNull()
      .references(() => users.id),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    // When it ended: approved, rejected or reopened
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('approval_rounds_tenant_id_idx').on(table.tenantId, table.id),
    // At most one round waits per document, whatever two people do at once
    uniqueIndex('approval_rounds_pending_idx')
      .on(table.tenantId, table.document, table.documentId)
      .where(sql`${table.status} = 'pending'`),
    // A document's history, newest first
    index('approval_rounds_document_idx').on(
      table.tenantId,
      table.document,
      table.documentId,
      table.submittedAt,
    ),
    // "Waiting for me" for an Owner, who may decide every waiting step: oldest first
    index('approval_rounds_waiting_idx')
      .on(table.tenantId, table.submittedAt, table.id)
      .where(sql`${table.status} = 'pending'`),
    check('approval_rounds_amount_check', sql`${table.amount} >= 0`),
    check(
      'approval_rounds_closed_check',
      sql`(${table.status} = 'pending') = (${table.closedAt} IS NULL)`,
    ),
  ],
);

// The levels the round's amount reached, copied when it was submitted (decision 13): a change in
// Settings never moves a document that is already waiting.
export const approvalSteps = pgTable(
  'approval_steps',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    roundId: uuid('round_id').notNull(),
    position: smallint('position').notNull(),
    minAmount: numeric('min_amount', { precision: 19, scale: 4 }).notNull(),
    // NULL once the role is deleted (the FK's ON DELETE SET NULL is in migration 0036); the name
    // below still says who it was for
    roleId: uuid('role_id'),
    roleName: text('role_name').notNull(),
    decision: text('decision', { enum: APPROVAL_DECISIONS }),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    // Why it was rejected (required), or a note with an approval
    comment: text('comment'),
  },
  (table) => [
    uniqueIndex('approval_steps_position_idx').on(table.tenantId, table.roundId, table.position),
    // "Waiting for me": the undecided steps of the roles a person has. Also the role FK's check.
    index('approval_steps_open_role_idx')
      .on(table.tenantId, table.roleId, table.roundId)
      .where(sql`${table.decision} IS NULL`),
    index('approval_steps_tenant_role_idx').on(table.tenantId, table.roleId),
    foreignKey({
      name: 'approval_steps_round_fk',
      columns: [table.tenantId, table.roundId],
      foreignColumns: [approvalRounds.tenantId, approvalRounds.id],
    }),
    check('approval_steps_position_check', sql`${table.position} BETWEEN 1 AND 5`),
    check('approval_steps_amount_check', sql`${table.minAmount} >= 0`),
    // Decided means decided by someone, at a time; undecided means none of the three
    check(
      'approval_steps_decided_check',
      sql`(${table.decision} IS NULL AND ${table.decidedBy} IS NULL AND ${table.decidedAt} IS NULL) OR (${table.decision} IS NOT NULL AND ${table.decidedBy} IS NOT NULL AND ${table.decidedAt} IS NOT NULL)`,
    ),
    // A rejection says why (decision 15); 500 = the contract's limit
    check(
      'approval_steps_comment_check',
      sql`(${table.decision} IS DISTINCT FROM 'rejected' OR ${table.comment} IS NOT NULL) AND (${table.comment} IS NULL OR (${table.decision} IS NOT NULL AND char_length(${table.comment}) BETWEEN 1 AND 500))`,
    ),
  ],
);
