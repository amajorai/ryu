// apps/desktop/src/components/agents/AnnotationQueuesPanel.tsx
//
// Human review for an agent: annotation queues over its runs, single messages
// and external traces. A reviewer claims the next item, scores it against the
// queue rubric (score range + closed label set + comment), and reviewed items
// export into a Prompt Studio suite as regression cases. Core owns the queue
// state and every permission check (`/api/annotation-queues/*`); this view only
// drives it through `@ryuhq/core-client/annotation-queues`.

import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { listAnnotationQueues } from "@ryuhq/core-client/annotation-queues.ts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { CreateQueueForm } from "./AnnotationQueuesPanel-create-form.tsx";
import { errorText } from "./AnnotationQueuesPanel-parsing.ts";
import { QueueDetail } from "./AnnotationQueuesPanel-queue-detail.tsx";

export { parseLabelList, parseScore } from "./AnnotationQueuesPanel-parsing.ts";

export interface AnnotationQueuesPanelProps {
	agentId: string;
	target: ApiTarget;
}

export function AnnotationQueuesPanel({
	agentId,
	target,
}: AnnotationQueuesPanelProps) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const queryKey = useMemo(
		() => ["annotation-queues", target.url, agentId],
		[target.url, agentId]
	);
	const queues = useQuery({
		queryKey,
		queryFn: () => listAnnotationQueues(target, agentId),
	});
	const [selectedId, setSelectedId] = useState<string>("");
	const list = queues.data ?? [];
	const selected =
		list.find((queue) => queue.id === selectedId) ?? list[0] ?? null;
	const refresh = () => {
		queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
	};

	return (
		<section
			aria-label="Annotation queues"
			className="flex flex-col gap-3 border-border border-t pt-4"
		>
			<div className="flex flex-col gap-1">
				<h3 className="font-medium text-sm">Annotation queues</h3>
				<p className="text-muted-foreground text-xs">
					Review this agent's runs by hand, then export the reviewed exchanges
					into a prompt suite.
				</p>
			</div>
			{queues.error ? (
				<p className="text-status-destructive text-xs">
					{errorText(queues.error)}
				</p>
			) : null}
			{list.length > 0 ? (
				<NativeSelect
					aria-label="Annotation queue"
					onChange={(event) => setSelectedId(event.target.value)}
					value={selected?.id ?? ""}
				>
					{list.map((queue) => (
						<NativeSelectOption key={queue.id} value={queue.id}>
							{tl("{name} ({pending} pending)", {
								name: queue.name,
								pending: String(queue.counts.pending),
							})}
						</NativeSelectOption>
					))}
				</NativeSelect>
			) : null}
			{selected ? (
				<QueueDetail
					agentId={agentId}
					key={selected.id}
					onChanged={refresh}
					queue={selected}
					target={target}
				/>
			) : null}
			<CreateQueueForm
				agentId={agentId}
				onCreated={(queueId) => {
					setSelectedId(queueId);
					refresh();
				}}
				target={target}
			/>
		</section>
	);
}
