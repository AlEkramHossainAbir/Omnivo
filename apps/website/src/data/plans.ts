// The plans on the pricing section. The plans and what they include are the README's draft
// ("Pricing (draft)"). The PRICES ARE PLACEHOLDERS: the README sets none. Later (build plan step
// 23) the plans come from the product catalog the Admin panel manages, and this file goes.
//
// Money stays a string, as everywhere in Omnivo: the page only shows it, never adds it up.
export interface Plan {
  id: 'free' | 'starter' | 'growth' | 'enterprise';
  name: string;
  // who it is for, under the name
  audience: string;
  // null = no fixed price ("Custom")
  price: {
    monthly: string; // per month, billed monthly
    yearlyPerMonth: string; // per month, billed yearly (2 months free)
    yearlyTotal: string; // what a year costs
  } | null;
  features: readonly string[];
  cta: string;
  recommended: boolean;
}

export const PLANS: readonly Plan[] = [
  {
    id: 'free',
    name: 'Free',
    audience: 'For a freelancer, or to try Omnivo',
    price: { monthly: '৳0', yearlyPerMonth: '৳0', yearlyTotal: '৳0' },
    features: ['1 user and 1 branch', 'Accounting and invoicing', 'Bangla and English'],
    cta: 'Start free',
    recommended: false,
  },
  {
    id: 'starter',
    name: 'Starter',
    audience: 'For a shop or a small trader',
    price: { monthly: '৳1,500', yearlyPerMonth: '৳1,250', yearlyTotal: '৳15,000' },
    features: [
      'Up to 5 users',
      'Accounting, inventory and sales',
      'POS counter with shifts',
      'Keeps working offline',
    ],
    cta: 'Choose Starter',
    recommended: false,
  },
  {
    id: 'growth',
    name: 'Growth',
    audience: 'For a business with depots and branches',
    price: { monthly: '৳4,500', yearlyPerMonth: '৳3,750', yearlyTotal: '৳45,000' },
    features: [
      'Up to 25 users',
      'Every module: purchase, approvals, reports',
      'Many branches and depots',
      'API access',
    ],
    cta: 'Choose Growth',
    recommended: true,
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    audience: 'For a factory or a large distributor',
    price: null,
    features: [
      'Unlimited users',
      'A database of your own',
      'Single sign-on (SSO)',
      'SLA and your own domain',
    ],
    cta: 'Talk to us',
    recommended: false,
  },
];
