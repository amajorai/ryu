import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import {
	getA2aSettings,
	listA2aPeers,
	listA2aPrincipals,
	listA2aTasks,
	listPublishedA2aAgents,
} from "@/src/lib/api/a2a.ts";
import type { Agent, AgentInput, AgentSummary } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { AccessPanel } from "./A2aSettings-access-panel.tsx";
import { PeersPanel } from "./A2aSettings-peers-panel.tsx";
import { PublishedAgentsPanel } from "./A2aSettings-published-agents.tsx";
import { ServerConfigForm } from "./A2aSettings-server-config.tsx";
import { errorMessage } from "./A2aSettings-shared.tsx";
import { TasksPanel } from "./A2aSettings-tasks-panel.tsx";

interface A2aAgentRoster {
	agents: AgentSummary[];
	create: (input: AgentInput) => Promise<Agent>;
}

export function A2aSettings() {
	const agentRoster = useAgents();
	return <A2aSettingsView agentRoster={agentRoster} />;
}

export function A2aSettingsView({
	agentRoster,
}: {
	agentRoster: A2aAgentRoster;
}) {
	const node = useActiveNode();
	const target: ApiTarget = {
		url: node.url,
		token: node.token ?? null,
		userJwt: node.userJwt ?? null,
	};
	const queryClient = useQueryClient();
	const settings = useQuery({
		queryKey: ["a2a", node.url, "settings"],
		queryFn: () => getA2aSettings(target),
	});
	const peers = useQuery({
		queryKey: ["a2a", node.url, "peers"],
		queryFn: () => listA2aPeers(target),
	});
	const principals = useQuery({
		queryKey: ["a2a", node.url, "principals"],
		queryFn: () => listA2aPrincipals(target),
	});
	const published = useQuery({
		queryKey: ["a2a", node.url, "published-agents"],
		queryFn: () => listPublishedA2aAgents(target),
	});
	const tasks = useQuery({
		queryKey: ["a2a", node.url, "tasks"],
		queryFn: () => listA2aTasks(target),
		refetchInterval: (query) =>
			(query.state.data ?? []).some((task) =>
				["submitted", "working"].includes(task.state)
			)
				? 2000
				: false,
	});
	const reload = async () => {
		await queryClient.invalidateQueries({ queryKey: ["a2a", node.url] });
	};
	const firstError =
		settings.error ??
		peers.error ??
		principals.error ??
		published.error ??
		tasks.error;

	if (settings.isLoading && !settings.data) {
		return <SkeletonRows inset="catalog" />;
	}
	if (!settings.data) {
		return (
			<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
				<p className="font-medium">A2A settings are unavailable</p>
				<p className="mt-1 text-muted-foreground text-xs">
					{errorMessage(firstError)}
				</p>
				<Button
					className="mt-3"
					onClick={() => void settings.refetch()}
					size="sm"
				>
					Retry
				</Button>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			{firstError ? (
				<div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-status-destructive text-xs">
					<span>{errorMessage(firstError)}</span>
					<Button onClick={() => void reload()} size="sm" variant="ghost">
						Retry A2A data
					</Button>
				</div>
			) : null}
			<ServerConfigForm
				config={settings.data}
				key={settings.data.updatedAt || "default"}
				onSaved={reload}
				target={target}
			/>
			<PublishedAgentsPanel
				agents={agentRoster.agents}
				onChanged={reload}
				published={published.data ?? []}
				target={target}
			/>
			<PeersPanel
				agents={agentRoster.agents}
				createAgent={agentRoster.create}
				onChanged={reload}
				peers={peers.data ?? []}
				target={target}
			/>
			<AccessPanel
				onChanged={reload}
				principals={principals.data ?? []}
				target={target}
			/>
			<TasksPanel onChanged={reload} target={target} tasks={tasks.data ?? []} />
		</div>
	);
}
