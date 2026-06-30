// Provider-agnostic denoise/voice-clarity engine.
//
// This is the shared core that both the LiveKit adapter (VoiceClarityProcessor)
// and the standalone API (createDenoisedTrack/createDenoisedStream) build on.
// It owns the Web Audio graph only — it has ZERO knowledge of LiveKit:
//
//   MediaStreamTrack ──► MediaStreamSource ──► AudioWorklet (WASM) ──► MediaStreamDestination ──► processedTrack
//
// Anything that can hand us a MediaStreamTrack (getUserMedia, LiveKit, Twilio,
// Daily, Agora, a <video>'s captureStream, …) can use this.

import { loadRuntime } from './loader';

export interface DenoiseOptions {
  /** Master enable; can be toggled at runtime via setEnabled(). Default true. */
  enabled?: boolean;
  /** Max noise attenuation (dB). Lower = more natural, higher = more removal. Default 30. */
  attenuationLimitDb?: number;
  /** Presence-EQ lift (dB) — the "clarity strength" knob. Default 4. */
  presenceGainDb?: number;
}

export type ResolvedDenoiseOptions = Required<DenoiseOptions>;

/**
 * Normalise user options into a fully-populated set with defaults applied and
 * values clamped to safe ranges. Pure function — unit-testable without a browser.
 */
export function resolveOptions(opts: DenoiseOptions = {}): ResolvedDenoiseOptions {
  return {
    enabled: opts.enabled ?? true,
    // DeepFilterNet attenuation is meaningful in roughly [0, 100] dB.
    attenuationLimitDb: clamp(opts.attenuationLimitDb ?? 30, 0, 100),
    // Presence lift beyond ~12 dB starts to sound harsh; cut below 0 is allowed.
    presenceGainDb: clamp(opts.presenceGainDb ?? 4, -12, 12),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * A live denoise graph attached to one input track on one AudioContext.
 *
 * The DeepFilterNet model requires 48 kHz. We reuse a provided context only if
 * it is already at 48 kHz; otherwise we create our own so the worklet's
 * 480-sample frames are a true 10 ms (a wrong rate distorts the denoise).
 */
export class DenoiseEngine {
  /** The cleaned-up track. Available after init() resolves. */
  processedTrack?: MediaStreamTrack;

  private opts: ResolvedDenoiseOptions;
  private context?: AudioContext;
  private ownsContext = false;
  private source?: MediaStreamAudioSourceNode;
  private worklet?: AudioWorkletNode;
  private sink?: MediaStreamAudioDestinationNode;

  constructor(opts: DenoiseOptions = {}) {
    this.opts = resolveOptions(opts);
  }

  async init(track: MediaStreamTrack, audioContext?: AudioContext): Promise<void> {
    this.context =
      audioContext && audioContext.sampleRate === 48_000
        ? audioContext
        : new AudioContext({ sampleRate: 48_000 });
    this.ownsContext = this.context !== audioContext;

    const runtime = await loadRuntime(this.context);

    const inputStream = new MediaStream([track]);
    this.source = this.context.createMediaStreamSource(inputStream);
    this.sink = this.context.createMediaStreamDestination();

    this.worklet = new AudioWorkletNode(this.context, 'voice-clarity-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: {
        wasmModule: runtime.module,
        enabled: this.opts.enabled,
        attenuationLimitDb: this.opts.attenuationLimitDb,
        presenceGainDb: this.opts.presenceGainDb,
      },
    });

    this.source.connect(this.worklet);
    this.worklet.connect(this.sink);
    this.processedTrack = this.sink.stream.getAudioTracks()[0];
  }

  setEnabled(enabled: boolean): void {
    this.opts.enabled = enabled;
    this.worklet?.port.postMessage({ type: 'set-enabled', value: enabled });
  }

  setPresenceGainDb(db: number): void {
    this.opts.presenceGainDb = clamp(db, -12, 12);
    this.worklet?.port.postMessage({ type: 'set-presence-gain', value: this.opts.presenceGainDb });
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  async destroy(): Promise<void> {
    try {
      this.source?.disconnect();
      this.worklet?.disconnect();
      this.sink?.disconnect();
      this.worklet?.port.postMessage({ type: 'destroy' });
    } finally {
      if (this.ownsContext) await this.context?.close().catch(() => {});
      this.source = undefined;
      this.worklet = undefined;
      this.sink = undefined;
      this.processedTrack = undefined;
      this.context = undefined;
    }
  }
}
