import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  build: { outDir: '../dist/client', emptyOutDir: true, target: 'es2022' },
  server: {
    port: 5173,
    // The client always talks to same-origin /ws. In dev that is proxied to the
    // game server; in prod the game server serves the built client itself. One
    // code path, no environment branching in the client.
    proxy: { '/ws': { target: 'ws://localhost:8787', ws: true } },
  },
});
