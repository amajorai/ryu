# Ryu SDK — Go binding (cgo over the Rust core)

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](../../README.md#repository-layout--licensing)
[![Stack](https://shieldcn.dev/badge/Go-cgo-00ADD8.svg?logo=go&logoColor=white)](../../README.md)

`ryusdk` calls the shared **`ryu-sdk` Rust core** through its C-ABI
(`crates/ryu-sdk-ffi`) using cgo. Go gets the exact same manifest validation,
gateway egress rules, and gateway-mandatory model client as the TypeScript and
(future) Python/Swift/Kotlin bindings — one core, no drift.

> **Status: written but NOT yet compiled/verified.** It was authored in an
> environment without a Go toolchain *or* a cgo C compiler, so it has not been
> built or run. The Rust C-ABI it targets **is** verified (`cargo test -p
> ryu-sdk-ffi`, 4 marshalling tests green). Treat the Go side as needing a first
> `go build` on a machine with Go + a C compiler.

## Build

```bash
# 1. Build the C-ABI core (produces the static/dynamic lib + header).
cargo build --release --manifest-path crates/ryu-sdk-ffi/Cargo.toml

# 2. Build/test the Go package (needs Go >= 1.21 and a cgo C compiler).
cd bindings/go
go build ./...
go test ./...
```

### Platform linking notes

The `#cgo LDFLAGS` in `ryusdk/ryusdk.go` link the static lib from
`crates/ryu-sdk-ffi/target/release`. Caveats:

- **Linux/macOS:** the static `.a` links cleanly with the listed system libs.
- **Windows:** the Rust **msvc** staticlib is a `.lib` that mingw-gcc (the usual
  cgo compiler) cannot consume. Either link the **cdylib** (`ryu_sdk_ffi.dll` +
  its import lib) or build the FFI crate with the **gnu** toolchain
  (`cargo build --target x86_64-pc-windows-gnu -p ryu-sdk-ffi`) so the archive
  format matches cgo. Set `LDFLAGS`/`PATH` accordingly.

## Usage

```go
package main

import (
	"fmt"

	"github.com/amajorai/ryu/bindings/go/ryusdk"
)

func main() {
	// Manifest validation (shared Rust logic).
	if err := ryusdk.ValidatePluginID("io.ryu.example"); err != nil {
		panic(err)
	}

	// Gateway egress rule — direct providers are rejected.
	if err := ryusdk.AssertAllowedEgress("https://api.openai.com"); err != nil {
		fmt.Println("blocked as expected:", err)
	}

	// Gateway-mandatory model client.
	client, err := ryusdk.NewModelClient("gemma4", ryusdk.ResolveGatewayURL(), "")
	if err != nil {
		panic(err)
	}
	defer client.Close()

	reply, err := client.Chat(`[{"role":"user","content":"hello"}]`)
	if err != nil {
		panic(err)
	}
	fmt.Println(reply) // {"content":"...","finish_reason":"...","usage":{...}}
}
```
