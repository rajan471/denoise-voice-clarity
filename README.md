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
      bands.rs         # WebRTC 3-band QMF filterbank + BandedVoiceClarity
      ffi.rs           # C ABI exports (feature = "ffi"); header from gen-header.sh
      jni.rs           # JNI exports for Android (feature = "android")
      wasm.rs          # wasm-bindgen bindings (feature = "wasm")
  web/                 # web adapter for web-app (livekit-client)
    package.json
    src/
      VoiceClarityProcessor.ts   # LiveKit TrackProcessor (lazy-loads WASM)
      worklet/voiceClarity.worklet.ts  # AudioWorkletProcessor → WASM
      loader.ts        # dynamic import of the WASM bundle (bundle-budget safe)
  android/             # Gradle library module → AAR (LiveKit Android 2.18.2)
    build.gradle.kts
    src/main/
      java/com/gruner/voiceclarity/VoiceClarityAudioProcessor.kt  # implements AudioProcessorInterface via JNI
      jniLibs/         # .so files for arm64-v8a / armeabi-v7a / x86_64 (gitignored; built by script)
  ios/                 # Swift Package: DenoiseVoiceClarity (LiveKit Swift SDK 2.15.0)
    Package.swift
    Sources/
      VoiceClarity/VoiceClarityProcessor.swift  # implements AudioCustomProcessingDelegate
      DenoiseVoiceCoreFFI/include/              # cbindgen header + modulemap (committed)
    Frameworks/        # DenoiseVoiceCoreFFI.xcframework (gitignored; built by script)
  scripts/
    build-wasm.sh      # wasm-pack build → web/wasm/
    gen-header.sh      # cbindgen → ios/Sources/DenoiseVoiceCoreFFI/include/ header
    build-android.sh   # cargo-ndk → jniLibs/ → gradle assembleRelease → AAR
    build-ios.sh       # cargo iOS targets → lipo → xcodebuild xcframework
```

## Status

| Part | State |
|---|---|
| Clarity DSP chain (HPF, EQ, AGC, compressor, VAD) | ✅ implemented + unit-tested |
| Engine trait + passthrough reference engine | ✅ implemented (builds & tests today) |
| DeepFilterNet 3 binding | ✅ builds + real-time on host (~0.2 ms/frame vs 10 ms budget); weights embedded via `default-model` feature — no env var needed |
| WASM bindings | ✅ written; needs `wasm-pack` to produce the bundle |
| Web TrackProcessor + AudioWorklet | ✅ written; verify against the installed `livekit-client` version |
| Android / iOS adapters | ✅ in-repo (`android/`, `ios/`); see [`docs/superpowers/specs/2026-06-12-voice-clarity-mobile-adapters-design.md`](./docs/superpowers/specs/2026-06-12-voice-clarity-mobile-adapters-design.md) |

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
cargo build --release --features dfn   # weights are embedded via default-model; no env var needed
cargo test --features dfn              # smoke-tests on host (~0.2 ms/frame measured)
```

### WASM (for web)
```bash
./scripts/build-wasm.sh    # wasm-pack build --target web → web/wasm/
```

### Web adapter
```bash
cd web && npm install && npm run build
```

### Android (AAR)

Prerequisites: Android NDK, `cargo-ndk` (`cargo install cargo-ndk`), Rust
targets `aarch64-linux-android`, `armv7-linux-androideabi`, `x86_64-linux-android`.

```bash
./scripts/build-android.sh   # cargo-ndk → android/src/main/jniLibs/ → gradle assembleRelease
# Output: android/build/outputs/aar/voiceclarity-release.aar
```

CI manual job `android-aar` produces the artifact without a local NDK — trigger
it from the GitLab pipeline page and download from the job artifacts.

### iOS (XCFramework + Swift Package)

Prerequisites: macOS with full Xcode (not just Command Line Tools), Rust
targets `aarch64-apple-ios`, `aarch64-apple-ios-sim`, `x86_64-apple-ios`.

```bash
./scripts/gen-header.sh      # cbindgen → ios/Sources/DenoiseVoiceCoreFFI/include/
./scripts/build-ios.sh       # cargo iOS targets → lipo → xcodebuild -create-xcframework
# Output: ios/Frameworks/DenoiseVoiceCoreFFI.xcframework  (then consumed by Package.swift)
```

CI manual job `ios-xcframework` produces the artifact — trigger from the
GitLab pipeline page and download from the job artifacts.

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

## Integrating into the mobile apps

### Android

Pull the AAR from the GitHub Release (see "Consuming from GitHub Releases"
below), add it as a file dependency, or publish to a Maven registry — publishing
config is included in `android/`. Attach before connecting to the room:

```kotlin
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.audio.AudioOptions
import io.livekit.android.audio.AudioProcessorOptions
import com.gruner.voiceclarity.VoiceClarityAudioProcessor

val processor = VoiceClarityAudioProcessor()
processor.setEnabled(true)
processor.setAttenuationLimitDb(20f)   // optional; default is fine

val room = LiveKit.create(
    appContext = applicationContext,
    overrides = LiveKitOverrides(
        audioOptions = AudioOptions(
            audioProcessorOptions = AudioProcessorOptions(
                capturePostProcessor = processor
            )
        )
    )
)
```

**Band layout (Android):** the WebRTC external audio processor hook delivers
full-band mono float data (e.g. 480 samples @ 48 kHz, post-band-merge); the
adapter forwards `bands = 1` to the core. The core's merge→process→split path
is a no-op for this case.

**Teardown:** call `room.disconnect()` and stop capture before releasing the
processor. Do not call the processor after release.

**Degradation:** if `libdenoise_voice_core.so` fails to load, the adapter stays
inert (`isEnabled()` returns `false`) and raw audio publishes untouched — no
crash, one warn log. After 50 consecutive process errors the adapter
self-disables with one log line.

### iOS

Add the `ios/` directory as a local Swift Package dependency in Xcode
(File → Add Package Dependencies → Add Local…). The package name is
`DenoiseVoiceClarity`, product `VoiceClarity`.

```swift
import LiveKit
import VoiceClarity

let processor = VoiceClarityProcessor()
processor.isUserEnabled = true
processor.setAttenuationLimitDb(20)    // optional

AudioManager.shared.capturePostProcessingDelegate = processor
// connect to room as normal
```

**Band layout (iOS):** `LKAudioBuffer` exposes genuine APM split-band data
(3 × 160 frames-per-band @ 48 kHz). The adapter passes `bands` and
`framesPerBand` through to the core, which runs the full 3-band
merge→process→split path.

**Teardown:** set `AudioManager.shared.capturePostProcessingDelegate = nil`
and stop capture before releasing the processor.

**Degradation:** same rules as Android — init failure leaves the processor
inert; 50 consecutive errors trigger self-disable with one log line.

## Publishing & consuming via GitHub Releases

Releases are public, so any project can consume these artifacts. Pushing a
**bare-semver tag** (e.g. `0.1.0`, *not* `v0.1.0`) triggers
`.github/workflows/release.yml`, which builds and attaches:

- `voiceclarity-<version>.aar` (+ `.sha256`) — Android, all three ABIs bundled
- `DenoiseVoiceCoreFFI-<version>.xcframework.zip` (+ `.sha256`) — iOS

```bash
git tag 0.1.0 && git push origin 0.1.0   # CI builds + publishes the Release
```

The Android build needs the NDK and the iOS build needs Xcode; both are
provided by the GitHub-hosted runners in the workflow, so no local toolchain is
required to cut a release.

### Android — resolve the release asset as a Gradle dependency

A Release asset is a plain file URL, not a Maven repo, so a bare
`implementation("…")` coordinate won't find it. Gradle's **ivy repository with a
custom pattern** maps the coordinate onto the Release download URL — and it
works cleanly here precisely because this AAR has **no transitive
dependencies** (the `.so`s are bundled inside it and LiveKit is the app's own
`compileOnly`/`implementation`), so the missing POM doesn't matter.

In the consuming app's `settings.gradle.kts` (or `build.gradle.kts`):

```kotlin
repositories {
    ivy {
        url = uri("https://github.com/rajan471/denoise-voice-clarity/releases/download")
        patterns { artifact("[revision]/[artifact]-[revision].[ext]") }
        metadataSources { artifact() }              // no POM/metadata — trust the artifact
        content { includeModule("com.gruner", "voiceclarity") }
    }
}
```
```kotlin
dependencies {
    implementation("com.gruner:voiceclarity:0.1.0@aar")   // -> releases/download/0.1.0/voiceclarity-0.1.0.aar
    implementation("io.livekit:livekit-android:2.18.2")    // the app provides its own LiveKit
}
```

Simpler fallback (no resolution magic): download `voiceclarity-0.1.0.aar` into
`app/libs/` and use `implementation(files("libs/voiceclarity-0.1.0.aar"))`.

### iOS — remote binary target from the release asset

Host the package on a git repo/tag and point the binary target at the Release
zip. The checksum is printed by the release workflow (and saved as the
`.sha256` asset); paste it into `Package.swift`:

```swift
.binaryTarget(
    name: "DenoiseVoiceCoreFFI",
    url: "https://github.com/rajan471/denoise-voice-clarity/releases/download/0.1.0/DenoiseVoiceCoreFFI-0.1.0.xcframework.zip",
    checksum: "<value from DenoiseVoiceCoreFFI-0.1.0.xcframework.zip.sha256>"
)
```

(The committed `ios/Package.swift` uses a *local* `path:` binary target for
in-repo development; switch to the `url:`+`checksum:` form for published
consumption.)
