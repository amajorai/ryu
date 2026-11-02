#!/usr/bin/env bash
# .github/scripts/build-cargo-target.sh
#
# `cargo build --release` of one standalone manifest, with its shipped feature
# set. Shared by the hub's release, canary and nightly `build` jobs.
#
# Environment: TARGET_DIR (the matrix row's `dir`, e.g. apps/core) and FEATURES
# (the row's comma-separated `features`; empty for rows that declare none).
#
# Core MUST carry its three shipped-but-not-default features.
# `sandbox-wasmtime`, `voice-parakeet` and `voice-vad` are off in
# `[features] default` so `cargo test`/`cargo check` stay lean (no
# wasmtime/cranelift, no ONNX Runtime). Off in `default` does NOT mean off in the
# product: this step used to run a bare `cargo build --release`, so every
# `ryu-core` these workflows ever published shipped with NO WASM sandbox
# (`detect_backend("wasmtime")` returns the compile-time feature, so it was
# false), NO parakeet STT inference (silently degrading to whisper) and NO Silero
# VAD. Core's updater has real channel support (`apps/core/src/update/mod.rs`),
# so a node on any channel installs what these jobs produce.
#
# The flag lives on the matrix row because `ryu-gateway` declares none of these
# features and `--features` on it would be a hard error. Every build site that
# produces a ryu-core a human runs is enumerated in `apps/core/Cargo.toml` just
# above the `sandbox-wasmtime` declaration; adding a feature there means adding
# it to that list and to every site.
#
# The opus codec needs no system library here: opus 0.4 builds its bundled
# libopus from source through `opusic-sys` (CMake >= 3.16) and links it
# statically.
set -euo pipefail

dir="${TARGET_DIR:?TARGET_DIR is required}"
features="${FEATURES-}"
# Swatinem/rust-cache restores `target/`, so a fingerprint written by an earlier
# (possibly featureless) run can survive into this one. Drop the ryu-core bin
# fingerprint first: cargo re-links that single unit and writes a fresh record,
# which is what assert-feature-set.sh grades. Without this the assert could pass
# on a stale artifact, and an assertion that might be reading last week's build
# is not an assertion.
find "$dir/target/release/.fingerprint" -name bin-ryu-core.json -delete 2>/dev/null || true
if [ -n "$features" ]; then
  cargo build --release --manifest-path "$dir/Cargo.toml" --features "$features"
else
  cargo build --release --manifest-path "$dir/Cargo.toml"
fi
