import {
  type Account,
  accountTypeFits,
  addQuantity,
  APPROVAL_DOCUMENTS,
  type AuthSession,
  compareQuantity,
  type ErrorCode,
  type Preferences,
  type ProductCategory,
  routes,
  type Settings,
  STOCK_ACCOUNT_USES,
} from '@omnivo/contracts';
import { delay, http, HttpResponse, type HttpResponseResolver } from 'msw';

import { API_URL } from '../lib/api';
import { meIn, OWNER, WORKSPACES, type Workspace } from './fixtures';
import {
  allocateReceipt,
  assertNotVoided,
  confirmWithCredit,
  createReceipt,
  creditOf,
  findInvoice,
  findReceipt,
  listInvoices,
  listReceipts,
  type MockInvoice,
  postInvoice,
  removeInvoice,
  saveInvoice,
  toInvoice,
  toReceipt,
  voidReceipt,
} from './invoice-data';
import {
  createShare,
  emailDraft,
  findFile,
  publicDocument,
  requestFile,
  revokeShare,
  sendEmail,
  settleDocumentOutput,
  toDocumentEmail,
  toDocumentFile,
  toDocumentShare,
} from './document-output-data';
import { mock, MockProblem, problem, readBody, readQuery, reply } from './mock';
import {
  allocateCreditNote,
  assertCreditNotePosted,
  assertRefundNotVoided,
  createRefund,
  findCreditNote,
  findRefund,
  findReturn,
  listCreditNotes,
  listRefunds,
  listReturns,
  type MockCreditNote,
  type MockSalesReturn,
  postCreditNote,
  postReturn,
  removeCreditNote,
  removeReturn,
  saveCreditNote,
  saveReturn,
  toCreditNote,
  toReturn,
  voidRefund,
} from './return-data';
import {
  assertCanChange,
  assertRoleNameFree,
  demoPreview,
  expiry,
  findMember,
  findRole,
  isOpen,
  MOCK_SEND_DELAY_MS,
  newToken,
  roleList,
  toInvitation,
  toRole,
} from './people-data';
import {
  assertAccountCodeFree,
  assertNotLocked,
  codeOf,
  findAccount,
  parentFor,
} from './accounting-data';
import {
  allocatePayment,
  cancelBill,
  cancelPayment,
  findBill,
  findPayment,
  listBills,
  listPayments,
  type MockBill,
  type MockSupplierPayment,
  paymentSummaryOf,
  postBill,
  postPayment,
  removeBill,
  removePayment,
  reopenBill,
  reopenPayment,
  saveBill,
  savePayment,
  submitBill,
  submitPayment,
  toBill,
  toSupplierPayment,
  voidPayment,
} from './bill-data';
import {
  checkLines,
  findEntry,
  ledgerOf,
  openingOf,
  postDraft,
  postNew,
  replaceDraft,
  reverseEntry,
  saveOpening,
  setLockDate,
  sortedEntries,
  statementOf,
  summaryOf,
  writeDraft,
} from './journal-data';
import {
  balanceSheetOf,
  closeYear,
  createExport,
  exportUrl,
  fiscalYearsOf,
  profitAndLossOf,
  reopenYear,
  settleExports,
  toExport,
  trialBalanceOf,
} from './report-data';
import {
  findProduct,
  IMPORT_DELAY_MS,
  listProducts,
  type MockImport,
  saveProduct,
  settleImports,
  productSummaryOf,
  toImport,
} from './product-data';
import {
  cancelPurchaseOrder,
  closePurchaseOrder,
  findGoodsReceipt,
  findPurchaseOrder,
  listGoodsReceipts,
  listPurchaseOrders,
  postGoodsReceipt,
  purchaseOrderSummaryOf,
  removeGoodsReceipt,
  removePurchaseOrder,
  reopenPurchaseOrder,
  saveGoodsReceipt,
  savePurchaseOrder,
  submitPurchaseOrder,
  toGoodsReceipt,
  toPurchaseOrder,
} from './purchase-order-data';
import {
  allocateDebitNote,
  assertDebitNotePosted,
  assertSupplierRefundNotVoided,
  createSupplierRefund,
  findDebitNote,
  findPurchaseReturn,
  findSupplierRefund,
  listDebitNotes,
  listPurchaseReturns,
  listSupplierRefunds,
  type MockDebitNote,
  type MockPurchaseReturn,
  postDebitNote,
  postPurchaseReturn,
  removeDebitNote,
  removePurchaseReturn,
  saveDebitNote,
  savePurchaseReturn,
  toDebitNote,
  toPurchaseReturn,
  voidSupplierRefund,
} from './purchase-return-data';
import {
  assertCustomerUnused,
  assertGroupNameFree,
  assertPriceListNameFree,
  assertProductTaxRate,
  balanceOf,
  createTaxRate,
  customerSummaryOf,
  dropStalePrices,
  findCustomer,
  findGroup,
  findPriceList,
  findTaxRate,
  listCustomers,
  priceItemsOf,
  refreshPartyRefs,
  saveCustomer,
  setPriceItems,
  setTaxRateArchived,
  sortedTaxRates,
  toCustomer,
  toGroup,
  toPriceList,
  updateTaxRate,
} from './sales-data';
import {
  answerQuotation,
  changeOrderStatus,
  createOrder,
  findDelivery,
  findOrder,
  findQuotation,
  listDeliveries,
  listOrders,
  listQuotations,
  lookupPrices,
  type MockOrder,
  pageOf,
  postDelivery,
  removeDelivery,
  removeOrder,
  removeQuotation,
  saveDelivery,
  saveQuotation,
  toDelivery,
  toOrder,
  toQuotation,
  updateOrder,
} from './sales-document-data';
import {
  approvalsNeedRole,
  cancelRequisition,
  closeRequisition,
  decide,
  describeLevels,
  findRequisition,
  forgetRole,
  listRequisitions,
  lookupCosts,
  onApproved,
  openLines,
  removeRequisition,
  reopenRequisition,
  requisitionSummaryOf,
  saveRequisition,
  saveRule,
  submitRequisition,
  toRequisition,
  toRule,
  waitingList,
} from './requisition-data';
import { settleSetup, startSetup } from './setup-data';
import {
  batchReport,
  cardOf,
  findAdjustment,
  findRevaluation,
  findTransfer,
  listStock,
  movementsOf,
  postAdjustment,
  receiveTransfer,
  reorderReport,
  revalue,
  saveAdjustment,
  saveTransfer,
  sendTransfer,
  setLevel,
  valuationList,
  valuationSummary,
  warehouse as newWarehouse,
} from './stock-data';
import {
  assertSupplierGroupNameFree,
  copyToCustomer,
  copyToSupplier,
  findSupplier,
  findSupplierGroup,
  listSuppliers,
  makeCustomer,
  makeSupplier,
  removeSupplier,
  saveSupplier,
  supplierSummaryOf,
  toSupplier,
  toSupplierGroup,
} from './supplier-data';
import { push } from './push-data';
import { pull, registerDevice } from './sync-data';
import {
  assertCodeFree,
  checkVersion,
  dataOf,
  diff,
  findBranch,
  record,
  seriesList,
  startFresh,
  transaction,
  type WorkspaceData,
} from './workspace-data';

// mock সার্ভারের অবস্থা — শুধু এই ট্যাবের memory-তে, reload করলে আবার শুরু থেকে
let signedIn = true;
let workspace: Workspace = WORKSPACES[0];
let preferences: Preferences = { language: null, theme: 'system' };

// আপলোড হওয়া ফাইল: storage-এর বদলে ব্রাউজারের blob URL — <img src>-এ সরাসরি বসে
const uploads = new Map<string, { contentType: string; sizeBytes: number; url?: string }>();
const MOCK_STORAGE = `${API_URL}/mock-storage`;

// settleSetup / settleExports: a started setup or an asked-for export "finishes" on the first read
// after its delay, like the worker would
function current() {
  const data = dataOf(workspace);
  settleSetup(data);
  settleExports(data);
  settleDocumentOutput(data);
  settleImports(data.catalog, (type, params) => {
    data.notifications.unshift({
      id: crypto.randomUUID(),
      type,
      params,
      readAt: null,
      createdAt: new Date().toISOString(),
    });
  });
  return data;
}

function me() {
  const data = current();
  return meIn(workspace, data.settings.companyName, preferences, data.setup.status);
}

// handler-এর ভেতরে MockProblem ছুড়লেই আসল API-র মতো problem response — প্রতিটা নিয়মে আলাদা
// if/return লিখতে হয় না
function guarded(resolver: HttpResponseResolver): HttpResponseResolver {
  return async (info) => {
    try {
      return await resolver(info);
    } catch (error) {
      if (error instanceof MockProblem) {
        return problem(error.status, error.code, error.fieldErrors, error.params);
      }
      throw error;
    }
  };
}

// audit-এর "আগের মান" — ফর্মের ঘরগুলো
function editable(settings: Settings) {
  return {
    allowNegativeStock: settings.allowNegativeStock,
    overReceiptPercent: settings.overReceiptPercent,
    pricesIncludeVat: settings.pricesIncludeVat,
    companyName: settings.companyName,
    legalName: settings.legalName,
    bin: settings.bin,
    phone: settings.phone,
    email: settings.email,
    address: settings.address,
    baseCurrency: settings.baseCurrency,
    fiscalYearStartMonth: settings.fiscalYearStartMonth,
    timezone: settings.timezone,
  };
}

function session(): AuthSession {
  return {
    accessToken: `mock-${crypto.randomUUID()}`,
    accessTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

// The API's sibling rule: two "Knit" in one place would be two answers to "which one?"
function assertCategoryPlace(
  categories: readonly ProductCategory[],
  parentId: string | null,
  name: string,
  except?: string,
): void {
  if (parentId !== null && !categories.some((category) => category.id === parentId)) {
    throw new MockProblem(409, 'category_parent_invalid', {
      parentId: ['category_parent_invalid'],
    });
  }
  const taken = categories.some(
    (category) =>
      category.id !== except &&
      category.parentId === parentId &&
      category.name.toLowerCase() === name.toLowerCase(),
  );
  if (taken) throw new MockProblem(409, 'category_name_taken', { name: ['category_name_taken'] });
}

// Only an asset account holds money (step 15c, the API's assertMoneyType)
function assertMoneyType(holdsMoney: boolean, type: Account['type']): void {
  if (holdsMoney && type !== 'asset') {
    throw new MockProblem(409, 'account_money_type', { holdsMoney: ['account_money_type'] });
  }
}

// Confirming an order checks the credit limit (step 15c). The audit rows are the API's: confirmed,
// then the override when there was one, with the limit and what the customer owes now.
function confirmAndRecord(data: WorkspaceData, order: MockOrder, overrideCreditLimit: boolean) {
  const overridden = confirmWithCredit(data, order, overrideCreditLimit);
  record(data, 'sales_order.confirmed', 'sales_order', order.id);
  if (overridden) {
    record(data, 'credit_limit.overridden', 'sales_order', order.id, diff({}, overridden));
  }
}

// Posting an invoice, with the audit rows the API writes: the challan it made for its own goods
// (created and posted), the credit override, then the invoice posted
function postAndRecord(data: WorkspaceData, draft: MockInvoice, overrideCreditLimit: boolean) {
  const { challan, overridden } = postInvoice(data, draft, overrideCreditLimit);
  if (challan) {
    record(data, 'delivery.created', 'delivery', challan.id);
    record(data, 'delivery.posted', 'delivery', challan.id);
  }
  if (overridden) {
    record(data, 'credit_limit.overridden', 'invoice', draft.id, diff({}, overridden));
  }
  record(data, 'invoice.posted', 'invoice', draft.id);
}

// Posting a return or a credit note, with the API's audit row (step 15d). A credit note's row says
// what its posting applied to its own invoice.
function postReturnAndRecord(data: WorkspaceData, draft: MockSalesReturn) {
  postReturn(data, draft);
  record(data, 'sales_return.posted', 'sales_return', draft.id, {
    number: { from: null, to: draft.number },
  });
}

function postCreditNoteAndRecord(data: WorkspaceData, draft: MockCreditNote) {
  const applied = postCreditNote(data, draft);
  record(data, 'credit_note.posted', 'credit_note', draft.id, {
    number: { from: null, to: draft.number },
    applied: { from: null, to: applied },
  });
}

// The sales returns account chosen in Settings → Sales (step 15d) can be neither archived nor
// deleted, like the API's account_used_by_sales
function assertNotSalesAccount(data: WorkspaceData, id: string): void {
  if (data.salesAccounts.returns === id) throw new MockProblem(409, 'account_used_by_sales');
}

// Step 17c: the same for the two accounts of Settings → Purchase accounts (account_used_by_purchase)
function assertNotPurchaseAccount(data: WorkspaceData, id: string): void {
  const { priceDifference, services } = data.purchaseAccounts;
  if (priceDifference === id || services === id) {
    throw new MockProblem(409, 'account_used_by_purchase');
  }
}

// Step 17c: a bill line, an expense or a payment that names it keeps it, drafts too (the API's
// foreign keys, mapped to account_in_use). Step 17d: a supplier refund too
// (supplier_refunds_account_fk).
function usedByPurchase(data: WorkspaceData, id: string): boolean {
  const { bills, payments, refunds } = data.purchase;
  return (
    bills.some(
      (bill) =>
        bill.lines.some((line) => line.accountId === id) ||
        bill.expenses.some((expense) => expense.accountId === id),
    ) ||
    payments.some((payment) => payment.accountId === id) ||
    refunds.some((refund) => refund.accountId === id)
  );
}

// A bill's posting, with its audit rows: the goods receipt it made for its own goods (if any), and
// the bill posted. The API writes both inside the posting.
function recordBillPosted(data: WorkspaceData, bill: MockBill): void {
  const receipt = data.purchase.receipts.find((item) => item.billId === bill.id);
  if (receipt) {
    record(
      data,
      'goods_receipt.posted',
      'goods_receipt',
      receipt.id,
      diff({}, { number: receipt.number, bill: bill.number, entry: receipt.entry?.number ?? null }),
    );
  }
  record(
    data,
    'bill.posted',
    'bill',
    bill.id,
    diff({}, { number: bill.number, entry: bill.entry?.number ?? null }),
  );
}

function recordPaymentPosted(data: WorkspaceData, payment: MockSupplierPayment): void {
  record(
    data,
    'supplier_payment.posted',
    'supplier_payment',
    payment.id,
    diff({}, { number: payment.number, entry: payment.entry?.number ?? null }),
  );
}

// "Post" or "Submit": the engine's round (approved at once for the mock's Owner), then the posting
function submitBillAndRecord(data: WorkspaceData, bill: MockBill): void {
  const steps = submitBill(data, bill);
  record(
    data,
    'approval.submitted',
    'bill',
    bill.id,
    diff({}, { amount: bill.total, steps, status: bill.status }),
  );
  recordBillPosted(data, bill);
}

function submitPaymentAndRecord(data: WorkspaceData, payment: MockSupplierPayment): void {
  const steps = submitPayment(data, payment);
  record(
    data,
    'approval.submitted',
    'supplier_payment',
    payment.id,
    diff({}, { amount: payment.amount, steps, status: payment.status }),
  );
  recordPaymentPosted(data, payment);
}

// What the approvals engine runs when a bill's or a payment's last approval is given (decision 7),
// like the API's services register in their constructors. The approve handler runs decide() in a
// transaction(), so a refused posting leaves the round waiting.
onApproved('bill', (data, id) => {
  const bill = findBill(data, id);
  postBill(data, bill);
  recordBillPosted(data, bill);
});
onApproved('supplier_payment', (data, id) => {
  const payment = findPayment(data, id);
  postPayment(data, payment);
  recordPaymentPosted(data, payment);
});

// Posting a purchase return or a debit note, with the API's audit row (step 17d). A debit note's
// row says what its posting applied to its own bill.
function postPurchaseReturnAndRecord(data: WorkspaceData, draft: MockPurchaseReturn) {
  postPurchaseReturn(data, draft);
  record(
    data,
    'purchase_return.posted',
    'purchase_return',
    draft.id,
    diff({}, { number: draft.number, entry: draft.entry?.number ?? null }),
  );
}

function postDebitNoteAndRecord(data: WorkspaceData, draft: MockDebitNote) {
  const applied = postDebitNote(data, draft);
  record(
    data,
    'debit_note.posted',
    'debit_note',
    draft.id,
    diff({}, { number: draft.number, entry: draft.entry?.number ?? null, applied }),
  );
}

// What the audit log shows of a bill and a payment: the header and the size, not every line
function billSnapshot(bill: MockBill) {
  return {
    number: bill.number,
    date: bill.date,
    dueDate: bill.dueDate,
    supplier: bill.supplier.code,
    supplierBillNumber: bill.supplierBillNumber,
    mushakNumber: bill.mushakNumber,
    total: bill.total,
    lines: bill.lines.length,
    expenses: bill.expenses.length,
  };
}

function paymentSnapshot(payment: MockSupplierPayment) {
  return {
    number: payment.number,
    date: payment.date,
    supplier: payment.supplier.code,
    amount: payment.amount,
    method: payment.method,
    reference: payment.reference,
    bills: payment.allocations.length,
  };
}

// UI-র প্রতিটা পথ দেখার জন্য: লগইনে পাসওয়ার্ড "wrong-password" → invalid_credentials,
// সাইনআপে ঠিকানা "rahman-garments" → slug_taken
export const handlers = [
  // Step 18a: an offline browser (Playwright's context.setOffline, DevTools' "Offline") gets what a
  // dead network gives, a failed fetch. MSW runs these handlers inside the page, so without this
  // the mock would answer every request with the network off. undefined = on to the next handler.
  http.all(`${API_URL}/*`, () => (navigator.onLine ? undefined : HttpResponse.error())),

  mock(routes.health.check, () => reply(routes.health.check, { status: 'ok' })),

  mock(routes.auth.refresh, () =>
    signedIn ? reply(routes.auth.refresh, session()) : problem(401, 'session_ended'),
  ),

  mock(routes.auth.me, () => reply(routes.auth.me, me())),

  mock(routes.me.updatePreferences, async ({ request }) => {
    const body = await readBody(routes.me.updatePreferences.body, request);
    preferences = {
      language: body.language ?? preferences.language,
      theme: body.theme ?? preferences.theme,
    };
    return reply(routes.me.updatePreferences, preferences);
  }),

  mock(routes.auth.login, async ({ request }) => {
    const body = await readBody(routes.auth.login.body, request);
    await delay();
    if (body.password === 'wrong-password') return problem(401, 'invalid_credentials');
    signedIn = true;
    return reply(routes.auth.login, session());
  }),

  mock(routes.auth.signUp, async ({ request }) => {
    const body = await readBody(routes.auth.signUp.body, request);
    await delay();
    if (body.workspaceSlug === WORKSPACES[0].slug) {
      return problem(409, 'slug_taken', { workspaceSlug: ['slug_taken'] });
    }
    // A new workspace: setup 'pending', so the app goes on to the onboarding wizard
    workspace = WORKSPACES[0];
    startFresh(workspace, body.companyName);
    signedIn = true;
    return reply(routes.auth.signUp, session());
  }),

  mock(routes.auth.switchTenant, async ({ request }) => {
    const { tenantId } = await readBody(routes.auth.switchTenant.body, request);
    const target = WORKSPACES.find((candidate) => candidate.tenantId === tenantId);
    if (!target) return problem(403, 'switch_denied');
    workspace = target;
    return reply(routes.auth.switchTenant, session());
  }),

  mock(routes.auth.logout, () => {
    signedIn = false;
    return reply(routes.auth.logout, undefined);
  }),

  mock(routes.members.list, async ({ request }) => {
    const query = readQuery(routes.members.list.query, request);
    // আসল API keyset ব্যবহার করে; mock-এ cursor শুধু একটা offset — ক্লায়েন্টের কাছে দুটোই অস্বচ্ছ
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    const sorted = current().people.members.toSorted((a, b) =>
      a.fullName.localeCompare(b.fullName),
    );
    if (query.sort === '-name') sorted.reverse();
    const items = sorted.slice(start, start + query.limit);
    const end = start + items.length;
    // পাতার মাঝে একটু দেরি — "Loading more…" চোখে দেখা যায়
    await delay(400);
    return reply(routes.members.list, {
      items,
      nextCursor: end < sorted.length ? String(end) : null,
    });
  }),

  mock(
    routes.members.updateRoles,
    guarded(async ({ request, params }) => {
      const { id } = routes.members.updateRoles.params.parse(params);
      const { roleIds, version } = await readBody(routes.members.updateRoles.body, request);
      const data = current();
      const member = findMember(data.people, id);
      checkVersion(member.version, version);
      assertCanChange(data.people, member, roleIds);
      const before = member.roles.map((role) => role.name).join(', ') || null;
      member.roles = roleIds
        .map((roleId) => findRole(data.people, roleId))
        .map((role) => ({ id: role.id, name: role.name }))
        .toSorted((a, b) => a.name.localeCompare(b.name));
      member.version += 1;
      const after = member.roles.map((role) => role.name).join(', ') || null;
      record(data, 'member.roles_changed', 'member', id, { roles: { from: before, to: after } });
      await delay();
      return reply(routes.members.updateRoles, member);
    }),
  ),

  mock(
    routes.members.remove,
    guarded(({ request, params }) => {
      const { id } = routes.members.remove.params.parse(params);
      const { version } = readQuery(routes.members.remove.query, request);
      const data = current();
      const member = findMember(data.people, id);
      checkVersion(member.version, version);
      assertCanChange(data.people, member, []);
      data.people.members = data.people.members.filter((other) => other.membershipId !== id);
      record(data, 'member.removed', 'member', id, { email: { from: member.email, to: null } });
      return reply(routes.members.remove, undefined);
    }),
  ),

  mock(routes.roles.list, () => reply(routes.roles.list, { items: roleList(current().people) })),

  mock(
    routes.roles.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.roles.create.body, request);
      const data = current();
      assertRoleNameFree(data.people, body.name);
      const created = {
        id: crypto.randomUUID(),
        ...body,
        kind: 'custom' as const,
        permissions: [],
        version: 1,
        updatedAt: new Date().toISOString(),
      };
      data.people.roles.push(created);
      record(data, 'role.created', 'role', created.id, diff({}, body));
      await delay();
      return reply(routes.roles.create, toRole(data.people, created));
    }),
  ),

  mock(
    routes.roles.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.roles.update.params.parse(params);
      const { version, ...fields } = await readBody(routes.roles.update.body, request);
      const data = current();
      const target = findRole(data.people, id);
      if (target.kind === 'owner') throw new MockProblem(409, 'owner_role_locked');
      checkVersion(target.version, version);
      assertRoleNameFree(data.people, fields.name, id);
      const before = { name: target.name, description: target.description };
      Object.assign(target, fields, { version: version + 1 });
      // সদস্যের তালিকায় রোলের নামও নতুন
      for (const member of data.people.members) {
        for (const held of member.roles) if (held.id === id) held.name = fields.name;
      }
      record(data, 'role.updated', 'role', id, diff(before, fields));
      return reply(routes.roles.update, toRole(data.people, target));
    }),
  ),

  mock(
    routes.roles.remove,
    guarded(({ request, params }) => {
      const { id } = routes.roles.remove.params.parse(params);
      const { version } = readQuery(routes.roles.remove.query, request);
      const data = current();
      const target = findRole(data.people, id);
      if (target.kind === 'owner') throw new MockProblem(409, 'owner_role_locked');
      checkVersion(target.version, version);
      const inUse =
        data.people.members.some((member) => member.roles.some((held) => held.id === id)) ||
        data.people.invitations.some(
          (invitation) => isOpen(invitation) && invitation.roles.some((held) => held.id === id),
        );
      // Step 17a: an approval level names it, or a waiting round still needs it
      if (inUse || approvalsNeedRole(data, id)) throw new MockProblem(409, 'role_in_use');
      forgetRole(data, id);
      data.people.roles = data.people.roles.filter((other) => other.id !== id);
      record(data, 'role.deleted', 'role', id, { name: { from: target.name, to: null } });
      return reply(routes.roles.remove, undefined);
    }),
  ),

  mock(
    routes.roles.updateMatrix,
    guarded(async ({ request }) => {
      const body = await readBody(routes.roles.updateMatrix.body, request);
      const data = current();
      // আসল API-র মতো সব-নয়-কিছুই-না: আগে সব যাচাই, তারপর লেখা
      const targets = body.roles.map((change) => {
        const target = findRole(data.people, change.id);
        if (target.kind === 'owner') throw new MockProblem(409, 'owner_role_locked');
        checkVersion(target.version, change.version);
        return { target, change };
      });
      for (const { target, change } of targets) {
        const changes = diff(
          Object.fromEntries(target.permissions.map((key) => [key, true])),
          Object.fromEntries(change.permissions.map((key) => [key, true])),
        );
        for (const key of target.permissions) {
          if (!change.permissions.includes(key)) changes[key] = { from: true, to: false };
        }
        target.permissions = change.permissions;
        target.version += 1;
        record(data, 'role.permissions_changed', 'role', target.id, changes);
      }
      await delay();
      return reply(routes.roles.updateMatrix, { items: roleList(data.people) });
    }),
  ),

  mock(routes.invitations.list, () =>
    reply(routes.invitations.list, {
      items: current().people.invitations.filter(isOpen).map(toInvitation),
    }),
  ),

  mock(
    routes.invitations.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.invitations.create.body, request);
      const data = current();
      if (data.people.members.some((member) => member.email === body.email)) {
        throw new MockProblem(409, 'already_member', { email: ['already_member'] });
      }
      if (data.people.invitations.some((other) => isOpen(other) && other.email === body.email)) {
        throw new MockProblem(409, 'already_invited', { email: ['already_invited'] });
      }
      const invitation = {
        id: crypto.randomUUID(),
        email: body.email,
        roles: body.roleIds.map((roleId) => {
          const held = findRole(data.people, roleId);
          return { id: held.id, name: held.name };
        }),
        invitedBy: { id: OWNER.id, fullName: OWNER.fullName },
        sendsAt: Date.now() + MOCK_SEND_DELAY_MS,
        expiresAt: expiry(),
        createdAt: new Date().toISOString(),
        version: 1,
        token: newToken(),
        acceptedAt: null,
        revokedAt: null,
      };
      data.people.invitations.unshift(invitation);
      record(data, 'member.invited', 'invitation', invitation.id, {
        email: { from: null, to: invitation.email },
      });
      // ইমেইলের বদলে console — `pnpm dev:mock`-এ লিংকটা খুলে join পেজ দেখা যায়
      console.info(`[mock] invitation link: ${window.location.origin}/invite#${invitation.token}`);
      await delay();
      return reply(routes.invitations.create, toInvitation(invitation));
    }),
  ),

  mock(
    routes.invitations.resend,
    guarded(async ({ request, params }) => {
      const { id } = routes.invitations.resend.params.parse(params);
      const { version } = await readBody(routes.invitations.resend.body, request);
      const invitation = current().people.invitations.find(
        (candidate) => candidate.id === id && isOpen(candidate),
      );
      if (!invitation) throw new MockProblem(404, 'not_found');
      checkVersion(invitation.version, version);
      Object.assign(invitation, {
        token: newToken(),
        expiresAt: expiry(),
        sendsAt: Date.now() + MOCK_SEND_DELAY_MS,
        version: version + 1,
      });
      console.info(`[mock] invitation link: ${window.location.origin}/invite#${invitation.token}`);
      return reply(routes.invitations.resend, toInvitation(invitation));
    }),
  ),

  mock(
    routes.invitations.revoke,
    guarded(({ request, params }) => {
      const { id } = routes.invitations.revoke.params.parse(params);
      const { version } = readQuery(routes.invitations.revoke.query, request);
      const invitation = current().people.invitations.find(
        (candidate) => candidate.id === id && isOpen(candidate),
      );
      if (!invitation) throw new MockProblem(404, 'not_found');
      checkVersion(invitation.version, version);
      Object.assign(invitation, { revokedAt: new Date().toISOString(), version: version + 1 });
      return reply(routes.invitations.revoke, undefined);
    }),
  ),

  mock(
    routes.invitations.lookup,
    guarded(async ({ request }) => {
      const { token } = await readBody(routes.invitations.lookup.body, request);
      const invitation = current().people.invitations.find(
        (candidate) => candidate.token === token && isOpen(candidate),
      );
      const preview = invitation
        ? {
            workspace: { name: workspace.name, slug: workspace.slug },
            email: invitation.email,
            invitedBy: invitation.invitedBy?.fullName ?? null,
            accountExists: false,
            expiresAt: invitation.expiresAt,
          }
        : demoPreview(token, workspace);
      if (!preview) throw new MockProblem(404, 'invitation_invalid');
      await delay();
      return reply(routes.invitations.lookup, preview);
    }),
  ),

  mock(
    routes.invitations.accept,
    guarded(async ({ request }) => {
      const body = await readBody(routes.invitations.accept.body, request);
      const invitation = current().people.invitations.find(
        (candidate) => candidate.token === body.token && isOpen(candidate),
      );
      if (!invitation && !demoPreview(body.token, workspace)) {
        throw new MockProblem(404, 'invitation_invalid');
      }
      if (body.account === 'existing' && body.password === 'wrong-password') {
        throw new MockProblem(401, 'invalid_credentials');
      }
      if (invitation) invitation.acceptedAt = new Date().toISOString();
      await delay();
      // mock-এ "আমি" সবসময় OWNER — গ্রহণের পরে একই ড্যাশবোর্ড, শুধু পথটা দেখার জন্য
      signedIn = true;
      return reply(routes.invitations.accept, session());
    }),
  ),

  mock(routes.settings.get, () => reply(routes.settings.get, current().settings)),

  mock(
    routes.settings.update,
    guarded(async ({ request }) => {
      const { version, ...fields } = await readBody(routes.settings.update.body, request);
      const data = current();
      checkVersion(data.settings.version, version);
      if (
        fields.baseCurrency !== data.settings.baseCurrency &&
        data.journal.entries.some((entry) => entry.status === 'posted')
      ) {
        throw new MockProblem(409, 'base_currency_locked', {
          baseCurrency: ['base_currency_locked'],
        });
      }
      const before = editable(data.settings);
      // Step 17b: the form's "3" is stored as NUMERIC(5,2), "3.00" (it has at most 2 decimals, so
      // cutting the 4 that addQuantity() gives is exact); an unchanged percent is not logged
      const overReceiptPercent = addQuantity(fields.overReceiptPercent, '0').slice(0, -2);
      const unchanged = compareQuantity(overReceiptPercent, before.overReceiptPercent) === 0;
      data.settings = { ...data.settings, ...fields, overReceiptPercent, version: version + 1 };
      record(
        data,
        'settings.updated',
        'workspace',
        workspace.tenantId,
        diff(before, {
          ...fields,
          overReceiptPercent: unchanged ? before.overReceiptPercent : fields.overReceiptPercent,
        }),
      );
      await delay();
      return reply(routes.settings.update, data.settings);
    }),
  ),

  mock(
    routes.settings.setLogo,
    guarded(async ({ request }) => {
      const { attachmentId } = await readBody(routes.settings.setLogo.body, request);
      const data = current();
      const file = attachmentId === null ? undefined : uploads.get(attachmentId);
      if (attachmentId !== null && !file?.url) throw new MockProblem(409, 'attachment_not_ready');
      data.settings = {
        ...data.settings,
        logo: attachmentId !== null && file?.url ? { attachmentId, url: file.url } : null,
      };
      record(data, 'settings.logo_changed', 'workspace', workspace.tenantId);
      return reply(routes.settings.setLogo, data.settings);
    }),
  ),

  mock(routes.branches.list, ({ request }) => {
    const { status } = readQuery(routes.branches.list.query, request);
    const items = current()
      .branches.filter((branch) => (status === 'active') === (branch.archivedAt === null))
      .toSorted((a, b) => a.code.localeCompare(b.code));
    return reply(routes.branches.list, { items });
  }),

  mock(
    routes.branches.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.branches.create.body, request);
      const data = current();
      assertCodeFree(data, body.code);
      const created = {
        id: crypto.randomUUID(),
        ...body,
        archivedAt: null,
        version: 1,
        updatedAt: new Date().toISOString(),
      };
      data.branches.push(created);
      record(data, 'branch.created', 'branch', created.id, diff({}, body));
      await delay();
      return reply(routes.branches.create, created);
    }),
  ),

  mock(
    routes.branches.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.branches.update.params.parse(params);
      const { version, ...fields } = await readBody(routes.branches.update.body, request);
      const data = current();
      const target = findBranch(data, id);
      checkVersion(target.version, version);
      assertCodeFree(data, fields.code, id);
      const before = {
        code: target.code,
        name: target.name,
        phone: target.phone,
        address: target.address,
      };
      Object.assign(target, fields, { version: version + 1, updatedAt: new Date().toISOString() });
      record(data, 'branch.updated', 'branch', id, diff(before, fields));
      await delay();
      return reply(routes.branches.update, target);
    }),
  ),

  mock(
    routes.branches.archive,
    guarded(async ({ request, params }) => {
      const { id } = routes.branches.archive.params.parse(params);
      const { version } = await readBody(routes.branches.archive.body, request);
      const data = current();
      const target = findBranch(data, id);
      checkVersion(target.version, version);
      const othersActive = data.branches.some((b) => b.id !== id && b.archivedAt === null);
      if (!othersActive) throw new MockProblem(409, 'branch_last_active');
      Object.assign(target, { archivedAt: new Date().toISOString(), version: version + 1 });
      record(data, 'branch.archived', 'branch', id);
      return reply(routes.branches.archive, target);
    }),
  ),

  mock(
    routes.branches.restore,
    guarded(async ({ request, params }) => {
      const { id } = routes.branches.restore.params.parse(params);
      const { version } = await readBody(routes.branches.restore.body, request);
      const data = current();
      const target = findBranch(data, id);
      checkVersion(target.version, version);
      Object.assign(target, { archivedAt: null, version: version + 1 });
      record(data, 'branch.restored', 'branch', id);
      return reply(routes.branches.restore, target);
    }),
  ),

  mock(routes.accounts.list, () =>
    reply(routes.accounts.list, {
      items: current().accounts.toSorted((a, b) => a.code.localeCompare(b.code)),
    }),
  ),

  mock(
    routes.accounts.get,
    guarded(({ params }) => {
      const { id } = routes.accounts.get.params.parse(params);
      return reply(routes.accounts.get, findAccount(current().accounts, id));
    }),
  ),

  mock(
    routes.accounts.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.accounts.create.body, request);
      const data = current();
      const parent = parentFor(data.accounts, body.parentId);
      assertAccountCodeFree(data.accounts, body.code);
      // A new account takes its parent's type
      assertMoneyType(body.holdsMoney, parent.type);
      const created = {
        ...body,
        id: crypto.randomUUID(),
        type: parent.type,
        purpose: null,
        archivedAt: null,
        version: 1,
        updatedAt: new Date().toISOString(),
      };
      data.accounts.push(created);
      record(
        data,
        'account.created',
        'account',
        created.id,
        diff(
          {},
          {
            code: body.code,
            name: body.name,
            description: body.description,
            parent: parent.code,
            holdsMoney: body.holdsMoney,
          },
        ),
      );
      await delay();
      return reply(routes.accounts.create, created);
    }),
  ),

  mock(
    routes.accounts.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.accounts.update.params.parse(params);
      const { version, ...fields } = await readBody(routes.accounts.update.body, request);
      const data = current();
      const target = findAccount(data.accounts, id);
      checkVersion(target.version, version);
      if (fields.parentId !== target.parentId) {
        if (fields.parentId === null) throw new MockProblem(409, 'account_parent_invalid');
        parentFor(data.accounts, fields.parentId, target);
      }
      assertAccountCodeFree(data.accounts, fields.code, id);
      assertMoneyType(fields.holdsMoney, target.type);
      const snapshot = (account: Account) => ({
        code: account.code,
        name: account.name,
        description: account.description,
        parent: codeOf(data.accounts, account.parentId),
        holdsMoney: account.holdsMoney,
      });
      const before = snapshot(target);
      Object.assign(target, fields, { version: version + 1, updatedAt: new Date().toISOString() });
      record(data, 'account.updated', 'account', id, diff(before, snapshot(target)));
      await delay();
      return reply(routes.accounts.update, target);
    }),
  ),

  mock(
    routes.accounts.archive,
    guarded(async ({ request, params }) => {
      const { id } = routes.accounts.archive.params.parse(params);
      const { version } = await readBody(routes.accounts.archive.body, request);
      const data = current();
      const target = findAccount(data.accounts, id);
      checkVersion(target.version, version);
      assertNotLocked(target);
      // Chosen in Settings → Inventory (step 14), like the API
      if (Object.values(current().stockAccounts).includes(target.id)) {
        throw new MockProblem(409, 'account_used_by_stock');
      }
      assertNotSalesAccount(data, target.id);
      assertNotPurchaseAccount(data, target.id);
      if (data.accounts.some((child) => child.parentId === id && child.archivedAt === null)) {
        throw new MockProblem(409, 'account_has_active_children');
      }
      Object.assign(target, { archivedAt: new Date().toISOString(), version: version + 1 });
      record(data, 'account.archived', 'account', id);
      return reply(routes.accounts.archive, target);
    }),
  ),

  mock(
    routes.accounts.restore,
    guarded(async ({ request, params }) => {
      const { id } = routes.accounts.restore.params.parse(params);
      const { version } = await readBody(routes.accounts.restore.body, request);
      const data = current();
      const target = findAccount(data.accounts, id);
      checkVersion(target.version, version);
      const parent = data.accounts.find((account) => account.id === target.parentId);
      if (parent && parent.archivedAt !== null) {
        throw new MockProblem(409, 'account_parent_archived');
      }
      Object.assign(target, { archivedAt: null, version: version + 1 });
      record(data, 'account.restored', 'account', id);
      return reply(routes.accounts.restore, target);
    }),
  ),

  mock(
    routes.accounts.remove,
    guarded(({ request, params }) => {
      const { id } = routes.accounts.remove.params.parse(params);
      const { version } = readQuery(routes.accounts.remove.query, request);
      const data = current();
      const target = findAccount(data.accounts, id);
      checkVersion(target.version, version);
      assertNotLocked(target);
      // Chosen in Settings → Inventory (step 14), like the API
      if (Object.values(current().stockAccounts).includes(target.id)) {
        throw new MockProblem(409, 'account_used_by_stock');
      }
      assertNotSalesAccount(data, target.id);
      assertNotPurchaseAccount(data, target.id);
      if (data.accounts.some((child) => child.parentId === id)) {
        throw new MockProblem(409, 'account_has_children');
      }
      if (
        data.journal.entries.some((entry) => entry.lines.some((line) => line.accountId === id)) ||
        usedByPurchase(data, id)
      ) {
        throw new MockProblem(409, 'account_in_use');
      }
      data.accounts = data.accounts.filter((account) => account.id !== id);
      record(data, 'account.deleted', 'account', id, {
        code: { from: target.code, to: null },
        name: { from: target.name, to: null },
      });
      return reply(routes.accounts.remove, undefined);
    }),
  ),

  mock(routes.journal.list, ({ request }) => {
    const query = readQuery(routes.journal.list.query, request);
    // The mock's cursor is an offset, like its other lists
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    const all = sortedEntries(current()).filter(
      (entry) => query.status === undefined || entry.status === query.status,
    );
    const items = all.slice(start, start + query.limit).map(summaryOf);
    const end = start + items.length;
    return reply(routes.journal.list, { items, nextCursor: end < all.length ? String(end) : null });
  }),

  mock(
    routes.journal.get,
    guarded(({ params }) => {
      const { id } = routes.journal.get.params.parse(params);
      return reply(routes.journal.get, findEntry(current(), id));
    }),
  ),

  mock(
    routes.journal.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.journal.create.body, request);
      const data = current();
      // A draft may leave the customer for later; posting needs it (the API's allowMissingParty)
      checkLines(data, body.lines, { allowMissingParty: !body.post });
      const entry = body.post ? postNew(data, body) : writeDraft(data, body);
      record(data, 'journal.created', 'journal_entry', entry.id);
      if (body.post) {
        record(data, 'journal.posted', 'journal_entry', entry.id, {
          number: { from: null, to: entry.number },
        });
      }
      await delay();
      return reply(routes.journal.create, entry);
    }),
  ),

  mock(
    routes.journal.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.journal.update.params.parse(params);
      const { version, post, ...fields } = await readBody(routes.journal.update.body, request);
      const data = current();
      const entry = findEntry(data, id);
      if (entry.status !== 'draft') throw new MockProblem(409, 'journal_not_draft');
      checkVersion(entry.version, version);
      checkLines(data, fields.lines, { allowMissingParty: !post });
      // All or nothing, like the API's transaction: post a copy, keep it only if it posts
      const before = structuredClone(entry);
      replaceDraft(data, entry, fields);
      if (post) {
        try {
          postDraft(data, entry);
        } catch (error) {
          Object.assign(entry, before);
          throw error;
        }
      }
      record(data, 'journal.updated', 'journal_entry', id);
      await delay();
      return reply(routes.journal.update, entry);
    }),
  ),

  mock(
    routes.journal.remove,
    guarded(({ request, params }) => {
      const { id } = routes.journal.remove.params.parse(params);
      const { version } = readQuery(routes.journal.remove.query, request);
      const data = current();
      const entry = findEntry(data, id);
      if (entry.status !== 'draft') throw new MockProblem(409, 'journal_not_draft');
      checkVersion(entry.version, version);
      data.journal.entries = data.journal.entries.filter((item) => item.id !== id);
      record(data, 'journal.deleted', 'journal_entry', id);
      return reply(routes.journal.remove, undefined);
    }),
  ),

  mock(
    routes.journal.post,
    guarded(async ({ request, params }) => {
      const { id } = routes.journal.post.params.parse(params);
      const { version } = await readBody(routes.journal.post.body, request);
      const data = current();
      const entry = findEntry(data, id);
      if (entry.status !== 'draft') throw new MockProblem(409, 'journal_not_draft');
      checkVersion(entry.version, version);
      postDraft(data, entry);
      record(data, 'journal.posted', 'journal_entry', id, {
        number: { from: null, to: entry.number },
      });
      return reply(routes.journal.post, entry);
    }),
  ),

  mock(
    routes.journal.reverse,
    guarded(async ({ request, params }) => {
      const { id } = routes.journal.reverse.params.parse(params);
      const { version, date } = await readBody(routes.journal.reverse.body, request);
      const data = current();
      const entry = findEntry(data, id);
      checkVersion(entry.version, version);
      const reversal = reverseEntry(data, entry, date);
      record(data, 'journal.reversed', 'journal_entry', id, {
        reversal: { from: null, to: reversal.number },
      });
      await delay();
      return reply(routes.journal.reverse, reversal);
    }),
  ),

  mock(
    routes.ledger.get,
    guarded(({ request, params }) => {
      const { id } = routes.ledger.get.params.parse(params);
      const query = readQuery(routes.ledger.get.query, request);
      return reply(routes.ledger.get, ledgerOf(current(), id, query));
    }),
  ),

  mock(routes.openingBalances.get, () => reply(routes.openingBalances.get, openingOf(current()))),

  mock(
    routes.openingBalances.save,
    guarded(async ({ request }) => {
      const body = await readBody(routes.openingBalances.save.body, request);
      const data = current();
      saveOpening(data, body);
      const saved = openingOf(data);
      record(data, 'journal.opening_balances_saved', 'workspace', workspace.tenantId, {
        entry: { from: null, to: saved.entry?.number ?? null },
      });
      await delay();
      return reply(routes.openingBalances.save, saved);
    }),
  ),

  mock(routes.periodLock.get, () => {
    const { journal } = current();
    return reply(routes.periodLock.get, {
      lockDate: journal.lockDate,
      version: journal.lockVersion,
    });
  }),

  mock(
    routes.periodLock.update,
    guarded(async ({ request }) => {
      const { lockDate, version } = await readBody(routes.periodLock.update.body, request);
      const data = current();
      const before = data.journal.lockDate;
      setLockDate(data, lockDate, version);
      record(data, 'books.lock_date_changed', 'workspace', workspace.tenantId, {
        lockDate: { from: before, to: lockDate },
      });
      return reply(routes.periodLock.update, {
        lockDate: data.journal.lockDate,
        version: data.journal.lockVersion,
      });
    }),
  ),

  mock(routes.reports.trialBalance, ({ request }) =>
    reply(
      routes.reports.trialBalance,
      trialBalanceOf(current(), readQuery(routes.reports.trialBalance.query, request)),
    ),
  ),

  mock(routes.reports.profitAndLoss, ({ request }) =>
    reply(
      routes.reports.profitAndLoss,
      profitAndLossOf(current(), readQuery(routes.reports.profitAndLoss.query, request)),
    ),
  ),

  mock(routes.reports.balanceSheet, ({ request }) =>
    reply(
      routes.reports.balanceSheet,
      balanceSheetOf(current(), readQuery(routes.reports.balanceSheet.query, request)),
    ),
  ),

  mock(routes.fiscalYears.list, () => reply(routes.fiscalYears.list, fiscalYearsOf(current()))),

  mock(
    routes.fiscalYears.close,
    guarded(async ({ request }) => {
      const { end } = await readBody(routes.fiscalYears.close.body, request);
      return reply(routes.fiscalYears.close, closeYear(current(), end));
    }),
  ),

  mock(
    routes.fiscalYears.reopen,
    guarded(async ({ request }) => {
      const { end } = await readBody(routes.fiscalYears.reopen.body, request);
      return reply(routes.fiscalYears.reopen, reopenYear(current(), end));
    }),
  ),

  mock(
    routes.reportExports.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.reportExports.create.body, request);
      return reply(routes.reportExports.create, createExport(current(), body));
    }),
  ),

  mock(routes.reportExports.list, () =>
    reply(routes.reportExports.list, {
      items: current().exports.map(toExport),
      nextCursor: null,
    }),
  ),

  mock(
    routes.reportExports.download,
    guarded(({ params }) => {
      const { id } = routes.reportExports.download.params.parse(params);
      const item = current().exports.find((candidate) => candidate.id === id);
      if (!item) throw new MockProblem(404, 'not_found');
      if (item.status !== 'ready') throw new MockProblem(409, 'export_not_ready');
      return reply(routes.reportExports.download, {
        url: exportUrl(item),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
    }),
  ),

  mock(routes.numberSeries.list, () =>
    reply(routes.numberSeries.list, { items: seriesList(current()) }),
  ),

  mock(
    routes.numberSeries.update,
    guarded(async ({ request, params }) => {
      const { documentType } = routes.numberSeries.update.params.parse(params);
      const { version, ...format } = await readBody(routes.numberSeries.update.body, request);
      const data = current();
      checkVersion(data.series.get(documentType)?.version ?? 0, version);
      data.series.set(documentType, { ...format, version: version + 1 });
      record(data, 'number_series.updated', 'number_series', crypto.randomUUID(), {});
      const saved = seriesList(data).find((series) => series.documentType === documentType);
      if (!saved) throw new MockProblem(404, 'not_found');
      return reply(routes.numberSeries.update, saved);
    }),
  ),

  mock(routes.audit.list, ({ request }) => {
    const query = readQuery(routes.audit.list.query, request);
    // mock-এ cursor শুধু offset (members-এর মতো) — ক্লায়েন্টের কাছে অস্বচ্ছ string
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    const all = current().audit.filter(
      (entry) => query.entityType === undefined || entry.entityType === query.entityType,
    );
    const items = all.slice(start, start + query.limit);
    const end = start + items.length;
    return reply(routes.audit.list, { items, nextCursor: end < all.length ? String(end) : null });
  }),

  mock(routes.setup.get, () => reply(routes.setup.get, current().setup)),

  mock(
    routes.setup.start,
    guarded(async ({ request }) => {
      const { industry } = await readBody(routes.setup.start.body, request);
      await delay();
      return reply(routes.setup.start, startSetup(current(), industry));
    }),
  ),

  mock(
    routes.setup.retry,
    guarded(() => {
      const data = current();
      if (data.setup.status !== 'failed') throw new MockProblem(409, 'setup_not_failed');
      return reply(routes.setup.retry, data.setup);
    }),
  ),

  mock(routes.notifications.list, ({ request }) => {
    const query = readQuery(routes.notifications.list.query, request);
    // mock-এ cursor শুধু offset (members-এর মতো)
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    const all = current().notifications;
    const items = all.slice(start, start + query.limit);
    const end = start + items.length;
    return reply(routes.notifications.list, {
      items,
      nextCursor: end < all.length ? String(end) : null,
    });
  }),

  mock(routes.notifications.unreadCount, () =>
    reply(routes.notifications.unreadCount, {
      count: current().notifications.filter((item) => item.readAt === null).length,
    }),
  ),

  mock(
    routes.notifications.markRead,
    guarded(({ params }) => {
      const { id } = routes.notifications.markRead.params.parse(params);
      const found = current().notifications.find((item) => item.id === id);
      if (!found) throw new MockProblem(404, 'not_found');
      found.readAt ??= new Date().toISOString();
      return reply(routes.notifications.markRead, undefined);
    }),
  ),

  mock(routes.notifications.markAllRead, () => {
    const readAt = new Date().toISOString();
    for (const item of current().notifications) item.readAt ??= readAt;
    return reply(routes.notifications.markAllRead, undefined);
  }),

  mock(routes.attachments.createUpload, async ({ request }) => {
    const body = await readBody(routes.attachments.createUpload.body, request);
    const id = crypto.randomUUID();
    uploads.set(id, { contentType: body.contentType, sizeBytes: body.sizeBytes });
    return reply(routes.attachments.createUpload, {
      attachment: { id, ...body, status: 'pending', createdAt: new Date().toISOString() },
      upload: {
        method: 'PUT',
        url: `${MOCK_STORAGE}/${id}`,
        headers: { 'content-type': body.contentType },
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    });
  }),

  // storage-এর জায়গায়: চুক্তির রুট না, তাই mock() না — সাধারণ MSW handler
  http.put(`${MOCK_STORAGE}/:id`, async ({ request, params }) => {
    const file = typeof params.id === 'string' ? uploads.get(params.id) : undefined;
    if (!file) return new HttpResponse(null, { status: 404 });
    file.url = URL.createObjectURL(await request.blob());
    await delay(600);
    return new HttpResponse(null, { status: 200 });
  }),

  mock(
    routes.attachments.complete,
    guarded(({ params }) => {
      const { id } = routes.attachments.complete.params.parse(params);
      const file = uploads.get(id);
      if (!file?.url) throw new MockProblem(409, 'upload_incomplete');
      return reply(routes.attachments.complete, {
        id,
        purpose: 'company_logo',
        fileName: 'logo',
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        status: 'ready',
        createdAt: new Date().toISOString(),
      });
    }),
  ),

  mock(
    routes.attachments.download,
    guarded(({ params }) => {
      const { id } = routes.attachments.download.params.parse(params);
      const url = uploads.get(id)?.url;
      if (!url) throw new MockProblem(409, 'attachment_not_ready');
      return reply(routes.attachments.download, {
        url,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
    }),
  ),

  // ---------------------------------------------------------------------------------------------
  // Units, categories, custom fields, products and imports (step 12)

  mock(routes.units.list, () => reply(routes.units.list, { items: current().catalog.units })),

  mock(
    routes.units.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.units.create.body, request);
      const data = current();
      if (data.catalog.units.some((unit) => unit.code.toLowerCase() === body.code.toLowerCase())) {
        throw new MockProblem(409, 'unit_code_taken', { code: ['unit_code_taken'] });
      }
      const created = {
        id: crypto.randomUUID(),
        ...body,
        ratio: body.ratio === null ? null : Number(body.ratio).toFixed(6),
        archivedAt: null,
        version: 1,
        updatedAt: new Date().toISOString(),
      };
      data.catalog.units.push(created);
      record(
        data,
        'unit.created',
        'unit',
        created.id,
        diff({}, { code: body.code, name: body.name }),
      );
      return reply(routes.units.create, created);
    }),
  ),

  mock(
    routes.units.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.units.update.params.parse(params);
      const { version, ...fields } = await readBody(routes.units.update.body, request);
      const data = current();
      const target = data.catalog.units.find((unit) => unit.id === id);
      if (!target) throw new MockProblem(404, 'not_found');
      checkVersion(target.version, version);
      if (
        data.catalog.units.some(
          (unit) => unit.id !== id && unit.code.toLowerCase() === fields.code.toLowerCase(),
        )
      ) {
        throw new MockProblem(409, 'unit_code_taken', { code: ['unit_code_taken'] });
      }
      Object.assign(target, fields, { version: version + 1, updatedAt: new Date().toISOString() });
      record(data, 'unit.updated', 'unit', id);
      return reply(routes.units.update, target);
    }),
  ),

  ...(['archive', 'restore'] as const).map((action) =>
    mock(
      routes.units[action],
      guarded(async ({ request, params }) => {
        const { id } = routes.units[action].params.parse(params);
        const { version } = await readBody(routes.units[action].body, request);
        const data = current();
        const target = data.catalog.units.find((unit) => unit.id === id);
        if (!target) throw new MockProblem(404, 'not_found');
        checkVersion(target.version, version);
        Object.assign(target, {
          archivedAt: action === 'archive' ? new Date().toISOString() : null,
          version: version + 1,
        });
        record(data, action === 'archive' ? 'unit.archived' : 'unit.restored', 'unit', id);
        return reply(routes.units[action], target);
      }),
    ),
  ),

  mock(
    routes.units.remove,
    guarded(({ request, params }) => {
      const { id } = routes.units.remove.params.parse(params);
      const { version } = readQuery(routes.units.remove.query, request);
      const data = current();
      const target = data.catalog.units.find((unit) => unit.id === id);
      if (!target) throw new MockProblem(404, 'not_found');
      checkVersion(target.version, version);
      const used = data.catalog.products.some(
        (item) => item.baseUnitId === id || item.units.some((pack) => pack.unitId === id),
      );
      if (used) throw new MockProblem(409, 'unit_in_use');
      data.catalog.units = data.catalog.units.filter((unit) => unit.id !== id);
      record(data, 'unit.deleted', 'unit', id);
      return reply(routes.units.remove, undefined);
    }),
  ),

  mock(routes.productCategories.list, () => {
    const { categories, products } = current().catalog;
    return reply(routes.productCategories.list, {
      items: categories.map((category) => ({
        ...category,
        productCount: products.filter((item) => item.categoryId === category.id).length,
      })),
    });
  }),

  mock(
    routes.productCategories.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.productCategories.create.body, request);
      const data = current();
      assertCategoryPlace(data.catalog.categories, body.parentId, body.name);
      const created = {
        id: crypto.randomUUID(),
        ...body,
        productCount: 0,
        version: 1,
        updatedAt: new Date().toISOString(),
      };
      data.catalog.categories.push(created);
      record(data, 'product_category.created', 'product_category', created.id);
      return reply(routes.productCategories.create, created);
    }),
  ),

  mock(
    routes.productCategories.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.productCategories.update.params.parse(params);
      const { version, ...fields } = await readBody(routes.productCategories.update.body, request);
      const data = current();
      const target = data.catalog.categories.find((category) => category.id === id);
      if (!target) throw new MockProblem(404, 'not_found');
      checkVersion(target.version, version);
      // Walk up from the new parent: meeting the category itself means a loop
      for (
        let above = fields.parentId;
        above !== null;
        above = data.catalog.categories.find((category) => category.id === above)?.parentId ?? null
      ) {
        if (above === id) {
          throw new MockProblem(409, 'category_parent_loop', {
            parentId: ['category_parent_loop'],
          });
        }
      }
      assertCategoryPlace(data.catalog.categories, fields.parentId, fields.name, id);
      Object.assign(target, fields, { version: version + 1, updatedAt: new Date().toISOString() });
      record(data, 'product_category.updated', 'product_category', id);
      return reply(routes.productCategories.update, {
        ...target,
        productCount: data.catalog.products.filter((item) => item.categoryId === id).length,
      });
    }),
  ),

  mock(
    routes.productCategories.remove,
    guarded(({ request, params }) => {
      const { id } = routes.productCategories.remove.params.parse(params);
      const { version } = readQuery(routes.productCategories.remove.query, request);
      const data = current();
      const target = data.catalog.categories.find((category) => category.id === id);
      if (!target) throw new MockProblem(404, 'not_found');
      checkVersion(target.version, version);
      if (data.catalog.categories.some((category) => category.parentId === id)) {
        throw new MockProblem(409, 'category_has_children');
      }
      if (data.catalog.products.some((item) => item.categoryId === id)) {
        throw new MockProblem(409, 'category_in_use');
      }
      data.catalog.categories = data.catalog.categories.filter((category) => category.id !== id);
      record(data, 'product_category.deleted', 'product_category', id);
      return reply(routes.productCategories.remove, undefined);
    }),
  ),

  mock(routes.customFields.list, () =>
    reply(routes.customFields.list, { items: current().catalog.fields }),
  ),

  mock(
    routes.customFields.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.customFields.create.body, request);
      const data = current();
      if (data.catalog.fields.some((field) => field.key === body.key)) {
        throw new MockProblem(409, 'custom_field_key_taken', { key: ['custom_field_key_taken'] });
      }
      const created = {
        id: crypto.randomUUID(),
        ...body,
        options: body.type === 'select' ? body.options : [],
        required: body.type === 'boolean' ? false : body.required,
        archivedAt: null,
        version: 1,
        updatedAt: new Date().toISOString(),
      };
      data.catalog.fields.push(created);
      record(data, 'custom_field.created', 'custom_field', created.id);
      return reply(routes.customFields.create, created);
    }),
  ),

  mock(
    routes.customFields.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.customFields.update.params.parse(params);
      const { version, ...fields } = await readBody(routes.customFields.update.body, request);
      const data = current();
      const target = data.catalog.fields.find((field) => field.id === id);
      if (!target) throw new MockProblem(404, 'not_found');
      checkVersion(target.version, version);
      if (target.type === 'select' && fields.options.length === 0) {
        throw new MockProblem(400, 'invalid_input', { options: ['custom_field_options_required'] });
      }
      Object.assign(target, fields, { version: version + 1, updatedAt: new Date().toISOString() });
      record(data, 'custom_field.updated', 'custom_field', id);
      return reply(routes.customFields.update, target);
    }),
  ),

  ...(['archive', 'restore'] as const).map((action) =>
    mock(
      routes.customFields[action],
      guarded(async ({ request, params }) => {
        const { id } = routes.customFields[action].params.parse(params);
        const { version } = await readBody(routes.customFields[action].body, request);
        const data = current();
        const target = data.catalog.fields.find((field) => field.id === id);
        if (!target) throw new MockProblem(404, 'not_found');
        checkVersion(target.version, version);
        Object.assign(target, {
          archivedAt: action === 'archive' ? new Date().toISOString() : null,
          version: version + 1,
        });
        record(
          data,
          action === 'archive' ? 'custom_field.archived' : 'custom_field.restored',
          'custom_field',
          id,
        );
        return reply(routes.customFields[action], target);
      }),
    ),
  ),

  mock(routes.products.list, async ({ request }) => {
    const query = readQuery(routes.products.list.query, request);
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    const all = listProducts(current().catalog, query);
    const items = all.slice(start, start + query.limit).map(productSummaryOf);
    const end = start + items.length;
    // A short wait on later pages: "Loading more…" can be seen while scrolling
    if (start > 0) await delay(300);
    return reply(routes.products.list, {
      items,
      nextCursor: end < all.length ? String(end) : null,
    });
  }),

  mock(
    routes.products.get,
    guarded(({ params }) => {
      const { id } = routes.products.get.params.parse(params);
      return reply(routes.products.get, findProduct(current().catalog, id));
    }),
  ),

  mock(
    routes.products.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.products.create.body, request);
      const data = current();
      assertProductTaxRate(data.sales, body.taxRateId, null);
      const saved = saveProduct(data.catalog, body);
      data.catalog.products.push(saved);
      record(
        data,
        'product.created',
        'product',
        saved.id,
        diff({}, { code: saved.code, name: saved.name }),
      );
      await delay();
      return reply(routes.products.create, saved);
    }),
  ),

  mock(
    routes.products.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.products.update.params.parse(params);
      const { version, ...body } = await readBody(routes.products.update.body, request);
      const data = current();
      const target = findProduct(data.catalog, id);
      checkVersion(target.version, version);
      // An archived rate the product already has is kept, like an archived unit
      assertProductTaxRate(data.sales, body.taxRateId, target.taxRateId);
      const saved = saveProduct(data.catalog, body, target);
      data.catalog.products = data.catalog.products.map((item) => (item.id === id ? saved : item));
      // A dropped pack or variant takes its price-list prices with it
      dropStalePrices(data);
      record(
        data,
        'product.updated',
        'product',
        id,
        diff({ name: target.name }, { name: saved.name }),
      );
      await delay();
      return reply(routes.products.update, saved);
    }),
  ),

  ...(['archive', 'restore'] as const).map((action) =>
    mock(
      routes.products[action],
      guarded(async ({ request, params }) => {
        const { id } = routes.products[action].params.parse(params);
        const { version } = await readBody(routes.products[action].body, request);
        const data = current();
        const target = findProduct(data.catalog, id);
        checkVersion(target.version, version);
        Object.assign(target, {
          archivedAt: action === 'archive' ? new Date().toISOString() : null,
          version: version + 1,
          updatedAt: new Date().toISOString(),
        });
        record(data, action === 'archive' ? 'product.archived' : 'product.restored', 'product', id);
        return reply(routes.products[action], target);
      }),
    ),
  ),

  mock(
    routes.products.remove,
    guarded(({ request, params }) => {
      const { id } = routes.products.remove.params.parse(params);
      const { version } = readQuery(routes.products.remove.query, request);
      const data = current();
      const target = findProduct(data.catalog, id);
      checkVersion(target.version, version);
      data.catalog.products = data.catalog.products.filter((item) => item.id !== id);
      dropStalePrices(data);
      record(data, 'product.deleted', 'product', id, diff({ name: target.name }, { name: null }));
      return reply(routes.products.remove, undefined);
    }),
  ),

  mock(routes.productImports.create, async ({ request }) => {
    const body = await readBody(routes.productImports.create.body, request);
    const item: MockImport = {
      id: crypto.randomUUID(),
      ...body,
      status: 'uploading',
      rowCount: null,
      productCount: null,
      errorCount: 0,
      errors: [],
      requestedBy: { id: OWNER.id, fullName: OWNER.fullName },
      createdAt: new Date().toISOString(),
      finishedAt: null,
      readyAt: 0,
      text: null,
    };
    current().catalog.imports.unshift(item);
    return reply(routes.productImports.create, {
      import: toImport(item),
      upload: {
        method: 'PUT',
        url: `${MOCK_STORAGE}/imports/${item.id}`,
        headers: { 'content-type': 'text/csv' },
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    });
  }),

  // The CSV goes to the pretend storage: kept as text for the pretend worker
  http.put(`${MOCK_STORAGE}/imports/:id`, async ({ request, params }) => {
    const item = current().catalog.imports.find((candidate) => candidate.id === params.id);
    if (!item) return new HttpResponse(null, { status: 404 });
    item.text = await request.text();
    await delay(400);
    return new HttpResponse(null, { status: 200 });
  }),

  mock(
    routes.productImports.start,
    guarded(({ params }) => {
      const { id } = routes.productImports.start.params.parse(params);
      const item = current().catalog.imports.find((candidate) => candidate.id === id);
      if (!item) throw new MockProblem(404, 'not_found');
      if (item.status !== 'uploading') throw new MockProblem(409, 'import_not_pending');
      if (item.text === null) throw new MockProblem(409, 'import_not_uploaded');
      Object.assign(item, { status: 'queued', readyAt: Date.now() + IMPORT_DELAY_MS });
      return reply(routes.productImports.start, toImport(item));
    }),
  ),

  mock(routes.productImports.list, () =>
    reply(routes.productImports.list, {
      items: current().catalog.imports.map(toImport),
      nextCursor: null,
    }),
  ),

  mock(
    routes.productImports.get,
    guarded(({ params }) => {
      const { id } = routes.productImports.get.params.parse(params);
      const item = current().catalog.imports.find((candidate) => candidate.id === id);
      if (!item) throw new MockProblem(404, 'not_found');
      return reply(routes.productImports.get, { ...toImport(item), errors: item.errors });
    }),
  ),

  // --- Warehouses and stock (step 13) ----------------------------------------------------------

  mock(routes.warehouses.list, ({ request }) => {
    const { status } = readQuery(routes.warehouses.list.query, request);
    const items = current()
      .stock.warehouses.filter((place) => (status === 'active') === (place.archivedAt === null))
      .toSorted((a, b) => a.code.localeCompare(b.code));
    return reply(routes.warehouses.list, { items });
  }),

  mock(
    routes.warehouses.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.warehouses.create.body, request);
      const data = current();
      if (data.stock.warehouses.some((place) => place.code === body.code)) {
        throw new MockProblem(409, 'warehouse_code_taken', { code: ['warehouse_code_taken'] });
      }
      const created = newWarehouse(body.branchId, body.code, body.name, body.address);
      data.stock.warehouses.push(created);
      record(data, 'warehouse.created', 'warehouse', created.id, diff({}, { code: created.code }));
      return reply(routes.warehouses.create, created);
    }),
  ),

  mock(
    routes.warehouses.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.warehouses.update.params.parse(params);
      const { version, ...fields } = await readBody(routes.warehouses.update.body, request);
      const data = current();
      const target = data.stock.warehouses.find((place) => place.id === id);
      if (!target) throw new MockProblem(404, 'not_found');
      checkVersion(target.version, version);
      if (data.stock.warehouses.some((place) => place.code === fields.code && place.id !== id)) {
        throw new MockProblem(409, 'warehouse_code_taken', { code: ['warehouse_code_taken'] });
      }
      Object.assign(target, fields, { version: version + 1, updatedAt: new Date().toISOString() });
      record(data, 'warehouse.updated', 'warehouse', id);
      return reply(routes.warehouses.update, target);
    }),
  ),

  ...(['archive', 'restore'] as const).map((action) =>
    mock(
      routes.warehouses[action],
      guarded(async ({ request, params }) => {
        const { id } = routes.warehouses[action].params.parse(params);
        const { version } = await readBody(routes.warehouses[action].body, request);
        const data = current();
        const target = data.stock.warehouses.find((place) => place.id === id);
        if (!target) throw new MockProblem(404, 'not_found');
        checkVersion(target.version, version);
        if (action === 'archive') {
          const holds = data.stock.movements
            .filter((movement) => movement.warehouseId === id)
            .reduce((sum, movement) => sum + Number(movement.quantity), 0);
          if (holds !== 0) throw new MockProblem(409, 'warehouse_has_stock');
        }
        Object.assign(target, {
          archivedAt: action === 'archive' ? new Date().toISOString() : null,
          version: version + 1,
        });
        record(
          data,
          action === 'archive' ? 'warehouse.archived' : 'warehouse.restored',
          'warehouse',
          id,
        );
        return reply(routes.warehouses[action], target);
      }),
    ),
  ),

  mock(routes.stock.list, async ({ request }) => {
    const query = readQuery(routes.stock.list.query, request);
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    const all = listStock(current(), query);
    const items = all.slice(start, start + query.limit);
    const end = start + items.length;
    if (start > 0) await delay(300);
    return reply(routes.stock.list, { items, nextCursor: end < all.length ? String(end) : null });
  }),

  mock(
    routes.stock.card,
    guarded(({ params }) => {
      const { id } = routes.stock.card.params.parse(params);
      return reply(routes.stock.card, cardOf(current(), id));
    }),
  ),

  mock(
    routes.stock.movements,
    guarded(({ request, params }) => {
      const { id } = routes.stock.movements.params.parse(params);
      const query = readQuery(routes.stock.movements.query, request);
      const { items, openingBalance, closingBalance } = movementsOf(current(), id, query);
      return reply(routes.stock.movements, {
        items,
        nextCursor: null,
        openingBalance,
        closingBalance,
      });
    }),
  ),

  mock(routes.stock.batches, ({ request }) => {
    const query = readQuery(routes.stock.batches.query, request);
    return reply(routes.stock.batches, { items: batchReport(current(), query), nextCursor: null });
  }),

  mock(routes.stock.reorder, ({ request }) => {
    const query = readQuery(routes.stock.reorder.query, request);
    return reply(routes.stock.reorder, {
      items: reorderReport(current(), query.warehouseId),
      nextCursor: null,
    });
  }),

  mock(
    routes.stock.setReorderLevel,
    guarded(async ({ request }) => {
      const body = await readBody(routes.stock.setReorderLevel.body, request);
      const data = current();
      const saved = setLevel(data, body);
      record(data, 'reorder_level.changed', 'reorder_level', body.variantId);
      return reply(routes.stock.setReorderLevel, saved);
    }),
  ),

  mock(routes.stockAdjustments.list, ({ request }) => {
    const query = readQuery(routes.stockAdjustments.list.query, request);
    const items = current()
      .stock.adjustments.filter(
        (adjustment) =>
          (query.status === undefined || adjustment.status === query.status) &&
          (query.warehouseId === undefined || adjustment.warehouseId === query.warehouseId),
      )
      // A whole adjustment is a summary with its lines: the client's parse drops them
      .toSorted((a, b) => b.date.localeCompare(a.date));
    return reply(routes.stockAdjustments.list, { items, nextCursor: null });
  }),

  mock(
    routes.stockAdjustments.get,
    guarded(({ params }) => {
      const { id } = routes.stockAdjustments.get.params.parse(params);
      return reply(routes.stockAdjustments.get, findAdjustment(current(), id));
    }),
  ),

  mock(
    routes.stockAdjustments.create,
    guarded(async ({ request }) => {
      const { post, ...input } = await readBody(routes.stockAdjustments.create.body, request);
      const data = current();
      const draft = saveAdjustment(data, input);
      record(data, 'stock_adjustment.created', 'stock_adjustment', draft.id);
      const saved = post ? postAdjustment(data, draft) : draft;
      await delay();
      return reply(routes.stockAdjustments.create, saved);
    }),
  ),

  mock(
    routes.stockAdjustments.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.stockAdjustments.update.params.parse(params);
      const { post, version, ...input } = await readBody(
        routes.stockAdjustments.update.body,
        request,
      );
      const data = current();
      const target = findAdjustment(data, id);
      if (target.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
      checkVersion(target.version, version);
      const draft = saveAdjustment(data, input, target);
      record(data, 'stock_adjustment.updated', 'stock_adjustment', id);
      const saved = post ? postAdjustment(data, draft) : draft;
      await delay();
      return reply(routes.stockAdjustments.update, saved);
    }),
  ),

  mock(
    routes.stockAdjustments.remove,
    guarded(({ request, params }) => {
      const { id } = routes.stockAdjustments.remove.params.parse(params);
      const { version } = readQuery(routes.stockAdjustments.remove.query, request);
      const data = current();
      const target = findAdjustment(data, id);
      if (target.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
      checkVersion(target.version, version);
      data.stock.adjustments = data.stock.adjustments.filter((row) => row.id !== id);
      record(data, 'stock_adjustment.deleted', 'stock_adjustment', id);
      return reply(routes.stockAdjustments.remove, undefined);
    }),
  ),

  mock(
    routes.stockAdjustments.post,
    guarded(async ({ request, params }) => {
      const { id } = routes.stockAdjustments.post.params.parse(params);
      const { version } = await readBody(routes.stockAdjustments.post.body, request);
      const data = current();
      const target = findAdjustment(data, id);
      checkVersion(target.version, version);
      const posted = postAdjustment(data, target);
      record(data, 'stock_adjustment.posted', 'stock_adjustment', id);
      return reply(routes.stockAdjustments.post, posted);
    }),
  ),

  mock(routes.stockTransfers.list, ({ request }) => {
    const query = readQuery(routes.stockTransfers.list.query, request);
    const items = current()
      .stock.transfers.filter(
        (transfer) =>
          (query.status === undefined || transfer.status === query.status) &&
          (query.warehouseId === undefined ||
            transfer.fromWarehouseId === query.warehouseId ||
            transfer.toWarehouseId === query.warehouseId),
      )
      .toSorted((a, b) => b.sentOn.localeCompare(a.sentOn));
    return reply(routes.stockTransfers.list, { items, nextCursor: null });
  }),

  mock(
    routes.stockTransfers.get,
    guarded(({ params }) => {
      const { id } = routes.stockTransfers.get.params.parse(params);
      return reply(routes.stockTransfers.get, findTransfer(current(), id));
    }),
  ),

  mock(
    routes.stockTransfers.create,
    guarded(async ({ request }) => {
      const { send, ...input } = await readBody(routes.stockTransfers.create.body, request);
      const data = current();
      const draft = saveTransfer(data, input);
      record(data, 'stock_transfer.created', 'stock_transfer', draft.id);
      const saved = send ? sendTransfer(data, draft) : draft;
      await delay();
      return reply(routes.stockTransfers.create, saved);
    }),
  ),

  mock(
    routes.stockTransfers.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.stockTransfers.update.params.parse(params);
      const { send, version, ...input } = await readBody(
        routes.stockTransfers.update.body,
        request,
      );
      const data = current();
      const target = findTransfer(data, id);
      if (target.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
      checkVersion(target.version, version);
      const draft = saveTransfer(data, input, target);
      record(data, 'stock_transfer.updated', 'stock_transfer', id);
      const saved = send ? sendTransfer(data, draft) : draft;
      await delay();
      return reply(routes.stockTransfers.update, saved);
    }),
  ),

  mock(
    routes.stockTransfers.remove,
    guarded(({ request, params }) => {
      const { id } = routes.stockTransfers.remove.params.parse(params);
      const { version } = readQuery(routes.stockTransfers.remove.query, request);
      const data = current();
      const target = findTransfer(data, id);
      if (target.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
      checkVersion(target.version, version);
      data.stock.transfers = data.stock.transfers.filter((row) => row.id !== id);
      record(data, 'stock_transfer.deleted', 'stock_transfer', id);
      return reply(routes.stockTransfers.remove, undefined);
    }),
  ),

  mock(
    routes.stockTransfers.send,
    guarded(async ({ request, params }) => {
      const { id } = routes.stockTransfers.send.params.parse(params);
      const { version } = await readBody(routes.stockTransfers.send.body, request);
      const data = current();
      const target = findTransfer(data, id);
      checkVersion(target.version, version);
      const sent = sendTransfer(data, target);
      record(data, 'stock_transfer.sent', 'stock_transfer', id);
      return reply(routes.stockTransfers.send, sent);
    }),
  ),

  mock(
    routes.stockTransfers.receive,
    guarded(async ({ request, params }) => {
      const { id } = routes.stockTransfers.receive.params.parse(params);
      const { version, ...input } = await readBody(routes.stockTransfers.receive.body, request);
      const data = current();
      const target = findTransfer(data, id);
      checkVersion(target.version, version);
      const received = receiveTransfer(data, target, input);
      record(data, 'stock_transfer.received', 'stock_transfer', id);
      await delay();
      return reply(routes.stockTransfers.receive, received);
    }),
  ),

  // --- Stock values (step 14) ------------------------------------------------------------------

  mock(routes.stock.valuation, ({ request }) => {
    const query = readQuery(routes.stock.valuation.query, request);
    return reply(routes.stock.valuation, {
      items: valuationList(current(), query),
      nextCursor: null,
    });
  }),

  mock(routes.stock.valuationSummary, () =>
    reply(routes.stock.valuationSummary, valuationSummary(current())),
  ),

  mock(routes.stockRevaluations.list, () =>
    reply(routes.stockRevaluations.list, {
      items: current().stock.revaluations.map((revaluation) => ({
        id: revaluation.id,
        number: revaluation.number,
        date: revaluation.date,
        note: revaluation.note,
        lineCount: revaluation.lineCount,
        difference: revaluation.difference,
        postedAt: revaluation.postedAt,
      })),
      nextCursor: null,
    }),
  ),

  mock(
    routes.stockRevaluations.get,
    guarded(({ params }) => {
      const { id } = routes.stockRevaluations.get.params.parse(params);
      return reply(routes.stockRevaluations.get, findRevaluation(current(), id));
    }),
  ),

  mock(
    routes.stockRevaluations.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.stockRevaluations.create.body, request);
      const data = current();
      const posted = revalue(data, body);
      record(data, 'stock_revaluation.posted', 'stock_revaluation', posted.id, {
        number: { from: null, to: posted.number },
      });
      await delay();
      return reply(routes.stockRevaluations.create, posted);
    }),
  ),

  mock(routes.stockAccounts.get, () => reply(routes.stockAccounts.get, current().stockAccounts)),

  mock(
    routes.stockAccounts.update,
    guarded(async ({ request }) => {
      const body = await readBody(routes.stockAccounts.update.body, request);
      const data = current();
      // The API's rules: an active ledger of a type that fits, never the inventory account
      const fieldErrors: Record<string, ErrorCode[]> = {};
      for (const use of STOCK_ACCOUNT_USES) {
        const account = data.accounts.find((row) => row.id === body[use]);
        if (account?.purpose === 'inventory') fieldErrors[use] = ['stock_account_inventory'];
        else if (
          !account ||
          account.isGroup ||
          account.archivedAt !== null ||
          !accountTypeFits(use, account.type)
        ) {
          fieldErrors[use] = ['stock_account_invalid'];
        }
      }
      const [first] = Object.values(fieldErrors);
      if (first?.[0] !== undefined) throw new MockProblem(409, first[0], fieldErrors);
      const before = data.stockAccounts;
      data.stockAccounts = { ...body };
      record(
        data,
        'stock_accounts.changed',
        'workspace',
        crypto.randomUUID(),
        diff(
          Object.fromEntries(
            STOCK_ACCOUNT_USES.map((use) => [use, codeOf(data.accounts, before[use])]),
          ),
          Object.fromEntries(
            STOCK_ACCOUNT_USES.map((use) => [use, codeOf(data.accounts, body[use])]),
          ),
        ),
      );
      return reply(routes.stockAccounts.update, data.stockAccounts);
    }),
  ),

  // ---------------------------------------------------------------------------------------------
  // VAT rates, customers, customer groups and price lists (step 15a)

  mock(routes.taxRates.list, () =>
    reply(routes.taxRates.list, { items: sortedTaxRates(current().sales) }),
  ),

  mock(
    routes.taxRates.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.taxRates.create.body, request);
      const data = current();
      const created = createTaxRate(data.sales, body);
      record(
        data,
        'tax_rate.created',
        'tax_rate',
        created.id,
        diff({}, { name: created.name, kind: created.kind, rate: created.rate }),
      );
      return reply(routes.taxRates.create, created);
    }),
  ),

  mock(
    routes.taxRates.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.taxRates.update.params.parse(params);
      const body = await readBody(routes.taxRates.update.body, request);
      const data = current();
      const target = findTaxRate(data.sales, id);
      const before = { name: target.name, kind: target.kind, rate: target.rate };
      updateTaxRate(data.sales, target, body);
      record(
        data,
        'tax_rate.updated',
        'tax_rate',
        id,
        diff(before, { name: target.name, kind: target.kind, rate: target.rate }),
      );
      return reply(routes.taxRates.update, target);
    }),
  ),

  ...(['archive', 'restore'] as const).map((action) =>
    mock(
      routes.taxRates[action],
      guarded(async ({ request, params }) => {
        const { id } = routes.taxRates[action].params.parse(params);
        const { version } = await readBody(routes.taxRates[action].body, request);
        const data = current();
        const target = findTaxRate(data.sales, id);
        setTaxRateArchived(target, version, action === 'archive');
        record(
          data,
          action === 'archive' ? 'tax_rate.archived' : 'tax_rate.restored',
          'tax_rate',
          id,
        );
        return reply(routes.taxRates[action], target);
      }),
    ),
  ),

  mock(routes.customers.list, async ({ request }) => {
    const query = readQuery(routes.customers.list.query, request);
    const data = current();
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    const all = listCustomers(data.sales, query);
    const items = all
      .slice(start, start + query.limit)
      .map((item) => customerSummaryOf(data, item));
    const end = start + items.length;
    if (start > 0) await delay(300);
    return reply(routes.customers.list, {
      items,
      nextCursor: end < all.length ? String(end) : null,
    });
  }),

  mock(
    routes.customers.get,
    guarded(({ params }) => {
      const { id } = routes.customers.get.params.parse(params);
      const data = current();
      return reply(routes.customers.get, toCustomer(data, findCustomer(data.sales, id)));
    }),
  ),

  mock(
    routes.customers.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.customers.create.body, request);
      const data = current();
      const saved = saveCustomer(data, body);
      data.sales.customers.push(saved);
      record(
        data,
        'customer.created',
        'customer',
        saved.id,
        diff({}, { code: saved.code, name: saved.name }),
      );
      await delay();
      return reply(routes.customers.create, toCustomer(data, saved));
    }),
  ),

  mock(
    routes.customers.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.customers.update.params.parse(params);
      const { version, ...body } = await readBody(routes.customers.update.body, request);
      const data = current();
      const target = findCustomer(data.sales, id);
      checkVersion(target.version, version);
      const saved = saveCustomer(data, body, target);
      data.sales.customers = data.sales.customers.map((item) => (item.id === id ? saved : item));
      refreshPartyRefs(data, saved);
      // A party that is also a supplier is one row: the supplier page shows the same name
      copyToSupplier(data, saved);
      record(
        data,
        'customer.updated',
        'customer',
        id,
        diff(
          { code: target.code, name: target.name, paymentTermsDays: target.paymentTermsDays },
          { code: saved.code, name: saved.name, paymentTermsDays: saved.paymentTermsDays },
        ),
      );
      await delay();
      return reply(routes.customers.update, toCustomer(data, saved));
    }),
  ),

  ...(['archive', 'restore'] as const).map((action) =>
    mock(
      routes.customers[action],
      guarded(async ({ request, params }) => {
        const { id } = routes.customers[action].params.parse(params);
        const { version } = await readBody(routes.customers[action].body, request);
        const data = current();
        const target = findCustomer(data.sales, id);
        checkVersion(target.version, version);
        // Archiving an archived customer changes nothing, like the API
        if ((target.archivedAt !== null) !== (action === 'archive')) {
          Object.assign(target, {
            archivedAt: action === 'archive' ? new Date().toISOString() : null,
            version: version + 1,
            updatedAt: new Date().toISOString(),
          });
          record(
            data,
            action === 'archive' ? 'customer.archived' : 'customer.restored',
            'customer',
            id,
          );
          // Archived is the party's (decision 10): hidden from purchase documents too
          copyToSupplier(data, target);
        }
        return reply(routes.customers[action], toCustomer(data, target));
      }),
    ),
  ),

  mock(
    routes.customers.remove,
    guarded(({ request, params }) => {
      const { id } = routes.customers.remove.params.parse(params);
      const { version } = readQuery(routes.customers.remove.query, request);
      const data = current();
      const target = findCustomer(data.sales, id);
      checkVersion(target.version, version);
      assertCustomerUnused(data, id);
      data.sales.customers = data.sales.customers.filter((item) => item.id !== id);
      // A party that is also a supplier stays, as a supplier: only its customer side goes
      const supplier = data.suppliers.suppliers.find((item) => item.id === id);
      if (supplier) {
        Object.assign(supplier, {
          isCustomer: false,
          version: supplier.version + 1,
          updatedAt: new Date().toISOString(),
        });
      }
      record(
        data,
        'customer.deleted',
        'customer',
        id,
        diff({ code: target.code, name: target.name }, { code: null, name: null }),
      );
      return reply(routes.customers.remove, undefined);
    }),
  ),

  mock(
    routes.customers.statement,
    guarded(({ request, params }) => {
      const { id } = routes.customers.statement.params.parse(params);
      const query = readQuery(routes.customers.statement.query, request);
      return reply(routes.customers.statement, statementOf(current(), id, query));
    }),
  ),

  // The balances of the rows the customer list shows (step 18a): archived customers too, an id
  // that is no customer here left out
  mock(routes.customers.balances, ({ request }) => {
    const { ids } = readQuery(routes.customers.balances.query, request);
    const data = current();
    const known = new Set(data.sales.customers.map((customer) => customer.id));
    const items = ids
      .filter((id) => known.has(id))
      .map((id) => ({ id, balance: balanceOf(data, id) }));
    return reply(routes.customers.balances, { items });
  }),

  // The credit line on the order and invoice forms (step 15c)
  mock(
    routes.customers.credit,
    guarded(({ params }) => {
      const { id } = routes.customers.credit.params.parse(params);
      return reply(routes.customers.credit, creditOf(current(), id));
    }),
  ),

  // "Make customer too" on a supplier's page (step 17a)
  mock(
    routes.customers.fromSupplier,
    guarded(async ({ request, params }) => {
      const { id } = routes.customers.fromSupplier.params.parse(params);
      const { version } = await readBody(routes.customers.fromSupplier.body, request);
      const data = current();
      const target = findSupplier(data, id);
      checkVersion(target.version, version);
      const created = makeCustomer(data, target);
      record(
        data,
        'customer.created',
        'customer',
        id,
        diff({}, { code: created.code, name: created.name }),
      );
      return reply(routes.customers.fromSupplier, toCustomer(data, created));
    }),
  ),

  mock(routes.customerGroups.list, () => {
    const { sales } = current();
    return reply(routes.customerGroups.list, {
      items: sales.groups
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map((item) => toGroup(sales, item)),
    });
  }),

  mock(
    routes.customerGroups.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.customerGroups.create.body, request);
      const data = current();
      assertGroupNameFree(data.sales, body.name);
      const created = {
        id: crypto.randomUUID(),
        name: body.name,
        version: 1,
        updatedAt: new Date().toISOString(),
      };
      data.sales.groups.push(created);
      record(data, 'customer_group.created', 'customer_group', created.id, {
        name: { from: null, to: created.name },
      });
      return reply(routes.customerGroups.create, toGroup(data.sales, created));
    }),
  ),

  mock(
    routes.customerGroups.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.customerGroups.update.params.parse(params);
      const { version, name } = await readBody(routes.customerGroups.update.body, request);
      const data = current();
      const target = findGroup(data.sales, id);
      checkVersion(target.version, version);
      assertGroupNameFree(data.sales, name, id);
      const before = target.name;
      Object.assign(target, { name, version: version + 1, updatedAt: new Date().toISOString() });
      record(
        data,
        'customer_group.updated',
        'customer_group',
        id,
        diff({ name: before }, { name }),
      );
      return reply(routes.customerGroups.update, toGroup(data.sales, target));
    }),
  ),

  mock(
    routes.customerGroups.remove,
    guarded(({ request, params }) => {
      const { id } = routes.customerGroups.remove.params.parse(params);
      const { version } = readQuery(routes.customerGroups.remove.query, request);
      const data = current();
      const target = findGroup(data.sales, id);
      checkVersion(target.version, version);
      // Archived customers count too (the API's parties_customer_group_fk)
      if (data.sales.customers.some((item) => item.groupId === id)) {
        throw new MockProblem(409, 'customer_group_in_use');
      }
      data.sales.groups = data.sales.groups.filter((item) => item.id !== id);
      record(data, 'customer_group.deleted', 'customer_group', id, {
        name: { from: target.name, to: null },
      });
      return reply(routes.customerGroups.remove, undefined);
    }),
  ),

  mock(routes.priceLists.list, () => {
    const { sales } = current();
    return reply(routes.priceLists.list, {
      items: sales.priceLists
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map((item) => toPriceList(sales, item)),
    });
  }),

  mock(
    routes.priceLists.get,
    guarded(({ params }) => {
      const { id } = routes.priceLists.get.params.parse(params);
      const { sales } = current();
      return reply(routes.priceLists.get, toPriceList(sales, findPriceList(sales, id)));
    }),
  ),

  mock(
    routes.priceLists.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.priceLists.create.body, request);
      const data = current();
      assertPriceListNameFree(data.sales, body.name);
      const created = {
        id: crypto.randomUUID(),
        ...body,
        archivedAt: null,
        version: 1,
        updatedAt: new Date().toISOString(),
      };
      data.sales.priceLists.push(created);
      record(
        data,
        'price_list.created',
        'price_list',
        created.id,
        diff({}, { name: created.name, description: created.description }),
      );
      return reply(routes.priceLists.create, toPriceList(data.sales, created));
    }),
  ),

  mock(
    routes.priceLists.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.priceLists.update.params.parse(params);
      const { version, ...fields } = await readBody(routes.priceLists.update.body, request);
      const data = current();
      const target = findPriceList(data.sales, id);
      checkVersion(target.version, version);
      assertPriceListNameFree(data.sales, fields.name, id);
      const before = { name: target.name, description: target.description };
      Object.assign(target, fields, { version: version + 1, updatedAt: new Date().toISOString() });
      record(data, 'price_list.updated', 'price_list', id, diff(before, fields));
      return reply(routes.priceLists.update, toPriceList(data.sales, target));
    }),
  ),

  ...(['archive', 'restore'] as const).map((action) =>
    mock(
      routes.priceLists[action],
      guarded(async ({ request, params }) => {
        const { id } = routes.priceLists[action].params.parse(params);
        const { version } = await readBody(routes.priceLists[action].body, request);
        const data = current();
        const target = findPriceList(data.sales, id);
        checkVersion(target.version, version);
        if ((target.archivedAt !== null) !== (action === 'archive')) {
          Object.assign(target, {
            archivedAt: action === 'archive' ? new Date().toISOString() : null,
            version: version + 1,
            updatedAt: new Date().toISOString(),
          });
          record(
            data,
            action === 'archive' ? 'price_list.archived' : 'price_list.restored',
            'price_list',
            id,
          );
        }
        return reply(routes.priceLists[action], toPriceList(data.sales, target));
      }),
    ),
  ),

  mock(
    routes.priceLists.items,
    guarded(async ({ request, params }) => {
      const { id } = routes.priceLists.items.params.parse(params);
      const query = readQuery(routes.priceLists.items.query, request);
      const data = current();
      findPriceList(data.sales, id);
      const start = query.cursor === undefined ? 0 : Number(query.cursor);
      const all = priceItemsOf(data, id, query.search);
      const items = all.slice(start, start + query.limit);
      const end = start + items.length;
      if (start > 0) await delay(300);
      return reply(routes.priceLists.items, {
        items,
        nextCursor: end < all.length ? String(end) : null,
      });
    }),
  ),

  mock(
    routes.priceLists.setItems,
    guarded(async ({ request, params }) => {
      const { id } = routes.priceLists.setItems.params.parse(params);
      const body = await readBody(routes.priceLists.setItems.body, request);
      const data = current();
      const target = findPriceList(data.sales, id);
      const counts = setPriceItems(data, target, body);
      record(data, 'price_list.prices_changed', 'price_list', id, diff({}, counts));
      await delay();
      return reply(routes.priceLists.setItems, toPriceList(data.sales, target));
    }),
  ),

  // Quotations, sales orders and deliveries (step 15b). The audit rows carry no field changes:
  // the audit page shows what happened and to which document, which is what the e2e tests read.

  mock(routes.salesPrices.lookup, async ({ request }) => {
    const body = await readBody(routes.salesPrices.lookup.body, request);
    return reply(routes.salesPrices.lookup, lookupPrices(current(), body));
  }),

  mock(routes.quotations.list, ({ request }) => {
    const query = readQuery(routes.quotations.list.query, request);
    return reply(routes.quotations.list, pageOf(listQuotations(current(), query), query));
  }),

  mock(
    routes.quotations.get,
    guarded(({ params }) => {
      const { id } = routes.quotations.get.params.parse(params);
      const data = current();
      return reply(routes.quotations.get, toQuotation(data, findQuotation(data, id)));
    }),
  ),

  mock(
    routes.quotations.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.quotations.create.body, request);
      const data = current();
      const saved = saveQuotation(data, body);
      record(data, 'quotation.created', 'quotation', saved.id);
      await delay();
      return reply(routes.quotations.create, toQuotation(data, saved));
    }),
  ),

  mock(
    routes.quotations.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.quotations.update.params.parse(params);
      const { version, ...input } = await readBody(routes.quotations.update.body, request);
      const data = current();
      const target = findQuotation(data, id);
      checkVersion(target.version, version);
      const saved = saveQuotation(data, input, target);
      record(data, 'quotation.updated', 'quotation', id);
      await delay();
      return reply(routes.quotations.update, toQuotation(data, saved));
    }),
  ),

  mock(
    routes.quotations.remove,
    guarded(({ request, params }) => {
      const { id } = routes.quotations.remove.params.parse(params);
      const { version } = readQuery(routes.quotations.remove.query, request);
      const data = current();
      const target = findQuotation(data, id);
      checkVersion(target.version, version);
      removeQuotation(data, target);
      record(data, 'quotation.deleted', 'quotation', id);
      return reply(routes.quotations.remove, undefined);
    }),
  ),

  ...(['decline', 'reopen'] as const).map((action) =>
    mock(
      routes.quotations[action],
      guarded(async ({ request, params }) => {
        const { id } = routes.quotations[action].params.parse(params);
        const { version } = await readBody(routes.quotations[action].body, request);
        const data = current();
        const target = findQuotation(data, id);
        checkVersion(target.version, version);
        answerQuotation(target, action);
        record(
          data,
          action === 'decline' ? 'quotation.declined' : 'quotation.reopened',
          'quotation',
          id,
        );
        return reply(routes.quotations[action], toQuotation(data, target));
      }),
    ),
  ),

  mock(routes.salesOrders.list, ({ request }) => {
    const query = readQuery(routes.salesOrders.list.query, request);
    return reply(routes.salesOrders.list, pageOf(listOrders(current(), query), query));
  }),

  mock(
    routes.salesOrders.get,
    guarded(({ params }) => {
      const { id } = routes.salesOrders.get.params.parse(params);
      const data = current();
      return reply(routes.salesOrders.get, toOrder(data, findOrder(data, id)));
    }),
  ),

  mock(
    routes.salesOrders.create,
    guarded(async ({ request }) => {
      const { confirm, quotationId, overrideCreditLimit, ...input } = await readBody(
        routes.salesOrders.create.body,
        request,
      );
      const data = current();
      // "Confirm order" on a new form: saved and confirmed in one step, or nothing at all, like
      // the API (step 15c: the credit check may refuse the confirmation)
      const saved = transaction(data, () => {
        const created = createOrder(data, input, quotationId);
        record(data, 'sales_order.created', 'sales_order', created.id);
        if (confirm) confirmAndRecord(data, created, overrideCreditLimit);
        return created;
      });
      await delay();
      return reply(routes.salesOrders.create, toOrder(data, saved));
    }),
  ),

  mock(
    routes.salesOrders.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.salesOrders.update.params.parse(params);
      const { confirm, version, overrideCreditLimit, ...input } = await readBody(
        routes.salesOrders.update.body,
        request,
      );
      const data = current();
      const target = findOrder(data, id);
      checkVersion(target.version, version);
      transaction(data, () => {
        updateOrder(data, target, input);
        record(data, 'sales_order.updated', 'sales_order', id);
        if (confirm) confirmAndRecord(data, target, overrideCreditLimit);
      });
      await delay();
      return reply(routes.salesOrders.update, toOrder(data, target));
    }),
  ),

  mock(
    routes.salesOrders.remove,
    guarded(({ request, params }) => {
      const { id } = routes.salesOrders.remove.params.parse(params);
      const { version } = readQuery(routes.salesOrders.remove.query, request);
      const data = current();
      const target = findOrder(data, id);
      checkVersion(target.version, version);
      removeOrder(data, target);
      record(data, 'sales_order.deleted', 'sales_order', id);
      return reply(routes.salesOrders.remove, undefined);
    }),
  ),

  mock(
    routes.salesOrders.confirm,
    guarded(async ({ request, params }) => {
      const { id } = routes.salesOrders.confirm.params.parse(params);
      const { version, overrideCreditLimit } = await readBody(
        routes.salesOrders.confirm.body,
        request,
      );
      const data = current();
      const target = findOrder(data, id);
      checkVersion(target.version, version);
      transaction(data, () => {
        confirmAndRecord(data, target, overrideCreditLimit);
      });
      return reply(routes.salesOrders.confirm, toOrder(data, target));
    }),
  ),

  ...(['reopen', 'close', 'cancel'] as const).map((action) =>
    mock(
      routes.salesOrders[action],
      guarded(async ({ request, params }) => {
        const { id } = routes.salesOrders[action].params.parse(params);
        const { version } = await readBody(routes.salesOrders[action].body, request);
        const data = current();
        const target = findOrder(data, id);
        checkVersion(target.version, version);
        changeOrderStatus(data, target, action);
        const done = {
          reopen: 'sales_order.reopened',
          close: 'sales_order.closed',
          cancel: 'sales_order.cancelled',
        } as const;
        record(data, done[action], 'sales_order', id);
        return reply(routes.salesOrders[action], toOrder(data, target));
      }),
    ),
  ),

  mock(routes.deliveries.list, ({ request }) => {
    const query = readQuery(routes.deliveries.list.query, request);
    return reply(routes.deliveries.list, pageOf(listDeliveries(current(), query), query));
  }),

  mock(
    routes.deliveries.get,
    guarded(({ params }) => {
      const { id } = routes.deliveries.get.params.parse(params);
      const data = current();
      return reply(routes.deliveries.get, toDelivery(data, findDelivery(data, id)));
    }),
  ),

  mock(
    routes.deliveries.create,
    guarded(async ({ request }) => {
      const { post, ...input } = await readBody(routes.deliveries.create.body, request);
      const data = current();
      const draft = saveDelivery(data, input);
      record(data, 'delivery.created', 'delivery', draft.id);
      // "Post delivery" on a new form: saved and posted in one step, or nothing at all, like the
      // API's transaction
      if (post) {
        try {
          postDelivery(data, draft);
        } catch (error) {
          removeDelivery(data, draft);
          data.audit.shift();
          throw error;
        }
        record(data, 'delivery.posted', 'delivery', draft.id);
      }
      await delay();
      return reply(routes.deliveries.create, toDelivery(data, draft));
    }),
  ),

  mock(
    routes.deliveries.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.deliveries.update.params.parse(params);
      const { post, version, ...input } = await readBody(routes.deliveries.update.body, request);
      const data = current();
      const target = findDelivery(data, id);
      checkVersion(target.version, version);
      const draft = saveDelivery(data, input, target);
      record(data, 'delivery.updated', 'delivery', id);
      if (post) {
        try {
          postDelivery(data, draft);
        } catch (error) {
          // Back to the draft as it was before this save
          data.salesDocuments.deliveries = data.salesDocuments.deliveries.map((item) =>
            item.id === id ? target : item,
          );
          data.audit.shift();
          throw error;
        }
        record(data, 'delivery.posted', 'delivery', id);
      }
      await delay();
      return reply(routes.deliveries.update, toDelivery(data, draft));
    }),
  ),

  mock(
    routes.deliveries.remove,
    guarded(({ request, params }) => {
      const { id } = routes.deliveries.remove.params.parse(params);
      const { version } = readQuery(routes.deliveries.remove.query, request);
      const data = current();
      const target = findDelivery(data, id);
      checkVersion(target.version, version);
      removeDelivery(data, target);
      record(data, 'delivery.deleted', 'delivery', id);
      return reply(routes.deliveries.remove, undefined);
    }),
  ),

  mock(
    routes.deliveries.post,
    guarded(async ({ request, params }) => {
      const { id } = routes.deliveries.post.params.parse(params);
      const { version } = await readBody(routes.deliveries.post.body, request);
      const data = current();
      const target = findDelivery(data, id);
      checkVersion(target.version, version);
      postDelivery(data, target);
      record(data, 'delivery.posted', 'delivery', id);
      return reply(routes.deliveries.post, toDelivery(data, target));
    }),
  ),

  // Invoices and money receipts (step 15c). Every save that also posts runs in a transaction():
  // a refused posting (stock, period lock, credit limit) leaves nothing behind, not even the draft.

  mock(routes.invoices.list, ({ request }) => {
    const query = readQuery(routes.invoices.list.query, request);
    return reply(routes.invoices.list, pageOf(listInvoices(current(), query), query));
  }),

  mock(
    routes.invoices.get,
    guarded(({ params }) => {
      const { id } = routes.invoices.get.params.parse(params);
      const data = current();
      return reply(routes.invoices.get, toInvoice(data, findInvoice(data, id)));
    }),
  ),

  mock(
    routes.invoices.create,
    guarded(async ({ request }) => {
      const { post, overrideCreditLimit, ...input } = await readBody(
        routes.invoices.create.body,
        request,
      );
      const data = current();
      const saved = transaction(data, () => {
        const draft = saveInvoice(data, input);
        record(data, 'invoice.created', 'invoice', draft.id);
        if (post) postAndRecord(data, draft, overrideCreditLimit);
        return draft;
      });
      await delay();
      return reply(routes.invoices.create, toInvoice(data, saved));
    }),
  ),

  mock(
    routes.invoices.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.invoices.update.params.parse(params);
      const { post, overrideCreditLimit, version, ...input } = await readBody(
        routes.invoices.update.body,
        request,
      );
      const data = current();
      const target = findInvoice(data, id);
      checkVersion(target.version, version);
      const saved = transaction(data, () => {
        const draft = saveInvoice(data, input, target);
        record(data, 'invoice.updated', 'invoice', id);
        if (post) postAndRecord(data, draft, overrideCreditLimit);
        return draft;
      });
      await delay();
      return reply(routes.invoices.update, toInvoice(data, saved));
    }),
  ),

  mock(
    routes.invoices.remove,
    guarded(({ request, params }) => {
      const { id } = routes.invoices.remove.params.parse(params);
      const { version } = readQuery(routes.invoices.remove.query, request);
      const data = current();
      const target = findInvoice(data, id);
      checkVersion(target.version, version);
      removeInvoice(data, target);
      record(data, 'invoice.deleted', 'invoice', id);
      return reply(routes.invoices.remove, undefined);
    }),
  ),

  mock(
    routes.invoices.post,
    guarded(async ({ request, params }) => {
      const { id } = routes.invoices.post.params.parse(params);
      const { version, overrideCreditLimit } = await readBody(routes.invoices.post.body, request);
      const data = current();
      const target = findInvoice(data, id);
      checkVersion(target.version, version);
      transaction(data, () => {
        postAndRecord(data, target, overrideCreditLimit);
      });
      return reply(routes.invoices.post, toInvoice(data, target));
    }),
  ),

  mock(routes.receipts.list, ({ request }) => {
    const query = readQuery(routes.receipts.list.query, request);
    return reply(routes.receipts.list, pageOf(listReceipts(current(), query), query));
  }),

  mock(
    routes.receipts.get,
    guarded(({ params }) => {
      const { id } = routes.receipts.get.params.parse(params);
      const data = current();
      return reply(routes.receipts.get, toReceipt(data, findReceipt(data, id)));
    }),
  ),

  mock(
    routes.receipts.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.receipts.create.body, request);
      const data = current();
      const saved = transaction(data, () => {
        const receipt = createReceipt(data, body);
        record(data, 'receipt.created', 'receipt', receipt.id);
        return receipt;
      });
      await delay();
      return reply(routes.receipts.create, toReceipt(data, saved));
    }),
  ),

  mock(
    routes.receipts.allocate,
    guarded(async ({ request, params }) => {
      const { id } = routes.receipts.allocate.params.parse(params);
      const { version, allocations } = await readBody(routes.receipts.allocate.body, request);
      const data = current();
      const target = findReceipt(data, id);
      assertNotVoided(target);
      checkVersion(target.version, version);
      allocateReceipt(data, target, allocations);
      record(data, 'receipt.allocated', 'receipt', id);
      await delay();
      return reply(routes.receipts.allocate, toReceipt(data, target));
    }),
  ),

  mock(
    routes.receipts.void,
    guarded(async ({ request, params }) => {
      const { id } = routes.receipts.void.params.parse(params);
      const { version, ...input } = await readBody(routes.receipts.void.body, request);
      const data = current();
      const target = findReceipt(data, id);
      assertNotVoided(target);
      checkVersion(target.version, version);
      transaction(data, () => {
        voidReceipt(data, target, input);
        record(data, 'receipt.voided', 'receipt', id);
      });
      await delay();
      return reply(routes.receipts.void, toReceipt(data, target));
    }),
  ),

  // Sales returns, credit notes, refunds and the sales returns account (step 15d). Like the
  // invoices: every save that also posts, and every void, runs in a transaction().

  mock(routes.salesReturns.list, ({ request }) => {
    const query = readQuery(routes.salesReturns.list.query, request);
    return reply(routes.salesReturns.list, pageOf(listReturns(current(), query), query));
  }),

  mock(
    routes.salesReturns.get,
    guarded(({ params }) => {
      const { id } = routes.salesReturns.get.params.parse(params);
      const data = current();
      return reply(routes.salesReturns.get, toReturn(data, findReturn(data, id)));
    }),
  ),

  mock(
    routes.salesReturns.create,
    guarded(async ({ request }) => {
      const { post, ...input } = await readBody(routes.salesReturns.create.body, request);
      const data = current();
      const saved = transaction(data, () => {
        const draft = saveReturn(data, input);
        record(data, 'sales_return.created', 'sales_return', draft.id);
        if (post) postReturnAndRecord(data, draft);
        return draft;
      });
      await delay();
      return reply(routes.salesReturns.create, toReturn(data, saved));
    }),
  ),

  mock(
    routes.salesReturns.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.salesReturns.update.params.parse(params);
      const { post, version, ...input } = await readBody(routes.salesReturns.update.body, request);
      const data = current();
      const target = findReturn(data, id);
      checkVersion(target.version, version);
      const saved = transaction(data, () => {
        const draft = saveReturn(data, input, target);
        record(data, 'sales_return.updated', 'sales_return', id);
        if (post) postReturnAndRecord(data, draft);
        return draft;
      });
      await delay();
      return reply(routes.salesReturns.update, toReturn(data, saved));
    }),
  ),

  mock(
    routes.salesReturns.remove,
    guarded(({ request, params }) => {
      const { id } = routes.salesReturns.remove.params.parse(params);
      const { version } = readQuery(routes.salesReturns.remove.query, request);
      const data = current();
      const target = findReturn(data, id);
      checkVersion(target.version, version);
      removeReturn(data, target);
      record(data, 'sales_return.deleted', 'sales_return', id);
      return reply(routes.salesReturns.remove, undefined);
    }),
  ),

  mock(
    routes.salesReturns.post,
    guarded(async ({ request, params }) => {
      const { id } = routes.salesReturns.post.params.parse(params);
      const { version } = await readBody(routes.salesReturns.post.body, request);
      const data = current();
      const target = findReturn(data, id);
      checkVersion(target.version, version);
      transaction(data, () => {
        postReturnAndRecord(data, target);
      });
      return reply(routes.salesReturns.post, toReturn(data, target));
    }),
  ),

  mock(routes.creditNotes.list, ({ request }) => {
    const query = readQuery(routes.creditNotes.list.query, request);
    return reply(routes.creditNotes.list, pageOf(listCreditNotes(current(), query), query));
  }),

  mock(
    routes.creditNotes.get,
    guarded(({ params }) => {
      const { id } = routes.creditNotes.get.params.parse(params);
      const data = current();
      return reply(routes.creditNotes.get, toCreditNote(data, findCreditNote(data, id)));
    }),
  ),

  mock(
    routes.creditNotes.create,
    guarded(async ({ request }) => {
      const { post, ...input } = await readBody(routes.creditNotes.create.body, request);
      const data = current();
      const saved = transaction(data, () => {
        const draft = saveCreditNote(data, input);
        record(data, 'credit_note.created', 'credit_note', draft.id);
        if (post) postCreditNoteAndRecord(data, draft);
        return draft;
      });
      await delay();
      return reply(routes.creditNotes.create, toCreditNote(data, saved));
    }),
  ),

  mock(
    routes.creditNotes.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.creditNotes.update.params.parse(params);
      const { post, version, ...input } = await readBody(routes.creditNotes.update.body, request);
      const data = current();
      const target = findCreditNote(data, id);
      checkVersion(target.version, version);
      const saved = transaction(data, () => {
        const draft = saveCreditNote(data, input, target);
        record(data, 'credit_note.updated', 'credit_note', id);
        if (post) postCreditNoteAndRecord(data, draft);
        return draft;
      });
      await delay();
      return reply(routes.creditNotes.update, toCreditNote(data, saved));
    }),
  ),

  mock(
    routes.creditNotes.remove,
    guarded(({ request, params }) => {
      const { id } = routes.creditNotes.remove.params.parse(params);
      const { version } = readQuery(routes.creditNotes.remove.query, request);
      const data = current();
      const target = findCreditNote(data, id);
      checkVersion(target.version, version);
      removeCreditNote(data, target);
      record(data, 'credit_note.deleted', 'credit_note', id);
      return reply(routes.creditNotes.remove, undefined);
    }),
  ),

  mock(
    routes.creditNotes.post,
    guarded(async ({ request, params }) => {
      const { id } = routes.creditNotes.post.params.parse(params);
      const { version } = await readBody(routes.creditNotes.post.body, request);
      const data = current();
      const target = findCreditNote(data, id);
      checkVersion(target.version, version);
      transaction(data, () => {
        postCreditNoteAndRecord(data, target);
      });
      return reply(routes.creditNotes.post, toCreditNote(data, target));
    }),
  ),

  mock(
    routes.creditNotes.allocate,
    guarded(async ({ request, params }) => {
      const { id } = routes.creditNotes.allocate.params.parse(params);
      const { version, allocations } = await readBody(routes.creditNotes.allocate.body, request);
      const data = current();
      const target = findCreditNote(data, id);
      assertCreditNotePosted(target);
      checkVersion(target.version, version);
      allocateCreditNote(data, target, allocations);
      record(data, 'credit_note.allocated', 'credit_note', id);
      await delay();
      return reply(routes.creditNotes.allocate, toCreditNote(data, target));
    }),
  ),

  mock(routes.refunds.list, ({ request }) => {
    const query = readQuery(routes.refunds.list.query, request);
    return reply(routes.refunds.list, pageOf(listRefunds(current(), query), query));
  }),

  mock(
    routes.refunds.get,
    guarded(({ params }) => {
      const { id } = routes.refunds.get.params.parse(params);
      return reply(routes.refunds.get, findRefund(current(), id));
    }),
  ),

  mock(
    routes.refunds.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.refunds.create.body, request);
      const data = current();
      const saved = transaction(data, () => {
        const refund = createRefund(data, body);
        record(data, 'refund.created', 'refund', refund.id);
        return refund;
      });
      await delay();
      return reply(routes.refunds.create, saved);
    }),
  ),

  mock(
    routes.refunds.void,
    guarded(async ({ request, params }) => {
      const { id } = routes.refunds.void.params.parse(params);
      const { version, ...input } = await readBody(routes.refunds.void.body, request);
      const data = current();
      const target = findRefund(data, id);
      assertRefundNotVoided(target);
      checkVersion(target.version, version);
      transaction(data, () => {
        voidRefund(data, target, input);
        record(data, 'refund.voided', 'refund', id);
      });
      await delay();
      return reply(routes.refunds.void, target);
    }),
  ),

  mock(routes.salesAccounts.get, () => reply(routes.salesAccounts.get, current().salesAccounts)),

  mock(
    routes.salesAccounts.update,
    guarded(async ({ request }) => {
      const { returns } = await readBody(routes.salesAccounts.update.body, request);
      const data = current();
      // The API's rule: an active income ledger; empty = the Sales account itself
      if (returns !== null) {
        const account = data.accounts.find((row) => row.id === returns);
        if (account?.type !== 'income' || account.isGroup || account.archivedAt !== null) {
          throw new MockProblem(409, 'sales_account_invalid', {
            returns: ['sales_account_invalid'],
          });
        }
      }
      const before = data.salesAccounts.returns;
      data.salesAccounts = { returns };
      record(
        data,
        'sales_accounts.changed',
        'workspace',
        crypto.randomUUID(),
        diff(
          { returns: codeOf(data.accounts, before) },
          { returns: codeOf(data.accounts, returns) },
        ),
      );
      return reply(routes.salesAccounts.update, data.salesAccounts);
    }),
  ),
  // --- Step 16: PDFs, emails and share links (document-output-data.ts) ---------------------------
  // The API asks for the send permission on the four routes that send; the mock signs in as the
  // owner, who has it, so it checks nothing.

  mock(
    routes.documentOutput.file,
    guarded(async ({ request, params }) => {
      const { kind, id } = routes.documentOutput.file.params.parse(params);
      const { language } = await readBody(routes.documentOutput.file.body, request);
      return reply(
        routes.documentOutput.file,
        toDocumentFile(requestFile(current(), kind, id, language)),
      );
    }),
  ),

  mock(
    routes.documentOutput.getFile,
    guarded(({ params }) => {
      const { kind, id, fileId } = routes.documentOutput.getFile.params.parse(params);
      return reply(
        routes.documentOutput.getFile,
        toDocumentFile(findFile(current(), kind, id, fileId)),
      );
    }),
  ),

  mock(
    routes.documentOutput.emailDraft,
    guarded(({ request, params }) => {
      const { kind, id } = routes.documentOutput.emailDraft.params.parse(params);
      const { language } = readQuery(routes.documentOutput.emailDraft.query, request);
      return reply(routes.documentOutput.emailDraft, emailDraft(current(), kind, id, language));
    }),
  ),

  mock(
    routes.documentOutput.emails,
    guarded(({ params }) => {
      const { kind, id } = routes.documentOutput.emails.params.parse(params);
      const items = current().documentOutput.emails.filter(
        (email) => email.kind === kind && email.documentId === id,
      );
      return reply(routes.documentOutput.emails, { items: items.map(toDocumentEmail) });
    }),
  ),

  mock(
    routes.documentOutput.sendEmail,
    guarded(async ({ request, params }) => {
      const { kind, id } = routes.documentOutput.sendEmail.params.parse(params);
      const body = await readBody(routes.documentOutput.sendEmail.body, request);
      return reply(
        routes.documentOutput.sendEmail,
        toDocumentEmail(sendEmail(current(), kind, id, body)),
      );
    }),
  ),

  mock(
    routes.documentOutput.shares,
    guarded(({ params }) => {
      const { kind, id } = routes.documentOutput.shares.params.parse(params);
      const items = current().documentOutput.shares.filter(
        (share) => share.kind === kind && share.documentId === id,
      );
      return reply(routes.documentOutput.shares, { items: items.map(toDocumentShare) });
    }),
  ),

  mock(
    routes.documentOutput.createShare,
    guarded(async ({ request, params }) => {
      const { kind, id } = routes.documentOutput.createShare.params.parse(params);
      const { language } = await readBody(routes.documentOutput.createShare.body, request);
      return reply(routes.documentOutput.createShare, createShare(current(), kind, id, language));
    }),
  ),

  mock(
    routes.documentOutput.revokeShare,
    guarded(({ params }) => {
      const { kind, id, shareId } = routes.documentOutput.revokeShare.params.parse(params);
      revokeShare(current(), kind, id, shareId);
      return reply(routes.documentOutput.revokeShare, undefined);
    }),
  ),

  // No login: the customer opens the link. The mock answers its demo links in the first
  // workspace (document-output-data.ts says why it cannot answer a link made in the dialog).
  mock(
    routes.publicDocuments.get,
    guarded(async ({ params }) => {
      const { token } = routes.publicDocuments.get.params.parse(params);
      const shared = publicDocument(dataOf(WORKSPACES[0]), token);
      await delay();
      return reply(routes.publicDocuments.get, shared);
    }),
  ),

  // ---------------------------------------------------------------------------------------------
  // Suppliers, approvals and requisitions (step 17a)

  mock(routes.suppliers.list, async ({ request }) => {
    const query = readQuery(routes.suppliers.list.query, request);
    const data = current();
    const page = pageOf(listSuppliers(data, query), query);
    if (query.cursor !== undefined) await delay(300);
    return reply(routes.suppliers.list, {
      items: page.items.map((item) => supplierSummaryOf(data, item)),
      nextCursor: page.nextCursor,
    });
  }),

  mock(
    routes.suppliers.get,
    guarded(({ params }) => {
      const { id } = routes.suppliers.get.params.parse(params);
      const data = current();
      return reply(routes.suppliers.get, toSupplier(data, findSupplier(data, id)));
    }),
  ),

  mock(
    routes.suppliers.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.suppliers.create.body, request);
      const data = current();
      const saved = saveSupplier(data, body);
      data.suppliers.suppliers.push(saved);
      record(
        data,
        'supplier.created',
        'supplier',
        saved.id,
        diff({}, { code: saved.code, name: saved.name }),
      );
      await delay();
      return reply(routes.suppliers.create, toSupplier(data, saved));
    }),
  ),

  mock(
    routes.suppliers.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.suppliers.update.params.parse(params);
      const { version, ...body } = await readBody(routes.suppliers.update.body, request);
      const data = current();
      const target = findSupplier(data, id);
      checkVersion(target.version, version);
      const saved = saveSupplier(data, body, target);
      data.suppliers.suppliers = data.suppliers.suppliers.map((item) =>
        item.id === id ? saved : item,
      );
      // The journal's lines and the customer side show the new name
      refreshPartyRefs(data, saved);
      copyToCustomer(data, saved);
      record(
        data,
        'supplier.updated',
        'supplier',
        id,
        diff(
          { code: target.code, name: target.name, paymentTermsDays: target.paymentTermsDays },
          { code: saved.code, name: saved.name, paymentTermsDays: saved.paymentTermsDays },
        ),
      );
      await delay();
      return reply(routes.suppliers.update, toSupplier(data, saved));
    }),
  ),

  // "Make supplier too" on a customer's page
  mock(
    routes.suppliers.fromCustomer,
    guarded(async ({ request, params }) => {
      const { id } = routes.suppliers.fromCustomer.params.parse(params);
      const { version } = await readBody(routes.suppliers.fromCustomer.body, request);
      const data = current();
      const target = findCustomer(data.sales, id);
      checkVersion(target.version, version);
      const created = makeSupplier(data, target);
      record(
        data,
        'supplier.created',
        'supplier',
        id,
        diff({}, { code: created.code, name: created.name }),
      );
      return reply(routes.suppliers.fromCustomer, toSupplier(data, created));
    }),
  ),

  ...(['archive', 'restore'] as const).map((action) =>
    mock(
      routes.suppliers[action],
      guarded(async ({ request, params }) => {
        const { id } = routes.suppliers[action].params.parse(params);
        const { version } = await readBody(routes.suppliers[action].body, request);
        const data = current();
        const target = findSupplier(data, id);
        checkVersion(target.version, version);
        if ((target.archivedAt !== null) !== (action === 'archive')) {
          Object.assign(target, {
            archivedAt: action === 'archive' ? new Date().toISOString() : null,
            version: version + 1,
            updatedAt: new Date().toISOString(),
          });
          copyToCustomer(data, target);
          record(
            data,
            action === 'archive' ? 'supplier.archived' : 'supplier.restored',
            'supplier',
            id,
          );
        }
        return reply(routes.suppliers[action], toSupplier(data, target));
      }),
    ),
  ),

  mock(
    routes.suppliers.remove,
    guarded(({ request, params }) => {
      const { id } = routes.suppliers.remove.params.parse(params);
      const { version } = readQuery(routes.suppliers.remove.query, request);
      const data = current();
      const target = findSupplier(data, id);
      checkVersion(target.version, version);
      removeSupplier(data, target);
      record(
        data,
        'supplier.deleted',
        'supplier',
        id,
        diff({ code: target.code, name: target.name }, { code: null, name: null }),
      );
      return reply(routes.suppliers.remove, undefined);
    }),
  ),

  mock(
    routes.suppliers.statement,
    guarded(({ request, params }) => {
      const { id } = routes.suppliers.statement.params.parse(params);
      const query = readQuery(routes.suppliers.statement.query, request);
      return reply(routes.suppliers.statement, statementOf(current(), id, query, 'supplier'));
    }),
  ),

  mock(routes.supplierGroups.list, () => {
    const data = current();
    return reply(routes.supplierGroups.list, {
      items: data.suppliers.groups
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map((item) => toSupplierGroup(data, item)),
    });
  }),

  mock(
    routes.supplierGroups.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.supplierGroups.create.body, request);
      const data = current();
      assertSupplierGroupNameFree(data, body.name);
      const created = {
        id: crypto.randomUUID(),
        name: body.name,
        version: 1,
        updatedAt: new Date().toISOString(),
      };
      data.suppliers.groups.push(created);
      record(data, 'supplier_group.created', 'supplier_group', created.id, {
        name: { from: null, to: created.name },
      });
      return reply(routes.supplierGroups.create, toSupplierGroup(data, created));
    }),
  ),

  mock(
    routes.supplierGroups.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.supplierGroups.update.params.parse(params);
      const { version, name } = await readBody(routes.supplierGroups.update.body, request);
      const data = current();
      const target = findSupplierGroup(data, id);
      checkVersion(target.version, version);
      assertSupplierGroupNameFree(data, name, id);
      const before = target.name;
      Object.assign(target, { name, version: version + 1, updatedAt: new Date().toISOString() });
      record(
        data,
        'supplier_group.updated',
        'supplier_group',
        id,
        diff({ name: before }, { name }),
      );
      return reply(routes.supplierGroups.update, toSupplierGroup(data, target));
    }),
  ),

  mock(
    routes.supplierGroups.remove,
    guarded(({ request, params }) => {
      const { id } = routes.supplierGroups.remove.params.parse(params);
      const { version } = readQuery(routes.supplierGroups.remove.query, request);
      const data = current();
      const target = findSupplierGroup(data, id);
      checkVersion(target.version, version);
      // Archived suppliers count too (the API's parties_supplier_group_fk)
      if (data.suppliers.suppliers.some((item) => item.groupId === id)) {
        throw new MockProblem(409, 'supplier_group_in_use');
      }
      data.suppliers.groups = data.suppliers.groups.filter((item) => item.id !== id);
      record(data, 'supplier_group.deleted', 'supplier_group', id, {
        name: { from: target.name, to: null },
      });
      return reply(routes.supplierGroups.remove, undefined);
    }),
  ),

  // One card per kind of document, in the contract's order (step 17b adds purchase orders)
  mock(routes.approvalRules.list, () =>
    reply(routes.approvalRules.list, {
      items: APPROVAL_DOCUMENTS.map((document) => toRule(current(), document)),
    }),
  ),

  mock(
    routes.approvalRules.update,
    guarded(async ({ request, params }) => {
      const { document } = routes.approvalRules.update.params.parse(params);
      const body = await readBody(routes.approvalRules.update.body, request);
      const data = current();
      const before = describeLevels(toRule(data, document));
      const saved = saveRule(data, document, body);
      record(data, 'approval_rules.changed', 'workspace', workspace.tenantId, {
        [document]: { from: before, to: describeLevels(saved) },
      });
      return reply(routes.approvalRules.update, saved);
    }),
  ),

  mock(routes.approvals.waiting, ({ request }) => {
    const query = readQuery(routes.approvals.waiting.query, request);
    return reply(routes.approvals.waiting, pageOf(waitingList(current()), query));
  }),

  mock(routes.approvals.waitingCount, () =>
    reply(routes.approvals.waitingCount, { count: waitingList(current()).length }),
  ),

  ...(['approve', 'reject'] as const).map((action) =>
    mock(
      routes.approvals[action],
      guarded(async ({ request, params }) => {
        const { document, id } = routes.approvals[action].params.parse(params);
        const body = await readBody(routes.approvals[action].body, request);
        const data = current();
        const decision = action === 'approve' ? 'approved' : 'rejected';
        // Step 17c: the last approval of a bill or a payment posts it; a refused posting (a closed
        // period) fails the approval and leaves the round as it was, like the API's transaction
        transaction(data, () => {
          const { step, count } = decide(data, document, id, decision, body);
          record(
            data,
            action === 'approve' ? 'approval.approved' : 'approval.rejected',
            document,
            id,
            diff(
              {},
              {
                step: `${String(step.position)} of ${String(count)}`,
                role: step.role.name,
                comment: body.comment,
              },
            ),
          );
        });
        await delay();
        return reply(routes.approvals[action], undefined);
      }),
    ),
  ),

  mock(routes.requisitions.list, ({ request }) => {
    const query = readQuery(routes.requisitions.list.query, request);
    const data = current();
    const page = pageOf(listRequisitions(data, query), query);
    return reply(routes.requisitions.list, {
      items: page.items.map((item) => requisitionSummaryOf(data, item)),
      nextCursor: page.nextCursor,
    });
  }),

  mock(
    routes.requisitions.get,
    guarded(({ params }) => {
      const { id } = routes.requisitions.get.params.parse(params);
      const data = current();
      return reply(routes.requisitions.get, toRequisition(data, findRequisition(data, id)));
    }),
  ),

  mock(
    routes.requisitions.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.requisitions.create.body, request);
      const data = current();
      const created = saveRequisition(data, body);
      record(
        data,
        'requisition.created',
        'requisition',
        created.id,
        diff({}, { number: created.number, amount: created.amount }),
      );
      await delay();
      return reply(routes.requisitions.create, toRequisition(data, created));
    }),
  ),

  mock(
    routes.requisitions.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.requisitions.update.params.parse(params);
      const { version, ...body } = await readBody(routes.requisitions.update.body, request);
      const data = current();
      const target = findRequisition(data, id);
      checkVersion(target.version, version);
      const before = target.amount;
      saveRequisition(data, body, target);
      record(
        data,
        'requisition.updated',
        'requisition',
        id,
        diff({ amount: before }, { amount: target.amount }),
      );
      await delay();
      return reply(routes.requisitions.update, toRequisition(data, target));
    }),
  ),

  mock(
    routes.requisitions.remove,
    guarded(({ request, params }) => {
      const { id } = routes.requisitions.remove.params.parse(params);
      const { version } = readQuery(routes.requisitions.remove.query, request);
      const data = current();
      const target = findRequisition(data, id);
      checkVersion(target.version, version);
      removeRequisition(data, target);
      record(
        data,
        'requisition.deleted',
        'requisition',
        id,
        diff({ number: target.number }, { number: null }),
      );
      return reply(routes.requisitions.remove, undefined);
    }),
  ),

  mock(
    routes.requisitions.submit,
    guarded(async ({ request, params }) => {
      const { id } = routes.requisitions.submit.params.parse(params);
      const { version } = await readBody(routes.requisitions.submit.body, request);
      const data = current();
      const target = findRequisition(data, id);
      checkVersion(target.version, version);
      const steps = submitRequisition(data, target);
      record(
        data,
        'approval.submitted',
        'requisition',
        id,
        diff({}, { amount: target.amount, steps, status: target.status }),
      );
      await delay();
      return reply(routes.requisitions.submit, toRequisition(data, target));
    }),
  ),

  mock(
    routes.requisitions.reopen,
    guarded(async ({ request, params }) => {
      const { id } = routes.requisitions.reopen.params.parse(params);
      const { version } = await readBody(routes.requisitions.reopen.body, request);
      const data = current();
      const target = findRequisition(data, id);
      checkVersion(target.version, version);
      const before = target.status;
      reopenRequisition(data, target);
      record(
        data,
        'approval.reopened',
        'requisition',
        id,
        diff({ status: before }, { status: target.status }),
      );
      return reply(routes.requisitions.reopen, toRequisition(data, target));
    }),
  ),

  mock(
    routes.requisitions.cancel,
    guarded(async ({ request, params }) => {
      const { id } = routes.requisitions.cancel.params.parse(params);
      const { version } = await readBody(routes.requisitions.cancel.body, request);
      const data = current();
      const target = findRequisition(data, id);
      checkVersion(target.version, version);
      const before = target.status;
      cancelRequisition(data, target);
      record(
        data,
        'requisition.cancelled',
        'requisition',
        id,
        diff({ status: before }, { status: target.status }),
      );
      return reply(routes.requisitions.cancel, toRequisition(data, target));
    }),
  ),

  mock(
    routes.purchaseCosts.lookup,
    guarded(async ({ request }) => {
      const body = await readBody(routes.purchaseCosts.lookup.body, request);
      return reply(routes.purchaseCosts.lookup, lookupCosts(current(), body));
    }),
  ),

  // ---------------------------------------------------------------------------------------------
  // Purchase orders and goods receipts (step 17b)

  mock(
    routes.requisitions.close,
    guarded(async ({ request, params }) => {
      const { id } = routes.requisitions.close.params.parse(params);
      const { version } = await readBody(routes.requisitions.close.body, request);
      const data = current();
      const target = findRequisition(data, id);
      checkVersion(target.version, version);
      closeRequisition(data, target);
      record(
        data,
        'requisition.closed',
        'requisition',
        id,
        diff({ status: 'approved' }, { status: target.status }),
      );
      return reply(routes.requisitions.close, toRequisition(data, target));
    }),
  ),

  mock(routes.requisitionLines.open, ({ request }) => {
    const { limit, cursor, ...query } = readQuery(routes.requisitionLines.open.query, request);
    return reply(
      routes.requisitionLines.open,
      pageOf(openLines(current(), query), { limit, cursor }),
    );
  }),

  mock(routes.purchaseOrders.list, ({ request }) => {
    const query = readQuery(routes.purchaseOrders.list.query, request);
    const page = pageOf(listPurchaseOrders(current(), query), query);
    return reply(routes.purchaseOrders.list, {
      items: page.items.map(purchaseOrderSummaryOf),
      nextCursor: page.nextCursor,
    });
  }),

  mock(
    routes.purchaseOrders.get,
    guarded(({ params }) => {
      const { id } = routes.purchaseOrders.get.params.parse(params);
      const data = current();
      return reply(routes.purchaseOrders.get, toPurchaseOrder(data, findPurchaseOrder(data, id)));
    }),
  ),

  mock(
    routes.purchaseOrders.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.purchaseOrders.create.body, request);
      const data = current();
      const created = savePurchaseOrder(data, body);
      record(
        data,
        'purchase_order.created',
        'purchase_order',
        created.id,
        diff({}, { supplier: created.supplier.name, total: created.total }),
      );
      await delay();
      return reply(routes.purchaseOrders.create, toPurchaseOrder(data, created));
    }),
  ),

  mock(
    routes.purchaseOrders.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.purchaseOrders.update.params.parse(params);
      const { version, ...body } = await readBody(routes.purchaseOrders.update.body, request);
      const data = current();
      const target = findPurchaseOrder(data, id);
      checkVersion(target.version, version);
      const before = { supplier: target.supplier.name, total: target.total };
      savePurchaseOrder(data, body, target);
      record(
        data,
        'purchase_order.updated',
        'purchase_order',
        id,
        diff(before, { supplier: target.supplier.name, total: target.total }),
      );
      await delay();
      return reply(routes.purchaseOrders.update, toPurchaseOrder(data, target));
    }),
  ),

  mock(
    routes.purchaseOrders.remove,
    guarded(({ request, params }) => {
      const { id } = routes.purchaseOrders.remove.params.parse(params);
      const { version } = readQuery(routes.purchaseOrders.remove.query, request);
      const data = current();
      const target = findPurchaseOrder(data, id);
      checkVersion(target.version, version);
      removePurchaseOrder(data, target);
      record(
        data,
        'purchase_order.deleted',
        'purchase_order',
        id,
        diff({ supplier: target.supplier.name }, { supplier: null }),
      );
      return reply(routes.purchaseOrders.remove, undefined);
    }),
  ),

  mock(
    routes.purchaseOrders.submit,
    guarded(async ({ request, params }) => {
      const { id } = routes.purchaseOrders.submit.params.parse(params);
      const { version } = await readBody(routes.purchaseOrders.submit.body, request);
      const data = current();
      const target = findPurchaseOrder(data, id);
      checkVersion(target.version, version);
      const steps = submitPurchaseOrder(data, target);
      record(
        data,
        'approval.submitted',
        'purchase_order',
        id,
        diff({}, { amount: target.total, steps, status: target.status }),
      );
      await delay();
      return reply(routes.purchaseOrders.submit, toPurchaseOrder(data, target));
    }),
  ),

  // Reopen, close and cancel: the same request, each with its own rule and audit row
  ...(['reopen', 'close', 'cancel'] as const).map((action) =>
    mock(
      routes.purchaseOrders[action],
      guarded(async ({ request, params }) => {
        const { id } = routes.purchaseOrders[action].params.parse(params);
        const { version } = await readBody(routes.purchaseOrders[action].body, request);
        const data = current();
        const target = findPurchaseOrder(data, id);
        checkVersion(target.version, version);
        const before = target.status;
        const change = {
          reopen: () => {
            reopenPurchaseOrder(data, target);
            return 'approval.reopened' as const;
          },
          close: () => {
            closePurchaseOrder(data, target);
            return 'purchase_order.closed' as const;
          },
          cancel: () => {
            cancelPurchaseOrder(data, target);
            return 'purchase_order.cancelled' as const;
          },
        }[action];
        const auditAction = change();
        record(
          data,
          auditAction,
          'purchase_order',
          id,
          diff({ status: before }, { status: target.status }),
        );
        return reply(routes.purchaseOrders[action], toPurchaseOrder(data, target));
      }),
    ),
  ),

  mock(routes.goodsReceipts.list, ({ request }) => {
    const query = readQuery(routes.goodsReceipts.list.query, request);
    return reply(routes.goodsReceipts.list, pageOf(listGoodsReceipts(current(), query), query));
  }),

  mock(
    routes.goodsReceipts.get,
    guarded(({ params }) => {
      const { id } = routes.goodsReceipts.get.params.parse(params);
      const data = current();
      return reply(routes.goodsReceipts.get, toGoodsReceipt(data, findGoodsReceipt(data, id)));
    }),
  ),

  // "Post goods receipt" on a new form: saved and posted in one step, or nothing at all
  mock(
    routes.goodsReceipts.create,
    guarded(async ({ request }) => {
      const { post, orderId, ...input } = await readBody(routes.goodsReceipts.create.body, request);
      const data = current();
      const saved = transaction(data, () => {
        const draft = saveGoodsReceipt(data, orderId, input);
        record(data, 'goods_receipt.created', 'goods_receipt', draft.id);
        if (!post) return draft;
        postGoodsReceipt(data, draft);
        record(
          data,
          'goods_receipt.posted',
          'goods_receipt',
          draft.id,
          diff({}, { number: draft.number, entry: draft.entry?.number ?? null }),
        );
        return draft;
      });
      await delay();
      return reply(routes.goodsReceipts.create, toGoodsReceipt(data, saved));
    }),
  ),

  // The edit form sends no order: a receipt keeps its own (decision 20)
  mock(
    routes.goodsReceipts.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.goodsReceipts.update.params.parse(params);
      const { post, version, ...input } = await readBody(routes.goodsReceipts.update.body, request);
      const data = current();
      const target = findGoodsReceipt(data, id);
      checkVersion(target.version, version);
      const saved = transaction(data, () => {
        const draft = saveGoodsReceipt(data, target.orderId, input, target);
        record(data, 'goods_receipt.updated', 'goods_receipt', id);
        if (!post) return draft;
        postGoodsReceipt(data, draft);
        record(
          data,
          'goods_receipt.posted',
          'goods_receipt',
          id,
          diff({}, { number: draft.number, entry: draft.entry?.number ?? null }),
        );
        return draft;
      });
      await delay();
      return reply(routes.goodsReceipts.update, toGoodsReceipt(data, saved));
    }),
  ),

  mock(
    routes.goodsReceipts.remove,
    guarded(({ request, params }) => {
      const { id } = routes.goodsReceipts.remove.params.parse(params);
      const { version } = readQuery(routes.goodsReceipts.remove.query, request);
      const data = current();
      const target = findGoodsReceipt(data, id);
      checkVersion(target.version, version);
      removeGoodsReceipt(data, target);
      record(data, 'goods_receipt.deleted', 'goods_receipt', id);
      return reply(routes.goodsReceipts.remove, undefined);
    }),
  ),

  mock(
    routes.goodsReceipts.post,
    guarded(async ({ request, params }) => {
      const { id } = routes.goodsReceipts.post.params.parse(params);
      const { version } = await readBody(routes.goodsReceipts.post.body, request);
      const data = current();
      const target = findGoodsReceipt(data, id);
      checkVersion(target.version, version);
      transaction(data, () => {
        postGoodsReceipt(data, target);
        record(
          data,
          'goods_receipt.posted',
          'goods_receipt',
          id,
          diff({}, { number: target.number, entry: target.entry?.number ?? null }),
        );
      });
      await delay();
      return reply(routes.goodsReceipts.post, toGoodsReceipt(data, target));
    }),
  ),
  // --- Step 17c: supplier bills, supplier payments and the purchase accounts (bill-data.ts) ------
  // A save that also submits runs in a transaction(), and so does every submit: the mock's Owner
  // is approved at once, so a submit posts, and a refused posting leaves no new draft behind and
  // an old one as it was, like the API's transaction.

  mock(routes.bills.list, ({ request }) => {
    const query = readQuery(routes.bills.list.query, request);
    return reply(routes.bills.list, pageOf(listBills(current(), query), query));
  }),

  mock(
    routes.bills.get,
    guarded(({ params }) => {
      const { id } = routes.bills.get.params.parse(params);
      const data = current();
      return reply(routes.bills.get, toBill(data, findBill(data, id)));
    }),
  ),

  mock(
    routes.bills.create,
    guarded(async ({ request }) => {
      const { submit, ...input } = await readBody(routes.bills.create.body, request);
      const data = current();
      const saved = transaction(data, () => {
        const draft = saveBill(data, input);
        record(data, 'bill.created', 'bill', draft.id, diff({}, billSnapshot(draft)));
        if (submit) submitBillAndRecord(data, draft);
        return draft;
      });
      await delay();
      return reply(routes.bills.create, toBill(data, saved));
    }),
  ),

  mock(
    routes.bills.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.bills.update.params.parse(params);
      const { submit, version, ...input } = await readBody(routes.bills.update.body, request);
      const data = current();
      const target = findBill(data, id);
      checkVersion(target.version, version);
      const saved = transaction(data, () => {
        const draft = saveBill(data, input, target);
        record(data, 'bill.updated', 'bill', id, diff(billSnapshot(target), billSnapshot(draft)));
        if (submit) submitBillAndRecord(data, draft);
        return draft;
      });
      await delay();
      return reply(routes.bills.update, toBill(data, saved));
    }),
  ),

  mock(
    routes.bills.remove,
    guarded(({ request, params }) => {
      const { id } = routes.bills.remove.params.parse(params);
      const { version } = readQuery(routes.bills.remove.query, request);
      const data = current();
      const target = findBill(data, id);
      checkVersion(target.version, version);
      removeBill(data, target);
      const snapshot = billSnapshot(target);
      record(
        data,
        'bill.deleted',
        'bill',
        id,
        diff(snapshot, Object.fromEntries(Object.keys(snapshot).map((field) => [field, null]))),
      );
      return reply(routes.bills.remove, undefined);
    }),
  ),

  mock(
    routes.bills.submit,
    guarded(async ({ request, params }) => {
      const { id } = routes.bills.submit.params.parse(params);
      const { version } = await readBody(routes.bills.submit.body, request);
      const data = current();
      const target = findBill(data, id);
      checkVersion(target.version, version);
      transaction(data, () => {
        submitBillAndRecord(data, target);
      });
      await delay();
      return reply(routes.bills.submit, toBill(data, target));
    }),
  ),

  // Reopen and cancel: the same request, each with its own rule and audit row
  ...(['reopen', 'cancel'] as const).map((action) =>
    mock(
      routes.bills[action],
      guarded(async ({ request, params }) => {
        const { id } = routes.bills[action].params.parse(params);
        const { version } = await readBody(routes.bills[action].body, request);
        const data = current();
        const target = findBill(data, id);
        checkVersion(target.version, version);
        const before = target.status;
        if (action === 'reopen') reopenBill(data, target);
        else cancelBill(data, target);
        record(
          data,
          action === 'reopen' ? 'approval.reopened' : 'bill.cancelled',
          'bill',
          id,
          diff({ status: before }, { status: target.status }),
        );
        return reply(routes.bills[action], toBill(data, target));
      }),
    ),
  ),

  mock(routes.supplierPayments.list, ({ request }) => {
    const query = readQuery(routes.supplierPayments.list.query, request);
    return reply(routes.supplierPayments.list, pageOf(listPayments(current(), query), query));
  }),

  mock(
    routes.supplierPayments.get,
    guarded(({ params }) => {
      const { id } = routes.supplierPayments.get.params.parse(params);
      const data = current();
      return reply(routes.supplierPayments.get, toSupplierPayment(data, findPayment(data, id)));
    }),
  ),

  mock(
    routes.supplierPayments.create,
    guarded(async ({ request }) => {
      const { submit, ...input } = await readBody(routes.supplierPayments.create.body, request);
      const data = current();
      const saved = transaction(data, () => {
        const draft = savePayment(data, input);
        record(
          data,
          'supplier_payment.created',
          'supplier_payment',
          draft.id,
          diff({}, paymentSnapshot(draft)),
        );
        if (submit) submitPaymentAndRecord(data, draft);
        return draft;
      });
      await delay();
      return reply(routes.supplierPayments.create, toSupplierPayment(data, saved));
    }),
  ),

  mock(
    routes.supplierPayments.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.supplierPayments.update.params.parse(params);
      const { submit, version, ...input } = await readBody(
        routes.supplierPayments.update.body,
        request,
      );
      const data = current();
      const target = findPayment(data, id);
      checkVersion(target.version, version);
      const saved = transaction(data, () => {
        const draft = savePayment(data, input, target);
        record(
          data,
          'supplier_payment.updated',
          'supplier_payment',
          id,
          diff(paymentSnapshot(target), paymentSnapshot(draft)),
        );
        if (submit) submitPaymentAndRecord(data, draft);
        return draft;
      });
      await delay();
      return reply(routes.supplierPayments.update, toSupplierPayment(data, saved));
    }),
  ),

  mock(
    routes.supplierPayments.remove,
    guarded(({ request, params }) => {
      const { id } = routes.supplierPayments.remove.params.parse(params);
      const { version } = readQuery(routes.supplierPayments.remove.query, request);
      const data = current();
      const target = findPayment(data, id);
      checkVersion(target.version, version);
      removePayment(data, target);
      const snapshot = paymentSnapshot(target);
      record(
        data,
        'supplier_payment.deleted',
        'supplier_payment',
        id,
        diff(snapshot, Object.fromEntries(Object.keys(snapshot).map((field) => [field, null]))),
      );
      return reply(routes.supplierPayments.remove, undefined);
    }),
  ),

  mock(
    routes.supplierPayments.submit,
    guarded(async ({ request, params }) => {
      const { id } = routes.supplierPayments.submit.params.parse(params);
      const { version } = await readBody(routes.supplierPayments.submit.body, request);
      const data = current();
      const target = findPayment(data, id);
      checkVersion(target.version, version);
      transaction(data, () => {
        submitPaymentAndRecord(data, target);
      });
      await delay();
      return reply(routes.supplierPayments.submit, toSupplierPayment(data, target));
    }),
  ),

  ...(['reopen', 'cancel'] as const).map((action) =>
    mock(
      routes.supplierPayments[action],
      guarded(async ({ request, params }) => {
        const { id } = routes.supplierPayments[action].params.parse(params);
        const { version } = await readBody(routes.supplierPayments[action].body, request);
        const data = current();
        const target = findPayment(data, id);
        checkVersion(target.version, version);
        const before = target.status;
        if (action === 'reopen') reopenPayment(data, target);
        else cancelPayment(data, target);
        record(
          data,
          action === 'reopen' ? 'approval.reopened' : 'supplier_payment.cancelled',
          'supplier_payment',
          id,
          diff({ status: before }, { status: target.status }),
        );
        return reply(routes.supplierPayments[action], toSupplierPayment(data, target));
      }),
    ),
  ),

  mock(
    routes.supplierPayments.allocate,
    guarded(async ({ request, params }) => {
      const { id } = routes.supplierPayments.allocate.params.parse(params);
      const { version, allocations } = await readBody(
        routes.supplierPayments.allocate.body,
        request,
      );
      const data = current();
      const target = findPayment(data, id);
      checkVersion(target.version, version);
      const before = paymentSummaryOf(data, target).applied;
      allocatePayment(data, target, allocations);
      record(
        data,
        'supplier_payment.allocated',
        'supplier_payment',
        id,
        diff({ applied: before }, { applied: paymentSummaryOf(data, target).applied }),
      );
      await delay();
      return reply(routes.supplierPayments.allocate, toSupplierPayment(data, target));
    }),
  ),

  mock(
    routes.supplierPayments.void,
    guarded(async ({ request, params }) => {
      const { id } = routes.supplierPayments.void.params.parse(params);
      const { version, ...input } = await readBody(routes.supplierPayments.void.body, request);
      const data = current();
      const target = findPayment(data, id);
      checkVersion(target.version, version);
      transaction(data, () => {
        voidPayment(data, target, input);
        record(
          data,
          'supplier_payment.voided',
          'supplier_payment',
          id,
          diff(
            {},
            { date: input.date, reason: input.reason, reversal: target.voidEntry?.number ?? null },
          ),
        );
      });
      await delay();
      return reply(routes.supplierPayments.void, toSupplierPayment(data, target));
    }),
  ),

  // --- Step 17d: purchase returns, debit notes and supplier refunds (purchase-return-data.ts) -----
  // No approval (decision 5): "Post" posts. Like the sales returns of 15d, every save that also
  // posts, and every void, runs in a transaction().

  mock(routes.purchaseReturns.list, ({ request }) => {
    const query = readQuery(routes.purchaseReturns.list.query, request);
    return reply(routes.purchaseReturns.list, pageOf(listPurchaseReturns(current(), query), query));
  }),

  mock(
    routes.purchaseReturns.get,
    guarded(({ params }) => {
      const { id } = routes.purchaseReturns.get.params.parse(params);
      const data = current();
      return reply(
        routes.purchaseReturns.get,
        toPurchaseReturn(data, findPurchaseReturn(data, id)),
      );
    }),
  ),

  mock(
    routes.purchaseReturns.create,
    guarded(async ({ request }) => {
      const { post, ...input } = await readBody(routes.purchaseReturns.create.body, request);
      const data = current();
      const saved = transaction(data, () => {
        const draft = savePurchaseReturn(data, input);
        record(data, 'purchase_return.created', 'purchase_return', draft.id);
        if (post) postPurchaseReturnAndRecord(data, draft);
        return draft;
      });
      await delay();
      return reply(routes.purchaseReturns.create, toPurchaseReturn(data, saved));
    }),
  ),

  mock(
    routes.purchaseReturns.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.purchaseReturns.update.params.parse(params);
      const { post, version, ...input } = await readBody(
        routes.purchaseReturns.update.body,
        request,
      );
      const data = current();
      const target = findPurchaseReturn(data, id);
      checkVersion(target.version, version);
      const saved = transaction(data, () => {
        const draft = savePurchaseReturn(data, input, target);
        record(data, 'purchase_return.updated', 'purchase_return', id);
        if (post) postPurchaseReturnAndRecord(data, draft);
        return draft;
      });
      await delay();
      return reply(routes.purchaseReturns.update, toPurchaseReturn(data, saved));
    }),
  ),

  mock(
    routes.purchaseReturns.remove,
    guarded(({ request, params }) => {
      const { id } = routes.purchaseReturns.remove.params.parse(params);
      const { version } = readQuery(routes.purchaseReturns.remove.query, request);
      const data = current();
      const target = findPurchaseReturn(data, id);
      checkVersion(target.version, version);
      removePurchaseReturn(data, target);
      record(data, 'purchase_return.deleted', 'purchase_return', id);
      return reply(routes.purchaseReturns.remove, undefined);
    }),
  ),

  mock(
    routes.purchaseReturns.post,
    guarded(async ({ request, params }) => {
      const { id } = routes.purchaseReturns.post.params.parse(params);
      const { version } = await readBody(routes.purchaseReturns.post.body, request);
      const data = current();
      const target = findPurchaseReturn(data, id);
      checkVersion(target.version, version);
      transaction(data, () => {
        postPurchaseReturnAndRecord(data, target);
      });
      return reply(routes.purchaseReturns.post, toPurchaseReturn(data, target));
    }),
  ),

  mock(routes.debitNotes.list, ({ request }) => {
    const query = readQuery(routes.debitNotes.list.query, request);
    return reply(routes.debitNotes.list, pageOf(listDebitNotes(current(), query), query));
  }),

  mock(
    routes.debitNotes.get,
    guarded(({ params }) => {
      const { id } = routes.debitNotes.get.params.parse(params);
      const data = current();
      return reply(routes.debitNotes.get, toDebitNote(data, findDebitNote(data, id)));
    }),
  ),

  mock(
    routes.debitNotes.create,
    guarded(async ({ request }) => {
      const { post, ...input } = await readBody(routes.debitNotes.create.body, request);
      const data = current();
      const saved = transaction(data, () => {
        const draft = saveDebitNote(data, input);
        record(data, 'debit_note.created', 'debit_note', draft.id);
        if (post) postDebitNoteAndRecord(data, draft);
        return draft;
      });
      await delay();
      return reply(routes.debitNotes.create, toDebitNote(data, saved));
    }),
  ),

  mock(
    routes.debitNotes.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.debitNotes.update.params.parse(params);
      const { post, version, ...input } = await readBody(routes.debitNotes.update.body, request);
      const data = current();
      const target = findDebitNote(data, id);
      checkVersion(target.version, version);
      const saved = transaction(data, () => {
        const draft = saveDebitNote(data, input, target);
        record(data, 'debit_note.updated', 'debit_note', id);
        if (post) postDebitNoteAndRecord(data, draft);
        return draft;
      });
      await delay();
      return reply(routes.debitNotes.update, toDebitNote(data, saved));
    }),
  ),

  mock(
    routes.debitNotes.remove,
    guarded(({ request, params }) => {
      const { id } = routes.debitNotes.remove.params.parse(params);
      const { version } = readQuery(routes.debitNotes.remove.query, request);
      const data = current();
      const target = findDebitNote(data, id);
      checkVersion(target.version, version);
      removeDebitNote(data, target);
      record(data, 'debit_note.deleted', 'debit_note', id);
      return reply(routes.debitNotes.remove, undefined);
    }),
  ),

  mock(
    routes.debitNotes.post,
    guarded(async ({ request, params }) => {
      const { id } = routes.debitNotes.post.params.parse(params);
      const { version } = await readBody(routes.debitNotes.post.body, request);
      const data = current();
      const target = findDebitNote(data, id);
      checkVersion(target.version, version);
      transaction(data, () => {
        postDebitNoteAndRecord(data, target);
      });
      return reply(routes.debitNotes.post, toDebitNote(data, target));
    }),
  ),

  mock(
    routes.debitNotes.allocate,
    guarded(async ({ request, params }) => {
      const { id } = routes.debitNotes.allocate.params.parse(params);
      const { version, allocations } = await readBody(routes.debitNotes.allocate.body, request);
      const data = current();
      const target = findDebitNote(data, id);
      assertDebitNotePosted(target);
      checkVersion(target.version, version);
      const before = toDebitNote(data, target).applied;
      allocateDebitNote(data, target, allocations);
      record(
        data,
        'debit_note.allocated',
        'debit_note',
        id,
        diff({ applied: before }, { applied: toDebitNote(data, target).applied }),
      );
      await delay();
      return reply(routes.debitNotes.allocate, toDebitNote(data, target));
    }),
  ),

  mock(routes.supplierRefunds.list, ({ request }) => {
    const query = readQuery(routes.supplierRefunds.list.query, request);
    return reply(routes.supplierRefunds.list, pageOf(listSupplierRefunds(current(), query), query));
  }),

  mock(
    routes.supplierRefunds.get,
    guarded(({ params }) => {
      const { id } = routes.supplierRefunds.get.params.parse(params);
      return reply(routes.supplierRefunds.get, findSupplierRefund(current(), id));
    }),
  ),

  mock(
    routes.supplierRefunds.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.supplierRefunds.create.body, request);
      const data = current();
      const saved = transaction(data, () => {
        const refund = createSupplierRefund(data, body);
        record(
          data,
          'supplier_refund.created',
          'supplier_refund',
          refund.id,
          diff(
            {},
            {
              number: refund.number,
              amount: refund.amount,
              source: refund.source.number,
              entry: refund.entry.number,
            },
          ),
        );
        return refund;
      });
      await delay();
      return reply(routes.supplierRefunds.create, saved);
    }),
  ),

  mock(
    routes.supplierRefunds.void,
    guarded(async ({ request, params }) => {
      const { id } = routes.supplierRefunds.void.params.parse(params);
      const { version, ...input } = await readBody(routes.supplierRefunds.void.body, request);
      const data = current();
      const target = findSupplierRefund(data, id);
      assertSupplierRefundNotVoided(target);
      checkVersion(target.version, version);
      transaction(data, () => {
        voidSupplierRefund(data, target, input);
        record(
          data,
          'supplier_refund.voided',
          'supplier_refund',
          id,
          diff(
            {},
            { date: input.date, reason: input.reason, reversal: target.voidEntry?.number ?? null },
          ),
        );
      });
      await delay();
      return reply(routes.supplierRefunds.void, target);
    }),
  ),

  mock(routes.purchaseAccounts.get, () =>
    reply(routes.purchaseAccounts.get, current().purchaseAccounts),
  ),

  mock(
    routes.purchaseAccounts.update,
    guarded(async ({ request }) => {
      const input = await readBody(routes.purchaseAccounts.update.body, request);
      const data = current();
      // The API's rule: an active expense ledger, under its own field
      const issues = (['priceDifference', 'services'] as const).flatMap((field) => {
        const id = input[field];
        if (id === null) return [];
        const account = data.accounts.find((row) => row.id === id);
        return account?.type === 'expense' && !account.isGroup && account.archivedAt === null
          ? []
          : [field];
      });
      if (issues.length > 0) {
        throw new MockProblem(
          409,
          'purchase_account_invalid',
          Object.fromEntries(issues.map((field) => [field, ['purchase_account_invalid']])),
        );
      }
      const before = data.purchaseAccounts;
      data.purchaseAccounts = { priceDifference: input.priceDifference, services: input.services };
      record(
        data,
        'purchase_accounts.changed',
        'workspace',
        workspace.tenantId,
        diff(
          {
            priceDifference: codeOf(data.accounts, before.priceDifference),
            services: codeOf(data.accounts, before.services),
          },
          {
            priceDifference: codeOf(data.accounts, input.priceDifference),
            services: codeOf(data.accounts, input.services),
          },
        ),
      );
      return reply(routes.purchaseAccounts.update, data.purchaseAccounts);
    }),
  ),

  // Step 18a: the device and its pulls (sync-data.ts). The mock's person is always the owner.
  mock(
    routes.sync.registerDevice,
    guarded(async ({ request }) => {
      const body = await readBody(routes.sync.registerDevice.body, request);
      const data = current();
      const { device, branchCode } = registerDevice(data, OWNER.id, body);
      // The API's audit row, for a new device only
      if (branchCode !== null) {
        record(data, 'device.registered', 'device', device.id, {
          name: { from: null, to: device.name },
          branch: { from: null, to: branchCode },
        });
      }
      return reply(routes.sync.registerDevice, device);
    }),
  ),

  mock(
    routes.sync.pull,
    guarded(({ request }) => {
      const query = readQuery(routes.sync.pull.query, request);
      return reply(routes.sync.pull, pull(current(), workspace.tenantId, OWNER.id, query));
    }),
  ),

  // Step 18b: the commands a device saved offline (push-data.ts)
  mock(
    routes.sync.push,
    guarded(async ({ request }) => {
      const body = await readBody(routes.sync.push.body, request);
      const answer = push(current(), OWNER.id, body);
      await delay();
      return reply(routes.sync.push, answer);
    }),
  ),
];
