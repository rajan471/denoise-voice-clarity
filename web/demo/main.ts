// Live demo wiring for denoise-voice-clarity.
//
// We import the package straight from its built ../dist so the loader's
// `new URL('./wasm/…', import.meta.url)` and worklet paths resolve to real
// files that Vite can serve/fingerprint. (Importing ../src would break those
// asset URLs.)
import {
  createDenoisedStream,
  isVoiceClaritySupported,
  type DenoiseHandle,
} from '../dist/index.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const enableBtn = $<HTMLButtonElement>('enable');
const gateStatus = $('gateStatus');
const liveCard = $('live');
const spectrumCard = $('spectrumCard');
const compareCard = $('compare');

let rawStream: MediaStream | null = null;
let handle: DenoiseHandle | null = null;
let monitorEl: HTMLAudioElement | null = null;

enableBtn.addEventListener('click', async () => {
  if (!isVoiceClaritySupported()) {
    gateStatus.textContent = 'This browser lacks AudioWorklet + WASM streaming. Try Chrome/Edge/Firefox.';
    return;
  }
  enableBtn.disabled = true;
  gateStatus.textContent = 'Requesting mic + loading WASM…';
  try {
    // Ask the browser NOT to denoise — we want the raw signal so the contrast
    // is honest. Our chain owns suppression + AGC.
    rawStream = await navigator.mediaDevices.getUserMedia({
      audio: { noiseSuppression: false, echoCancellation: true, autoGainControl: false },
    });
    handle = await createDenoisedStream(rawStream, { enabled: true, presenceGainDb: 4 });

    gateStatus.textContent = 'Ready ✓';
    liveCard.classList.remove('hidden');
    spectrumCard.classList.remove('hidden');
    compareCard.classList.remove('hidden');
    startScope(handle.stream);
    startSpectrum(rawStream, handle.stream);
    setupLiveControls();
    setupRecorder();
  } catch (err) {
    enableBtn.disabled = false;
    gateStatus.textContent = 'Mic permission denied or unavailable.';
    console.error(err);
  }
});

// ── Live controls: bypass toggle, headphone monitor, clarity slider ──────────
function setupLiveControls() {
  const denoiseToggle = $('denoiseToggle');
  const denoiseSwitch = $('denoiseSwitch');
  const denoiseLabel = $('denoiseLabel');
  let on = true;
  denoiseToggle.addEventListener('click', () => {
    on = !on;
    handle!.setEnabled(on);
    denoiseSwitch.classList.toggle('on', on);
    denoiseLabel.textContent = on ? 'ON' : 'OFF';
    denoiseLabel.style.color = on ? 'var(--accent)' : 'var(--muted)';
  });

  const monitorToggle = $('monitorToggle');
  const monitorSwitch = $('monitorSwitch');
  let monitoring = false;
  monitorToggle.addEventListener('click', () => {
    monitoring = !monitoring;
    monitorSwitch.classList.toggle('on', monitoring);
    if (monitoring) {
      monitorEl = new Audio();
      monitorEl.srcObject = handle!.stream;
      monitorEl.play().catch(() => {});
    } else if (monitorEl) {
      monitorEl.pause();
      monitorEl.srcObject = null;
      monitorEl = null;
    }
  });

  const presence = $<HTMLInputElement>('presence');
  const presenceVal = $('presenceVal');
  presence.addEventListener('input', () => {
    const db = Number(presence.value);
    handle!.setPresenceGainDb(db);
    presenceVal.textContent = `${db >= 0 ? '+' : ''}${db} dB`;
  });
}

// ── Oscilloscope on the cleaned output ───────────────────────────────────────
function startScope(stream: MediaStream) {
  const canvas = $<HTMLCanvasElement>('scope');
  const ctx = canvas.getContext('2d')!;
  const ac = new AudioContext();
  const src = ac.createMediaStreamSource(stream);
  const analyser = ac.createAnalyser();
  analyser.fftSize = 2048;
  src.connect(analyser); // not connected to destination → no feedback
  const buf = new Uint8Array(analyser.fftSize);

  const draw = () => {
    requestAnimationFrame(draw);
    analyser.getByteTimeDomainData(buf);
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#33e6a0';
    ctx.beginPath();
    const slice = width / buf.length;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i] / 128 - 1;
      const y = height / 2 + v * (height / 2) * 0.9;
      const x = i * slice;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  };
  draw();
}

// ── Dual spectrum: raw input (red) vs denoised output (green) ────────────────
// Both analysers live in one analysis-only AudioContext (never connected to the
// destination, so there's no feedback). The red bars show the mic with all its
// noise; the green bars show what the filter lets through. The gap is removed
// energy. Level meters + a smoothed "noise reduction" dB make it quantitative.
function startSpectrum(rawStream: MediaStream, cleanStream: MediaStream) {
  const canvas = $<HTMLCanvasElement>('spectrum');
  const ctx = canvas.getContext('2d')!;
  const inBar = $<HTMLElement>('inBar');
  const outBar = $<HTMLElement>('outBar');
  const inLevel = $('inLevel');
  const outLevel = $('outLevel');
  const reductionEl = $('reduction');

  const ac = new AudioContext();
  const makeAnalyser = (stream: MediaStream) => {
    const a = ac.createAnalyser();
    a.fftSize = 1024;
    a.smoothingTimeConstant = 0.75;
    ac.createMediaStreamSource(stream).connect(a); // analysis only — no output
    return a;
  };
  const inA = makeAnalyser(rawStream);
  const outA = makeAnalyser(cleanStream);

  const bins = inA.frequencyBinCount; // 512
  const inFreq = new Uint8Array(bins);
  const outFreq = new Uint8Array(bins);
  const inTime = new Uint8Array(inA.fftSize);
  const outTime = new Uint8Array(outA.fftSize);

  // Show speech-relevant range only: 0–8 kHz.
  const nyquist = ac.sampleRate / 2;
  const maxBin = Math.min(bins, Math.ceil((8000 / nyquist) * bins));
  const BARS = 40;

  let smoothReduction = 0;

  const rms = (buf: Uint8Array) => {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i] / 128 - 1;
      sum += v * v;
    }
    return Math.sqrt(sum / buf.length); // 0..~1
  };
  const dbfs = (r: number) => (r <= 0.0008 ? -60 : Math.max(-60, 20 * Math.log10(r)));

  const draw = () => {
    requestAnimationFrame(draw);
    inA.getByteFrequencyData(inFreq);
    outA.getByteFrequencyData(outFreq);
    inA.getByteTimeDomainData(inTime);
    outA.getByteTimeDomainData(outTime);

    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    const gap = 3;
    const barW = (width - gap * (BARS - 1)) / BARS;
    const perBar = maxBin / BARS;

    for (let b = 0; b < BARS; b++) {
      const start = Math.floor(b * perBar);
      const end = Math.max(start + 1, Math.floor((b + 1) * perBar));
      let inMax = 0;
      let outMax = 0;
      for (let i = start; i < end; i++) {
        if (inFreq[i] > inMax) inMax = inFreq[i];
        if (outFreq[i] > outMax) outMax = outFreq[i];
      }
      const x = b * (barW + gap);
      const inH = (inMax / 255) * height;
      const outH = (outMax / 255) * height;
      // Red (input) behind — the part above green reads as "removed noise".
      ctx.fillStyle = 'rgba(255,107,107,0.55)';
      ctx.fillRect(x, height - inH, barW, inH);
      // Green (denoised output) in front.
      ctx.fillStyle = '#33e6a0';
      ctx.fillRect(x, height - outH, barW, outH);
    }

    // Level meters + reduction readout (time-domain RMS).
    const inR = rms(inTime);
    const outR = rms(outTime);
    inBar.style.width = `${Math.min(100, inR * 180)}%`;
    outBar.style.width = `${Math.min(100, outR * 180)}%`;
    inLevel.textContent = `${dbfs(inR).toFixed(0)} dB`;
    outLevel.textContent = `${dbfs(outR).toFixed(0)} dB`;

    // Reduction = how much quieter output is than input right now (clamped ≥0).
    const reduction = Math.max(0, dbfs(inR) - dbfs(outR));
    smoothReduction += (reduction - smoothReduction) * 0.1;
    reductionEl.textContent = `−${smoothReduction.toFixed(1)} dB`;
  };
  draw();
}

// ── Record raw + denoised simultaneously, then A/B playback ──────────────────
const MAX_RECORD_MS = 3 * 60 * 1000; // 3 minutes, then auto-stop

function setupRecorder() {
  const recordBtn = $<HTMLButtonElement>('record');
  const recStatus = $('recStatus');
  const playRaw = $<HTMLButtonElement>('playRaw');
  const playClean = $<HTMLButtonElement>('playClean');
  const downloadRaw = $<HTMLButtonElement>('downloadRaw');
  const downloadClean = $<HTMLButtonElement>('downloadClean');
  const rawAudio = $<HTMLAudioElement>('rawAudio');
  const cleanAudio = $<HTMLAudioElement>('cleanAudio');

  const pickMime = () =>
    ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) =>
      MediaRecorder.isTypeSupported(m),
    );
  const extFor = (type: string) => (type.includes('mp4') ? 'm4a' : 'webm');

  // Object URLs backing the current recording — revoked before the next take so
  // repeated recordings don't leak blobs.
  let rawUrl: string | null = null;
  let cleanUrl: string | null = null;

  let recording = false;
  let stopRecording: (() => void) | null = null;

  recordBtn.addEventListener('click', async () => {
    // Second click while a take is in progress → stop early.
    if (recording) {
      stopRecording?.();
      return;
    }

    const mimeType = pickMime();
    const rawRec = new MediaRecorder(rawStream!, mimeType ? { mimeType } : undefined);
    const cleanRec = new MediaRecorder(handle!.stream, mimeType ? { mimeType } : undefined);
    const rawChunks: Blob[] = [];
    const cleanChunks: Blob[] = [];
    rawRec.ondataavailable = (e) => e.data.size && rawChunks.push(e.data);
    cleanRec.ondataavailable = (e) => e.data.size && cleanChunks.push(e.data);

    const done = Promise.all([
      new Promise<void>((r) => (rawRec.onstop = () => r())),
      new Promise<void>((r) => (cleanRec.onstop = () => r())),
    ]);

    // Fresh take — invalidate old outputs.
    playRaw.disabled = playClean.disabled = true;
    downloadRaw.disabled = downloadClean.disabled = true;

    recording = true;
    recordBtn.textContent = '■ Stop';
    rawRec.start();
    cleanRec.start();

    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(capTimer);
      clearInterval(ticker);
      if (rawRec.state !== 'inactive') rawRec.stop();
      if (cleanRec.state !== 'inactive') cleanRec.stop();
    };
    stopRecording = stop;
    const capTimer = setTimeout(stop, MAX_RECORD_MS);

    const startedAt = Date.now();
    const fmt = (ms: number) => {
      const total = Math.floor(ms / 1000);
      return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    };
    const tick = () => {
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(0, MAX_RECORD_MS - elapsed);
      recStatus.textContent = `● Recording ${fmt(elapsed)} — click Stop when done (auto-stops in ${fmt(remaining)})`;
    };
    tick();
    const ticker = setInterval(tick, 250);

    await done;
    clearInterval(ticker);

    const type = mimeType ?? 'audio/webm';
    if (rawUrl) URL.revokeObjectURL(rawUrl);
    if (cleanUrl) URL.revokeObjectURL(cleanUrl);
    rawUrl = URL.createObjectURL(new Blob(rawChunks, { type }));
    cleanUrl = URL.createObjectURL(new Blob(cleanChunks, { type }));
    rawAudio.src = rawUrl;
    cleanAudio.src = cleanUrl;

    const ext = extFor(type);
    wireDownload(downloadRaw, () => rawUrl, `original.${ext}`);
    wireDownload(downloadClean, () => cleanUrl, `denoised.${ext}`);

    recStatus.textContent = 'Done. Play both — same words, with and without the filter — or download them.';
    recording = false;
    stopRecording = null;
    recordBtn.textContent = '● Record';
    playRaw.disabled = playClean.disabled = false;
    downloadRaw.disabled = downloadClean.disabled = false;
  });

  wirePlay(playRaw, rawAudio, '▶ Play original', cleanAudio);
  wirePlay(playClean, cleanAudio, '▶ Play denoised', rawAudio);
}

// Trigger a file download of the current object URL under a friendly name.
function wireDownload(btn: HTMLButtonElement, url: () => string | null, filename: string) {
  btn.onclick = () => {
    const href = url();
    if (!href) return;
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
}

function wirePlay(btn: HTMLButtonElement, el: HTMLAudioElement, label: string, other: HTMLAudioElement) {
  btn.addEventListener('click', () => {
    other.pause();
    el.currentTime = 0;
    el.play();
  });
  el.onended = () => (btn.textContent = label);
  el.onplay = () => (btn.textContent = '■ Stop');
  el.onpause = () => (btn.textContent = label);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
