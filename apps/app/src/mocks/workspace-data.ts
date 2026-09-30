import {
  type AuditAction,
  type AuditChanges,
  type AuditEntityType,
  type AuditEntry,
  type AuditValue,
  type Branch,
  DEFAULT_SETTINGS,
  defaultNumberFormat,
  DOCUMENT_TYPES,
  type DocumentType,
  formatDocumentNumber,
  type NumberFormat,
  type NumberSeries,
  periodOf,
  type Settings,
  todayIn,
} from '@omnivo/contracts';

import { OWNER, type Workspace } from './fixtures';
import { MockProblem } from './mock';
import { type People, seedPeople } from './people-data';

// mock সার্ভারের এক workspace-এর ডেটা — শুধু এই ট্যাবের memory-তে, reload করলে আবার শুরু থেকে।
// নিয়মগুলো আসল API-র মতো (version, অনন্য কোড, শেষ চালু ব্রাঞ্চ) — UI-র error-পথ mock দিয়েও দেখা যায়
export interface WorkspaceData {
  settings: Settings;
  branches: Branch[];
  series: Map<DocumentType, NumberFormat & { version: number }>;
  audit: AuditEntry[];
  people: People;
}

function now(): string {
  return new Date().toISOString();
}

function branch(code: string, name: string, address: string, archived = false): Branch {
  return {
    id: crypto.randomUUID(),
    code,
    name,
    phone: '+880 1711-000000',
    address,
    archivedAt: archived ? now() : null,
    version: 1,
    updatedAt: now(),
  };
}

// আসল ইন্ডাস্ট্রির উদাহরণ (CLAUDE.md → Content): গার্মেন্টসের কারখানা আর ডিপো, ফার্মার ডিপো
function seed(workspace: Workspace): WorkspaceData {
  const garments = workspace.slug === 'rahman-garments';
  const data: WorkspaceData = {
    settings: {
      companyName: workspace.name,
      legalName: null,
      bin: garments ? '0001234560101' : null,
      phone: null,
      email: null,
      address: null,
      ...DEFAULT_SETTINGS,
      logo: null,
      version: 1,
    },
    branches: garments
      ? [
          branch('HO', 'Head office', 'House 42, Road 11, Banani, Dhaka 1213'),
          branch('GZP', 'Gazipur factory', 'BSCIC Industrial Area, Konabari, Gazipur 1751'),
          branch('CTG', 'Chattogram depot', 'Port Connecting Road, Chattogram 4100'),
          branch('NGJ', 'Narayanganj dyeing unit', 'Fatullah, Narayanganj 1421', true),
        ]
      : [branch('HO', 'Head office', 'Tejgaon Industrial Area, Dhaka 1208')],
    series: new Map(),
    audit: [],
    people: seedPeople(workspace),
  };
  record(data, 'workspace.created', 'workspace', workspace.tenantId, {
    name: { from: null, to: workspace.name },
  });
  return data;
}

const store = new Map<string, WorkspaceData>();

export function dataOf(workspace: Workspace): WorkspaceData {
  let data = store.get(workspace.tenantId);
  if (!data) {
    data = seed(workspace);
    store.set(workspace.tenantId, data);
  }
  return data;
}

export function record(
  data: WorkspaceData,
  action: AuditAction,
  entityType: AuditEntityType,
  entityId: string,
  changes: AuditChanges = {},
): void {
  // নতুন আগে — আসল API-র ক্রম
  data.audit.unshift({
    id: crypto.randomUUID(),
    action,
    entityType,
    entityId,
    actor: { id: OWNER.id, fullName: OWNER.fullName },
    changes,
    ipAddress: '103.4.145.2',
    requestId: crypto.randomUUID(),
    createdAt: now(),
  });
}

type Snapshot = Record<string, AuditValue>;

// API-র common/audit/audit.ts-এর মতো: শুধু যা বদলেছে
export function diff(before: Snapshot, after: Snapshot): AuditChanges {
  const changes: AuditChanges = {};
  for (const [field, to] of Object.entries(after)) {
    const from = before[field] ?? null;
    if (from !== to) changes[field] = { from, to };
  }
  return changes;
}

export function checkVersion(actual: number, sent: number): void {
  if (actual !== sent) throw new MockProblem(409, 'version_conflict');
}

export function findBranch(data: WorkspaceData, id: string): Branch {
  const found = data.branches.find((candidate) => candidate.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function assertCodeFree(data: WorkspaceData, code: string, except?: string): void {
  if (data.branches.some((other) => other.code === code && other.id !== except)) {
    throw new MockProblem(409, 'branch_code_taken', { code: ['branch_code_taken'] });
  }
}

export function seriesList(data: WorkspaceData): NumberSeries[] {
  const period = (format: NumberFormat) =>
    periodOf(todayIn(data.settings.timezone), format.yearStyle, data.settings.fiscalYearStartMonth);
  return DOCUMENT_TYPES.map((documentType) => {
    const saved = data.series.get(documentType);
    const format = saved ?? defaultNumberFormat(documentType);
    return {
      documentType,
      ...format,
      version: saved?.version ?? 0,
      // mock-এ কোনো ডকুমেন্ট তৈরি হয় না, তাই পরের নম্বর সবসময় ১
      nextNumber: formatDocumentNumber(format, period(format), 1),
    };
  });
}
