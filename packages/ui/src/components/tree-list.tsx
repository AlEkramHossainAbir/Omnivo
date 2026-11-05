import { ArrowDown01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { type ReactNode, useId } from 'react';

import type { TreeNode } from '../lib/tree.js';

interface TreeListProps<T> {
  // The list's name for screen readers
  label: string;
  nodes: readonly TreeNode<T>[];
  // The caller keeps the open/closed state, so it can open everything while a search is on
  isOpen: (id: string) => boolean;
  onToggle: (id: string) => void;
  // Everything right of the arrow: code, name, pills, buttons
  renderRow: (item: T) => ReactNode;
  // The arrow's label, like "Show the accounts in Current assets"
  toggleLabel: (item: T, open: boolean) => string;
}

type BranchProps<T> = Omit<TreeListProps<T>, 'label' | 'nodes'> & {
  node: TreeNode<T>;
  depth: number;
};

// CLAUDE.md → Tree list. Nested lists with one show/hide button per group (the WAI-ARIA
// "disclosure" pattern), not role="tree": a real tree widget needs arrow-key focus handling
// written by hand, while lists and buttons work with Tab, Enter and every screen reader as they
// are. Not virtualized: a chart of accounts is a few hundred rows, and closed groups render nothing.
export function TreeList<T>({ label, nodes, ...branch }: TreeListProps<T>) {
  return (
    // The first row of the card has no rule above it; every other row does
    <ul
      aria-label={label}
      className="rounded-card border border-line bg-surface shadow-sm [&>li:first-child>div]:border-t-0"
    >
      {nodes.map((node) => (
        <TreeBranch key={node.id} node={node} depth={0} {...branch} />
      ))}
    </ul>
  );
}

function TreeBranch<T>({ node, depth, isOpen, onToggle, renderRow, toggleLabel }: BranchProps<T>) {
  const listId = useId();
  const hasChildren = node.children.length > 0;
  const open = hasChildren && isOpen(node.id);
  return (
    <li>
      {/* group/row: renderRow's content can react to the row's hover (group-hover/row:…) */}
      <div className="group/row flex min-h-11 items-center gap-1 border-t border-line px-2 py-1.5 transition-colors duration-150 hover:bg-subtle sm:px-4">
        {/* 16px per level. A spacer, not padding on the row: the rule above spans the full width */}
        <span aria-hidden="true" className="shrink-0" style={{ width: depth * 16 }} />
        {hasChildren ? (
          <button
            type="button"
            aria-expanded={open}
            // Points at the list only while it exists
            aria-controls={open ? listId : undefined}
            aria-label={toggleLabel(node.item, open)}
            onClick={() => {
              onToggle(node.id);
            }}
            className="grid size-7 shrink-0 place-items-center rounded-lg text-ink-3 transition-colors duration-150 hover:text-ink"
          >
            {/* Two icons, not a rotated one: CLAUDE.md allows no transform animation */}
            <HugeiconsIcon
              icon={open ? ArrowDown01Icon : ArrowRight01Icon}
              size={16}
              strokeWidth={1.5}
            />
          </button>
        ) : (
          <span aria-hidden="true" className="size-7 shrink-0" />
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2.5">{renderRow(node.item)}</div>
      </div>
      {open && (
        <ul id={listId}>
          {node.children.map((child) => (
            <TreeBranch
              key={child.id}
              node={child}
              depth={depth + 1}
              isOpen={isOpen}
              onToggle={onToggle}
              renderRow={renderRow}
              toggleLabel={toggleLabel}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
