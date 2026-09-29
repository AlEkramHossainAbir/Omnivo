/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular imports break module boundaries and tree-shaking.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'packages-not-to-apps',
      severity: 'error',
      comment: 'Shared packages are used by apps, never the other way round.',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'browser-packages-not-to-server',
      severity: 'error',
      comment:
        'ui and i18n ship to the browser. Importing db or auth would bundle server code and secrets handling into the app.',
      from: { path: '^packages/(ui|i18n)/' },
      to: { path: ['^packages/(db|auth)/', 'node_modules/(better-auth|drizzle-orm|postgres)/'] },
    },
    {
      name: 'contracts-only-zod',
      severity: 'error',
      comment:
        'contracts is loaded by the API and the browser alike. It may use zod and nothing else, so neither side pulls in the other side of the stack.',
      from: { path: '^packages/contracts/src/', pathNot: '\\.spec\\.ts$' },
      to: { pathNot: ['^packages/contracts/src/', 'node_modules/zod/'] },
    },
    {
      name: 'mocks-only-in-dev',
      severity: 'error',
      comment:
        'MSW and the mock handlers are dev tools. App code may load them only through the dynamic import in main.tsx, which a production build removes.',
      from: { path: '^apps/app/src/', pathNot: ['^apps/app/src/mocks/', '\\.spec\\.ts$'] },
      to: {
        path: ['^apps/app/src/mocks/', 'node_modules/msw/'],
        dependencyTypesNot: ['dynamic-import'],
      },
    },
    // Module boundary rules inside apps/api (accounting must not import inventory internals,
    // etc.) get added as the modular monolith takes shape — steps 6-8.
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|dist|build|coverage)(/|$)' },
  },
};
