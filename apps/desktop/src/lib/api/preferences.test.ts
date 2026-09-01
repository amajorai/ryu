// apps/desktop/src/lib/api/preferences.test.ts
//
// Two kinds of test, both about the same failure mode: a control in Settings
// that writes a value the node does not act on.
//
//  1. MIRROR tests. Every preference key and default below has its real
//     definition in Rust, in this repo. A stale copy here is silent — the UI
//     writes `context.max_tokens`, Core reads `context.max-tokens`, the switch
//     appears to work, and nothing changes. These tests PARSE the Rust sources
//     and compare. Each helper THROWS when its anchor is missing, because an
//     assertion comparing `undefined` to `undefined` is how a guard like this
//     dies quietly (the same doctrine as `gateway.test.ts`).
//
//  2. COERCION tests, over the pure parsers. Core's parsers are strict Rust
//     (`str::parse::<usize>()` rejects "5.9", "5abc", "-1"); JavaScript's
//     `Number.parseInt` accepts all three. Where the TS coercion is looser than
//     the Rust one, the settings UI would show a value the node is silently
//     ignoring. These pin the two to the same contract.
//
//     STRICTER is a bug too, and was one: `str::parse::<usize>()` ACCEPTS a
//     leading `+` (verified with rustc, not from memory), while these mirrors
//     required bare digits. `context.max-tokens=+8000` — set the way the docs
//     tell operators to set it — was honoured by Core and rendered as Off, so
//     the card described a node that wasn't running. Each numeric case below
//     now covers both directions, and each mirror is anchored to the Rust
//     expression it claims to reproduce so a Core-side rewrite fails here.
//
// ── The coupling, stated so nobody has to discover it ────────────────────────
//
// The anchors below read `apps/core/src/server/mod.rs`, which is one of the
// largest and most-edited files in the repo and is NOT owned by whoever owns
// this test. A Core author changing `parse_context_budget` gets a failure in a
// desktop test file they have never opened, so the anchors are built to fail
// only for the right reason and to say what to do when they fail:
//
//  - Every anchor is scoped to a NAMED Rust item via `rustItemBody`, not matched
//    against the whole file. Two functions that both parse a `usize` can no
//    longer satisfy each other's anchor.
//  - `rustItemBody` THROWS, naming this file and the item, when the item is gone
//    — a rename or a move reads as "the mirror lost its target", not as a bare
//    `expected true, got false`.
//  - Comparison is whitespace-normalized (`expectRustAnchor`), so a rustfmt
//    reflow, an added line break or a re-indent cannot break a test whose claim
//    is about the EXPRESSION, not about its formatting.
//
// What is deliberately NOT done: replacing the anchors with pure behaviour
// assertions. `bun test` cannot execute Rust, and a mirror with no anchor is the
// exact hole that let the leading-`+` divergence sit here unnoticed. The
// coupling is real; it is made loud rather than hidden.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	AGENT_GATEWAY_ROUTING_PREF_KEY,
	AGENT_TOOL_BRIDGE_PREF_KEY,
	AUTO_RECALL_DEFAULT_TOP_K,
	AUTO_RECALL_MAX_TOP_K,
	AUTO_RECALL_MIN_TOP_K,
	AUTO_RECALL_TOP_K_PREF_KEY,
	agentLanePreferenceKey,
	CONTEXT_AUTO_COMPACT_PREF_KEY,
	CONTEXT_COMPACT_EFFORT_PREF_KEY,
	CONTEXT_COMPACT_MODEL_PREF_KEY,
	CONTEXT_DEFAULT_OUTPUT_RESERVE,
	CONTEXT_MAX_OUTPUT_PREF_KEY,
	CONTEXT_MAX_OUTPUT_RESERVE,
	CONTEXT_MAX_TOKENS_PREF_KEY,
	CONTEXT_MIN_BUDGET_TOKENS,
	CONTEXT_SKILLS_RESERVE,
	coerceAutoRecallTopK,
	coerceContextOutputReserve,
	coerceToolRanker,
	contextHistoryBudget,
	DEFAULT_AGENT_GATEWAY_ROUTING,
	DEFAULT_AGENT_TOOL_BRIDGE,
	DEFAULT_CLAUDE_GATEWAY_ROUTING,
	DEFAULT_CLOUD_AGENT_SELECTION_PREF_KEY,
	DEFAULT_CODEX_GATEWAY_ROUTING,
	DEFAULT_GATEWAY_ROUTING,
	DEFAULT_LOCAL_AGENT_SELECTION_PREF_KEY,
	defaultCloudAgentSelection,
	defaultLocalAgentSelection,
	EMPTY_AGENT_SELECTION,
	formatContextBudget,
	MANAGED_RYU_MODEL_ID,
	MANAGED_RYU_PROVIDER_ID,
	MAX_ISLAND_EDGE_OFFSET,
	MIN_ISLAND_EDGE_OFFSET,
	NODE_ROUTING_PREF_KEY,
	parseContextBudget,
	parseNodeRoutingPreferences,
	serializeNodeRoutingPreferences,
	TOOL_RANKER_PREF_KEY,
} from "./preferences.ts";

// src/lib/api → src/lib → src → apps/desktop → apps → repo root.
const REPO_ROOT = join(import.meta.dir, "../../../../..");

function rustSource(relative: string): string {
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
function rustStrConst(source: string, file: string, name: string): string {
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
function rustUsizeConst(source: string, file: string, name: string): number {
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
function rustItemBody(source: string, file: string, header: string): string {
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
const squeeze = (s: string): string => s.replaceAll(/\s+/g, " ").trim();

/** The mirror under test; named in every anchor diagnostic. */
const PREFERENCES_TS = "apps/desktop/src/lib/api/preferences.ts";

/** What {@link rustAnchor} returns when the expression is still there. */
const ANCHOR_PRESENT = "present";

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
function rustAnchor(
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

const SERVER_RS = "apps/core/src/server/mod.rs";
const GATEWAY_RS = "apps/core/src/sidecar/gateway.rs";
const CONTEXT_WINDOW_RS = "apps/core/src/sidecar/adapters/context_window.rs";
// The ranker pref belongs to the extracted tool-registry crate, not to Core —
// Core's MCP catalog and the skills tool both re-export it from there.
const TOOL_REGISTRY_RS = "crates/core/tool-registry/src/lib.rs";

/** Owner of BOTH per-agent gates — the egress swap and the MCP tool bridge. */
const AGENT_ROUTING_RS = "apps/core/src/agent_routing/mod.rs";

const serverRs = rustSource(SERVER_RS);
const gatewayRs = rustSource(GATEWAY_RS);
const contextWindowRs = rustSource(CONTEXT_WINDOW_RS);
const toolRegistryRs = rustSource(TOOL_REGISTRY_RS);
const agentRoutingRs = rustSource(AGENT_ROUTING_RS);

/**
 * The body of `pub fn NAME(...) -> ... { … }`, brace-matched, or throw.
 *
 * Needed because the fact under test is a `.unwrap_or(…)` INSIDE a function, not
 * a const — and searching the whole file for `unwrap_or(true)` would pass on any
 * unrelated occurrence, which is how a mirror test dies quietly.
 */
function rustFnBody(source: string, name: string): string {
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

describe("preference keys mirror Core", () => {
	it("uses Core's atomic managed-routing preference key", () => {
		expect(NODE_ROUTING_PREF_KEY).toBe(
			rustStrConst(gatewayRs, GATEWAY_RS, "NODE_ROUTING_PREF_KEY")
		);
	});

	it("uses Core's auto-recall top-k key and default", () => {
		expect(AUTO_RECALL_TOP_K_PREF_KEY).toBe(
			rustStrConst(serverRs, SERVER_RS, "AUTO_RECALL_TOP_K_PREF")
		);
		expect(AUTO_RECALL_DEFAULT_TOP_K).toBe(
			rustUsizeConst(serverRs, SERVER_RS, "AUTO_RECALL_DEFAULT_TOP_K")
		);
	});

	it("uses Core's five context-window keys", () => {
		expect(CONTEXT_MAX_TOKENS_PREF_KEY).toBe(
			rustStrConst(serverRs, SERVER_RS, "CONTEXT_MAX_TOKENS_PREF")
		);
		expect(CONTEXT_MAX_OUTPUT_PREF_KEY).toBe(
			rustStrConst(serverRs, SERVER_RS, "CONTEXT_MAX_OUTPUT_PREF")
		);
		expect(CONTEXT_AUTO_COMPACT_PREF_KEY).toBe(
			rustStrConst(serverRs, SERVER_RS, "CONTEXT_AUTO_COMPACT_PREF")
		);
		expect(CONTEXT_COMPACT_MODEL_PREF_KEY).toBe(
			rustStrConst(serverRs, SERVER_RS, "CONTEXT_COMPACT_MODEL_PREF")
		);
		expect(CONTEXT_COMPACT_EFFORT_PREF_KEY).toBe(
			rustStrConst(serverRs, SERVER_RS, "CONTEXT_COMPACT_EFFORT_PREF")
		);
	});

	it("mirrors the reply reserve default and the skills margin", () => {
		expect(CONTEXT_DEFAULT_OUTPUT_RESERVE).toBe(
			rustUsizeConst(serverRs, SERVER_RS, "CONTEXT_DEFAULT_OUTPUT_RESERVE")
		);
		// The card's "leaves at most N for history" readout subtracts this; if
		// Core's margin moves, the readout starts overstating the room available.
		expect(CONTEXT_SKILLS_RESERVE).toBe(
			rustUsizeConst(contextWindowRs, CONTEXT_WINDOW_RS, "SKILLS_RESERVE")
		);
	});

	it("uses the tool registry's ranker key", () => {
		expect(TOOL_RANKER_PREF_KEY).toBe(
			rustStrConst(toolRegistryRs, TOOL_REGISTRY_RS, "RANKER_PREF_KEY")
		);
	});

	// ── The two per-agent gates that used to be one ──────────────────────────
	//
	// `agent_routing` owns BOTH keys, and the whole point of the split is that
	// they are different keys with shared ON defaults and independent opt-outs.
	// Two ways this could break
	// silently, one guarded by each test below:
	//
	//   1. a rename on either side leaves the desktop writing a key Core never
	//      reads — a switch that persists happily and changes nothing;
	//   2. either default drifts from Core, at which case an agent with no stored
	//      entry is reported wrongly, which is the state EVERY agent is in until
	//      someone opens the panel.

	it("uses Core's two per-agent keys, which must not be the same key", () => {
		expect(AGENT_GATEWAY_ROUTING_PREF_KEY).toBe(
			rustStrConst(
				agentRoutingRs,
				AGENT_ROUTING_RS,
				"AGENT_GATEWAY_ROUTING_PREF_KEY"
			)
		);
		expect(AGENT_TOOL_BRIDGE_PREF_KEY).toBe(
			rustStrConst(
				agentRoutingRs,
				AGENT_ROUTING_RS,
				"AGENT_TOOL_BRIDGE_PREF_KEY"
			)
		);
		// Stated as its own assertion because "two keys" is the fix, not a detail:
		// re-merging them re-creates the bug where declining the credential swap
		// also silently withheld every Ryu tool.
		expect(AGENT_TOOL_BRIDGE_PREF_KEY).not.toBe(AGENT_GATEWAY_ROUTING_PREF_KEY);
	});

	it("mirrors Core's independent defaults for the two gates", () => {
		// Core: both independent gates share the broad ON baseline; explicit false
		// entries remain separate direct-egress/tool-bridge opt-outs.
		// Anchored on the literal
		// text rather than restated, so a flip in Rust fails here.
		const gatewayFn = rustFnBody(agentRoutingRs, "is_gateway_routing");
		const bridgeFn = rustFnBody(agentRoutingRs, "is_tool_bridge_enabled");
		expect(gatewayFn).toContain("unwrap_or(DEFAULT_AGENT_GATEWAY_ROUTING)");
		expect(bridgeFn).toContain("unwrap_or(DEFAULT_AGENT_TOOL_BRIDGE)");
		expect(DEFAULT_GATEWAY_ROUTING).toBe(true);
		expect(DEFAULT_AGENT_GATEWAY_ROUTING).toBe(DEFAULT_GATEWAY_ROUTING);
		expect(DEFAULT_AGENT_TOOL_BRIDGE).toBe(DEFAULT_GATEWAY_ROUTING);
		expect(DEFAULT_CLAUDE_GATEWAY_ROUTING).toBe(DEFAULT_GATEWAY_ROUTING);
		expect(DEFAULT_CODEX_GATEWAY_ROUTING).toBe(DEFAULT_GATEWAY_ROUTING);
		// The maps stay separate even though they share a default: explicit opt-outs
		// must never make an egress choice remove the agent's tools.
		expect(DEFAULT_AGENT_TOOL_BRIDGE).toBe(DEFAULT_AGENT_GATEWAY_ROUTING);
	});

	it("writes the exact literal Core's ranker parser matches", () => {
		// `ToolRanker::from_pref` compares against the lowercase literal and keeps
		// Needle 2 as the safe default when a value is unknown.
		expect(
			rustAnchor(
				toolRegistryRs,
				TOOL_REGISTRY_RS,
				"pub fn from_pref(",
				'Some("semantic") => ToolRanker::Semantic'
			)
		).toBe(ANCHOR_PRESENT);
		expect(coerceToolRanker("semantic")).toBe("semantic");
	});
});

describe("local and cloud agent lanes", () => {
	it("keeps the legacy default local-only", () => {
		expect(agentLanePreferenceKey("local")).toBe(
			DEFAULT_LOCAL_AGENT_SELECTION_PREF_KEY
		);
		expect(agentLanePreferenceKey("cloud")).toBe(
			DEFAULT_CLOUD_AGENT_SELECTION_PREF_KEY
		);
		expect(DEFAULT_LOCAL_AGENT_SELECTION_PREF_KEY).not.toBe(
			DEFAULT_CLOUD_AGENT_SELECTION_PREF_KEY
		);
	});

	it("uses Ryu on the installed local model for the local lane", () => {
		expect(defaultLocalAgentSelection()).toEqual({
			...EMPTY_AGENT_SELECTION,
			agent_id: "ryu",
			provider: "local",
			model: "gemma-4-E2B-it-Q4_K_M",
		});
	});

	it("only sets managed Ryu for paid cloud defaults", () => {
		expect(defaultCloudAgentSelection(false)).toEqual(EMPTY_AGENT_SELECTION);
		expect(defaultCloudAgentSelection(true)).toEqual({
			...EMPTY_AGENT_SELECTION,
			agent_id: "ryu",
			provider: MANAGED_RYU_PROVIDER_ID,
			model: MANAGED_RYU_MODEL_ID,
		});
	});
});

describe("managed node-routing preferences", () => {
	it("round-trips fallback order and additive firewall patterns", () => {
		const prefs = parseNodeRoutingPreferences(
			serializeNodeRoutingPreferences({
				fallback: [" anthropic ", "openrouter"],
				firewall: {
					custom_patterns: [
						{ kind: "secret", name: "internal_id", regex: "id_[0-9]+" },
					],
				},
			})
		);
		expect(prefs).toEqual({
			fallback: ["anthropic", "openrouter"],
			firewall: {
				custom_patterns: [
					{ kind: "secret", name: "internal_id", regex: "id_[0-9]+" },
				],
			},
		});
	});

	it("treats malformed or unsafe pattern entries as empty preferences", () => {
		expect(
			parseNodeRoutingPreferences(
				JSON.stringify({
					fallback: ["anthropic", 42, ""],
					firewall: {
						custom_patterns: [{ kind: "not-a-kind", name: "x", regex: ".*" }],
					},
				})
			)
		).toEqual({ fallback: ["anthropic"], firewall: null });
		expect(parseNodeRoutingPreferences("not-json")).toEqual({
			fallback: [],
			firewall: null,
		});
	});
});

describe("coerceAutoRecallTopK", () => {
	it("falls back to Core's default when unset or unusable", () => {
		expect(coerceAutoRecallTopK(null)).toBe(AUTO_RECALL_DEFAULT_TOP_K);
		expect(coerceAutoRecallTopK("")).toBe(AUTO_RECALL_DEFAULT_TOP_K);
		expect(coerceAutoRecallTopK("   ")).toBe(AUTO_RECALL_DEFAULT_TOP_K);
		expect(coerceAutoRecallTopK("lots")).toBe(AUTO_RECALL_DEFAULT_TOP_K);
		// Core rejects zero and negatives (`filter(|n| *n > 0)` on a `usize` parse).
		expect(coerceAutoRecallTopK("0")).toBe(AUTO_RECALL_DEFAULT_TOP_K);
		expect(coerceAutoRecallTopK("-3")).toBe(AUTO_RECALL_DEFAULT_TOP_K);
	});

	it("rejects what Rust's usize parse rejects, not what parseInt accepts", () => {
		// `Number.parseInt` would read these as 5 and 12; `str::parse::<usize>()`
		// errors, so Core uses its default — the UI must agree.
		expect(coerceAutoRecallTopK("5.9")).toBe(AUTO_RECALL_DEFAULT_TOP_K);
		expect(coerceAutoRecallTopK("12abc")).toBe(AUTO_RECALL_DEFAULT_TOP_K);
		// …and rejects nothing else. Every case here is an `Err` from rustc:
		// a second sign, a sign detached from the digits, a bare sign, a Rust
		// numeric separator, and a non-ASCII digit.
		expect(coerceAutoRecallTopK("++5")).toBe(AUTO_RECALL_DEFAULT_TOP_K);
		expect(coerceAutoRecallTopK("+ 5")).toBe(AUTO_RECALL_DEFAULT_TOP_K);
		expect(coerceAutoRecallTopK("+")).toBe(AUTO_RECALL_DEFAULT_TOP_K);
		expect(coerceAutoRecallTopK("5_0")).toBe(AUTO_RECALL_DEFAULT_TOP_K);
		expect(coerceAutoRecallTopK("٥")).toBe(AUTO_RECALL_DEFAULT_TOP_K);
	});

	it("honours a plain positive integer, trimmed", () => {
		expect(coerceAutoRecallTopK("1")).toBe(AUTO_RECALL_MIN_TOP_K);
		expect(coerceAutoRecallTopK(" 12 ")).toBe(12);
	});

	it("accepts the leading + that Rust's usize parse accepts", () => {
		// `"+5".parse::<usize>()` is `Ok(5)` — being STRICTER than Core is the
		// same failure as being looser: the node recalls 5 snippets a turn while
		// the control claims the default.
		expect(coerceAutoRecallTopK("+5")).toBe(5);
		expect(coerceAutoRecallTopK(" +12 ")).toBe(12);
		// Leading zeros are Rust-legal too, with or without the sign.
		expect(coerceAutoRecallTopK("0005")).toBe(5);
		expect(coerceAutoRecallTopK("+0005")).toBe(5);
		// `-` stays rejected: `usize` is unsigned, and rustc errors even on "-0".
		expect(coerceAutoRecallTopK("-0")).toBe(AUTO_RECALL_DEFAULT_TOP_K);
		// `+0` parses to 0, which the `> 0` filter then sends to the default —
		// rejected by the filter, not by the grammar.
		expect(coerceAutoRecallTopK("+0")).toBe(AUTO_RECALL_DEFAULT_TOP_K);
	});

	it("falls back when the digit run overflows JS's own number range", () => {
		// The one place the shared grammar check is not enough: `parseInt` returns
		// `Infinity` past ~1e309 (verified in bun: 400 nines → Infinity, but a
		// 21-digit value is still a finite float), so the finite check is a live
		// branch, not decoration. Rust calls this `PosOverflow` and Core falls
		// back — agreement here is luck rather than fidelity, since between 2^64
		// and 1e309 the mirror is knowingly looser (see `parseRustUsize`).
		expect(coerceAutoRecallTopK("9".repeat(400))).toBe(
			AUTO_RECALL_DEFAULT_TOP_K
		);
	});

	it("reports a value above the offered range instead of clamping it", () => {
		// Core has NO ceiling — `resolve_auto_recall_top_k` accepts any positive
		// `usize`, and the docs tell readers to `curl` these keys. Clamping on
		// READ would show 50 while the node injects 200 snippets a turn.
		expect(AUTO_RECALL_MAX_TOP_K).toBeLessThan(200);
		expect(coerceAutoRecallTopK("200")).toBe(200);
		// Scoped to the resolver, not the file: `parse::<usize>().ok()` appears in
		// several Core readers, and an anchor any of them could satisfy would keep
		// passing after THIS one grew a ceiling.
		expect(
			rustAnchor(
				serverRs,
				SERVER_RS,
				"async fn resolve_auto_recall_top_k(",
				"let from_str = |s: &str| s.trim().parse::<usize>().ok().filter(|n| *n > 0);"
			)
		).toBe(ANCHOR_PRESENT);
	});
});

describe("parseContextBudget / formatContextBudget", () => {
	it("treats unset, blank, zero and off as off (Core's disabled contract)", () => {
		expect(parseContextBudget(null)).toEqual({ kind: "off" });
		expect(parseContextBudget("")).toEqual({ kind: "off" });
		expect(parseContextBudget("  ")).toEqual({ kind: "off" });
		expect(parseContextBudget("0")).toEqual({ kind: "off" });
		expect(parseContextBudget("off")).toEqual({ kind: "off" });
		expect(parseContextBudget("OFF")).toEqual({ kind: "off" });
	});

	it("reads auto case-insensitively", () => {
		expect(parseContextBudget("auto")).toEqual({ kind: "auto" });
		expect(parseContextBudget(" Auto ")).toEqual({ kind: "auto" });
	});

	it("reads a positive integer and rejects everything Rust rejects", () => {
		expect(parseContextBudget("8192")).toEqual({
			kind: "tokens",
			tokens: 8192,
		});
		expect(parseContextBudget(" 4096 ")).toEqual({
			kind: "tokens",
			tokens: 4096,
		});
		// Rust's `usize` parse errors on these, so Core disables the feature.
		expect(parseContextBudget("8k")).toEqual({ kind: "off" });
		expect(parseContextBudget("8192.5")).toEqual({ kind: "off" });
		expect(parseContextBudget("-8192")).toEqual({ kind: "off" });
		expect(parseContextBudget("nonsense")).toEqual({ kind: "off" });
	});

	it("reads a + budget as the budget Core is actually enforcing", () => {
		// The regression this pins: the docs tell operators to `curl` these keys,
		// `"+8000".parse::<usize>()` is `Ok(8000)`, so Core trims history to 8000
		// tokens. Reading it as Off made the card describe a different node — and
		// MemoryTab's no-op-blur guards (`parsed === budget.tokens`) compare
		// against this value, so an Off reading also armed a silent overwrite.
		expect(parseContextBudget("+8000")).toEqual({
			kind: "tokens",
			tokens: 8000,
		});
		expect(parseContextBudget(" +16384 ")).toEqual({
			kind: "tokens",
			tokens: 16_384,
		});
		// `+0` is `Ok(0)`, which fails Core's `Ok(n) if n > 0` arm → disabled.
		expect(parseContextBudget("+0")).toEqual({ kind: "off" });
		// A write never emits the sign, so the round-trip normalises it away.
		expect(formatContextBudget(parseContextBudget("+8000"))).toBe("8000");
	});

	it("is anchored to the Rust expression it claims to mirror", () => {
		// Without this, a Core-side rewrite to a hand-rolled digit scanner (which
		// would reject `+` again) leaves the mirror silently wrong in the other
		// direction — the same hole that let the `+` bug sit here unnoticed.
		expect(
			rustAnchor(
				serverRs,
				SERVER_RS,
				"fn parse_context_budget(",
				"match raw.parse::<usize>() {"
			)
		).toBe(ANCHOR_PRESENT);
		// And the literal-"0" test that runs BEFORE the parse, which is why `+0`
		// reaches the parse and is disabled by the `> 0` filter instead.
		expect(
			rustAnchor(
				serverRs,
				SERVER_RS,
				"fn parse_context_budget(",
				'raw.is_empty() || raw == "0" || raw.eq_ignore_ascii_case("off")'
			)
		).toBe(ANCHOR_PRESENT);
	});

	it("round-trips through the literals Core's parser accepts", () => {
		expect(formatContextBudget({ kind: "off" })).toBe("off");
		expect(formatContextBudget({ kind: "auto" })).toBe("auto");
		expect(formatContextBudget({ kind: "tokens", tokens: 16_384 })).toBe(
			"16384"
		);
		for (const raw of ["off", "auto", "16384"]) {
			expect(formatContextBudget(parseContextBudget(raw))).toBe(raw);
		}
	});

	it("clamps a written budget up to the floor that leaves room for history", () => {
		// Below the floor, Core's saturating `input_budget` reaches zero and
		// `window_count` still keeps the newest turn — i.e. every turn silently
		// becomes "system prompt + last message". The floor keeps that unreachable.
		expect(formatContextBudget({ kind: "tokens", tokens: 1 })).toBe(
			String(CONTEXT_MIN_BUDGET_TOKENS)
		);
	});
});

describe("coerceContextOutputReserve", () => {
	it("falls back to Core's 1024 when unset or unparseable", () => {
		expect(coerceContextOutputReserve(null)).toBe(
			CONTEXT_DEFAULT_OUTPUT_RESERVE
		);
		expect(coerceContextOutputReserve("")).toBe(CONTEXT_DEFAULT_OUTPUT_RESERVE);
		expect(coerceContextOutputReserve("some")).toBe(
			CONTEXT_DEFAULT_OUTPUT_RESERVE
		);
		expect(coerceContextOutputReserve("1024.5")).toBe(
			CONTEXT_DEFAULT_OUTPUT_RESERVE
		);
	});

	it("honours any value Core's parse accepts, including out-of-range ones", () => {
		expect(coerceContextOutputReserve("2048")).toBe(2048);
		expect(coerceContextOutputReserve(" 4096 ")).toBe(4096);
		// Core's `.ok().unwrap_or(1024)` accepts a literal 0 (the reply gets no
		// room) and has no ceiling. The field must show what the node uses; the
		// offered range is enforced on write, not on read.
		expect(coerceContextOutputReserve("0")).toBe(0);
		expect(coerceContextOutputReserve("65536")).toBeGreaterThan(
			CONTEXT_MAX_OUTPUT_RESERVE
		);
	});

	it("accepts a leading + like Core's parse, and still rejects -", () => {
		expect(coerceContextOutputReserve("+2048")).toBe(2048);
		expect(coerceContextOutputReserve(" +0 ")).toBe(0);
		expect(coerceContextOutputReserve("-2048")).toBe(
			CONTEXT_DEFAULT_OUTPUT_RESERVE
		);
	});

	it("is anchored to the Rust expression it claims to mirror", () => {
		// The reserve is read inside the context-window resolver, not by a helper
		// of its own, so the resolver is the item that owns this contract.
		expect(
			rustAnchor(
				serverRs,
				SERVER_RS,
				"async fn resolve_context_window(",
				"Ok(Some(v)) => v.trim().parse::<usize>().ok(),"
			)
		).toBe(ANCHOR_PRESENT);
	});
});

describe("contextHistoryBudget", () => {
	it("subtracts the reply reserve and the skills margin", () => {
		expect(contextHistoryBudget(8192, 1024)).toBe(
			8192 - 1024 - CONTEXT_SKILLS_RESERVE
		);
	});

	it("never reports a negative ceiling", () => {
		// Mirrors the saturating subtraction in Core's `input_budget`.
		expect(contextHistoryBudget(1000, 2000)).toBe(0);
	});
});

describe("coerceToolRanker", () => {
	it("defaults to Needle 2 for unset and unknown values", () => {
		expect(coerceToolRanker(null)).toBe("needle2");
		expect(coerceToolRanker("")).toBe("needle2");
		expect(coerceToolRanker("bm25")).toBe("bm25");
		expect(coerceToolRanker("vector")).toBe("needle2");
		expect(coerceToolRanker('"semantic"')).toBe("needle2");
		expect(coerceToolRanker("needle")).toBe("needle2");
		expect(coerceToolRanker("NEEDLE2")).toBe("needle2");
	});

	it("selects semantic for the literal Core matches, trimmed and lowercased", () => {
		expect(coerceToolRanker("semantic")).toBe("semantic");
		expect(coerceToolRanker(" Semantic ")).toBe("semantic");
	});
});

// ─── Guard for the guards ────────────────────────────────────────────────────
//
// `rustItemBody` / `expectRustAnchor` are what make the cross-file coupling
// survivable. A throw that never fires and a normalization that does not
// normalize are both invisible until the day they were supposed to help, so
// they are exercised against a synthetic source rather than trusted.

describe("the anchor helpers fail for the right reasons", () => {
	const SAMPLE = [
		"impl ToolRanker {",
		"    pub fn from_pref(s: Option<&str>) -> ToolRanker {",
		"        match s {",
		'            Some("semantic") => ToolRanker::Semantic,',
		"            _ => ToolRanker::Needle2,",
		"        }",
		"    }",
		"",
		"    pub fn other(&self) -> usize {",
		"        99",
		"    }",
		"}",
	].join("\n");

	it("scopes to the named item instead of the whole file", () => {
		// The failure this prevents: an anchor satisfied by a DIFFERENT function in
		// the same file, which keeps passing after the mirrored one is rewritten.
		const body = rustItemBody(SAMPLE, "sample.rs", "pub fn from_pref(");
		expect(body).toContain("ToolRanker::Semantic");
		expect(body).not.toContain("99");
	});

	it("throws a message naming this test file when the item is gone", () => {
		// Not `expect(false)`: a Core author who renames the function must be told
		// where the mirror lives, from the failure line alone.
		expect(() =>
			rustItemBody(SAMPLE, "sample.rs", "pub fn from_pref_renamed(")
		).toThrow(/preferences\.test\.ts/);
	});

	it("ignores formatting, so a rustfmt reflow cannot break a mirror", () => {
		const reflowed = SAMPLE.replace(
			'            Some("semantic") => ToolRanker::Semantic,',
			'            Some("semantic")\n                => ToolRanker::Semantic,'
		);
		expect(
			rustAnchor(
				reflowed,
				"sample.rs",
				"pub fn from_pref(",
				'Some("semantic") => ToolRanker::Semantic'
			)
		).toBe(ANCHOR_PRESENT);
	});

	it("reports the expression and its home when the expression changes", () => {
		// The diagnostic IS the deliverable: normalization must not be so eager that
		// a genuinely different expression still reads as present.
		const probe = rustAnchor(
			SAMPLE,
			"sample.rs",
			"pub fn from_pref(",
			'Some("meaning") => ToolRanker::Semantic'
		);
		expect(probe).not.toBe(ANCHOR_PRESENT);
		expect(probe).toContain("sample.rs :: pub fn from_pref(");
		expect(probe).toContain(PREFERENCES_TS);
	});
});

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
//    `s.trim().parse::<i64>()` — a SIGNED parse, a different grammar. `Number()`
//    is looser than both; the divergence and why it is tolerated are documented
//    on the function itself.
//  - `getAgentAutoRouting`        → a JSON blob, whose `similarity_threshold` is
//    an f64 on the gateway. Not a usize key at all.
//  - `getIslandEdgeOffset`        → NO Rust consumer. The other end is the
//    island's `parseEdgeOffset` (apps/island/src/shared/edge-offset.ts), which is
//    `Number(raw.trim())` + `Number.isFinite` + the same clamp — a TS↔TS mirror
//    that already agrees exactly. Rewriting it as a usize mirror would make the
//    desktop STRICTER than the process that actually reads the key.

// `rustSource` is reused purely as "read a repo file, throw loudly if missing" —
// the name is about its other callers.
const preferencesTs = rustSource(PREFERENCES_TS);

/**
 * Every numeric coercion call in a TS source, keyed by the function containing
 * it. The argument must start with an identifier or `(` so a `Number.parseInt("5.9")`
 * written inside a doc comment is not counted as a call site.
 */
function numericCoercionOwners(source: string): string[] {
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

describe("preferences.ts numeric reads", () => {
	it("attributes a new numeric read to the function that added it", () => {
		// The census is only worth anything if it SEES a new call site. Exercised on
		// a synthetic source rather than by editing preferences.ts, which several
		// jobs share. Also pins the two exclusions the scanner depends on: a numeric
		// call written inside a doc comment (string argument) and a bare `Number()`
		// mention are prose, not call sites.
		const sample = [
			'/** Looser than Rust: `Number.parseInt("5.9")` is 5, `Number()` is NaN. */',
			"export function existing(raw: string): number {",
			"	return parseRustUsize(raw) ?? 0;",
			"}",
			"",
			"export async function freshlyAdded(raw: string): Promise<number> {",
			"	return Number(raw.trim());",
			"}",
		].join("\n");
		expect(numericCoercionOwners(sample)).toEqual(["existing", "freshlyAdded"]);
	});

	it("has no numeric coercion outside the audited set", () => {
		// A new entry here is not a failure to route around: it means a preference
		// grew a numeric read, and the audit above has to say which Rust (or TS)
		// parse it mirrors. `str::parse::<usize>()` accepts a leading `+` and
		// rejects "5.9"/"5abc"; `Number`/`parseInt` disagree with it in both
		// directions, and a control that disagrees with its consumer is a control
		// that shows a value the node is not using.
		expect(numericCoercionOwners(preferencesTs)).toEqual([
			"coerceAutoRecallTopK",
			"coerceContextOutputReserve",
			"getAgentAutoRouting",
			"getIslandEdgeOffset",
			"getSupportAccessLocalExpiry",
			"parseContextBudget",
			"parseRustUsize",
		]);
	});

	it("routes every usize-backed key through the shared mirror", () => {
		// The three named in the round-6 fix, asserted as a SET: a fourth usize key
		// added with a hand-rolled `parseInt` would show up in the census above,
		// and this says what the census's fix is.
		for (const fn of [
			"coerceAutoRecallTopK",
			"coerceContextOutputReserve",
			"parseContextBudget",
		]) {
			const start = preferencesTs.indexOf(`function ${fn}(`);
			expect({ fn, declared: start >= 0 }).toEqual({ fn, declared: true });
			const body = preferencesTs.slice(
				start,
				preferencesTs.indexOf("\n}", start)
			);
			expect({ fn, viaMirror: body.includes("parseRustUsize(") }).toEqual({
				fn,
				viaMirror: true,
			});
		}
	});

	it("agrees with the island on the one key Rust never parses", () => {
		// TS↔TS: the desktop writes `island-edge-offset`, the island's Electron main
		// process reads it. Both coerce with `Number(...)` + `Number.isFinite` and
		// clamp to the same range, so the two ends cannot disagree about a value a
		// user can set. Anchored because the island file is in a different app and
		// nothing else would notice it drifting to a stricter parse.
		const islandTs = rustSource("apps/island/src/shared/edge-offset.ts");
		for (const anchor of [
			"const value = Number(raw.trim());",
			"Number.isFinite(value)",
			"MAX_EDGE_OFFSET",
			"MIN_EDGE_OFFSET",
		]) {
			expect({ anchor, present: islandTs.includes(anchor) }).toEqual({
				anchor,
				present: true,
			});
		}
		// And the desktop side offers exactly the range the island enforces.
		expect(MIN_ISLAND_EDGE_OFFSET).toBe(
			Number(/MIN_EDGE_OFFSET = (\d+)/.exec(islandTs)?.[1])
		);
		expect(MAX_ISLAND_EDGE_OFFSET).toBe(
			Number(/MAX_EDGE_OFFSET = (\d+)/.exec(islandTs)?.[1])
		);
	});
});

describe("the batched agent-flag writers target the key they are named for", () => {
	// The failure this prevents is one identifier wide and would not be a type
	// error: both `*Many` exports take `(target, Record<string, boolean>)` and both
	// delegate to `mergeAgentFlagMap`, differing only in the key they pass. The
	// bulk "give every agent Ryu's tools" button sits beside the egress column, so
	// a mispointed call would silently move every installed agent's model traffic —
	// and for a subscription agent, its credential — through the gateway.
	//
	// Asserted over the SOURCE rather than by calling them: exercising the real
	// writers means a network mock, and a mock that returned success would prove
	// nothing about which key travelled. Scoped with `rustItemBody`, which throws
	// if either export is renamed, so this cannot rot into a vacuous pass.
	const prefsTs = rustSource("apps/desktop/src/lib/api/preferences.ts");

	it("routes the tool-bridge writer to the tool-bridge key only", () => {
		const body = rustItemBody(
			prefsTs,
			"apps/desktop/src/lib/api/preferences.ts",
			"export function setAgentToolBridgeMany("
		);
		expect(body).toContain("AGENT_TOOL_BRIDGE_PREF_KEY");
		expect(body).not.toContain("AGENT_GATEWAY_ROUTING_PREF_KEY");
	});

	it("routes the egress writer to the egress key only", () => {
		const body = rustItemBody(
			prefsTs,
			"apps/desktop/src/lib/api/preferences.ts",
			"export function setAgentGatewayRoutingMany("
		);
		expect(body).toContain("AGENT_GATEWAY_ROUTING_PREF_KEY");
		expect(body).not.toContain("AGENT_TOOL_BRIDGE_PREF_KEY");
	});

	it("keeps the two keys distinct, so the assertions above can discriminate", () => {
		// If these ever became the same string the two tests above would both pass
		// while the writers were interchangeable — the exact hazard, undetected.
		expect(AGENT_TOOL_BRIDGE_PREF_KEY).not.toBe(AGENT_GATEWAY_ROUTING_PREF_KEY);
	});
});
