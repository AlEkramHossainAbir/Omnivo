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
    // Module boundary rules (apps/api must not import apps/app, etc.)
    // get added as the modular monolith takes shape — steps 6-8.
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|dist|build|coverage)(/|$)' },
  },
};
