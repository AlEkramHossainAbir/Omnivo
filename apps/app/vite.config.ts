import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true },
  // dist/.vite/manifest.json: কোন chunk কোন chunk-কে import করে — bundle-size চেক এটা পড়ে
  build: { manifest: true },
});
