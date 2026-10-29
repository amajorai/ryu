// Tests for the manifest-seat checks.
//
// These are the half of the gate that has no other coverage: a purity violation
// or a broken case fails loudly on its own, but a manifest problem is SILENT at
// test time and only shows up as a tool that registers and then never works. So
// each check gets a case proving it reports the problem, and one proving a
// correct manifest reports nothing.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	checkBodyDrift,
	checkManifestContract,
	findManifestSeat,
} from "./manifest.mjs";

/** Write a throwaway package directory and return its path. */
function pkg(manifest) {
	const dir = mkdtempSync(join(tmpdir(), "toolsmith-manifest-"));
	mkdirSync(join(dir, "tools"), { recursive: true });
	writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
	return dir;
}

const INLINE_MANIFEST = {
	id: "@demo/pkg",
	version: "1.0.0",
	description: "A demo package.",
	permission_grants: ["tool:execute"],
	runnables: [
		{
			id: "tool-probe",
			name: "probe",
			kind: "tool",
			config: {
				slug: "probe",
				backend: "inline_js",
				description: "Probe a thing and return whether it responded.",
				input_schema: { type: "object", properties: {} },
				code: "return 1;",
			},
		},
	],
};

const ADAPTER_MANIFEST = {
	id: "@demo/pkg",
	version: "1.0.0",
	description: "A demo package.",
	permission_grants: ["tool:execute"],
	provides: [
		{
			capability: "web.search",
			version: "1.0.0",
			tools: {
				"web.search": {
					tool: "provider.tool",
					adapter: { code_file: "adapters/web.search.js" },
				},
			},
		},
	],
};

// ── findManifestSeat ─────────────────────────────────────────────────────────

test("finds an inline_js seat by slug", () => {
	const { seat } = findManifestSeat(
		pkg(INLINE_MANIFEST),
		{ tool: "probe" },
		"inline_tool"
	);
	assert.equal(seat.type, "inline_js");
	assert.equal(seat.config.slug, "probe");
});

test("finds an adapter seat by canonical verb", () => {
	const { seat } = findManifestSeat(
		pkg(ADAPTER_MANIFEST),
		{ tool: "web.search" },
		"adapter"
	);
	assert.equal(seat.type, "adapter");
	assert.equal(seat.binding.adapter.code_file, "adapters/web.search.js");
});

test("finds a turn hook seat by hook id", () => {
	const dir = pkg({
		id: "@demo/pkg",
		version: "1.0.0",
		description: "A demo package.",
		contributes: {
			turn_hooks: [
				{ id: "guard", on: "pre_tool_use", code_file: "hooks/guard.js" },
			],
		},
	});
	const { seat } = findManifestSeat(dir, { tool: "guard" }, "turn_hook");
	assert.equal(seat.type, "turn_hook");
	assert.equal(seat.hook.code_file, "hooks/guard.js");
});

test("a tool the manifest does not declare yields a null seat, not a throw", () => {
	// Null rather than an exception because the CALLER decides what it means: for
	// `verify` it is a hard failure ("a body nothing references never runs"), and
	// the distinction from "no manifest at all" has to survive to that point.
	const { seat } = findManifestSeat(
		pkg(INLINE_MANIFEST),
		{ tool: "absent" },
		"inline_tool"
	);
	assert.equal(seat, null);
});

test("a package with no manifest throws", () => {
	const dir = mkdtempSync(join(tmpdir(), "toolsmith-empty-"));
	assert.throws(
		() => findManifestSeat(dir, { tool: "probe" }, "inline_tool"),
		/has no manifest\.json/
	);
});

// ── checkBodyDrift ───────────────────────────────────────────────────────────

test("an inline body matching the manifest reports no drift", () => {
	const { seat } = findManifestSeat(
		pkg(INLINE_MANIFEST),
		{ tool: "probe" },
		"inline_tool"
	);
	assert.deepEqual(
		checkBodyDrift(
			seat,
			{ tool: "probe", code_file: "tools/probe.js" },
			"return 1;"
		),
		[]
	);
});

test("line-ending-only differences do not report drift", () => {
	const manifest = structuredClone(INLINE_MANIFEST);
	manifest.runnables[0].config.code = "return 1;\n";
	const { seat } = findManifestSeat(
		pkg(manifest),
		{ tool: "probe" },
		"inline_tool"
	);
	assert.deepEqual(
		checkBodyDrift(
			seat,
			{ tool: "probe", code_file: "tools/probe.js" },
			"return 1;\r\n"
		),
		[]
	);
});

test("an edited-but-unsealed body is reported as drift", () => {
	// The whole reason `sync --check` exists: the manifest string is what Core
	// loads, the file is what gets reviewed and tested.
	const { seat } = findManifestSeat(
		pkg(INLINE_MANIFEST),
		{ tool: "probe" },
		"inline_tool"
	);
	const problems = checkBodyDrift(
		seat,
		{ tool: "probe", code_file: "tools/probe.js" },
		"return 2;"
	);
	assert.equal(problems.length, 1);
	assert.match(problems[0], /has drifted from tools\/probe\.js/);
});

test("an adapter pointing at a different file than the cases test is reported", () => {
	const { seat } = findManifestSeat(
		pkg(ADAPTER_MANIFEST),
		{ tool: "web.search" },
		"adapter"
	);
	const problems = checkBodyDrift(
		seat,
		{ tool: "web.search", code_file: "adapters/other.js" },
		"return 1;"
	);
	assert.equal(problems.length, 1);
	assert.match(problems[0], /points at adapters\/web.search\.js/);
});

test("an adapter that inlines `code` is rejected even when the file matches", () => {
	const manifest = structuredClone(ADAPTER_MANIFEST);
	manifest.provides[0].tools["web.search"].adapter.code = "return 1;";
	const { seat } = findManifestSeat(
		pkg(manifest),
		{ tool: "web.search" },
		"adapter"
	);
	const problems = checkBodyDrift(
		seat,
		{ tool: "web.search", code_file: "adapters/web.search.js" },
		"return 1;"
	);
	assert.equal(problems.length, 1);
	assert.match(problems[0], /inlines `code`/);
});

// ── checkManifestContract ────────────────────────────────────────────────────

const inlineSpec = { tool: "probe", code_file: "tools/probe.js" };

function contractFor(manifest, spec = inlineSpec, kind = "inline_tool") {
	const found = findManifestSeat(pkg(manifest), spec, kind);
	return checkManifestContract(found.manifest, spec, kind, found.seat);
}

test("a well-formed inline tool reports no contract problems", () => {
	assert.deepEqual(contractFor(INLINE_MANIFEST), []);
});

test("the deprecated inline_deno backend name still passes the contract", () => {
	// Core loads `inline_deno` as `inline_js`, so a package written before the
	// rename must not be refused here either.
	const manifest = structuredClone(INLINE_MANIFEST);
	manifest.runnables[0].config.backend = "inline_deno";
	assert.deepEqual(contractFor(manifest), []);
});

test("a backend other than inline_js is reported", () => {
	const manifest = structuredClone(INLINE_MANIFEST);
	manifest.runnables[0].config.backend = "http";
	const problems = contractFor(manifest);
	assert.equal(problems.length, 1);
	assert.match(problems[0], /expected 'inline_js'/);
});

test("a missing tool:execute grant is reported", () => {
	// The silent one. Without the grant Core registers the tool, serves it in
	// discovery, and refuses every call — nothing else in the pipeline notices.
	const manifest = structuredClone(INLINE_MANIFEST);
	manifest.permission_grants = [];
	const problems = contractFor(manifest);
	assert.equal(problems.length, 1);
	assert.match(problems[0], /tool:execute/);
});

test("a TODO description is reported for both the package and the tool", () => {
	const manifest = structuredClone(INLINE_MANIFEST);
	manifest.description = "TODO: one line.";
	manifest.runnables[0].config.description = "TODO: what probe does.";
	const problems = contractFor(manifest);
	assert.equal(problems.length, 2);
	assert.ok(problems.every((p) => /description/.test(p)));
});

test("an unscoped plugin id is reported", () => {
	const manifest = structuredClone(INLINE_MANIFEST);
	manifest.id = "pkg";
	const problems = contractFor(manifest);
	assert.match(problems[0], /scoped plugin id/);
});

test("a non-semver version is reported", () => {
	const manifest = structuredClone(INLINE_MANIFEST);
	manifest.version = "1.0";
	const problems = contractFor(manifest);
	assert.match(problems[0], /not semver/);
});

test("a missing input_schema is reported", () => {
	const manifest = structuredClone(INLINE_MANIFEST);
	manifest.runnables[0].config.input_schema = undefined;
	const problems = contractFor(manifest);
	assert.equal(problems.length, 1);
	assert.match(problems[0], /input_schema/);
});

test("an adapter code_file outside hooks|adapters is reported", () => {
	// Mirrors Core's `validate_code_file_path`: exactly `<dir>/<name>.js`, flat,
	// and only those two dirs. A nested or otherwise-rooted path fails at load.
	const problems = contractFor(
		ADAPTER_MANIFEST,
		{ tool: "web.search", code_file: "tools/web.search.js" },
		"adapter"
	);
	assert.equal(problems.length, 1);
	assert.match(problems[0], /must be|is not '<hooks\|adapters>/);
});

test("a nested adapter code_file is reported (the flat-layout rule)", () => {
	const problems = contractFor(
		ADAPTER_MANIFEST,
		{ tool: "web.search", code_file: "adapters/nested/web.search.js" },
		"adapter"
	);
	assert.equal(problems.length, 1);
});

test("code_file names Core rejects are reported (traversal, leading dot, bad chars)", () => {
	// Same rule as Core's `validate_code_file_path` and the SDK's
	// `isValidCodeFilePath`: `a..js` contains `..`, so Core refuses it at install.
	for (const code_file of [
		"adapters/a..js",
		"adapters/..js",
		"adapters/.hidden.js",
		"adapters/x..y.mjs",
		"adapters/web search.js",
		"adapters/web.search.ts",
		"hooks/../guard.js",
	]) {
		const problems = contractFor(
			ADAPTER_MANIFEST,
			{ tool: "web.search", code_file },
			"adapter"
		);
		assert.equal(problems.length, 1, code_file);
		assert.match(problems[0], /is not '<hooks\|adapters>/, code_file);
	}
});

test("well-formed code_file names pass the path rule", () => {
	for (const code_file of [
		"adapters/web.search.js",
		"adapters/web_search-v2.mjs",
		"hooks/guard.js",
	]) {
		const problems = contractFor(
			ADAPTER_MANIFEST,
			{ tool: "web.search", code_file },
			"adapter"
		);
		assert.ok(
			problems.every((p) => !/is not '<hooks\|adapters>/.test(p)),
			`${code_file}: ${problems.join("; ")}`
		);
	}
});

test("an adapter without the tool:execute grant is reported", () => {
	// Same silent failure as an inline tool: the provider is listed in its layer,
	// and Core refuses every verb call routed through the adapter.
	const manifest = structuredClone(ADAPTER_MANIFEST);
	manifest.permission_grants = [];
	const problems = contractFor(
		manifest,
		{ tool: "web.search", code_file: "adapters/web.search.js" },
		"adapter"
	);
	assert.equal(problems.length, 1);
	assert.match(problems[0], /tool:execute/);
});
