import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  // পেজের একমাত্র primary বাটন সাধারণত এখানে (CLAUDE.md: প্রতি view-এ একটা primary)
  actions?: ReactNode;
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    // flex-wrap: ফোনে বাটন শিরোনামের নিচে নেমে যায়, আড়াআড়ি scroll হয় না
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-h1">{title}</h1>
        {description && <p className="mt-1 text-label text-ink-3">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

interface SectionHeaderProps {
  title: string;
  subtitle?: string | undefined;
}

// পেজের ভেতরের অংশের শিরোনাম, কার্ড ছাড়া — যেমন DataTable-এর উপরে (যেটা নিজেই কার্ড)।
// দেখতে CardHeader-এর মতো (১৫px/600 + ১৩px ink-3), কিন্তু padding নেই
export function SectionHeader({ title, subtitle }: SectionHeaderProps) {
  return (
    <header>
      <h2 className="text-h3">{title}</h2>
      {subtitle && <p className="text-label text-ink-3">{subtitle}</p>}
    </header>
  );
}
