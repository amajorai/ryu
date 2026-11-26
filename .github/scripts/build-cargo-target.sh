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
# is not an assertion. Cargo keeps the record in one of two places (old and new
# build directory layout, see assert-feature-set.sh), so both are cleared.
#
# Two files go, not one. `bin-ryu-core.json` is the record the assert reads;
# `bin-ryu-core` beside it is the hash cargo compares to decide whether the unit
# is fresh. With only the JSON gone, cargo (1.95 and 1.100 both, tried on a
# small crate) calls an unchanged unit fresh and writes no new JSON, so the
# assert would find nothing. From 1.100 on it matters more: each feature set has
# its own unit folder, so a restored featureless unit and the featured one sit
# side by side and both can be fresh. Removing the hash as well makes cargo link
# the bin again and write the record for exactly the unit this run built.
release="$dir/target/release"
find "$release/.fingerprint" "$release/build" -path '*fingerprint/*' \
  \( -name bin-ryu-core.json -o -name bin-ryu-core \) -delete 2>/dev/null || true
if [ -n "$features" ]; then
  # WORKAROUND for ort-sys 2.0.0-rc.12 on Windows under cargo >= 1.100.0.
  # `voice-parakeet` and `voice-vad` pull ONNX Runtime through transcribe-rs,
  # which pins `ort = "=2.0.0-rc.12"` with its default `copy-dylibs` feature.
  # That build script takes the third ancestor of OUT_DIR as "the target
  # directory" and links the runtime's DLLs into it and into its `examples` and
  # `deps` folders. Cargo 1.100.0 put OUT_DIR one level deeper
  # (`build/<package>/<hash>/out`, was `build/<package>-<hash>/out`), so the
  # script now lands on `target/release/build`, where those two folders do not
  # exist, and panics at `build/dynamic_link.rs:42` with "The system cannot find
  # the path specified". Only the Windows package ships a DLL (DirectML.dll),
  # which is why Linux and macOS build. Creating the two folders lets the script
  # finish; the links it writes there are unused, and package-binary.sh ships
  # only the executable, as before. ort-sys 2.0.0-rc.14 resolves the directory
  # for both layouts: remove this once transcribe-rs allows ort >= 2.0.0-rc.14.
  mkdir -p "$release/build/examples" "$release/build/deps"
  cargo build --release --manifest-path "$dir/Cargo.toml" --features "$features"
else
  cargo build --release --manifest-path "$dir/Cargo.toml"
fi
