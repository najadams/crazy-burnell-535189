import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';

// Counter is an Electron app. The renderer is a plain Vite + React bundle;
// the main + preload processes are bundled by vite-plugin-electron and
// emitted into dist-electron/. package.json `main` points there.

export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        entry: 'src/main/index.ts',
        vite: {
          build: {
            // Electron main needs CommonJS for `require` of native modules
            // (better-sqlite3). vite-plugin-electron handles the format.
            sourcemap: true,
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['better-sqlite3'],
            },
          },
        },
      },
      preload: {
        input: 'src/main/preload.ts',
        vite: {
          build: {
            sourcemap: true,
            outDir: 'dist-electron',
          },
        },
      },
      renderer: {},
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
