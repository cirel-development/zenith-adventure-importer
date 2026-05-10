import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    minify: false,
    lib: {
      entry: resolve(__dirname, 'src/module.ts'),
      formats: ['es'],
      fileName: () => 'module.js',
    },
    rollupOptions: {
      output: {
        // Keep all CSS in one file Foundry's manifest can reference
        assetFileNames: 'zenith-adventure-importer.css',
      },
    },
  },
});
