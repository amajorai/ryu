#!/usr/bin/env bash
# Rebuild the JavaScript sandbox guest (QuickJS via Javy, compiled to WebAssembly)
# that ryu-tool-exec embeds and runs inside Wasmtime.
#
# Output: crates/core/tool-exec/assets/ryu_js_guest.wasm plus its
# ryu_js_guest.wasm.sha256 (both committed; the host crate embeds the blob with
# include_bytes!, so ordinary Core builds need no WASI toolchain, and a test pins
# it to the recorded hash). The blob lives in assets/, not guest/, because guest/
# is a nested Cargo package and `cargo package` leaves those out of the .crate.
#
# The toolchain below is not pinned, so the output is not byte-for-byte
# reproducible across machines; commit the source change, the blob and the hash
# together and review the source diff.
#
# Toolchain, in order of preference:
#   1. WASI_SDK=<path to a wasi-sdk install>  (what rquickjs-sys downloads by default)
#   2. a system clang with the wasm32 target plus a WASI sysroot
#      (Debian/Ubuntu: apt install clang wasi-libc libclang-rt-dev-wasm32)
#
# Usage:  tools/build-js-guest.sh
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
GUEST="$ROOT/crates/core/tool-exec/guest"
ASSETS="$ROOT/crates/core/tool-exec/assets"
TARGET=wasm32-wasip1

rustup target add "$TARGET" >/dev/null

if [[ -z "${WASI_SDK:-}" ]]; then
	clang_bin="$(command -v clang || true)"
	sysroot_include=/usr/include/wasm32-wasi
	if [[ -z "$clang_bin" || ! -d "$sysroot_include" ]]; then
		echo "error: set WASI_SDK, or install clang + a WASI sysroot (see header)" >&2
		exit 1
	fi
	resource_dir="$("$clang_bin" -print-resource-dir)"
	shim_dir="$(mktemp -d)"
	trap 'rm -rf "$shim_dir"' EXIT
	# Distro sysroots are laid out for the `wasm32-wasi` triple; rustc's cc
	# invocation asks for `wasm32-wasip1`.
	cat >"$shim_dir/clang" <<EOF
#!/bin/sh
for arg in "\$@"; do
	case "\$arg" in --target=wasm32-wasip1) arg=--target=wasm32-wasi ;; esac
	set -- "\$@" "\$arg"; shift
done
exec "$clang_bin" "\$@"
EOF
	chmod +x "$shim_dir/clang"
	export RQUICKJS_SYS_NO_WASI_SDK=1
	export CC_wasm32_wasip1="$shim_dir/clang"
	export AR_wasm32_wasip1="$(command -v llvm-ar || ls /usr/bin/llvm-ar-* | sort -V | tail -1)"
	export BINDGEN_EXTRA_CLANG_ARGS_wasm32_wasip1="--target=wasm32-wasi -nostdinc -isystem $resource_dir/include -isystem $sysroot_include"
fi

cargo build --manifest-path "$GUEST/Cargo.toml" --release --target "$TARGET"
mkdir -p "$ASSETS"
cp "$GUEST/target/$TARGET/release/ryu-js-guest.wasm" "$ASSETS/ryu_js_guest.wasm"
if command -v sha256sum >/dev/null 2>&1; then
	(cd "$ASSETS" && sha256sum ryu_js_guest.wasm >ryu_js_guest.wasm.sha256)
else
	(cd "$ASSETS" && shasum -a 256 ryu_js_guest.wasm >ryu_js_guest.wasm.sha256)
fi
echo "wrote $ASSETS/ryu_js_guest.wasm ($(wc -c <"$ASSETS/ryu_js_guest.wasm") bytes)"
echo "wrote $ASSETS/ryu_js_guest.wasm.sha256"
