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

command -v uniffi-bindgen-cs >/dev/null 2>&1 || {
  echo "uniffi-bindgen-cs is required; install the version pinned in README.md" >&2
  exit 1
}

cargo build --release --manifest-path "$REPO_ROOT/crates/sdk/uniffi/Cargo.toml"
uniffi-bindgen-cs --library "$LIB_PATH" --out-dir "$SCRIPT_DIR"
cp "$LIB_PATH" "$SCRIPT_DIR/"

cd "$SCRIPT_DIR"
dotnet run --project ryu_sdk.csproj
