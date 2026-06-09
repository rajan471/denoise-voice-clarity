// Copy the wasm-pack output (web/wasm/) into the publishable dist/wasm/.
// Run after `npm run build:wasm`. If the WASM hasn't been built yet, this warns
// and exits 0 so a JS-only build (passthrough) still succeeds in CI.
import { cp, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const src = new URL('../wasm/', import.meta.url);
const dst = new URL('../dist/wasm/', import.meta.url);

if (!existsSync(src)) {
  console.warn('⚠  web/wasm/ not found — run `npm run build:wasm` first. Skipping.');
  process.exit(0);
}

await mkdir(dst, { recursive: true });
// Exclude wasm-pack's own .gitignore (contains `*`, which npm honours and would
// strip the whole wasm dir from the published tarball) and its package.json
// (a nested package.json changes module resolution for files in this dir).
const skip = new Set(['.gitignore', 'package.json']);
await cp(src, dst, {
  recursive: true,
  filter: (s) => !skip.has(s.split('/').pop()),
});
const files = await readdir(dst);
console.log(`✓ copied ${files.length} wasm artifact(s) → dist/wasm/:`, files.join(', '));
