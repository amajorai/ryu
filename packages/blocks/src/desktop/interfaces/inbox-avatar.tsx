import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { initials } from "./interface-renderer.ts";

/**
 * An agent's avatar in the user's theme: their picture when they have one,
 * else initials on the secondary surface. Deliberately carries no presence
 * badge: an agent can be busy on another thread, and the inbox row's section
 * already says what this thread is doing.
 */
export function InboxAgentAvatar({
	agent,
	size = "default",
}: {
	agent: InterfaceAgent;
	size?: "default" | "sm";
}) {
	return (
		<Avatar aria-hidden="true" size={size}>
			{agent.avatarUrl ? <AvatarImage alt="" src={agent.avatarUrl} /> : null}
			<AvatarFallback className="bg-secondary font-medium text-secondary-foreground">
				{initials(agent.name)}
			</AvatarFallback>
		</Avatar>
	);
}
