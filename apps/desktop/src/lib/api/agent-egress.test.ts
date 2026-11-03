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
// describe blocks (agent-egress.tool-bridge.test.ts and
// agent-egress.ryu-engine.test.ts) exist because the two verdicts must never be
// derived from one another. Their inert sets are close to inverted: `acp:gemini`
// cannot be egress-routed but takes the bridge; `acp:pi` can be egress-routed but
// can never take the bridge. When these two were ONE preference, declining the
// credential swap silently withheld every Ryu tool, which is why a freshly
// installed ACP agent did not work out of the box.

//
// The suite is split across agent-egress*.test.ts files that share
// agent-egress.test-support.ts; the timing caveats are agent-egress.timing.test.ts.

import { describe, expect, it } from "bun:test";
import {
	ACP_GATEWAY_CMDS_RS,
	ACP_REGISTRY_RS,
	AGENT_EGRESS_TS,
	AGENT_ROUTE_RS,
	anchor,
	classify,
	PRESENT,
	prefs,
	rustSource,
	tl,
} from "./agent-egress.test-support.ts";
import { classifyAgentEgress, summarizeAgentEgress } from "./agent-egress.ts";

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
		expect(anchor(ACP_GATEWAY_CMDS_RS, "recommended: false,")).toBe(PRESENT);
		const source = ACP_REGISTRY_RS.map(rustSource).join("\n");
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
				AGENT_ROUTE_RS,
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
				AGENT_ROUTE_RS,
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
				"apps/core/src/sidecar/adapters/acp/registry_lookup.rs",
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
				prefs({}),
				tl
			);
			expect(`${engine}:${row.mechanism}`).toBe(`${engine}:local-engine`);
		}
		expect(listed.length).toBeGreaterThan(0);
	});
});

// ── Classifier ───────────────────────────────────────────────────────────────

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

	it("FreeToken is classified as a local engine", () => {
		const row = classify({ id: "agt_freetoken", engine: "freetoken" });
		expect(row.mechanism).toBe("local-engine");
		expect(row.governed).toBeNull();
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
