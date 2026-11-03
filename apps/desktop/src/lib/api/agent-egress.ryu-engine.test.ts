// apps/desktop/src/lib/api/agent-egress.ryu-engine.test.ts
//
// Part of the agent-egress suite; see agent-egress.test.ts for the doctrine.
// Rows for built-in bots and limited custom agents on the Ryu engine, and the
// tool counters, badges and bulk action over the bridge layer.

import { describe, expect, it } from "bun:test";
import { runsLimitedOnManagedPi, runsOnRyuEngine } from "../agent-engine.ts";
import {
	AGENT_ROUTE_RS,
	anchor,
	CATALOG,
	classify,
	entry,
	PRESENT,
	prefs,
	tl,
} from "./agent-egress.test-support.ts";
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

describe("a built-in bot on Ryu's engine is the flagship's route, not an engine's", () => {
	// Core's own catalog lists `jay-jr` as an ordinary ACP entry (transport acp,
	// gatewayBypass false). Without its own branch the classifier would land on
	// the generic base-URL switch and the MCP-bridge switch, neither of which
	// Core reads for it.
	const JAY_CATALOG = [...CATALOG, entry({ id: "jay-jr" })];
	const jay = (over: Partial<EgressPrefs> = {}): AgentEgress =>
		classifyAgentEgress(
			{ id: "jay-jr", name: "Jay Jr.", engine: "jay-jr", flagship: false },
			JAY_CATALOG,
			prefs(over),
			tl
		);

	it("mirrors Core's id set and its agent_route branch", () => {
		expect(runsOnRyuEngine("jay-jr")).toBe(true);
		expect(runsOnRyuEngine("patrol")).toBe(true);
		expect(runsOnRyuEngine("ryu")).toBe(false);
		expect(runsOnRyuEngine("acp:pi")).toBe(false);
		expect(
			anchor(
				"apps/core/src/agents/jay_jr.rs",
				'pub const AGENT_ID: &str = "jay-jr";'
			)
		).toBe(PRESENT);
		expect(
			anchor(
				"apps/core/src/agents/jay_jr.rs",
				"pub fn runs_on_ryu_engine(agent_id: &str) -> bool { agent_id == AGENT_ID }"
			)
		).toBe(PRESENT);
		expect(
			anchor(
				"apps/core/src/agents/patrol.rs",
				'pub const AGENT_ID: &str = "patrol";'
			)
		).toBe(PRESENT);
		expect(
			anchor(
				"apps/core/src/agents/mod.rs",
				"pub fn runs_on_ryu_engine(agent_id: &str) -> bool { jay_jr::runs_on_ryu_engine(agent_id) || patrol::is_patrol(agent_id) }"
			)
		).toBe(PRESENT);
		expect(
			anchor(
				AGENT_ROUTE_RS,
				'agent_id.filter(|id| *id == "ryu" || crate::agents::runs_on_ryu_engine(id))'
			)
		).toBe(PRESENT);
	});

	it("follows the managed Pi's routing with no switch, in both directions", () => {
		const governed = jay();
		expect(governed.mechanism).toBe("pi-provider");
		expect(governed.governed).toBe(true);
		expect(governed.control).toBeNull();
		expect(governed.detail).toContain("Ryu agent's model settings");

		// The case the generic switch would have lied about: the managed Pi set
		// to the user's own provider key sends this bot's calls direct too.
		const direct = jay({ piRouting: "direct", agents: { "jay-jr": true } });
		expect(direct.governed).toBe(false);
		expect(direct.control).toBeNull();
	});

	it("gets Ryu's tools from the Pi extension, scoped, with no bridge switch", () => {
		const row = jay({ tools: { "jay-jr": false } });
		expect(row.tools.mechanism).toBe("pi-extension");
		expect(row.tools.enabled).toBe(true);
		expect(row.tools.control).toBeNull();
		expect(row.tools.detail).toContain(
			"limited to the tools this agent allows"
		);
		// And the bulk action skips it rather than writing a preference Core
		// never reads for it.
		const plan = planEnableToolsForAll(summarizeAgentEgress([row]));
		expect(plan.changes).toHaveLength(0);
		expect(plan.skipped.map((skip) => skip.agentId)).toEqual(["jay-jr"]);
	});
});

describe("a limited custom agent on the Ryu engine runs Ryu's managed Pi", () => {
	const custom = (
		modelsLimited: boolean,
		over: Partial<EgressPrefs> = {}
	): AgentEgress =>
		classifyAgentEgress(
			{
				id: "agent-a",
				name: "Agent A",
				engine: "acp:pi",
				flagship: false,
				modelsLimited,
			},
			CATALOG,
			prefs(over),
			tl
		);

	it("mirrors Core's predicate and its agent_route branch", () => {
		expect(runsLimitedOnManagedPi("agent-a", "acp:pi", true)).toBe(true);
		expect(runsLimitedOnManagedPi("agent-a", "acp:pi", false)).toBe(false);
		expect(runsLimitedOnManagedPi("acp:pi", "acp:pi", true)).toBe(false);
		expect(runsLimitedOnManagedPi("jay-jr", "acp:pi", true)).toBe(false);
		expect(runsLimitedOnManagedPi("agent-a", "acp:claude", true)).toBe(false);
		expect(
			anchor(
				AGENT_ROUTE_RS,
				".filter(|id| crate::agents::runs_limited_on_managed_pi(id, engine, provider_access))"
			)
		).toBe(PRESENT);
	});

	it("follows the managed Pi's routing and gets its scoped extension tools", () => {
		const row = custom(true);
		expect(row.mechanism).toBe("pi-provider");
		expect(row.governed).toBe(true);
		expect(row.control).toBeNull();
		expect(row.tools.mechanism).toBe("pi-extension");
		expect(row.tools.detail).toContain(
			"limited to the tools this agent allows"
		);
		expect(custom(true, { piRouting: "direct" }).governed).toBe(false);
	});

	it("leaves an unrestricted one on your own Pi, as before", () => {
		const limited = custom(true);
		const unrestricted = custom(false);
		expect(unrestricted.mechanism).not.toBe(limited.mechanism);
		expect(unrestricted.tools.mechanism).not.toBe("pi-extension");
		expect(unrestricted).toEqual(
			classifyAgentEgress(
				{ id: "agent-a", name: "Agent A", engine: "acp:pi", flagship: false },
				CATALOG,
				prefs({}),
				tl
			)
		);
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
