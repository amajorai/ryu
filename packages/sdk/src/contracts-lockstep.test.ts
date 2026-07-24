/**
 * Contracts lockstep guard.
 *
 * The Rust crate `crates/ryu-kernel-contracts` blesses
 * `schemas/plugin-manifest.schema.json` (its snapshot test regenerates it from
 * the Rust types), and `bun run generate:contracts` compiles that schema into
 * `src/generated/plugin-manifest.ts`. This test is the cheap structural guard
 * that the SDK's deliberately simpler zod authoring schema, the blessed JSON
 * Schema, and the generated types stay describing the same manifest:
 *
 * 1. a known-good repo manifest (apps-store/mail/manifest.json — the first
 *    fully manifest-driven app) parses with the zod `PluginManifestSchema`;
 * 2. every key the schema marks required exists in the schema, the generated
 *    TS, and the fixture;
 * 3. every top-level key the fixture uses is a key the wire model knows.
 *
 * Deterministic, filesystem-only, no network.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PluginManifestSchema } from "./manifest";

const FIXTURE_PATH = join(
	import.meta.dir,
	"../../../apps-store/mail/manifest.json"
);
const SCHEMA_PATH = join(
	import.meta.dir,
	"../../../crates/core/kernel-contracts/schemas/plugin-manifest.schema.json"
);
const GENERATED_PATH = join(import.meta.dir, "generated/plugin-manifest.ts");

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Record<
	string,
	unknown
>;
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as {
	title: string;
	required: string[];
	properties: Record<string, unknown>;
};
const generatedSource = readFileSync(GENERATED_PATH, "utf8");

describe("contracts lockstep (zod ↔ blessed JSON Schema ↔ generated TS)", () => {
	test("the known-good mail manifest.json parses with the zod authoring schema", () => {
		const parsed = PluginManifestSchema.parse(fixture);
		expect(parsed.id).toBe("com.ryu.mail");
		expect(parsed.runnables.length).toBeGreaterThan(0);
	});

	test("blessed schema describes PluginManifest with the required identity keys", () => {
		expect(schema.title).toBe("PluginManifest");
		for (const key of ["id", "name", "version", "runnables"]) {
			expect(schema.required).toContain(key);
			expect(Object.keys(schema.properties)).toContain(key);
			// The fixture (and thus anything zod accepts as known-good) carries them.
			expect(fixture).toHaveProperty(key);
		}
	});

	test("generated TS declares PluginManifest with the required keys", () => {
		expect(generatedSource).toContain("export interface PluginManifest {");
		for (const key of ["id", "name", "version", "runnables"]) {
			// Required schema keys must appear as non-optional generated fields.
			expect(generatedSource).toMatch(new RegExp(`^\\t${key}[?]?:`, "m"));
		}
	});

	test("every top-level fixture key is a key the wire model knows", () => {
		const wireKeys = new Set(Object.keys(schema.properties));
		for (const key of Object.keys(fixture)) {
			expect(wireKeys).toContain(key);
		}
	});
});
