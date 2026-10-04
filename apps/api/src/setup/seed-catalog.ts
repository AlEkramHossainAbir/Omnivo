import { customFieldDefinitions, productCategories, units } from '@omnivo/db';
import { eq } from 'drizzle-orm';

import type { Transaction } from '../common/tenant/with-tenant.js';
import type { CatalogTemplate, CategoryTemplate } from './templates.js';

interface Pending {
  node: CategoryTemplate;
  parentId: string | null;
}

export interface SeededCatalog {
  units: number;
  categories: number;
  customFields: number;
}

// Creates a template's units, product categories and custom fields in the transaction's tenant.
// Makes nothing (returns null) if the workspace already has any unit: the set is made whole or not
// at all, in one transaction, so "a unit exists" means "the catalog was made" — the same rule as
// seedChart(), and what makes the setup job and the catalog job idempotent. Both lock the tenant
// row first, so they never race.
export async function seedCatalog(
  tx: Transaction,
  tenantId: string,
  catalog: CatalogTemplate,
): Promise<SeededCatalog | null> {
  const [existing] = await tx
    .select({ id: units.id })
    .from(units)
    .where(eq(units.tenantId, tenantId))
    .limit(1);
  if (existing) return null;

  await tx.insert(units).values(catalog.units.map((unit) => ({ tenantId, ...unit })));

  // One level at a time, like the chart: a child needs its parent's id. Names are unique among
  // siblings (templates.spec.ts), so the name finds the new row's id.
  let level: Pending[] = catalog.categories.map((node) => ({ node, parentId: null }));
  let categories = 0;
  while (level.length > 0) {
    const inserted = await tx
      .insert(productCategories)
      .values(level.map(({ node, parentId }) => ({ tenantId, parentId, name: node.name })))
      .returning({
        id: productCategories.id,
        name: productCategories.name,
        parentId: productCategories.parentId,
      });
    categories += inserted.length;
    level = level.flatMap(({ node, parentId }) => {
      const row = inserted.find(
        (candidate) => candidate.name === node.name && candidate.parentId === parentId,
      );
      if (!row) throw new Error(`Catalog template: category ${node.name} was not created`);
      return (node.children ?? []).map((child) => ({
        node: child,
        parentId: row.id,
      }));
    });
  }

  if (catalog.customFields.length > 0) {
    await tx.insert(customFieldDefinitions).values(
      catalog.customFields.map((field) => ({
        tenantId,
        entity: 'product' as const,
        key: field.key,
        label: field.label,
        type: field.type,
        options: [...(field.options ?? [])],
        required: field.required ?? false,
      })),
    );
  }
  return {
    units: catalog.units.length,
    categories,
    customFields: catalog.customFields.length,
  };
}
