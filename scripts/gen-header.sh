#!/usr/bin/env bash
# Generate the C header for the iOS FFI surface from rust-core.
# cbindgen parses source directly (not compiled output), so it reads ffi.rs
# even though it is cfg-gated behind feature = "ffi"; no --features flag is
# needed.  The [export] include = ["DvcHandle"] in cbindgen.toml ensures the
# opaque struct is emitted even when it would otherwise be filtered.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/ios/Sources/DenoiseVoiceCoreFFI/include/denoise_voice_core.h"

mkdir -p "$(dirname "$OUT")"

cd "$ROOT/rust-core"
cbindgen --config cbindgen.toml --output "$OUT"
echo "Wrote $OUT"
