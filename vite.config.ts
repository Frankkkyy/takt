import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:8787', '/healthz': 'http://localhost:8787' } },
  // Bryntum Scheduler Pro (trial bundle, not minified) is one ~4.7 MB lazy chunk, loaded only by the owner console.
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 5000 },
});
