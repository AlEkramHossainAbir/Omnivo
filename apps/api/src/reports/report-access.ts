import {
  isCostSort,
  isStockValueSort,
  type PermissionKey,
  type SalesReportSort,
  type StockMovementSort,
} from '@omnivo/contracts';

import { AppError } from '../common/http/app-error.js';

// Who may read what in the step 21b and 21c reports, past the route's own permission

// The same answer the PermissionGuard gives (403 permission_missing, with the key), for a check the
// route cannot make: the guard knows one permission per route
export function missingPermission(permission: PermissionKey): AppError {
  return new AppError(403, 'permission_missing', `Missing permission: ${permission}.`, {
    params: { permissions: permission },
  });
}

// Cost and margin need inventory.stock.value (decision 3). Without it the columns are null, and a
// sort by them is refused (decision 17): the order of the rows would tell what the hidden column
// says. The page never offers it; a hand-made URL or an export query does.
export function checkCostSort(sort: SalesReportSort, withCost: boolean): void {
  if (!withCost && isCostSort(sort)) throw missingPermission('inventory.stock.value');
}

// Step 21c: the same rule for the stock movement report's value columns (decision 24)
export function checkValueSort(sort: StockMovementSort, withValue: boolean): void {
  if (!withValue && isStockValueSort(sort)) throw missingPermission('inventory.stock.value');
}
