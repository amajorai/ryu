import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { MessageSquareDashed } from "lucide-react";
import { BoardAvatar, type BoardAvatarSize } from "./board-avatar.tsx";
import { agentById } from "./interface-renderer.ts";
import { fullDateTime } from "./timeline-model.ts";

const AVATAR_SIZE: Record<BoardAvatarSize, string> = {
	20: "size-5",
	24: "size-6",
	28: "size-7",
};

/** Attribute that marks every focusable thread in either scale. */
export const TIMELINE_EVENT_ATTRIBUTE = "data-timeline-event";

export function threadTitle(thread: InterfaceThread | undefined): string {
	return thread?.title.trim() || "Untitled thread";
}

/** The agents on a thread that the snapshot knows about, lead first. */
export function threadAgents(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): InterfaceAgent[] {
	const agents: InterfaceAgent[] = [];
	for (const id of thread.agentIds) {
		const agent = agentById(snapshot, id);
		if (agent) {
			agents.push(agent);
		}
	}
	return agents;
}

/** Team or project name a thread is filed under, if any. */
export function threadGroupName(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): string | null {
	const groupId = thread.teamId ?? thread.projectId;
	if (!groupId) {
		return null;
	}
	return snapshot.groups.find((group) => group.id === groupId)?.name ?? null;
}

/** "Atlas", "Atlas, Echo +1", or "No agent". */
export function agentSummary(agents: readonly InterfaceAgent[]): string {
	const [lead, second] = agents;
	if (!lead) {
		return "No agent";
	}
	if (!second) {
		return lead.name;
	}
	const extra = agents.length - 2;
	return `${lead.name}, ${second.name}${extra > 0 ? ` +${extra}` : ""}`;
}

/** One sentence that names a thread for screen readers. */
export function threadAccessibleName(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): string {
	return [
		threadTitle(thread),
		agentSummary(threadAgents(snapshot, thread)),
		THREAD_STATUS_LABELS[threadStatus(thread)],
		fullDateTime(thread.updatedAt),
	]
		.filter(Boolean)
		.join(", ");
}

/**
 * The lead agent's face, or a neutral mark for a thread with no agent. It
 * carries no presence dot: the rail already says when a thread is running.
 */
export function TimelineThreadAvatar({
	agents,
	className,
	size = 24,
}: {
	agents: readonly InterfaceAgent[];
	className?: string;
	size?: BoardAvatarSize;
}) {
	const [lead] = agents;
	if (lead) {
		return (
			<BoardAvatar
				agent={lead}
				className={className}
				name={lead.name}
				size={size}
			/>
		);
	}
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
				AVATAR_SIZE[size],
				className
			)}
		>
			<MessageSquareDashed className={size === 20 ? "size-3" : "size-3.5"} />
		</span>
	);
}
