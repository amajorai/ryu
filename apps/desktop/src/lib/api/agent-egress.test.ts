// apps/desktop/src/lib/api/agent-egress.test.ts
//
// Two kinds of test, both guarding the same failure: a governance view that
// tells you an agent is filtered/budgeted/logged when it is not.
//
//  1. MIRROR tests. The four defaults this view reports live in Rust, in this
//     repo, in four different modules — Pi, Claude, Codex, and routable generic
//     ACP agents are governed by default. A
//     stale copy here is silent:
//     the page would print "Direct" over a governed Pi, or "Governed" over a
//     Claude Code that is shipping tokens straight to Anthropic. So these tests
//     PARSE the Rust and compare, in the same doctrine as `preferences.test.ts`
//     — every anchor THROWS when its target is gone, because an assertion
//     comparing `undefined` to `undefined` is how a guard like this dies quietly.
//
//  2. CLASSIFIER tests over the pure `classifyAgentEgress`, pinning the
//     resolution ORDER to `agent_route`'s (flagship → BYO `acp-exec:` → local
//     engine → registry entry → claude/codex/openai-compat/bypass) and pinning
//     the two states that must never collapse into "not governed": a local
//     engine (nothing leaves the machine) and an agent Core declared unroutable
//     (no working toggle exists, so we must not render one).
//
// Since `agent_routing`'s split, every row also carries a SECOND, independent
// verdict — whether Ryu's MCP tool bridge reaches the agent — and the last five
// describe blocks in this file exist because the two verdicts must never be
// derived from one another. Their inert sets are close to inverted: `acp:gemini`
// cannot be egress-routed but takes the bridge; `acp:pi` can be egress-routed but
// can never take the bridge. When these two were ONE preference, declining the
// credential swap silently withheld every Ryu tool, which is why a freshly
// installed ACP agent did not work out of the box.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentEgress,
	applyToolBridgePlan,
	classifyAgentEgress,
	describeEgressBadge,
	describeToolBadge,
	type EgressPrefs,
	planEnableToolsForAll,
	summarizeAgentEgress,
	type ToolBridgePlan,
} from "./agent-egress.ts";
import type { AgentCatalogEntry } from "./agents.ts";

// src/lib/api → src/lib → src → apps/desktop → apps → repo root.
const REPO_ROOT = join(import.meta.dir, "../../../../..");

/** The mirror under test; named in every anchor diagnostic. */
const AGENT_EGRESS_TS = "apps/desktop/src/lib/api/agent-egress.ts";

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

/**
 * Drop `//` line comments, then collapse whitespace runs to one space, so
 * neither `cargo fmt` nor a reworded doc comment can break an anchor. Stripping
 * only ever REMOVES text, so it cannot turn a stale mirror into a passing one.
 */
const squeeze = (s: string): string =>
	s
		.replaceAll(/^[ \t]*\/\/.*$/gm, "")
		.replaceAll(/\s+/g, " ")
		.trim();

/**
 * Assert a literal Rust expression is still present in `file`, whitespace-
 * insensitively. Returns a marker string rather than asserting inline (Biome's
 * `noMisplacedAssertion` rejects an `expect` outside an `it`, and a returned
 * diagnostic shows the reader WHY the mirror is stale, not just that it is).
 */
const PRESENT = "present";
function anchor(file: string, expression: string): string {
	const body = squeeze(rustSource(file));
	if (body.includes(squeeze(expression))) {
		return PRESENT;
	}
	return (
		`mirror test anchor lost its target: \`${expression}\` is no longer in ${file}. ` +
		`${AGENT_EGRESS_TS} claims to reproduce that default; re-check the mirror ` +
		"against whatever replaced it, then re-point this anchor."
	);
}

describe("the four per-family defaults this view reports", () => {
	// The whole point of the surface: each family has a separate control, even
	// though each family keeps its own explicit default and control.

	it("Claude Code is governed by default — it shares Core's default", () => {
		expect(
			anchor(
				"apps/core/src/claude_config/mod.rs",
				"static GATEWAY_ROUTING: AtomicBool = AtomicBool::new(DEFAULT_CLAUDE_GATEWAY_ROUTING);"
			)
		).toBe(PRESENT);
	});

	it("Codex is governed by default — it shares Core's default", () => {
		expect(
			anchor(
				"apps/core/src/codex_config/mod.rs",
				"static GATEWAY_ROUTING: AtomicBool = AtomicBool::new(DEFAULT_CODEX_GATEWAY_ROUTING);"
			)
		).toBe(PRESENT);
	});

	it("generic per-agent routing defaults ON — a missing map entry is governed", () => {
		expect(
			anchor(
				"apps/core/src/agent_routing/mod.rs",
				".and_then(|m| m.get(agent_id).copied()) .unwrap_or(DEFAULT_AGENT_GATEWAY_ROUTING)"
			)
		).toBe(PRESENT);
	});

	it("the managed Pi defaults ON — anything but the literal `direct` is gateway", () => {
		// `is_gateway_routing()` reads settings.json's `x-ryu-routing` and only
		// `"direct"` turns it off, so a node that has never been configured is
		// governed. This is why `fetchEgressPrefs` falls back to "gateway" when
		// `/api/pi-config` cannot be read — the opposite fallback would paint a
		// fresh node as ungoverned.
		expect(
			anchor(
				"apps/core/src/pi_config/mod.rs",
				"match settings.extra.get(ROUTING_KEY).and_then(Value::as_str) { Some(ROUTING_DIRECT) => false, _ => true, }"
			)
		).toBe(PRESENT);
	});

	it("only the gateway/managed Pi providers are gateway-routed", () => {
		// `apply()` writes ROUTING_KEY from `is_managed_or_gateway(&provider)`,
		// which is why the Pi row is a consequence of the provider choice and
		// carries no boolean switch of its own.
		expect(
			anchor(
				"apps/core/src/pi_config/mod.rs",
				"let gateway = is_managed_or_gateway(&provider);"
			)
		).toBe(PRESENT);
	});

	it("only the flagship is `recommended`, so nothing else inherits Pi's ON", () => {
		// The Pi branch fires on `AgentSummary.recommended`. Every agent built from
		// the upstream ACP registry must stay `recommended: false` or it would be
		// painted "Through gateway" from Pi's default — the exact false positive
		// this surface exists to remove.
		expect(
			anchor("apps/core/src/sidecar/adapters/acp.rs", "recommended: false,")
		).toBe(PRESENT);
		const source = rustSource("apps/core/src/sidecar/adapters/acp.rs");
		const trueRows = source.match(/recommended: true,/g) ?? [];
		// Exactly one hand-written registry entry sets it: `ryu`.
		expect(trueRows).toHaveLength(1);
	});
});

describe("mechanism anchors — the redirect each family actually uses", () => {
	it("Claude and Codex take their dedicated path, never the generic one", () => {
		// `is_special` is what stops a stale generic-map entry from injecting
		// OPENAI_BASE_URL into an Anthropic/Codex agent, and is why the classifier
		// checks the two ids BEFORE the generic branch.
		expect(
			anchor(
				"apps/core/src/sidecar/adapters/mod.rs",
				'let is_special = entry.id == "acp:claude" || entry.id == "acp:codex";'
			)
		).toBe(PRESENT);
	});

	it("an OpenAI-compat registry agent is always forwarded via the gateway", () => {
		// Anchored to the whole arm, not the bare `via_gateway: true` (which also
		// appears on the plain-default route): the claim is specifically that a
		// registry OpenAI-compat transport has no ungoverned path, which is why
		// that row shows no switch.
		expect(
			anchor(
				"apps/core/src/sidecar/adapters/mod.rs",
				`AgentRoute::OpenAiCompat {
					base_url: (*base_url).to_owned(),
					model: model.or(*reg_model).unwrap_or("default").to_owned(),
					api_key: None,
					via_gateway: true,
				}`
			)
		).toBe(PRESENT);
	});

	it("find_by_prefix is an id-or-prefix scan in registry order", () => {
		expect(
			anchor(
				"apps/core/src/sidecar/adapters/acp.rs",
				".find(|e| agent_id == e.id || agent_id.starts_with(&e.id))"
			)
		).toBe(PRESENT);
	});

	it("Core's local-engine list is the one the classifier mirrors", () => {
		const source = rustSource("apps/core/src/sidecar/active_engine.rs");
		const start = source.indexOf("pub const LOCAL_ENGINES: &[&str] = &[");
		if (start < 0) {
			throw new Error(
				"mirror test anchor lost its target: LOCAL_ENGINES is no longer in " +
					`apps/core/src/sidecar/active_engine.rs. ${AGENT_EGRESS_TS} mirrors it.`
			);
		}
		const end = source.indexOf("];", start);
		const listed = [...source.slice(start, end).matchAll(/"([^"]+)"/g)].map(
			(m) => m[1]
		);
		// Read back the mirror's own set through a classification probe: every
		// engine Core calls local must classify as `local-engine` here, or the UI
		// would report a loopback model as ungoverned provider egress.
		for (const engine of listed) {
			const row = classifyAgentEgress(
				{ id: "agt_x", name: "x", engine, flagship: false },
				[],
				prefs({})
			);
			expect(`${engine}:${row.mechanism}`).toBe(`${engine}:local-engine`);
		}
		expect(listed.length).toBeGreaterThan(0);
	});
});

// ── Classifier ───────────────────────────────────────────────────────────────

const prefs = (over: Partial<EgressPrefs>): EgressPrefs => ({
	agents: {},
	claude: true,
	codex: true,
	piRouting: "gateway",
	// Empty, i.e. no agent has an explicit tool-bridge entry — which is the state
	// every agent on a real node is in until someone touches the panel, and the
	// state Core reads as ON.
	tools: {},
	...over,
});

const entry = (
	over: Partial<AgentCatalogEntry> & { id: string }
): AgentCatalogEntry => ({
	added: true,
	available: true,
	bridgeVersionStatus: null,
	description: null,
	detected: null,
	engine: null,
	gatewayBypass: false,
	iconUrl: null,
	installedBridgeVersion: null,
	installedVersion: null,
	installHint: null,
	latestBridgeVersion: null,
	latestVersion: null,
	name: over.id,
	recommended: false,
	registryId: null,
	transport: "acp",
	versionStatus: null,
	...over,
});

/** A catalog in the same declaration order Core's registry uses. */
const CATALOG: AgentCatalogEntry[] = [
	entry({ id: "ryu" }),
	entry({ id: "acp:claude", gatewayBypass: true }),
	entry({ id: "acp:codex" }),
	entry({ id: "acp:gemini", gatewayBypass: true }),
	// `registry_id: Some("pi-acp")` verbatim from Core's entry — it is one of the
	// two ways the tool-bridge mirror recognises a pi-acp spawn.
	entry({ id: "acp:pi", registryId: "pi-acp" }),
	entry({ id: "openclaw", gatewayBypass: true }),
	entry({ id: "zeroclaw", transport: "openai_compat" }),
];

const classify = (
	agent: { engine: string | null; flagship?: boolean; id: string },
	over: Partial<EgressPrefs> = {}
): AgentEgress =>
	classifyAgentEgress(
		{
			id: agent.id,
			name: agent.id,
			engine: agent.engine,
			flagship: agent.flagship ?? false,
		},
		CATALOG,
		prefs(over)
	);

describe("classifyAgentEgress mirrors Core's agent_route order", () => {
	it("the flagship follows Pi's provider routing, and defaults governed", () => {
		const row = classify({ id: "ryu", engine: "ryu", flagship: true });
		expect(row.mechanism).toBe("pi-provider");
		expect(row.governed).toBe(true);
		// Not a boolean preference — it is decided by which provider is active,
		// so offering a switch here would offer a control Core cannot honour.
		// It must still say WHERE to change it: a status with no pointer is a
		// dead end, and this is the only family that is on by default.
		expect(row.detail).toContain("Ryu agent's model settings");
		expect(row.control).toBeNull();
	});

	it("the flagship reads direct when Pi is pointed at a BYOK provider", () => {
		const row = classify(
			{ id: "ryu", engine: "ryu", flagship: true },
			{ piRouting: "direct" }
		);
		expect(row.governed).toBe(false);
		expect(row.detail).toContain("Ryu agent's model settings");
	});

	it("Claude Code is governed by default and toggleable, with the credential note", () => {
		const row = classify({ id: "acp:claude", engine: "acp:claude" });
		expect(row.mechanism).toBe("anthropic-passthrough");
		expect(row.governed).toBe(true);
		expect(row.control).toEqual({ kind: "claude" });
		// Enabling changes how a subscription credential flows; the row must say so.
		expect(row.credentialNote).toContain("subscription");
	});

	it("Claude Code reads its OWN preference, not the generic map", () => {
		// The generic map is deliberately ignored for acp:claude in Core
		// (`is_special`); a stale entry there must not flip this row.
		const row = classify(
			{ id: "acp:claude", engine: "acp:claude" },
			{ agents: { "acp:claude": true }, claude: false }
		);
		expect(row.governed).toBe(false);
		expect(
			classify({ id: "acp:claude", engine: "acp:claude" }, { claude: true })
				.governed
		).toBe(true);
	});

	it("Codex is governed by default and toggleable, with the credential note", () => {
		const row = classify({ id: "acp:codex", engine: "acp:codex" });
		expect(row.mechanism).toBe("codex-passthrough");
		expect(row.governed).toBe(true);
		expect(row.control).toEqual({ kind: "codex" });
		expect(row.credentialNote).toContain("subscription");
		expect(
			classify({ id: "acp:codex", engine: "acp:codex" }, { codex: false })
				.governed
		).toBe(false);
	});

	it("a BYO acp-exec agent uses the generic map keyed on the AGENT id", () => {
		// Core's `route_id = agent_id.unwrap_or(engine)`: the key is the agent's
		// record id, which is what the existing per-agent switch writes. Keying on
		// the engine instead would read a value nothing ever wrote.
		const row = classify(
			{ id: "agt_byo", engine: "acp-exec:my-agent --acp" },
			{ agents: { agt_byo: true } }
		);
		expect(row.mechanism).toBe("openai-base-url");
		expect(row.governed).toBe(true);
		expect(row.control).toEqual({ kind: "agent", agentId: "agt_byo" });
		// Ryu sets the variable; it cannot make a foreign binary read it.
		expect(row.bestEffort).toBe(true);
	});

	it("an agent Core declared unroutable gets NO switch and no false negative", () => {
		// gemini carries gateway_bypass — Core's own doc calls the generic
		// injection "a genuine no-op" for it. A switch here would be a settable
		// value that cannot take effect, and reporting the map's `true` as
		// "governed" would be a status reporting healthy for a dead thing.
		const row = classify(
			{ id: "acp:gemini", engine: "acp:gemini" },
			{ agents: { "acp:gemini": true } }
		);
		expect(row.mechanism).toBe("unroutable");
		expect(row.control).toBeNull();
		expect(row.governed).toBe(false);
	});

	it("an OpenAI-compat registry agent is always governed and has no switch", () => {
		const row = classify({ id: "zeroclaw", engine: "zeroclaw" });
		expect(row.mechanism).toBe("gateway-forward");
		expect(row.governed).toBe(true);
		expect(row.control).toBeNull();
	});

	it("a local-engine agent is neither governed nor direct", () => {
		const row = classify({ id: "agt_local", engine: "llamacpp" });
		expect(row.mechanism).toBe("local-engine");
		// `null`, not `false`: nothing reaches a provider, so "not governed"
		// would put it in the same bucket as an ungoverned Claude Code.
		expect(row.governed).toBeNull();
		expect(row.control).toBeNull();
	});

	it("an unrecognised engine says so instead of guessing", () => {
		const row = classify({ id: "agt_x", engine: "not-an-engine" });
		expect(row.mechanism).toBe("unresolved");
		expect(row.governed).toBeNull();
	});

	it("a null engine falls back to the id, like Core's engine.or(agent_id)", () => {
		expect(classify({ id: "acp:pi", engine: null }).mechanism).toBe(
			"openai-base-url"
		);
		expect(classify({ id: "agt_orphan", engine: null }).mechanism).toBe(
			"unresolved"
		);
	});

	it("an empty acp-exec command is not treated as a BYO agent", () => {
		// Core only takes the acp-exec branch for a non-empty command; an empty
		// one falls through to the registry lookup and finds nothing.
		expect(classify({ id: "agt_e", engine: "acp-exec:   " }).mechanism).toBe(
			"unresolved"
		);
	});
});

describe("summarizeAgentEgress keeps best-effort out of the governed count", () => {
	it("counts governed, best-effort and direct separately", () => {
		const rows = [
			classify({ id: "ryu", engine: "ryu", flagship: true }),
			classify({ id: "acp:claude", engine: "acp:claude" }, { claude: false }),
			classify(
				{ id: "agt_byo", engine: "acp-exec:x" },
				{ agents: { agt_byo: true } }
			),
			classify({ id: "agt_local", engine: "ollama" }),
		];
		const view = summarizeAgentEgress(rows);
		expect(view.governedCount).toBe(1); // ryu; Claude explicitly opted out
		expect(view.bestEffortCount).toBe(1); // the BYO redirect
		expect(view.directCount).toBe(1); // the explicit direct-egress Claude row
		expect(view.otherCount).toBe(1); // the local-engine row
		expect(view.rows).toHaveLength(4);
	});

	it("the four counters partition the rows, so the caption adds up", () => {
		// A summary line that omits a state ("1 governed, 0 direct" over three
		// rows) reads as "the rest were fine". Every classifiable shape below is
		// represented; the sum must equal the list length for any of them.
		const rows = [
			classify({ id: "ryu", engine: "ryu", flagship: true }),
			classify({ id: "acp:claude", engine: "acp:claude" }, { claude: true }),
			classify({ id: "acp:codex", engine: "acp:codex" }),
			classify({ id: "acp:gemini", engine: "acp:gemini" }),
			classify({ id: "zeroclaw", engine: "zeroclaw" }),
			classify({ id: "agt_local", engine: "mlx" }),
			classify({ id: "agt_x", engine: "nope" }),
			classify({ id: "agt_byo", engine: "acp-exec:x" }),
			classify(
				{ id: "agt_byo2", engine: "acp-exec:y" },
				{ agents: { agt_byo2: true } }
			),
		];
		const view = summarizeAgentEgress(rows);
		expect(
			view.governedCount +
				view.bestEffortCount +
				view.directCount +
				view.otherCount
		).toBe(rows.length);
	});
});

// ── Timing: a saved preference is not an in-force preference ─────────────────
//
// The third failure this file guards, after "wrong state" and "state that does
// not add up": a state that is RIGHT about the preference and wrong about the
// world. Every mechanism here is injected into the agent's spawn command, so the
// instant after a write the node agrees with the badge and a running subprocess
// does not. These tests pin (a) that spawn-time premise against Core, so the
// caveat cannot outlive its reason, and (b) that the wording is the agent
// editor's own, so the two surfaces over these three preferences cannot drift
// into describing one mechanism two ways.

/** The other UI over `claude-`/`codex-`/`agent-gateway-routing`. */
const AGENT_EDIT_TSX = "packages/blocks/src/desktop/agent-edit.tsx";

/** Same reader as the Rust mirrors; the wording mirror below is TypeScript. */
const repoSource = rustSource;

describe("the spawn-time premise the timing caveat rests on", () => {
	it("each family's routing is baked into a SPAWN COMMAND, not signalled", () => {
		// If any of these stopped returning a *different command string* — say one
		// started writing a config file a live agent re-reads — that family would no
		// longer need the caveat, and a caveat nobody needs is the fastest way to
		// teach a reader to skip the ones that matter.
		expect(
			anchor(
				"apps/core/src/sidecar/adapters/acp.rs",
				'"ANTHROPIC_BASE_URL={base_url} {spawn_cmd}"'
			)
		).toBe(PRESENT);
		expect(
			anchor(
				"apps/core/src/sidecar/adapters/acp.rs",
				'"OPENAI_BASE_URL={gateway_v1} OPENAI_API_KEY={token} {spawn_cmd}"'
			)
		).toBe(PRESENT);
		expect(
			anchor(
				"apps/core/src/sidecar/adapters/acp.rs",
				"\"CODEX_HOME='{}' npx -y @zed-industries/codex-acp\""
			)
		).toBe(PRESENT);
		// The flagship's own injection, inline in `ryu_agent_route`.
		expect(
			anchor(
				"apps/core/src/sidecar/adapters/mod.rs",
				'"OPENAI_BASE_URL={gateway_v1} OPENAI_API_KEY={token} "'
			)
		).toBe(PRESENT);
	});

	it("the ACP pool is keyed on the spawn command, so a change respawns", () => {
		// This is the fact that makes the PASSIVE wording correct: the pool key
		// carries the resolved spawn command, so a flipped preference produces a
		// different key, misses the warm instance, and Core spawns a fresh one on
		// the chat's next message. Drop `spawn_cmd` from this key and the change
		// would instead reach a warm chat NEVER (until its idle TTL) — the copy
		// would become wrong in the other direction, so it must fail loudly.
		expect(
			anchor(
				"apps/core/src/sidecar/adapters/acp.rs",
				'"{conversation}\\u{1}{agent_key}\\u{1}{spawn_cmd}\\u{1}{}\\u{1}{workspace_key}\\u{1}{environment_key}\\u{1}{security_key}"'
			)
		).toBe(PRESENT);
	});
});

describe("the timing sentence is the agent editor's, verbatim", () => {
	it("every sentence this view shows also appears in agent-edit.tsx", () => {
		const source = repoSource(AGENT_EDIT_TSX);
		const shown = [
			classify({ id: "acp:claude", engine: "acp:claude" }).takesEffect,
			classify({ id: "acp:codex", engine: "acp:codex" }).takesEffect,
			classify({ id: "agt_byo", engine: "acp-exec:x" }).takesEffect,
		];
		for (const sentence of shown) {
			if (sentence === null) {
				throw new Error(
					`${AGENT_EGRESS_TS} stopped attaching a timing sentence to a row ` +
						"whose routing is injected at spawn — the badge would go back to " +
						"claiming a saved value is in force."
				);
			}
			if (!source.includes(sentence)) {
				throw new Error(
					`"${sentence}" is not in ${AGENT_EDIT_TSX}. That file is the other UI ` +
						`over these same three preferences and ${AGENT_EGRESS_TS} copies its ` +
						"wording deliberately: one mechanism described in two phrasings reads " +
						"as two mechanisms. Match the editor's sentence, or change both."
				);
			}
		}
		// Three families, three distinct sentences — not one generic string used
		// three times, which would drop "Claude Code"/"Codex" from the rows where
		// the editor names them.
		expect(new Set(shown).size).toBe(3);
	});
});

describe("takesEffect marks the rows with a spawn step, and only those", () => {
	it("attaches to every row whose routing is injected at spawn", () => {
		expect(
			classify({ id: "ryu", engine: "ryu", flagship: true }).takesEffect
		).toBe("Takes effect the next time the agent starts.");
		expect(
			classify({ id: "acp:claude", engine: "acp:claude" }).takesEffect
		).toBe("Takes effect the next time Claude Code starts.");
		expect(classify({ id: "acp:codex", engine: "acp:codex" }).takesEffect).toBe(
			"Takes effect the next time Codex starts."
		);
		expect(classify({ id: "agt_byo", engine: "acp-exec:x" }).takesEffect).toBe(
			"Takes effect the next time the agent starts."
		);
		expect(classify({ id: "acp:pi", engine: "acp:pi" }).takesEffect).toBe(
			"Takes effect the next time the agent starts."
		);
	});

	it("stays off rows with nothing to wait for", () => {
		// A caveat on a row it cannot apply to is noise that devalues the ones that
		// carry weight: nothing about a local model, an agent Core cannot route, an
		// engine it cannot resolve, or a request-time forward changes at spawn.
		expect(classify({ id: "agt_local", engine: "mlx" }).takesEffect).toBeNull();
		expect(
			classify({ id: "acp:gemini", engine: "acp:gemini" }).takesEffect
		).toBeNull();
		expect(
			classify({ id: "zeroclaw", engine: "zeroclaw" }).takesEffect
		).toBeNull();
		expect(classify({ id: "agt_x", engine: "nope" }).takesEffect).toBeNull();
		expect(
			classify({ id: "agt_sdk", engine: "sdk:thing" }).takesEffect
		).toBeNull();
	});
});

describe("the two caveats on one row stay two caveats", () => {
	it("the best-effort note does not borrow the timing sentence's verb", () => {
		// A governed BYO row renders both: "…only does anything if the command's
		// client reads that variable" (WHETHER the redirect works) directly above
		// "Takes effect the next time the agent starts." (WHEN it starts applying).
		// They are different facts. If both open with "takes effect" a reader fuses
		// them into one vague hedge and loses the one that says the redirect may do
		// nothing at all.
		const row = classify(
			{ id: "agt_byo", engine: "acp-exec:x" },
			{ agents: { agt_byo: true } }
		);
		expect(row.bestEffort).toBe(true);
		expect(row.detail.toLowerCase()).toContain("reads that variable");
		expect(row.detail.toLowerCase()).not.toContain("takes effect");
		expect(row.takesEffect?.toLowerCase()).toContain("takes effect");
	});
});

describe("describeEgressBadge will not call a saved value in force", () => {
	it("reads governed subscription defaults without a saved preference", () => {
		const settled = (row: AgentEgress) => describeEgressBadge(row).label;
		expect(
			settled(classify({ id: "ryu", engine: "ryu", flagship: true }))
		).toBe("Through gateway");
		expect(settled(classify({ id: "acp:codex", engine: "acp:codex" }))).toBe(
			"Through gateway"
		);
		expect(
			settled(
				classify(
					{ id: "agt_byo", engine: "acp-exec:x" },
					{ agents: { agt_byo: true } }
				)
			)
		).toBe("Pointed at gateway");
		expect(settled(classify({ id: "agt_local", engine: "mlx" }))).toBe(
			"On this device"
		);
		expect(settled(classify({ id: "acp:gemini", engine: "acp:gemini" }))).toBe(
			"Can't be routed"
		);
		expect(settled(classify({ id: "agt_x", engine: "nope" }))).toBe("Unknown");
	});

	it("hedges a just-saved ON — a running agent is still going direct", () => {
		// The exact bug: the preference write returns, the node agrees, and Claude
		// Code is still streaming to Anthropic on the environment it was spawned
		// with. "Through gateway" here would be a status reporting healthy for a
		// dead thing, inside the surface built to stop doing that.
		const row = classify(
			{ id: "acp:claude", engine: "acp:claude" },
			{ claude: true }
		);
		expect(describeEgressBadge(row).label).toBe("Through gateway");
		const badge = describeEgressBadge(row, true);
		expect(badge.label).toBe("Gateway on next start");
		expect(badge.pendingStart).toBe(true);
		expect(badge.label).not.toBe(describeEgressBadge(row).label);
	});

	it("hedges a just-saved OFF the same way, in the same direction as the write", () => {
		// Mirrored lie: a running agent keeps going THROUGH the gateway after the
		// switch says direct. Someone turning routing off to keep a subscription
		// outside Ryu egress is owed that just as much. The label follows the value
		// WRITTEN, not the row, which is still the pre-write read until the refetch.
		const stale = classify(
			{ id: "acp:claude", engine: "acp:claude" },
			{ claude: true }
		);
		const badge = describeEgressBadge(stale, false);
		expect(badge.label).toBe("Direct on next start");
		expect(badge.pendingStart).toBe(true);
	});

	it("does NOT hedge a row that has no spawn step to wait for", () => {
		// Hedging everywhere is how a caveat stops being read. An openai_compat
		// agent is forwarded by Core at request time; there is nothing pending.
		const row = classify({ id: "zeroclaw", engine: "zeroclaw" });
		expect(row.takesEffect).toBeNull();
		const badge = describeEgressBadge(row, true);
		expect(badge.label).toBe("Through gateway");
		expect(badge.pendingStart).toBe(false);
	});
});

// ── Layer 3: the MCP tool bridge ─────────────────────────────────────────────
//
// A fourth failure this file now guards, and the one that shipped: reporting an
// agent's TOOL access from its EGRESS setting. The two gates were one preference
// until `agent_routing`'s split, and their sets of "inert" agents are not merely
// different — they are close to inverted (`acp:gemini` cannot be egress-routed
// but takes the bridge; `acp:pi` can be egress-routed but can never take the
// bridge). Any mirror that derives one from the other is wrong for both.

/** Owner of both gates and both defaults. */
const AGENT_ROUTING_RS = "apps/core/src/agent_routing/mod.rs";
/** Where the bridge decision is actually taken, per ACP instance. */
const ACP_RS = "apps/core/src/sidecar/adapters/acp.rs";
/** Ships the flagship's alternative tool path. */
const PI_CONFIG_RS = "apps/core/src/pi_config/mod.rs";

describe("the tool bridge's two terms, mirrored from Core", () => {
	it("the transport term is the pi-acp substring test this file reproduces", () => {
		// `runsPiAcp` in agent-egress.ts reconstructs this set from catalog data.
		// If Core stops keying on the spawn command, the reconstruction is wrong
		// in a way nothing else would catch — the desktop never sees a spawn cmd.
		expect(
			anchor(ACP_RS, "fn acp_bridge_supported(spawn_cmd: &str) -> bool")
		).toBe(PRESENT);
		expect(anchor(ACP_RS, '!spawn_cmd.contains("pi-acp")')).toBe(PRESENT);
	});

	it("the preference term is ANDed with the transport term, transport first", () => {
		// Order matters to the mirror: because the transport guard short-circuits,
		// a pi-acp agent is answered WITHOUT consulting the preference at all. That
		// is why this view shows those agents a state rather than a switch — the
		// switch would be settable and permanently inert.
		expect(
			anchor(
				ACP_RS,
				"acp_bridge_supported(spawn_cmd) && crate::agent_routing::is_tool_bridge_enabled(agent_id)"
			)
		).toBe(PRESENT);
	});

	it("a missing entry means ON, which is what a fresh node reports", () => {
		// Every agent is in this state until someone opens the panel, so getting it
		// wrong mis-reports the common case rather than an edge one.
		expect(anchor(AGENT_ROUTING_RS, "pub fn is_tool_bridge_enabled")).toBe(
			PRESENT
		);
		expect(
			anchor(AGENT_ROUTING_RS, ".unwrap_or(DEFAULT_AGENT_TOOL_BRIDGE)")
		).toBe(PRESENT);
		const row = classify({ id: "acp:gemini", engine: "acp:gemini" });
		expect(row.tools.enabled).toBe(true);
	});

	it("the flagship's tools come from a Pi extension, not from this switch", () => {
		// The single most damaging thing this view could say is "the Ryu agent has
		// no tools". It has them — via `ryu-mcp.ts` shipped into the MANAGED config
		// dir — it just does not get them from the bridge.
		expect(anchor(PI_CONFIG_RS, "fn ensure_pi_mcp_extension")).toBe(PRESENT);
		expect(anchor(PI_CONFIG_RS, "fn pi_mcp_extension_path() -> PathBuf")).toBe(
			PRESENT
		);
		expect(
			anchor(PI_CONFIG_RS, 'config_dir().join("extensions").join("ryu-mcp.ts")')
		).toBe(PRESENT);
	});

	it("that extension is never installed for the user's own Pi", () => {
		// Which is exactly why `acp:pi` gets NEITHER path, and why this view says so
		// where a user would look instead of letting them find out when a tool call
		// silently never happens.
		//
		// Anchored on CODE, not on the doc comment that states it: `squeeze` strips
		// `//` lines before matching, so a comment anchor would be matched against
		// text that is never there — a test that passes on an empty haystack is the
		// failure mode this file's helper exists to avoid.
		//
		// Two facts, together sufficient. (a) the extension is written under
		// `config_dir()`, which resolves to Ryu's own `~/.ryu/pi-agent`, never the
		// user's `~/.pi`; (b) the function that ships it runs only from the flagship
		// spawn paths — both `ensure_managed_defaults()` call sites in the adapters
		// are `ryu`-prefixed, and bare `acp:pi` (`pi_acp_cmd_gated`) is not among
		// them.
		expect(anchor(PI_CONFIG_RS, "ensure_pi_mcp_extension()?;")).toBe(PRESENT);
		expect(
			anchor(
				PI_CONFIG_RS,
				'crate::sidecar::download_manager::ryu_dir().join("pi-agent")'
			)
		).toBe(PRESENT);

		const adapters = [
			rustSource(ACP_RS),
			rustSource("apps/core/src/sidecar/adapters/mod.rs"),
		].join("\n");
		const calls = adapters.match(/ensure_managed_defaults\(\)/g) ?? [];
		expect(calls).toHaveLength(2);
		expect(
			anchor(ACP_RS, "ryu_pi_acp_cmd: could not write managed Pi defaults")
		).toBe(PRESENT);
		expect(
			anchor(
				"apps/core/src/sidecar/adapters/mod.rs",
				"ryu fallback: could not write managed Pi defaults"
			)
		).toBe(PRESENT);
	});

	it("the bridge is decided once per pooled instance, not per turn", () => {
		// The premise under `TAKES_EFFECT_TOOLS`. Unlike egress, this decision does
		// not change the spawn command, so it does not change the pool key and a
		// warm instance is REUSED with its old bridge until it closes.
		expect(anchor(ACP_RS, "let bridge_spawn_cmd = spawn_cmd.clone();")).toBe(
			PRESENT
		);
		expect(
			anchor(
				ACP_RS,
				"tokio::time::timeout(std::time::Duration::from_secs(600), rx)"
			)
		).toBe(PRESENT);
		expect(anchor(ACP_RS, "pool.retain(|_, turns| !turns.is_closed());")).toBe(
			PRESENT
		);
	});
});

describe("the two gates are independent, in both directions", () => {
	it("declining the credential swap does not withhold tools", () => {
		// THE regression. Before the split this row would have had no tools at all,
		// which is why a freshly installed ACP agent could not do anything.
		const row = classify({ id: "acp:gemini", engine: "acp:gemini" });
		expect(row.governed).toBe(false);
		expect(row.tools.enabled).toBe(true);
		expect(row.tools.mechanism).toBe("mcp-bridge");
	});

	it("routing egress through the gateway does not force tools on", () => {
		const row = classify(
			{ id: "agt_byo", engine: "acp-exec:my-agent" },
			{ agents: { agt_byo: true }, tools: { agt_byo: false } }
		);
		expect(row.governed).toBe(true);
		expect(row.tools.enabled).toBe(false);
		expect(row.tools.control).toEqual({ agentId: "agt_byo" });
	});

	it("the tool half reads its OWN map, never the egress map", () => {
		// A `Pick<EgressPrefs, "tools">` parameter makes the wrong read a type
		// error; this pins the behaviour so a widening of that type is still caught.
		const row = classify(
			{ id: "agt_byo", engine: "acp-exec:my-agent" },
			{ agents: { agt_byo: false } }
		);
		expect(row.governed).toBe(false);
		expect(row.tools.enabled).toBe(true);
	});

	it("an explicit opt-out is honoured and is the only way to be off", () => {
		const row = classify(
			{ id: "acp:codex", engine: "acp:codex" },
			{ tools: { "acp:codex": false } }
		);
		expect(row.tools.enabled).toBe(false);
		expect(row.tools.detail).toContain("withheld");
	});
});

describe("who has a tool control, which is NOT who has an egress control", () => {
	it("an agent Core cannot egress-route still takes the bridge", () => {
		// `acp:gemini` is `gateway_bypass: true` — no egress switch — yet its spawn
		// command is not pi-acp, so the bridge works fine. Deriving the tool column
		// from `gatewayBypass` would strip tools from this agent for no reason.
		const row = classify({ id: "acp:gemini", engine: "acp:gemini" });
		expect(row.control).toBeNull();
		expect(row.tools.control).toEqual({ agentId: "acp:gemini" });
	});

	it("bare acp:pi is the exact inverse — settable egress, impossible tools", () => {
		const row = classify({ id: "acp:pi", engine: "acp:pi" });
		expect(row.control).toEqual({ agentId: "acp:pi", kind: "agent" });
		expect(row.tools.control).toBeNull();
		expect(row.tools.mechanism).toBe("pi-no-bridge");
		// `false`, not `null`: this is a known absence, not an unanswerable
		// question, and it is the answer to "why does my Pi ignore Ryu's tools".
		expect(row.tools.enabled).toBe(false);
		expect(row.tools.detail).toContain("Use the Ryu agent");
	});

	it("the flagship has tools but no switch, and says where they come from", () => {
		const row = classify({ id: "ryu", engine: "ryu", flagship: true });
		expect(row.tools.mechanism).toBe("pi-extension");
		expect(row.tools.enabled).toBe(true);
		expect(row.tools.control).toBeNull();
		expect(row.tools.detail).toContain("Pi extension");
	});

	it("a BYO command that runs pi-acp gets no tool control either", () => {
		// Core matches the substring in the spawn command, and a BYO `acp-exec:`
		// engine IS that command, so the desktop can mirror it exactly here.
		const row = classify({ id: "agt_byo", engine: "acp-exec:npx pi-acp" });
		expect(row.tools.control).toBeNull();
		expect(row.tools.mechanism).toBe("pi-no-bridge");
	});

	it("a BYO command that does not run pi-acp does", () => {
		const row = classify({ id: "agt_byo", engine: "acp-exec:my-agent" });
		expect(row.tools.control).toEqual({ agentId: "agt_byo" });
		expect(row.tools.mechanism).toBe("mcp-bridge");
	});

	it("a CUSTOM agent bound to the `ryu` engine gets no tools and no switch", () => {
		// The reachable hole: the agent editor offers every installed agent as an
		// engine, so `engine: "ryu"` on a custom record is a thing a user can save.
		// Core's flagship branch keys on the AGENT id (`agent_id == "ryu"`), which
		// this record fails, so it resolves to the `ryu` registry entry's bare
		// `pi_acp_cmd()` — pi-acp with no `PI_CODING_AGENT_DIR`, which is Core's
		// `RyuToolAccess::None`. Not `pi-extension`: the managed extension is only
		// loaded by a Pi spawned against Ryu's own config dir.
		const row = classify({ id: "agt_custom", engine: "ryu" });
		expect(row.tools.mechanism).toBe("pi-no-bridge");
		expect(row.tools.enabled).toBe(false);
		expect(row.tools.control).toBeNull();
		// And the flagship itself is still the extension case, so the new clause
		// did not swallow it.
		const flagship = classify({ id: "ryu", engine: "ryu", flagship: true });
		expect(flagship.tools.mechanism).toBe("pi-extension");
	});

	it("the three ACP mechanisms are Core's three RyuToolAccess cases", () => {
		// Core classifies this itself (`acp::RyuToolAccess`), served as
		// `ryuToolAccess` on `GET /api/agents/:id/acp-config`. That endpoint SPAWNS
		// the agent to probe it, so a list of every installed agent cannot call it
		// — this file reconstructs the pure spawn-command part instead. These
		// anchors are what keep the reconstruction honest: if Core's taxonomy
		// changes, the mirror has to be revisited rather than quietly diverging.
		expect(anchor(ACP_RS, "pub enum RyuToolAccess")).toBe(PRESENT);
		expect(anchor(ACP_RS, 'Self::Bridge => "bridge",')).toBe(PRESENT);
		expect(anchor(ACP_RS, 'Self::PiExtension => "pi-extension",')).toBe(
			PRESENT
		);
		expect(anchor(ACP_RS, 'Self::None => "none",')).toBe(PRESENT);
		// The PiExtension term is the second substring this file mirrors: only a Pi
		// spawned against Ryu's managed config dir loads `ryu-mcp.ts`.
		expect(anchor(ACP_RS, 'if spawn_cmd.contains("PI_CODING_AGENT_DIR")')).toBe(
			PRESENT
		);
	});

	it("a non-ACP route is `null`, never rendered as 'no tools'", () => {
		for (const [id, engine] of [
			["zeroclaw", "zeroclaw"],
			["agt_local", "ollama"],
			["agt_x", "nope"],
		] as const) {
			const row = classify({ id, engine });
			expect(`${id}:${row.tools.enabled}`).toBe(`${id}:null`);
			expect(row.tools.mechanism).toBe("not-acp");
			expect(row.tools.control).toBeNull();
		}
	});
});

describe("the tool counters partition the rows too", () => {
	const rows = () => [
		classify({ id: "ryu", engine: "ryu", flagship: true }),
		classify({ id: "acp:claude", engine: "acp:claude" }, { claude: false }),
		classify({ id: "acp:gemini", engine: "acp:gemini" }),
		classify({ id: "acp:pi", engine: "acp:pi" }),
		classify({ id: "zeroclaw", engine: "zeroclaw" }),
		classify({ id: "agt_local", engine: "mlx" }),
		classify(
			{ id: "agt_off", engine: "acp-exec:x" },
			{ tools: { agt_off: false } }
		),
	];

	it("every row lands in exactly one tool counter", () => {
		const view = summarizeAgentEgress(rows());
		expect(view.toolsOnCount + view.toolsOffCount + view.toolsOtherCount).toBe(
			view.rows.length
		);
	});

	it("the tool counters do not track the egress counters", () => {
		// If the two partitions ever agree row-for-row, one is being derived from
		// the other — the exact conflation this split removed.
		const view = summarizeAgentEgress(rows());
		expect(view.toolsOnCount).not.toBe(view.governedCount);
		// ryu (extension) + direct-egress claude + gemini = 3 with tools; pi + the
		// opt-out = 2 without; zeroclaw + the local engine = 2 not applicable.
		expect(view.toolsOnCount).toBe(3);
		expect(view.toolsOffCount).toBe(2);
		expect(view.toolsOtherCount).toBe(2);
	});
});

describe("describeToolBadge keeps the two layers' words apart", () => {
	it("never reuses an egress label for a tool state", () => {
		const rows = [
			classify({ id: "ryu", engine: "ryu", flagship: true }),
			classify({ id: "acp:gemini", engine: "acp:gemini" }),
			classify({ id: "acp:pi", engine: "acp:pi" }),
			classify({ id: "zeroclaw", engine: "zeroclaw" }),
			classify(
				{ id: "agt_off", engine: "acp-exec:x" },
				{ tools: { agt_off: false } }
			),
		];
		const egressLabels = new Set(
			rows.map((row) => describeEgressBadge(row).label)
		);
		for (const row of rows) {
			const label = describeToolBadge(row).label;
			// A shared word between the columns is how a reader concludes one
			// badge is reporting both.
			expect(`${row.agentId}:${egressLabels.has(label)}`).toBe(
				`${row.agentId}:false`
			);
		}
	});

	it("gives the flagship its own pill, because it has no control", () => {
		const row = classify({ id: "ryu", engine: "ryu", flagship: true });
		expect(describeToolBadge(row).label).toBe("Tools via Pi extension");
		const bridged = classify({ id: "acp:gemini", engine: "acp:gemini" });
		expect(describeToolBadge(bridged).label).toBe("Ryu tools on");
	});

	it("separates 'switched off' from 'cannot take tools'", () => {
		const off = classify(
			{ id: "agt_off", engine: "acp-exec:x" },
			{ tools: { agt_off: false } }
		);
		expect(describeToolBadge(off).label).toBe("Ryu tools off");
		const impossible = classify({ id: "acp:pi", engine: "acp:pi" });
		expect(describeToolBadge(impossible).label).toBe("Can't take tools");
	});

	it("hedges a just-saved value, in its own words and its own window", () => {
		const row = classify({ id: "acp:gemini", engine: "acp:gemini" });
		const on = describeToolBadge(row, true);
		expect(on.label).toBe("Tools on in new chats");
		expect(on.pendingStart).toBe(true);
		const off = describeToolBadge(row, false);
		expect(off.label).toBe("Tools off in new chats");
		expect(off.pendingStart).toBe(true);
	});

	it("does not hedge a row with no bridge to rebuild", () => {
		const row = classify({ id: "acp:pi", engine: "acp:pi" });
		expect(row.tools.takesEffect).toBeNull();
		expect(describeToolBadge(row, true).pendingStart).toBe(false);
	});

	it("the tool timing sentence is NOT the egress one", () => {
		// Two different stale windows: egress changes the pool key so the next
		// message respawns; the bridge does not, so a live chat keeps its tools
		// until the instance idles out. One sentence for both would be false for
		// whichever it was not written about.
		const row = classify({ id: "acp:gemini", engine: "acp:gemini" });
		const byo = classify({ id: "agt_byo", engine: "acp-exec:x" });
		expect(row.tools.takesEffect).not.toBe(byo.takesEffect);
		expect(row.tools.takesEffect).toContain("new chats");
		expect(byo.takesEffect).toBe(
			"Takes effect the next time the agent starts."
		);
	});
});

describe("the bulk action shows its work and never touches egress", () => {
	const view = () =>
		summarizeAgentEgress([
			classify({ id: "ryu", engine: "ryu", flagship: true }),
			classify({ id: "acp:pi", engine: "acp:pi" }),
			classify({ id: "zeroclaw", engine: "zeroclaw" }),
			classify(
				{ id: "agt_off", engine: "acp-exec:x" },
				{ tools: { agt_off: false } }
			),
			classify({ id: "acp:gemini", engine: "acp:gemini" }),
		]);

	it("changes only the rows that would actually change", () => {
		const plan = planEnableToolsForAll(view());
		expect(plan.changes.map((c) => c.agentId)).toEqual(["agt_off"]);
		expect(plan.changes[0]).toMatchObject({ from: false, to: true });
	});

	it("enumerates the skipped agents WITH a reason, rather than hiding them", () => {
		// A preview that silently omits the agents it cannot help lets the user
		// believe the click covered everything — and the flagship + `acp:pi` skips
		// are the ones most worth reading.
		const plan = planEnableToolsForAll(view());
		expect(plan.skipped.map((s) => s.agentId).sort()).toEqual([
			"acp:pi",
			"ryu",
			"zeroclaw",
		]);
		for (const skip of plan.skipped) {
			expect(`${skip.agentId}:${skip.reason.length > 0}`).toBe(
				`${skip.agentId}:true`
			);
		}
		const pi = plan.skipped.find((s) => s.agentId === "acp:pi");
		expect(pi?.reason).toContain("Cannot take Ryu's tools");
	});

	it("declares that model traffic is untouched, so the UI must say it", () => {
		// The safety property of the whole feature: a one-click "configure every
		// agent" that flipped egress would re-point a Claude Pro sign-in at the
		// gateway and move where that spend is counted, for every agent, from one
		// button. `egressUntouched` is a constant precisely so removing it is a
		// review-visible act.
		expect(planEnableToolsForAll(view()).egressUntouched).toBe(true);
	});

	it("a plan carries no egress control at all", () => {
		// Structural, not incidental: every entry a plan can produce is keyed only
		// by agent id and lands in the tool-bridge map.
		const plan = planEnableToolsForAll(view());
		for (const change of plan.changes) {
			expect(Object.keys(change).sort()).toEqual([
				"agentId",
				"from",
				"name",
				"to",
			]);
		}
	});

	it("re-planning after a full apply has nothing left to do", () => {
		const settled = summarizeAgentEgress([
			classify({ id: "acp:gemini", engine: "acp:gemini" }),
			classify(
				{ id: "agt_on", engine: "acp-exec:x" },
				{ tools: { agt_on: true } }
			),
		]);
		expect(planEnableToolsForAll(settled).changes).toHaveLength(0);
	});

	it("an empty plan writes nothing and still succeeds", async () => {
		// No fetch is stubbed here on purpose: if the short-circuit regressed, this
		// test would attempt a real request and fail rather than pass silently.
		const empty: ToolBridgePlan = {
			changes: [],
			egressUntouched: true,
			skipped: [],
		};
		expect(
			await applyToolBridgePlan(
				{ url: "http://127.0.0.1:1/", token: null, userJwt: null },
				empty
			)
		).toBe(true);
	});

	it("can also be planned in the OFF direction, with the same shape", () => {
		const plan = planEnableToolsForAll(view(), false);
		expect(plan.changes.map((c) => c.agentId).sort()).toEqual(["acp:gemini"]);
		expect(plan.egressUntouched).toBe(true);
	});
});
