// The leading disclosure slot of a sidebar chat row: the latest agent's avatar
// (or the participant grid) at rest, the attention dot, and the expand chevron.

import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { avatarStateFromRunStatus } from "@ryu/ui/components/avatar-conversation.tsx";
import type { Dispatch, SetStateAction } from "react";
import { conversationParticipantIds } from "@/src/lib/agent-conversation-groups.ts";
import { AgentAvatar, engineForAgent } from "@/src/lib/agent-logos.tsx";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { ConversationRunStatusMeta } from "@/src/lib/conversation-run-status.ts";
import type { Conversation } from "@/types/chat.ts";
import { ParticipantOrbitAvatar } from "./sidebar-chat-row-group-avatar.tsx";

export function ChatRowDisclosureButton({
	agents,
	conv,
	dotRingClass,
	groupConversation,
	latestAgent,
	rowExpanded,
	runStatus,
	setRowExpanded,
}: {
	agents: AgentSummary[];
	conv: Conversation;
	dotRingClass: string;
	groupConversation: boolean;
	latestAgent: AgentSummary | undefined;
	rowExpanded: boolean;
	runStatus: ConversationRunStatusMeta | null;
	setRowExpanded: Dispatch<SetStateAction<boolean>>;
}) {
	// A state that cannot make progress without attention badges itself even when
	// the chat is read. In particular, interrupted is not failed: it is a partial
	// reply Core recovered after the local engine stopped, and it cannot auto-resume.
	const showDot = runStatus?.needsAttention === true;
	return (
		<button
			aria-label={rowExpanded ? "Collapse chat details" : "Expand chat details"}
			className="relative flex size-4 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:text-foreground"
			onClick={(e) => {
				e.stopPropagation();
				setRowExpanded((v) => !v);
			}}
			type="button"
		>
			{/* The agent that last took this thread, in the same slot the
			    chevron lives in: shown at rest, crossfading out on hover (and
			    hidden while expanded) so the disclosure affordance can morph
			    in exactly as it did when this slot held only a dot. */}
			{groupConversation ? (
				<span
					className={`absolute inset-0 flex items-center justify-center transition-opacity ${
						rowExpanded ? "opacity-0" : "opacity-100 group-hover/row:opacity-0"
					}`}
				>
					<ParticipantOrbitAvatar
						agents={agents}
						conversationState={avatarStateFromRunStatus(conv.runStatus)}
						participants={conversationParticipantIds(conv)}
					/>
				</span>
			) : latestAgent ? (
				<span
					className={`absolute inset-0 m-auto size-4 object-contain transition-opacity ${
						rowExpanded ? "opacity-0" : "opacity-100 group-hover/row:opacity-0"
					}`}
				>
					<AgentAvatar
						className="size-4 object-contain"
						conversationState={avatarStateFromRunStatus(conv.runStatus)}
						engine={engineForAgent(latestAgent)}
						glyph={latestAgent.avatarGlyph}
						presentation="compact"
						size="16px"
					/>
				</span>
			) : null}
			{/* Attention dot. With an avatar it becomes a badge pinned to the
			    avatar's top-right corner, ringed in the colour of whatever
			    surface is behind it, and stays put through hover — the avatar
			    fades to reveal the chevron, but a failed or interrupted run
			    must not blink out from under the pointer. Without an agent
			    there is nothing to badge, so it keeps its original behaviour:
			    centred in the slot, crossfading out for the chevron.
			    The unread count is shown at the row's trailing edge. */}
			{showDot &&
				(latestAgent || groupConversation ? (
					<span
						aria-label={runStatus.description}
						className={`absolute -top-0.5 -right-0.5 size-1.5 rounded-full ${dotRingClass} ${runStatus.dotClass}`}
						role="img"
						title={runStatus.description}
					/>
				) : (
					<span
						aria-label={runStatus.description}
						className={`absolute inset-0 m-auto size-1.5 rounded-full transition-opacity ${
							rowExpanded
								? "opacity-0"
								: "opacity-100 group-hover/row:opacity-0"
						} ${runStatus.dotClass}`}
						role="img"
						title={runStatus.description}
					/>
				))}
			{/* Chevron: hidden at rest, fades in on hover; always shown (and
			    un-rotated) once expanded so it can be collapsed again. */}
			<HugeiconsIcon
				className={`size-3 transition-[opacity,rotate] motion-reduce:transition-opacity ${
					rowExpanded
						? "opacity-100"
						: "-rotate-90 opacity-0 group-hover/row:opacity-100"
				}`}
				icon={ArrowDown01Icon}
			/>
		</button>
	);
}
