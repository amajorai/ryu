// Package ryusdk is the Go binding for the Ryu SDK. It calls the shared
// `ryu-sdk` Rust core through its C-ABI (crates/ryu-sdk-ffi) via cgo, so Go gets
// the exact same manifest validation, gateway egress rules, and
// gateway-mandatory model client as every other binding.
//
// # Build prerequisites
//
//  1. Build the C-ABI core (release):
//     cargo build --release --manifest-path crates/ryu-sdk-ffi/Cargo.toml
//  2. A cgo-compatible C toolchain must be on PATH (gcc/clang; on Windows the
//     Rust staticlib is MSVC-format, so prefer the cdylib import lib or build
//     the FFI crate with the gnu toolchain to match mingw cgo).
//
// The cgo directives below link the static library from the FFI crate's
// `target/release`. Adjust the paths/flags for your platform and link mode
// (static `.a`/`.lib` vs dynamic `.so`/`.dylib`/`.dll`).
package ryusdk

/*
#cgo CFLAGS: -I${SRCDIR}/../../../crates/ryu-sdk-ffi/include
#cgo linux LDFLAGS: -L${SRCDIR}/../../../crates/ryu-sdk-ffi/target/release -lryu_sdk_ffi -lm -ldl -lpthread
#cgo darwin LDFLAGS: -L${SRCDIR}/../../../crates/ryu-sdk-ffi/target/release -lryu_sdk_ffi -framework CoreFoundation -framework Security
#cgo windows LDFLAGS: -L${SRCDIR}/../../../crates/ryu-sdk-ffi/target/release -lryu_sdk_ffi -lws2_32 -luserenv -lbcrypt -lntdll
#include <stdlib.h>
#include "ryu_sdk.h"
*/
import "C"

import (
	"errors"
	"unsafe"
)

// lastError returns the calling thread's last Rust-side error, or nil.
func lastError(fallback string) error {
	cerr := C.ryu_last_error()
	if cerr == nil {
		if fallback == "" {
			return nil
		}
		return errors.New(fallback)
	}
	defer C.ryu_string_free(cerr)
	return errors.New(C.GoString(cerr))
}

// takeString copies an owned C string into Go and frees it.
func takeString(ptr *C.char) string {
	if ptr == nil {
		return ""
	}
	defer C.ryu_string_free(ptr)
	return C.GoString(ptr)
}

// ── Manifest + schema ───────────────────────────────────────────────────────

// ValidatePluginID returns nil if id is a valid (path-traversal-safe,
// reverse-domain) plugin id, or an error describing why not.
func ValidatePluginID(id string) error {
	cid := C.CString(id)
	defer C.free(unsafe.Pointer(cid))
	if C.ryu_validate_plugin_id(cid) != 0 {
		return lastError("invalid plugin id")
	}
	return nil
}

// ParseAndValidateManifest parses and fully validates a plugin.json string,
// returning the normalized manifest JSON.
func ParseAndValidateManifest(manifestJSON string) (string, error) {
	cj := C.CString(manifestJSON)
	defer C.free(unsafe.Pointer(cj))
	out := C.ryu_parse_and_validate_manifest(cj)
	if out == nil {
		return "", lastError("manifest validation failed")
	}
	return takeString(out), nil
}

// PluginManifestJSONSchema returns the JSON Schema for a plugin.json, derived
// from the Rust types (so it never drifts from what the core validates).
func PluginManifestJSONSchema() string {
	return takeString(C.ryu_plugin_manifest_json_schema())
}

// ── Gateway ─────────────────────────────────────────────────────────────────

// ResolveGatewayURL returns the effective gateway base URL (RYU_GATEWAY_URL or
// the built-in default).
func ResolveGatewayURL() string {
	return takeString(C.ryu_resolve_gateway_url())
}

// AssertAllowedEgress returns an error if url points at a blocked direct
// provider (the BYOK-at-the-gateway rule).
func AssertAllowedEgress(url string) error {
	curl := C.CString(url)
	defer C.free(unsafe.Pointer(curl))
	if C.ryu_assert_allowed_egress(curl) != 0 {
		return lastError("egress not allowed")
	}
	return nil
}

// ── Model client ────────────────────────────────────────────────────────────

// ModelClient is a gateway-mandatory chat client. Construct with
// NewModelClient and release with Close.
type ModelClient struct {
	handle *C.RyuModelClientHandle
}

// NewModelClient constructs a client for model. baseURL and token may be empty
// to use the RYU_GATEWAY_URL / RYU_GATEWAY_TOKEN defaults. A direct-provider
// baseURL is rejected.
func NewModelClient(model, baseURL, token string) (*ModelClient, error) {
	cmodel := C.CString(model)
	defer C.free(unsafe.Pointer(cmodel))

	var cbase, ctoken *C.char
	if baseURL != "" {
		cbase = C.CString(baseURL)
		defer C.free(unsafe.Pointer(cbase))
	}
	if token != "" {
		ctoken = C.CString(token)
		defer C.free(unsafe.Pointer(ctoken))
	}

	h := C.ryu_model_client_new(cmodel, cbase, ctoken)
	if h == nil {
		return nil, lastError("failed to construct model client")
	}
	return &ModelClient{handle: h}, nil
}

// Close releases the underlying Rust handle. Safe to call more than once.
func (c *ModelClient) Close() {
	if c.handle != nil {
		C.ryu_model_client_free(c.handle)
		c.handle = nil
	}
}

// Chat sends a blocking, non-streaming chat completion. messagesJSON is a JSON
// array of {"role","content"} objects; the returned string is a JSON object
// {"content","finish_reason","usage"}.
func (c *ModelClient) Chat(messagesJSON string) (string, error) {
	if c.handle == nil {
		return "", errors.New("model client is closed")
	}
	cmsgs := C.CString(messagesJSON)
	defer C.free(unsafe.Pointer(cmsgs))
	out := C.ryu_model_client_chat(c.handle, cmsgs)
	if out == nil {
		return "", lastError("chat failed")
	}
	return takeString(out), nil
}
