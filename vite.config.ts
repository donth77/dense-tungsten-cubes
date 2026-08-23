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
  server: {
    host: true, // bind on the LAN so a real phone can hit the dev server
    /*
     * PINNED, and strict.
     *
     * Vite's default 5173 collides with another project on this machine, and the failure
     * is silent in a nasty way: that project binds IPv6 `[::1]:5173` only, so Vite finds
     * IPv4 free, takes it, and reports "ready" on 5173 — while macOS resolves `localhost`
     * to IPv6 and hands the browser the OTHER app. Dense is running and invisible.
     *
     * `strictPort` is the half that matters. Without it Vite silently walks to the next
     * free port when there is a real conflict, and you go looking at the wrong URL.
     */
    port: 5180,
    strictPort: true,
  },
});
