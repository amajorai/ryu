// apps/desktop/src/lib/api/agent-egress.tool-bridge.test.ts
//
// Part of the agent-egress suite; see agent-egress.test.ts for the doctrine.
//
// ── Layer 3: the MCP tool bridge ─────────────────────────────────────────────
//
// A fourth failure this file now guards, and the one that shipped: reporting an
// agent's TOOL access from its EGRESS setting. The two gates were one preference
// until `agent_routing`'s split, and their sets of "inert" agents are not merely
// different — they are close to inverted (`acp:gemini` cannot be egress-routed
// but takes the bridge; `acp:pi` can be egress-routed but can never take the
// bridge). Any mirror that derives one from the other is wrong for both.

import { describe, expect, it } from "bun:test";
import {
	ACP_PI_CMD_RS,
	ACP_TOOL_ACCESS_RS,
	AGENT_ROUTING_RS,
	adapterSources,
	anchor,
	classify,
	PI_CONFIG_RS,
	PRESENT,
	RYU_ROUTE_RS,
} from "./agent-egress.test-support.ts";

describe("the tool bridge's two terms, mirrored from Core", () => {
	it("the transport term is the pi-acp substring test this file reproduces", () => {
		// `runsPiAcp` in agent-egress.ts reconstructs this set from catalog data.
		// If Core stops keying on the spawn command, the reconstruction is wrong
		// in a way nothing else would catch — the desktop never sees a spawn cmd.
		expect(
			anchor(
				ACP_TOOL_ACCESS_RS,
				"fn acp_bridge_supported(spawn_cmd: &str) -> bool"
			)
		).toBe(PRESENT);
		expect(anchor(ACP_TOOL_ACCESS_RS, '!spawn_cmd.contains("pi-acp")')).toBe(
			PRESENT
		);
	});

	it("the preference term is ANDed with the transport term, transport first", () => {
		// Order matters to the mirror: because the transport guard short-circuits,
		// a pi-acp agent is answered WITHOUT consulting the preference at all. That
		// is why this view shows those agents a state rather than a switch — the
		// switch would be settable and permanently inert.
		expect(
			anchor(
				ACP_TOOL_ACCESS_RS,
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

	it("ships through managed spawn paths and defaults to an isolated directory", () => {
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
		// `config_dir()`, whose runtime admission helper defaults to Ryu's own
		// `~/.ryu/runtimes/pi-agent` (an explicit managed-root override can change it);
		// (b) the function that ships it runs only from the flagship
		// spawn paths — both `ensure_managed_defaults()` call sites in the adapters
		// are `ryu`-prefixed, and bare `acp:pi` (`pi_acp_cmd_gated`) is not among
		// them.
		expect(anchor(PI_CONFIG_RS, "ensure_pi_mcp_extension()?;")).toBe(PRESENT);
		expect(
			anchor(
				PI_CONFIG_RS,
				"crate::required_update_runtime::pi_config_root( &crate::sidecar::download_manager::ryu_dir(), &crate::paths::config_dir(), )"
			)
		).toBe(PRESENT);
		expect(
			anchor(
				"apps/core/src/required_update_runtime.rs",
				'.unwrap_or_else(|| ryu_sidecar_runtime::layout::runtime_dir(data, "pi-agent"));'
			)
		).toBe(PRESENT);

		const adapters = adapterSources().join("\n");
		const calls = adapters.match(/ensure_managed_defaults\(\)/g) ?? [];
		expect(calls).toHaveLength(2);
		expect(
			anchor(
				ACP_PI_CMD_RS,
				"ryu_pi_acp_cmd: refusing stale managed Pi configuration"
			)
		).toBe(PRESENT);
		expect(
			anchor(
				RYU_ROUTE_RS,
				"ryu fallback: refusing stale managed Pi configuration"
			)
		).toBe(PRESENT);
	});

	it("the bridge is decided once per pooled instance, not per turn", () => {
		// The premise under `TAKES_EFFECT_TOOLS`. Unlike egress, this decision does
		// not change the spawn command, so it does not change the pool key and a
		// warm instance is REUSED with its old bridge until it closes.
		expect(
			anchor(
				"apps/core/src/sidecar/adapters/acp/serve_prepare.rs",
				"let bridge_spawn_cmd = spawn_cmd.clone();"
			)
		).toBe(PRESENT);
		expect(
			anchor(
				"apps/core/src/sidecar/adapters/acp/permission_waiters.rs",
				"tokio::time::timeout(std::time::Duration::from_secs(600), rx)"
			)
		).toBe(PRESENT);
		expect(
			anchor(
				"apps/core/src/sidecar/adapters/acp/spawn_launch.rs",
				"pool.retain(|_, entry| {"
			)
		).toBe(PRESENT);
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
		expect(anchor(ACP_TOOL_ACCESS_RS, "pub enum RyuToolAccess")).toBe(PRESENT);
		expect(anchor(ACP_TOOL_ACCESS_RS, 'Self::Bridge => "bridge",')).toBe(
			PRESENT
		);
		expect(
			anchor(ACP_TOOL_ACCESS_RS, 'Self::PiExtension => "pi-extension",')
		).toBe(PRESENT);
		expect(anchor(ACP_TOOL_ACCESS_RS, 'Self::None => "none",')).toBe(PRESENT);
		// The PiExtension term is the second substring this file mirrors: only a Pi
		// spawned against Ryu's managed config dir loads `ryu-mcp.ts`.
		expect(
			anchor(ACP_TOOL_ACCESS_RS, 'if spawn_cmd.contains("PI_CODING_AGENT_DIR")')
		).toBe(PRESENT);
	});

	it("a non-ACP route is `null`, never rendered as 'no tools'", () => {
		for (const [id, engine] of [
			["zeroclaw", "zeroclaw"],
			["agt_local", "ollama"],
			["agt_lemonade", "lemonade"],
			["agt_llama_swap", "llama-swap"],
			["agt_freetoken", "freetoken"],
			["agt_x", "nope"],
		] as const) {
			const row = classify({ id, engine });
			expect(`${id}:${row.tools.enabled}`).toBe(`${id}:null`);
			expect(row.tools.mechanism).toBe("not-acp");
			expect(row.tools.control).toBeNull();
		}
	});
});
