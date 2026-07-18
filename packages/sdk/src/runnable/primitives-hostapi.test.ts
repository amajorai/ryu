/**
 * Lockstep guard: every SDK primitive that binds to a host-bridge RPC method must
 * name a method that actually exists in the blessed host-API contract, with the
 * SAME grant.
 *
 * `PRIMITIVE_BINDINGS` (`primitives.ts`) is the SDK's mirror of the host↔plugin
 * method vocabulary. The canonical vocabulary now lives in
 * `crates/ryu-kernel-contracts/schemas/host-api.json` (blessed from the Rust
 * table; re-bless with `RYU_REGEN_SCHEMAS=1 cargo test -p ryu-kernel-contracts`).
 * This test pins the `bridge`-transport bindings to that table so a renamed method
 * or a drifted grant is caught here rather than at runtime. `direct` bindings hit
 * Core data-path endpoints (not RPC methods) and `broker` bindings are abstract
 * capabilities with no method yet, so only `bridge` bindings are checked.
 *
 * Deterministic, filesystem-only, no network.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PRIMITIVE_BINDINGS } from "./primitives";

const HOST_API_PATH = join(
	import.meta.dir,
	"../../../../crates/core/kernel-contracts/schemas/host-api.json"
);

interface HostApiMethodEntry {
	capability: string;
	grant: string | null;
	method: string;
	streaming: boolean;
	tsHost: boolean;
}

const contract = JSON.parse(readFileSync(HOST_API_PATH, "utf8")) as {
	version: string;
	methods: HostApiMethodEntry[];
};

const grantByMethod = new Map<string, string | null>(
	contract.methods.map((m) => [m.method, m.grant])
);

describe("PRIMITIVE_BINDINGS lockstep with the blessed host-API contract", () => {
	test("every bridge binding names a method present in the contract", () => {
		for (const [name, binding] of Object.entries(PRIMITIVE_BINDINGS)) {
			if (binding.transport !== "bridge") {
				continue;
			}
			expect(
				grantByMethod.has(binding.method),
				`${name} → method "${binding.method}" missing from host-api.json`
			).toBe(true);
		}
	});

	test("every bridge binding's grant matches the contract's grant for that method", () => {
		for (const [name, binding] of Object.entries(PRIMITIVE_BINDINGS)) {
			if (binding.transport !== "bridge") {
				continue;
			}
			expect(
				grantByMethod.get(binding.method),
				`${name} → grant drift for "${binding.method}"`
			).toBe(binding.grant);
		}
	});

	test("the contract exposes at least one method (sanity)", () => {
		expect(contract.methods.length).toBeGreaterThan(0);
	});
});
