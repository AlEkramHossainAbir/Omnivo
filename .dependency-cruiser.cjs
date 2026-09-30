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
    {
      name: 'queue-only-in-worker',
      severity: 'error',
      comment:
        'The API hands work to the worker by writing an outbox row with emit(), in the same transaction as the change. A job put on the queue straight from a request is lost when that transaction rolls back after it, or runs before the data it needs is committed.',
      from: {
        path: '^apps/api/src/',
        pathNot: ['^apps/api/src/worker/', '^apps/api/src/worker\\.ts$', '\\.spec\\.ts$'],
      },
      to: { path: 'node_modules/bullmq/' },
    },
    {
      name: 'api-not-to-worker',
      severity: 'error',
      comment:
        'worker/ is the other process (relay, queues, job runner). Feature code provides handlers that worker/ imports; it never imports worker/ itself, so the HTTP process never starts queue workers by accident.',
      from: {
        path: '^apps/api/src/',
        pathNot: ['^apps/api/src/worker/', '^apps/api/src/worker\\.ts$', '^apps/api/src/testing/'],
      },
      to: { path: '^apps/api/src/worker/' },
    },
    // More module boundary rules inside apps/api (accounting must not import inventory internals,
    // etc.) get added as the modular monolith takes shape.
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Only our own build output. node_modules must stay in the graph (doNotFollow above already
    // stops the cruise there): excluding it — or any path with /dist/ in it, which is where most
    // packages keep their code — removed the packages themselves, so rules that point at a package
    // (contracts-only-zod, queue-only-in-worker) could never fire.
    exclude: { path: '^(apps|packages)/[^/]+/(dist|dist-worker|build|coverage)/' },
  },
};
