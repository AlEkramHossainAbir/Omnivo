import type { Account } from '@omnivo/contracts';
import { buildTree, flattenTree, type TreeNode } from '@omnivo/ui';

// Sorts "1120" after "1110" and "1-2" before "1-10", like people read account codes
const byCode = new Intl.Collator('en', { numeric: true });

export function accountTree(accounts: readonly Account[]): TreeNode<Account>[] {
  return buildTree(accounts, {
    id: (account) => account.id,
    parentId: (account) => account.parentId,
    compare: (a, b) => byCode.compare(a.code, b.code),
  });
}

// The groups an account can go under, in tree order, indented for the native <select> (which
// shows plain text only — em spaces are the indent). For a move, `moving` leaves out the account
// itself, everything under it (a loop) and the groups of other types; the API refuses those too.
export function groupOptions(
  accounts: readonly Account[],
  moving?: Account,
): { value: string; label: string }[] {
  const tree = accountTree(
    accounts.filter((account) => account.isGroup && account.archivedAt === null),
  );
  const allowed = moving ? tree.filter((root) => root.item.type === moving.type) : tree;
  return flattenTree(withoutBranch(allowed, moving?.id)).map(({ node, depth }) => ({
    value: node.id,
    label: `${' '.repeat(depth)}${node.item.code} · ${node.item.name}`,
  }));
}

function withoutBranch(
  nodes: readonly TreeNode<Account>[],
  id: string | undefined,
): TreeNode<Account>[] {
  return nodes.flatMap((node) =>
    node.id === id ? [] : [{ ...node, children: withoutBranch(node.children, id) }],
  );
}

const DIGITS = /^\d+$/;

function trailingZeros(value: bigint): number {
  let zeros = 0;
  for (let rest = value; rest !== 0n && rest % 10n === 0n; rest /= 10n) zeros += 1;
  return zeros;
}

// A code for a new account under `parent`, following the numbers around it: after 1110 and 1120
// comes 1130; the first account in 1100 is 1110, in 1120 it is 1121. '' when there is no clear
// next number (codes with dots, or no room left in the group) — the person types one.
// BigInt: a code can be 20 digits, more than a JavaScript number holds exactly.
export function suggestCode(parent: Account, accounts: readonly Account[]): string {
  if (!DIGITS.test(parent.code)) return '';
  const siblings = accounts
    .filter((account) => account.parentId === parent.id && DIGITS.test(account.code))
    .map((account) => BigInt(account.code));

  let next: bigint;
  let step: bigint;
  const last = siblings.reduce<bigint | null>(
    (max, code) => (max === null || code > max ? code : max),
    null,
  );
  if (last !== null) {
    step = 10n ** BigInt(trailingZeros(last));
    next = last + step;
  } else {
    const zeros = trailingZeros(BigInt(parent.code));
    if (zeros === 0) return '';
    step = 10n ** BigInt(zeros - 1);
    next = BigInt(parent.code) + step;
  }

  // Stay inside the group's own range: under 1100, codes start with 11 and have four digits
  const prefix = parent.code.replace(/0+$/, '');
  const taken = new Set(accounts.map((account) => account.code));
  for (;;) {
    const code = String(next).padStart(parent.code.length, '0');
    if (code.length !== parent.code.length || !code.startsWith(prefix)) return '';
    if (!taken.has(code)) return code;
    next += step;
  }
}
