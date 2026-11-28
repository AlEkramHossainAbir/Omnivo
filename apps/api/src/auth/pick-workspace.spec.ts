import { describe, expect, it } from 'vitest';

import { pickWorkspace, type WorkspaceOption } from './pick-workspace.js';

const karim: WorkspaceOption = {
  tenantId: '0190a000-0000-7000-8000-000000000001',
  name: 'Karim Pharma',
  slug: 'karim-pharma',
};
const nabil: WorkspaceOption = {
  tenantId: '0190a000-0000-7000-8000-000000000002',
  name: 'Nabil Distribution',
  slug: 'nabil-distribution',
};
// Sorted by name, as listWorkspaces gives them
const both = [karim, nabil];

describe('pickWorkspace', () => {
  it('opens the hinted workspace when the person belongs to it', () => {
    expect(pickWorkspace(both, 'nabil-distribution', karim.tenantId)).toBe(nabil);
  });

  it('ignores a hint the person does not belong to, and uses the last workspace', () => {
    expect(pickWorkspace(both, 'rahman-garments', nabil.tenantId)).toBe(nabil);
  });

  it('uses the last workspace when there is no hint', () => {
    expect(pickWorkspace(both, undefined, nabil.tenantId)).toBe(nabil);
  });

  it('falls back to the first by name when the last workspace is gone', () => {
    expect(pickWorkspace(both, undefined, '0190a000-0000-7000-8000-00000000dead')).toBe(karim);
    expect(pickWorkspace(both, undefined, null)).toBe(karim);
  });

  it('finds nothing for a person in no workspace', () => {
    expect(pickWorkspace([], 'karim-pharma', karim.tenantId)).toBeUndefined();
  });
});
