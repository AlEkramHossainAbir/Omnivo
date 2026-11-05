import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateCustomFieldInput,
  CustomFieldDefinition,
  CustomFieldEntity,
  UpdateCustomFieldInput,
} from '@omnivo/contracts';
import { customFieldDefinitions } from '@omnivo/db';
import { and, asc, eq, sql } from 'drizzle-orm';

import { audit, created, diff } from '../common/audit/audit.js';
import { isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

type FieldRow = typeof customFieldDefinitions.$inferSelect;

function toDefinition(row: FieldRow): CustomFieldDefinition {
  return {
    id: row.id,
    entity: row.entity,
    key: row.key,
    label: row.label,
    type: row.type,
    options: row.options,
    required: row.required,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// The audit log shows the choices as one line: "Tablet, Capsule, Syrup"
function snapshot(row: Pick<FieldRow, 'label' | 'options' | 'required'>) {
  return { label: row.label, options: row.options.join(', '), required: row.required };
}

// The workspace's own fields. Only the definitions live here; each record checks its values
// against them (customFieldsInputSchema in contracts, used by products/product-write.ts).
@Injectable()
export class CustomFieldsService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  // In the order they were made (UUIDv7 ids), which is the order forms show them in
  list(entity: CustomFieldEntity): Promise<CustomFieldDefinition[]> {
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(customFieldDefinitions)
        .where(
          and(
            eq(customFieldDefinitions.tenantId, getTenantId()),
            eq(customFieldDefinitions.entity, entity),
          ),
        )
        .orderBy(asc(customFieldDefinitions.id));
      return rows.map(toDefinition);
    });
  }

  async create(input: CreateCustomFieldInput): Promise<CustomFieldDefinition> {
    try {
      return await this.withTenant(async (tx) => {
        const [row] = await tx
          .insert(customFieldDefinitions)
          .values({
            tenantId: getTenantId(),
            entity: input.entity,
            key: input.key,
            label: input.label,
            type: input.type,
            // A choice list on a text field would mean nothing
            options: input.type === 'select' ? input.options : [],
            // Unticked is a value too: a yes/no field is never "missing"
            required: input.type === 'boolean' ? false : input.required,
            createdBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Custom field insert returned no row');
        await audit(tx, {
          action: 'custom_field.created',
          entityType: 'custom_field',
          entityId: row.id,
          changes: created({ key: row.key, type: row.type, ...snapshot(row) }),
        });
        return toDefinition(row);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'custom_field_definitions_key_idx')) {
        throw new AppError(409, 'custom_field_key_taken', 'Another field uses this key.', {
          fieldErrors: { key: ['custom_field_key_taken'] },
        });
      }
      throw error;
    }
  }

  // A removed choice stays on the records that hold it; their form shows it as wrong when they are
  // next edited, so nothing changes behind anyone's back
  update(id: string, input: UpdateCustomFieldInput): Promise<CustomFieldDefinition> {
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.version !== input.version) throw versionConflict();
      if (before.type === 'select' && input.options.length === 0) {
        throw new AppError(400, 'invalid_input', 'A select keeps at least one choice.', {
          fieldErrors: { options: ['custom_field_options_required'] },
        });
      }
      const after = await this.write(tx, id, {
        label: input.label,
        options: before.type === 'select' ? input.options : [],
        required: before.type === 'boolean' ? false : input.required,
      });
      await audit(tx, {
        action: 'custom_field.updated',
        entityType: 'custom_field',
        entityId: id,
        changes: diff(snapshot(before), snapshot(after)),
      });
      return toDefinition(after);
    });
  }

  setArchived(id: string, version: number, archived: boolean): Promise<CustomFieldDefinition> {
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.version !== version) throw versionConflict();
      if ((before.archivedAt !== null) === archived) return toDefinition(before);
      const after = await this.write(tx, id, { archivedAt: archived ? new Date() : null });
      await audit(tx, {
        action: archived ? 'custom_field.archived' : 'custom_field.restored',
        entityType: 'custom_field',
        entityId: id,
      });
      return toDefinition(after);
    });
  }

  private async lock(tx: Transaction, id: string): Promise<FieldRow> {
    const [row] = await tx
      .select()
      .from(customFieldDefinitions)
      .where(
        and(eq(customFieldDefinitions.tenantId, getTenantId()), eq(customFieldDefinitions.id, id)),
      )
      .for('update');
    if (!row) throw notFound('Custom field');
    return row;
  }

  private async write(
    tx: Transaction,
    id: string,
    fields: Partial<Pick<FieldRow, 'label' | 'options' | 'required' | 'archivedAt'>>,
  ): Promise<FieldRow> {
    const [row] = await tx
      .update(customFieldDefinitions)
      .set({
        ...fields,
        version: sql`${customFieldDefinitions.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(
        and(eq(customFieldDefinitions.tenantId, getTenantId()), eq(customFieldDefinitions.id, id)),
      )
      .returning();
    if (!row) throw notFound('Custom field');
    return row;
  }
}
