//! denoise-voice-core
//!
//! Client-side noise suppression + voice-clarity chain for LiveKit calls.
//! A license-free replacement for the Krisp filter. See ../DESIGN.md.
//!
//! Audio contract: 48 kHz, mono, f32 samples in [-1.0, 1.0], processed in
//! fixed 10 ms frames (`FRAME_SIZE` = 480 samples). The host (AudioWorklet on
//! web, native processor on mobile) is responsible for resampling to 48 kHz
//! mono and for buffering the platform's block size into `FRAME_SIZE` frames.

pub mod bands;
pub mod clarity;
pub mod engine;
pub mod vad;

#[cfg(feature = "wasm")]
pub mod wasm;

use clarity::{ClarityChain, ClarityConfig};
use engine::{new_engine, Denoiser};

/// Sample rate the core operates at. The host must resample to this.
pub const SAMPLE_RATE: u32 = 48_000;
/// Frame size in samples (10 ms @ 48 kHz). Matches DeepFilterNet's hop size.
pub const FRAME_SIZE: usize = 480;

/// Top-level configuration for a `VoiceClarity` instance.
#[derive(Clone, Debug)]
pub struct Config {
    /// Master enable. When false, `process` is a bit-exact passthrough.
    pub enabled: bool,
    /// Maximum noise attenuation in dB. Limiting this keeps the voice natural
    /// instead of "underwater" when the denoiser is aggressive. ~24–40 dB is
    /// a sane range; DeepFilterNet honours this directly.
    pub attenuation_limit_db: f32,
    /// Clarity post-chain settings (AGC, EQ, compressor).
    pub clarity: ClarityConfig,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: true,
            attenuation_limit_db: 30.0,
            clarity: ClarityConfig::default(),
        }
    }
}

/// The full chain: optional high-pass → denoiser → clarity post-chain.
///
/// One instance per audio track. Not thread-safe; the host owns it on a single
/// audio thread (the AudioWorklet thread on web).
pub struct VoiceClarity {
    enabled: bool,
    denoiser: Box<dyn Denoiser>,
    clarity: ClarityChain,
    // Scratch buffer so we never allocate on the audio thread.
    scratch: [f32; FRAME_SIZE],
}

impl VoiceClarity {
    /// Create a new chain. `new_engine` selects the compiled-in denoiser
    /// (DeepFilterNet when `feature = "dfn"`, otherwise the passthrough
    /// reference engine).
    pub fn new(config: Config) -> Self {
        let mut denoiser = new_engine();
        denoiser.set_attenuation_limit_db(config.attenuation_limit_db);
        Self {
            enabled: config.enabled,
            denoiser,
            clarity: ClarityChain::new(SAMPLE_RATE as f32, config.clarity),
            scratch: [0.0; FRAME_SIZE],
        }
    }

    /// Process exactly one `FRAME_SIZE` frame in place.
    ///
    /// When disabled, returns immediately leaving `frame` untouched. The host
    /// must always feed full frames; partial frames are a programming error
    /// and are left untouched.
    pub fn process(&mut self, frame: &mut [f32]) {
        if !self.enabled || frame.len() != FRAME_SIZE {
            return;
        }
        // 1) denoise (engine may also do its own internal high-pass / dereverb)
        self.scratch.copy_from_slice(frame);
        self.denoiser.process(&mut self.scratch);
        // 2) clarity post-chain on the cleaned signal
        self.clarity.process(&mut self.scratch);
        frame.copy_from_slice(&self.scratch);
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    pub fn set_attenuation_limit_db(&mut self, db: f32) {
        self.denoiser.set_attenuation_limit_db(db);
    }

    pub fn set_clarity(&mut self, config: ClarityConfig) {
        self.clarity.set_config(config);
    }

    /// Reset all internal state (filters, AGC envelope, denoiser model state).
    /// Call on track restart so stale state doesn't bleed across sessions.
    pub fn reset(&mut self) {
        self.denoiser.reset();
        self.clarity.reset();
        self.scratch = [0.0; FRAME_SIZE];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_is_passthrough() {
        let mut vc = VoiceClarity::new(Config {
            enabled: false,
            ..Config::default()
        });
        let original: Vec<f32> = (0..FRAME_SIZE).map(|i| (i as f32 * 0.001).sin()).collect();
        let mut frame = original.clone();
        vc.process(&mut frame);
        assert_eq!(frame, original, "disabled chain must not alter samples");
    }

    #[test]
    fn wrong_frame_size_is_ignored() {
        let mut vc = VoiceClarity::new(Config::default());
        let mut frame = vec![0.5_f32; FRAME_SIZE + 1];
        let original = frame.clone();
        vc.process(&mut frame);
        assert_eq!(frame, original, "non-FRAME_SIZE frames are left untouched");
    }

    #[test]
    fn output_stays_bounded() {
        // Even with the clarity boost, output must never blow past the limiter.
        let mut vc = VoiceClarity::new(Config::default());
        for _ in 0..200 {
            let mut frame: Vec<f32> = (0..FRAME_SIZE)
                .map(|i| 0.9 * (i as f32 * 0.05).sin())
                .collect();
            vc.process(&mut frame);
            for s in &frame {
                assert!(s.abs() <= 1.0001, "sample {} exceeded full-scale", s);
            }
        }
    }
}
