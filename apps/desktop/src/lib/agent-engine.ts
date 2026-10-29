import type { AgentSummary } from "@/src/lib/api/agents.ts";

/**
 * Built-in bots that run on Ryu's own engine instead of being an engine: Jay Jr.
 * and Patrol. Mirrors Core's `agents::runs_on_ryu_engine`;
 * `agent-egress.test.ts` pins the two together.
 */
const RYU_ENGINE_BOT_IDS: ReadonlySet<string> = new Set(["jay-jr", "patrol"]);

/**
 * Whether `agentId` is a built-in bot that Core routes to Ryu's managed Pi under
 * its own identity. Such a bot takes the Ryu agent's model routing and Pi
 * extension tools, not an engine's own launch, egress or tool-bridge settings.
 */
export function runsOnRyuEngine(agentId: string): boolean {
	return RYU_ENGINE_BOT_IDS.has(agentId);
}

/**
 * Whether a custom agent saved on the "Ryu" engine (`acp:pi`) runs on Ryu's
 * managed Pi under its own identity: only when its model providers are limited
 * (an account-access list, or only its own identity). An unrestricted one runs
 * your own installed Pi. Mirrors Core's `agents::runs_limited_on_managed_pi`.
 */
export function runsLimitedOnManagedPi(
	agentId: string,
	engine: string | null,
	modelsLimited: boolean
): boolean {
	return (
		modelsLimited &&
		!["", "default", "ryu", "acp:pi"].includes(agentId.trim()) &&
		!runsOnRyuEngine(agentId) &&
		engine?.trim() === "acp:pi"
	);
}

/** The engine id used by the agent setup picker for an installed built-in. */
export function agentEngineOptionId(agent: AgentSummary): string | null {
	if (!agent.builtIn) {
		return null;
	}
	return agent.id === "ryu" || runsOnRyuEngine(agent.id) ? "acp:pi" : agent.id;
}

/** Resolve the picker engine back to the agent id shown in the universal picker. */
export function agentIdForEngine(
	engine: string | null | undefined,
	agents: AgentSummary[]
): string | null {
	const value = engine?.trim();
	if (!value) {
		return null;
	}

	const exact = agents.find(
		(agent) =>
			agentEngineOptionId(agent) === value ||
			agent.id === value ||
			agent.engine === value
	);
	if (exact) {
		return exact.id;
	}

	const withoutAcpPrefix = value.startsWith("acp:")
		? value.slice("acp:".length)
		: value;
	return (
		agents.find(
			(agent) =>
				agent.engine === withoutAcpPrefix || agent.id === withoutAcpPrefix
		)?.id ?? null
	);
}

/** Convert a universal-picker agent selection into the persisted engine slot. */
export function engineForAgentSelection(agent: AgentSummary): string {
	return agentEngineOptionId(agent) ?? agent.engine ?? agent.id;
}
