// Tests for the static determinism scan.
//
// Each rule gets a case that proves the scan FAILS on the bad input, not merely
// that it passes on the good one: a denylist that silently stops matching turns
// "unchecked" into "certified", which is the exact failure this whole pipeline
// exists to prevent.

import assert from "node:assert/strict";
import test from "node:test";

import { scanPurity } from "./purity.mjs";

// ── purity scan ──────────────────────────────────────────────────────────────

test("purity scan accepts a pure body", () => {
	const violations = scanPurity("return { n: input.a + input.b };");
	assert.deepEqual(violations, []);
});

test("purity scan rejects every ambient nondeterminism source", () => {
	const bad = [
		["return Date.now();", "Date.now()"],
		["return new Date();", "new Date() with no argument"],
		["return Math.random();", "Math.random()"],
		["return crypto.randomUUID();", "crypto randomness"],
		["return performance.now();", "performance.now()"],
		["return await fetch('https://x');", "fetch()"],
		["return process.env.HOME;", "process.env"],
		["setTimeout(() => {}, 1); return 1;", "timers"],
		["return globalThis.x;", "globalThis"],
		["return eval('1');", "eval()"],
		["return new Function('return 1')();", "new Function()"],
		["return require('fs');", "require()"],
		["import x from 'y';\nreturn 1;", "import statement"],
		["export const x = 1;\nreturn 1;", "export statement"],
		["return childProcess.run('ls');", "the childProcess global"],
	];
	for (const [source, what] of bad) {
		const violations = scanPurity(source);
		assert.ok(
			violations.some((v) => v.what === what),
			`scanPurity did not flag ${what} in: ${source}`
		);
	}
});

test("purity scan ignores denied tokens inside comments and strings", () => {
	// The scan blanks non-code before matching, so prose about the rule does not
	// trip the rule. Without this, every template header comment in this repo —
	// which names Date.now() precisely to warn about it — would fail its own gate.
	const source = [
		"// never call Math.random() here",
		'const note = "Date.now() is banned";',
		"/* fetch( is fine in a block comment */",
		"return { note };",
	].join("\n");
	assert.deepEqual(scanPurity(source), []);
});

test("purity scan reports line and column of each violation", () => {
	const source = "const a = 1;\nreturn Date.now();";
	const [violation] = scanPurity(source);
	assert.equal(violation.line, 2);
	assert.equal(violation.what, "Date.now()");
	assert.equal(violation.source, "return Date.now();");
});
