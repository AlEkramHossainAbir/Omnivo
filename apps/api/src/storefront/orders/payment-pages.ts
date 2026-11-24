import { randomInt } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { SHOP_PAYMENT_NOTICE_PATH, SHOP_PAYMENT_RETURN_PATH } from '@omnivo/contracts';
import { storefrontPayments } from '@omnivo/db';
import { and, eq } from 'drizzle-orm';

import type { Config } from '../../config.js';
import { CONFIG, PAYMENT_GATEWAY } from '../../infra/tokens.js';
import type { PaymentGateway } from '../../payments/gateway.js';
import type { OpenGatewayAccount } from '../gateway-accounts.js';
import { ShopDb } from '../shop-db.js';
import { shopUrl } from '../shop-url.js';

const TRAN_ID_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// 20 letters and digits from the OS's random source (27d.1's mine 12): about 103 bits, so a
// stranger cannot guess one. randomInt draws each one without the modulo bias of a byte % 36
export function newTranId(): string {
  let id = '';
  for (let index = 0; index < 20; index += 1) id += TRAN_ID_LETTERS[randomInt(36)] ?? '';
  return id;
}

// A try's row as placing an order and "Try again" write it. The account's provider and mode are
// copied, so the answer is asked where the page was opened (27d.2's mine 20)
export function tryValues(
  tenantId: string,
  orderId: string,
  tryNo: number,
  amount: string,
  account: OpenGatewayAccount,
  now: Date,
): typeof storefrontPayments.$inferInsert {
  return {
    tenantId,
    orderId,
    tryNo,
    tranId: newTranId(),
    provider: account.provider,
    mode: account.mode,
    amount,
    startedAt: now,
  };
}

// What the gateway's page shows about the order, from the order's own row
export interface PageOrder {
  customerName: string;
  phone: string;
  address: string;
  zoneName: string;
  items: number;
  shopName: string;
}

// Step 27d (decision 1): asks the gateway for a payment page, after the try's transaction has
// committed, so a slow SSLCommerz never holds the order's locks. A page that did not open marks
// the try not_opened (27d.1's mine 14): the order and its hold stay, and /checkout/paid offers
// "Try again" and "Pay on delivery".
@Injectable()
export class PaymentPages {
  constructor(
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(CONFIG) private readonly config: Config,
    private readonly shopDb: ShopDb,
  ) {}

  async open(
    host: string | undefined,
    subdomain: string,
    account: OpenGatewayAccount,
    payment: { id: string; tranId: string; amount: string },
    order: PageOrder,
  ): Promise<string | null> {
    // On the shop's own address (decision 2): the gateway posts the browser back there, and the
    // shop's server passes the two ids on to the API
    const page = await this.gateway.openPage(account, {
      tranId: payment.tranId,
      amount: payment.amount,
      returnUrl: shopUrl(this.config.storefront, subdomain, SHOP_PAYMENT_RETURN_PATH),
      noticeUrl: shopUrl(this.config.storefront, subdomain, SHOP_PAYMENT_NOTICE_PATH),
      customer: {
        name: order.customerName,
        phone: order.phone,
        address: order.address,
        area: order.zoneName,
      },
      description: `Order from ${order.shopName}`,
      items: order.items,
    });
    if (page.ok) return page.url;
    // Only while it is still started: an answer that came in the meantime (it cannot, with no
    // page, but the rule costs nothing) is never overwritten
    await this.shopDb.orders(host, async (tx, shop) => {
      await tx
        .update(storefrontPayments)
        .set({ status: 'not_opened' })
        .where(
          and(
            eq(storefrontPayments.tenantId, shop.tenantId),
            eq(storefrontPayments.id, payment.id),
            eq(storefrontPayments.status, 'started'),
          ),
        );
    });
    return null;
  }
}
