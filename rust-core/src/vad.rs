//! Tiny energy-based voice-activity detector.
//!
//! Not a speech classifier — just enough to stop the AGC from amplifying the
//! noise floor during silence. It tracks a slow noise-floor estimate and flags
//! "speech" when the short-term level sits a margin above it, with hangover so
//! we don't chop the tails of words.

const EPS: f32 = 1.0e-9;

pub struct Vad {
    floor_db: f32,    // slow noise-floor estimate (dB)
    margin_db: f32,   // how far above the floor counts as speech
    hangover: u32,    // frames to keep "speech" after it drops
    hang_count: u32,
    floor_up: f32,    // smoothing when level rises above floor (slow)
    floor_down: f32,  // smoothing when level falls (fast — track silence quickly)
}

impl Vad {
    pub fn new(_fs: f32) -> Self {
        Self {
            floor_db: -60.0,
            margin_db: 9.0,
            hangover: 20, // ~200 ms at 10 ms frames
            hang_count: 0,
            floor_up: 0.995,
            floor_down: 0.95,
        }
    }

    /// Feed one frame's RMS, get back whether speech is present.
    pub fn update(&mut self, rms: f32) -> bool {
        let level_db = 20.0 * (rms + EPS).log10();
        // adapt the floor: rise slowly, fall quickly toward quiet levels
        if level_db < self.floor_db {
            self.floor_db = self.floor_down * self.floor_db + (1.0 - self.floor_down) * level_db;
        } else {
            self.floor_db = self.floor_up * self.floor_db + (1.0 - self.floor_up) * level_db;
        }
        let is_loud = level_db > self.floor_db + self.margin_db;
        if is_loud {
            self.hang_count = self.hangover;
            true
        } else if self.hang_count > 0 {
            self.hang_count -= 1;
            true
        } else {
            false
        }
    }

    pub fn reset(&mut self) {
        self.floor_db = -60.0;
        self.hang_count = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_is_not_speech() {
        let mut vad = Vad::new(48_000.0);
        let mut last = true;
        for _ in 0..200 {
            last = vad.update(0.0001); // near-silence
        }
        assert!(!last, "sustained silence must read as non-speech");
    }

    #[test]
    fn loud_is_speech_with_hangover() {
        let mut vad = Vad::new(48_000.0);
        for _ in 0..50 {
            vad.update(0.0005);
        } // establish a low floor
        assert!(vad.update(0.2), "loud frame should be speech");
        // immediately after, hangover keeps it true for a bit
        assert!(vad.update(0.0005), "hangover should hold speech briefly");
    }
}
