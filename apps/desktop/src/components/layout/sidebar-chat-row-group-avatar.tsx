// Participant grid avatar for multi-agent (council/team) chat rows.

import { UserMultiple02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import type { AvatarConversationState } from "@ryu/ui/components/avatar-conversation.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { CSSProperties as LayoutCSSProperties } from "react";
import { AgentAvatar, engineForAgent } from "@/src/lib/agent-logos.tsx";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import layoutStyles from "./sidebar-conversation-rows.module.css";
import { groupAvatarPositions } from "./sidebar-group-avatar.ts";

/** Cells in a group tile's 2x2 grid. Up to this many participants each get a
 *  cell; past it, the bottom-right cell turns into a "+N" count of the rest. */
const GROUP_AVATAR_CELLS = 4;

/** Grid of participant avatars for a multi-agent conversation: up to four
 *  avatars fill the 2x2 grid; a larger group shows three (top-left, top-right,
 *  bottom-left) and counts the rest in the bottom-right cell ("+N"). It stays
 *  legible at the 16px disclosure size and makes a council/team thread read as
 *  a group before its title is read. */
export function ParticipantOrbitAvatar({
	conversationState,
	participants,
	agents,
	size = "sm",
}: {
	agents: AgentSummary[];
	participants: string[];
	conversationState?: AvatarConversationState;
	size?: "md" | "sm";
}) {
	const tl = useLiteralMessages();
	const large = size === "md";
	const members = participants
		.map((id) => agents.find((agent) => agent.id === id))
		.filter((agent): agent is AgentSummary => Boolean(agent));
	if (members.length === 0) {
		return (
			<HugeiconsIcon
				aria-label={tl("{count} participants", { count: participants.length })}
				className={
					large
						? "size-8 text-muted-foreground"
						: "size-4 text-muted-foreground"
				}
				icon={UserMultiple02Icon}
			/>
		);
	}
	// At most GROUP_AVATAR_CELLS faces; the full count is in the tooltip, so
	// there is no "+N" cell.
	const shown = members.slice(0, GROUP_AVATAR_CELLS);
	const positions = groupAvatarPositions(shown.length, 0);
	const cell = `absolute flex items-center justify-center overflow-hidden rounded-full ring-1 ring-sidebar ${large ? "size-5 ring-2" : "size-2.5"}`;
	return (
		<span
			aria-label={tl("{count} participants", { count: participants.length })}
			className={`relative flex shrink-0 ${large ? "size-9" : "size-4"}`}
			role="img"
			title={tl("{count} participants", { count: participants.length })}
		>
			{shown.map((agent, index) => {
				const cssVariables1: LayoutCssVariables = {
					"--desktop-inline1-z-Index": shown.length - index,
				};
				return (
					<span
						className={cn(
							`${cell} bg-sidebar ${positions[index]}`,
							layoutStyles.inline1
						)}
						key={agent.id}
						style={cssVariables1}
					>
						<AgentAvatar
							className={`${large ? "size-5" : "size-2.5"} object-cover`}
							conversationState={conversationState}
							engine={engineForAgent(agent)}
							glyph={agent.avatarGlyph}
							presentation="portrait"
							size={large ? "20px" : "10px"}
						/>
					</span>
				);
			})}
		</span>
	);
}

interface LayoutCssVariables extends LayoutCSSProperties {
	"--desktop-inline1-z-Index"?: string | number;
}
