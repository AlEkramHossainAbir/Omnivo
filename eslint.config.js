import config from '@omnivo/config/eslint';

export default [
  ...config,
  {
    // NestJS modules are legitimately empty classes.
    files: ['apps/api/**/*.ts'],
    rules: { '@typescript-eslint/no-extraneous-class': 'off' },
  },
];
