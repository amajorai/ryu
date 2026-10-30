import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import {
	type A2aPublishedAgent,
	deletePublishedA2aAgent,
	publishA2aAgent,
} from "@/src/lib/api/a2a.ts";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { errorMessage, SectionCard } from "./A2aSettings-shared.tsx";

export function PublishedAgentsPanel({
	agents,
	onChanged,
	published,
	target,
}: {
	agents: AgentSummary[];
	onChanged: () => Promise<void>;
	published: A2aPublishedAgent[];
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const [agentId, setAgentId] = useState("");
	const selected = agents.find((agent) => agent.id === agentId);
	const publish = useMutation({
		mutationFn: () => {
			if (!selected) {
				throw new Error("Choose a local agent to publish");
			}
			const description =
				selected.description ||
				tl("A2A access to {agentName}", { agentName: selected.name });
			return publishA2aAgent(target, {
				agentId: selected.id,
				description,
				enabled: true,
				name: selected.name,
				skills: [
					{
						description,
						id: `ryu:${selected.id}`,
						name: selected.name,
						tags: ["ryu"],
					},
				],
			});
		},
		onSuccess: async () => {
			setAgentId("");
			toast.success("Agent published to A2A");
			await onChanged();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});
	const update = useMutation({
		mutationFn: (agent: A2aPublishedAgent) =>
			publishA2aAgent(target, {
				agentId: agent.agentId,
				description: agent.description,
				enabled: !agent.enabled,
				id: agent.id,
				name: agent.name,
				skills: agent.skills,
			}),
		onSuccess: onChanged,
		onError: (error) => toast.error(errorMessage(error)),
	});
	const remove = useMutation({
		mutationFn: (id: string) => deletePublishedA2aAgent(target, id),
		onSuccess: onChanged,
		onError: (error) => toast.error(errorMessage(error)),
	});

	return (
		<SectionCard
			description="Only published agents appear in the public Agent Card or receive inbound tasks."
			title="Published agents"
		>
			<div className="flex gap-2">
				<label className="sr-only" htmlFor="a2a-agent-picker">
					Local agent
				</label>
				<select
					className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm"
					id="a2a-agent-picker"
					onChange={(event) => setAgentId(event.target.value)}
					value={agentId}
				>
					<option value="">Choose a local agent…</option>
					{agents.map((agent) => (
						<option key={agent.id} value={agent.id}>
							{agent.name}
						</option>
					))}
				</select>
				<Button
					disabled={!selected}
					loading={publish.isPending}
					onClick={() => publish.mutate()}
					size="sm"
				>
					Publish
				</Button>
			</div>
			<div className="divide-y rounded-md border">
				{published.length === 0 ? (
					<p className="px-3 py-4 text-muted-foreground text-xs">
						No agents are published.
					</p>
				) : null}
				{published.map((agent) => (
					<div className="flex items-center gap-3 px-3 py-2.5" key={agent.id}>
						<div className="min-w-0 flex-1">
							<p className="truncate font-medium text-sm" title={agent.name}>
								{agent.name}
							</p>
							<p className="truncate text-muted-foreground text-xs">
								{tl(
									"{agentId} · {count, plural, one {# skill} other {# skills}}",
									{ agentId: agent.agentId, count: agent.skills.length }
								)}
							</p>
						</div>
						<Switch
							aria-label={`${agent.enabled ? "Disable" : "Enable"} ${agent.name}`}
							checked={agent.enabled}
							disabled={update.isPending}
							onCheckedChange={() => update.mutate(agent)}
						/>
						<Button
							aria-label={tl("Remove published agent {name}", {
								name: agent.name,
							})}
							disabled={remove.isPending}
							onClick={() => remove.mutate(agent.id)}
							size="sm"
							variant="ghost"
						>
							Remove
						</Button>
					</div>
				))}
			</div>
		</SectionCard>
	);
}
