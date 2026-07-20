// apps/desktop/src/lib/agent-gateway.ts
//
// Client-side mirror of Core's per-agent gateway-routing resolution for sidebar
// badges. OpenAI-compat agents are always governed; the Ryu flagship follows Pi
// config; Claude/Codex/BYO agents follow their respective preference toggles.

import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { fetchPiConfig } from "@/src/lib/api/pi-config.ts";
import {
	getAgentGatewayRoutingMap,
	getClaudeGatewayRouting,
	getCodexGatewayRouting,
} from "@/src/lib/api/preferences.ts";

export interface AgentGatewayGovernanceSnapshot {
	agentRouting: Record<string, boolean>;
	claudeRouting: boolean;
	codexRouting: boolean;
	/** Effective Pi routing for the flagship Ryu agent (`"gateway"` | `"direct"`). */
	ryuPiRouting: string;
}

/** Load the preference snapshot needed to badge gateway-governed agents. */
export async function fetchAgentGatewayGovernanceSnapshot(
	target: ApiTarget
): Promise<AgentGatewayGovernanceSnapshot> {
	const [claudeRouting, codexRouting, ryuPiRouting, agentRouting] =
		await Promise.all([
			getClaudeGatewayRouting(target),
			getCodexGatewayRouting(target),
			fetchPiConfig(target)
				.then((cfg) => cfg.routing)
				.catch(() => "gateway"),
			getAgentGatewayRoutingMap(target),
		]);

	return {
		claudeRouting,
		codexRouting,
		ryuPiRouting,
		agentRouting,
	};
}

/** Whether this agent's chat egress is currently routed through the Ryu gateway. */
export function isAgentGatewayGoverned(
	agent: AgentSummary,
	snapshot: AgentGatewayGovernanceSnapshot | null | undefined
): boolean {
	if (!snapshot) {
		return false;
	}

	// Registry OpenAI-compat agents always use via_gateway: true.
	if (agent.transport === "openai_compat") {
		return true;
	}

	// Flagship Ryu agent (Pi + Gateway by default).
	if (agent.id === "ryu" || agent.recommended) {
		return snapshot.ryuPiRouting !== "direct";
	}

	if (agent.id === "acp:claude") {
		return snapshot.claudeRouting;
	}

	if (agent.id === "acp:codex") {
		return snapshot.codexRouting;
	}

	return snapshot.agentRouting[agent.id] === true;
}
