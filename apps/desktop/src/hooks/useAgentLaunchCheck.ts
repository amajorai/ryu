// apps/desktop/src/hooks/useAgentLaunchCheck.ts
//
// Asks Core whether an agent's engine would start under the identity mode and
// account access shown on screen (`POST /api/agents/launch-check`), so the
// create and edit flows can warn before the agent fails its first turn. Core
// answers from the same checks that turn runs, so the reason shown here is the
// one the chat would show. Nothing is saved or started by asking.

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
	type AgentIdentityMode,
	type AgentLaunchCheck,
	checkAgentLaunch,
} from "@/src/lib/api/agents.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface UseAgentLaunchCheckInput {
	/** The account allowlist being edited; `null` is no limit. */
	accountAccess: string[] | null;
	/** The saved agent's id; omit for an agent that is not created yet. */
	agentId?: string | null;
	/** The engine as it would be saved; empty skips the check. */
	engine: string | null;
	identityMode: AgentIdentityMode;
}

export interface UseAgentLaunchCheckResult {
	/** Core's answer, or `null` until one arrives (or when there is no engine). */
	check: AgentLaunchCheck | null;
	/** True while the answer for the current selection is still on its way
	 * (an earlier answer may be on screen meanwhile). */
	pending: boolean;
	/** True when Core answered that the engine would not start. */
	refused: boolean;
}

/** Whether Core would start this agent's engine under this account access. */
export function useAgentLaunchCheck({
	accountAccess,
	agentId,
	engine,
	identityMode,
}: UseAgentLaunchCheckInput): UseAgentLaunchCheckResult {
	const node = useActiveNode();
	const target = useMemo(() => toTarget(node), [node]);
	const trimmedEngine = engine?.trim() ?? "";
	// Keyed by value, sorted, so a reordered or freshly built list is the same
	// question.
	const accessKey = useMemo(
		() => (accountAccess === null ? null : [...accountAccess].sort()),
		[accountAccess]
	);
	const query = useQuery({
		queryKey: [
			"agent-launch-check",
			node.url,
			agentId ?? null,
			trimmedEngine,
			identityMode,
			accessKey,
		],
		queryFn: () =>
			checkAgentLaunch(target, {
				accountAccess: accessKey,
				agentId: agentId ?? null,
				engine: trimmedEngine,
				identityMode,
			}),
		enabled: trimmedEngine.length > 0,
		// Keep the last answer on screen while a changed selection is checked.
		placeholderData: (previous) => previous,
		// Routing switches can change elsewhere; a short cache is enough.
		staleTime: 15_000,
		retry: 1,
	});
	const check = trimmedEngine ? (query.data ?? null) : null;
	const pending =
		trimmedEngine.length > 0 && (query.isLoading || query.isPlaceholderData);
	return { check, pending, refused: check !== null && !check.launchable };
}
