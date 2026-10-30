// apps/desktop/src/lib/api/agent-egress-tool-bridge.ts
//
// Split out of `agent-egress.ts`; import from there. See that module's header.

import { isNativeBoolean } from "@ryu/ui/lib/native-primitive-observation.ts";
import {
	runsLimitedOnManagedPi,
	runsOnRyuEngine,
} from "@/src/lib/agent-engine.ts";
import { TAKES_EFFECT_TOOLS } from "./agent-egress-constants.ts";
import type {
	AgentToolBridge,
	EgressAgentInput,
	EgressMechanism,
	EgressPrefs,
} from "./agent-egress-types.ts";
import type { AgentCatalogEntry } from "./agents.ts";
import { DEFAULT_AGENT_TOOL_BRIDGE } from "./preferences.ts";

// ── Layer 3: the MCP tool bridge ─────────────────────────────────────────────
//
// Core's decision is `acp_tool_bridge_enabled(spawn_cmd, agent_id)` =
// `acp_bridge_supported(spawn_cmd) && is_tool_bridge_enabled(agent_id)`.
// TWO terms, and the desktop must mirror both or it will print a preference value
// over an agent Core will never bridge.
//
// ── Why this mirrors rather than reads Core's own answer ─────────────────────
// Core DOES classify this itself: `acp::RyuToolAccess` (`bridge` | `pi-extension`
// | `none`) is served as `ryuToolAccess`. The three cases are the same three
// {@link ToolBridgeMechanism} names an ACP agent can take here, deliberately —
// they were derived from the same two spawn-command substrings.
//
// It is not consumed here because of WHERE it is served: `GET /api/agents/:id/
// acp-config`, whose handler calls `probe_acp_config`, which SPAWNS the agent and
// opens a throwaway ACP session to read its advertisement. That is a subprocess
// per agent — acceptable for one agent's editor, not for a settings list that
// renders every installed agent at once. So this file reconstructs the pure part
// (`ryu_tool_access` is explicitly "derived from the spawn command alone") from
// catalog data already in hand, and the four mirror tests below pin it to Core.
//
// If Core ever puts `ryuToolAccess` on the cheap `GET /api/agents/catalog`, delete
// `runsPiAcp` and read the field — a mirror living next to a served answer is the
// same drift trap this module's header records about the deleted
// `src/lib/agent-gateway.ts`.

/**
 * Mirror of Core's `acp_bridge_supported`: `!spawn_cmd.contains("pi-acp")`.
 *
 * The desktop never sees a spawn command, so this reconstructs the same set from
 * catalog data it already fetches. Three ways an agent ends up running `pi-acp`:
 *
 *   1. the flagship `ryu` — `AcpAgentEntry { id: "ryu", transport: Acp { spawn_cmd:
 *      pi_acp_cmd() } }`, wrapped by `ryu_pi_acp_cmd` at routing time;
 *   2. `acp:pi` — the same `pi_acp_cmd()`, and the only registry entry carrying
 *      `registry_id: Some("pi-acp")`;
 *   3. a BYO `acp-exec:<command>` whose command literally runs pi-acp, which Core
 *      matches by the same substring test.
 *
 * **This is NOT `gatewayBypass`, and the two sets genuinely differ** — mixing them
 * up is the single easiest way to get this wrong. `acp:gemini` is
 * `gateway_bypass: true` (Core cannot redirect its model calls) yet takes the tool
 * bridge fine; `acp:pi` is `gateway_bypass: false` (its egress IS settable) yet can
 * never take the bridge. Neither field substitutes for the other.
 */
function runsPiAcp(
	agentId: string,
	engine: string,
	flagship: boolean,
	entry: AgentCatalogEntry | null
): boolean {
	// A built-in bot on Ryu's engine (Jay Jr.) is routed by AGENT id to the same
	// managed Pi as the flagship (`agent_route` checks it before the engine), so
	// its spawn is the flagship's pi-acp bridge whatever its catalog entry says.
	if (flagship || agentId === "ryu" || runsOnRyuEngine(agentId)) {
		return true;
	}
	if (engine.startsWith("acp-exec:")) {
		return engine.includes("pi-acp");
	}
	// `entry.id === "ryu"` matters and is NOT covered by the flagship check above:
	// the agent editor offers every installed agent as an engine, so a CUSTOM agent
	// can be bound to `engine: "ryu"`. Its id is not `"ryu"` and Core sets
	// `recommended` only on the registry entry, so `flagship` is false — yet
	// `agent_route` matches `agent_id == "ryu"` on the AGENT id, which a custom
	// agent fails, dropping it to the registry entry whose transport is the bare
	// `pi_acp_cmd()`. That command carries `pi-acp` and no `PI_CODING_AGENT_DIR`,
	// which is Core's `RyuToolAccess::None`: no bridge and no extension either.
	// Without this clause the row would offer a switch Core's transport guard can
	// never honour — the dead control this module refuses everywhere else.
	return (
		entry?.registryId === "pi-acp" ||
		entry?.id === "acp:pi" ||
		entry?.id === "ryu"
	);
}

/**
 * The stored tool-bridge value for an agent, folding in Core's ON default.
 *
 * Split out and named because the default is the whole fix: a missing entry is
 * the state EVERY agent is in until someone touches this panel, so getting it
 * wrong here would mis-report the common case rather than an edge one.
 */
function storedToolBridge(
	agentId: string,
	tools: Record<string, boolean>
): boolean {
	const stored = tools[agentId];
	return isNativeBoolean(stored) ? stored : DEFAULT_AGENT_TOOL_BRIDGE;
}

/**
 * Classify how Ryu's tools reach one agent — the layer-3 half of a row.
 *
 * Pure, and takes the already-resolved catalog `entry` so it cannot disagree with
 * {@link classifyAgentEgress} about which registry entry an engine resolved to.
 */
export function classifyToolBridge(
	agent: EgressAgentInput,
	entry: AgentCatalogEntry | null,
	// `Pick`, not the whole `EgressPrefs`: this half must be structurally unable
	// to read an egress preference. The bug being fixed was one gate consulting
	// the other's value, so the type is where that is made impossible rather than
	// only discouraged in a comment.
	prefs: Pick<EgressPrefs, "tools">,
	egressMechanism: EgressMechanism
): AgentToolBridge {
	const engine = agent.engine?.trim() || agent.id;
	const flagship = agent.flagship || agent.id === "ryu";

	if (runsPiAcp(agent.id, engine, flagship, entry)) {
		// A built-in bot on Ryu's engine runs the same managed Pi, so it gets
		// Ryu's tools through the same extension — but only the ones its own
		// allowlist names, and none of Pi's built-in shell or file tools (Core
		// starts that Pi with only the brokered Ryu tools active).
		if (!flagship && runsOnManagedPiAsItself(agent)) {
			return {
				mechanism: "pi-extension",
				enabled: true,
				control: null,
				takesEffect: null,
				detail:
					"Runs on the Ryu agent's engine and gets Ryu's tools from the same Pi extension, limited to the tools this agent allows. There is nothing to turn on here.",
			};
		}
		// The flagship still HAS Ryu's tools — via a different mechanism entirely.
		// `pi_config::ensure_pi_mcp_extension` ships `ryu-mcp.ts` into the MANAGED
		// config dir (`~/.ryu/runtimes/pi-agent/extensions/`), and that extension POSTs to
		// Core's HTTP tool API. Saying "no tools" here would be false in the most
		// damaging possible place: the default agent, on every fresh install.
		if (flagship) {
			return {
				mechanism: "pi-extension",
				enabled: true,
				control: null,
				takesEffect: null,
				detail:
					"Has Ryu's tools, but not through this switch — the Ryu agent gets them from a Pi extension Ryu installs into its own config folder. There is nothing to turn on here.",
			};
		}
		// Bare `acp:pi` (and a BYO command running pi-acp) get NEITHER: pi-acp
		// advertises no MCP-server support so Core skips the bridge, and
		// `ensure_pi_mcp_extension` writes only into Ryu's managed folder — its
		// doc comment is explicit that it "never touches the user's `~/.pi`".
		// This is the answer to "why does my Pi agent ignore every Ryu tool", and
		// it has to be readable HERE, not discovered when a tool call never happens.
		return {
			mechanism: "pi-no-bridge",
			enabled: false,
			control: null,
			takesEffect: null,
			detail:
				"Ryu cannot give this one tools. Pi accepts no tool server over ACP, and the extension Ryu uses for its own agent is only installed into Ryu's managed Pi folder, not your own. Use the Ryu agent if you want Ryu's tools with Pi.",
		};
	}

	// Everything that is not an ACP session: a local engine, an SDK app, an
	// `openai_compat` registry agent Core forwards itself, or an engine Core
	// cannot resolve. None of them build an ACP session, so this preference has
	// nothing to act on — and claiming either answer would be inventing one.
	if (
		egressMechanism === "local-engine" ||
		egressMechanism === "gateway-forward" ||
		egressMechanism === "unresolved"
	) {
		return {
			mechanism: "not-acp",
			enabled: null,
			control: null,
			takesEffect: null,
			detail:
				"Not an ACP agent, so this switch does not apply — whatever tools it has are decided by how it is run, not here.",
		};
	}

	const enabled = storedToolBridge(agent.id, prefs.tools);
	return {
		mechanism: "mcp-bridge",
		enabled,
		control: { agentId: agent.id },
		takesEffect: TAKES_EFFECT_TOOLS,
		detail: enabled
			? "Ryu's tools are offered to this agent — exactly the tools its own allowlist permits, re-checked on every call."
			: "Ryu's tools are withheld from this agent. It runs with only whatever tools it brings itself.",
	};
}

/** Whether Core routes `agent` to Ryu's managed Pi under its own identity. */
export function runsOnManagedPiAsItself(agent: EgressAgentInput): boolean {
	return (
		runsOnRyuEngine(agent.id) ||
		runsLimitedOnManagedPi(agent.id, agent.engine, agent.modelsLimited === true)
	);
}
