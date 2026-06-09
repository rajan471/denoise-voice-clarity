// LiveKit TrackProcessor that runs the voice-clarity chain on a local mic track.
//
// Usage (inside web-app's infra/livekit adapter, behind FEATURE_VOICE_CLARITY):
//
//   const { VoiceClarityProcessor } = await import('denoise-voice-clarity');
//   const proc = new VoiceClarityProcessor();
//   await micTrack.setProcessor(proc);   // micTrack: LocalAudioTrack
//
// On unsupported browsers or load failure, callers should catch and fall back
// to the browser-native noiseSuppression in audioCaptureDefaults.
//
// NOTE: the exact TrackProcessor shape can vary across livekit-client minor
// versions — verify against the installed ^2.17.x before wiring. We implement
// the documented init/restart/destroy + processedTrack contract.

import type { Track } from 'livekit-client';
import { loadRuntime } from './loader';

export interface VoiceClarityOptions {
  /** Master enable; can be toggled at runtime via setEnabled(). */
  enabled?: boolean;
  /** Max noise attenuation (dB). Lower = more natural, higher = more removal. */
  attenuationLimitDb?: number;
  /** Presence-EQ lift (dB) — the "clarity strength" knob. */
  presenceGainDb?: number;
}

interface ProcessorOptions {
  track: MediaStreamTrack;
  audioContext?: AudioContext;
}

export class VoiceClarityProcessor {
  readonly name = 'denoise-voice-clarity';

  /** LiveKit reads this and publishes it instead of the raw mic track. */
  processedTrack?: MediaStreamTrack;

  private opts: Required<VoiceClarityOptions>;
  private context?: AudioContext;
  private ownsContext = false;
  private source?: MediaStreamAudioSourceNode;
  private worklet?: AudioWorkletNode;
  private sink?: MediaStreamAudioDestinationNode;

  constructor(opts: VoiceClarityOptions = {}) {
    this.opts = {
      enabled: opts.enabled ?? true,
      attenuationLimitDb: opts.attenuationLimitDb ?? 30,
      presenceGainDb: opts.presenceGainDb ?? 4,
    };
  }

  async init(options: ProcessorOptions): Promise<void> {
    // The DeepFilterNet model requires 48 kHz. Reuse LiveKit's context only if
    // it's already at 48 kHz; otherwise create our own so the worklet's
    // 480-sample frames are a true 10 ms (wrong rate → distorted denoise).
    const provided = options.audioContext;
    this.context =
      provided && provided.sampleRate === 48_000
        ? provided
        : new AudioContext({ sampleRate: 48_000 });
    this.ownsContext = this.context !== provided;

    const runtime = await loadRuntime(this.context);

    const inputStream = new MediaStream([options.track]);
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

  /** Called by LiveKit when the underlying track is replaced (e.g. device switch). */
  async restart(options: ProcessorOptions): Promise<void> {
    await this.destroy();
    await this.init(options);
  }

  setEnabled(enabled: boolean): void {
    this.opts.enabled = enabled;
    this.worklet?.port.postMessage({ type: 'set-enabled', value: enabled });
  }

  setPresenceGainDb(db: number): void {
    this.opts.presenceGainDb = db;
    this.worklet?.port.postMessage({ type: 'set-presence-gain', value: db });
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
