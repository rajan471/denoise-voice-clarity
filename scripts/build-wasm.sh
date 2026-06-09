#!/usr/bin/env bash
# Build the WASM bundle for the web adapter.
#
# Requirements (install once on the build machine — NOT available in this repo
# sandbox):
#   - Rust + cargo                : https://rustup.rs
#   - wasm-pack                   : cargo install wasm-pack
#   - wasm32 target               : rustup target add wasm32-unknown-unknown
#
# Output: web/wasm/  (denoise_voice_core.js + _bg.wasm + .d.ts)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/web/wasm"

# Default build = passthrough engine + clarity chain (small, no model).
# Add `--features dfn,wasm` plus a bundled model to ship real DeepFilterNet.
FEATURES="${FEATURES:-wasm}"

# Enable WebAssembly SIMD (simd128). Speeds up tract / DeepFilterNet inference
# substantially in the browser — the difference between real-time and dropouts.
# All modern evergreen browsers support wasm SIMD.
export RUSTFLAGS="${RUSTFLAGS:-} -C target-feature=+simd128"

echo "Building denoise-voice-core → $OUT (features: $FEATURES, RUSTFLAGS: $RUSTFLAGS)"
cd "$ROOT/rust-core"
wasm-pack build \
  --release \
  --target web \
  --out-dir "$OUT" \
  --out-name denoise_voice_core \
  -- --features "$FEATURES"

echo "Done. Lazy-import web/wasm/denoise_voice_core.js from the web adapter."
echo "Reminder: the .wasm is multi-MB with the model — keep it out of the"
echo "web-app initial bundle (dynamic import only on feature enable)."
