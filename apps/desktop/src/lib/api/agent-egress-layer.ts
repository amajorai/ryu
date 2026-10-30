// apps/desktop/src/lib/api/agent-egress-layer.ts
//
// Split out of `agent-egress.ts`; import from there. See that module's header.

import {
	CLAUDE_ID,
	CODEX_ID,
	LOCAL_ENGINES,
	PI_POINTER,
	TAKES_EFFECT_AGENT,
	TAKES_EFFECT_CLAUDE,
	TAKES_EFFECT_CODEX,
} from "./agent-egress-constants.ts";
import { runsOnManagedPiAsItself } from "./agent-egress-tool-bridge.ts";
import type {
	AgentEgress,
	EgressAgentInput,
	EgressPrefs,
} from "./agent-egress-types.ts";
import type { AgentCatalogEntry } from "./agents.ts";
import { DEFAULT_AGENT_GATEWAY_ROUTING } from "./preferences.ts";

/**
 * Mirror of Core's `AcpAgentRegistry::find_by_prefix`
 * (`agent_id == e.id || agent_id.starts_with(&e.id)`), scanning in registry
 * order. The order of `GET /api/agents/catalog` is the registry's declaration
 * order, so preserving the array order preserves Core's resolution.
 */
export function findByPrefix(
	engine: string,
	catalog: readonly AgentCatalogEntry[]
): AgentCatalogEntry | null {
	for (const entry of catalog) {
		if (engine === entry.id || engine.startsWith(entry.id)) {
			return entry;
		}
	}
	return null;
}

/**
 * The layer-1 half. Private: callers must go through
 * {@link classifyAgentEgress}, so a row can never be built with an egress
 * verdict and no tool verdict beside it.
 */
export function classifyEgressLayer(
	agent: EgressAgentInput,
	catalog: readonly AgentCatalogEntry[],
	prefs: EgressPrefs
): Omit<AgentEgress, "tools"> {
	const base = { agentId: agent.id, name: agent.name };

	// 1. The flagship. Core checks `agent_id == "ryu"` before anything else and
	//    routes it to `ryu_agent_route`, whose gateway env-injection is gated on
	//    `pi_config::is_gateway_routing()`.
	//
	//    No switch, and the copy has to say where the control IS: Core writes
	//    `x-ryu-routing` only from `apply()`, as `is_managed_or_gateway(&provider)`
	//    — so this is decided by which provider the managed Pi is set to, and
	//    "off" has no meaning until you name the provider to go direct to. A
	//    switch here would be a control Core cannot honour; a bare status with no
	//    pointer would be a dead end on the one family that is ON by default.
	if (agent.flagship || agent.id === "ryu") {
		const governed = prefs.piRouting !== "direct";
		return {
			...base,
			mechanism: "pi-provider",
			governed,
			control: null,
			bestEffort: false,
			credentialNote: null,
			takesEffect: TAKES_EFFECT_AGENT,
			detail: governed
				? `Runs Ryu's managed Pi with the gateway on top — every model call is filtered, budgeted and logged. ${PI_POINTER}`
				: `Ryu's managed Pi is set to a direct provider, so its model calls go straight to that provider. ${PI_POINTER}`,
		};
	}

	// 1b. A built-in bot on Ryu's engine (Jay Jr.). `agent_route` sends it to the
	//     same `ryu_agent_route_with_user_jwt` as the flagship, BEFORE any engine
	//     lookup, and that route decides gateway routing only from
	//     `pi_config::is_gateway_routing()`. The per-agent `agent-gateway-routing`
	//     switch is never read for it, so offering one would be a dead control —
	//     and defaulting it to "governed" would be false whenever the managed Pi is
	//     set to a direct provider. A custom agent on the "Ryu" engine whose
	//     model providers are limited takes the same route
	//     (`agents::runs_limited_on_managed_pi`).
	if (runsOnManagedPiAsItself(agent)) {
		const governed = prefs.piRouting !== "direct";
		return {
			...base,
			mechanism: "pi-provider",
			governed,
			control: null,
			bestEffort: false,
			credentialNote: null,
			takesEffect: TAKES_EFFECT_AGENT,
			detail: governed
				? `Runs on the Ryu agent's managed Pi with the gateway on top — every model call is filtered, budgeted and logged under this agent's own name. ${PI_POINTER}`
				: `Runs on the Ryu agent's managed Pi, which is set to a direct provider, so its model calls go straight to that provider. ${PI_POINTER}`,
		};
	}

	// Core: `let engine = engine.or(agent_id)?` then `route_id = agent_id`.
	const engine = agent.engine?.trim() || agent.id;

	// 2. BYO `acp-exec:<command>` — the one case the generic toggle was built for.
	const byoCommand = engine.startsWith("acp-exec:")
		? engine.slice("acp-exec:".length).trim()
		: "";
	if (byoCommand !== "") {
		const governed = prefs.agents[agent.id] ?? DEFAULT_AGENT_GATEWAY_ROUTING;
		return {
			...base,
			mechanism: "openai-base-url",
			governed,
			control: { kind: "agent", agentId: agent.id },
			bestEffort: true,
			credentialNote: null,
			takesEffect: TAKES_EFFECT_AGENT,
			detail: governed
				? "Ryu points this command at the gateway with OPENAI_BASE_URL. It only does anything if the command's client reads that variable."
				: "Runs your command as-is — its model calls go straight to whatever provider it is configured with.",
		};
	}

	// 3. SDK apps run out of process against the loopback; nothing here reads or
	//    writes their egress, so claiming either answer would be inventing one.
	if (engine.startsWith("sdk:")) {
		return {
			...base,
			mechanism: "unresolved",
			governed: null,
			control: null,
			bestEffort: false,
			credentialNote: null,
			takesEffect: null,
			detail:
				"An SDK app. Ryu does not control its model egress from here — check the app itself.",
		};
	}

	// 4. Local inference engine — a loopback route, not provider egress.
	if (LOCAL_ENGINES.has(engine)) {
		return {
			...base,
			mechanism: "local-engine",
			governed: null,
			control: null,
			bestEffort: false,
			credentialNote: null,
			takesEffect: null,
			detail:
				"Runs a model on this device. Nothing is sent to a provider, so there is no egress to govern.",
		};
	}

	const entry = findByPrefix(engine, catalog);
	if (!entry) {
		return {
			...base,
			mechanism: "unresolved",
			governed: null,
			control: null,
			bestEffort: false,
			credentialNote: null,
			takesEffect: null,
			detail: `Ryu does not recognise the engine "${engine}", so it cannot say where this agent's model calls go (chats with it will fail).`,
		};
	}

	// 5. Claude Code — its own Anthropic-format passthrough, governed by default;
	// explicit false enables direct egress.
	if (entry.id === CLAUDE_ID) {
		return {
			...base,
			mechanism: "anthropic-passthrough",
			governed: prefs.claude,
			control: { kind: "claude" },
			bestEffort: false,
			credentialNote:
				"Your Claude Pro/Max sign-in is forwarded to Anthropic unchanged — Ryu adds no API key, so you stay on your subscription. The gateway does see the request.",
			takesEffect: TAKES_EFFECT_CLAUDE,
			detail: prefs.claude
				? "Routed through the gateway's Anthropic passthrough, so its model calls are filtered and logged."
				: "Talks to Anthropic directly. Its model calls are not filtered, not counted against your budget, and not in the activity log.",
		};
	}

	// 6. Codex — its own ChatGPT-login passthrough, governed by default; explicit
	// false enables direct egress.
	if (entry.id === CODEX_ID) {
		return {
			...base,
			mechanism: "codex-passthrough",
			governed: prefs.codex,
			control: { kind: "codex" },
			bestEffort: false,
			credentialNote:
				"Your ChatGPT sign-in is forwarded to OpenAI unchanged — Ryu adds no API key, so you stay on your subscription. Codex runs against a separate config folder while this is on.",
			takesEffect: TAKES_EFFECT_CODEX,
			detail: prefs.codex
				? "Routed through the gateway's Codex passthrough, so its model calls are filtered and logged."
				: "Talks to OpenAI directly. Its model calls are not filtered, not counted against your budget, and not in the activity log.",
		};
	}

	// 7. An OpenAI-compat registry agent — Core always forwards it via the
	//    gateway (`via_gateway: true`), so there is nothing to opt into.
	if (entry.transport === "openai_compat") {
		return {
			...base,
			mechanism: "gateway-forward",
			governed: true,
			control: null,
			bestEffort: false,
			credentialNote: null,
			takesEffect: null,
			detail:
				"Always goes through the gateway — this agent has no direct path to a provider.",
		};
	}

	// 8. An ACP agent Core declared unroutable. The generic preference is still
	//    writable, but Core's own doc calls the injection "a genuine no-op" for
	//    these, so offering the switch would be offering a dead control.
	if (entry.gatewayBypass) {
		return {
			...base,
			mechanism: "unroutable",
			governed: false,
			control: null,
			bestEffort: false,
			credentialNote: null,
			takesEffect: null,
			detail:
				"Ryu has no way to redirect this agent — it speaks its provider's own protocol and ignores the gateway. Its model calls always go direct.",
		};
	}

	// 9. Any remaining registry ACP agent: the generic base-URL swap applies.
	const governed = prefs.agents[agent.id] ?? DEFAULT_AGENT_GATEWAY_ROUTING;
	return {
		...base,
		mechanism: "openai-base-url",
		governed,
		control: { kind: "agent", agentId: agent.id },
		bestEffort: true,
		credentialNote: null,
		takesEffect: TAKES_EFFECT_AGENT,
		detail: governed
			? "Ryu points this agent at the gateway with OPENAI_BASE_URL. It only does anything if the agent reads that variable."
			: "Its model calls go straight to whatever provider it is configured with.",
	};
}
