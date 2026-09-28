import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/build/**', '**/coverage/**', '**/.turbo/**'],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  // Hooks only at the top level of components/hooks, and effect dependencies stay complete.
  reactHooks.configs.flat.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: process.cwd(),
      },
    },
    rules: {
      // Only matters with the React Compiler, which we do not run. It flags every
      // TanStack Virtual/Table hook, so the warning would be permanent noise.
      'react-hooks/incompatible-library': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-expect-error': 'allow-with-description',
          minimumDescriptionLength: 10,
        },
      ],
    },
  },
  {
    // Plain JS here is only Node config files. TS files get their globals from each
    // tsconfig's lib/types (DOM for app/ui/i18n, node for api/db/auth), not from ESLint.
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
);
