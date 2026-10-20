import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Build stamp for the footer's "Site details" (like teachChat): the git short hash of what shipped,
// and a human-scale deploy number (commits on this line of history; two deploys of one commit share it).
let build = 'dev';
let buildNum = '0';
try {
  build = execSync('git rev-parse --short HEAD').toString().trim();
  buildNum = execSync('git rev-list --count HEAD').toString().trim();
} catch {
  /* not a git checkout: "dev" */
}

// Builds web/ into public/, which the Worker serves (wrangler.jsonc "assets").
export default defineConfig({
  root: import.meta.dirname,
  define: {
    __BUILD__: JSON.stringify(build),
    __BUILD_NUM__: JSON.stringify(buildNum),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  build: {
    outDir: resolve(import.meta.dirname, '../public'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        host: resolve(import.meta.dirname, 'host/index.html'),
        board: resolve(import.meta.dirname, 'board/index.html'),
        admin: resolve(import.meta.dirname, 'admin/index.html'),
      },
    },
  },
  server: {
    // `npm run dev:web` against a running `wrangler dev` on :8792 (ws: the room sockets)
    proxy: { '/api': { target: 'http://127.0.0.1:8792', ws: true } },
  },
});
