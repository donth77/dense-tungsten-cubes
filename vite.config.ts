import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// 08 §3. No plugins needed: rapier3d-compat embeds its wasm as base64, so there is
// no MIME configuration and no separate asset to serve.
export default defineConfig({
  base: './', // static-host friendly
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        // The toy.
        main: resolve(import.meta.dirname, 'index.html'),
        // The tuning workbench: built, but never linked from the UI.
        calibrate: resolve(import.meta.dirname, 'calibrate.html'),
      },
    },
  },
  server: { host: true }, // bind on the LAN so a real phone can hit the dev server
});
