// esbuild build for the npm package.
//
// Produces three artifacts in dist/:
//   index.js                  — the public API (ESM; livekit-client external)
//   voiceClarity.worklet.js   — the AudioWorklet, with the wasm-bindgen glue
//                               BUNDLED IN (worklet scope can't dynamic-import).
//   wasm/                     — the .wasm binary + glue (copied by copy-wasm.mjs)
//
// The worklet is emitted as a classic, self-contained script (no import/export,
// no import.meta) so `audioWorklet.addModule()` accepts it on every browser.
import { build } from 'esbuild';
import { existsSync } from 'node:fs';

const wasmGlue = 'wasm/denoise_voice_core.js';
if (!existsSync(new URL(`../dist/${wasmGlue}`, import.meta.url))) {
  console.warn(
    `\n⚠  dist/${wasmGlue} not found.\n` +
      `   Run \`npm run build:wasm\` then \`npm run copy:wasm\` first,\n` +
      `   or the worklet will be bundled without the core (passthrough only).\n`,
  );
}

const common = {
  bundle: true,
  minify: true,
  target: ['es2022'],
  logLevel: 'info',
};

// 1) Public API — ESM, keep livekit-client and the asset URLs external.
await build({
  ...common,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  format: 'esm',
  platform: 'browser',
  external: ['livekit-client'],
  // The .wasm and worklet are loaded at runtime via `new URL(..., import.meta.url)`;
  // mark as external so esbuild leaves the URLs intact (we ship the files).
  loader: { '.wasm': 'file' },
});

// AudioWorkletGlobalScope lacks TextDecoder in some browsers, but the
// wasm-bindgen glue instantiates `new TextDecoder()` at module top-level. As a
// banner this runs FIRST — before the hoisted glue — so it's always defined.
const TEXTDECODER_POLYFILL =
  'if(typeof TextDecoder==="undefined"){globalThis.TextDecoder=class{' +
  'decode(b){if(!b)return"";const a=b instanceof Uint8Array?b:new Uint8Array(b.buffer||b);' +
  'let s="",i=0;while(i<a.length){let c=a[i++];' +
  'if(c<128)s+=String.fromCharCode(c);' +
  'else if(c<224)s+=String.fromCharCode((c&31)<<6|a[i++]&63);' +
  'else if(c<240)s+=String.fromCharCode((c&15)<<12|(a[i++]&63)<<6|a[i++]&63);' +
  'else{let p=((c&7)<<18|(a[i++]&63)<<12|(a[i++]&63)<<6|a[i++]&63)-65536;' +
  's+=String.fromCharCode(55296+(p>>10),56320+(p&1023))}}return s}}}';

// 2) Worklet — classic IIFE so it's a valid AudioWorklet module everywhere.
//    The wasm-bindgen glue gets inlined here; initSync(module) is fed the
//    compiled module from the main thread, so the glue's own fetch path is unused.
await build({
  ...common,
  entryPoints: ['src/worklet/voiceClarity.worklet.ts'],
  outfile: 'dist/voiceClarity.worklet.js',
  format: 'iife',
  platform: 'browser',
  banner: { js: TEXTDECODER_POLYFILL },
  // AudioWorkletGlobalScope has no `import.meta`; define a harmless shim so any
  // residual reference in the glue doesn't throw. We never use the glue's URL.
  define: { 'import.meta.url': '""' },
});

console.log('\n✓ built dist/index.js + dist/voiceClarity.worklet.js');
