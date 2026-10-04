import { Inject, Injectable } from '@nestjs/common';
import {
  defaultNumberFormat,
  DOCUMENT_TYPES,
  type DocumentType,
  formatDocumentNumber,
  type NumberFormat,
  type NumberSeries,
  periodOf,
  todayIn,
  type UpdateNumberSeriesInput,
} from '@omnivo/contracts';
import { numberSeries, numberSeriesCounters, tenantSettings } from '@omnivo/db';
import { and, eq, sql } from 'drizzle-orm';

import { audit, diff } from '../common/audit/audit.js';
import { versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

// audit আর উত্তরের জন্য শুধু ছাঁচের তিনটা ঘর। পুরো রো spread করা যেত না: `{ ...(row ?? default) }`-এ
// TypeScript union-এর index-signature চেক ফসকে যায় (interface থাকলে), আর createdAt-এর Date চুপচাপ
// audit-এ ঢুকত — যাচাইয়ের সময় ঠিক এটাই ধরা পড়েছে। ফেরত টাইপ ইচ্ছা করে লেখা নেই: inferred object
// type-এর implicit index signature আছে (diff()-এ বসে), NumberFormat interface-এর নেই
function pickFormat(format: NumberFormat) {
  return { prefix: format.prefix, yearStyle: format.yearStyle, padding: format.padding };
}

// '' (বছর ছাড়া ছাঁচ) PK-র কলামে রাখা যায়, কিন্তু 'all' পড়তে পরিষ্কার
function periodKey(period: string): string {
  return period === '' ? 'all' : period;
}

@Injectable()
export class NumberingService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  // পরের ধাপের ডকুমেন্ট (ইনভয়েস, journal) নিজের transaction-এর ভেতর থেকে এটা ডাকবে:
  //   const number = await numbering.next(tx, 'sales.invoice', invoice.date);
  // কাউন্টার সেই transaction-এর অংশ — ইনভয়েস rollback হলে নম্বরও ফেরত যায়, ফাঁক থাকে না। দুজন একসাথে
  // চাইলে ON CONFLICT DO UPDATE রো-টা lock করে: দ্বিতীয়জন প্রথমজনের commit পর্যন্ত অপেক্ষা করে পরেরটা পায়
  async next(tx: Transaction, documentType: DocumentType, isoDate: string): Promise<string> {
    const [number] = await this.nextMany(tx, documentType, isoDate, 1);
    if (number === undefined) throw new Error('nextMany returned no number');
    return number;
  }

  // `count` numbers in a row with one counter update — a CSV import of 5,000 products takes its
  // codes in one statement instead of 5,000. Same transaction rule as next(): a rollback gives them
  // all back.
  async nextMany(
    tx: Transaction,
    documentType: DocumentType,
    isoDate: string,
    count: number,
  ): Promise<string[]> {
    if (count < 1) return [];
    const tenantId = getTenantId();
    const { format, fiscalYearStartMonth } = await this.formatOf(tx, documentType);
    const period = periodOf(isoDate, format.yearStyle, fiscalYearStartMonth);
    const [counter] = await tx
      .insert(numberSeriesCounters)
      .values({ tenantId, documentType, period: periodKey(period), lastValue: count })
      .onConflictDoUpdate({
        target: [
          numberSeriesCounters.tenantId,
          numberSeriesCounters.documentType,
          numberSeriesCounters.period,
        ],
        set: { lastValue: sql`${numberSeriesCounters.lastValue} + ${count}` },
      })
      .returning({ lastValue: numberSeriesCounters.lastValue });
    if (!counter) throw new Error('Counter upsert returned no row');
    // The counter now holds the last of them; the first is count - 1 before it
    const first = counter.lastValue - count + 1;
    return Array.from({ length: count }, (_, index) =>
      formatDocumentNumber(format, period, first + index),
    );
  }

  list(): Promise<NumberSeries[]> {
    return this.withTenant(async (tx) => {
      const settings = await this.settingsOf(tx);
      const rows = await tx
        .select()
        .from(numberSeries)
        .where(eq(numberSeries.tenantId, getTenantId()));
      const saved = new Map(rows.map((row) => [row.documentType, row]));
      return Promise.all(
        DOCUMENT_TYPES.map(async (documentType) => {
          const row = saved.get(documentType);
          const format = row ?? defaultNumberFormat(documentType);
          return this.describe(tx, documentType, format, row?.version ?? 0, settings);
        }),
      );
    });
  }

  update(documentType: DocumentType, input: UpdateNumberSeriesInput): Promise<NumberSeries> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      const { version, ...format } = input;
      const [current] = await tx
        .select()
        .from(numberSeries)
        .where(
          and(eq(numberSeries.tenantId, tenantId), eq(numberSeries.documentType, documentType)),
        )
        .for('update');
      if ((current?.version ?? 0) !== version) throw versionConflict();

      const userId = currentPrincipal().userId;
      // প্রথম বদল = নতুন রো। ON CONFLICT DO NOTHING: দুজন একসাথে প্রথমবার সেভ করলে দ্বিতীয়জন রো পায়
      // না (returning খালি) — unique error-এর 500-এর বদলে সাধারণ version_conflict
      const [row] = current
        ? await tx
            .update(numberSeries)
            .set({ ...format, version: sql`${numberSeries.version} + 1`, updatedBy: userId })
            .where(eq(numberSeries.id, current.id))
            .returning()
        : await tx
            .insert(numberSeries)
            .values({ tenantId, documentType, ...format, createdBy: userId, updatedBy: userId })
            .onConflictDoNothing()
            .returning();
      if (!row) throw versionConflict();

      await audit(tx, {
        action: 'number_series.updated',
        entityType: 'number_series',
        entityId: row.id,
        changes: diff(pickFormat(current ?? defaultNumberFormat(documentType)), pickFormat(format)),
      });
      return this.describe(
        tx,
        documentType,
        pickFormat(row),
        row.version,
        await this.settingsOf(tx),
      );
    });
  }

  // "আজ একটা হলে কোন নম্বর" — কাউন্টার শুধু পড়া হয়, বাড়ানো না
  private async describe(
    tx: Transaction,
    documentType: DocumentType,
    format: NumberFormat,
    version: number,
    settings: { fiscalYearStartMonth: number; timezone: string },
  ): Promise<NumberSeries> {
    const period = periodOf(
      todayIn(settings.timezone),
      format.yearStyle,
      settings.fiscalYearStartMonth,
    );
    const [counter] = await tx
      .select({ lastValue: numberSeriesCounters.lastValue })
      .from(numberSeriesCounters)
      .where(
        and(
          eq(numberSeriesCounters.tenantId, getTenantId()),
          eq(numberSeriesCounters.documentType, documentType),
          eq(numberSeriesCounters.period, periodKey(period)),
        ),
      );
    return {
      documentType,
      prefix: format.prefix,
      yearStyle: format.yearStyle,
      padding: format.padding,
      version,
      nextNumber: formatDocumentNumber(format, period, (counter?.lastValue ?? 0) + 1),
    };
  }

  private async formatOf(tx: Transaction, documentType: DocumentType) {
    const settings = await this.settingsOf(tx);
    const [row] = await tx
      .select()
      .from(numberSeries)
      .where(
        and(eq(numberSeries.tenantId, getTenantId()), eq(numberSeries.documentType, documentType)),
      );
    return {
      format: row ?? defaultNumberFormat(documentType),
      fiscalYearStartMonth: settings.fiscalYearStartMonth,
    };
  }

  private async settingsOf(tx: Transaction) {
    const [settings] = await tx
      .select({
        fiscalYearStartMonth: tenantSettings.fiscalYearStartMonth,
        timezone: tenantSettings.timezone,
      })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, getTenantId()));
    if (!settings) throw new Error(`tenant_settings row missing for tenant ${getTenantId()}`);
    return settings;
  }
}
