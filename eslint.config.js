import config from '@omnivo/config/eslint';

export default [
  ...config,
  {
    // NestJS modules are legitimately empty classes.
    files: ['apps/api/**/*.ts'],
    rules: { '@typescript-eslint/no-extraneous-class': 'off' },
  },
  {
    // TanStack Router redirects by throwing its Redirect (a Response, not an Error) from
    // beforeLoad. Allow exactly that type, keep the rule for everything else.
    files: ['apps/app/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/only-throw-error': [
        'error',
        { allow: [{ from: 'package', package: '@tanstack/router-core', name: 'Redirect' }] },
      ],
    },
  },
  {
    // Step 26d: `interface Translation extends Messages {}` is empty on purpose: it is the place
    // '@omnivo/i18n/shop' adds the shop's words by declaration merging, which a type alias cannot
    // take. The option allows exactly that shape (one `extends`), in this one file.
    files: ['packages/i18n/src/types.ts'],
    rules: {
      '@typescript-eslint/no-empty-object-type': [
        'error',
        { allowInterfaces: 'with-single-extends' },
      ],
    },
  },
];
