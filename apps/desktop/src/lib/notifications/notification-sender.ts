import { AGENT_LIST_KEY } from "@/src/lib/agent-list-query.ts";
import { agentLogoSrc } from "@/src/lib/agent-logos.tsx";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import { queryClient } from "@/src/lib/query-client.ts";
import type { NotificationSender } from "./agent-notification-image.ts";

/**
 * Find the agent behind a notification in the agent lists the shell already
 * loaded, without a network read: notifications fire from event streams that
 * must not wait on (or fail because of) another request. `null` when the id is
 * unknown, so the caller shows the app's own notification image.
 */
export function findNotificationSender(
	agentId: string | null | undefined
): NotificationSender | null {
	if (!agentId) {
		return null;
	}
	const lists = queryClient.getQueriesData<AgentSummary[]>({
		queryKey: [AGENT_LIST_KEY],
	});
	for (const [, agents] of lists) {
		const agent = agents?.find((candidate) => candidate.id === agentId);
		if (agent) {
			return {
				id: agent.id,
				name: agent.name,
				avatarGlyph: agent.avatarGlyph,
				avatarUrl: agent.avatarUrl,
				logoSrc: agentLogoSrc(
					agent.engine ?? (agent.builtIn ? agent.id : null)
				),
			};
		}
	}
	return null;
}
