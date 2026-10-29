import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import {
	DitherAvatar,
	ditherAvatarSeed,
} from "@ryu/ui/components/dither-kit/avatar.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";

/**
 * An agent's picture, or Ryu's generative dither tile (seeded by id).
 * Decorative: whatever sits beside it names the agent.
 */
export function QuizAvatar({
	agent,
	className,
}: {
	agent: InterfaceAgent;
	/** Size and ring classes, e.g. `size-10`. */
	className: string;
}) {
	const seed = ditherAvatarSeed({ id: agent.id, name: agent.name });
	return (
		<Avatar aria-hidden="true" className={cn("shrink-0", className)}>
			{agent.avatarUrl ? <AvatarImage alt="" src={agent.avatarUrl} /> : null}
			<AvatarFallback appearance="artwork" className="overflow-hidden bg-muted">
				<DitherAvatar animate={false} className="size-full" name={seed} />
			</AvatarFallback>
		</Avatar>
	);
}
