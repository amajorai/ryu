import {
	Avatar,
	AvatarBadge,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { agentHue, initials } from "./interface-renderer.ts";

/** One agent's avatar, colored by id and marked while it is working. */
export function InterfaceAgentAvatar({
	agent,
	fallbackName,
	size = "default",
}: {
	agent: InterfaceAgent | undefined;
	fallbackName?: string;
	size?: "default" | "lg" | "sm";
}) {
	const name = agent?.name ?? fallbackName ?? "Agent";
	const hue = agentHue(agent?.id ?? name);
	return (
		<Avatar size={size}>
			{agent?.avatarUrl ? <AvatarImage alt="" src={agent.avatarUrl} /> : null}
			<AvatarFallback
				className="font-medium text-white"
				style={{ backgroundColor: `oklch(0.62 0.13 ${hue})` }}
			>
				{initials(name)}
			</AvatarFallback>
			{agent?.status === "working" ? (
				<>
					<AvatarBadge aria-hidden="true" className="bg-emerald-500" />
					<span className="sr-only">Working</span>
				</>
			) : null}
		</Avatar>
	);
}
