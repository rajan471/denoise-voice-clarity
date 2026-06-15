#!/usr/bin/env bash
# Build DenoiseVoiceCoreFFI.xcframework (device + simulator static libs).
#
# Requirements (install once on the build machine — NOT available in this repo
# sandbox):
#   - Rust + cargo          : https://rustup.rs
#   - Xcode (full install, not CLT-only) for xcodebuild + lipo
#   - rustup targets:
#       rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
#   - cbindgen (for header regen): cargo install cbindgen
#
# Output: ios/Frameworks/DenoiseVoiceCoreFFI.xcframework
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Regenerate the C header so it never drifts from the Rust source.
"$ROOT/scripts/gen-header.sh"

FEATURES="${FEATURES:-dfn,ffi}"
OUT="$ROOT/ios/Frameworks"
HDRS="$ROOT/ios/Sources/DenoiseVoiceCoreFFI/include"
LIB=libdenoise_voice_core.a

echo "Building denoise-voice-core static libs (features: $FEATURES)…"
cd "$ROOT/rust-core"
for t in aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios; do
  echo "  cargo build --release --target $t"
  cargo build --release --target "$t" --features "$FEATURES"
done

# Merge arm64-sim + x86_64-sim into a universal simulator slice.
SIM_FAT="$ROOT/rust-core/target/sim-universal"
mkdir -p "$SIM_FAT"
lipo -create \
  "$ROOT/rust-core/target/aarch64-apple-ios-sim/release/$LIB" \
  "$ROOT/rust-core/target/x86_64-apple-ios/release/$LIB" \
  -output "$SIM_FAT/$LIB"
echo "  lipo sim-universal → $SIM_FAT/$LIB"

rm -rf "$OUT/DenoiseVoiceCoreFFI.xcframework"
mkdir -p "$OUT"
xcodebuild -create-xcframework \
  -library "$ROOT/rust-core/target/aarch64-apple-ios/release/$LIB" -headers "$HDRS" \
  -library "$SIM_FAT/$LIB" -headers "$HDRS" \
  -output "$OUT/DenoiseVoiceCoreFFI.xcframework"

echo "Wrote $OUT/DenoiseVoiceCoreFFI.xcframework"
