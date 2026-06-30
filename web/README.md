# denoise-voice-clarity

[![npm version](https://img.shields.io/npm/v/denoise-voice-clarity.svg?color=33e6a0)](https://www.npmjs.com/package/denoise-voice-clarity)
[![npm downloads](https://img.shields.io/npm/dm/denoise-voice-clarity.svg?color=33e6a0)](https://www.npmjs.com/package/denoise-voice-clarity)
[![license](https://img.shields.io/npm/l/denoise-voice-clarity.svg?color=33e6a0)](./LICENSE)
[![types](https://img.shields.io/npm/types/denoise-voice-clarity.svg?color=33e6a0)](https://www.npmjs.com/package/denoise-voice-clarity)

**Real-time noise suppression for the browser — a free, open-source, license-free
Krisp replacement.** Runs 100% client-side in an `AudioWorklet` + WebAssembly
(DeepFilterNet 3), so no audio ever leaves the user's device and there are no
per-seat fees. Works with **plain WebRTC / `getUserMedia`** and ships a thin
**LiveKit** adapter.

### ▶ [Try the live demo](https://rajan471.github.io/denoise-voice-clarity/) — hear it on your own mic

Toggle the filter on your microphone, record an A/B clip, and watch a live
input-vs-denoised spectrum: **https://rajan471.github.io/denoise-voice-clarity/**
(runs entirely in your browser — no audio is uploaded).

---

- **Denoise** — DeepFilterNet 3 neural suppression (optional build) or a passthrough reference engine.
- **Clarity** — high-pass → presence EQ → AGC → soft compressor, VAD-gated.
- **No license server, no per-seat cost** (unlike Krisp / Koala).
- **Provider-agnostic** — anything that gives you a `MediaStreamTrack` works.
- **Lazy-loaded** — dynamic-import keeps the multi-MB WASM out of your initial bundle.

## How it compares

| | denoise-voice-clarity | Krisp | Koala (Picovoice) | RNNoise (jitsi) |
|---|---|---|---|---|
| License | **MIT, free** | Commercial, per-seat | Commercial | BSD, free |
| Runs in-browser (no server) | ✅ | ✅ (LiveKit Cloud) | ✅ | ✅ |
| Model | DeepFilterNet 3 | Proprietary | Proprietary | RNNoise |
| Audio leaves device | **No** | No | No | No |
| Works outside LiveKit | ✅ (any WebRTC) | Tied to vendor SDKs | ✅ | ✅ |
| Voice-clarity chain (EQ/AGC) | ✅ | partial | ❌ | ❌ |

## Install

```bash
npm install denoise-voice-clarity
```

## Quick start (any WebRTC / `getUserMedia`)

No LiveKit required. Dynamic-import so the WASM stays out of your initial bundle:

```ts
async function enableDenoise(): Promise<MediaStream> {
  const { createDenoisedStream, isVoiceClaritySupported } =
    await import('denoise-voice-clarity');

  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { noiseSuppression: false, autoGainControl: false, echoCancellation: true },
  });

  if (!isVoiceClaritySupported()) return mic; // fall back to the raw mic

  const denoised = await createDenoisedStream(mic, {
    enabled: true,
    attenuationLimitDb: 30, // higher = more removal
    presenceGainDb: 4,      // "clarity strength"
  });

  // denoised.stream / denoised.track are clean — publish them anywhere:
  //   peerConnection.addTrack(denoised.track, denoised.stream)
  //   twilioLocalAudioTrack, daily, agora, <audio>.srcObject, …
  return denoised.stream;
}
```

Toggle and tune at runtime, then tear down:

```ts
denoised.setEnabled(false);     // bypass (hear the raw mic)
denoised.setPresenceGainDb(6);  // more presence
await denoised.destroy();        // free the graph + AudioContext
```

> Turn **off** the browser's own `noiseSuppression` / `autoGainControl` when this
> is active (keep `echoCancellation`) so you don't double-process.

## LiveKit

A `TrackProcessor` adapter is included — attach it to a `LocalAudioTrack`:

```ts
import type { LocalAudioTrack } from 'livekit-client';

async function enableVoiceClarity(micTrack: LocalAudioTrack) {
  const { VoiceClarityProcessor, isVoiceClaritySupported } =
    await import('denoise-voice-clarity');
  if (!isVoiceClaritySupported()) return false; // fall back to native suppression

  const processor = new VoiceClarityProcessor({ enabled: true, presenceGainDb: 4 });
  await micTrack.setProcessor(processor);
  return true;
}
```

Disable native suppression in `RoomOptions.audioCaptureDefaults` (keep
`echoCancellation`). Full wiring: [`examples/meeting-ui-integration.ts`](./examples/meeting-ui-integration.ts).
`livekit-client ^2.17` is an optional peer dependency — only needed if you use
this adapter.

## API

| Export | Description |
|---|---|
| `createDenoisedStream(stream, opts?)` | Denoise a `MediaStream`'s first audio track → `DenoiseHandle`. |
| `createDenoisedTrack(track, opts?)` | Denoise a single `MediaStreamTrack` → `DenoiseHandle`. |
| `DenoiseEngine` | Low-level engine if you want to manage the graph yourself. |
| `VoiceClarityProcessor` | LiveKit `TrackProcessor` adapter. |
| `isVoiceClaritySupported()` | Capability check (`AudioWorklet` + streaming WASM). |

`DenoiseOptions`: `enabled` (default `true`), `attenuationLimitDb` (0–100, default
30), `presenceGainDb` (−12…12, default 4). A `DenoiseHandle` exposes `track`,
`stream`, `setEnabled()`, `setPresenceGainDb()`, and `destroy()`.

## Browser support

Requires `AudioWorklet` and `WebAssembly.compileStreaming` (all modern evergreen
browsers). `isVoiceClaritySupported()` gates it for you; fall back to the raw mic
+ native suppression otherwise.

## Build from source

```bash
# 1. Rust core → WASM (needs Rust + wasm-pack; see ../scripts/build-wasm.sh)
npm run build:wasm                        # small passthrough+clarity WASM
FEATURES="wasm,dfn" npm run build:wasm    # full DeepFilterNet (needs model weights)

# 2. npm package (copies WASM, bundles worklet, emits types)
npm run build                             # → dist/{index.js, voiceClarity.worklet.js, wasm/, *.d.ts}
```

`npm publish` runs `prepublishOnly` → `build`; the published package contains only
`dist/` + this README.

## Notes / caveats

- The worklet is a self-contained classic script with the wasm-bindgen glue
  inlined (AudioWorklet scope can't dynamic-import). Built by `scripts/build.mjs`.
- Adds ~10 ms latency (one 480-sample frame at 48 kHz) — fine for calls.
- The full DeepFilterNet model WASM is large (~18 MB); always dynamic-import it.
- The `TrackProcessor` interface can shift across `livekit-client` minors — tested
  against `^2.17`.

License: MIT.
