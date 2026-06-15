---
title: Voice-Clarity Add-on (open-source Krisp replacement)
date: 2026-06-09
status: approved
---

# Voice-Clarity Add-on

> This is the canonical design for the `denoiseVoiceClarity` module. A copy also
> lives at `docs/superpowers/specs/2026-06-09-voice-clarity-noise-suppression-addon-design.md`.

## 1. Summary

A self-hosted, license-free replacement for the Krisp noise filter on LiveKit
calls. It runs **client-side**, in the participant's app, before audio is
published to the SFU — the same place Krisp runs. It does two things in one
chain:

1. **Denoise** — remove background noise (keyboard, traffic, fans, babble)
   using **DeepFilterNet 3**, an open-source speech-enhancement model.
2. **Clarity boost** — lightweight DSP that makes the remaining voice clearer
   and more consistent (AGC, presence EQ, soft compression).

The motivation is **licensing**: Krisp and Picovoice Koala charge per
seat/minute. DeepFilterNet 3 is dual MIT / Apache-2.0, RNNoise is BSD, DTLN is
MIT — all free for commercial use. LiveKit's audio-processor API
(`LocalAudioTrack.setProcessor()` on web, equivalents on mobile) is open, so the
integration layer carries no license cost either.

## 2. Goals / Non-Goals

### Goals
- Krisp-comparable noise suppression with **no per-seat license fee**.
- A single shared engine reused across web, Android, iOS.
- Web client first (`web-app`), working end-to-end.
- User-toggleable, off by default; lazy-loaded so it costs nothing when disabled.
- Honour web-app performance budgets — the model must not inflate the initial bundle.

### Non-Goals
- Training our own model (we embed an existing one).
- Server-side denoising on the SFU (it forwards encoded RTP, does not process
  media; agent-side denoising is a separate future effort).
- ~~Android/iOS implementation in this repo~~ — superseded 2026-06-12: the adapters now live here (`android/`, `ios/`); see `docs/superpowers/specs/2026-06-12-voice-clarity-mobile-adapters-design.md`.

## 3. Engine decision

| Engine | License | Quality | CPU/Battery | Verdict |
|---|---|---|---|---|
| **DeepFilterNet 3** | MIT / Apache-2.0 | Best | Heaviest | **Chosen** |
| DTLN | MIT | Good | Medium | Fallback candidate |
| RNNoise | BSD | Solid (steady noise) | Lightest | Low-end fallback |

DeepFilterNet 3 is a *speech enhancement* model (reconstructs clean speech, not
a crude gate) with a tunable attenuation limit so voices don't sound
"underwater." Risk accepted: heaviest on CPU/battery — measured during web
rollout; RNNoise becomes a runtime fallback only if low-end devices struggle.

## 4. Architecture

```
mic ─▶ [HPF] ─▶ [DeepFilterNet3] ─▶ [clarity post-chain] ─▶ LiveKit publish
              rumble cut  speech enhance   AGC + presence EQ + soft comp
```

### 4.1 `denoise-voice-core` (shared, Rust)
One engine, compiled to three targets from one codebase: **WASM** (web),
**JNI/NDK native lib** (Android), **Swift FFI static lib** (iOS). Frame-based,
48 kHz mono, 10 ms (480-sample) frames. Public API:
`init(config)`, `process(in, out)`, `set_enabled`, `set_attenuation_limit_db`,
`set_clarity`, `reset`, `destroy`.

### 4.2 Per-platform LiveKit adapter (thin glue)
Web: an `AudioWorkletProcessor` calling the WASM module, wrapped as a LiveKit
`TrackProcessor` and attached via `LocalAudioTrack.setProcessor()`.

### 4.3 Clarity post-chain (DSP, VAD-gated)
1. **AGC / normalization** — lift quiet talkers to a consistent level.
2. **Presence EQ** — gentle lift ~2–5 kHz where intelligibility lives.
3. **Soft compressor / limiter** — even out loud/soft, prevent clipping.
4. **(optional) De-esser** — only if presence lift makes sibilance harsh.

## 5. Web integration (first deliverable)

Repo: `web-app` (`livekit-client@2.17.2`). Today `realLivekitAdapter.ts:231`
sets `audioCaptureDefaults` with browser-native suppression. The add-on:
- Keeps browser `echoCancellation: true` (AEC stays the browser's job).
- Turns **off** native `noiseSuppression`/`autoGainControl` when active.
- Attaches the processor via `setProcessor()`, inside `infra/livekit` (Clean
  Architecture: `features/`/`application/` never touch the SDK).
- **Lazy-loads** the multi-MB WASM only on enable (CI blocks bundle >350 KB).
- AudioWorklet runs off the main thread (no frame-render budget impact).
- Behind `FEATURE_VOICE_CLARITY` (default off in prod). Load failure / unsupported
  → silently fall back to native suppression, log non-fatal.

## 6. Data flow

```
LocalAudioTrack (mic)
  └─ TrackProcessor → AudioWorklet ── f32 10ms frames ──▶ core (WASM)
                                          ├ HPF ├ DeepFilterNet3 └ clarity
       ◀── cleaned frames ──┘
  └─ published to LiveKit SFU
```
No audio leaves the device; nothing new is sent to any server. Preserves E2EE.

## 7. Error handling & degradation
- WASM/model load failure → native browser suppression; toggle "unavailable."
- Processor throws mid-call → detach, keep raw track live, log non-fatal.
- Frame budget overrun on slow devices → auto-disable + one-time notice;
  candidate trigger for the RNNoise fallback later.

## 8. Performance & fallback
Target: real-time within the 10 ms frame budget on a mid-tier laptop / modern
phone. Measure CPU%, dropped frames, battery during rollout. Add RNNoise as a
lighter per-tier profile only if measurements demand it (the core abstracts the
engine behind one trait). Not built up front (YAGNI).

## 9. Testing
- **Core (Rust):** golden-frame DSP tests; SNR-improvement on fixture clips;
  attenuation-limit bounds.
- **Web adapter:** Vitest for attach/detach, enable/disable, fallback-on-failure;
  worklet message-protocol contract test.
- **E2E (Playwright):** toggle on/off mid-call without dropping audio; fallback path.
- **Manual A/B:** keyboard / café / fan / street vs native and vs Krisp yardstick.

## 10. Rollout
1. Build `denoise-voice-core` (WASM + DFN3 + clarity), unit-tested.
2. Wire web adapter into `infra/livekit`; lazy-load; flag off.
3. Dogfood on dev/staging; gather CPU/battery/quality data.
4. Cohort enable; compare vs native.
5. ~~Android adapter (reuse core) → iOS adapter; each its own spec → plan cycle.~~ — superseded 2026-06-12: adapters built in-repo (`android/`, `ios/`); mobile teams integrate the AAR / Swift Package behind their own toggle and run device A/B before enabling by default.

## 11. Open questions
- DFN3 WASM: single-threaded vs SharedArrayBuffer-threaded (decide after a spike
  against the COOP/COEP headers already in web-app).
- Clarity-chain default params (EQ curve, AGC target LUFS, compressor ratio) —
  tune during the manual quality pass.
- Single tuned profile vs a user "strength" slider (lean: single profile first).
