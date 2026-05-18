import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// API target. mise sets PORT for the API process; Vite inherits the same env
// so a single source controls both. Override with API_PORT if you ever want
// the web dev server to point somewhere different.
const apiPort = process.env.API_PORT || process.env.PORT || '3001';
const apiTarget = `http://localhost:${apiPort}`;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@visual-compare/api': resolve(__dirname, '../api/src'),
    },
  },
  build: {
    // Emit source maps for the production bundle so prod stack traces are
    // navigable. The .map files are served alongside the JS but are only
    // fetched by clients that open devtools, so the user-facing payload
    // is unchanged. Adds ~1–3 MB to the dist size; cheap for our scale.
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': apiTarget,
      '/images': apiTarget,
    },
  },
});
