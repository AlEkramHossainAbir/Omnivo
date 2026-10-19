import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// One route's summary in the built contracts, a whole line: `summary: 'Sales orders, newest date
// first',` (a summary with an apostrophe is in double quotes). Never `summary: route.summary,`.
const ROUTE_SUMMARY = /^[ \t]*summary: (?:'[^'\n]*'|"[^"\n]*"),\n/gm;

// Step 17b: a route's summary is English for the OpenAPI document (contracts' gen-openapi and the
// API's docs). The browser never reads it, and every page's chunk carried all 244 of them: 4 KB gz
// of each page's 100 KB budget, growing with every step's routes. The built contracts lose them
// here, in the app's bundle only. The type still says `summary: string`; no app code may read it.
function dropRouteSummaries(): Plugin {
  return {
    name: 'omnivo:drop-route-summaries',
    transform(code, id) {
      if (!id.includes('/packages/contracts/dist/')) return null;
      return { code: code.replace(ROUTE_SUMMARY, ''), map: null };
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), dropRouteSummaries()],
  server: { port: 5173, strictPort: true },
  // dist/.vite/manifest.json: কোন chunk কোন chunk-কে import করে — bundle-size চেক এটা পড়ে
  build: { manifest: true },
});
