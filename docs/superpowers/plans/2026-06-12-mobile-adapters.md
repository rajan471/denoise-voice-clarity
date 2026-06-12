# Android + iOS Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `android/` (AAR, Kotlin `AudioProcessorInterface`) and `ios/` (Swift Package, `AudioCustomProcessingDelegate`) adapters around `denoise-voice-core`, with the DFN3 engine, banded-buffer handling, and CI-buildable artifacts.

**Architecture:** rust-core gains a band merge/split stage (WebRTC 3-band QMF port), a hand-rolled C ABI (`ffi` feature) and JNI exports (`android` feature). Kotlin/Swift adapters are thin state machines over that ABI, mirroring the official Krisp plugins' integration shape. Spec: `docs/superpowers/specs/2026-06-12-voice-clarity-mobile-adapters-design.md`.

**Tech Stack:** Rust (cdylib/staticlib, `jni` crate, cbindgen), Kotlin + Gradle (AAR), Swift Package Manager (XCFramework binary target), cargo-ndk, GitLab CI.

**Local toolchain constraint:** this machine has no NDK/Xcode. Verifiable locally: all host `cargo test`s, `cargo check` per mobile target, header generation. AAR/XCFramework assembly is verified by CI (Task 11). Steps below say which kind each verification is.

---

### Task 0: Prove the `dfn` feature builds and is real-time on host (GATE)

**Files:** none (build verification only)

- [ ] **Step 0.1:** Run: `cd rust-core && cargo test --features dfn dfn_runtime -- --nocapture` (first build pulls the git dep; allow ~10 min).
  Expected: PASS, printed `ms/frame` < 10.
- [ ] **Step 0.2:** If it fails to compile, fix within `rust-core` only (the `deep_filter`/tract pin comment in Cargo.toml is the first suspect) and re-run until green. **Do not proceed to any other task until this passes.**
- [ ] **Step 0.3:** Commit any fixes: `git commit -m "fix(core): make dfn feature build on host"` (skip if no changes).

### Task 1: Three-band filterbank (`bands.rs`)

**Files:**
- Create: `rust-core/src/bands.rs`
- Modify: `rust-core/src/lib.rs` (add `pub mod bands;`)

- [ ] **Step 1.1: Write failing tests** at the bottom of the new `rust-core/src/bands.rs` (module skeleton + tests first):

```rust
//! Port of WebRTC's three-band filterbank (modules/audio_processing/
//! splitting_filter / three_band_filter_bank). BSD-3-Clause upstream;
//! attribution in NOTICE. 48 kHz <-> 3 x 16 kHz bands, 480 <-> 3x160 samples.

pub const NUM_BANDS: usize = 3;
pub const FULL_FRAME: usize = 480;
pub const BAND_FRAME: usize = FULL_FRAME / NUM_BANDS; // 160

pub struct ThreeBandFilterBank { /* state added in Step 1.3 */ }

impl ThreeBandFilterBank {
    pub fn new() -> Self { unimplemented!() }
    /// bands: 3 contiguous slices of 160 (layout: band-major, as WebRTC hands
    /// them: [b0[0..160], b1[0..160], b2[0..160]]) -> 480 full-band samples.
    pub fn merge(&mut self, bands: &[f32], out: &mut [f32]) { unimplemented!() }
    /// 480 full-band samples -> band-major 3x160.
    pub fn split(&mut self, full: &[f32], out_bands: &mut [f32]) { unimplemented!() }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// split -> merge must reconstruct a sine within the same tolerance
    /// WebRTC's own splitting_filter_unittest uses (they allow the filterbank's
    /// inherent delay; we compensate by cross-correlating for best lag).
    #[test]
    fn split_merge_reconstructs_sine() {
        let mut fb_a = ThreeBandFilterBank::new();
        let mut fb_s = ThreeBandFilterBank::new();
        let n_frames = 50;
        let mut input = Vec::new();
        let mut output = Vec::new();
        for f in 0..n_frames {
            let full: Vec<f32> = (0..FULL_FRAME)
                .map(|i| {
                    let t = (f * FULL_FRAME + i) as f32 / 48_000.0;
                    (2.0 * std::f32::consts::PI * 440.0 * t).sin() * 0.5
                })
                .collect();
            input.extend_from_slice(&full);
            let mut bands = [0.0f32; FULL_FRAME];
            fb_s.split(&full, &mut bands);
            let mut recon = [0.0f32; FULL_FRAME];
            fb_a.merge(&bands, &mut recon);
            output.extend_from_slice(&recon);
        }
        // find best alignment lag in [0, 512), then SNR over the aligned region
        let mut best = (0usize, f32::MIN);
        for lag in 0..512 {
            let corr: f32 = input[..input.len() - 512]
                .iter().zip(&output[lag..]).map(|(a, b)| a * b).sum();
            if corr > best.1 { best = (lag, corr); }
        }
        let lag = best.0;
        let (mut sig, mut err) = (0.0f64, 0.0f64);
        for i in 4800..input.len() - 512 { // skip warmup
            sig += (input[i] as f64).powi(2);
            err += ((input[i] - output[i + lag]) as f64).powi(2);
        }
        let snr_db = 10.0 * (sig / err.max(1e-12)).log10();
        assert!(snr_db > 30.0, "reconstruction SNR {snr_db:.1} dB too low (lag {lag})");
    }

    /// Energy of a 12 kHz tone must land in band 1 (8-16 kHz), not band 0.
    #[test]
    fn split_routes_energy_to_correct_band() {
        let mut fb = ThreeBandFilterBank::new();
        let mut bands = [0.0f32; FULL_FRAME];
        let mut e = [0.0f32; NUM_BANDS];
        for f in 0..20 {
            let full: Vec<f32> = (0..FULL_FRAME)
                .map(|i| {
                    let t = (f * FULL_FRAME + i) as f32 / 48_000.0;
                    (2.0 * std::f32::consts::PI * 12_000.0 * t).sin()
                })
                .collect();
            fb.split(&full, &mut bands);
            for b in 0..NUM_BANDS {
                e[b] += bands[b * BAND_FRAME..(b + 1) * BAND_FRAME]
                    .iter().map(|x| x * x).sum::<f32>();
            }
        }
        assert!(e[1] > 10.0 * e[0] && e[1] > 10.0 * e[2],
            "12kHz energy should dominate band 1: {e:?}");
    }
}
```

- [ ] **Step 1.2:** Add `pub mod bands;` to `rust-core/src/lib.rs` after `pub mod engine;`. Run `cargo test bands` — expected: panic `unimplemented!` / FAIL.
- [ ] **Step 1.3: Implement** by porting WebRTC's filterbank. Source of truth (pin this revision in a comment):
  `https://webrtc.googlesource.com/src/+/refs/branch-heads/6478/modules/audio_processing/three_band_filter_bank.cc` (and `.h`).
  Port rules: keep the sparse-FIR + DCT-modulation structure, the `kFilterCoeffs` table verbatim, `kSparsity = 4`, `kStrideLog2`/memory layout as upstream; translate loops to safe Rust over fixed-size arrays; both `merge` (their `Synthesis`) and `split` (their `Analysis`) share the struct. Fetch the two files with curl, keep a copy under `rust-core/vendor-ref/` (reference only, gitignored), and add the BSD-3 attribution block at the top of `bands.rs`.
- [ ] **Step 1.4:** Run: `cargo test bands` — expected: both tests PASS. If SNR fails, diff your port against the reference files line by line (coefficient table first).
- [ ] **Step 1.5:** Commit: `git add -A && git commit -m "feat(core): three-band QMF filterbank (WebRTC port) for banded capture buffers"`

### Task 2: Banded processor with rate policy (`bands.rs` + `lib.rs`)

**Files:**
- Modify: `rust-core/src/bands.rs` (add `BandedVoiceClarity`)
- Test: same file, `#[cfg(test)]`

- [ ] **Step 2.1: Failing tests** (append to `bands.rs` tests):

```rust
    use crate::Config;

    #[test]
    fn banded_48k_3band_processes() {
        let mut p = super::BandedVoiceClarity::new(Config::default());
        assert!(p.init(48_000, 1).is_ok());
        let mut buf = [0.1f32; FULL_FRAME]; // 3 bands x 160, band-major
        assert_eq!(p.process_banded(3, BAND_FRAME, &mut buf), Ok(()));
    }

    #[test]
    fn banded_16k_single_band_is_clarity_only() {
        let mut p = super::BandedVoiceClarity::new(Config::default());
        assert!(p.init(16_000, 1).is_ok());
        let mut buf = [0.1f32; 160]; // 10ms @ 16k, 1 band
        assert_eq!(p.process_banded(1, 160, &mut buf), Ok(()));
        assert!(p.dfn_active() == false, "DFN must be bypassed off 48k");
    }

    #[test]
    fn banded_rejects_shape_mismatch() {
        let mut p = super::BandedVoiceClarity::new(Config::default());
        assert!(p.init(48_000, 1).is_ok());
        let mut buf = [0.0f32; 100];
        assert!(p.process_banded(3, 100, &mut buf).is_err());
    }
```

- [ ] **Step 2.2:** Run `cargo test banded` — expected FAIL (type not found).
- [ ] **Step 2.3: Implement** in `bands.rs`:

```rust
use crate::clarity::ClarityChain;
use crate::{Config, VoiceClarity, FRAME_SIZE, SAMPLE_RATE};

/// Wraps VoiceClarity for WebRTC's banded capture-post buffers and owns the
/// rate policy: full chain at 48 kHz; clarity-only at any other rate.
pub struct BandedVoiceClarity {
    config: Config,
    sample_rate: u32,
    full: Option<VoiceClarity>,        // 48 kHz path
    clarity_only: Option<ClarityChain>, // non-48k fallback
    merge_fb: ThreeBandFilterBank,
    split_fb: ThreeBandFilterBank,
    scratch: [f32; FRAME_SIZE],
    enabled: bool,
}

impl BandedVoiceClarity {
    pub fn new(config: Config) -> Self {
        Self {
            enabled: config.enabled,
            config,
            sample_rate: 0,
            full: None,
            clarity_only: None,
            merge_fb: ThreeBandFilterBank::new(),
            split_fb: ThreeBandFilterBank::new(),
            scratch: [0.0; FRAME_SIZE],
        }
    }

    pub fn init(&mut self, sample_rate: u32, channels: u32) -> Result<(), &'static str> {
        if channels == 0 { return Err("channels must be >= 1"); }
        self.sample_rate = sample_rate;
        if sample_rate == SAMPLE_RATE {
            self.full = Some(VoiceClarity::new(self.config.clone()));
            self.clarity_only = None;
        } else {
            self.full = None;
            self.clarity_only =
                Some(ClarityChain::new(sample_rate as f32, self.config.clarity.clone()));
        }
        self.merge_fb = ThreeBandFilterBank::new();
        self.split_fb = ThreeBandFilterBank::new();
        Ok(())
    }

    pub fn reset(&mut self, new_rate: u32) -> Result<(), &'static str> {
        self.init(new_rate, 1)
    }

    pub fn dfn_active(&self) -> bool { self.full.is_some() }
    pub fn set_enabled(&mut self, on: bool) {
        self.enabled = on;
        if let Some(f) = &mut self.full { f.set_enabled(on); }
    }
    pub fn set_attenuation_limit_db(&mut self, db: f32) {
        self.config.attenuation_limit_db = db;
        if let Some(f) = &mut self.full { f.set_attenuation_limit_db(db); }
    }

    /// buf layout is band-major: bands x frames_per_band, one channel.
    pub fn process_banded(
        &mut self, bands: usize, frames_per_band: usize, buf: &mut [f32],
    ) -> Result<(), &'static str> {
        if !self.enabled { return Ok(()); }
        if buf.len() != bands * frames_per_band { return Err("buffer/shape mismatch"); }
        match (bands, &mut self.full) {
            (3, Some(full)) if frames_per_band == BAND_FRAME => {
                self.merge_fb.merge(buf, &mut self.scratch);
                full.process(&mut self.scratch);
                self.split_fb.split(&self.scratch, buf);
                Ok(())
            }
            (1, Some(full)) if frames_per_band == FRAME_SIZE => {
                full.process(buf);
                Ok(())
            }
            _ => {
                // Any other shape: clarity-only on band 0 (speech band),
                // upper bands pass through untouched.
                let chain = match &mut self.clarity_only {
                    Some(c) => c,
                    None => {
                        // 48k init but unexpected band shape — build lazily.
                        self.clarity_only = Some(ClarityChain::new(
                            self.sample_rate as f32, self.config.clarity.clone()));
                        self.clarity_only.as_mut().unwrap()
                    }
                };
                chain.process(&mut buf[..frames_per_band]);
                Ok(())
            }
        }
    }
}
```

  Note: if `ClarityChain::new` / `process` / fields differ from this sketch (check `clarity.rs`), adapt the calls — the public behavior in the tests is the contract, and `ClarityChain::process` must accept arbitrary slice lengths (it is per-sample; verify, and if it asserts frame size, relax it to per-sample iteration).
- [ ] **Step 2.4:** Run `cargo test` (whole crate) — all pass, including pre-existing tests.
- [ ] **Step 2.5:** Commit: `git commit -am "feat(core): BandedVoiceClarity — banded buffers + rate policy"`

### Task 3: C ABI (`ffi.rs`, feature `ffi`)

**Files:**
- Create: `rust-core/src/ffi.rs`
- Modify: `rust-core/Cargo.toml` (features), `rust-core/src/lib.rs`

- [ ] **Step 3.1:** Add to `Cargo.toml` `[features]`: `ffi = []` and to crate-type comment no change (cdylib+rlib already set; staticlib needed for iOS): change `crate-type` to `["cdylib", "rlib", "staticlib"]`.
- [ ] **Step 3.2: Failing test** — create `rust-core/src/ffi.rs` with tests first:

```rust
//! C ABI for the mobile adapters (iOS direct; Android via jni.rs).
//! All functions are unsafe-by-contract: handle must come from dvc_create,
//! buffer must hold bands*frames_per_band f32s. No allocation/locks/logging
//! on the process path.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffi_lifecycle_roundtrip() {
        unsafe {
            let h = dvc_create();
            assert!(!h.is_null());
            assert_eq!(dvc_init(h, 48_000, 1), 0);
            let mut buf = [0.1f32; 480];
            assert_eq!(dvc_process_banded(h, 3, 160, buf.as_mut_ptr()), 0);
            assert_eq!(dvc_process_banded(h, 3, 100, buf.as_mut_ptr()), -2); // bad shape
            dvc_set_enabled(h, false);
            dvc_set_attenuation_limit_db(h, 24.0);
            assert_eq!(dvc_reset(h, 16_000), 0);
            dvc_destroy(h);
        }
    }

    #[test]
    fn ffi_null_handle_is_safe() {
        unsafe {
            assert_eq!(dvc_init(std::ptr::null_mut(), 48_000, 1), -1);
            assert_eq!(dvc_process_banded(std::ptr::null_mut(), 3, 160, std::ptr::null_mut()), -1);
            dvc_destroy(std::ptr::null_mut()); // must not crash
        }
    }
}
```

- [ ] **Step 3.3:** Add `#[cfg(feature = "ffi")] pub mod ffi;` to `lib.rs`. Run `cargo test --features ffi ffi_` — expected FAIL (functions missing).
- [ ] **Step 3.4: Implement** above the tests in `ffi.rs`:

```rust
use crate::bands::BandedVoiceClarity;
use crate::Config;
use std::os::raw::{c_float, c_int};

pub struct DvcHandle(BandedVoiceClarity);

/// # Safety: returned pointer must be freed with dvc_destroy.
#[no_mangle]
pub unsafe extern "C" fn dvc_create() -> *mut DvcHandle {
    Box::into_raw(Box::new(DvcHandle(BandedVoiceClarity::new(Config::default()))))
}

#[no_mangle]
pub unsafe extern "C" fn dvc_destroy(h: *mut DvcHandle) {
    if !h.is_null() { drop(Box::from_raw(h)); }
}

#[no_mangle]
pub unsafe extern "C" fn dvc_init(h: *mut DvcHandle, sample_rate_hz: c_int, channels: c_int) -> c_int {
    let Some(h) = h.as_mut() else { return -1 };
    if sample_rate_hz <= 0 || channels <= 0 { return -2; }
    match h.0.init(sample_rate_hz as u32, channels as u32) { Ok(()) => 0, Err(_) => -3 }
}

#[no_mangle]
pub unsafe extern "C" fn dvc_reset(h: *mut DvcHandle, new_rate_hz: c_int) -> c_int {
    let Some(h) = h.as_mut() else { return -1 };
    if new_rate_hz <= 0 { return -2; }
    match h.0.reset(new_rate_hz as u32) { Ok(()) => 0, Err(_) => -3 }
}

/// In-place. buf must point to bands*frames_per_band valid f32s (one channel).
#[no_mangle]
pub unsafe extern "C" fn dvc_process_banded(
    h: *mut DvcHandle, bands: c_int, frames_per_band: c_int, buf: *mut c_float,
) -> c_int {
    let Some(h) = h.as_mut() else { return -1 };
    if buf.is_null() || bands <= 0 || frames_per_band <= 0 { return -1; }
    let n = bands as usize * frames_per_band as usize;
    let slice = std::slice::from_raw_parts_mut(buf, n);
    match h.0.process_banded(bands as usize, frames_per_band as usize, slice) {
        Ok(()) => 0,
        Err(_) => -2,
    }
}

#[no_mangle]
pub unsafe extern "C" fn dvc_set_enabled(h: *mut DvcHandle, enabled: bool) {
    if let Some(h) = h.as_mut() { h.0.set_enabled(enabled); }
}

#[no_mangle]
pub unsafe extern "C" fn dvc_set_attenuation_limit_db(h: *mut DvcHandle, db: c_float) {
    if let Some(h) = h.as_mut() { h.0.set_attenuation_limit_db(db); }
}

#[no_mangle]
pub unsafe extern "C" fn dvc_dfn_active(h: *const DvcHandle) -> bool {
    h.as_ref().map(|h| h.0.dfn_active()).unwrap_or(false)
}
```

  (Note `dvc_process_banded` bad-shape returns -2 per the test; null/invalid args -1.)
- [ ] **Step 3.5:** Run `cargo test --features ffi` — all PASS. Also `cargo test --features ffi,dfn ffi_lifecycle` — PASS (proves DFN inside the FFI path).
- [ ] **Step 3.6:** Commit: `git commit -am "feat(core): C ABI (ffi feature) for mobile adapters"`

### Task 4: cbindgen header + `scripts/gen-header.sh`

**Files:**
- Create: `rust-core/cbindgen.toml`, `scripts/gen-header.sh`,
  `ios/Sources/DenoiseVoiceCoreFFI/include/denoise_voice_core.h` (generated, checked in)

- [ ] **Step 4.1:** `cargo install cbindgen` (local verify available — pure cargo).
- [ ] **Step 4.2:** Create `rust-core/cbindgen.toml`:

```toml
language = "C"
include_guard = "DENOISE_VOICE_CORE_H"
autogen_warning = "/* Generated by cbindgen from rust-core; run scripts/gen-header.sh. Do not edit. */"
[export]
include = ["DvcHandle"]
[parse]
parse_deps = false
```

- [ ] **Step 4.3:** Create `scripts/gen-header.sh` (chmod +x):

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/ios/Sources/DenoiseVoiceCoreFFI/include/denoise_voice_core.h"
mkdir -p "$(dirname "$OUT")"
cd "$ROOT/rust-core"
cbindgen --config cbindgen.toml --crate denoise-voice-core --output "$OUT" -- --features ffi 2>/dev/null \
  || cbindgen --config cbindgen.toml --output "$OUT"
echo "Wrote $OUT"
```

- [ ] **Step 4.4:** Run it; open the header and verify all 8 `dvc_*` symbols are present with `DvcHandle*` types. Expected: header exists, compiles as C (spot-check: `cc -fsyntax-only` on a tiny include stub if `cc` exists; otherwise visual check).
- [ ] **Step 4.5:** Commit: `git add -A && git commit -m "build: cbindgen header generation for iOS FFI"`

### Task 5: JNI exports (`jni.rs`, feature `android`)

**Files:**
- Create: `rust-core/src/jni.rs`
- Modify: `rust-core/Cargo.toml`, `rust-core/src/lib.rs`

- [ ] **Step 5.1:** Cargo.toml: add `jni = { version = "0.21", optional = true }` to deps and feature `android = ["ffi", "dep:jni"]`.
- [ ] **Step 5.2:** Add `#[cfg(feature = "android")] pub mod jni;` to `lib.rs` (note: name the module `jni` but import the crate as `::jni` inside). Create `rust-core/src/jni.rs`:

```rust
//! JNI bridge for the Android adapter (com.gruner.voiceclarity.NativeCore).
//! Thin wrappers over ffi.rs; the hot path resolves the direct ByteBuffer
//! address once per call — zero copies.

use crate::ffi::*;
use ::jni::objects::{JByteBuffer, JClass};
use ::jni::sys::{jboolean, jfloat, jint, jlong};
use ::jni::JNIEnv;

#[no_mangle]
pub extern "system" fn Java_com_gruner_voiceclarity_NativeCore_create(
    _env: JNIEnv, _c: JClass,
) -> jlong {
    unsafe { dvc_create() as jlong }
}

#[no_mangle]
pub extern "system" fn Java_com_gruner_voiceclarity_NativeCore_destroy(
    _env: JNIEnv, _c: JClass, h: jlong,
) {
    unsafe { dvc_destroy(h as *mut DvcHandle) }
}

#[no_mangle]
pub extern "system" fn Java_com_gruner_voiceclarity_NativeCore_init(
    _env: JNIEnv, _c: JClass, h: jlong, rate: jint, channels: jint,
) -> jint {
    unsafe { dvc_init(h as *mut DvcHandle, rate, channels) }
}

#[no_mangle]
pub extern "system" fn Java_com_gruner_voiceclarity_NativeCore_reset(
    _env: JNIEnv, _c: JClass, h: jlong, rate: jint,
) -> jint {
    unsafe { dvc_reset(h as *mut DvcHandle, rate) }
}

#[no_mangle]
pub extern "system" fn Java_com_gruner_voiceclarity_NativeCore_processBanded(
    env: JNIEnv, _c: JClass, h: jlong, bands: jint, frames_per_band: jint, buf: JByteBuffer,
) -> jint {
    let Ok(addr) = env.get_direct_buffer_address(&buf) else { return -4 };
    let Ok(cap) = env.get_direct_buffer_capacity(&buf) else { return -4 };
    let needed = (bands as usize) * (frames_per_band as usize) * 4;
    if cap < needed { return -5; }
    unsafe {
        dvc_process_banded(h as *mut DvcHandle, bands, frames_per_band, addr as *mut f32)
    }
}

#[no_mangle]
pub extern "system" fn Java_com_gruner_voiceclarity_NativeCore_setEnabled(
    _env: JNIEnv, _c: JClass, h: jlong, on: jboolean,
) {
    unsafe { dvc_set_enabled(h as *mut DvcHandle, on != 0) }
}

#[no_mangle]
pub extern "system" fn Java_com_gruner_voiceclarity_NativeCore_setAttenuationLimitDb(
    _env: JNIEnv, _c: JClass, h: jlong, db: jfloat,
) {
    unsafe { dvc_set_attenuation_limit_db(h as *mut DvcHandle, db) }
}
```

- [ ] **Step 5.3:** Host type-check: `cargo check --features android`. Expected: clean. (jni crate compiles on host; `ffi.rs` items need `pub` visibility for this module — adjust if the compiler complains.)
- [ ] **Step 5.4:** Mobile target type-check (no NDK needed for `check`): `rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android && cargo check --features android,dfn --target aarch64-linux-android`. Expected: clean. If `deep_filter`/tract fails on the Android target, record the exact error and fix (this is the cross-compile risk surfacing early — typical issues: `getrandom` backend, missing `std::arch` paths).
- [ ] **Step 5.5:** Commit: `git commit -am "feat(core): JNI exports (android feature)"`

### Task 6: Android Gradle module

**Files:**
- Create: `android/settings.gradle.kts`, `android/build.gradle.kts`, `android/gradle.properties`,
  `android/src/main/AndroidManifest.xml`,
  `android/src/main/java/com/gruner/voiceclarity/NativeCore.kt`,
  `android/src/main/java/com/gruner/voiceclarity/VoiceClarityAudioProcessor.kt`,
  `android/src/test/java/com/gruner/voiceclarity/VoiceClarityAudioProcessorTest.kt`,
  `android/.gitignore` (`build/`, `src/main/jniLibs/`)

- [ ] **Step 6.1:** Pin the LiveKit SDK: `curl -s https://search.maven.org/solrsearch/select?q=g:io.livekit+AND+a:livekit-android` → take latest stable, write it into `build.gradle.kts` below (placeholder `LK_VERSION`).
- [ ] **Step 6.2:** `android/settings.gradle.kts`:

```kotlin
pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositories { google(); mavenCentral() } }
rootProject.name = "voiceclarity"
```

  `android/build.gradle.kts`:

```kotlin
plugins {
    id("com.android.library") version "8.5.2"
    id("org.jetbrains.kotlin.android") version "2.0.20"
    id("maven-publish")
}

// Publishing to the GitLab package registry: the mobile team's pipeline sets
// GITLAB_MAVEN_URL + CI_JOB_TOKEN; locally the AAR is consumed as a file dep.
publishing {
    publications {
        register<MavenPublication>("release") {
            groupId = "com.gruner"
            artifactId = "voiceclarity"
            version = "0.1.0"
            afterEvaluate { from(components["release"]) }
        }
    }
    repositories {
        maven {
            url = uri(System.getenv("GITLAB_MAVEN_URL") ?: "$buildDir/repo")
            credentials(HttpHeaderCredentials::class) {
                name = "Job-Token"
                value = System.getenv("CI_JOB_TOKEN") ?: ""
            }
            authentication { create<HttpHeaderAuthentication>("header") }
        }
    }
}

android {
    namespace = "com.gruner.voiceclarity"
    compileSdk = 35
    defaultConfig { minSdk = 24 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    // The app supplies its own LiveKit SDK; we only compile against it.
    compileOnly("io.livekit:livekit-android:LK_VERSION")
    testImplementation("io.livekit:livekit-android:LK_VERSION")
    testImplementation("junit:junit:4.13.2")
}
```

  `android/src/main/AndroidManifest.xml`: `<manifest/>`
- [ ] **Step 6.3:** `NativeCore.kt`:

```kotlin
package com.gruner.voiceclarity

/** JNI bridge to libdenoise_voice_core.so. Mirrors rust-core/src/jni.rs. */
internal object NativeCore {
    @Volatile var available: Boolean = false
        private set

    init {
        available = try {
            System.loadLibrary("denoise_voice_core"); true
        } catch (t: Throwable) {
            android.util.Log.w("VoiceClarity", "native core unavailable: $t"); false
        }
    }

    external fun create(): Long
    external fun destroy(handle: Long)
    external fun init(handle: Long, sampleRateHz: Int, channels: Int): Int
    external fun reset(handle: Long, newRateHz: Int): Int
    external fun processBanded(handle: Long, bands: Int, framesPerBand: Int,
                               buffer: java.nio.ByteBuffer): Int
    external fun setEnabled(handle: Long, enabled: Boolean)
    external fun setAttenuationLimitDb(handle: Long, db: Float)
}
```

- [ ] **Step 6.4: Failing JVM test** for the adapter state machine — `VoiceClarityAudioProcessorTest.kt`. The adapter takes a bridge interface so tests fake it (NativeCore implements it in prod):

```kotlin
package com.gruner.voiceclarity

import org.junit.Assert.*
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

private class FakeBridge(var processResult: Int = 0) : VoiceClarityAudioProcessor.Bridge {
    var inited = 0; var resets = 0; var destroyed = 0
    override val available = true
    override fun create() = 1L
    override fun destroy(handle: Long) { destroyed++ }
    override fun init(handle: Long, sampleRateHz: Int, channels: Int): Int { inited++; return 0 }
    override fun reset(handle: Long, newRateHz: Int): Int { resets++; return 0 }
    override fun processBanded(handle: Long, bands: Int, framesPerBand: Int, buffer: ByteBuffer) = processResult
    override fun setEnabled(handle: Long, enabled: Boolean) {}
    override fun setAttenuationLimitDb(handle: Long, db: Float) {}
}

class VoiceClarityAudioProcessorTest {
    private fun directBuf(floats: Int): ByteBuffer =
        ByteBuffer.allocateDirect(floats * 4).order(ByteOrder.nativeOrder())

    @Test fun `lifecycle init and process`() {
        val p = VoiceClarityAudioProcessor(FakeBridge())
        p.initializeAudioProcessing(48_000, 1)
        assertTrue(p.isEnabled())
        p.processAudio(3, 480, directBuf(480))
        assertEquals("denoise-voice-clarity", p.getName())
    }

    @Test fun `unavailable bridge means inert`() {
        val bridge = object : VoiceClarityAudioProcessor.Bridge by FakeBridge() {
            override val available = false
        }
        val p = VoiceClarityAudioProcessor(bridge)
        p.initializeAudioProcessing(48_000, 1)
        assertFalse(p.isEnabled())
        p.processAudio(3, 480, directBuf(480)) // must not throw
    }

    @Test fun `error budget self-disables after 50 consecutive failures`() {
        val bridge = FakeBridge(processResult = -2)
        val p = VoiceClarityAudioProcessor(bridge)
        p.initializeAudioProcessing(48_000, 1)
        repeat(50) { p.processAudio(3, 480, directBuf(480)) }
        assertFalse(p.isEnabled())
    }

    @Test fun `reset is forwarded`() {
        val bridge = FakeBridge()
        val p = VoiceClarityAudioProcessor(bridge)
        p.initializeAudioProcessing(48_000, 1)
        p.resetAudioProcessing(16_000)
        assertEquals(1, bridge.resets)
    }
}
```

- [ ] **Step 6.5:** Implement `VoiceClarityAudioProcessor.kt`:

```kotlin
package com.gruner.voiceclarity

import io.livekit.android.audio.AudioProcessorInterface
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicInteger

/**
 * LiveKit capture post-processor running the denoise-voice-core chain
 * (HPF -> DeepFilterNet 3 -> clarity). Attach via
 * AudioProcessorOptions(capturePostProcessor = this).
 *
 * Degradation: if the native lib is missing or processing keeps failing,
 * the processor turns inert and audio passes through untouched.
 */
class VoiceClarityAudioProcessor internal constructor(
    private val bridge: Bridge,
) : AudioProcessorInterface {

    internal interface Bridge {
        val available: Boolean
        fun create(): Long
        fun destroy(handle: Long)
        fun init(handle: Long, sampleRateHz: Int, channels: Int): Int
        fun reset(handle: Long, newRateHz: Int): Int
        fun processBanded(handle: Long, bands: Int, framesPerBand: Int, buffer: ByteBuffer): Int
        fun setEnabled(handle: Long, enabled: Boolean)
        fun setAttenuationLimitDb(handle: Long, db: Float)
    }

    constructor() : this(RealBridge)

    private object RealBridge : Bridge {
        override val available get() = NativeCore.available
        override fun create() = NativeCore.create()
        override fun destroy(handle: Long) = NativeCore.destroy(handle)
        override fun init(handle: Long, sampleRateHz: Int, channels: Int) =
            NativeCore.init(handle, sampleRateHz, channels)
        override fun reset(handle: Long, newRateHz: Int) = NativeCore.reset(handle, newRateHz)
        override fun processBanded(handle: Long, bands: Int, framesPerBand: Int, buffer: ByteBuffer) =
            NativeCore.processBanded(handle, bands, framesPerBand, buffer)
        override fun setEnabled(handle: Long, enabled: Boolean) = NativeCore.setEnabled(handle, enabled)
        override fun setAttenuationLimitDb(handle: Long, db: Float) =
            NativeCore.setAttenuationLimitDb(handle, db)
    }

    private companion object { const val MAX_CONSECUTIVE_ERRORS = 50 }

    @Volatile private var handle: Long = 0
    @Volatile private var userEnabled = true
    @Volatile private var healthy = false
    private val consecutiveErrors = AtomicInteger(0)

    fun setEnabled(enabled: Boolean) {
        userEnabled = enabled
        if (handle != 0L) bridge.setEnabled(handle, enabled)
    }

    fun setAttenuationLimitDb(db: Float) {
        if (handle != 0L) bridge.setAttenuationLimitDb(handle, db)
    }

    fun release() {
        if (handle != 0L) { bridge.destroy(handle); handle = 0; healthy = false }
    }

    // -- AudioProcessorInterface ------------------------------------------

    override fun isEnabled(): Boolean = healthy && userEnabled

    override fun getName(): String = "denoise-voice-clarity"

    override fun initializeAudioProcessing(sampleRateHz: Int, numChannels: Int) {
        if (!bridge.available) { healthy = false; return }
        if (handle == 0L) handle = bridge.create()
        healthy = handle != 0L && bridge.init(handle, sampleRateHz, numChannels) == 0
        consecutiveErrors.set(0)
    }

    override fun resetAudioProcessing(newRate: Int) {
        if (handle != 0L) { bridge.reset(handle, newRate); consecutiveErrors.set(0) }
    }

    override fun processAudio(numBands: Int, numFrames: Int, buffer: ByteBuffer) {
        if (!isEnabled()) return
        // numFrames is the total frame count; per-band length is numFrames/numBands.
        val framesPerBand = if (numBands > 0) numFrames / numBands else return
        val rc = bridge.processBanded(handle, numBands, framesPerBand, buffer)
        if (rc == 0) {
            consecutiveErrors.set(0)
        } else if (consecutiveErrors.incrementAndGet() >= MAX_CONSECUTIVE_ERRORS) {
            healthy = false
            android.util.Log.w("VoiceClarity", "self-disabled after $MAX_CONSECUTIVE_ERRORS errors (rc=$rc)")
        }
    }
}
```

  **Implementation check during this step:** confirm against the pinned SDK source whether `processAudio`'s `numFrames` is total-across-bands or per-band (read the SDK's `AudioProcessingController`/webrtc glue, or the Krisp android plugin if public). Fix the `framesPerBand` line accordingly and note the finding in the KDoc.
- [ ] **Step 6.6:** Verify: if `gradle` is available locally run `cd android && gradle testDebugUnitTest`; otherwise mark for CI (Task 11 runs it) and at minimum confirm Kotlin compiles via CI. Record which.
- [ ] **Step 6.7:** Commit: `git add android && git commit -m "feat(android): VoiceClarityAudioProcessor AAR module"`

### Task 7: `scripts/build-android.sh`

**Files:** Create: `scripts/build-android.sh` (chmod +x)

- [ ] **Step 7.1:**

```bash
#!/usr/bin/env bash
# Build libdenoise_voice_core.so for all Android ABIs and assemble the AAR.
# Requirements: Android NDK (ANDROID_NDK_HOME), cargo-ndk (cargo install cargo-ndk),
# rustup targets aarch64-linux-android armv7-linux-androideabi x86_64-linux-android.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JNI_DIR="$ROOT/android/src/main/jniLibs"
FEATURES="${FEATURES:-dfn,ffi,android}"

cd "$ROOT/rust-core"
cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 \
  -o "$JNI_DIR" build --release --features "$FEATURES"

cd "$ROOT/android"
./gradlew --no-daemon assembleRelease 2>/dev/null || gradle --no-daemon assembleRelease
echo "AAR: $ROOT/android/build/outputs/aar/"
```

- [ ] **Step 7.2:** Local verify limited to syntax: `bash -n scripts/build-android.sh`. Full run is a CI/NDK-machine job.
- [ ] **Step 7.3:** Commit: `git add scripts/build-android.sh && git commit -m "build: android .so + AAR build script"`

### Task 8: iOS Swift Package

**Files:**
- Create: `ios/Package.swift`,
  `ios/Sources/VoiceClarity/VoiceClarityProcessor.swift`,
  `ios/Sources/DenoiseVoiceCoreFFI/include/module.modulemap`,
  `ios/Tests/VoiceClarityTests/VoiceClarityProcessorTests.swift`,
  `ios/.gitignore` (`Frameworks/`, `.build/`)

- [ ] **Step 8.1:** `module.modulemap` (next to the generated header):

```
module DenoiseVoiceCoreFFI {
    header "denoise_voice_core.h"
    export *
}
```

- [ ] **Step 8.2:** `ios/Package.swift` (pin client-sdk-swift to current stable — check https://github.com/livekit/client-sdk-swift/releases and substitute `LK_SWIFT_VERSION`):

```swift
// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "DenoiseVoiceClarity",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "VoiceClarity", targets: ["VoiceClarity"])],
    dependencies: [
        .package(url: "https://github.com/livekit/client-sdk-swift.git", from: "LK_SWIFT_VERSION"),
    ],
    targets: [
        .binaryTarget(
            name: "DenoiseVoiceCoreFFI",
            path: "Frameworks/DenoiseVoiceCoreFFI.xcframework"
        ),
        .target(
            name: "VoiceClarity",
            dependencies: [
                "DenoiseVoiceCoreFFI",
                .product(name: "LiveKit", package: "client-sdk-swift"),
            ]
        ),
        .testTarget(name: "VoiceClarityTests", dependencies: ["VoiceClarity"]),
    ]
)
```

- [ ] **Step 8.3: Test first** — `VoiceClarityProcessorTests.swift` (state machine with a fake core, same shape as Android):

```swift
import XCTest
@testable import VoiceClarity

final class FakeCore: VoiceClarityCore {
    var available = true
    var processResult: Int32 = 0
    var inits = 0, resets = 0, destroys = 0
    func create() -> OpaquePointer? { OpaquePointer(bitPattern: 1) }
    func destroy(_ h: OpaquePointer?) { destroys += 1 }
    func initialize(_ h: OpaquePointer?, sampleRate: Int32, channels: Int32) -> Int32 { inits += 1; return 0 }
    func reset(_ h: OpaquePointer?, newRate: Int32) -> Int32 { resets += 1; return 0 }
    func processBanded(_ h: OpaquePointer?, bands: Int32, framesPerBand: Int32,
                       buffer: UnsafeMutablePointer<Float>) -> Int32 { processResult }
    func setEnabled(_ h: OpaquePointer?, _ on: Bool) {}
    func setAttenuationLimitDb(_ h: OpaquePointer?, _ db: Float) {}
}

final class VoiceClarityProcessorTests: XCTestCase {
    func testLifecycle() {
        let core = FakeCore()
        let p = VoiceClarityProcessor(core: core)
        p.audioProcessingInitialize(sampleRate: 48_000, channels: 1)
        XCTAssertTrue(p.isHealthy)
        XCTAssertEqual(core.inits, 1)
        p.audioProcessingRelease()
        XCTAssertEqual(core.destroys, 1)
    }

    func testErrorBudgetSelfDisables() {
        let core = FakeCore(); core.processResult = -2
        let p = VoiceClarityProcessor(core: core)
        p.audioProcessingInitialize(sampleRate: 48_000, channels: 1)
        var buf = [Float](repeating: 0.1, count: 480)
        buf.withUnsafeMutableBufferPointer { ptr in
            for _ in 0..<50 {
                p.processChannel(bands: 3, framesPerBand: 160, buffer: ptr.baseAddress!)
            }
        }
        XCTAssertFalse(p.isHealthy)
    }
}
```

- [ ] **Step 8.4:** Implement `VoiceClarityProcessor.swift`:

```swift
import Foundation
import LiveKit
import DenoiseVoiceCoreFFI

/// Abstraction over the C core so tests can fake it.
protocol VoiceClarityCore: AnyObject {
    var available: Bool { get }
    func create() -> OpaquePointer?
    func destroy(_ h: OpaquePointer?)
    func initialize(_ h: OpaquePointer?, sampleRate: Int32, channels: Int32) -> Int32
    func reset(_ h: OpaquePointer?, newRate: Int32) -> Int32
    func processBanded(_ h: OpaquePointer?, bands: Int32, framesPerBand: Int32,
                       buffer: UnsafeMutablePointer<Float>) -> Int32
    func setEnabled(_ h: OpaquePointer?, _ on: Bool)
    func setAttenuationLimitDb(_ h: OpaquePointer?, _ db: Float)
}

final class RealCore: VoiceClarityCore {
    var available: Bool { true } // statically linked — if we linked, it's there
    func create() -> OpaquePointer? { OpaquePointer(dvc_create()) }
    func destroy(_ h: OpaquePointer?) { dvc_destroy(UnsafeMutableRawPointer(h)?.assumingMemoryBound(to: DvcHandle.self)) }
    func initialize(_ h: OpaquePointer?, sampleRate: Int32, channels: Int32) -> Int32 {
        dvc_init(UnsafeMutableRawPointer(h)?.assumingMemoryBound(to: DvcHandle.self), sampleRate, channels)
    }
    func reset(_ h: OpaquePointer?, newRate: Int32) -> Int32 {
        dvc_reset(UnsafeMutableRawPointer(h)?.assumingMemoryBound(to: DvcHandle.self), newRate)
    }
    func processBanded(_ h: OpaquePointer?, bands: Int32, framesPerBand: Int32,
                       buffer: UnsafeMutablePointer<Float>) -> Int32 {
        dvc_process_banded(UnsafeMutableRawPointer(h)?.assumingMemoryBound(to: DvcHandle.self),
                           bands, framesPerBand, buffer)
    }
    func setEnabled(_ h: OpaquePointer?, _ on: Bool) {
        dvc_set_enabled(UnsafeMutableRawPointer(h)?.assumingMemoryBound(to: DvcHandle.self), on)
    }
    func setAttenuationLimitDb(_ h: OpaquePointer?, _ db: Float) {
        dvc_set_attenuation_limit_db(UnsafeMutableRawPointer(h)?.assumingMemoryBound(to: DvcHandle.self), db)
    }
}

/// LiveKit capture post-processor. Attach:
///   AudioManager.shared.capturePostProcessingDelegate = processor
public final class VoiceClarityProcessor: NSObject, AudioCustomProcessingDelegate, @unchecked Sendable {
    private static let maxConsecutiveErrors = 50

    private let core: VoiceClarityCore
    private var handle: OpaquePointer?
    private let lock = NSLock()
    private var consecutiveErrors = 0
    public private(set) var isHealthy = false
    public var isUserEnabled = true {
        didSet { core.setEnabled(handle, isUserEnabled) }
    }

    init(core: VoiceClarityCore) { self.core = core; super.init() }
    override public convenience init() { self.init(core: RealCore()) }

    public var audioProcessingName: String { "denoise-voice-clarity" }

    public func setAttenuationLimitDb(_ db: Float) { core.setAttenuationLimitDb(handle, db) }

    public func audioProcessingInitialize(sampleRate: Int, channels: Int) {
        lock.lock(); defer { lock.unlock() }
        if handle == nil { handle = core.create() }
        if let h = handle {
            isHealthy = core.initialize(h, sampleRate: Int32(sampleRate), channels: Int32(channels)) == 0
        } else { isHealthy = false }
        consecutiveErrors = 0
    }

    public func audioProcessingProcess(audioBuffer: LKAudioBuffer) {
        guard isHealthy, isUserEnabled else { return }
        for ch in 0..<audioBuffer.channels {
            processChannel(bands: Int32(audioBuffer.bands),
                           framesPerBand: Int32(audioBuffer.framesPerBand),
                           buffer: audioBuffer.rawBuffer(forChannel: ch))
        }
    }

    /// Internal seam so tests can drive a single channel without LKAudioBuffer.
    func processChannel(bands: Int32, framesPerBand: Int32, buffer: UnsafeMutablePointer<Float>) {
        let rc = core.processBanded(handle, bands: bands, framesPerBand: framesPerBand, buffer: buffer)
        if rc == 0 { consecutiveErrors = 0 }
        else {
            consecutiveErrors += 1
            if consecutiveErrors >= Self.maxConsecutiveErrors { isHealthy = false }
        }
    }

    public func audioProcessingRelease() {
        lock.lock(); defer { lock.unlock() }
        if let h = handle { core.destroy(h); handle = nil }
        isHealthy = false
    }
}
```

  Note: the `RealCore` pointer casts depend on the exact header types cbindgen emitted (`DvcHandle*`). When the header is in front of you, simplify — if cbindgen exposes `dvc_create() -> *mut DvcHandle`, Swift imports it as `UnsafeMutablePointer<DvcHandle>?` and `OpaquePointer` gymnastics shrink to direct typed pointers. The protocol seam is the part under test; keep it.
- [ ] **Step 8.5:** Verify what's possible without Xcode: none locally (`swift build` also needs the toolchain — check `swift --version`; if a host Swift exists, `swift build` will still fail on the missing xcframework, that's expected). CI covers it (Task 11). Record status honestly in the commit body.
- [ ] **Step 8.6:** Commit: `git add ios && git commit -m "feat(ios): VoiceClarityProcessor Swift package"`

### Task 9: `scripts/build-ios.sh`

**Files:** Create: `scripts/build-ios.sh` (chmod +x)

- [ ] **Step 9.1:**

```bash
#!/usr/bin/env bash
# Build DenoiseVoiceCoreFFI.xcframework (device + simulator static libs).
# Requirements: Xcode (xcodebuild), rustup targets:
#   aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FEATURES="${FEATURES:-dfn,ffi}"
OUT="$ROOT/ios/Frameworks"
HDRS="$ROOT/ios/Sources/DenoiseVoiceCoreFFI/include"
LIB=libdenoise_voice_core.a

cd "$ROOT/rust-core"
for t in aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios; do
  cargo build --release --target "$t" --features "$FEATURES"
done

SIM_FAT="$ROOT/rust-core/target/sim-universal"
mkdir -p "$SIM_FAT"
lipo -create \
  "target/aarch64-apple-ios-sim/release/$LIB" \
  "target/x86_64-apple-ios/release/$LIB" \
  -output "$SIM_FAT/$LIB"

rm -rf "$OUT/DenoiseVoiceCoreFFI.xcframework"
xcodebuild -create-xcframework \
  -library "target/aarch64-apple-ios/release/$LIB" -headers "$HDRS" \
  -library "$SIM_FAT/$LIB" -headers "$HDRS" \
  -output "$OUT/DenoiseVoiceCoreFFI.xcframework"
echo "Wrote $OUT/DenoiseVoiceCoreFFI.xcframework"
```

- [ ] **Step 9.2:** `bash -n scripts/build-ios.sh`; `rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios && cd rust-core && cargo check --target aarch64-apple-ios --features dfn,ffi` (type-check works without Xcode; full build needs it).
- [ ] **Step 9.3:** Commit: `git add scripts/build-ios.sh && git commit -m "build: ios xcframework build script"`

### Task 10: GitLab CI artifact jobs

**Files:** Create: `.gitlab-ci.yml` (repo root)

- [ ] **Step 10.1:**

```yaml
# Artifact builds for the mobile adapters. Host tests run on every MR;
# artifact jobs are manual until the runners get NDK/Xcode provisioned.
stages: [test, build]

rust-tests:
  stage: test
  image: rust:1.79
  script:
    - cd rust-core
    - cargo test --features ffi
    - cargo test --features ffi,dfn
  rules: [{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' }, { if: '$CI_COMMIT_BRANCH' }]

android-aar:
  stage: build
  image: ghcr.io/cirruslabs/android-sdk:35-ndk
  before_script:
    - curl -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
    - source "$HOME/.cargo/env"
    - rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
    - cargo install cargo-ndk
  script:
    - ./scripts/build-android.sh
    - cd android && gradle --no-daemon testDebugUnitTest
  artifacts: { paths: [android/build/outputs/aar/] }
  rules: [{ when: manual }]

ios-xcframework:
  stage: build
  tags: [macos]            # requires a macOS runner with Xcode
  script:
    - rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
    - ./scripts/gen-header.sh
    - ./scripts/build-ios.sh
    - cd ios && swift test
  artifacts: { paths: [ios/Frameworks/DenoiseVoiceCoreFFI.xcframework] }
  rules: [{ when: manual }]
```

- [ ] **Step 10.2:** Validate YAML: `python3 -c "import yaml,sys; yaml.safe_load(open('.gitlab-ci.yml'))"`.
- [ ] **Step 10.3:** Commit: `git add .gitlab-ci.yml && git commit -m "ci: host tests + manual android/ios artifact jobs"`

### Task 11: Docs — README, DESIGN.md amendment

**Files:**
- Modify: `README.md` (layout tree, status table row "Android / iOS adapters", new Build sections)
- Modify: `DESIGN.md` (§2 Non-Goals: drop the "separate repos" line, point to the mobile spec; §10 step 5 likewise)

- [ ] **Step 11.1:** README: change status row to `| Android / iOS adapters | ✅ in-repo (android/, ios/) — see docs/superpowers/specs/2026-06-12-voice-clarity-mobile-adapters-design.md |`; add `android/` and `ios/` to the layout tree; add Build subsections quoting `scripts/build-android.sh` / `scripts/build-ios.sh` and their toolchain prerequisites; document the consumer attach points (Android `AudioProcessorOptions(capturePostProcessor = VoiceClarityAudioProcessor())`, iOS `AudioManager.shared.capturePostProcessingDelegate = VoiceClarityProcessor()`).
- [ ] **Step 11.2:** DESIGN.md §2: replace `- Android/iOS implementation in this repo (separate repos; reuse the core).` with `- (superseded 2026-06-12) Android/iOS adapters now live in this repo — see docs/superpowers/specs/2026-06-12-voice-clarity-mobile-adapters-design.md.` and §10 item 5 similarly.
- [ ] **Step 11.3:** Commit: `git commit -am "docs: mobile adapters in-repo — README + DESIGN amendments"`

### Task 12: Final verification sweep

- [ ] **Step 12.1:** `cd rust-core && cargo test && cargo test --features ffi && cargo test --features ffi,dfn && cargo check --features android --target aarch64-linux-android && cargo check --features ffi,dfn --target aarch64-apple-ios && cargo build --release --target wasm32-unknown-unknown --features wasm` — all green (wasm build proves no web regression).
- [ ] **Step 12.2:** `git log --oneline` — confirm one commit per task; working tree clean.
- [ ] **Step 12.3:** Report: list what is locally verified vs CI-deferred (AAR assembly, XCFramework, swift test).
