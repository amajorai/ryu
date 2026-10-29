// Deterministic execution harness for Ryu sandboxed tool bodies.
//
// Core runs a plugin tool body by splicing it into an async IIFE with a fixed set
// of injected bindings and nothing else (see `build_inline_tool_program` and
// `build_capability_adapter_program` in `crates/core/tool-exec/src/lib.rs`). The
// body is a FRAGMENT, not a module: no `export`, a top-level `return` is correct.
// That is exactly why `node --test` cannot simply `import()` one, and why every
// existing `plugins-store/{plugins,lsp,external_plugins}/*/plugin.test.mjs` asserts only on manifest SHAPE and
// never executes a line of the logic it ships.
//
// This module reproduces the splice on the test side so a tool body can actually
// be run, with three properties Core's runtime does not give you for free:
//
//   1. **Injected-only scope.** The body sees exactly the bindings Core injects.
//      Every ambient source of nondeterminism (`Date.now`, `Math.random`,
//      `crypto`, `performance`, `fetch`, `process`, timers) is SHADOWED by a
//      parameter that throws, so reaching for one is a hard, named failure at the
//      moment it happens rather than a flake that shows up in production.
//   2. **Stubbed effects.** `host.*` / `callTool` / `callNamed` are driven from a
//      case fixture and RECORD every call, so a case can pin the outcome (what the
//      tool asked the world to do) and not merely the return value.
//   3. **Double execution.** Every case runs twice against identical stubs and the
//      two results must deep-equal. Anything nondeterministic that slipped past the
//      shadowing — iteration order over a mutated shared object, a cached clock
//      read — fails here instead of at 3am.
//
// The harness is deliberately dependency-free (`node:` builtins only) so a
// generated test keeps the zero-dependency property every co-located plugin test
// in this repo already has.
//
// # On `new AsyncFunction(...)` below
//
// Compiling a string into a function is the whole job here — the thing under test
// IS a source fragment, and Core itself compiles it the same way inside its JS
// sandbox. The
// ordering that makes it tolerable: both `index.mjs verify` and `defineToolTests`
// run `scanPurity` FIRST and refuse to execute anything that trips it, and the
// denylist rejects `import` / `require` / `eval` / `new Function` / `process` /
// `fetch` / `childProcess`. Keep the scan first; never call `runCase` on an unscanned body.
//
// **This is a guardrail, not a sandbox.** The scan is a conservative regex denylist
// over source with comments and strings blanked; it does not model regex literals,
// and a determined author can reach the real globals through channels it does not
// enumerate. The body runs with full Node privileges in this process. So: run the
// harness on tool bodies you or your team wrote and have read. Do NOT point it at
// an untrusted third-party plugin as a vetting step — for that, the thing that
// actually confines the code is Core's JS sandbox, not this file.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
	checkBodyDrift,
	checkManifestContract,
	findManifestSeat,
	normalizeLineEndings,
} from "./manifest.mjs";
import { formatViolations, scanPurity } from "./purity.mjs";

/** Constructor for `async function` — the splice target. */
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;

/**
 * Thrown when a tool body reaches for an ambient nondeterministic global.
 * A distinct class so a case can legitimately assert on it (`expectImpure`).
 */
function storageString(value) {
	try {
		const text = String.prototype.valueOf.call(value);
		return text === value ? text : undefined;
	} catch {
		return undefined;
	}
}

export class ImpureAccessError extends Error {
	constructor(what) {
		super(
			`nondeterministic access: ${what} — a tool body must be a pure function of its injected input`
		);
		this.name = "ImpureAccessError";
	}
}

const denied = (what) => () => {
	throw new ImpureAccessError(what);
};

/**
 * The shadow bindings that make impurity impossible rather than merely discouraged.
 *
 * These are passed as PARAMETERS to the spliced function, so inside the body the
 * name resolves to the shadow and never reaches the real global. `Math` and `Date`
 * are not banned wholesale — `Math.max` and `new Date(1700000000000)` are perfectly
 * pure, and banning them would push authors toward hand-rolled replacements that
 * are worse. Only the impure MEMBERS are poisoned.
 */
function shadowGlobals() {
	// Prototype-chained so every pure member of Math still resolves.
	const PureMath = Object.create(Math, {
		random: { value: denied("Math.random()"), enumerable: false },
	});

	const PureDate = new Proxy(Date, {
		get(target, prop) {
			if (prop === "now") {
				return denied("Date.now()");
			}
			return target[prop];
		},
		construct(target, args) {
			if (args.length === 0) {
				throw new ImpureAccessError("new Date() with no argument");
			}
			return Reflect.construct(target, args);
		},
	});

	const pureCrypto = {
		randomUUID: denied("crypto.randomUUID()"),
		getRandomValues: denied("crypto.getRandomValues()"),
		subtle: new Proxy(
			{},
			{
				get: (_t, prop) => denied(`crypto.subtle.${String(prop)}()`),
			}
		),
	};

	return {
		Math: PureMath,
		Date: PureDate,
		crypto: pureCrypto,
		performance: { now: denied("performance.now()") },
		fetch: denied("fetch() — network must go through host/callTool"),
		process: new Proxy(
			{},
			{ get: (_t, prop) => denied(`process.${String(prop)}`) }
		),
		setTimeout: denied("setTimeout()"),
		setInterval: denied("setInterval()"),
		globalThis: new Proxy(
			{},
			{ get: (_t, prop) => denied(`globalThis.${String(prop)}`) }
		),
		require: denied("require()"),
		childProcess: new Proxy(
			{},
			{ get: (_t, prop) => denied(`childProcess.${String(prop)}`) }
		),
	};
}

/**
 * Structured-clone a value so a stub response handed to the body cannot be
 * mutated in run 1 and observed in run 2 — which would make the double-run check
 * pass on a body that is not actually replayable.
 */
function frozenCopy(value) {
	return value === undefined ? undefined : structuredClone(value);
}

/**
 * Snapshot a recorded call's arguments through JSON.
 *
 * Not `structuredClone`: that PRESERVES an explicitly-`undefined` property, and
 * `deepStrictEqual` treats `{namespace: undefined}` as different from `{}`. A case
 * is written in JSON, where `undefined` cannot be expressed at all — so every
 * `expectCalls` entry for `host.storage.get(key)` would have to spell out a
 * `namespace: undefined` the author never passed. Dropping the key here makes the
 * recording match what a case can actually say.
 */
function recordable(value) {
	const json = JSON.stringify(value);
	return json === undefined ? undefined : JSON.parse(json);
}

/**
 * Build the `host` facade Core injects into an `inline_js` tool, driven from a
 * case's `host` fixture.
 *
 * - `sideModel` / `runAgent` / `reactions.add` (fixture key `reactionsAdd`) read
 *   from a QUEUE (`host.sideModel: [r1, r2]`), so a
 *   body that calls twice gets two different answers and a body that calls more
 *   often than the fixture allows fails loudly instead of silently reusing one.
 * - `storage` is a real in-memory Map seeded from `host.storage`, because a queue
 *   would not model read-after-write and storage round-trips are the single most
 *   common thing a tool body gets wrong.
 * - `log` is captured, never printed — a passing test suite should be quiet.
 */
function buildHost(spec, calls) {
	const queues = new Map();
	for (const key of [
		"sideModel",
		"runAgent",
		"runFanout",
		"workflowScript",
		"workflowRunStatus",
		"reactionsAdd",
	]) {
		const value = spec?.[key];
		queues.set(key, Array.isArray(value) ? [...value] : []);
	}
	const store = new Map(Object.entries(spec?.storage ?? {}));

	const dequeue = (key, args) => {
		const queue = queues.get(key);
		if (queue.length === 0) {
			throw new Error(
				`host.${key} was called with ${JSON.stringify(args)} but the case fixture has no response left for it — add one to "host.${key}"`
			);
		}
		return frozenCopy(queue.shift());
	};

	const record = (path, args) => {
		calls.push({ path, args: recordable(args) });
	};

	const nsKey = (key, namespace) =>
		namespace ? `${namespace}:${String(key)}` : String(key);

	return {
		sideModel: async (args = {}) => {
			record("host.sideModel", args);
			return dequeue("sideModel", args);
		},
		runAgent: async (args = {}) => {
			record("host.runAgent", args);
			return dequeue("runAgent", args);
		},
		runFanout: async (args = {}) => {
			record("host.runFanout", args);
			return dequeue("runFanout", args);
		},
		workflows: {
			script: async (args = {}) => {
				record("host.workflows.script", args);
				return dequeue("workflowScript", args);
			},
			status: async (args = {}) => {
				record("host.workflows.status", args);
				return dequeue("workflowRunStatus", args);
			},
		},
		reactions: {
			add: async (args = {}) => {
				record("host.reactions.add", args);
				return dequeue("reactionsAdd", args);
			},
		},
		storage: {
			get: async (key, namespace) => {
				record("host.storage.get", { key, namespace });
				return frozenCopy(store.get(nsKey(key, namespace)) ?? null);
			},
			set: async (key, value, namespace) => {
				record("host.storage.set", { key, value, namespace });
				store.set(
					nsKey(key, namespace),
					storageString(value) ?? JSON.stringify(value)
				);
				return null;
			},
			delete: async (key, namespace) => {
				record("host.storage.delete", { key, namespace });
				store.delete(nsKey(key, namespace));
				return null;
			},
			keys: async (namespace) => {
				record("host.storage.keys", { namespace });
				// Sorted: Map insertion order would leak the ORDER OF WRITES into the
				// tool's output, which is precisely the kind of accidental input this
				// harness exists to eliminate.
				return [...store.keys()].sort();
			},
		},
		log: (...args) => {
			calls.push({ path: "host.log", args: recordable(args) });
		},
	};
}

/**
 * Build the `callTool` / `callNamed` pair Core injects into a capability adapter.
 *
 * Mirrors the real seam's asymmetry exactly: `callTool` takes NO tool id (the
 * target is fixed by the manifest before the sandbox starts) while `callNamed`
 * takes one and it is checked against the manifest's declared `adapter.tools`
 * allowlist. The harness enforces that allowlist too, so a case cannot pass
 * against a call the real runtime would refuse.
 */
function buildProvider(spec, allowlist, calls) {
	const primary = Array.isArray(spec?.call) ? [...spec.call] : [];
	const named = new Map(
		Object.entries(spec?.named ?? {}).map(([id, list]) => [
			id,
			Array.isArray(list) ? [...list] : [list],
		])
	);

	return {
		callTool: async (args = {}) => {
			calls.push({ path: "callTool", args: recordable(args) });
			if (primary.length === 0) {
				throw new Error(
					`callTool was called with ${JSON.stringify(args)} but the case fixture has no response left for it — add one to "provider.call"`
				);
			}
			return frozenCopy(primary.shift());
		},
		callNamed: async (id, args = {}) => {
			calls.push({ path: `callNamed:${id}`, args: recordable(args) });
			if (allowlist && !allowlist.includes(id)) {
				throw new Error(
					`callNamed("${id}") is not in the manifest's adapter.tools allowlist [${allowlist.join(", ")}] — Core would reject this call host-side`
				);
			}
			const queue = named.get(id);
			if (!queue || queue.length === 0) {
				throw new Error(
					`callNamed("${id}") has no response left in the case fixture — add one to "provider.named.${id}"`
				);
			}
			return frozenCopy(queue.shift());
		},
	};
}

/**
 * Execute a tool body ONCE against a case fixture.
 *
 * `kind` picks the injected signature, matching Core:
 * - `"inline_tool"` → `input`, `caller`, `host`   (`build_inline_tool_program`)
 * - `"adapter"`     → `input`, `defaults`, `callTool`, `callNamed`
 *                     (`build_capability_adapter_program`)
 *
 * Returns `{ value, calls }` or throws whatever the body threw.
 */
export async function runOnce({ kind, code, testCase, adapterTools }) {
	const calls = [];
	const shadows = shadowGlobals();
	const shadowNames = Object.keys(shadows);
	const shadowValues = Object.values(shadows);

	const input = frozenCopy(testCase.input ?? {});

	let bindingNames;
	let bindingValues;
	if (kind === "adapter") {
		const provider = buildProvider(testCase.provider, adapterTools, calls);
		bindingNames = ["input", "defaults", "callTool", "callNamed"];
		bindingValues = [
			input,
			frozenCopy(testCase.defaults ?? {}),
			provider.callTool,
			provider.callNamed,
		];
	} else if (kind === "turn_hook") {
		// Core's `plugin_host::build_hook_program` injects `ctx` instead of `input`
		// and returns a HookDirective. Nine `plugins-store/{plugins,lsp,external_plugins}/*/plugin.test.mjs` files
		// hand-roll this splice today, each with its own ad-hoc host stub and no
		// determinism check; supporting the form here is what lets them converge.
		bindingNames = ["ctx", "host"];
		bindingValues = [
			frozenCopy(testCase.ctx ?? {}),
			buildHost(testCase.host, calls),
		];
	} else {
		// `caller` is host-derived in Core (the dispatching agent + its host
		// conversation), so a case seeds it separately from `input` — writing the
		// same field into `input` must not change it. Absent fixture → the
		// agent-less shape Core injects for workflows/monitors/recipes.
		bindingNames = ["input", "caller", "host"];
		bindingValues = [
			input,
			frozenCopy(testCase.caller ?? { agent_id: null, conversation_id: null }),
			buildHost(testCase.host, calls),
		];
	}

	// The splice. `"use strict"` matters: it turns an accidental implicit global
	// assignment inside the body into a TypeError instead of state that leaks
	// between the two runs of the double-execution check.
	const fn = new AsyncFunction(
		...bindingNames,
		...shadowNames,
		`"use strict";\n${code}`
	);
	const value = await fn(...bindingValues, ...shadowValues);
	return { value, calls };
}

/**
 * Run one case with the full determinism protocol: execute twice against
 * identical fresh stubs, require both runs to agree, then check the assertions
 * the case declared.
 *
 * A case declares exactly one expectation of `expect` / `expectError` /
 * `expectImpure`, and may additionally declare `expectCalls`.
 */
export async function runCase({ kind, code, testCase, adapterTools }) {
	const attempt = async () => {
		try {
			const { value, calls } = await runOnce({
				kind,
				code,
				testCase,
				adapterTools,
			});
			return { value, calls, error: null };
		} catch (err) {
			return { value: undefined, calls: null, error: err };
		}
	};

	const first = await attempt();
	const second = await attempt();

	// Determinism gate, before any expectation: a body whose two runs disagree
	// cannot be meaningfully asserted on at all.
	assert.deepStrictEqual(
		{ value: second.value, error: second.error?.message ?? null },
		{ value: first.value, error: first.error?.message ?? null },
		`case "${testCase.name}" is NOT deterministic — two identical runs produced different results. The body depends on something other than its injected input.`
	);

	const expectations = ["expect", "expectError", "expectImpure"].filter(
		(k) => testCase[k] !== undefined
	);
	assert.equal(
		expectations.length,
		1,
		`case "${testCase.name}" must declare exactly one of expect / expectError / expectImpure (found: ${expectations.join(", ") || "none"})`
	);

	if (testCase.expectImpure !== undefined) {
		assert.ok(
			first.error instanceof ImpureAccessError,
			`case "${testCase.name}" expected the body to be rejected as impure, but it returned ${JSON.stringify(first.value)}`
		);
		assert.match(first.error.message, new RegExp(testCase.expectImpure));
		return;
	}

	if (testCase.expectError !== undefined) {
		assert.ok(
			first.error,
			`case "${testCase.name}" expected an error but the body returned ${JSON.stringify(first.value)}`
		);
		assert.match(first.error.message, new RegExp(testCase.expectError));
		return;
	}

	if (first.error) {
		throw first.error;
	}
	// Compared through the same JSON snapshot as recorded calls: the result leaves
	// Core's sandbox as JSON, so an `undefined`-valued key (e.g. an optional
	// `published` a provider omitted) is absent on the wire and a case — written
	// in JSON — cannot express it any other way.
	assert.deepStrictEqual(recordable(first.value), testCase.expect);

	if (testCase.expectCalls !== undefined) {
		// Outcome, not just output: the exact sequence of effects the tool asked
		// the host/provider to perform. This is the half that catches "returns the
		// right shape while calling the wrong endpoint".
		assert.deepStrictEqual(first.calls, testCase.expectCalls);
	}
}

/**
 * Every case table a package declares, relative to `dir`: `cases.json` for the
 * one-tool package, plus `cases/<tool>.json` for each additional body in a
 * package that ships several (e.g. one adapter per `browser.*` verb). Sorted, so
 * test registration order never depends on directory iteration order.
 */
export function caseFiles(dir) {
	const files = existsSync(join(dir, "cases.json")) ? ["cases.json"] : [];
	const nested = join(dir, "cases");
	if (existsSync(nested)) {
		for (const name of readdirSync(nested).sort()) {
			if (name.endsWith(".json")) {
				files.push(`cases/${name}`);
			}
		}
	}
	return files;
}

/**
 * `defineToolTests` for every case table in a multi-tool package. Fails (rather
 * than passing vacuously) when the package declares none.
 */
export function definePackageToolTests(dir) {
	const files = caseFiles(dir);
	if (files.length === 0) {
		test("package declares at least one case table", () => {
			assert.fail(`${dir} has neither cases.json nor cases/*.json`);
		});
		return;
	}
	for (const file of files) {
		defineToolTests(dir, file);
	}
}

/**
 * Read a tool package's `cases.json` (or `casesFile`, relative to `dir`), resolve
 * the body it names, and register a `node:test` test per case plus the
 * whole-file determinism guards.
 *
 * This is the ONE entry point a generated test calls, which is what keeps a
 * generated test five lines long and therefore worth regenerating.
 */
export function defineToolTests(dir, casesFile = "cases.json") {
	const casesPath = join(dir, casesFile);
	const spec = JSON.parse(readFileSync(casesPath, "utf8"));
	const kind = spec.kind ?? "inline_tool";
	const codePath = join(dir, spec.code_file);
	const code = normalizeLineEndings(readFileSync(codePath, "utf8"));

	test(`${spec.tool}: body is present and non-trivial`, () => {
		assert.ok(existsSync(codePath), `${codePath} is missing`);
		assert.ok(
			code.trim().length > 0,
			"tool body is empty — an empty body returns undefined and would pass a lax case"
		);
		assert.ok(
			/\breturn\b/.test(code),
			"tool body never returns — Core reports the fragment's final value, so a body with no `return` always yields undefined"
		);
	});

	// The purity scan runs HERE, before a single case test is registered, and a
	// violation ABORTS registration. Same ordering the CLI uses and for the same
	// reason: the scan is what clears the body of `import`/`require`/`eval`/
	// `process`/`fetch`, so nothing may execute ahead of it.
	const violations = scanPurity(code);
	if (violations.length > 0) {
		test(`${spec.tool}: body is deterministic`, () => {
			assert.fail(
				`${violations.length} violation(s) — cases were NOT run:\n${formatViolations(codePath, violations)}`
			);
		});
		return;
	}

	// Drift + seat, as tests rather than only as a CLI step. Without these the
	// suite would validate `${spec.code_file}` while Core loads the manifest's
	// sealed `code` string — a green run certifying something that is not what
	// ships. This is the whole reason the checks live in `manifest.mjs`.
	test(`${spec.tool}: manifest seats the body and matches it`, () => {
		const { manifest, seat } = findManifestSeat(dir, spec, kind);
		assert.ok(
			seat,
			`manifest.json does not declare tool '${spec.tool}' — a body nothing references never runs`
		);
		const problems = [
			...checkBodyDrift(seat, spec, code),
			...checkManifestContract(manifest, spec, kind, seat),
		];
		assert.deepStrictEqual(problems, [], problems.join("\n  "));
	});

	test(`${spec.tool}: declares at least three cases`, () => {
		// Not arbitrary: one happy path proves nothing about a tool. The floor is
		// happy + boundary + failure, which is the minimum that distinguishes a
		// working tool from one that only works on the author's example.
		assert.ok(
			Array.isArray(spec.cases) && spec.cases.length >= 3,
			`${spec.tool} declares ${spec.cases?.length ?? 0} cases; at least 3 are required (happy path, edge case, failure)`
		);
	});

	test(`${spec.tool}: case names are unique`, () => {
		const names = spec.cases.map((c) => c.name);
		assert.equal(
			new Set(names).size,
			names.length,
			"two cases share a name — a failure would not say which one broke"
		);
	});

	for (const testCase of spec.cases) {
		test(`${spec.tool}: ${testCase.name}`, async () => {
			await runCase({
				kind,
				code,
				testCase,
				adapterTools: spec.adapter_tools,
			});
		});
	}
}
