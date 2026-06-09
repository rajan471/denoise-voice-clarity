// Example: wiring the voice-clarity add-on into web-app's meeting/call UI.
//
// This belongs in web-app's `infra/livekit` layer (NOT in features/ or
// application/ — Clean Architecture rule: only infra/ touches the SDK).
// It is illustrative; adapt names to realLivekitAdapter.ts.

import type { LocalAudioTrack, Room } from 'livekit-client';

// 1) When creating the Room, DISABLE native suppression so we don't double-process.
//    (Today realLivekitAdapter.ts:231 sets these to true.)
export function buildAudioCaptureDefaults(voiceClarityOn: boolean) {
  return {
    echoCancellation: true, // AEC stays the browser's job
    noiseSuppression: !voiceClarityOn, // off when our add-on is active
    autoGainControl: !voiceClarityOn, // our clarity chain owns AGC
    sampleRate: 48_000,
    channelCount: 1,
  };
}

// 2) After the mic track is published, attach the processor — lazily importing
//    the package so the multi-MB WASM never lands in the initial bundle.
export async function applyVoiceClarity(
  micTrack: LocalAudioTrack,
  flagEnabled: boolean,
): Promise<boolean> {
  if (!flagEnabled) return false;

  try {
    const { VoiceClarityProcessor, isVoiceClaritySupported } = await import(
      'denoise-voice-clarity'
    );
    if (!isVoiceClaritySupported()) return false;

    const processor = new VoiceClarityProcessor({
      enabled: true,
      attenuationLimitDb: 30,
      presenceGainDb: 4,
    });
    await micTrack.setProcessor(processor);
    return true;
  } catch (err) {
    // Fail safe: fall back to native browser suppression (already on the track
    // options if we passed voiceClarityOn=false). Log non-fatal (no PII).
    // logger.warn('voice-clarity unavailable, using native suppression', err);
    return false;
  }
}

// 3) Runtime toggle from the in-call control bar:
//      const proc = micTrack.getProcessor() as VoiceClarityProcessor | undefined;
//      proc?.setEnabled(false);
//
// 4) On call end / device switch, LiveKit calls processor.destroy()/restart()
//    automatically when the track is stopped or replaced.
//
// Gate the whole thing behind FEATURE_VOICE_CLARITY (default off in prod).
export async function exampleJoinFlow(room: Room): Promise<void> {
  await room.localParticipant.setMicrophoneEnabled(true);
  const pub = room.localParticipant.getTrackPublication(/* Source.Microphone */ 'microphone' as never);
  const track = pub?.audioTrack as LocalAudioTrack | undefined;
  if (track) await applyVoiceClarity(track, /* flag */ true);
}
