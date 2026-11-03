// apps/desktop/src/lib/api/agent-egress.timing.test.ts
//
// Part of the agent-egress suite; see agent-egress.test.ts for the doctrine.
//
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

import { describe, expect, it } from "bun:test";
import {
	ACP_GATEWAY_CMDS_RS,
	AGENT_EDIT_TSX,
	AGENT_EGRESS_TS,
	anchor,
	classify,
	PRESENT,
	RYU_ROUTE_RS,
	repoSource,
} from "./agent-egress.test-support.ts";
import { type AgentEgress, describeEgressBadge } from "./agent-egress.ts";

describe("the spawn-time premise the timing caveat rests on", () => {
	it("each family's routing is baked into its spawn configuration", () => {
		// If any of these stopped returning a *different command string* — say one
		// started writing a config file a live agent re-reads — that family would no
		// longer need the caveat, and a caveat nobody needs is the fastest way to
		// teach a reader to skip the ones that matter.
		expect(
			anchor(ACP_GATEWAY_CMDS_RS, '"ANTHROPIC_BASE_URL={base_url} {spawn_cmd}"')
		).toBe(PRESENT);
		expect(
			anchor(
				ACP_GATEWAY_CMDS_RS,
				`acp_spawn_with_env(
                    spawn_cmd,
                    vec![
                        ("OPENAI_BASE_URL".to_owned(), gateway_v1),
                        ("OPENAI_API_KEY".to_owned(), token),
                    ],
                )`
			)
		).toBe(PRESENT);
		expect(
			anchor(
				ACP_GATEWAY_CMDS_RS,
				"\"CODEX_HOME='{}' npx -y @zed-industries/codex-acp\""
			)
		).toBe(PRESENT);
		// The flagship injects the Gateway into the structured spawn environment.
		expect(
			anchor(
				RYU_ROUTE_RS,
				'env.push(("OPENAI_BASE_URL".to_owned(), gateway_v1));'
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
				"apps/core/src/sidecar/adapters/acp/pool_key.rs",
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
