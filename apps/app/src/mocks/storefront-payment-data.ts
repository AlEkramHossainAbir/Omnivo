import {
  addMoney,
  compareMoney,
  type CreateStorefrontPaymentGatewayInput,
  type ErrorCode,
  isZeroMoney,
  moneyAccountIds,
  type PaymentMethod,
  percentOfMoney,
  type ShopPaymentMethod,
  type StorefrontAccountChoice,
  type StorefrontOrderPayment,
  type StorefrontPaymentGateway,
  type StorefrontPaymentSetup,
  subtractMoney,
  sumMoney,
  todayIn,
  type UpdateStorefrontPaymentGatewayInput,
} from '@omnivo/contracts';

import {
  allocateReceipt,
  createReceipt,
  dueOn,
  findInvoice,
  findReceipt,
  refundedFrom,
} from './invoice-data';
import { MockProblem } from './mock';
import { findOrder } from './sales-document-data';
import { branchOf } from './stock-data';
import type { MockGateway, MockShopOrder, MockShopPayment } from './storefront-seed';
import type { WorkspaceData } from './workspace-data';

// Step 27d: the shop's online payment in the ERP, with the API's rules: the Online payment card
// (apps/api/src/storefront/admin/payment-gateway.service.ts) and the money receipt each paid try
// makes (storefront/orders/payment-receipts.ts). The mock has no gateway to ask: its orders' tries
// are seeded as the API would have left them, and "Test connection" answers like the API's
// FakeGateway (the store ids fake_rejected and fake_unreachable).
//
// This file imports no other storefront mock file but the seed's types: storefront-data.ts (the
// settings' Pay online check) and storefront-order-data.ts (the order's view, Delivered) import it,
// and workspace-data.ts seeds through them. The audit rows are the handlers' (handlers.ts).

function now(): string {
  return new Date().toISOString();
}

// 422, as the API answers these (storefront-data.ts's own fieldProblem answers 409)
function fieldProblem(code: ErrorCode, field: string): MockProblem {
  return new MockProblem(422, code, { [field]: [code] });
}

function notSetUp(): MockProblem {
  return new MockProblem(404, 'storefront_gateway_not_set_up');
}

// ---------------------------------------------------------------------------------------------
// The Online payment card

// What the two selects offer, read like the API's chartOf(): a money account is a posting account
// that holds money (itself or a group above it); a fee account an active expense posting account
function chartOf(data: WorkspaceData): {
  moneyAccounts: StorefrontAccountChoice[];
  feeAccounts: StorefrontAccountChoice[];
} {
  const accounts = [...data.accounts].sort((a, b) => a.code.localeCompare(b.code));
  const money = moneyAccountIds(accounts);
  const choice = ({ id, code, name }: (typeof accounts)[number]) => ({ id, code, name });
  return {
    moneyAccounts: accounts.filter((account) => money.has(account.id)).map(choice),
    feeAccounts: accounts
      .filter(
        (account) => account.type === 'expense' && !account.isGroup && account.archivedAt === null,
      )
      .map(choice),
  };
}

// storefront_online_ready(): the gateway is saved and both its accounts still fit
export function onlineReady(data: WorkspaceData): boolean {
  const gateway = data.storefront.gateway;
  if (gateway === null) return false;
  const chart = chartOf(data);
  return (
    chart.moneyAccounts.some((account) => account.id === gateway.moneyAccountId) &&
    chart.feeAccounts.some((account) => account.id === gateway.feeAccountId)
  );
}

// The shop's settings: Pay online may be ticked only once the card is ready. Only a newly ticked
// box is checked, so a shop whose account was archived since can still save its other settings
// (and untick it)
export function checkOnline(
  data: WorkspaceData,
  methods: readonly ShopPaymentMethod[],
  before: readonly ShopPaymentMethod[],
): void {
  if (!methods.includes('online') || before.includes('online') || onlineReady(data)) return;
  throw fieldProblem('storefront_online_not_ready', 'paymentMethods');
}

// Never the password: the card shows only that one is saved
export function toGateway(data: WorkspaceData, gateway: MockGateway): StorefrontPaymentGateway {
  return {
    provider: gateway.provider,
    storeId: gateway.storeId,
    mode: gateway.mode,
    moneyAccountId: gateway.moneyAccountId,
    feeAccountId: gateway.feeAccountId,
    ready: onlineReady(data),
    lastTest: gateway.lastTest,
    version: gateway.version,
    updatedAt: gateway.updatedAt,
  };
}

export function gatewaySetup(data: WorkspaceData): StorefrontPaymentSetup {
  const chart = chartOf(data);
  const gateway = data.storefront.gateway;
  return {
    gateway: gateway === null ? null : toGateway(data, gateway),
    moneyAccounts: chart.moneyAccounts,
    feeAccounts: chart.feeAccounts,
  };
}

function checkAccounts(
  data: WorkspaceData,
  input: { moneyAccountId: string; feeAccountId: string },
) {
  const chart = chartOf(data);
  if (!chart.moneyAccounts.some((account) => account.id === input.moneyAccountId)) {
    throw fieldProblem('storefront_gateway_money_account_invalid', 'moneyAccountId');
  }
  if (!chart.feeAccounts.some((account) => account.id === input.feeAccountId)) {
    throw fieldProblem('storefront_gateway_fee_account_invalid', 'feeAccountId');
  }
}

// The audit's view, as the API's snapshot(): never the password
export function gatewaySnapshot(gateway: MockGateway) {
  return {
    storeId: gateway.storeId,
    mode: gateway.mode,
    moneyAccount: gateway.moneyAccountId,
    feeAccount: gateway.feeAccountId,
  };
}

export function createGateway(
  data: WorkspaceData,
  input: CreateStorefrontPaymentGatewayInput,
): MockGateway {
  if (data.storefront.gateway !== null) {
    throw new MockProblem(409, 'storefront_gateway_set_up_already');
  }
  checkAccounts(data, input);
  const gateway: MockGateway = {
    provider: 'sslcommerz',
    storeId: input.storeId,
    mode: input.mode,
    password: input.password,
    moneyAccountId: input.moneyAccountId,
    feeAccountId: input.feeAccountId,
    lastTest: null,
    version: 1,
    updatedAt: now(),
  };
  data.storefront.gateway = gateway;
  return gateway;
}

// An empty password keeps the saved one. A change to what the last test reached (the store id,
// the password, the mode) clears that test: it said something about the old values
export function updateGateway(
  data: WorkspaceData,
  input: UpdateStorefrontPaymentGatewayInput,
): { before: MockGateway; after: MockGateway; passwordChanged: boolean } {
  const before = data.storefront.gateway;
  if (before === null) throw notSetUp();
  if (before.version !== input.version) throw new MockProblem(409, 'version_conflict');
  checkAccounts(data, input);
  const passwordChanged = input.password !== '' && input.password !== before.password;
  const reach = passwordChanged || input.storeId !== before.storeId || input.mode !== before.mode;
  const after: MockGateway = {
    ...before,
    storeId: input.storeId,
    mode: input.mode,
    password: passwordChanged ? input.password : before.password,
    moneyAccountId: input.moneyAccountId,
    feeAccountId: input.feeAccountId,
    lastTest: reach ? null : before.lastTest,
    version: before.version + 1,
    updatedAt: now(),
  };
  data.storefront.gateway = after;
  return { before, after, passwordChanged };
}

// "Test connection", as the API's FakeGateway answers it: two store ids stand for SSLCommerz on a
// bad day, every other one works. A refusal is an answer, kept on the card, not an error. The test
// is not a change of the account, so its version stays
export function testGateway(data: WorkspaceData): MockGateway {
  const gateway = data.storefront.gateway;
  if (gateway === null) throw notSetUp();
  const problem =
    gateway.storeId === 'fake_rejected'
      ? 'rejected'
      : gateway.storeId === 'fake_unreachable'
        ? 'unreachable'
        : null;
  gateway.lastTest = { at: now(), problem };
  return gateway;
}

// ---------------------------------------------------------------------------------------------
// The order's tries and their receipts

export function toPayment(data: WorkspaceData, payment: MockShopPayment): StorefrontOrderPayment {
  const receipt =
    payment.receiptId === null
      ? undefined
      : data.billing.receipts.find((item) => item.id === payment.receiptId);
  return {
    id: payment.id,
    tranId: payment.tranId,
    status: payment.status,
    amount: payment.amount,
    startedAt: payment.startedAt,
    settledAt: payment.settledAt,
    cardType: payment.cardType,
    bankTranId: payment.bankTranId,
    storeAmount: payment.storeAmount,
    receipt: receipt === undefined ? null : { id: receipt.id, number: receipt.number },
    receiptError: payment.receiptError,
  };
}

// The API's receiptMethodOf(): SSLCommerz's card_type starts with the brand ("BKASH-BKash",
// "VISA-Dutch Bangla"); a wallet or a card, else a bank transfer (internet banking)
const WALLETS = ['BKASH', 'NAGAD', 'ROCKET', 'UPAY', 'MCASH', 'TCASH', 'DBBLMOBILEB', 'OKWALLET'];
const CARDS = ['VISA', 'MASTER', 'AMEX', 'UNIONPAY', 'NEXUS', 'DBBL', 'QCASH'];

function receiptMethodOf(cardType: string | null): PaymentMethod {
  const brand = (cardType ?? '').split('-')[0]?.toUpperCase().replace(/\s+/g, '') ?? '';
  if (WALLETS.some((wallet) => brand.startsWith(wallet))) return 'mobile_wallet';
  if (CARDS.some((card) => brand.startsWith(card))) return 'card';
  return 'bank_transfer';
}

// What is left of a receipt to apply: its amount less what invoices took and refunds paid back
function leftOf(data: WorkspaceData, receiptId: string): string {
  const receipt = findReceipt(data, receiptId);
  const applied = sumMoney(receipt.allocations.map((allocation) => allocation.amount));
  return subtractMoney(
    subtractMoney(receipt.amount, applied),
    refundedFrom(data, 'receipt', receiptId),
  );
}

// Applies the paid tries' advances to the order's invoice, the oldest first, each as much as the
// invoice still owes. A second payment finds nothing left and stays an advance (decision 6)
export function applyPaymentsToInvoice(
  data: WorkspaceData,
  order: MockShopOrder,
  invoiceId: string,
): void {
  const invoice = findInvoice(data, invoiceId);
  for (const payment of order.payments) {
    if (payment.receiptId === null) continue;
    const due = dueOn(data, invoice);
    if (!(compareMoney(due, '0') > 0)) return;
    const left = leftOf(data, payment.receiptId);
    const amount = compareMoney(left, due) < 0 ? left : due;
    if (!(compareMoney(amount, '0') > 0)) continue;
    const receipt = findReceipt(data, payment.receiptId);
    allocateReceipt(data, receipt, [...receipt.allocations, { invoiceId, amount }]);
  }
}

// One paid try's posted receipt (the API's makeIn): the sales order's customer and branch, the
// gateway's money account, the bank's own number as the reference, the fee to the fee account.
// Throws the receipt's own refusal, which the caller keeps on the try
function makeReceiptIn(
  data: WorkspaceData,
  order: MockShopOrder,
  payment: MockShopPayment,
  at: string,
): string {
  const gateway = data.storefront.gateway;
  if (gateway === null || order.salesOrderId === null) {
    throw new MockProblem(409, 'storefront_order_step_invalid');
  }
  const salesOrder = findOrder(data, order.salesOrderId);
  const branchId = branchOf(data, salesOrder.warehouseId);
  if (branchId === null) throw new Error(`Warehouse ${salesOrder.warehouseId} has no branch`);
  const fee = subtractMoney(payment.amount, payment.storeAmount ?? payment.amount);
  const receipt = createReceipt(
    data,
    {
      customerId: salesOrder.customer.id,
      date: todayIn(data.settings.timezone, new Date(at)),
      amount: addMoney(payment.amount, '0'),
      accountId: gateway.moneyAccountId,
      method: receiptMethodOf(payment.cardType),
      reference: [payment.bankTranId ?? payment.tranId, payment.cardType]
        .filter((part) => part !== null)
        .join(' · ')
        .slice(0, 60),
      branchId,
      note: `Paid online for shop order ${order.orderNo} (SSLCommerz ${payment.tranId})`,
      allocations: [],
    },
    isZeroMoney(fee) ? null : { accountId: gateway.feeAccountId, amount: fee },
  );
  payment.receiptId = receipt.id;
  payment.receiptError = null;
  // Paid after it was delivered: the invoice is there already, so the money goes to it now
  if (order.invoiceId !== null) applyPaymentsToInvoice(data, order, order.invoiceId);
  return receipt.id;
}

// The API's makeAll(), once the order has its sales order: every paid try with no receipt and no
// error yet. A refusal is kept on its try, and the others still go
export function makePaymentReceipts(data: WorkspaceData, order: MockShopOrder, at: string): void {
  for (const payment of order.payments) {
    if (payment.status !== 'paid' || payment.receiptId !== null || payment.receiptError !== null) {
      continue;
    }
    try {
      makeReceiptIn(data, order, payment, at);
    } catch (error) {
      if (!(error instanceof MockProblem)) throw error;
      payment.receiptError = error.code;
    }
  }
}

// "Make the receipt" on the order's page (the API's makePaymentReceipt), after the version and
// the step are checked by the caller (storefront-order-data.ts). The receipt's own refusal is kept
// on the try and still answered
export function retryPaymentReceipt(
  data: WorkspaceData,
  order: MockShopOrder,
  paymentId: string,
  at: string = now(),
): string {
  const payment = order.payments.find((item) => item.id === paymentId);
  if (payment === undefined) throw new MockProblem(404, 'not_found');
  if (payment.status !== 'paid' || payment.receiptId !== null || order.salesOrderId === null) {
    throw new MockProblem(409, 'storefront_order_step_invalid');
  }
  try {
    return makeReceiptIn(data, order, payment, at);
  } catch (error) {
    if (error instanceof MockProblem) payment.receiptError = error.code;
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// The seed (storefront-order-data.ts → seedShopOrders)

// Rahman Fashion's SSLCommerz sandbox store, saved and tested: the money goes to the Dutch-Bangla
// account (SSLCommerz pays out into it), the fee to Bank charges. Pay online is ticked with it
export function seedGateway(data: WorkspaceData, at: string): void {
  const byCode = (code: string) => data.accounts.find((account) => account.code === code)?.id;
  const moneyAccountId = byCode('1121');
  const feeAccountId = byCode('5410');
  const shop = data.storefront.shop;
  if (moneyAccountId === undefined || feeAccountId === undefined || shop === null) return;
  data.storefront.gateway = {
    provider: 'sslcommerz',
    storeId: 'rahmanfashion_sandbox',
    mode: 'sandbox',
    password: 'rahmanfashion@ssl',
    moneyAccountId,
    feeAccountId,
    lastTest: { at, problem: null },
    version: 1,
    updatedAt: at,
  };
  if (!shop.paymentMethods.includes('online'))
    shop.paymentMethods = [...shop.paymentMethods, 'online'];
}

// A try as the API leaves it. `paid` is SSLCommerz's answer: how the shopper paid and its fee
// (2.5%, as the API's fake gateway keeps)
export function seedTry(
  order: MockShopOrder,
  startedAt: string,
  outcome:
    | { status: 'paid'; cardType: string; bankTranId: string; settledAt: string }
    | { status: 'failed' | 'cancelled'; settledAt: string }
    | { status: 'started' | 'not_opened' },
): MockShopPayment {
  const tranId = Array.from(crypto.getRandomValues(new Uint8Array(20)), (byte) =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.charAt(byte % 36),
  ).join('');
  const paid = outcome.status === 'paid';
  const payment: MockShopPayment = {
    id: crypto.randomUUID(),
    tranId,
    status: outcome.status,
    amount: order.total,
    startedAt,
    settledAt: 'settledAt' in outcome ? outcome.settledAt : null,
    cardType: paid ? outcome.cardType : null,
    bankTranId: paid ? outcome.bankTranId : null,
    storeAmount: paid ? subtractMoney(order.total, percentOfMoney(order.total, '2.5')) : null,
    receiptId: null,
    receiptError: null,
  };
  order.payments.push(payment);
  return payment;
}
