# Launch submissions — copy-paste ready

Companion to `LAUNCH.md` (which has the Show HN / Reddit / dev.to copy). This
file is the **directory + discoverability** work: GitHub repo metadata, awesome-list
PRs, and contributor on-ramps. Everything below is ready to submit as-is.

Replace `DEMO_URL` with the GitHub Pages URL once Pages is enabled:
`https://rajan471.github.io/denoise-voice-clarity/`

---

## 1. GitHub repo metadata (Settings → General / the ⚙ next to "About")

**About → Description** (paste):

```
Real-time in-browser noise suppression for WebRTC — a free, open-source, license-free Krisp replacement (DeepFilterNet 3 in WASM). Works with plain getUserMedia or LiveKit.
```

**About → Website** (paste once Pages is live):

```
https://rajan471.github.io/denoise-voice-clarity/
```

**About → Topics** (paste the whole line into the topics box):

```
webrtc noise-suppression noise-cancellation denoise voice-clarity krisp krisp-alternative rnnoise deepfilternet wasm webassembly audioworklet livekit getusermedia typescript audio-processing
```

GitHub ranks repo search on topics + description, so this alone improves discovery.

---

## 2. awesome-rtc PR (best-maintained RTC list)

**Repo:** https://github.com/rtckit/awesome-rtc
**Section:** `Developer Resources → JavaScript Libraries`
**Entry format:** `*   [Name](URL) - description.`

**Line to add** (keep the section alphabetical):

```markdown
*   [denoise-voice-clarity](https://github.com/rajan471/denoise-voice-clarity) - Real-time in-browser noise suppression for WebRTC (DeepFilterNet 3 in WASM); a free, license-free Krisp replacement. Works with plain getUserMedia or LiveKit.
```

**PR title:** `Add denoise-voice-clarity (in-browser noise suppression) to JavaScript Libraries`

**PR body:**

> Adds [denoise-voice-clarity](https://github.com/rajan471/denoise-voice-clarity), an
> open-source (MIT) client-side noise-suppression library for WebRTC. It runs
> DeepFilterNet 3 in an AudioWorklet + WebAssembly, fully in the browser (no
> server, no per-seat license), and works with plain `getUserMedia` as well as
> LiveKit. Live demo: DEMO_URL — placed under JavaScript Libraries, kept alphabetical.

**Steps:** Fork → edit `README.md` → add the line in the JS Libraries section
(alphabetical) → commit → open PR with the title/body above.

---

## 3. awesome-wasm PR

**Repo:** https://github.com/mbasso/awesome-wasm
**Section:** `Projects → Others` (no audio/DSP subsection; alphabetical within)
**Entry format (note: description goes INSIDE the link text here):**

```markdown
*   [denoise-voice-clarity - real-time WebRTC noise suppression (DeepFilterNet 3) running in the browser via WebAssembly](https://github.com/rajan471/denoise-voice-clarity)
```

**PR title:** `Add denoise-voice-clarity to Projects`

**PR body:**

> Adds [denoise-voice-clarity](https://github.com/rajan471/denoise-voice-clarity):
> DeepFilterNet 3 compiled to WebAssembly and run in an AudioWorklet to denoise
> microphone audio in real time, entirely client-side. MIT licensed. Live demo: DEMO_URL

> Note: this list has a large PR backlog, so expect a slow merge — submit early.

---

## 4. LiveKit-specific placement

There is no single canonical "awesome-livekit" list, so the higher-value LiveKit
moves are direct (already in `LAUNCH.md`):

- Post in the **LiveKit Community Slack** (`#showcase` / `#general`) and **GitHub
  Discussions** — the Krisp-alternative angle lands well there.
- Open a short **GitHub Discussion** on `livekit/components-js` or `livekit/client-sdk-js`
  titled "Open-source Krisp-alternative TrackProcessor" linking the demo. (A
  Discussion, not an issue — it's a resource share, not a bug.)

---

## 5. Contributor on-ramps (open these as GitHub Issues, label `good first issue`)

Drive-by contributors need a door. Suggested issues:

**Issue: Shrink the WASM (~18 MB) — quantization / model pruning**
> The published bundle ships the full DeepFilterNet 3 model (~18 MB of WASM),
> lazy-loaded. Investigate int8/quantized weights, tract optimizations, or a
> lighter model tier to cut download size. This is the #1 adoption blocker.
> Acceptance: smaller `.wasm` with documented quality delta on a fixed A/B sample.

**Issue: Add a React hook (`useDenoisedTrack`)**
> Wrap `createDenoisedTrack` in a small React hook handling lifecycle/cleanup, so
> React apps can drop it in. Ship as a subpath export (`denoise-voice-clarity/react`)
> with an example.

**Issue: Framework examples (Vue, Svelte, vanilla PeerConnection)**
> Add minimal examples wiring `createDenoisedStream` into a raw `RTCPeerConnection`
> and into Vue/Svelte mic capture, mirroring the existing demo.

**Issue: Provider adapters (Twilio Video, Daily, Agora)**
> Thin adapters/recipes showing `createDenoisedTrack` feeding each SDK's
> local-audio-track API. Mostly docs + a few lines each.

---

## Suggested order

1. Repo metadata (§1) — 2 minutes, immediate SEO win.
2. awesome-rtc PR (§2) — highest-signal directory.
3. Show HN + LiveKit Slack (`LAUNCH.md`) — time these together with the demo live.
4. awesome-wasm PR (§3) — submit and forget (slow backlog).
5. Open the contributor issues (§5) before the HN traffic arrives.
