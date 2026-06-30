// Provider-agnostic public API — use this when you are NOT on LiveKit.
//
// Works with anything that gives you a MediaStreamTrack / MediaStream:
// getUserMedia, Twilio Video, Daily, Agora, Zoom Web SDK, a <video> element's
// captureStream(), etc. You get back a cleaned-up track/stream you can publish,
// send over a WebRTC PeerConnection, or feed to <audio>.
//
//   const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
//   const denoised = await createDenoisedStream(mic);
//   peerConnection.addTrack(denoised.stream.getAudioTracks()[0], denoised.stream);
//   // later:
//   denoised.setEnabled(false);   // bypass
//   await denoised.destroy();     // tear down

import { DenoiseEngine, type DenoiseOptions } from './engine';

export interface DenoiseHandle {
  /** The cleaned-up track. */
  readonly track: MediaStreamTrack;
  /** A MediaStream wrapping `track`, for APIs that want a stream. */
  readonly stream: MediaStream;
  /** Toggle the denoise/clarity chain on or off (bypass) at runtime. */
  setEnabled(enabled: boolean): void;
  /** Adjust the presence-EQ "clarity strength" (dB) at runtime. */
  setPresenceGainDb(db: number): void;
  /** Tear down the audio graph and (if we created it) close the AudioContext. */
  destroy(): Promise<void>;
}

/**
 * Wrap a single input audio track and return a denoised track + controls.
 *
 * @param inputTrack a live microphone `MediaStreamTrack` (kind === 'audio')
 * @param options    denoise/clarity tuning, see {@link DenoiseOptions}
 * @param audioContext optional context to reuse; must be 48 kHz to be reused,
 *                     otherwise a private 48 kHz context is created.
 */
export async function createDenoisedTrack(
  inputTrack: MediaStreamTrack,
  options: DenoiseOptions = {},
  audioContext?: AudioContext,
): Promise<DenoiseHandle> {
  if (inputTrack.kind !== 'audio') {
    throw new Error(
      `denoise-voice-clarity: expected an audio track, got kind="${inputTrack.kind}"`,
    );
  }

  const engine = new DenoiseEngine(options);
  await engine.init(inputTrack, audioContext);

  const track = engine.processedTrack;
  if (!track) {
    // Should never happen: init() always sets processedTrack on success.
    await engine.destroy();
    throw new Error('denoise-voice-clarity: failed to produce a processed track');
  }

  const stream = new MediaStream([track]);

  return {
    track,
    stream,
    setEnabled: (enabled) => engine.setEnabled(enabled),
    setPresenceGainDb: (db) => engine.setPresenceGainDb(db),
    destroy: () => engine.destroy(),
  };
}

/**
 * Convenience wrapper that takes a whole `MediaStream`, denoises its first
 * audio track, and returns a handle whose `.stream` is ready to use.
 *
 * Only the first audio track is processed (the typical mic case). Other tracks
 * (e.g. video) are not touched and are NOT included in the returned stream —
 * compose them yourself if you need a combined A/V stream.
 */
export async function createDenoisedStream(
  inputStream: MediaStream,
  options: DenoiseOptions = {},
  audioContext?: AudioContext,
): Promise<DenoiseHandle> {
  const [audioTrack] = inputStream.getAudioTracks();
  if (!audioTrack) {
    throw new Error('denoise-voice-clarity: the provided MediaStream has no audio track');
  }
  return createDenoisedTrack(audioTrack, options, audioContext);
}
