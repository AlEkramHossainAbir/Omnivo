import {
  addMoney,
  addQuantity,
  type ApprovalDecision,
  type ApprovalDocument,
  type ApprovalRound,
  type ApprovalRule,
  type ApprovalRuleInput,
  type ApprovalStep,
  type CostLookup,
  type CostLookupInput,
  type CostLookupItem,
  compareQuantity,
  defaultLineDescription,
  type DocumentRef,
  type DocumentApproval,
  type ErrorCode,
  fitsDecimals,
  levelsFor,
  type OpenRequisitionLine,
  type OpenRequisitionLineQuery,
  type Requisition,
  requisitionAmount,
  type RequisitionInput,
  type RequisitionLine,
  requisitionLineAmount,
  type RequisitionLineInput,
  type RequisitionOrderFilter,
  type RequisitionOrderState,
  type RequisitionStatus,
  type RequisitionSummary,
  shiftIsoDate,
  subtractQuantity,
  sumQuantity,
  toBaseQuantity,
  todayIn,
  unitCostOf,
  type WaitingApproval,
} from '@omnivo/contracts';

import { OWNER } from './fixtures';
import { MockProblem } from './mock';
import { newestFirst, seriesNumber } from './sales-document-data';
import type { MockBill, MockSupplierPayment } from './bill-data';
import type { MockGoodsReceipt, MockPurchaseOrder } from './purchase-order-data';
import { averageCostOf, decimalsOf, findVariant, issuesError, refOf } from './stock-data';
import type { WorkspaceData } from './workspace-data';

// The mock's step 17a approvals and requisitions: the API's rules (approvals.service.ts,
// requisitions.service.ts, cost-lookup.service.ts) on plain arrays, shortened. The handlers write
// the audit rows, with what these functions return.
//
// The mock always signs in as the Owner (fixtures.ts), and an Owner may decide any step and has
// their own documents approved when they submit them (decision 14). So in the mock a requisition
// written on the page is approved at once, and the waiting ones are the seed's, submitted by
// other members. The API's tests (17a.4) check the rules for everyone else: no self-approval, the
// step's role, and the bell for the next level.
//
// Step 17b: purchase orders are approved the same way, and order requisition lines. The orders and
// goods receipts live in purchase-order-data.ts, which imports this file; this one reads them
// through the WorkspaceData type only, like sales-document-data.ts reads the invoices.
//
// Step 17c: bills and supplier payments (bill-data.ts) too. They have no "approved" status: the
// last approval posts them (decision 7), with the poster bill-data.ts registers (onApproved()).

// The levels of one kind of document, with the role by id: its name is read from the roles on
// every read, like the API's join, so a renamed role shows its new name
export interface MockRule {
  levels: { minAmount: string; roleId: string }[];
  // 0 = never saved, like the API's missing row
  version: number;
  updatedAt: string | null;
}

// A round as the API's approval_rounds row, with its steps. A step keeps a copy of its role's name
// (role_name), so it still reads after the role is deleted. The kind is a string, like the
// contract's waiting item: 17b adds purchase orders.
export interface MockRound extends ApprovalRound {
  document: string;
  documentId: string;
}

// A requisition as stored. Its line count and approval history are worked out on read, and so are
// what purchase orders took of each line, its order state and its orders (step 17b, decision 26:
// counted, never stored), so an order saved a second ago shows on the requisition at once.
export type MockRequisitionLine = Omit<RequisitionLine, 'orderedQuantity'>;
export type MockRequisition = Omit<
  Requisition,
  'approval' | 'lineCount' | 'orderState' | 'orders' | 'lines'
> & { lines: MockRequisitionLine[] };

export interface MockPurchase {
  rules: Record<ApprovalDocument, MockRule>;
  rounds: MockRound[];
  // New ones first, like the API's uuidv7 order
  requisitions: MockRequisition[];
  // Step 17b, new ones first (purchase-order-data.ts)
  orders: MockPurchaseOrder[];
  receipts: MockGoodsReceipt[];
  // Step 17c, new ones first (bill-data.ts)
  bills: MockBill[];
  payments: MockSupplierPayment[];
  // The last number given from the 'purchase.requisition', 'purchase.order',
  // 'inventory.receipt', 'purchase.bill' and 'purchase.payment' series
  counters: { requisition: number; order: number; receipt: number; bill: number; payment: number };
}

export function emptyPurchase(): MockPurchase {
  const none = { levels: [], version: 0, updatedAt: null };
  return {
    rules: {
      requisition: { ...none },
      purchase_order: { ...none },
      bill: { ...none },
      supplier_payment: { ...none },
    },
    rounds: [],
    requisitions: [],
    orders: [],
    receipts: [],
    bills: [],
    payments: [],
    counters: { requisition: 0, order: 0, receipt: 0, bill: 0, payment: 0 },
  };
}

function now(): string {
  return new Date().toISOString();
}

const ME = { id: OWNER.id, name: OWNER.fullName };

function conflict(code: ErrorCode): MockProblem {
  return new MockProblem(409, code);
}

// --- Approval levels ----------------------------------------------------------------------------

export function toRule(data: WorkspaceData, document: ApprovalDocument): ApprovalRule {
  const rule = data.purchase.rules[document];
  return {
    document,
    levels: rule.levels.map((level) => {
      const role = data.people.roles.find((item) => item.id === level.roleId);
      return { minAmount: level.minAmount, role: { id: level.roleId, name: role?.name ?? '' } };
    }),
    version: rule.version,
    updatedAt: rule.updatedAt,
  };
}

// "Purchase manager from 20000.0000; Director from 100000.0000", like the API's audit row
export function describeLevels(rule: ApprovalRule): string | null {
  if (rule.levels.length === 0) return null;
  return rule.levels.map((level) => `${level.role.name} from ${level.minAmount}`).join('; ');
}

// The levels sent replace the old ones. Documents already waiting keep the levels they were
// submitted with (decision 13): their steps are copies.
export function saveRule(
  data: WorkspaceData,
  document: ApprovalDocument,
  input: ApprovalRuleInput,
): ApprovalRule {
  const rule = data.purchase.rules[document];
  if (rule.version !== input.version) throw conflict('version_conflict');
  const unknown = input.levels.flatMap((level, index) =>
    data.people.roles.some((role) => role.id === level.roleId) ? [] : [index],
  );
  if (unknown.length > 0) {
    throw new MockProblem(
      409,
      'approval_role_invalid',
      Object.fromEntries(
        unknown.map((index) => [`levels.${String(index)}.roleId`, ['approval_role_invalid']]),
      ),
    );
  }
  data.purchase.rules[document] = {
    // "20000" → "20000.0000": the way Postgres sends NUMERIC(19,4)
    levels: input.levels.map((level) => ({
      minAmount: addMoney(level.minAmount, '0'),
      roleId: level.roleId,
    })),
    version: rule.version + 1,
    updatedAt: now(),
  };
  return toRule(data, document);
}

// A role that a level names, or that a waiting round still needs, cannot be deleted (the API's
// roles.service.ts: approval_levels_role_fk and the waiting-step count)
export function approvalsNeedRole(data: WorkspaceData, roleId: string): boolean {
  return (
    Object.values(data.purchase.rules).some((rule) =>
      rule.levels.some((level) => level.roleId === roleId),
    ) ||
    data.purchase.rounds.some(
      (round) =>
        round.status === 'pending' &&
        round.steps.some((step) => step.decision === null && step.role.id === roleId),
    )
  );
}

// After a role is deleted: the decided steps keep its name and lose its id (ON DELETE SET NULL)
export function forgetRole(data: WorkspaceData, roleId: string): void {
  for (const round of data.purchase.rounds) {
    for (const step of round.steps) {
      if (step.role.id === roleId) step.role = { id: null, name: step.role.name };
    }
  }
}

// --- A document's rounds ------------------------------------------------------------------------

function roundsOf(data: WorkspaceData, document: ApprovalDocument, id: string): MockRound[] {
  return data.purchase.rounds
    .filter((round) => round.document === document && round.documentId === id)
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

function toRound(round: MockRound): ApprovalRound {
  return {
    id: round.id,
    status: round.status,
    amount: round.amount,
    submittedBy: round.submittedBy,
    submittedAt: round.submittedAt,
    closedAt: round.closedAt,
    steps: round.steps.map((step) => ({ ...step })),
  };
}

// Every round, newest first. The Owner may decide any waiting step, so canDecide is "a step waits".
export function historyOf(
  data: WorkspaceData,
  document: ApprovalDocument,
  id: string,
): DocumentApproval {
  const rounds = roundsOf(data, document, id).map(toRound);
  const [newest] = rounds;
  const canDecide =
    newest?.status === 'pending' && newest.steps.some((step) => step.decision === null);
  return { rounds, canDecide };
}

// A new round with the levels the amount reaches (decision 13). The signed-in Owner's steps are
// written already approved, by the Owner, so the history says so; with no level the round has no
// step. Either way it is approved at once, and the document passes through pending. Returns how
// many steps it has. `amount` chooses the levels: a requisition's estimate, an order's total with
// VAT (step 17b, decision 14).
export function submitRound(
  data: WorkspaceData,
  document: ApprovalDocument,
  target: { id: string; amount: string },
): number {
  const at = now();
  const steps = levelsFor(toRule(data, document).levels, target.amount).map(
    (level, index): ApprovalStep => ({
      position: index + 1,
      minAmount: level.minAmount,
      role: level.role,
      decision: 'approved',
      decidedBy: ME,
      decidedAt: at,
      comment: null,
    }),
  );
  data.purchase.rounds.push({
    id: crypto.randomUUID(),
    document,
    documentId: target.id,
    status: 'approved',
    amount: target.amount,
    submittedBy: ME,
    submittedAt: at,
    closedAt: at,
    steps,
  });
  return steps.length;
}

// Approve or reject the step a document waits for. roundId is the round the page showed
// (decision 16): reopened or decided since, the answer is approval_not_pending. Returns the step
// decided and how many the round has.
export function decide(
  data: WorkspaceData,
  document: ApprovalDocument,
  id: string,
  decision: ApprovalDecision,
  input: { roundId: string; comment: string | null },
): { step: ApprovalStep; count: number } {
  const target = approvalTarget(data, document, id);
  const round = data.purchase.rounds.find(
    (item) => item.id === input.roundId && item.document === document && item.documentId === id,
  );
  const step = round?.steps.find((item) => item.decision === null);
  if (round?.status !== 'pending' || !step) throw conflict('approval_not_pending');
  const at = now();
  Object.assign(step, { decision, decidedBy: ME, decidedAt: at, comment: input.comment });
  const decided = { step, count: round.steps.length };
  // A step in the middle leaves the round waiting for the next level
  if (decision === 'approved' && round.steps.some((item) => item.decision === null)) {
    return decided;
  }
  Object.assign(round, { status: decision, closedAt: at });
  if (!target.posts) {
    setStatus(target.document, decision === 'approved' ? 'approved' : 'draft');
  } else if (decision === 'rejected') {
    backToDraft(target.document);
  } else {
    postApproved(data, document, id);
  }
  return decided;
}

// The document an approval decides. A requisition or a purchase order (step 17b) moves draft →
// pending → approved, or back to draft, with setStatus(). A bill or a supplier payment (step 17c)
// is posted by its last approval instead (`posts`), or goes back to draft.
type ApprovalTarget =
  | { posts: false; document: MockRequisition | MockPurchaseOrder }
  | { posts: true; document: MockBill | MockSupplierPayment };

function approvalTarget(
  data: WorkspaceData,
  document: ApprovalDocument,
  id: string,
): ApprovalTarget {
  const found = {
    requisition: () => data.purchase.requisitions.find((item) => item.id === id),
    purchase_order: () => data.purchase.orders.find((item) => item.id === id),
    bill: () => data.purchase.bills.find((item) => item.id === id),
    supplier_payment: () => data.purchase.payments.find((item) => item.id === id),
  };
  if (document === 'bill' || document === 'supplier_payment') {
    const target = found[document]();
    if (!target) throw new MockProblem(404, 'not_found');
    return { posts: true, document: target };
  }
  const target = found[document]();
  if (!target) throw new MockProblem(404, 'not_found');
  return { posts: false, document: target };
}

// What posts a bill or a payment when its last approval is given (decision 7). bill-data.ts
// registers them when it loads, like the API's services call approvals.onApproved() in their
// constructors: this file cannot import bill-data.ts, which imports it.
type Poster = (data: WorkspaceData, id: string) => void;
const posters = new Map<ApprovalDocument, Poster>();

export function onApproved(document: ApprovalDocument, post: Poster): void {
  posters.set(document, post);
}

// The poster's error is the approval's: the handler runs decide() in a transaction(), so a bill
// in a closed period leaves its round waiting, like the API's (decision 36)
function postApproved(data: WorkspaceData, document: ApprovalDocument, id: string): void {
  const post = posters.get(document);
  if (!post) throw new Error(`Nothing posts a ${document} on approval`);
  post(data, id);
}

// A rejected bill or payment goes back to draft, with a new version. Its number stays.
function backToDraft(target: MockBill | MockSupplierPayment): void {
  Object.assign(target, { status: 'draft', version: target.version + 1, updatedAt: now() });
}

// What a waiting item says about its document: a requisition by its warehouse; an order, a bill
// or a payment by its supplier (17b.3 decision 34, 17c). null: the document is gone, or has no
// number yet (submitting numbers it, so a document that waits always has one).
function waitingSubject(
  data: WorkspaceData,
  round: MockRound,
): { number: string; date: string; subject: string } | null {
  if (round.document === 'requisition') {
    const found = data.purchase.requisitions.find((item) => item.id === round.documentId);
    return found
      ? { number: found.number, date: found.date, subject: warehouseName(data, found.warehouseId) }
      : null;
  }
  const { orders, bills, payments } = data.purchase;
  const found = [...orders, ...bills, ...payments].find((item) => item.id === round.documentId);
  return found?.number
    ? { number: found.number, date: found.date, subject: found.supplier.name }
    : null;
}

// Ends the round a pending document waits on, as reopened: the step nobody decided stays "Not
// decided". An approved document keeps its approved round (decision 6).
export function endPendingRound(data: WorkspaceData, document: ApprovalDocument, id: string): void {
  const round = roundsOf(data, document, id).find((item) => item.status === 'pending');
  if (round) Object.assign(round, { status: 'reopened', closedAt: now() });
}

// The documents whose waiting step the reader may decide, oldest first. The Owner may decide every
// one, so that is every pending round.
export function waitingList(data: WorkspaceData): WaitingApproval[] {
  return data.purchase.rounds
    .filter((round) => round.status === 'pending')
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
    .flatMap((round): WaitingApproval[] => {
      const step = round.steps.find((item) => item.decision === null);
      const about = waitingSubject(data, round);
      if (!step || !about) return [];
      return [
        {
          document: round.document,
          id: round.documentId,
          ...about,
          amount: round.amount,
          submittedBy: round.submittedBy,
          submittedAt: round.submittedAt,
          roundId: round.id,
          position: step.position,
          stepCount: round.steps.length,
        },
      ];
    });
}

// --- Requisitions -------------------------------------------------------------------------------

function warehouseName(data: WorkspaceData, id: string): string {
  return data.stock.warehouses.find((item) => item.id === id)?.name ?? id;
}

export function findRequisition(data: WorkspaceData, id: string): MockRequisition {
  const found = data.purchase.requisitions.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// --- What purchase orders took of a requisition (step 17b) --------------------------------------

// The orders that are not cancelled, with each line that buys for a requisition line
function linkedOrderLines(data: WorkspaceData) {
  return data.purchase.orders
    .filter((order) => order.status !== 'cancelled')
    .flatMap((order) =>
      order.lines.flatMap((line) =>
        line.requisitionLine === null ? [] : [{ order, line, link: line.requisitionLine }],
      ),
    );
}

// How much of a requisition line orders took, in the base unit (the API's orderedOf()): all of an
// order line while the order is open or received, only what came in once it is closed (the rest
// is still wanted). A service is never received, so a closed order counts it in full.
function orderedOf(data: WorkspaceData, lineId: string): string {
  return sumQuantity(
    linkedOrderLines(data)
      .filter((item) => item.link.id === lineId)
      .map(({ order, line }) =>
        order.status === 'closed' && line.productType === 'goods'
          ? line.receivedQuantity
          : line.baseQuantity,
      ),
  );
}

function withOrdered(data: WorkspaceData, line: MockRequisitionLine): RequisitionLine {
  return { ...line, orderedQuantity: orderedOf(data, line.id) };
}

// Only an approved or closed requisition is ordered from: a draft's lines are not settled yet
function orderStateOf(data: WorkspaceData, stored: MockRequisition): RequisitionOrderState {
  if (stored.status !== 'approved' && stored.status !== 'closed') return 'not_ordered';
  const lines = stored.lines.map((line) => withOrdered(data, line));
  if (!lines.some((line) => compareQuantity(line.orderedQuantity, '0') > 0)) return 'not_ordered';
  return lines.some((line) => compareQuantity(line.orderedQuantity, line.baseQuantity) < 0)
    ? 'partly_ordered'
    : 'ordered';
}

// An order that is not cancelled buys for one of its lines, a draft order too (decision 27): the
// API's requisition_is_ordered()
function isOrdered(data: WorkspaceData, requisitionId: string): boolean {
  return linkedOrderLines(data).some((item) => item.link.requisitionId === requisitionId);
}

// The orders that buy for it, by number (null for a draft never submitted), oldest first
function ordersOf(data: WorkspaceData, requisitionId: string): DocumentRef[] {
  const seen = new Map<string, DocumentRef>();
  for (const { order, link } of linkedOrderLines(data).toReversed()) {
    if (link.requisitionId === requisitionId)
      seen.set(order.id, { id: order.id, number: order.number });
  }
  return [...seen.values()];
}

// --- Requisitions, read -------------------------------------------------------------------------

export function requisitionSummaryOf(
  data: WorkspaceData,
  stored: MockRequisition,
): RequisitionSummary {
  return {
    id: stored.id,
    number: stored.number,
    date: stored.date,
    neededBy: stored.neededBy,
    warehouseId: stored.warehouseId,
    status: stored.status,
    orderState: orderStateOf(data, stored),
    amount: stored.amount,
    lineCount: stored.lines.length,
    requestedBy: stored.requestedBy,
    version: stored.version,
    updatedAt: stored.updatedAt,
  };
}

export function toRequisition(data: WorkspaceData, stored: MockRequisition): Requisition {
  return {
    ...stored,
    lines: stored.lines.map((line) => withOrdered(data, line)),
    lineCount: stored.lines.length,
    orderState: orderStateOf(data, stored),
    approval: historyOf(data, 'requisition', stored.id),
    orders: ordersOf(data, stored.id),
  };
}

// Newest date first, like the API; the filters are the list's own. to_order (step 17b): approved,
// with a line still to order.
export function listRequisitions(
  data: WorkspaceData,
  query: {
    status?: RequisitionStatus | undefined;
    warehouseId?: string | undefined;
    order?: RequisitionOrderFilter | undefined;
  },
): MockRequisition[] {
  return newestFirst(
    data.purchase.requisitions.filter(
      (item) =>
        (query.status === undefined || item.status === query.status) &&
        (query.warehouseId === undefined || item.warehouseId === query.warehouseId) &&
        (query.order === undefined ||
          (item.status === 'approved' &&
            item.lines.some(
              (line) => compareQuantity(orderedOf(data, line.id), line.baseQuantity) < 0,
            ))),
    ),
  );
}

// The lines a purchase order for this warehouse may buy for (step 17b, decision 18): lines of
// approved requisitions with something still to order, oldest requisition first. A closed
// requisition is left out: its rest will not be bought. The search looks at the requisition's
// number and the item's name, code and SKU, like the API's.
export function openLines(
  data: WorkspaceData,
  query: Omit<OpenRequisitionLineQuery, 'limit' | 'cursor'>,
): OpenRequisitionLine[] {
  const search = query.search?.trim().toLowerCase() ?? '';
  return data.purchase.requisitions
    .filter(
      (item) =>
        item.status === 'approved' &&
        item.warehouseId === query.warehouseId &&
        (query.requisitionId === undefined || item.id === query.requisitionId),
    )
    .toSorted((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number))
    .flatMap((requisition) =>
      requisition.lines.flatMap((stored): OpenRequisitionLine[] => {
        const line = withOrdered(data, stored);
        const remainingQuantity = subtractQuantity(line.baseQuantity, line.orderedQuantity);
        if (compareQuantity(remainingQuantity, '0') <= 0) return [];
        const matches =
          search === '' ||
          [requisition.number, line.productName, line.productCode, line.sku].some((text) =>
            text.toLowerCase().includes(search),
          );
        if (!matches) return [];
        const { id, number, date, neededBy } = requisition;
        return [{ ...line, requisition: { id, number, date, neededBy }, remainingQuantity }];
      }),
    );
}

// The API's resolvePurchaseItems(): an active product or service, a unit that is its base unit or
// one of its packs, and a quantity that fits the unit. Every problem comes back at once.
function resolveLines(
  data: WorkspaceData,
  lines: readonly RequisitionLineInput[],
): MockRequisitionLine[] {
  const issues: { path: string; code: ErrorCode }[] = [];
  const resolved = lines.flatMap((input, index): MockRequisitionLine[] => {
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: `lines.${String(index)}.${field}`, code });
    };
    const found = findVariant(data, input.variantId);
    // Unknown, or its product or variant archived
    if (found?.product.archivedAt !== null || found.variant.archivedAt !== null) {
      at('variantId', 'purchase_item_invalid');
      return [];
    }
    const { product, variant } = found;
    const factor =
      input.unitId === product.baseUnitId
        ? '1'
        : product.units.find((pack) => pack.unitId === input.unitId)?.factor;
    if (factor === undefined) {
      at('unitId', 'stock_unit_invalid');
      return [];
    }
    if (!fitsDecimals(input.quantity, decimalsOf(data, input.unitId))) {
      at('quantity', 'stock_quantity_decimals');
      return [];
    }
    const ref = refOf(product, variant);
    return [
      {
        ...ref,
        id: crypto.randomUUID(),
        productType: product.type,
        units: product.units.map((pack) => ({ unitId: pack.unitId, factor: pack.factor })),
        unitId: input.unitId,
        // "2" → "2.0000": the way Postgres sends NUMERIC(19,4)
        quantity: addQuantity(input.quantity, '0'),
        baseQuantity: toBaseQuantity(input.quantity, factor, decimalsOf(data, product.baseUnitId)),
        description: input.description ?? defaultLineDescription(ref),
        estimatedCost: addMoney(input.estimatedCost, '0'),
        amount: requisitionLineAmount(input.quantity, input.estimatedCost),
      },
    ];
  });
  if (issues.length > 0) throw issuesError(issues);
  return resolved;
}

// An active warehouse; a draft keeps the one it has even after it is archived (keptId). Step 17b's
// purchase orders check theirs the same way.
export function assertWarehouse(
  data: WorkspaceData,
  warehouseId: string,
  keptId: string | null,
): void {
  const found = data.stock.warehouses.find((item) => item.id === warehouseId);
  if (!found || (found.archivedAt !== null && found.id !== keptId)) {
    throw new MockProblem(409, 'purchase_warehouse_invalid', {
      warehouseId: ['purchase_warehouse_invalid'],
    });
  }
}

// Create (no `existing`, numbered at once: decision 19) or change a draft
export function saveRequisition(
  data: WorkspaceData,
  input: RequisitionInput,
  existing?: MockRequisition,
): MockRequisition {
  if (existing && existing.status !== 'draft') throw conflict('purchase_not_draft');
  assertWarehouse(data, input.warehouseId, existing?.warehouseId ?? null);
  const lines = resolveLines(data, input.lines);
  const fields = {
    date: input.date,
    neededBy: input.neededBy,
    warehouseId: input.warehouseId,
    note: input.note,
    lines,
    amount: requisitionAmount(lines),
    updatedAt: now(),
  };
  if (existing) {
    Object.assign(existing, fields, { version: existing.version + 1 });
    return existing;
  }
  data.purchase.counters.requisition += 1;
  const created: MockRequisition = {
    ...fields,
    id: crypto.randomUUID(),
    number: seriesNumber(
      data,
      'purchase.requisition',
      data.purchase.counters.requisition,
      input.date,
    ),
    status: 'draft',
    requestedBy: ME,
    version: 1,
  };
  data.purchase.requisitions.unshift(created);
  return created;
}

// A requisition's or an order's status, with a new version: a page open somewhere must reload
function setStatus(
  target: MockRequisition | MockPurchaseOrder,
  status: RequisitionStatus & MockPurchaseOrder['status'],
): void {
  Object.assign(target, { status, version: target.version + 1, updatedAt: now() });
}

// Only a draft that was never submitted: approval history is never deleted (decision 25)
export function removeRequisition(data: WorkspaceData, target: MockRequisition): void {
  if (target.status !== 'draft' || roundsOf(data, 'requisition', target.id).length > 0) {
    throw conflict('purchase_was_submitted');
  }
  data.purchase.requisitions = data.purchase.requisitions.filter((item) => item.id !== target.id);
}

// Returns how many steps its round has
export function submitRequisition(data: WorkspaceData, target: MockRequisition): number {
  if (target.status !== 'draft') throw conflict('purchase_not_draft');
  const steps = submitRound(data, 'requisition', target);
  setStatus(target, 'approved');
  return steps;
}

// Pending: the round ends as reopened. Approved: the round stays approved (it was), and the next
// submit starts a new round from the first level (decision 6). Step 17b: not once an order buys for
// it, even a draft one (decision 27): the order's lines would lose their link.
export function reopenRequisition(data: WorkspaceData, target: MockRequisition): void {
  if (target.status !== 'pending' && target.status !== 'approved') {
    throw conflict('purchase_cannot_reopen');
  }
  if (target.status === 'approved' && isOrdered(data, target.id)) {
    throw conflict('purchase_close_instead');
  }
  if (target.status === 'pending') endPendingRound(data, 'requisition', target.id);
  setStatus(target, 'draft');
}

// Step 17b: once an order buys for it, some of it is being bought, so it is closed instead
export function cancelRequisition(data: WorkspaceData, target: MockRequisition): void {
  if (target.status !== 'draft' && target.status !== 'approved') {
    throw conflict('purchase_cannot_cancel');
  }
  if (target.status === 'approved' && isOrdered(data, target.id)) {
    throw conflict('purchase_close_instead');
  }
  setStatus(target, 'cancelled');
}

// Step 17b (decision 17): partly ordered, and the rest will not be. The orders already written go
// on. Closed is final.
export function closeRequisition(data: WorkspaceData, target: MockRequisition): void {
  if (target.status !== 'approved') throw conflict('purchase_not_approved');
  if (!isOrdered(data, target.id)) throw conflict('purchase_cancel_instead');
  setStatus(target, 'closed');
}

// --- The cost a line starts with ----------------------------------------------------------------

// The price of the latest approved order line for the variant, per one of the unit (step 17b,
// decision 19): the line's net (after its discount, before VAT) × the unit's factor ÷ its base
// quantity, to the 4 decimals a cost keeps. Approved, received and closed orders count: a draft or
// a pending order is not a price anybody agreed to. supplierId: only that supplier's orders.
// Step 17c (decision 25): a posted bill's line counts too, whichever is newer: a bill dated after
// its order says what the supplier really charged.
// The newest date first; a new document is put first in its array, and the bills go before the
// orders (a bill is written after its order), so on one date the newer one wins, like the API's
// created_at.
function lastPrice(
  data: WorkspaceData,
  variantId: string,
  factor: string,
  supplierId: string | null,
): string | null {
  const ofSupplier = (document: { supplier: { id: string } }) =>
    supplierId === null || document.supplier.id === supplierId;
  const agreed = [
    ...data.purchase.bills.filter((bill) => bill.status === 'posted' && ofSupplier(bill)),
    ...data.purchase.orders.filter(
      (order) => ['approved', 'received', 'closed'].includes(order.status) && ofSupplier(order),
    ),
  ];
  const [latest] = newestFirst(agreed).flatMap((document) =>
    document.lines.filter((line) => line.variantId === variantId),
  );
  // × the factor first, then ÷ the base quantity: one rounding at the end, like the API's NUMERIC
  return latest ? unitCostOf(toBaseQuantity(latest.net, factor, 4), latest.baseQuantity) : null;
}

// The API's CostLookupService: this supplier's last price, else anyone's last price (step 17b),
// else the variant's company-wide average cost (step 14) × the unit's factor; none for an item
// never bought. And the VAT rate an order line starts with: the product's own active rate, else the
// workspace default (step 17b). A unit that is not this product's drops out, like an unknown
// variant.
export function lookupCosts(data: WorkspaceData, input: CostLookupInput): CostLookup {
  const fallbackRate = data.sales.taxRates.find((rate) => rate.isDefault);
  return {
    items: input.items.flatMap((item): CostLookupItem[] => {
      const found = findVariant(data, item.variantId);
      if (!found) return [];
      const { product } = found;
      const factor =
        item.unitId === product.baseUnitId
          ? '1'
          : product.units.find((pack) => pack.unitId === item.unitId)?.factor;
      if (factor === undefined) return [];
      const rate =
        data.sales.taxRates.find(
          (row) => row.id === product.taxRateId && row.archivedAt === null,
        ) ?? fallbackRate;
      if (!rate) return [];
      const average = averageCostOf(data.stock, item.variantId);
      const sources: [string, string | null][] = [
        [
          'supplier_price',
          input.supplierId === null
            ? null
            : lastPrice(data, item.variantId, factor, input.supplierId),
        ],
        ['last_price', lastPrice(data, item.variantId, factor, null)],
        ['average_cost', average === null ? null : toBaseQuantity(average, factor, 4)],
      ];
      const [source, cost] = sources.find(([, value]) => value !== null) ?? [null, null];
      return [{ variantId: item.variantId, unitId: item.unitId, cost, source, taxRateId: rate.id }];
    }),
  };
}

// --- Seed ---------------------------------------------------------------------------------------

// The garments workspace's purchase desk (after the stock: the lines use its products and
// warehouses, and their costs its averages). Requisitions from ৳20,000 go to a purchase manager,
// from ৳1,00,000 to a director as well. Kamal is the purchase manager; nobody holds the Director
// role yet, so the bell for that level rings the Owner (decision 28). Sadia, a merchandiser, wrote
// three requisitions:
//   0001 two sewing machines (৳1,37,000): Kamal sent it back, so it is a draft again
//   0002 mailer bags (৳65,000): approved by Kamal
//   0003 jersey and buttons for an H&M order (৳2,11,240): Kamal approved step 1, and step 2
//        (Director) waits, for the Owner
// and the owner's own 0004 is a draft for buttons (৳1,944), below every level.
export function seedPurchase(data: WorkspaceData, garments: boolean): void {
  if (!garments) return;
  const role = (name: string) => data.people.roles.find((item) => item.name === name);
  const person = (name: string) => {
    const found = data.people.members.find((member) => member.fullName === name);
    if (!found) throw new Error(`The mock has no member ${name}`);
    return { id: found.userId, name: found.fullName };
  };
  const manager = role('Purchase manager');
  const director = role('Director');
  const [main] = data.stock.warehouses;
  if (!manager || !director || !main) return;
  const managerLevel = { minAmount: '20000.0000', roleId: manager.id };
  const directorLevel = { minAmount: '100000.0000', roleId: director.id };
  data.purchase.rules.requisition = {
    levels: [managerLevel, directorLevel],
    version: 1,
    updatedAt: now(),
  };
  // Step 17b: orders are approved by their total with VAT, from ৳50,000 by the purchase manager,
  // from ৳5,00,000 by a director as well (purchase-order-data.ts seeds the orders)
  data.purchase.rules.purchase_order = {
    levels: [
      { minAmount: '50000.0000', roleId: manager.id },
      { minAmount: '500000.0000', roleId: director.id },
    ],
    version: 1,
    updatedAt: now(),
  };
  // Step 17c: bills by their total with VAT from ৳1,00,000 by the purchase manager, who knows what
  // was ordered; payments by their amount from ৳2,00,000 by a director, who signs the cheques
  // (bill-data.ts seeds one bill waiting for Kamal)
  data.purchase.rules.bill = {
    levels: [{ minAmount: '100000.0000', roleId: manager.id }],
    version: 1,
    updatedAt: now(),
  };
  data.purchase.rules.supplier_payment = {
    levels: [{ minAmount: '200000.0000', roleId: director.id }],
    version: 1,
    updatedAt: now(),
  };

  const today = todayIn(data.settings.timezone);
  const sadia = person('Sadia Islam');
  const kamal = person('Kamal Uddin');
  // At ten in the morning (or the hour given), some days ago
  const daysAgo = (days: number, hour = 10) => {
    const moment = new Date(Date.now() - days * 86_400_000);
    moment.setHours(hour, 0, 0, 0);
    return moment.toISOString();
  };
  // A line of the product's first variant, in a unit by its code, at a cost per that unit
  const line = (code: string, unitCode: string, quantity: string, estimatedCost: string) => {
    const product = data.catalog.products.find((item) => item.code === code);
    const unit = data.catalog.units.find((item) => item.code === unitCode);
    const variant = product?.variants[0];
    if (!variant || !unit) throw new Error(`The mock catalog has no ${code} in ${unitCode}`);
    return { variantId: variant.id, unitId: unit.id, quantity, description: null, estimatedCost };
  };
  // A requisition Sadia wrote, `days` ago, in the Main store
  const write = (days: number, note: string | null, lines: RequisitionLineInput[]) => {
    const saved = saveRequisition(data, {
      date: shiftIsoDate(today, -days),
      neededBy: shiftIsoDate(today, 14),
      warehouseId: main.id,
      note,
      lines,
    });
    saved.requestedBy = sadia;
    return saved;
  };
  type Decided = Pick<ApprovalStep, 'decision' | 'decidedAt' | 'comment'>;
  const step = (
    position: number,
    level: { minAmount: string; roleId: string },
    name: string,
    decided: Decided = { decision: null, decidedAt: null, comment: null },
  ): ApprovalStep => ({
    position,
    minAmount: level.minAmount,
    role: { id: level.roleId, name },
    ...decided,
    decidedBy: decided.decision === null ? null : kamal,
  });
  // Sadia's round for the requisition, which then has the round's status
  const round = (
    target: MockRequisition,
    status: MockRound['status'],
    submittedAt: string,
    steps: ApprovalStep[],
  ) => {
    const closedAt = status === 'pending' ? null : (steps.at(-1)?.decidedAt ?? submittedAt);
    data.purchase.rounds.push({
      id: crypto.randomUUID(),
      document: 'requisition',
      documentId: target.id,
      status,
      amount: target.amount,
      submittedBy: sadia,
      submittedAt,
      closedAt,
      steps,
    });
    target.status =
      status === 'rejected' ? 'draft' : status === 'approved' ? 'approved' : 'pending';
  };

  // The oldest first: the numbers run by date
  const machines = write(5, 'Two machines for the new sewing line in Gazipur.', [
    line('P-00005', 'pcs', '2', '68500'),
  ]);
  round(machines, 'rejected', daysAgo(4), [
    step(1, managerLevel, manager.name, {
      decision: 'rejected',
      decidedAt: daysAgo(3, 15),
      comment: 'Buy one machine now, not two: the second line starts in January.',
    }),
    // The round ended before it: "Not decided"
    step(2, directorLevel, director.name),
  ]);
  const mailers = write(4, null, [line('P-00004', 'carton', '20', '3250')]);
  round(mailers, 'approved', daysAgo(4, 11), [
    step(1, managerLevel, manager.name, {
      decision: 'approved',
      decidedAt: daysAgo(3, 9),
      comment: null,
    }),
  ]);
  const jersey = write(
    2,
    'For buyer PO-HM-2026-1187: 2,000 polo shirts in navy. Cutting starts in two weeks.',
    [line('P-00002', 'm', '400', '520'), line('P-00003', 'gross', '50', '64.80')],
  );
  // Three hours ago: the bell's newest unread notifications stay the seed's own (workspace-data.ts)
  const kamalApproved = new Date(Date.now() - 3 * 3_600_000).toISOString();
  round(jersey, 'pending', daysAgo(2, 9), [
    step(1, managerLevel, manager.name, {
      decision: 'approved',
      decidedAt: kamalApproved,
      comment: 'Fine for the November production plan',
    }),
    step(2, directorLevel, director.name),
  ]);
  // The owner's own, never submitted
  saveRequisition(data, {
    date: today,
    neededBy: null,
    warehouseId: main.id,
    note: null,
    lines: [line('P-00003', 'gross', '30', '64.80')],
  });

  // Kamal's approval rang the next level: nobody holds Director, so the Owners
  data.notifications.push({
    id: crypto.randomUUID(),
    type: 'approval.requested',
    params: { document: 'requisition', id: jersey.id, number: jersey.number },
    readAt: null,
    createdAt: kamalApproved,
  });
  data.notifications.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
