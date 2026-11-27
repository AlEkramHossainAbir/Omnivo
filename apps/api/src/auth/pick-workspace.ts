import type { MeResponse } from '@omnivo/contracts';

// One of the person's workspaces, as the workspace switcher lists it. Taken from the contract,
// so this type can never drift from what `me` sends.
export type WorkspaceOption = MeResponse['memberships'][number];

// Step 3b: which workspace a sign-in opens.
// 1. The hint, when the person belongs to it (the workspace this browser used last).
// 2. Else the workspace they used last on any device (users.last_tenant_id).
// 3. Else the first one by name, so the answer is the same every time.
// undefined only when the person belongs to no workspace at all.
export function pickWorkspace(
  workspaces: readonly WorkspaceOption[],
  hint: string | undefined,
  lastTenantId: string | null,
): WorkspaceOption | undefined {
  return (
    workspaces.find((workspace) => workspace.slug === hint) ??
    workspaces.find((workspace) => workspace.tenantId === lastTenantId) ??
    workspaces[0]
  );
}
