import { defineConfig } from 'vitest/config';

// Only the shop's plain TypeScript (data, cart). Astro components are checked by `astro check`
// and in the browser, not here.
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
});
