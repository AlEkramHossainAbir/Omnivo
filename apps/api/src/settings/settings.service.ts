import { Inject, Injectable } from '@nestjs/common';
import type { Settings, UpdateSettingsInput } from '@omnivo/contracts';
import { attachments, journalEntries, tenantSettings, tenants } from '@omnivo/db';
import { and, eq, sql } from 'drizzle-orm';

import { audit, diff } from '../common/audit/audit.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { StorageService } from '../storage/storage.service.js';

@Injectable()
export class SettingsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly storage: StorageService,
  ) {}

  get(): Promise<Settings> {
    return this.withTenant((tx) => this.read(tx));
  }

  update(input: UpdateSettingsInput): Promise<Settings> {
    const tenantId = getTenantId();
    const { version, companyName, ...fields } = input;
    return this.withTenant(async (tx) => {
      // FOR UPDATE: পড়া থেকে লেখা পর্যন্ত রো-টা এই transaction-এর — মাঝখানে আরেকজন বদলাতে পারে না।
      // আগে পড়তেই হয়: audit-এর পুরনো মান এখান থেকে, আর version মেলানোও এখানে
      const [current] = await tx
        .select({ settings: tenantSettings, companyName: tenants.name })
        .from(tenantSettings)
        .innerJoin(tenants, eq(tenants.id, tenantSettings.tenantId))
        .where(eq(tenantSettings.tenantId, tenantId))
        .for('update', { of: tenantSettings });
      if (!current) throw notFound('Settings');
      if (current.settings.version !== version) throw versionConflict();
      // The books are kept in the base currency. Once one entry is posted, changing it would turn
      // every amount in them into another currency's amount without converting anything.
      if (fields.baseCurrency !== current.settings.baseCurrency) {
        const [posted] = await tx
          .select({ id: journalEntries.id })
          .from(journalEntries)
          .where(and(eq(journalEntries.tenantId, tenantId), eq(journalEntries.status, 'posted')))
          .limit(1);
        if (posted) {
          throw new AppError(
            409,
            'base_currency_locked',
            'The base currency cannot change once entries are posted.',
            { fieldErrors: { baseCurrency: ['base_currency_locked'] } },
          );
        }
      }

      await tx
        .update(tenantSettings)
        .set({
          ...fields,
          version: sql`${tenantSettings.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(eq(tenantSettings.tenantId, tenantId));
      // কোম্পানির নাম tenants-এ (লগইন আর switcher পড়ে)। tenants-এ RLS নেই, তাই id নিজে বেঁধে দেওয়া —
      // টোকেনের টেন্যান্ট, body থেকে কিছু না
      await tx.update(tenants).set({ name: companyName }).where(eq(tenants.id, tenantId));

      const before = current.settings;
      await audit(tx, {
        action: 'settings.updated',
        entityType: 'workspace',
        entityId: tenantId,
        changes: diff(
          { companyName: current.companyName, ...pickEditable(before) },
          { companyName, ...fields },
        ),
      });
      return this.read(tx);
    });
  }

  // লোগো ফর্মের বাইরে, এক ক্লিকের কাজ — তাই version চায় না আর বাড়ায়ও না। নাহলে লোগো বদলানোর পরে
  // একই পাতায় খোলা ফর্ম "কেউ বদলেছে" বলে সেভ হতো না, যদিও ফর্মের কোনো ঘর কেউ ছোঁয়নি
  setLogo(attachmentId: string | null): Promise<Settings> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      let newFileName: string | null = null;
      if (attachmentId !== null) {
        // purpose শর্তে, আলাদা if-এ না: এখন একটাই purpose, তাই `file.purpose !== 'company_logo'` টাইপের
        // হিসেবে সবসময় false (lint-এর no-unnecessary-condition সেটাই বলে)। ইনভয়েসের PDF-এর মতো নতুন
        // purpose এলে এই শর্তই সেটাকে লোগো হতে দেয় না — কোডে কিছু মনে রাখতে হয় না
        const [file] = await tx
          .select({ status: attachments.status, fileName: attachments.fileName })
          .from(attachments)
          .where(
            and(
              eq(attachments.tenantId, tenantId),
              eq(attachments.id, attachmentId),
              eq(attachments.purpose, 'company_logo'),
            ),
          );
        if (!file) throw notFound('Attachment');
        if (file.status !== 'ready') {
          throw new AppError(409, 'attachment_not_ready', 'Upload the logo before using it.');
        }
        newFileName = file.fileName;
      }
      // আগের লোগোর ফাইলের নাম — audit-এ id-র বদলে নাম ("rahman-logo.png"), মানুষ যা চেনে
      const [before] = await tx
        .select({ fileName: attachments.fileName })
        .from(tenantSettings)
        .leftJoin(
          attachments,
          and(
            eq(attachments.tenantId, tenantSettings.tenantId),
            eq(attachments.id, tenantSettings.logoAttachmentId),
          ),
        )
        .where(eq(tenantSettings.tenantId, tenantId))
        .for('update', { of: tenantSettings });
      if (!before) throw notFound('Settings');
      await tx
        .update(tenantSettings)
        .set({ logoAttachmentId: attachmentId, updatedBy: currentPrincipal().userId })
        .where(eq(tenantSettings.tenantId, tenantId));
      await audit(tx, {
        action: 'settings.logo_changed',
        entityType: 'workspace',
        entityId: tenantId,
        changes: diff({ logo: before.fileName }, { logo: newFileName }),
      });
      return this.read(tx);
    });
  }

  private async read(tx: Transaction): Promise<Settings> {
    const tenantId = getTenantId();
    const [row] = await tx
      .select({
        settings: tenantSettings,
        companyName: tenants.name,
        logoKey: attachments.storageKey,
        logoType: attachments.contentType,
      })
      .from(tenantSettings)
      .innerJoin(tenants, eq(tenants.id, tenantSettings.tenantId))
      .leftJoin(
        attachments,
        and(
          eq(attachments.tenantId, tenantSettings.tenantId),
          eq(attachments.id, tenantSettings.logoAttachmentId),
        ),
      )
      .where(eq(tenantSettings.tenantId, tenantId));
    // signup আর migration 0008 প্রতিটা টেন্যান্টে রো বানায় — না থাকা মানে ডেটার গোলমাল, 500 না 404
    if (!row) throw new Error(`tenant_settings row missing for tenant ${tenantId}`);

    const { settings } = row;
    const logoId = settings.logoAttachmentId;
    const logo =
      logoId !== null && row.logoKey !== null && row.logoType !== null
        ? {
            attachmentId: logoId,
            url: (await this.storage.downloadUrl(row.logoKey, row.logoType)).url,
          }
        : null;

    return {
      companyName: row.companyName,
      ...pickEditable(settings),
      logo,
      version: settings.version,
    };
  }
}

// ফর্মের ঘরগুলো — read আর audit-এর "আগের মান" একই তালিকা থেকে
function pickEditable(settings: typeof tenantSettings.$inferSelect) {
  return {
    legalName: settings.legalName,
    bin: settings.bin,
    phone: settings.phone,
    email: settings.email,
    address: settings.address,
    baseCurrency: settings.baseCurrency,
    fiscalYearStartMonth: settings.fiscalYearStartMonth,
    timezone: settings.timezone,
    allowNegativeStock: settings.allowNegativeStock,
  };
}
