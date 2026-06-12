---
title: Voice-Clarity mobile adapters (Android + iOS)
date: 2026-06-12
status: approved
---

# Voice-Clarity Mobile Adapters (Android + iOS)

> Extends the Voice-Clarity Add-on design
> (`DESIGN.md` / `2026-06-09-voice-clarity-noise-suppression-addon-design.md`).
> Supersedes that design's non-goal "Android/iOS implementation in this repo
> (separate repos)": the mobile adapters now live in this repo, mirroring
> `web/`.

## 1. Summary

Add Android and iOS LiveKit adapters for `denoise-voice-core`, packaged so the
Gruner mobile apps can drop them in:

- **Android** — a Gradle library module (`android/`) producing an AAR: a thin
  Kotlin `VoiceClarityAudioProcessor` implementing LiveKit's
  `AudioProcessorInterface`, backed by `libdenoise_voice_core.so` (Rust, JNI).
- **iOS** — a Swift Package (`ios/`): a thin Swift `VoiceClarityProcessor`
  implementing LiveKit's `AudioCustomProcessingDelegate`, backed by a
  `DenoiseVoiceCoreFFI.xcframework` (Rust static lib + C header).

Both adapters carry the full engine from day one: HPF → DeepFilterNet 3
(`dfn` feature) → clarity chain (AGC, presence EQ, soft compressor), VAD-gated.

## 2. Verified SDK hook points

Verified against SDK sources (livekit/client-sdk-android `main`,
livekit/client-sdk-swift `main`, and the official Krisp plugin
livekit/swift-krisp-noise-filter as the reference integration):

**Android** — `io.livekit.android.audio.AudioProcessorInterface`:

```kotlin
fun isEnabled(): Boolean
fun getName(): String
fun initializeAudioProcessing(sampleRateHz: Int, numChannels: Int)
fun resetAudioProcessing(newRate: Int)
fun processAudio(numBands: Int, numFrames: Int, buffer: ByteBuffer)
```

Attached by the app via
`LiveKitOverrides(audioOptions = AudioOptions(audioProcessorOptions =
AudioProcessorOptions(capturePostProcessor = processor)))`.

**iOS** — `AudioCustomProcessingDelegate`:

```swift
var audioProcessingName: String { get }            // optional
func audioProcessingInitialize(sampleRate: Int, channels: Int)
func audioProcessingProcess(audioBuffer: LKAudioBuffer)
func audioProcessingRelease()
```

Attached via `AudioManager.shared.capturePostProcessingDelegate = processor`.
`LKAudioBuffer` exposes `channels`, `frames`, `framesPerBand`, `bands`, and
`rawBuffer(forChannel:) -> UnsafeMutablePointer<Float>`; the Krisp plugin
loops channels and processes each channel's full banded buffer — we do the
same.

**Band-split reality (key constraint).** WebRTC's capture-post hook delivers
audio in the APM's split-band domain: at 48 kHz, 3 bands × 160
frames-per-band of f32 per channel, not the full-band 480-sample frames the
core's `process()` expects. The adapter path must merge bands → process →
re-split.

## 3. Architecture

```
WebRTC capture thread (10 ms cadence)
  Android: processAudio(numBands, numFrames, ByteBuffer)  ── direct buffer addr ─┐
  iOS:     audioProcessingProcess(LKAudioBuffer)          ── rawBuffer ptr ──────┤
                                                                                 ▼
                              dvc_process_banded(handle, bands, framesPerBand, *mut f32)
                                                                                 ▼
                       rust-core: bands::merge → [HPF → DFN3 → clarity] → bands::split
```

### 3.1 Core changes (`rust-core`)

- **`bands.rs` (new)** — port of WebRTC's splitting filter (BSD-3, license
  compatible; MIT/Apache-2.0 repo can vendor it with attribution):
  three-band DCT-modulated filterbank for 48 kHz (3×160), passthrough for
  `bands == 1`. `bands == 2` (32 kHz) is out of scope until a real capture
  path produces it — the core falls back to clarity-only (see rate policy).
  Unit test: merge∘split perfect-reconstruction within the same SNR bound
  WebRTC's own tests use.
- **Rate policy** — DFN3 runs only at 48 kHz full-band. For any other
  effective rate (e.g. 16 kHz Bluetooth HFP capture) the clarity chain
  re-initializes at the actual rate and DFN is bypassed. Mirrors the web
  design's degradation principle: never block audio, degrade silently,
  surface via logs/metrics.
- **`ffi.rs` (new, `feature = "ffi"`)** — hand-rolled C ABI, header generated
  by cbindgen:

  ```c
  DvcHandle *dvc_create(void);
  void  dvc_destroy(DvcHandle *h);
  int   dvc_init(DvcHandle *h, int sample_rate_hz, int channels);
  int   dvc_reset(DvcHandle *h, int new_rate_hz);
  int   dvc_process_banded(DvcHandle *h, int bands, int frames_per_band, float *buf);
  void  dvc_set_enabled(DvcHandle *h, bool enabled);
  void  dvc_set_attenuation_limit_db(DvcHandle *h, float db);
  void  dvc_set_clarity(DvcHandle *h, bool enabled);
  ```

  `dvc_process_banded` mutates the buffer in place (zero-copy), returns 0 on
  success / negative error code; no allocation, locking, or logging on the
  process path. Parameter setters use atomics read by the audio thread.
- **`jni.rs` (new, `feature = "android"`)** — JNI exports (via the `jni`
  crate) wrapping the same core object. `processAudio`'s direct `ByteBuffer`
  is resolved with `GetDirectBufferAddress` — zero-copy per frame.
- Existing `wasm` feature and web adapter are untouched; CI re-runs existing
  tests to prove no regression.

### 3.2 Android adapter (`android/`)

- Gradle library module, Kotlin, compiles against current stable
  `io.livekit:livekit-android` (compileOnly — the app supplies its own SDK).
- `VoiceClarityAudioProcessor : AudioProcessorInterface`:
  - `initializeAudioProcessing` → `dvc_init`; `resetAudioProcessing` →
    `dvc_reset`; `processAudio` → `dvc_process_banded` via JNI.
  - `isEnabled()` reflects a user-settable toggle AND native-lib health.
  - `System.loadLibrary` failure → adapter stays in passthrough,
    `isEnabled() = false`, one warning log. Never crashes the app.
  - N (= 50) consecutive process errors → self-disable + one log line.
- ABIs: `arm64-v8a`, `armeabi-v7a`, `x86_64` (emulator). `.so`s land in
  `src/main/jniLibs/` via `scripts/build-android.sh` (cargo-ndk), gitignored.
- Artifact: AAR via `gradle assembleRelease`; consumed as a file dependency
  or published to the GitLab package registry (publishing config included,
  registry wiring left to the mobile team's pipeline).

### 3.3 iOS adapter (`ios/`)

- Swift Package `DenoiseVoiceClarity`, depends on current stable
  `livekit/client-sdk-swift`.
- Binary target `DenoiseVoiceCoreFFI.xcframework`: static libs for
  `aarch64-apple-ios` + simulator (`aarch64-apple-ios-sim`, lipo'd with
  `x86_64-apple-ios` sim slice), plus the cbindgen header + modulemap. Built
  by `scripts/build-ios.sh`, gitignored.
- `VoiceClarityProcessor: AudioCustomProcessingDelegate`:
  - Per-channel loop over `rawBuffer(forChannel:)`, passing
    `bands`/`framesPerBand` to `dvc_process_banded` — same shape as the
    Krisp reference plugin.
  - Same degradation rules as Android (init failure → inert; error budget →
    self-disable).

### 3.4 What stays out of the adapters

No feature-flag plumbing, UI, analytics, or LiveKit room wiring — the apps own
attachment and the user toggle, exactly as `web-app` owns `FEATURE_VOICE_CLARITY`.
The adapters expose `setEnabled`, `setAttenuationLimitDb`, `setClarityEnabled`.

## 4. Build & toolchain

- `scripts/gen-header.sh` — cbindgen → checked-in
  `ios/Sources/DenoiseVoiceCoreFFI/include/denoise_voice_core.h` (regenerated,
  diff-reviewed).
- `scripts/build-android.sh` — `cargo ndk -t arm64-v8a -t armeabi-v7a -t
  x86_64 build --release --features dfn,ffi,android` → copy to `jniLibs/` →
  `./gradlew assembleRelease`.
- `scripts/build-ios.sh` — cargo builds per iOS target with
  `--features dfn,ffi` (staticlib) → lipo sim slices → `xcodebuild
  -create-xcframework`.
- **This dev machine has no NDK / Xcode / cbindgen.** Local verification is:
  host `cargo test --features ffi` (+ `dfn` once proven), `cargo check` per
  mobile target (type-checking needs no linker), and the existing wasm/web
  builds. Final AAR/XCFramework artifacts are produced by CI (GitLab job spec
  included in the deliverable) or any machine with NDK + Xcode; the scripts
  must run there unmodified.
- **Sequencing gate:** `--features dfn` has never been compiled anywhere.
  Implementation step 1 is proving it builds and passes a smoke test on the
  host (weights embedded via `default-model`). Cross-compilation comes after;
  if host build fails, fix the core before touching mobile code.

## 5. Error handling summary

| Failure | Behavior |
|---|---|
| Native lib fails to load (either OS) | Adapter inert, `isEnabled` false, one warn log; raw audio publishes untouched |
| `dvc_init` fails | Same as load failure |
| Non-48 kHz capture rate | Clarity-only (DFN bypassed), silent degradation |
| Process returns error | That frame passes through unmodified |
| 50 consecutive process errors | Self-disable + one log line |

## 6. Testing

- **Rust:** filterbank perfect-reconstruction SNR test; FFI lifecycle +
  in-place process round-trip tests (run on host); existing DSP golden tests
  unchanged; DFN host smoke test (noisy fixture in → SNR improves).
- **Android:** JVM unit tests for the adapter's state machine (enable/disable,
  error budget, load-failure inertness) with the native bridge faked; compile
  against the real LiveKit SDK.
- **iOS:** same state-machine tests via XCTest (run in CI; no Xcode locally).
- **On-device A/B** (keyboard/café/street vs native suppression) happens in
  the app teams' rollout, as with web.

## 7. Rollout

1. Prove `dfn` builds + smoke-tests on host.
2. Core: `bands.rs`, `ffi.rs`, `jni.rs` + tests (host-verified).
3. `android/` module + scripts; `ios/` package + scripts (compile-checked to
   the extent the machine allows; CI job spec for artifacts).
4. Amend `DESIGN.md` (§2 non-goals, §10 rollout) to point here.
5. Mobile teams integrate the AAR / Swift Package behind their own toggle and
   run the device A/B before enabling by default.
