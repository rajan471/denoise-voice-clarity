#!/usr/bin/env bash
# Build libdenoise_voice_core.so for all Android ABIs and assemble the AAR.
#
# Requirements (install once on the build machine — NOT available in this repo
# sandbox):
#   - Rust + cargo          : https://rustup.rs
#   - Android NDK           : set ANDROID_NDK_HOME
#   - cargo-ndk             : cargo install cargo-ndk
#   - rustup targets:
#       rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
#   - JDK 17+ and either the Gradle wrapper (android/gradlew) or a system gradle
#
# Output: android/build/outputs/aar/
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JNI_DIR="$ROOT/android/src/main/jniLibs"
FEATURES="${FEATURES:-dfn,ffi,android}"

echo "Building denoise-voice-core .so libs → $JNI_DIR (features: $FEATURES)"
cd "$ROOT/rust-core"
cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 \
  -o "$JNI_DIR" build --release --features "$FEATURES"

echo "Assembling AAR…"
cd "$ROOT/android"
if [ -x ./gradlew ]; then
  ./gradlew --no-daemon assembleRelease
else
  gradle --no-daemon assembleRelease
fi

echo "AAR: $ROOT/android/build/outputs/aar/"
