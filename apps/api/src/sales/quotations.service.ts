import { Inject, Injectable } from '@nestjs/common';
import {
  documentTotals,
  type PartyRef,
  type Quotation,
  type QuotationInput,
  type QuotationStatus,
  type QuotationSummary,
  type UpdateQuotationInput,
} from '@omnivo/contracts';
import { parties, quotationLines, quotations, salesOrders } from '@omnivo/db';
import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { NumberingService } from '../numbering/numbering.service.js';
import {
  assertCustomer,
  customerRefs,
  pricesIncludeVatNow,
  type ResolvedSalesLine,
  resolveSalesLines,
  salesLineValues,
  toSalesLine,
  withVariants,
} from './sales-lines.js';

type QuotationRow = typeof quotations.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// By the table's name: inside this subquery a bare "id" would be the line's own
const lineCount = sql<number>`(
  SELECT count(*)::int FROM quotation_lines l
   WHERE l.tenant_id = quotations.tenant_id AND l.quotation_id = quotations.id
)`;

function notOpen(): AppError {
  return new AppError(
    409,
    'quotation_not_open',
    'The customer has answered this quotation, so it stays as it is. Write a new one.',
  );
}

function toSummary(row: QuotationRow, customer: PartyRef, lines: number): QuotationSummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    validUntil: row.validUntil,
    customer,
    status: row.status,
    net: row.net,
    vat: row.vat,
    total: row.total,
    lineCount: lines,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// What the audit log shows of a quotation: what a person recognises, not ids or every line
function snapshot(row: QuotationRow, customer: PartyRef, lines: number) {
  return {
    number: row.number,
    date: row.date,
    validUntil: row.validUntil,
    customer: customer.code,
    total: row.total,
    lines,
  };
}

@Injectable()
export class QuotationsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: QuotationStatus | undefined;
    customerId?: string | undefined;
  }): Promise<{ items: QuotationSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.rows(
        tx,
        and(
          query.status === undefined ? undefined : eq(quotations.status, query.status),
          query.customerId === undefined ? undefined : eq(quotations.customerId, query.customerId),
          after === undefined
            ? undefined
            : sql`(${quotations.date}, ${quotations.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      const page = toPage(rows, query.limit, (last) => [last.quotation.date, last.quotation.id]);
      return {
        items: page.items.map((row) => toSummary(row.quotation, row.customer, row.lineCount)),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<Quotation> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  create(input: QuotationInput): Promise<Quotation> {
    return this.withTenant(async (tx) => {
      const customer = await assertCustomer(tx, input.customerId);
      const pricesIncludeVat = await pricesIncludeVatNow(tx);
      const lines = await resolveSalesLines(tx, input.lines, pricesIncludeVat);
      // Numbered at once: a quotation moves nothing, and the customer quotes its number back. A
      // deleted open quotation leaves a gap, which is fine for an offer.
      const number = await this.numbering.next(tx, 'sales.quotation', input.date);
      const [row] = await tx
        .insert(quotations)
        .values({
          tenantId: getTenantId(),
          number,
          date: input.date,
          validUntil: input.validUntil,
          customerId: customer.id,
          pricesIncludeVat,
          note: input.note,
          ...documentTotals(lines.map((line) => line.amounts)),
          createdBy: currentPrincipal().userId,
          updatedBy: currentPrincipal().userId,
        })
        .returning();
      if (!row) throw new Error('Quotation insert returned no row');
      await this.writeLines(tx, row.id, lines);
      await audit(tx, {
        action: 'quotation.created',
        entityType: 'quotation',
        entityId: row.id,
        changes: created(snapshot(row, customer, lines.length)),
      });
      return this.read(tx, row.id);
    });
  }

  update(id: string, input: UpdateQuotationInput): Promise<Quotation> {
    return this.withTenant(async (tx) => {
      const before = await this.lockOpen(tx, id, input.version);
      const linesBefore = await this.linesOf(tx, id);
      const customerBefore = await this.customerOf(tx, before.customerId);
      const customer = await assertCustomer(tx, input.customerId, before.customerId);
      // The quotation keeps the setting it was written with: its prices were typed that way
      const lines = await resolveSalesLines(
        tx,
        input.lines,
        before.pricesIncludeVat,
        new Set(linesBefore.map((line) => line.taxRateId)),
      );
      const [updated] = await tx
        .update(quotations)
        .set({
          date: input.date,
          validUntil: input.validUntil,
          customerId: customer.id,
          note: input.note,
          ...documentTotals(lines.map((line) => line.amounts)),
          version: sql`${quotations.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(quotations.tenantId, getTenantId()), eq(quotations.id, id)))
        .returning();
      if (!updated) throw notFound('Quotation');
      await this.writeLines(tx, id, lines);
      await audit(tx, {
        action: 'quotation.updated',
        entityType: 'quotation',
        entityId: id,
        changes: diff(
          snapshot(before, customerBefore, linesBefore.length),
          snapshot(updated, customer, lines.length),
        ),
      });
      return this.read(tx, id);
    });
  }

  remove(id: string, version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      const before = await this.lockOpen(tx, id, version);
      const lines = await this.linesOf(tx, id);
      const customer = await this.customerOf(tx, before.customerId);
      // The lines go with it (ON DELETE CASCADE)
      await tx
        .delete(quotations)
        .where(and(eq(quotations.tenantId, getTenantId()), eq(quotations.id, id)));
      await audit(tx, {
        action: 'quotation.deleted',
        entityType: 'quotation',
        entityId: id,
        changes: diff(snapshot(before, customer, lines.length), {
          number: null,
          date: null,
          validUntil: null,
          customer: null,
          total: null,
          lines: null,
        }),
      });
    });
  }

  // The customer said no. Kept, not deleted: what was offered, and when, is worth knowing.
  decline(id: string, version: number): Promise<Quotation> {
    return this.withTenant(async (tx) => {
      await this.lockOpen(tx, id, version);
      await this.setStatus(tx, id, 'declined');
      await audit(tx, { action: 'quotation.declined', entityType: 'quotation', entityId: id });
      return this.read(tx, id);
    });
  }

  // The customer came back after all. Only a declined quotation: an accepted one has its order.
  reopen(id: string, version: number): Promise<Quotation> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, version);
      if (row.status !== 'declined') {
        throw new AppError(
          409,
          'quotation_not_declined',
          'Only a declined quotation can be opened again.',
        );
      }
      await this.setStatus(tx, id, 'open');
      await audit(tx, { action: 'quotation.reopened', entityType: 'quotation', entityId: id });
      return this.read(tx, id);
    });
  }

  private async setStatus(tx: Transaction, id: string, status: QuotationStatus): Promise<void> {
    await tx
      .update(quotations)
      .set({
        status,
        version: sql`${quotations.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(quotations.tenantId, getTenantId()), eq(quotations.id, id)));
  }

  private async writeLines(
    tx: Transaction,
    quotationId: string,
    lines: readonly ResolvedSalesLine[],
  ): Promise<void> {
    await tx
      .delete(quotationLines)
      .where(
        and(
          eq(quotationLines.tenantId, getTenantId()),
          eq(quotationLines.quotationId, quotationId),
        ),
      );
    await tx
      .insert(quotationLines)
      .values(lines.map((line, index) => ({ ...salesLineValues(line, index), quotationId })));
  }

  // FOR UPDATE: two saves of one quotation, or a save and an order made from it, take turns
  private async lock(tx: Transaction, id: string, version: number): Promise<QuotationRow> {
    const [row] = await tx
      .select()
      .from(quotations)
      .where(and(eq(quotations.tenantId, getTenantId()), eq(quotations.id, id)))
      .for('update');
    if (!row) throw notFound('Quotation');
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private async lockOpen(tx: Transaction, id: string, version: number): Promise<QuotationRow> {
    const row = await this.lock(tx, id, version);
    if (row.status !== 'open') throw notOpen();
    return row;
  }

  private linesOf(tx: Transaction, quotationId: string) {
    return tx
      .select()
      .from(quotationLines)
      .where(
        and(
          eq(quotationLines.tenantId, getTenantId()),
          eq(quotationLines.quotationId, quotationId),
        ),
      )
      .orderBy(asc(quotationLines.lineNo));
  }

  // The quotations with their customers and line counts, newest first
  private rows(tx: Transaction, where: SQL | undefined, limit: number) {
    return tx
      .select({
        quotation: quotations,
        customer: { id: parties.id, code: parties.code, name: parties.name },
        lineCount,
      })
      .from(quotations)
      .innerJoin(
        parties,
        and(eq(parties.tenantId, quotations.tenantId), eq(parties.id, quotations.customerId)),
      )
      .where(and(eq(quotations.tenantId, getTenantId()), where))
      .orderBy(desc(quotations.date), desc(quotations.id))
      .limit(limit);
  }

  private async read(tx: Transaction, id: string): Promise<Quotation> {
    const [found] = await this.rows(tx, eq(quotations.id, id), 1);
    if (!found) throw notFound('Quotation');
    const { quotation: row } = found;
    const lines = await withVariants(tx, await this.linesOf(tx, id));
    // The order made from it (sales_orders_quotation_idx: one at most)
    const [order] = await tx
      .select({ id: salesOrders.id, number: salesOrders.number })
      .from(salesOrders)
      .where(and(eq(salesOrders.tenantId, getTenantId()), eq(salesOrders.quotationId, id)));
    return {
      ...toSummary(row, found.customer, found.lineCount),
      pricesIncludeVat: row.pricesIncludeVat,
      discount: row.discount,
      note: row.note,
      lines: lines.map(({ row: line, variant }) => toSalesLine(line, variant)),
      order: order ?? null,
    };
  }

  // The customer a quotation has, as the audit log names it. The FK keeps it.
  private async customerOf(tx: Transaction, customerId: string): Promise<PartyRef> {
    const customer = (await customerRefs(tx, [customerId])).get(customerId);
    if (!customer) throw new Error(`Customer ${customerId} is missing`);
    return customer;
  }
}
