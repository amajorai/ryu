#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
case "$(uname -s)" in
  Darwin) LIB_NAME="libryu_sdk_uniffi.dylib" ;;
  MINGW*|MSYS*|CYGWIN*) LIB_NAME="ryu_sdk_uniffi.dll" ;;
  *) LIB_NAME="libryu_sdk_uniffi.so" ;;
esac
LIB_PATH="$REPO_ROOT/target/release/$LIB_NAME"

cargo build --release --manifest-path "$REPO_ROOT/crates/sdk/uniffi/Cargo.toml"
mkdir -p "$SCRIPT_DIR/ryu_sdk"
cargo run --release --manifest-path "$REPO_ROOT/crates/sdk/uniffi/Cargo.toml" --bin uniffi-bindgen -- \
  generate --library "$LIB_PATH" --language python --out-dir "$SCRIPT_DIR/ryu_sdk"
cp "$LIB_PATH" "$SCRIPT_DIR/ryu_sdk/"

cd "$SCRIPT_DIR"
PYTHONPATH=. python3 -m unittest -v test_sdk.py
PYTHONPATH=. python3 smoke_test.py
PYTHONPATH=. python3 example.py
