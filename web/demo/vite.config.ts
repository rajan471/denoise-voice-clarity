import { defineConfig } from 'vite';

// The demo imports the package straight from its built `../dist`. Vite needs to
// be allowed to serve files from the parent package dir (dist/, wasm assets).
export default defineConfig({
  // Relative base so the built demo works on GitHub Pages / any sub-path host.
  base: './',
  server: {
    fs: { allow: ['..'] },
  },
  // The cross-origin-isolation headers some browsers want for high-res audio.
  // Harmless if unused; helps WASM threads if you enable them later.
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
