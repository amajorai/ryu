#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LIB_NAME="libryu_sdk_uniffi.dylib"
LIB_PATH="$REPO_ROOT/target/release/$LIB_NAME"

cargo build --release --manifest-path "$REPO_ROOT/crates/sdk/uniffi/Cargo.toml"
mkdir -p "$SCRIPT_DIR/Sources/RyuSdk" "$SCRIPT_DIR/Sources/RyuSdkFFI"
cargo run --release --manifest-path "$REPO_ROOT/crates/sdk/uniffi/Cargo.toml" --bin uniffi-bindgen -- \
  generate --library "$LIB_PATH" --language swift --out-dir "$SCRIPT_DIR/Sources/RyuSdk/.generated"
mv "$SCRIPT_DIR/Sources/RyuSdk/.generated/RyuSdk.swift" "$SCRIPT_DIR/Sources/RyuSdk/RyuSdk.swift"
mv "$SCRIPT_DIR/Sources/RyuSdk/.generated/RyuSdkFFI.h" "$SCRIPT_DIR/Sources/RyuSdkFFI/RyuSdkFFI.h"
mv "$SCRIPT_DIR/Sources/RyuSdk/.generated/RyuSdkFFI.modulemap" "$SCRIPT_DIR/Sources/RyuSdkFFI/module.modulemap"
rmdir "$SCRIPT_DIR/Sources/RyuSdk/.generated"

cd "$SCRIPT_DIR"
DYLD_LIBRARY_PATH="$REPO_ROOT/target/release${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}" swift test
DYLD_LIBRARY_PATH="$REPO_ROOT/target/release${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}" swift run ryu-sdk-example
