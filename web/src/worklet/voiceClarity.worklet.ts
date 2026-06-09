// AudioWorkletProcessor: bridges the browser's 128-sample render quantum to the
// core's fixed 480-sample (10 ms) frames, runs the WASM chain, and streams the
// result out. Runs on the dedicated audio thread.
//
// WASM loading: the main thread passes a compiled `WebAssembly.Module` via
// processorOptions. We instantiate it synchronously here with the wasm-bindgen
// `initSync(module)` entry (web target). The generated glue must be bundled
// INTO this worklet file at build time (AudioWorklet scope can't dynamic-import
// reliably) — configure the bundler to inline `../../wasm/denoise_voice_core.js`.
//
// This file is .ts for authoring; build it to `voiceClarity.worklet.js` (the
// URL loader.ts registers). See web/tsconfig.json + bundler notes in README.

// `initSync` is a NAMED export (the default export is the async initializer).
// We instantiate synchronously from the compiled module the main thread sends.
import { initSync, VoiceClarityWasm } from '../../wasm/denoise_voice_core.js';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
declare function registerProcessor(name: string, ctor: unknown): void;

const FRAME = 480; // must equal core FRAME_SIZE (10 ms @ 48 kHz)

// Simple single-producer/single-consumer circular buffer of f32 samples.
class Ring {
  private buf: Float32Array;
  private r = 0;
  private w = 0;
  count = 0;
  constructor(capacity: number) {
    this.buf = new Float32Array(capacity);
  }
  push(x: number): void {
    this.buf[this.w] = x;
    this.w = (this.w + 1) % this.buf.length;
    this.count++;
  }
  pop(): number {
    const x = this.buf[this.r]!;
    this.r = (this.r + 1) % this.buf.length;
    this.count--;
    return x;
  }
}

class VoiceClarityWorklet extends AudioWorkletProcessor {
  private core: VoiceClarityWasm | null = null;
  private enabled = true;
  private alive = true;

  // Decouple the browser's 128-sample render quantum from the core's 480-sample
  // frames. Input samples accumulate; whole frames are processed and pushed to
  // the output FIFO; output drains continuously. We hold ~1 frame of latency
  // (priming) so the output FIFO never underruns mid-stream — the previous
  // single-buffer scheme dropped samples and inserted zeros, causing stutter.
  private inRing = new Ring(FRAME * 16);
  private outRing = new Ring(FRAME * 16);
  private frame = new Float32Array(FRAME);
  private primed = false;
  // Output latency cushion. Frames land every ~3.75 quanta (480/128) but output
  // drains 128/quantum, so the buffer must hold enough to never run dry between
  // frames (and to absorb the occasional slow inference). 4 frames ≈ 40 ms.
  private static readonly PRIME = FRAME * 4;
  // Underrun diagnostics (post-priming silence = inference can't keep up).
  private underruns = 0;
  private samplesSinceLog = 0;

  constructor(options?: { processorOptions?: Record<string, unknown> }) {
    super();
    const po = options?.processorOptions ?? {};
    this.enabled = (po.enabled as boolean) ?? true;

    // The model assumes 48 kHz. If the AudioContext runs at another rate the
    // 480-sample frames are the wrong duration — warn loudly (the processor
    // forces a 48 kHz context, but log here as a safety net).
    if (typeof sampleRate === 'number' && sampleRate !== 48000) {
      // eslint-disable-next-line no-console
      console.warn(
        `[voice-clarity] AudioContext sampleRate is ${sampleRate}, expected 48000 — denoise may distort`,
      );
    }

    try {
      initSync(po.wasmModule as WebAssembly.Module);
      this.core = new VoiceClarityWasm();
      this.core.set_enabled(this.enabled);
      if (typeof po.attenuationLimitDb === 'number') {
        this.core.set_attenuation_limit_db(po.attenuationLimitDb);
      }
      if (typeof po.presenceGainDb === 'number') {
        this.core.set_presence_gain_db(po.presenceGainDb);
      }
    } catch (e) {
      // Fail safe: no core → passthrough so we never kill the user's audio.
      this.core = null;
      // eslint-disable-next-line no-console
      console.error('voice-clarity worklet init failed; passthrough', e);
    }

    this.port.onmessage = (ev: MessageEvent) => {
      const m = ev.data;
      if (m?.type === 'set-enabled') {
        this.enabled = !!m.value;
        this.core?.set_enabled(this.enabled);
      } else if (m?.type === 'set-presence-gain') {
        this.core?.set_presence_gain_db(m.value);
      } else if (m?.type === 'destroy') {
        this.core?.reset();
        this.alive = false;
      }
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return this.alive;

    const n = output.length;

    // Passthrough when disabled or core failed to load.
    if (!this.enabled || !this.core) {
      if (input) output.set(input);
      else output.fill(0);
      return this.alive;
    }

    // 1) Buffer this quantum's input (if muted, no samples arrive).
    if (input) {
      for (let i = 0; i < input.length; i++) this.inRing.push(input[i]!);
    }

    // 2) Process every whole frame we can, pushing results to the output FIFO.
    while (this.inRing.count >= FRAME) {
      for (let i = 0; i < FRAME; i++) this.frame[i] = this.inRing.pop();
      this.core.process(this.frame); // in-place denoise + clarity
      for (let i = 0; i < FRAME; i++) this.outRing.push(this.frame[i]!);
    }

    // 3) Build up PRIME samples of latency once, then drain continuously. Every
    //    output sample is a real processed sample, in order — no dropped
    //    samples, no zero-gaps mid-stream (the previous 1-frame cushion ran dry
    //    between frames every ~30 ms, causing the audible breaks).
    if (!this.primed && this.outRing.count >= VoiceClarityWorklet.PRIME) {
      this.primed = true;
    }

    if (this.primed) {
      for (let i = 0; i < n; i++) {
        if (this.outRing.count > 0) {
          output[i] = this.outRing.pop();
        } else {
          output[i] = 0;
          this.underruns++;
        }
      }
    } else {
      output.fill(0); // one-time priming latency (~40 ms)
    }

    // Throttled diagnostic (~once/sec). Underruns after priming mean the WASM
    // inference can't sustain real-time — surfaces the difference between a
    // buffering bug (fixed above) and a performance ceiling (needs SIMD/worker).
    this.samplesSinceLog += n;
    if (this.samplesSinceLog >= 48000) {
      if (this.underruns > 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[voice-clarity] ${this.underruns} sample underruns/s — inference too slow for real-time`,
        );
      }
      this.underruns = 0;
      this.samplesSinceLog = 0;
    }
    return this.alive;
  }
}

registerProcessor('voice-clarity-processor', VoiceClarityWorklet);
