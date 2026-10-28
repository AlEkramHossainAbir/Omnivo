import { type PosRegisterStatus, routes } from '@omnivo/contracts';
import { infiniteQueryOptions, keepPreviousData, queryOptions } from '@tanstack/react-query';

import { call } from './api';

// Step 20a: the server's reads of the POS, for the managers' pages: the registers, the posted
// sales and what sold short. Its own file, not queries.ts: queries.ts is in the chunk of almost
// every page, and only these three pages need these. All of them start with ['pos', tenantId], so
// one refresh after a register's save or a sync refreshes every POS list.

// The registers settings page: every register of the workspace, with who holds it
export function posRegistersQuery(tenantId: string, status: PosRegisterStatus) {
  return queryOptions({
    queryKey: ['pos', tenantId, 'registers', status],
    queryFn: async () => (await call(routes.pos.listRegisters, { query: { status } })).items,
  });
}

// One register, for a sale's page: its paper width and receipt footer, to print the receipt again
export function posRegisterQuery(tenantId: string, registerId: string) {
  return queryOptions({
    queryKey: ['pos', tenantId, 'register', registerId],
    queryFn: () => call(routes.pos.getRegister, { params: { id: registerId } }),
  });
}

// '' = every register
export function posSalesQuery(tenantId: string, registerId: string) {
  return infiniteQueryOptions({
    queryKey: ['pos', tenantId, 'sales', registerId],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.pos.listSales, {
        query: {
          limit: 50,
          ...(registerId !== '' && { registerId }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    // A new register filter keeps the old rows until its first page comes: no flash of empty
    placeholderData: keepPreviousData,
  });
}

export function posSaleQuery(tenantId: string, saleId: string) {
  return queryOptions({
    queryKey: ['pos', tenantId, 'sale', saleId],
    queryFn: () => call(routes.pos.getSale, { params: { id: saleId } }),
  });
}

// '' = every warehouse
export function soldShortQuery(tenantId: string, warehouseId: string) {
  return infiniteQueryOptions({
    queryKey: ['pos', tenantId, 'sold-short', warehouseId],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.pos.soldShort, {
        query: {
          limit: 50,
          ...(warehouseId !== '' && { warehouseId }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}
