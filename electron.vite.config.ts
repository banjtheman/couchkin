import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve('src/main/index.ts') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    base: './',
    plugins: [
      react(),
      {
        name: 'development-csp',
        apply: 'serve',
        transformIndexHtml: (html) =>
          html.replace(/<meta[^>]+http-equiv="Content-Security-Policy"[^>]*>/i, ''),
      },
    ],
    server: { host: '127.0.0.1', port: 5173, strictPort: false },
  },
});
