import { useCallback, useEffect, useState } from "react";
import {
	type Agent,
	type AgentInput,
	type AgentSummary,
	createAgent as apiCreateAgent,
	deleteAgent as apiDeleteAgent,
	updateAgent as apiUpdateAgent,
	fetchAgents,
} from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type ActiveEngine,
	type Engine,
	fetchActiveEngine,
	fetchEngines,
} from "@/src/lib/api/engines.ts";
import { useCoreRefresh } from "@/src/lib/core-refresh.ts";
import { PlanCapError } from "@/src/lib/gating/planCapBridge.ts";
import { useEntityCap } from "@/src/lib/gating/useEntityCap.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface UseAgentsResult {
	activeEngine: ActiveEngine | null;
	agents: AgentSummary[];
	create: (input: AgentInput) => Promise<Agent>;
	engines: Engine[];
	error: string | null;
	loading: boolean;
	reload: () => Promise<void>;
	remove: (id: string) => Promise<void>;
	update: (id: string, input: AgentInput) => Promise<Agent>;
}

/// Collapse a full agent record (returned by create/update) into the lightweight
/// list summary so a mutation can update the in-memory list without a refetch.
function recordToSummary(agent: Agent): AgentSummary {
	return {
		id: agent.id,
		name: agent.name,
		avatarUrl: agent.persona?.avatar_url ?? null,
		description: agent.description,
		systemPrompt: agent.systemPrompt,
		engine: agent.engine,
		model: agent.model,
		installed: null,
		installHint: null,
		builtIn: agent.builtIn,
		createdAt: agent.createdAt,
		version: agent.version,
		locked: agent.locked,
		// Custom agents (the only records that flow through here) aren't backed
		// by a registry transport entry, and are never the flagship.
		transport: null,
		recommended: false,
	};
}

/// Loads agents and available engines from the active Core node and exposes CRUD
/// operations that keep the in-memory list in sync after each mutation, so the
/// chat picker reflects edits immediately. The list carries lightweight
/// summaries; the edit page fetches the full record (with tools) by id.
export function useAgents(): UseAgentsResult {
	const activeNode = useActiveNode();
	const target: ApiTarget = {
		url: activeNode.url,
		token: activeNode.token ?? null,
	};
	const { url, token } = target;

	const { guard, limitFor } = useEntityCap();

	const [agents, setAgents] = useState<AgentSummary[]>([]);
	const [engines, setEngines] = useState<Engine[]>([]);
	const [activeEngine, setActiveEngine] = useState<ActiveEngine | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		setLoading(true);
		setError(null);
		const node: ApiTarget = { url, token };
		try {
			const [agentList, engineList, active] = await Promise.all([
				fetchAgents(node),
				fetchEngines(node),
				fetchActiveEngine(node).catch(() => null),
			]);
			setAgents(agentList);
			setEngines(engineList);
			setActiveEngine(active);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to load agents");
		} finally {
			setLoading(false);
		}
	}, [url, token]);

	useEffect(() => {
		reload().catch(() => undefined);
	}, [reload]);

	// Auto-recover when Core reconnects or the user hits "Refresh all".
	useCoreRefresh(reload);

	const create = useCallback(
		async (input: AgentInput) => {
			// Managed-path numeric cap (free tier). Blocks + opens the upgrade modal
			// when at the limit; a no-op off the managed path (self-host uncapped).
			if (!guard("maxAgents", agents.length)) {
				throw new PlanCapError("maxAgents", limitFor("maxAgents"));
			}
			const agent = await apiCreateAgent({ url, token }, input);
			setAgents((prev) => [recordToSummary(agent), ...prev]);
			return agent;
		},
		[url, token, guard, limitFor, agents.length]
	);

	const update = useCallback(
		async (id: string, input: AgentInput) => {
			const agent = await apiUpdateAgent({ url, token }, id, input);
			setAgents((prev) =>
				prev.map((a) => (a.id === id ? { ...a, ...recordToSummary(agent) } : a))
			);
			return agent;
		},
		[url, token]
	);

	const remove = useCallback(
		async (id: string) => {
			await apiDeleteAgent({ url, token }, id);
			setAgents((prev) => prev.filter((a) => a.id !== id));
		},
		[url, token]
	);

	return {
		agents,
		engines,
		activeEngine,
		loading,
		error,
		reload,
		create,
		update,
		remove,
	};
}
