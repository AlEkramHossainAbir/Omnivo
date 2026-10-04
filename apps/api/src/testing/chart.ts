import { ACCOUNT_TYPES } from '@omnivo/contracts';

import type {
  AccountTemplate,
  CatalogTemplate,
  CategoryTemplate,
  ChartTemplate,
} from '../setup/templates.js';

function count(node: AccountTemplate): number {
  return 1 + (node.children ?? []).reduce((sum, child) => sum + count(child), 0);
}

// How many accounts seedChart() makes from a template — tests compare with this instead of a
// number typed by hand, so adding an account to a template does not break them
export function accountCount(chart: ChartTemplate): number {
  return ACCOUNT_TYPES.reduce((sum, type) => sum + count(chart[type]), 0);
}

function countCategories(nodes: readonly CategoryTemplate[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countCategories(node.children ?? []), 0);
}

// What seedCatalog() makes from a template, for the setup's audit row (step 12)
export function catalogCount(catalog: CatalogTemplate) {
  return {
    units: catalog.units.length,
    categories: countCategories(catalog.categories),
    customFields: catalog.customFields.length,
  };
}
