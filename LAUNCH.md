# Launch kit — denoise-voice-clarity

Ready-to-post copy for the launch. Replace `DEMO_URL` with the deployed demo link
(see `web/demo/README.md`) before posting. **Post the demo link everywhere — for an
audio package, "hear it" is the whole pitch.**

Honesty notes: don't invent benchmark numbers. If you want to claim "X dB
reduction" or "beats RNNoise", record a real before/after first. Everything below
is written to be true without fabricated metrics.

Sequencing (one day):
1. Deploy the demo, confirm it works on a phone + laptop.
2. Morning (US): post **Show HN** + the LiveKit community post.
3. Cross-post to Reddit (`r/WebRTC`, `r/javascript`).
4. Publish the **dev.to** article, link it from the HN thread comment.
5. Submit to the awesome-lists (PRs sit for days — do it early).
6. Stay in the threads for the first 3–4 hours and answer everything.

---

## 1. Show HN

**Title** (HN likes plain + specific, no hype words):

```
Show HN: Open-source, in-browser noise suppression for WebRTC (Krisp alternative)
```

**URL:** `DEMO_URL`

**First comment** (post immediately after submitting):

> I built this because Krisp-grade noise suppression on the web is either a paid
> per-seat add-on (Krisp, Koala) or tied to one vendor's SDK. This is MIT, runs
> entirely client-side in an AudioWorklet + WebAssembly (DeepFilterNet 3), and
> works with plain `getUserMedia` — not just LiveKit. No audio leaves the device,
> no license server.
>
> The demo lets you toggle it on your own mic and record a 5-second A/B clip so
> you can hear the difference. Best with headphones if you turn on live monitoring.
>
> npm: https://www.npmjs.com/package/denoise-voice-clarity
> code: https://github.com/rajan471/denoise-voice-clarity
>
> Technical notes / known limitations:
> - The full DeepFilterNet model is ~18 MB of WASM, so it's lazy-loaded (dynamic
>   import) and not meant for the initial bundle. Shrinking this is the next thing
>   I want to tackle — happy to hear ideas (quantization, model pruning).
> - ~10 ms added latency (one 480-sample frame at 48 kHz).
> - Pairs with the browser's echo cancellation; it replaces native noise
>   suppression + AGC.
>
> Would love feedback on the API and the quality on different mics/environments.

---

## 2. LiveKit community (Slack #general or GitHub Discussions)

LiveKit's noise filter (Krisp) is a paid Cloud feature, so a free OSS alternative
is genuinely useful to that audience. Be a community member, not a billboard.

> Hi all — I put together an open-source, in-browser noise-suppression filter as
> a free alternative to the Krisp track processor. It's a `TrackProcessor` you
> attach to a `LocalAudioTrack` with `setProcessor()`, DeepFilterNet 3 running in
> an AudioWorklet + WASM, MIT licensed, no per-seat cost.
>
> Live demo (try it on your mic): DEMO_URL
> npm: `denoise-voice-clarity` · GitHub: https://github.com/rajan471/denoise-voice-clarity
>
> It also works outside LiveKit (plain `getUserMedia`). Feedback very welcome —
> especially on quality across different mics and whether the `setProcessor`
> contract holds up on your livekit-client version.

---

## 3. Reddit

**r/WebRTC** and **r/javascript** (also fine: r/webdev). Reddit hates ads — lead
with the technical story, not "check out my package".

**Title:**

```
I built a free, open-source in-browser noise suppression filter for WebRTC (DeepFilterNet 3 in WASM)
```

**Body:**

> Most browser noise-suppression options are either the browser's basic built-in
> one, or a paid per-seat product (Krisp/Koala). I wanted something Krisp-grade
> that's MIT and runs fully client-side, so I wrapped DeepFilterNet 3 in an
> AudioWorklet + WebAssembly.
>
> - Works with plain `getUserMedia` (and ships a LiveKit `TrackProcessor` adapter)
> - No audio leaves the device, no license server, no per-seat fee
> - Plus a small voice-clarity chain (high-pass → presence EQ → AGC → compressor)
>
> Live demo where you can A/B it on your own mic: DEMO_URL
> Code: https://github.com/rajan471/denoise-voice-clarity · npm: `denoise-voice-clarity`
>
> Honest caveats: the full model is ~18 MB of WASM (lazy-loaded), and it adds
> ~10 ms latency. Happy to answer anything about the audio-thread/WASM plumbing.

---

## 4. X / Twitter thread

1/
> Krisp-grade noise cancellation in the browser is usually paid + per-seat.
>
> So I open-sourced one. MIT, runs 100% client-side (DeepFilterNet 3 in WASM),
> works with plain WebRTC. Hear it on your own mic 👇
> DEMO_URL

2/
> How it works: your mic track → AudioWorklet → DeepFilterNet 3 (WebAssembly) →
> clean track you can publish to any WebRTC peer. No server, no audio leaving the
> device, no license key.

3/
> Drop-in for LiveKit (a `TrackProcessor`), but not tied to it — `getUserMedia`,
> Twilio, Daily, Agora all work.
>
> `npm i denoise-voice-clarity`
> https://github.com/rajan471/denoise-voice-clarity
> ⭐ appreciated if it's useful!

---

## 5. dev.to / blog article

**Title:** `A free, in-browser Krisp alternative: noise suppression with DeepFilterNet 3 + WebAssembly`

**Tags:** `webrtc`, `javascript`, `wasm`, `audio`

---

Video calls have a noise problem, and the good fixes are paywalled. Krisp and
Koala are excellent — and commercial, per-seat. The browser's built-in
`noiseSuppression` is free but weak. I wanted something in between: Krisp-grade
quality, MIT licensed, running entirely in the browser. That's
[`denoise-voice-clarity`](https://www.npmjs.com/package/denoise-voice-clarity).

**[▶ Try the live demo](DEMO_URL)** — toggle it on your own mic and record an A/B
clip. (The rest of this post is just how it works.)

### The pipeline

```
mic track → MediaStreamSource → AudioWorklet (DeepFilterNet 3, WASM) → MediaStreamDestination → clean track
```

Everything happens on the client. The denoiser is [DeepFilterNet 3][dfn], a
small neural model, compiled to WebAssembly and run inside an `AudioWorklet` so
it sits on the audio render thread instead of the main thread. After the neural
suppression, a light voice-clarity chain (high-pass → presence EQ → AGC → soft
compressor, VAD-gated) makes speech sit forward.

### Using it (no LiveKit needed)

```ts
const { createDenoisedStream } = await import('denoise-voice-clarity');

const mic = await navigator.mediaDevices.getUserMedia({
  audio: { noiseSuppression: false, autoGainControl: false, echoCancellation: true },
});
const denoised = await createDenoisedStream(mic);

// denoised.track is clean — send it over any RTCPeerConnection:
peerConnection.addTrack(denoised.track, denoised.stream);
```

We dynamic-import the package so the multi-MB WASM never lands in your initial
bundle. There's also a one-line LiveKit `TrackProcessor` adapter if you're on
LiveKit.

### Two engineering notes worth sharing

**AudioWorklet can't `fetch` or dynamic-import reliably.** So the main thread
compiles the `.wasm` into a `WebAssembly.Module` and hands it to the worklet via
`processorOptions`; the worklet instantiates it synchronously (`initSync`). That
keeps instantiation off the audio hot path.

**Sample rate matters.** DeepFilterNet expects 48 kHz; the worklet's 480-sample
frames are only a true 10 ms at 48 kHz. If we're handed a context at another
rate, we spin up our own 48 kHz `AudioContext` rather than distort the model.

### Honest limitations

- The full model is ~18 MB of WASM. Lazy-load it. Shrinking this is next.
- ~10 ms added latency (one frame).
- It replaces the browser's noise suppression + AGC; keep echo cancellation on.

It's MIT, no per-seat cost, no audio leaving the device. Code and issues:
[github.com/rajan471/denoise-voice-clarity][gh]. If it's useful, a ⭐ helps it
reach more people.

[dfn]: https://github.com/Rikorose/DeepFilterNet
[gh]: https://github.com/rajan471/denoise-voice-clarity

---

## 6. Distribution checklist (do these regardless of the launch)

- [ ] **Deploy the demo** and put the URL in: GitHub repo "Website" field, npm
      `homepage`, README top, every post above.
- [ ] **GitHub repo polish**: add a description + topics
      (`webrtc`, `noise-suppression`, `wasm`, `audioworklet`, `livekit`, `krisp`,
      `deepfilternet`), and a short demo GIF/audio at the top of the README.
- [ ] **Submit to awesome lists** (PRs):
      `awesome-livekit`, `awesome-webrtc`, `awesome-wasm`, `awesome-audio`.
- [ ] **Answer the "how does it compare to RNNoise/Krisp" question** with a real
      recorded sample, not adjectives.
- [ ] **npm SEO**: the description + keywords are updated; npm ranks on those.
- [ ] **Link from your other projects** (the Gruner chat platform that uses it) —
      a real production user is the strongest signal.
- [ ] **Open a few good-first-issues** (shrink the WASM, add a React hook,
      Vue/Svelte examples) so drive-by contributors have a way in.
- [ ] **Re-engage in ~1 week** with a follow-up (a "we cut the WASM to N MB" post
      converts far better than the first launch).
