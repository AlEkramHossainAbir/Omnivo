import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@omnivo/db';

export const REQUIRED_PERMISSIONS_KEY = 'omnivo:requiredPermissions';

// PermissionKey = PERMISSIONS তালিকার key-গুলোর union — বানান ভুল হলে compile error
export const RequirePermission = (
  ...keys: [PermissionKey, ...PermissionKey[]]
): MethodDecorator & ClassDecorator => SetMetadata(REQUIRED_PERMISSIONS_KEY, keys);