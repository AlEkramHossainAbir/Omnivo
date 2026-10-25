import { DEFAULT_SETTINGS } from '@omnivo/contracts';
import { useQuery } from '@tanstack/react-query';

import { deviceSettingsQuery, settingsQuery } from './queries';
import { useSession } from './session-store';

// The workspace the person is signed in to, and its time zone. Moved here from
// components/stock-parts.tsx in step 18c (which re-exports them): the device lists need only these
// two, and stock-parts brought the stock pages' pills and helpers into their chunks.

export function useTenantId(): string {
  return useSession((state) => state.me?.tenant.id) ?? '';
}

// The company's time zone. Step 18b: offline, before the settings were ever loaded, the device's
// copy has it.
export function useTimeZone(): string {
  const tenantId = useTenantId();
  const server = useQuery(settingsQuery(tenantId)).data;
  const local = useQuery({ ...deviceSettingsQuery(tenantId), enabled: !server }).data;
  return server?.timezone ?? local?.timezone ?? DEFAULT_SETTINGS.timezone;
}
