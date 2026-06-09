# denoise-voice-clarity

Client-side noise suppression + voice-clarity for **LiveKit** calls — an
open-source, license-free replacement for the Krisp filter. Runs in the
browser via an `AudioWorklet` + WASM, attached to a `LocalAudioTrack` with
LiveKit's `setProcessor()` API.

- **Denoise**: DeepFilterNet 3 (optional build) or a passthrough reference engine.
- **Clarity**: high-pass → presence EQ → AGC → soft compressor (VAD-gated).
- **No per-seat license** (unlike Krisp / Koala).

## Install

```bash
npm install denoise-voice-clarity
# peer dep:
npm install livekit-client
```

## Use

Import **dynamically** so the multi-MB WASM stays out of your initial bundle:

```ts
import type { LocalAudioTrack } from 'livekit-client';

async function enableVoiceClarity(micTrack: LocalAudioTrack) {
  const { VoiceClarityProcessor, isVoiceClaritySupported } =
    await import('denoise-voice-clarity');

  if (!isVoiceClaritySupported()) return false; // fall back to native suppression

  const processor = new VoiceClarityProcessor({
    enabled: true,
    attenuationLimitDb: 30,
    presenceGainDb: 4,
  });
  await micTrack.setProcessor(processor);
  return true;
}
```

Toggle at runtime:

```ts
processor.setEnabled(false);
processor.setPresenceGainDb(6);
```

Disable the browser's own `noiseSuppression` / `autoGainControl` in your
`RoomOptions.audioCaptureDefaults` when this is active (keep `echoCancellation`),
so you don't double-process. See `examples/meeting-ui-integration.ts`.

## Build from source

```bash
# 1. Rust core → WASM (needs Rust + wasm-pack; see ../scripts/build-wasm.sh)
npm run build:wasm          # default: small passthrough+clarity WASM
FEATURES="wasm,dfn" npm run build:wasm   # full DeepFilterNet (needs model weights)

# 2. npm package (copies WASM, bundles worklet, emits types)
npm run build               # → dist/{index.js, voiceClarity.worklet.js, wasm/, *.d.ts}
```

`npm publish` runs `prepublishOnly` → `build`. The published package contains
only `dist/` + this README.

## Browser support

Requires `AudioWorklet` and `WebAssembly.compileStreaming` (all modern evergreen
browsers). `isVoiceClaritySupported()` gates this for you. On unsupported
browsers or load failure, the worklet falls back to passthrough and you should
fall back to native browser noise suppression.

## Notes / caveats

- The worklet ships as a self-contained classic script with the wasm-bindgen
  glue bundled in (AudioWorklet scope can't dynamic-import). Built by
  `scripts/build.mjs` (esbuild).
- Adds ~10 ms processing latency (one 480-sample frame) — fine for calls.
- The `TrackProcessor` interface can shift across `livekit-client` minors —
  tested against `^2.17`.

License: MIT.
