//! Clarity post-chain: cheap DSP applied *after* denoising to boost the voice
//! and keep levels consistent. All stages are real-time, per-frame/per-sample,
//! and allocate nothing on the audio thread.
//!
//! Chain order: high-pass → presence EQ → AGC → soft compressor → limiter.
//! AGC is gated by a voice-activity detector so we never amplify the noise
//! floor during silence.

use crate::vad::Vad;

const EPS: f32 = 1.0e-9;

#[inline]
fn db_to_lin(db: f32) -> f32 {
    10.0_f32.powf(db / 20.0)
}
#[inline]
fn lin_to_db(x: f32) -> f32 {
    20.0 * (x.abs() + EPS).log10()
}

/// Tunable parameters for the clarity chain. Defaults are a sensible
/// voice-call profile; tune during the manual A/B quality pass (DESIGN §11).
#[derive(Clone, Debug)]
pub struct ClarityConfig {
    pub hpf_hz: f32,           // remove rumble / plosive thump below this
    pub presence_hz: f32,      // intelligibility band centre (~2–5 kHz)
    pub presence_gain_db: f32, // gentle lift at presence_hz
    pub presence_q: f32,
    pub agc_target_db: f32,    // target RMS level (dBFS) for speech
    pub agc_max_gain_db: f32,  // ceiling on how much AGC may boost
    pub agc_time_const_ms: f32,
    pub comp_threshold_db: f32,
    pub comp_ratio: f32,
    pub comp_attack_ms: f32,
    pub comp_release_ms: f32,
    pub comp_makeup_db: f32,
    pub limiter_ceiling: f32, // linear, just under full scale
}

impl Default for ClarityConfig {
    fn default() -> Self {
        Self {
            hpf_hz: 80.0,
            presence_hz: 3000.0,
            presence_gain_db: 4.0,
            presence_q: 0.7,
            agc_target_db: -20.0,
            agc_max_gain_db: 18.0,
            agc_time_const_ms: 150.0,
            comp_threshold_db: -18.0,
            comp_ratio: 3.0,
            comp_attack_ms: 5.0,
            comp_release_ms: 80.0,
            comp_makeup_db: 2.0,
            limiter_ceiling: 0.99,
        }
    }
}

/// Transposed Direct Form II biquad. Stable, low-noise, one multiply-add per tap.
#[derive(Clone, Copy, Default)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn highpass(fs: f32, f0: f32, q: f32) -> Self {
        let w0 = 2.0 * std::f32::consts::PI * f0 / fs;
        let (sin, cos) = w0.sin_cos();
        let alpha = sin / (2.0 * q);
        let a0 = 1.0 + alpha;
        Self::normalized(
            (1.0 + cos) / 2.0,
            -(1.0 + cos),
            (1.0 + cos) / 2.0,
            a0,
            -2.0 * cos,
            1.0 - alpha,
        )
    }

    fn peaking(fs: f32, f0: f32, q: f32, gain_db: f32) -> Self {
        let a = db_to_lin(gain_db / 2.0); // amplitude, not power
        let w0 = 2.0 * std::f32::consts::PI * f0 / fs;
        let (sin, cos) = w0.sin_cos();
        let alpha = sin / (2.0 * q);
        let a0 = 1.0 + alpha / a;
        Self::normalized(
            1.0 + alpha * a,
            -2.0 * cos,
            1.0 - alpha * a,
            a0,
            -2.0 * cos,
            1.0 - alpha / a,
        )
    }

    fn normalized(b0: f32, b1: f32, b2: f32, a0: f32, a1: f32, a2: f32) -> Self {
        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }

    fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
}

pub struct ClarityChain {
    fs: f32,
    cfg: ClarityConfig,
    hpf: Biquad,
    presence: Biquad,
    vad: Vad,
    agc_gain: f32, // current smoothed AGC gain (linear)
    comp_env_db: f32,
    comp_attack_coef: f32,
    comp_release_coef: f32,
    agc_coef: f32,
}

impl ClarityChain {
    pub fn new(fs: f32, cfg: ClarityConfig) -> Self {
        let mut c = Self {
            fs,
            hpf: Biquad::highpass(fs, cfg.hpf_hz, 0.707),
            presence: Biquad::peaking(fs, cfg.presence_hz, cfg.presence_q, cfg.presence_gain_db),
            vad: Vad::new(fs),
            agc_gain: 1.0,
            comp_env_db: -120.0,
            comp_attack_coef: 0.0,
            comp_release_coef: 0.0,
            agc_coef: 0.0,
            cfg,
        };
        c.recompute_coefs();
        c
    }

    pub fn set_config(&mut self, cfg: ClarityConfig) {
        self.cfg = cfg;
        self.hpf = Biquad::highpass(self.fs, self.cfg.hpf_hz, 0.707);
        self.presence = Biquad::peaking(
            self.fs,
            self.cfg.presence_hz,
            self.cfg.presence_q,
            self.cfg.presence_gain_db,
        );
        self.recompute_coefs();
    }

    fn recompute_coefs(&mut self) {
        let tc = |ms: f32| (-1.0 / (ms * 0.001 * self.fs)).exp();
        self.comp_attack_coef = tc(self.cfg.comp_attack_ms);
        self.comp_release_coef = tc(self.cfg.comp_release_ms);
        self.agc_coef = tc(self.cfg.agc_time_const_ms);
    }

    pub fn process(&mut self, frame: &mut [f32]) {
        // --- per-sample: high-pass + presence EQ; also accumulate RMS ---
        let mut sum_sq = 0.0_f32;
        for s in frame.iter_mut() {
            let mut x = self.hpf.process(*s);
            x = self.presence.process(x);
            *s = x;
            sum_sq += x * x;
        }
        let rms = (sum_sq / frame.len() as f32).sqrt();
        let speech = self.vad.update(rms);

        // --- AGC: only adapt toward target while speech is present ---
        if speech && rms > EPS {
            let desired_db = (self.cfg.agc_target_db - lin_to_db(rms))
                .clamp(0.0, self.cfg.agc_max_gain_db);
            let desired_gain = db_to_lin(desired_db);
            // smooth toward desired gain
            self.agc_gain = self.agc_coef * self.agc_gain + (1.0 - self.agc_coef) * desired_gain;
        }
        // (when not speech we hold the last gain — no noise-floor pumping)

        let makeup = db_to_lin(self.cfg.comp_makeup_db);
        for s in frame.iter_mut() {
            // apply AGC
            let mut x = *s * self.agc_gain;
            // --- soft compressor (per-sample envelope follower in dB) ---
            let level_db = lin_to_db(x);
            let coef = if level_db > self.comp_env_db {
                self.comp_attack_coef
            } else {
                self.comp_release_coef
            };
            self.comp_env_db = coef * self.comp_env_db + (1.0 - coef) * level_db;
            let over = self.comp_env_db - self.cfg.comp_threshold_db;
            let reduction_db = if over > 0.0 {
                over * (1.0 - 1.0 / self.cfg.comp_ratio)
            } else {
                0.0
            };
            x *= db_to_lin(-reduction_db) * makeup;
            // --- brickwall limiter ---
            x = x.clamp(-self.cfg.limiter_ceiling, self.cfg.limiter_ceiling);
            *s = x;
        }
    }

    pub fn reset(&mut self) {
        self.hpf.reset();
        self.presence.reset();
        self.vad.reset();
        self.agc_gain = 1.0;
        self.comp_env_db = -120.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|s| s * s).sum::<f32>() / x.len() as f32).sqrt()
    }

    #[test]
    fn highpass_kills_dc() {
        let mut bq = Biquad::highpass(48_000.0, 80.0, 0.707);
        let mut last = 0.0;
        for _ in 0..2000 {
            last = bq.process(1.0); // constant (DC) input
        }
        assert!(last.abs() < 0.01, "DC should be removed, got {}", last);
    }

    #[test]
    fn agc_raises_quiet_speech() {
        let cfg = ClarityConfig::default();
        let mut chain = ClarityChain::new(48_000.0, cfg);
        // quiet 300 Hz tone, well below the -20 dB target
        let make = || -> Vec<f32> {
            (0..480)
                .map(|i| 0.02 * (2.0 * std::f32::consts::PI * 300.0 * i as f32 / 48_000.0).sin())
                .collect()
        };
        let mut last = make();
        for _ in 0..400 {
            last = make();
            chain.process(&mut last);
        }
        assert!(
            rms(&last) > 0.02,
            "AGC should have boosted the quiet tone, rms={}",
            rms(&last)
        );
    }

    #[test]
    fn limiter_caps_hot_input() {
        let mut chain = ClarityChain::new(48_000.0, ClarityConfig::default());
        let mut frame: Vec<f32> = (0..480)
            .map(|i| 2.0 * (i as f32 * 0.1).sin()) // deliberately over full scale
            .collect();
        chain.process(&mut frame);
        assert!(frame.iter().all(|s| s.abs() <= 0.9901));
    }
}
