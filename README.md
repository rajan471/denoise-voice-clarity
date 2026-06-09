# denoiseVoiceClarity

A self-hosted, **license-free** replacement for the Krisp noise filter on
LiveKit calls. Runs **client-side** in the participant's app, before audio is
published to the SFU — the same place Krisp runs.

It is a two-stage chain:

```
mic ─▶ [HPF] ─▶ [DeepFilterNet 3 denoise] ─▶ [clarity chain] ─▶ LiveKit publish
              rumble cut    speech enhance     AGC + presence EQ + soft comp
```

1. **Denoise** — DeepFilterNet 3 (MIT / Apache-2.0) removes background noise.
2. **Clarity** — light DSP (AGC, presence EQ, soft compressor) boosts the voice
   that's left and keeps levels consistent.

The motivation is licensing: Krisp / Picovoice Koala charge per seat/minute.
DeepFilterNet 3 / RNNoise / DTLN are all free for commercial use, and LiveKit's
`setProcessor()` audio API is open — so the whole pipeline carries no license fee.

Full design: [`DESIGN.md`](./DESIGN.md).

## Layout

```
denoiseVoiceClarity/
  DESIGN.md            # the approved design / spec
  rust-core/           # denoise-voice-core: shared engine (Rust → WASM + native)
    Cargo.toml
    src/
      lib.rs           # public API: VoiceClarity { process(frame) }
      engine.rs        # Denoiser trait + Passthrough + DeepFilterNet bindings
      clarity.rs       # DSP: biquad HPF, presence EQ, AGC, compressor
      vad.rs           # energy-based voice-activity gate
      wasm.rs          # wasm-bindgen bindings (feature = "wasm")
  web/                 # web adapter for web-app (livekit-client)
    package.json
    src/
      VoiceClarityProcessor.ts   # LiveKit TrackProcessor (lazy-loads WASM)
      worklet/voiceClarity.worklet.ts  # AudioWorkletProcessor → WASM
      loader.ts        # dynamic import of the WASM bundle (bundle-budget safe)
  scripts/
    build-wasm.sh      # wasm-pack build → web/wasm/
```

## Status

| Part | State |
|---|---|
| Clarity DSP chain (HPF, EQ, AGC, compressor, VAD) | ✅ implemented + unit-tested |
| Engine trait + passthrough reference engine | ✅ implemented (builds & tests today) |
| DeepFilterNet 3 binding | 🟡 wired against the `deep_filter` crate, behind `feature = "dfn"`; needs the toolchain + model weights to build |
| WASM bindings | ✅ written; needs `wasm-pack` to produce the bundle |
| Web TrackProcessor + AudioWorklet | ✅ written; verify against the installed `livekit-client` version |
| Android / iOS adapters | ⛔ separate repos, out of scope here (reuse the core) |

## Build

### Rust core (native, for tests)
```bash
cd rust-core
cargo test                 # builds passthrough engine + DSP, runs unit tests
cargo build --release      # native lib
```

### DeepFilterNet engine
```bash
cd rust-core
cargo build --release --features dfn   # pulls deep_filter; needs model weights
```
The model path is read from `DFN_MODEL_PATH` (see `engine.rs`). Download the
DFN3 weights from the DeepFilterNet release and point the env var at them.

### WASM (for web)
```bash
./scripts/build-wasm.sh    # wasm-pack build --target web → web/wasm/
```

### Web adapter
```bash
cd web && npm install && npm run build
```

## Integrating into web-app

In `web-app/src/infra/livekit`, when the user enables the feature flag
`FEATURE_VOICE_CLARITY`:

1. Lazy-import this package (keeps the multi-MB WASM out of the initial bundle —
   `web-app` CI blocks bundles >350 KB).
2. Disable browser-native `noiseSuppression` + `autoGainControl` in
   `audioCaptureDefaults` (keep `echoCancellation: true`).
3. Attach `VoiceClarityProcessor` to the published mic `LocalAudioTrack` via
   `setProcessor()`.
4. On load failure / unsupported browser → fall back to native suppression.

See `DESIGN.md` §5 for the exact seam (`realLivekitAdapter.ts:231`).
