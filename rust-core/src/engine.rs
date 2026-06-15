//! The denoiser engine, behind a trait so the platform glue and the clarity
//! chain never depend on which model is compiled in.
//!
//! - Default build: `PassthroughDenoiser` — builds and tests with no external
//!   model. The clarity chain still runs, so the chain is fully exercisable.
//! - `feature = "dfn"`: `DeepFilterNetDenoiser` — the real DeepFilterNet 3
//!   model. Needs the `deep_filter` crate and model weights.
//!
//! Swapping in RNNoise later (the low-end fallback in DESIGN §8) means adding
//! another `impl Denoiser` and a feature flag — nothing else changes.

/// One noise-suppression engine over 48 kHz / 480-sample frames.
pub trait Denoiser {
    /// Denoise one `FRAME_SIZE` frame in place.
    fn process(&mut self, frame: &mut [f32]);
    /// Clamp how aggressively noise is attenuated (dB). No-op for engines that
    /// don't support it (e.g. passthrough).
    fn set_attenuation_limit_db(&mut self, _db: f32) {}
    /// Drop model/filter state on track restart.
    fn reset(&mut self) {}
}

/// Selects the compiled-in engine.
pub fn new_engine() -> Box<dyn Denoiser> {
    #[cfg(feature = "dfn")]
    {
        match DeepFilterNetDenoiser::from_default_model() {
            Ok(d) => return Box::new(d),
            Err(e) => {
                // Fail safe: a missing model must not kill audio — fall back to
                // passthrough and let the clarity chain still help.
                eprintln!("denoise-voice-core: DFN init failed ({e}); using passthrough");
            }
        }
    }
    Box::new(PassthroughDenoiser)
}

/// Reference engine: leaves the signal untouched. Lets the whole chain build
/// and be unit-tested without any model.
pub struct PassthroughDenoiser;

impl Denoiser for PassthroughDenoiser {
    fn process(&mut self, _frame: &mut [f32]) {}
}

// ---------------------------------------------------------------------------
// DeepFilterNet 3 binding (real `deep_filter` API, git-pinned upstream).
//
// The model weights are embedded by the crate's `default-model` feature — no
// external file or env var needed. Inference runs through `tract`. The model is
// 48 kHz with hop_size 480, matching our FRAME_SIZE.
// ---------------------------------------------------------------------------
#[cfg(feature = "dfn")]
mod dfn {
    use super::Denoiser;
    use crate::FRAME_SIZE;
    use df::tract::{DfParams, DfTract, RuntimeParams};
    use ndarray::{Array2, ArrayView1};

    pub struct DeepFilterNetDenoiser {
        model: DfTract,
        // Reusable [channels, hop] buffers so we don't allocate on the audio thread.
        noisy: Array2<f32>,
        enh: Array2<f32>,
    }

    impl DeepFilterNetDenoiser {
        pub fn from_default_model() -> Result<Self, String> {
            // default-model embeds the weights; DfParams::default() loads them.
            let params = DfParams::default();
            let rp = RuntimeParams::default_with_ch(1);
            let model =
                DfTract::new(params, &rp).map_err(|e| format!("init DFN tract: {e:?}"))?;
            if model.hop_size != FRAME_SIZE {
                return Err(format!(
                    "DFN hop_size {} != FRAME_SIZE {}",
                    model.hop_size, FRAME_SIZE
                ));
            }
            let hop = model.hop_size;
            Ok(Self {
                model,
                noisy: Array2::zeros((1, hop)),
                enh: Array2::zeros((1, hop)),
            })
        }
    }

    impl Denoiser for DeepFilterNetDenoiser {
        fn process(&mut self, frame: &mut [f32]) {
            // Copy the mono frame into the [1, hop] input view.
            self.noisy.row_mut(0).assign(&ArrayView1::from(&*frame));
            // process(noisy, enh) -> LSNR (ignored). enh holds the cleaned frame.
            if self
                .model
                .process(self.noisy.view(), self.enh.view_mut())
                .is_ok()
            {
                if let Some(out) = self.enh.row(0).as_slice() {
                    frame.copy_from_slice(out);
                }
            }
            // On error we leave the frame as-is (fail-safe passthrough).
        }

        fn set_attenuation_limit_db(&mut self, db: f32) {
            self.model.set_atten_lim(db);
        }
    }
}

#[cfg(feature = "dfn")]
pub use dfn::DeepFilterNetDenoiser;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FRAME_SIZE;

    #[test]
    fn passthrough_is_identity() {
        // Test the passthrough engine directly — with `--features dfn`,
        // new_engine() returns the real DFN engine instead.
        let mut e = PassthroughDenoiser;
        let original: Vec<f32> = (0..FRAME_SIZE).map(|i| (i as f32).sin()).collect();
        let mut frame = original.clone();
        e.process(&mut frame);
        assert_eq!(frame, original);
    }

    // In the default build new_engine() must hand back the passthrough engine.
    #[cfg(not(feature = "dfn"))]
    #[test]
    fn default_engine_is_passthrough_identity() {
        let mut e = new_engine();
        let original: Vec<f32> = (0..FRAME_SIZE).map(|i| (i as f32).sin()).collect();
        let mut frame = original.clone();
        e.process(&mut frame);
        assert_eq!(frame, original);
    }

    // Runtime + real-time check for the real DeepFilterNet model.
    // Run with: cargo test --features dfn dfn_runtime -- --nocapture
    #[cfg(feature = "dfn")]
    #[test]
    fn dfn_runtime_loads_denoises_and_is_realtime() {
        use std::time::Instant;
        let mut e = DeepFilterNetDenoiser::from_default_model().expect("DFN default model loads");

        // Deterministic pseudo-noise (no speech) — DFN should attenuate it.
        let noise: Vec<f32> = (0..FRAME_SIZE)
            .map(|i| {
                let x = (i as u32).wrapping_mul(2654435761) % 2000;
                (x as f32 / 1000.0 - 1.0) * 0.4
            })
            .collect();
        let in_energy: f32 = noise.iter().map(|x| x * x).sum();

        // warm up the model's internal lookahead/state
        for _ in 0..8 {
            let mut f = noise.clone();
            e.process(&mut f);
        }

        let n = 200;
        let mut out = noise.clone();
        let t = Instant::now();
        for _ in 0..n {
            out = noise.clone();
            e.process(&mut out);
        }
        let per_frame_ms = t.elapsed().as_secs_f64() * 1000.0 / n as f64;
        let out_energy: f32 = out.iter().map(|x| x * x).sum();

        println!(
            "DFN native: {per_frame_ms:.3} ms/frame (budget 10ms) | noise energy {in_energy:.4} -> {out_energy:.4}"
        );
        assert!(out.iter().all(|x| x.is_finite()), "output must be finite");
        assert!(
            per_frame_ms < 10.0,
            "not real-time even natively: {per_frame_ms:.3} ms/frame"
        );
        assert!(
            out_energy < in_energy,
            "DFN should attenuate pure noise: {in_energy:.4} -> {out_energy:.4}"
        );
    }
}
