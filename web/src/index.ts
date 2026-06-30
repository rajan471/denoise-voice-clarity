// Public entry for the web package.
//
// IMPORTANT (bundle budget): the WASM core is multi-MB. Import this module
// DYNAMICALLY (`await import('denoise-voice-clarity')`) and only when you
// actually turn the feature on, so the WASM stays out of your initial bundle.

// ── Provider-agnostic API (use this anywhere: getUserMedia, Twilio, Daily, …) ──
export { createDenoisedTrack, createDenoisedStream } from './standalone';
export type { DenoiseHandle } from './standalone';
export { DenoiseEngine } from './engine';
export type { DenoiseOptions } from './engine';

// ── Capability check (call before constructing anything) ──
export { isVoiceClaritySupported } from './loader';

// ── LiveKit adapter (a thin TrackProcessor wrapper over the engine) ──
export { VoiceClarityProcessor } from './VoiceClarityProcessor';
export type { VoiceClarityOptions } from './VoiceClarityProcessor';
