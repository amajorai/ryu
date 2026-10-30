// apps/desktop/src/lib/api/agent-egress.ts
//
// ONE honest answer to "is this agent's model traffic governed?", per installed
// agent.
//
// ── Why this file exists ──────────────────────────────────────────────────────
// Governing an ACP agent has four independent layers. Layer 1 — the model call
// itself traversing the Ryu gateway, so the firewall/DLP, the spend budget and
// the audit log see it — is NOT one setting. It is decided by four different
// mechanisms with different defaults, and until this module there was no
// place that showed the combined answer:
//
//   flagship `ryu`  → `apps/core/src/pi_config`   — gateway-routed unless the
//                     active Pi provider is a BYOK one. Default ON (a fresh
//                     node has no `x-ryu-routing` key and `is_gateway_routing()`
//                     treats anything but `"direct"` as gateway).
//   `acp:claude`    → `apps/core/src/claude_config` — governed by default; an
//                     explicit preference opts out to direct egress.
//   `acp:codex`     → `apps/core/src/codex_config`  — governed by default; an
//                     explicit preference opts out to direct egress.
//   everything else → `apps/core/src/agent_routing` — a per-agent JSON map read
//                     with a governed default; explicit false opts out.
//
// An agent with layer 1 off sends its model calls straight to the provider:
// unmetered, unfiltered, absent from the audit log. That is a legitimate choice
// (it is how you keep a subscription agent entirely outside Ryu egress) — but it
// is a *choice*, and it was invisible.
//
// ── Why the answer is not a boolean ───────────────────────────────────────────
// Core cannot redirect an agent it has no hook into. `AcpAgentEntry.gateway_bypass`
// is Core's own machine-readable declaration of exactly that ("agent does not
// honour OPENAI_BASE_URL — provider calls bypass the local gateway", see the
// `tracing::debug!` in `adapters/acp.rs`), and it is served on
// `GET /api/agents/catalog`. For those agents the generic `agent-gateway-routing`
// preference is writable but INERT — Core's own module doc calls it "a genuine
// no-op". Rendering a switch there would be a settable value that cannot take
// effect, and rendering "governed" after someone flipped it would be a status
// reporting healthy for a dead thing. So `gateway_bypass` agents get no control
// and an explicit "Ryu cannot route this one" state instead of a false negative.
//
// ── Replaced `src/lib/agent-gateway.ts`, which is now DELETED ─────────────────
// `apps/desktop/src/lib/agent-gateway.ts` and `hooks/useAgentGatewayGovernance.ts`
// were a committed earlier attempt at the same mapping that NOTHING consumed —
// the hook was the only importer of the lib, and no component imported the hook.
// Both are gone; this module is the single source of truth. They are recorded
// here so the pair is not reconstructed from memory, because their
// `isAgentGatewayGoverned` carried the two defects this module exists to avoid:
//   1. it never read `gateway_bypass`, so a stale `agent-gateway-routing` entry
//      made it return `true` for an agent Core cannot route at all;
//   2. it had no local-engine state, so an agent running a model on this laptop
//      was reported the same as one streaming prompts to a provider unfiltered.
// Leaving a wrong-but-dead mapping next to a correct one is not neutral: the next
// person wiring a badge picks whichever they find first. Use `classifyAgentEgress`.
//
// ── Scope: TWO layers, and they must never fuse back into one ─────────────────
// This module now describes layer 1 (MODEL EGRESS) *and* layer 3 (the MCP TOOL
// BRIDGE), as two independent fields on every row. It still says nothing about:
//   layer 2 — the command-approval scan at the ACP `request_permission` seam,
//             which is node-wide and armed by default (`exec-approval-mode`);
//   layer 4 — plugin turn hooks.
// The UI that renders these rows must say so.
//
// Layer 3 is here because until `agent_routing`'s split it was NOT separable:
// ONE preference (`agent-gateway-routing`) gated both the base-URL swap and
// whether `build_ryu_mcp_server` was injected into the ACP session. Their risk
// profiles are different — egress moves a subscription credential and the billing
// path (hence a visible direct-egress opt-out), while the bridge offers only the tool allowlist
// the user already configured for that agent and re-checks it on every call
// (hence ON by default). Conflated, declining the credential swap ALSO removed every
// Ryu tool, which is why a freshly installed ACP agent could not do anything.
//
// So the invariant this file is responsible for, in code and in copy: **no field,
// badge, count or word here may cover both layers at once.** `governed` is egress
// and only egress; {@link AgentEgress.tools} is the bridge and only the bridge.
// The moment one "Governed" badge stands for both, the bug is back — this time in
// the UI, where it is harder to see than it was in Rust.

import { summarizeAgentEgress } from "./agent-egress-badges.ts";
import { classifyEgressLayer, findByPrefix } from "./agent-egress-layer.ts";
import { classifyToolBridge } from "./agent-egress-tool-bridge.ts";
import type {
	AgentEgress,
	AgentEgressView,
	EgressAgentInput,
	EgressControl,
	EgressPrefs,
} from "./agent-egress-types.ts";
import {
	type AgentCatalogEntry,
	type AgentSummary,
	fetchAgent,
	fetchAgentCatalog,
	fetchAgents,
} from "./agents.ts";
import type { ApiTarget } from "./client.ts";
import { fetchPiConfig } from "./pi-config.ts";
import {
	getAgentGatewayRoutingMap,
	getAgentToolBridgeMap,
	getClaudeGatewayRouting,
	getCodexGatewayRouting,
	setAgentGatewayRouting,
	setAgentToolBridge,
	setClaudeGatewayRouting,
	setCodexGatewayRouting,
} from "./preferences.ts";

export {
	describeEgressBadge,
	describeToolBadge,
	summarizeAgentEgress,
} from "./agent-egress-badges.ts";
export {
	applyToolBridgePlan,
	planEnableToolsForAll,
} from "./agent-egress-bulk.ts";
export { classifyToolBridge } from "./agent-egress-tool-bridge.ts";
export type {
	AgentEgress,
	AgentEgressView,
	AgentToolBridge,
	EgressAgentInput,
	EgressBadgeDescriptor,
	EgressBadgeVariant,
	EgressControl,
	EgressMechanism,
	EgressPrefs,
	ToolBridgeChange,
	ToolBridgeMechanism,
	ToolBridgePlan,
	ToolBridgeSkip,
} from "./agent-egress-types.ts";

/**
 * Classify one agent, layer 1 AND layer 3, mirroring the resolution order of
 * `agent_route` in `apps/core/src/sidecar/adapters/mod.rs`. Pure so the mapping
 * is testable without a node.
 *
 * ONE exported classifier for both layers rather than two the caller composes:
 * the tool-bridge half needs the SAME resolved catalog entry the egress half
 * resolved (`acp:pi` is recognised through `registryId === "pi-acp"`), and two
 * independent `findByPrefix` calls is exactly the seam where the two halves would
 * eventually answer about different agents.
 */
export function classifyAgentEgress(
	agent: EgressAgentInput,
	catalog: readonly AgentCatalogEntry[],
	prefs: EgressPrefs
): AgentEgress {
	// Resolved once, here, and threaded into both halves. The `acp-exec:`/`sdk:`
	// guard reproduces the original control flow, where those two branches
	// returned before the lookup ever ran — an `acp-exec:` engine cannot prefix-
	// match a registry id anyway, but relying on that would be relying on the
	// current registry's id shapes rather than on the order Core actually uses.
	const engineForLookup = agent.engine?.trim() || agent.id;
	const resolvedEntry =
		engineForLookup.startsWith("acp-exec:") ||
		engineForLookup.startsWith("sdk:")
			? null
			: findByPrefix(engineForLookup, catalog);
	const egress = classifyEgressLayer(agent, catalog, prefs);
	return {
		...egress,
		tools: classifyToolBridge(agent, resolvedEntry, prefs, egress.mechanism),
	};
}

/** Read the five preferences this view resolves against. */
export async function fetchEgressPrefs(
	target: ApiTarget
): Promise<EgressPrefs> {
	const [claude, codex, piRouting, agents, tools] = await Promise.all([
		getClaudeGatewayRouting(target),
		getCodexGatewayRouting(target),
		// A node whose managed Pi has never been configured has no settings.json;
		// Core's `is_gateway_routing()` returns true in exactly that case, so the
		// failure default must be "gateway" or a fresh node would read as direct.
		fetchPiConfig(target)
			.then((cfg) => cfg.routing)
			.catch(() => "gateway"),
		getAgentGatewayRoutingMap(target),
		getAgentToolBridgeMap(target),
	]);
	return { claude, codex, piRouting, agents, tools };
}

/**
 * The canonical engine binding for a summary row.
 *
 * `GET /api/agents` serves built-ins from the in-code registry with the `acp:`
 * prefix stripped (`"claude"`), and serves custom DB rows with `engine: null`
 * outright. Neither is what Core's router matches on, so: built-ins use their
 * id (which IS the registry id), and custom rows are re-read through
 * `GET /api/agents/:id`, whose record carries the engine the picker saved
 * (`acp:claude`, `acp-exec:<cmd>`, …). The same record says whether the
 * agent's model providers are limited, which moves a custom `acp:pi` agent
 * onto Ryu's managed Pi.
 */
async function canonicalEngine(
	target: ApiTarget,
	agent: AgentSummary
): Promise<{ engine: string | null; modelsLimited: boolean }> {
	if (agent.builtIn) {
		return { engine: agent.id, modelsLimited: false };
	}
	try {
		const record = await fetchAgent(target, agent.id);
		return {
			engine: record.engine,
			modelsLimited:
				record.accountAccess !== null || record.identityMode === "individual",
		};
	} catch {
		// A record we cannot read is honestly unknown, not "direct".
		return { engine: null, modelsLimited: false };
	}
}

/** Load every installed agent's model-egress state for a node. */
export async function loadAgentEgress(
	target: ApiTarget
): Promise<AgentEgressView> {
	const [agents, catalog, prefs] = await Promise.all([
		fetchAgents(target),
		fetchAgentCatalog(target).catch(() => []),
		fetchEgressPrefs(target),
	]);
	const engines = await Promise.all(
		agents.map((agent) => canonicalEngine(target, agent))
	);
	const rows = agents.map((agent, index) =>
		classifyAgentEgress(
			{
				id: agent.id,
				name: agent.name,
				engine: engines[index]?.engine ?? null,
				flagship: agent.recommended,
				modelsLimited: engines[index]?.modelsLimited ?? false,
			},
			catalog,
			prefs
		)
	);
	return summarizeAgentEgress(rows);
}

/** Write the preference behind a row's control. Returns whether it persisted. */
export function setAgentEgressGoverned(
	target: ApiTarget,
	control: EgressControl,
	enabled: boolean
): Promise<boolean> {
	switch (control.kind) {
		case "claude":
			return setClaudeGatewayRouting(target, enabled);
		case "codex":
			return setCodexGatewayRouting(target, enabled);
		default:
			return setAgentGatewayRouting(target, control.agentId, enabled);
	}
}

/** Write one row's tool-bridge preference. Returns whether it persisted. */
export function setAgentToolsEnabled(
	target: ApiTarget,
	agentId: string,
	enabled: boolean
): Promise<boolean> {
	return setAgentToolBridge(target, agentId, enabled);
}
