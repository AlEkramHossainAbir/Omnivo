import type { PermissionKey } from '@omnivo/contracts';
import { useCallback } from 'react';

import { useSession } from './session-store';

// can('core.branch.manage') — key টাইপ-চেকড (contracts-এর PermissionKey): বানান ভুল হলে compile error,
// আর catalog থেকে কোনো permission সরালে যেখানে যেখানে সেটা দেখা হয় সব জায়গায় লাল দাগ।
// UI-তে লুকানো শুধু সুবিধা — আসল পাহারা API-র PermissionGuard
export function useCan(): (permission: PermissionKey) => boolean {
  const permissions = useSession((state) => state.me?.permissions);
  return useCallback(
    (permission: PermissionKey) => permissions?.includes(permission) ?? false,
    [permissions],
  );
}
