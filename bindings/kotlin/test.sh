#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LIB_NAME="libryu_sdk_uniffi.so"
LIB_PATH="$REPO_ROOT/target/release/$LIB_NAME"

cargo build --release --manifest-path "$REPO_ROOT/crates/sdk/uniffi/Cargo.toml"
mkdir -p "$SCRIPT_DIR/src/main/kotlin"
cargo run --release --manifest-path "$REPO_ROOT/crates/sdk/uniffi/Cargo.toml" --bin uniffi-bindgen -- \
  generate --library "$LIB_PATH" --language kotlin --out-dir "$SCRIPT_DIR/src/main/kotlin"

cd "$SCRIPT_DIR"
gradle --no-daemon test -PryuLibrary="$LIB_PATH"
gradle --no-daemon run -PryuLibrary="$LIB_PATH"
