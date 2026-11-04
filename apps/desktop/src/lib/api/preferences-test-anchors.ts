import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rustModuleSource } from "./rust-module-source.ts";

// src/lib/api → src/lib → src → apps/desktop → apps → repo root.
export const REPO_ROOT = join(import.meta.dir, "../../../../..");

export function rustSource(relative: string): string {
	const path = join(REPO_ROOT, relative);
	try {
		return readFileSync(path, "utf8");
	} catch (e) {
		throw new Error(
			`mirror test cannot read ${relative} (resolved ${path}): ${e instanceof Error ? e.message : e}`
		);
	}
}

/** Read `const NAME: &str = "value";` (with or without `pub`), or throw. */
export function rustStrConst(
	source: string,
	file: string,
	name: string
): string {
	const re = new RegExp(
		`(?:pub\\s+)?const\\s+${name}\\s*:\\s*&str\\s*=\\s*"([^"]+)"`
	);
	const found = source.match(re);
	if (!found?.[1]) {
		throw new Error(`mirror test anchor missing: ${name} in ${file}`);
	}
	return found[1];
}

/** Read `const NAME: usize = 123;` (with or without `pub`), or throw. */
export function rustUsizeConst(
	source: string,
	file: string,
	name: string
): number {
	const re = new RegExp(
		`(?:pub\\s+)?const\\s+${name}\\s*:\\s*usize\\s*=\\s*([0-9_]+)`
	);
	const found = source.match(re);
	if (!found?.[1]) {
		throw new Error(`mirror test anchor missing: ${name} in ${file}`);
	}
	return Number.parseInt(found[1].replaceAll("_", ""), 10);
}

/**
 * Extract the body of one Rust item (a `fn`, an `impl` method, a `match` arm's
 * enclosing block) by its header line, brace-matched so a method inside an
 * `impl` yields the method and not the rest of the `impl`.
 *
 * Throws — never returns `""` — when the header is absent. That is the whole
 * point: an anchor whose host function was renamed must read as "this mirror
 * lost its target, go look at this test", not as a silent `false`.
 *
 * Brace counting is naive (it does not skip braces inside string or char
 * literals). Sufficient here and checked: every item anchored below contains no
 * brace-bearing literal. A future anchor that does will over-run its item and
 * the test that uses it will fail loudly rather than pass wrongly.
 */
export function rustItemBody(
	source: string,
	file: string,
	header: string
): string {
	const start = source.indexOf(header);
	if (start < 0) {
		throw new Error(
			`mirror test anchor lost its target: \`${header}\` is no longer in ${file}. ` +
				"The mirror in apps/desktop/src/lib/api/preferences.ts claims to reproduce " +
				"that item's parse; re-point this anchor (apps/desktop/src/lib/api/preferences.test.ts) " +
				"and re-check the mirror against whatever replaced it."
		);
	}
	const open = source.indexOf("{", start);
	if (open < 0) {
		throw new Error(`mirror test found \`${header}\` in ${file} but no body`);
	}
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		if (source[i] === "{") {
			depth++;
		} else if (source[i] === "}") {
			depth--;
			if (depth === 0) {
				return source.slice(open, i + 1);
			}
		}
	}
	throw new Error(
		`mirror test found \`${header}\` in ${file} but its body never closes`
	);
}

/** Collapse every whitespace run to one space, so formatting is not the claim. */
export const squeeze = (s: string): string => s.replaceAll(/\s+/g, " ").trim();

/** The mirror under test; named in every anchor diagnostic. */
export const PREFERENCES_TS = "apps/desktop/src/lib/api/preferences.ts";

/** What {@link rustAnchor} returns when the expression is still there. */
export const ANCHOR_PRESENT = "present";

/**
 * Probe a named Rust item for the expression a TS mirror reproduces,
 * whitespace-insensitively. Returns {@link ANCHOR_PRESENT}, or a diagnostic
 * naming the file, the item and the expression.
 *
 * A probe rather than an assertion helper on purpose (twice over): Biome's
 * `noMisplacedAssertion` rejects an `expect` outside an `it`, and returning the
 * diagnostic means the FAILURE LINE carries it — the person who breaks this is a
 * Core author who has never opened this file and needs to know what to do
 * without reading it.
 */
export function rustAnchor(
	source: string,
	file: string,
	header: string,
	anchor: string
): string {
	const body = rustItemBody(source, file, header);
	return squeeze(body).includes(squeeze(anchor))
		? ANCHOR_PRESENT
		: `MISSING from ${file} :: ${header} — the TS mirror in ${PREFERENCES_TS} claims Core still does: ${anchor}`;
}

export const SERVER_RS =
	"apps/core/src/server (mod.rs and its spliced submodules)";
export const PRIVACY_RS = "apps/core/src/privacy.rs";
export const GATEWAY_RS = "apps/core/src/sidecar/gateway.rs";
export const CONTEXT_WINDOW_RS =
	"apps/core/src/sidecar/adapters/context_window.rs";
// The ranker pref belongs to the extracted tool-registry crate, not to Core —
// Core's MCP catalog and the skills tool both re-export it from there.
export const TOOL_REGISTRY_RS = "crates/core/tool-registry/src/lib.rs";
export const DIARIZATION_RS = "crates/core/diarization/src/lib.rs";
export const MEETINGS_API_RS = "apps-store/meetings/backend/src/api.rs";
export const DIARIZATION_PIPELINE_PY =
	"apps-store/meetings/sidecar/ryu_diarize/pipeline.py";

/** Owner of BOTH per-agent gates — the egress swap and the MCP tool bridge. */
export const AGENT_ROUTING_RS = "apps/core/src/agent_routing/mod.rs";

export const serverRs = rustModuleSource("apps/core/src/server");
export const gatewayRs = rustSource(GATEWAY_RS);
export const contextWindowRs = rustSource(CONTEXT_WINDOW_RS);
export const toolRegistryRs = rustSource(TOOL_REGISTRY_RS);
export const agentRoutingRs = rustSource(AGENT_ROUTING_RS);
export const diarizationRs = rustSource(DIARIZATION_RS);
export const meetingsApiRs = rustSource(MEETINGS_API_RS);
export const diarizationPipelinePy = rustSource(DIARIZATION_PIPELINE_PY);

export function pythonDiarizationModels(source: string): string[] {
	const declaration = source.match(/SUPPORTED_MODELS\s*=\s*\(([^)]*)\)/);
	if (!declaration?.[1]) {
		throw new Error(
			`model contract anchor missing in ${DIARIZATION_PIPELINE_PY}`
		);
	}
	return [...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/**
 * The body of `pub fn NAME(...) -> ... { … }`, brace-matched, or throw.
 *
 * Needed because the fact under test is a `.unwrap_or(…)` INSIDE a function, not
 * a const — and searching the whole file for `unwrap_or(true)` would pass on any
 * unrelated occurrence, which is how a mirror test dies quietly.
 */
export function rustFnBody(source: string, name: string): string {
	const start = source.search(new RegExp(`(?:pub\\s+)?fn\\s+${name}\\s*\\(`));
	if (start < 0) {
		throw new Error(
			`mirror test anchor missing: fn ${name} in ${AGENT_ROUTING_RS}`
		);
	}
	const open = source.indexOf("{", start);
	if (open < 0) {
		throw new Error(`mirror test anchor malformed: fn ${name} has no body`);
	}
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		if (source[i] === "{") {
			depth += 1;
		} else if (source[i] === "}") {
			depth -= 1;
			if (depth === 0) {
				return source.slice(open, i + 1);
			}
		}
	}
	throw new Error(
		`mirror test anchor malformed: fn ${name} body is unbalanced`
	);
}

// ─── Census: every numeric read in preferences.ts has been audited ───────────
//
// The `+`-parse round fixed the three functions that go through
// `parseRustUsize`. This pins the OTHER half of that audit — the numeric reads
// that deliberately do NOT use it — so the result cannot decay silently when a
// new preference is added.
//
// Verdicts, each checked against the Rust (or TS) that consumes the key:
//
//  - `parseRustUsize`             the shared `str::parse::<usize>()` mirror.
//  - `coerceAutoRecallTopK`       → `resolve_auto_recall_top_k`, usize. Mirrored.
//  - `parseContextBudget`         → `parse_context_budget`, usize. Mirrored.
//  - `coerceContextOutputReserve` → `resolve_context_window`, usize. Mirrored.
//  - `getSupportAccessLocalExpiry`→ `privacy.rs::support_access_local`, which is
//    `s.trim().parse::<i64>()` — a SIGNED parse with bounded integer grammar.
//    Mirrored before conversion to Number; invalid values resolve to zero.
//  - `getAgentAutoRouting`        → a JSON blob, whose `similarity_threshold` is
//    an f64 on the gateway. Not a usize key at all.
//  - `getIslandEdgeOffset`        → NO Rust consumer. The other end is the
//    island's `parseEdgeOffset` (apps/island/src/shared/edge-offset.ts), which is
//    `Number(raw.trim())` + `Number.isFinite` + the same clamp — a TS↔TS mirror
//    that already agrees exactly. Rewriting it as a usize mirror would make the
//    desktop STRICTER than the process that actually reads the key.

// `rustSource` is reused purely as "read a repo file, throw loudly if missing" —
// the name is about its other callers.
export const preferencesTs = rustSource(PREFERENCES_TS);

/**
 * Every numeric coercion call in a TS source, keyed by the function containing
 * it. The argument must start with an identifier or `(` so a `Number.parseInt("5.9")`
 * written inside a doc comment is not counted as a call site.
 */
export function numericCoercionOwners(source: string): string[] {
	const declarations = [
		...source.matchAll(/^(?:export )?(?:async )?function (\w+)/gm),
	].map((m) => ({ at: m.index ?? 0, name: m[1] }));
	const owners = new Set<string>();
	for (const hit of source.matchAll(
		/(?:Number\.parseInt|Number\.parseFloat|Number|parseRustUsize)\(\s*[A-Za-z_(]/g
	)) {
		const at = hit.index ?? 0;
		let owner = "<module scope>";
		for (const declaration of declarations) {
			if (declaration.at >= at) {
				break;
			}
			owner = declaration.name;
		}
		owners.add(owner);
	}
	return [...owners].sort();
}
