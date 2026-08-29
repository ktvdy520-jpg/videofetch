import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(__dirname),
  base: '/videofetch/',
  publicDir: resolve(__dirname, 'public'),
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../src/shared'),
    },
  },
  build: {
    outDir: resolve(__dirname, '../docs'),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        dl: resolve(__dirname, 'dl.html'),
      },
    },
  },
  server: {
    port: 5174,
    strictPort: true,
  },
});
