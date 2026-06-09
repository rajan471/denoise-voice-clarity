// Public entry for the web adapter.
//
// IMPORTANT (web-app bundle budget): consumers MUST import this module
// dynamically (`await import('denoise-voice-clarity')`) and only when the
// FEATURE_VOICE_CLARITY flag is on. The WASM is multi-MB; static-importing it
// would blow the 350 KB initial-bundle CI gate in web-app.

export { VoiceClarityProcessor } from './VoiceClarityProcessor';
export { isVoiceClaritySupported } from './loader';
export type { VoiceClarityOptions } from './VoiceClarityProcessor';
