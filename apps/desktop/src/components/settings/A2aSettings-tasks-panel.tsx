import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { useMutation } from "@tanstack/react-query";
import { type A2aTaskRecord, cancelA2aTask } from "@/src/lib/api/a2a.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	artifactSummaries,
	errorMessage,
	SectionCard,
} from "./A2aSettings-shared.tsx";

export function TasksPanel({
	onChanged,
	target,
	tasks,
}: {
	onChanged: () => Promise<void>;
	target: ApiTarget;
	tasks: A2aTaskRecord[];
}) {
	const tl = useLiteralMessages();
	const cancel = useMutation({
		mutationFn: (id: string) => cancelA2aTask(target, id),
		onSuccess: onChanged,
		onError: (error) => toast.error(errorMessage(error)),
	});
	return (
		<SectionCard
			description="Recent inbound and outbound protocol tasks, including persisted state and artifact counts."
			title="Recent A2A tasks"
		>
			<div className="divide-y rounded-md border">
				{tasks.length === 0 ? (
					<p className="px-3 py-4 text-muted-foreground text-xs">
						No A2A tasks yet.
					</p>
				) : null}
				{tasks.map((task) => {
					const protocolTaskId = isNativeText(task.protocolTask.id)
						? task.protocolTask.id
						: task.id;
					const artifacts = artifactSummaries(task);
					const canCancel = ["submitted", "working"].includes(task.state);
					return (
						<div className="flex items-center gap-3 px-3 py-2.5" key={task.id}>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<p
										className="truncate font-mono text-xs"
										title={protocolTaskId}
									>
										{protocolTaskId}
									</p>
									<Badge variant="outline">{task.state}</Badge>
								</div>
								<p className="text-muted-foreground text-xs">
									{tl(
										"{direction} · {count, plural, one {# artifact} other {# artifacts}}",
										{ count: artifacts.length, direction: task.direction }
									)}
								</p>
								{artifacts.length > 0 ? (
									<details className="mt-1 text-xs">
										<summary
											aria-label={tl(
												"View artifacts for A2A task {protocolTaskId}",
												{
													protocolTaskId,
												}
											)}
											className="cursor-pointer text-muted-foreground"
										>
											View artifacts
										</summary>
										<ul className="mt-1 space-y-0.5 pl-4">
											{artifacts.map((artifact) => (
												<li key={artifact.id}>
													{artifact.name} · <code>{artifact.id}</code>
												</li>
											))}
										</ul>
									</details>
								) : null}
							</div>
							<Button
								aria-label={tl("Cancel A2A task {protocolTaskId}", {
									protocolTaskId,
								})}
								disabled={!canCancel || cancel.isPending}
								onClick={() => cancel.mutate(task.id)}
								size="sm"
								variant="ghost"
							>
								Cancel
							</Button>
						</div>
					);
				})}
			</div>
		</SectionCard>
	);
}
