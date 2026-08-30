# Ryu SDK — Go binding (cgo over the Rust core)

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](../../README.md#repository-layout--licensing)
[![Stack](https://shieldcn.dev/badge/Go-cgo-00ADD8.svg?logo=go&logoColor=white)](../../README.md)

`ryusdk` calls the shared **`ryu-sdk` Rust core** through its C-ABI
(`crates/sdk/ffi`) using cgo. Go gets the exact same manifest validation,
gateway egress rules, and gateway-mandatory model and embedding clients as the
other bindings — one core, no drift.

The package includes unit tests and a no-network example under `example/`. The
tests require Go plus a cgo C compiler and a release build of the Rust FFI.

## Build

```bash
# 1. Build the C-ABI core (produces the static/dynamic lib + header).
cargo build --release --manifest-path crates/sdk/ffi/Cargo.toml

# 2. Build/test the Go package (needs Go >= 1.21 and a cgo C compiler).
cd bindings/go
go build ./...
go test ./...

# Run the example (it only constructs gateway clients; no model request is sent).
go run ./example
```

### Platform linking notes

The `#cgo LDFLAGS` in `ryusdk/ryusdk.go` link the static lib from the workspace
`target/release`; `test.sh` also adds that directory to the platform's native
library search path because the Rust build emits both static and dynamic forms.
Caveats:

- **Linux/macOS:** the static `.a` links cleanly with the listed system libs.
- **Windows:** the Rust **msvc** staticlib is a `.lib` that mingw-gcc (the usual
  cgo compiler) cannot consume. Either link the **cdylib** (`ryu_sdk_ffi.dll` +
  its import lib) or build the FFI crate with the **gnu** toolchain
  (`cargo build --target x86_64-pc-windows-gnu --manifest-path crates/sdk/ffi/Cargo.toml`) so the archive
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

	// Gateway-mandatory model and embedding clients.
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

	embedder, err := ryusdk.NewEmbeddingClient("nomic-embed-text-v1.5", ryusdk.ResolveGatewayURL(), "")
	if err != nil {
		panic(err)
	}
	defer embedder.Close()
	vectors, err := embedder.Embed(`["hello"]`)
	if err != nil {
		panic(err)
	}
	fmt.Println(vectors)
}
```
