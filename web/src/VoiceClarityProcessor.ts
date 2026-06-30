// LiveKit TrackProcessor adapter that runs the voice-clarity chain on a local
// mic track. This is a thin wrapper over the provider-agnostic DenoiseEngine —
// it only adapts that engine to LiveKit's TrackProcessor contract
// (init/restart/destroy + a `processedTrack` LiveKit reads and publishes).
//
// Usage (behind your FEATURE_VOICE_CLARITY flag):
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

import { DenoiseEngine, type DenoiseOptions } from './engine';

/** @deprecated Prefer `DenoiseOptions` from the package root — kept as an alias. */
export type VoiceClarityOptions = DenoiseOptions;

interface ProcessorOptions {
  track: MediaStreamTrack;
  audioContext?: AudioContext;
}

export class VoiceClarityProcessor {
  readonly name = 'denoise-voice-clarity';

  /** LiveKit reads this and publishes it instead of the raw mic track. */
  processedTrack?: MediaStreamTrack;

  private engine: DenoiseEngine;

  constructor(opts: VoiceClarityOptions = {}) {
    this.engine = new DenoiseEngine(opts);
  }

  async init(options: ProcessorOptions): Promise<void> {
    await this.engine.init(options.track, options.audioContext);
    this.processedTrack = this.engine.processedTrack;
  }

  /** Called by LiveKit when the underlying track is replaced (e.g. device switch). */
  async restart(options: ProcessorOptions): Promise<void> {
    // destroy() tears down the graph but preserves the engine's options, so we
    // can re-init the same instance and keep enabled/presence-gain settings.
    await this.engine.destroy();
    await this.init(options);
  }

  setEnabled(enabled: boolean): void {
    this.engine.setEnabled(enabled);
  }

  setPresenceGainDb(db: number): void {
    this.engine.setPresenceGainDb(db);
  }

  async destroy(): Promise<void> {
    await this.engine.destroy();
    this.processedTrack = undefined;
  }
}
