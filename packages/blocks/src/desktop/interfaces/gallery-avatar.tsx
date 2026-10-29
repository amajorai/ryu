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

/** Pixel sizes the Gallery uses: card bylines, chips, the detail byline. */
export type GalleryAvatarSize = 20 | 24 | 40;

const SIZE: Record<GalleryAvatarSize, string> = {
	20: "size-5",
	24: "size-6",
	40: "size-10",
};

/**
 * An agent's picture, or the generative dither tile the rest of Ryu falls
 * back to (seeded by id, so it survives renames). Decorative: the text beside
 * it always names the agent.
 */
export function GalleryAvatar({
	agent,
	className,
	size,
}: {
	agent: InterfaceAgent;
	className?: string;
	size: GalleryAvatarSize;
}) {
	const seed = ditherAvatarSeed({ id: agent.id, name: agent.name });
	return (
		<Avatar aria-hidden="true" className={cn(SIZE[size], className)}>
			{agent.avatarUrl ? <AvatarImage alt="" src={agent.avatarUrl} /> : null}
			<AvatarFallback appearance="artwork" className="overflow-hidden bg-muted">
				<DitherAvatar animate={false} className="size-full" name={seed} />
			</AvatarFallback>
		</Avatar>
	);
}

/** Up to three overlapping faces for a multi-agent byline. */
export function GalleryAvatarStack({
	agents,
	ringClassName = "ring-background",
}: {
	agents: readonly InterfaceAgent[];
	ringClassName?: string;
}) {
	return (
		<span aria-hidden="true" className="flex shrink-0 -space-x-1.5">
			{agents.slice(0, 3).map((agent) => (
				<GalleryAvatar
					agent={agent}
					className={cn("ring-2", ringClassName)}
					key={agent.id}
					size={20}
				/>
			))}
		</span>
	);
}
