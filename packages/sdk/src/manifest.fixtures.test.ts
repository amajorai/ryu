/**
 * Validation coverage for every checked-in Plugin manifest fixture.
 *
 * The authoritative loader for these `plugin.json` files is Core's Rust
 * `PluginManifestLoader` (`apps/core/src/plugin_manifest/`). This suite is the
 * TypeScript-side guard: it walks the on-disk fixtures Core ships and asserts the
 * properties the SDK layer is responsible for keeping in lockstep with Rust —
 *
 *   1. every fixture is well-formed (JSON, non-empty id, valid semver, known
 *      runnable kinds, non-impersonating companion labels, valid surface targets);
 *   2. every turn-hook `on` names a real Core hook phase (the `ON_*` constants in
 *      `apps/core/src/plugin_host/mod.rs`);
 *   3. every `match.tools` gate is a well-formed tiny-glob (the shape Core's
 *      `glob_match` treats as a leading/trailing wildcard rather than a literal);
 *   4. the 55 fixtures whose runnables use only SDK-known kinds parse cleanly
 *      through `PluginManifestSchema`.
 *
 * The fixture set is read from Core's tree so a new shipped plugin is covered the
 * moment it lands, without touching this file.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	labelImpersonatesSystemChrome,
	PluginManifestSchema,
	SurfaceSchema,
} from "./manifest.ts";

// ── Fixture discovery ─────────────────────────────────────────────────────────
//
// Resolve from this file's dir (packages/sdk/src → repo root) so the suite reads
// the same set whether `bun test` is invoked from the package or the repo root.
const FIXTURES_DIR = join(
	import.meta.dir,
	"../../../apps/core/src/plugin_manifest/fixtures"
);

interface RawManifest {
	companion?: { label?: unknown };
	contributes?: {
		turn_hooks?: Array<{ on?: unknown; match?: { tools?: unknown[] } }>;
	};
	id?: unknown;
	name?: unknown;
	runnables?: Array<{ kind?: unknown; id?: unknown; name?: unknown }>;
	targets?: unknown[];
	version?: unknown;
}

function loadFixtures(): Array<{ file: string; manifest: RawManifest }> {
	const files = readdirSync(FIXTURES_DIR).filter((f) =>
		f.endsWith(".plugin.json")
	);
	return files.map((file) => ({
		file,
		manifest: JSON.parse(
			readFileSync(join(FIXTURES_DIR, file), "utf8")
		) as RawManifest,
	}));
}

const FIXTURES = loadFixtures();

// ── Authoritative vocabularies (mirror the Rust source of truth) ──────────────

/**
 * Every `RunnableKind` Core defines
 * (`crates/core/kernel-contracts/src/runnable.rs`). Note this is a SUPERSET of the
 * SDK's `RunnableKindSchema` (which omits `channel`/`engine`/`policy`) — the SDK
 * models only the subset a third-party author can pack today.
 */
const CORE_RUNNABLE_KINDS = new Set([
	"agent",
	"workflow",
	"tool",
	"skill",
	"companion",
	"channel",
	"engine",
	"policy",
]);

/** Kinds the SDK's `PluginManifestSchema` can round-trip. */
const SDK_KNOWN_KINDS = new Set([
	"agent",
	"workflow",
	"tool",
	"skill",
	"companion",
]);

/**
 * Every valid turn-hook phase — the `ON_*` string constants in
 * `apps/core/src/plugin_host/mod.rs`. A hook whose `on` is not one of these is
 * dead: `phase_matches` never fires it (the sole exception, `stop`, is itself in
 * the set and is also treated as `post_assistant_turn`).
 */
const VALID_HOOK_PHASES = new Set([
	"post_assistant_turn",
	"pre_user_turn",
	"session_start",
	"stop",
	"pre_tool_use",
	"post_tool_use",
	"subagent_stop",
	"session_end",
	"notification",
]);

/** SDK schema default for an omitted `on` (mirrors `TurnHookContributionSchema`). */
const DEFAULT_HOOK_PHASE = "post_assistant_turn";

// Semver mirror of the regex in `PluginManifestSchema` — duplicated here so the
// fixture check does not depend on a full schema parse (engine/policy fixtures
// cannot parse, yet still must carry a valid version).
const SEMVER = /^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/;

// ── glob_match oracle (ported verbatim from Core) ─────────────────────────────
//
// `apps/core/src/plugin_host/mod.rs::glob_match`. Ported so the fixture gate
// check and its unit cases test the *same* semantics Core enforces. Crucially
// there is NO compile/parse step in Core: a pattern with interior `*` (e.g.
// "a*b") is not an error — it silently falls through to an exact-literal match.
function globMatch(pattern: string, name: string): boolean {
	if (pattern === "*") {
		return true;
	}
	const leading = pattern.startsWith("*");
	const trailing = pattern.endsWith("*");
	if (leading && trailing) {
		// both ends starred: substring on the inner (strip one star each side)
		const inner = pattern.slice(1, -1);
		return name.includes(inner);
	}
	if (leading) {
		return name.endsWith(pattern.slice(1));
	}
	if (trailing) {
		return name.startsWith(pattern.slice(0, -1));
	}
	return pattern === name;
}

/**
 * A "well-formed" tool gate for Core's tiny matcher: an optional single leading
 * and/or trailing `*` with a plain literal body (no interior `*`). Anything with
 * an interior star is NOT rejected by Core — it just degrades to a literal match
 * that can never fire — so this is a lint, not a hard schema rule.
 */
function isWellFormedToolGlob(pattern: string): boolean {
	if (pattern === "*") {
		return true;
	}
	const body = pattern.replace(/^\*/, "").replace(/\*$/, "");
	return !body.includes("*");
}

// ── Suite sanity ──────────────────────────────────────────────────────────────

describe("fixture discovery", () => {
	it("finds the full shipped set (guards against a broken path)", () => {
		// A wrong FIXTURES_DIR would read zero files and every downstream test
		// would vacuously pass; assert a floor well below the current count (62).
		expect(FIXTURES.length).toBeGreaterThan(50);
	});
});

// ── 1. Every fixture is well-formed ───────────────────────────────────────────

describe("every fixture is well-formed", () => {
	for (const { file, manifest } of FIXTURES) {
		it(`${file}: has a non-empty id and name`, () => {
			expect(typeof manifest.id).toBe("string");
			expect((manifest.id as string).length).toBeGreaterThan(0);
			expect(typeof manifest.name).toBe("string");
			expect((manifest.name as string).length).toBeGreaterThan(0);
		});

		it(`${file}: version is valid semver`, () => {
			expect(manifest.version).toMatch(SEMVER);
		});

		it(`${file}: every runnable kind is a known Core RunnableKind`, () => {
			for (const r of manifest.runnables ?? []) {
				expect(CORE_RUNNABLE_KINDS.has(r.kind as string)).toBe(true);
				expect(typeof r.id).toBe("string");
				expect((r.id as string).length).toBeGreaterThan(0);
				expect(typeof r.name).toBe("string");
			}
		});

		it(`${file}: companion label does not impersonate system chrome`, () => {
			const label = manifest.companion?.label;
			if (typeof label === "string") {
				expect(labelImpersonatesSystemChrome(label)).toBe(false);
			}
		});

		it(`${file}: every target is a valid Core surface`, () => {
			for (const t of manifest.targets ?? []) {
				expect(SurfaceSchema.safeParse(t).success).toBe(true);
			}
		});
	}
});

// ── 2. Hook phase names ───────────────────────────────────────────────────────

describe("turn-hook phase names are valid Core phases", () => {
	for (const { file, manifest } of FIXTURES) {
		const hooks = manifest.contributes?.turn_hooks ?? [];
		if (hooks.length === 0) {
			continue;
		}
		it(`${file}: every turn_hook.on is a real ON_* phase`, () => {
			for (const hook of hooks) {
				// `on` is optional in the schema; absent means the default phase.
				const phase =
					typeof hook.on === "string" ? hook.on : DEFAULT_HOOK_PHASE;
				expect(VALID_HOOK_PHASES.has(phase)).toBe(true);
			}
		});
	}

	it("collectively exercises more than one distinct phase", () => {
		const seen = new Set<string>();
		for (const { manifest } of FIXTURES) {
			for (const hook of manifest.contributes?.turn_hooks ?? []) {
				seen.add(typeof hook.on === "string" ? hook.on : DEFAULT_HOOK_PHASE);
			}
		}
		// Guards against a matcher that trivially accepts everything: the fixtures
		// really do span several phases (post_assistant_turn, pre_tool_use, …).
		expect(seen.size).toBeGreaterThan(1);
		for (const phase of seen) {
			expect(VALID_HOOK_PHASES.has(phase)).toBe(true);
		}
	});
});

// ── 3. Tool-gate glob patterns ────────────────────────────────────────────────

describe("glob_match oracle (ported from Core)", () => {
	// The exact assertions from Core's `glob_match_supports_wildcards` #[test].
	it("'*' matches anything", () => {
		expect(globMatch("*", "anything")).toBe(true);
	});
	it("a bare literal matches only itself", () => {
		expect(globMatch("bash", "bash")).toBe(true);
		expect(globMatch("bash", "bashx")).toBe(false);
	});
	it("trailing star is a prefix match", () => {
		expect(globMatch("bash*", "bash__run")).toBe(true);
		expect(globMatch("bash*", "sh")).toBe(false);
	});
	it("leading star is a suffix match", () => {
		expect(globMatch("*write", "fs__write")).toBe(true);
		expect(globMatch("*write", "writer")).toBe(false);
	});
	it("double star is a substring match", () => {
		expect(globMatch("*edit*", "editor__do_edit")).toBe(true);
		expect(globMatch("*edit*", "read_only")).toBe(false);
	});
	it("an interior star degrades to an exact-literal match (Core has no compile step)", () => {
		// This is the footgun `isWellFormedToolGlob` lints for: "a*b" never behaves
		// as a wildcard — it matches only the literal string "a*b".
		expect(globMatch("a*b", "axb")).toBe(false);
		expect(globMatch("a*b", "a*b")).toBe(true);
		expect(isWellFormedToolGlob("a*b")).toBe(false);
	});
});

describe("every fixture tool-gate glob is well-formed", () => {
	for (const { file, manifest } of FIXTURES) {
		const patterns: string[] = [];
		for (const hook of manifest.contributes?.turn_hooks ?? []) {
			for (const t of hook.match?.tools ?? []) {
				if (typeof t === "string") {
					patterns.push(t);
				}
			}
		}
		if (patterns.length === 0) {
			continue;
		}
		it(`${file}: gates are leading/trailing-star only (no dead interior star)`, () => {
			for (const p of patterns) {
				expect(p.length).toBeGreaterThan(0);
				expect(isWellFormedToolGlob(p)).toBe(true);
			}
		});
	}
});

// ── 4. SDK-schema parity for the packable subset ──────────────────────────────

describe("SDK PluginManifestSchema parses every SDK-kind fixture", () => {
	const sdkKindFixtures = FIXTURES.filter(({ manifest }) =>
		(manifest.runnables ?? []).every((r) =>
			SDK_KNOWN_KINDS.has(r.kind as string)
		)
	);

	it("covers the bulk of the shipped set", () => {
		// The partition itself is meaningful: most shipped plugins are packable.
		expect(sdkKindFixtures.length).toBeGreaterThan(40);
	});

	for (const { file, manifest } of sdkKindFixtures) {
		it(`${file}: parses cleanly through PluginManifestSchema`, () => {
			const result = PluginManifestSchema.safeParse(manifest);
			if (!result.success) {
				throw new Error(
					`${file} failed SDK schema parse: ${JSON.stringify(
						result.error.issues.slice(0, 5),
						null,
						2
					)}`
				);
			}
			expect(result.success).toBe(true);
		});
	}
});

describe("Core-only-kind fixtures are outside the SDK schema (documented divergence)", () => {
	// engine/policy/channel are real Core RunnableKinds the SDK's zod enum omits by
	// design. Pinning this keeps the divergence visible: when the SDK grows these
	// kinds, this expectation flips and the test tells you to update the schema
	// mirror. It documents CURRENT behavior, it does not endorse it.
	const coreOnly = FIXTURES.filter(({ manifest }) =>
		(manifest.runnables ?? []).some(
			(r) => !SDK_KNOWN_KINDS.has(r.kind as string)
		)
	);

	it("exist and every one is rejected by the SDK schema", () => {
		expect(coreOnly.length).toBeGreaterThan(0);
		for (const { manifest } of coreOnly) {
			expect(PluginManifestSchema.safeParse(manifest).success).toBe(false);
		}
	});
});

// ── Regression: SDK schema must preserve turn-hook `match` gates ────────────────

describe("PluginManifestSchema preserves turn_hook.match", () => {
	// `ryu pack` / `ryu publish` persist `safeParse(...).data`, so any field
	// missing from `TurnHookContributionSchema` is silently stripped before
	// signing. That once dropped `match` entirely: an SDK-authored `pre_tool_use`
	// hook gating to specific tools (e.g. `["bash*"]`) lost its gate and ran on
	// EVERY tool call. Same failure class as widgets/requires/targets. This test
	// pins the fix — the gate must survive the parse the CLI applies.
	it("tool-firewall's match:{tools:['*']} survives the parse", () => {
		const raw = JSON.parse(
			readFileSync(join(FIXTURES_DIR, "tool-firewall.plugin.json"), "utf8")
		);
		expect(raw.contributes.turn_hooks[0].match).toEqual({ tools: ["*"] });

		const parsed = PluginManifestSchema.safeParse(raw);
		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			return;
		}
		const hook = parsed.data.contributes?.turn_hooks[0] as {
			match?: { tools: string[] };
		};
		expect(hook.match?.tools).toEqual(["*"]);
	});

	it("a hook without match stays gateless (field remains absent)", () => {
		const parsed = PluginManifestSchema.safeParse({
			id: "com.example.hooks",
			name: "Hooks",
			version: "1.0.0",
			contributes: {
				turn_hooks: [{ id: "h1", code: "return { action: 'none' };" }],
			},
		});
		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			return;
		}
		const hook = parsed.data.contributes?.turn_hooks[0] as {
			match?: unknown;
		};
		expect(hook.match).toBeUndefined();
	});
});
