//! wasm-bindgen surface for the web target.
//!
//! Built with `wasm-pack build --target web --features wasm` (see
//! ../scripts/build-wasm.sh). The AudioWorklet on the JS side instantiates one
//! `VoiceClarityWasm` per track and calls `process` with each 480-sample frame.
//!
//! When the `dfn` feature is also enabled, the model is loaded from bytes
//! passed in from JS (you can't read env/files from inside WASM) — see
//! `with_model`. Without `dfn`, the passthrough engine + clarity chain run.

use wasm_bindgen::prelude::*;

use crate::{clarity::ClarityConfig, Config, VoiceClarity, FRAME_SIZE};

#[wasm_bindgen]
pub struct VoiceClarityWasm {
    inner: VoiceClarity,
}

#[wasm_bindgen]
impl VoiceClarityWasm {
    /// Create with default config (passthrough engine unless `dfn` is built in
    /// with a model). `attenuation_limit_db` and the clarity defaults apply.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: VoiceClarity::new(Config::default()),
        }
    }

    /// The frame size the worklet must feed (samples). Exposed so JS never
    /// hard-codes it.
    #[wasm_bindgen(getter)]
    pub fn frame_size(&self) -> usize {
        FRAME_SIZE
    }

    /// Process one frame in place. `frame` must be exactly `frame_size` long
    /// and is mutated directly (zero-copy view into WASM memory from JS).
    pub fn process(&mut self, frame: &mut [f32]) {
        self.inner.process(frame);
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.inner.set_enabled(enabled);
    }

    pub fn set_attenuation_limit_db(&mut self, db: f32) {
        self.inner.set_attenuation_limit_db(db);
    }

    /// Adjust the presence-EQ lift at runtime (the main "clarity strength" knob).
    pub fn set_presence_gain_db(&mut self, db: f32) {
        let mut cfg = ClarityConfig::default();
        cfg.presence_gain_db = db;
        self.inner.set_clarity(cfg);
    }

    pub fn reset(&mut self) {
        self.inner.reset();
    }
}

impl Default for VoiceClarityWasm {
    fn default() -> Self {
        Self::new()
    }
}
