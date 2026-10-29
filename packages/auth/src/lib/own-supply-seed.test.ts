import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isOwnSupplyPool } from "./credit-pools.ts";
import {
	OWN_SUPPLY_SEED,
	OWN_SUPPLY_SEED_POOL_DEFAULTS,
} from "./own-supply-seed.ts";

const routerSource = readFileSync(
	fileURLToPath(
		new URL("../../../../crates/gateway/router/src/lib.rs", import.meta.url)
	),
	"utf8"
);

/** The string literals of one Rust `const NAME: &[...] = &[ ... ];` block. */
function rustConstStrings(name: string): string[] {
	const start = routerSource.indexOf(`pub const ${name}:`);
	if (start < 0) {
		throw new Error(`${name} not found in the router crate`);
	}
	const body = routerSource.slice(start, routerSource.indexOf("];", start));
	const afterType = body.slice(body.indexOf("= &["));
	return [...afterType.matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? "");
}

function triples(values: string[]): [string, string, string][] {
	const out: [string, string, string][] = [];
	for (let index = 0; index + 2 < values.length; index += 3) {
		out.push([
			values[index] ?? "",
			values[index + 1] ?? "",
			values[index + 2] ?? "",
		]);
	}
	return out;
}

describe("own-supply seed", () => {
	it("mirrors the gateway's compiled seed row for row", () => {
		expect(
			OWN_SUPPLY_SEED.map((row) => [row.openrouterId, row.slot, row.upstreamId])
		).toEqual(triples(rustConstStrings("SEED_OWN_SUPPLY_EQUIVALENTS")));
	});

	it("flags exactly the gateway's canary-required rows", () => {
		const required = rustConstStrings("SEED_CANARY_REQUIRED");
		const pairs: string[] = [];
		for (let index = 0; index + 1 < required.length; index += 2) {
			pairs.push(`${required[index]} ${required[index + 1]}`);
		}
		expect(
			OWN_SUPPLY_SEED.filter((row) => row.canaryRequired).map(
				(row) => `${row.slot} ${row.upstreamId}`
			)
		).toEqual(pairs);
	});

	it("uses own-supply slots, lowercase ids, and seed pool defaults", () => {
		for (const row of OWN_SUPPLY_SEED) {
			expect(isOwnSupplyPool(row.slot)).toBe(true);
			expect(row.openrouterId).toBe(row.openrouterId.toLowerCase());
		}
		for (const [pool, id] of Object.entries(OWN_SUPPLY_SEED_POOL_DEFAULTS)) {
			expect(
				OWN_SUPPLY_SEED.some(
					(row) => row.slot === pool && row.openrouterId === id
				)
			).toBe(true);
		}
		expect(
			OWN_SUPPLY_SEED.some(
				(row) => row.openrouterId === "anthropic/claude-3.5-sonnet"
			)
		).toBe(false);
	});
});
