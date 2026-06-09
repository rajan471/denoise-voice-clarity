// WASM + AudioWorklet loading.
//
// AudioWorklet code runs in a separate global scope that can't `fetch` or do
// arbitrary dynamic imports reliably across browsers. So the pattern is:
//   1. main thread fetches + compiles the .wasm into a `WebAssembly.Module`
//   2. registers the worklet module (the processor script) on the AudioContext
//   3. hands the compiled module to the worklet via `processorOptions`
//   4. the worklet instantiates it synchronously (wasm-bindgen `initSync`)
//
// This keeps instantiation off the audio thread's hot path and avoids
// async-in-worklet pitfalls.

// Paths are relative to the built entry (dist/index.js), so they match the
// published package layout: dist/{index.js, voiceClarity.worklet.js, wasm/*}.
// `new URL(..., import.meta.url)` lets the consuming bundler (Vite in web-app)
// fingerprint + copy these assets automatically.
const WASM_URL = new URL('./wasm/denoise_voice_core_bg.wasm', import.meta.url);
const WORKLET_URL = new URL('./voiceClarity.worklet.js', import.meta.url);

export interface LoadedRuntime {
  /** Compiled (not yet instantiated) core module, passed to each worklet. */
  module: WebAssembly.Module;
  /** True once the worklet processor is registered on the given context. */
  workletRegistered: boolean;
}

const registeredContexts = new WeakSet<BaseAudioContext>();

/** Feature/capability check used by the toggle UI. */
export function isVoiceClaritySupported(): boolean {
  return (
    typeof AudioWorkletNode !== 'undefined' &&
    typeof WebAssembly !== 'undefined' &&
    typeof WebAssembly.compileStreaming === 'function'
  );
}

/** Compile the WASM module once (cheap to reuse across tracks). */
export async function compileCore(): Promise<WebAssembly.Module> {
  // compileStreaming avoids buffering the whole .wasm in JS memory.
  return WebAssembly.compileStreaming(fetch(WASM_URL));
}

/** Register the AudioWorklet processor on a context (idempotent per context). */
export async function ensureWorklet(context: BaseAudioContext): Promise<void> {
  if (registeredContexts.has(context)) return;
  await context.audioWorklet.addModule(WORKLET_URL);
  registeredContexts.add(context);
}

export async function loadRuntime(context: BaseAudioContext): Promise<LoadedRuntime> {
  const [module] = await Promise.all([compileCore(), ensureWorklet(context)]);
  return { module, workletRegistered: true };
}
