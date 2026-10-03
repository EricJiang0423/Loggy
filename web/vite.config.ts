import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [react()],
  build: {
    outDir: path.resolve(import.meta.dirname, '../dist/web'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5317,
    proxy: { '/api': 'http://127.0.0.1:4317' },
  },
});
