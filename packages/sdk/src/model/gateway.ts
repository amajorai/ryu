/**
 * Gateway configuration + egress enforcement for the Ryu SDK model client.
 *
 * Rust-cored: every function here delegates to the `@ryuhq/sdk-native` addon, so
 * the gateway URL/token resolution and the direct-provider egress blocklist are
 * the exact same implementation (`crates/ryu-sdk/src/gateway.rs`) used by the
 * Go/Python bindings and Core itself — one source of truth, no drift.
 */

import * as native from "@ryuhq/sdk-native";

/** Default base URL for the local Ryu gateway — matches Core's DEFAULT_GATEWAY_URL. */
export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:7981";

/**
 * Resolve the effective gateway base URL.
 *
 * Resolution order (in the Rust core):
 *   1. `RYU_GATEWAY_URL` env var (when non-empty).
 *   2. `DEFAULT_GATEWAY_URL`.
 */
export function resolveGatewayUrl(): string {
	return native.resolveGatewayUrl();
}

/**
 * Resolve the optional gateway bearer token (`RYU_GATEWAY_TOKEN`), or
 * `undefined` when unset/empty.
 */
export function resolveGatewayToken(): string | undefined {
	return native.resolveGatewayToken() ?? undefined;
}

/**
 * Validate that `baseUrl` is an allowed egress target. Throws a descriptive
 * `Error` (from the Rust core) when the URL matches a known direct-provider
 * pattern, enforcing the BYOK-at-the-gateway rule.
 */
export function assertAllowedEgressUrl(baseUrl: string): void {
	native.assertAllowedEgress(baseUrl);
}
