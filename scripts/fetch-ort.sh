#!/bin/sh
# Fetch the pinned onnxruntime-web WASM runtime into src/vendor/ort/.
# Needed because extension CSP (script-src 'self') blocks the CDN default.
# Run once after cloning: bun run setup
set -eu
VER="1.31.0-dev.20260914-8d85527a0"
BASE="https://cdn.jsdelivr.net/npm/onnxruntime-web@${VER}/dist"
OUT="src/vendor/ort"
mkdir -p "$OUT"
curl -sL -o "$OUT/ort-wasm-simd-threaded.asyncify.mjs" "$BASE/ort-wasm-simd-threaded.asyncify.mjs"
curl -sL -o "$OUT/ort-wasm-simd-threaded.asyncify.wasm" "$BASE/ort-wasm-simd-threaded.asyncify.wasm"
ls -la "$OUT"
