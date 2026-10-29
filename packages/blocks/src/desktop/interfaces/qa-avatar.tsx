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
import { UserRound } from "lucide-react";

export type QaAvatarSize = 16 | 20 | 24 | 32;

const SIZE: Record<QaAvatarSize, string> = {
	16: "size-4",
	20: "size-5",
	24: "size-6",
	32: "size-8",
};

/**
 * An agent's picture, or Ryu's generative dither tile seeded by id. With no
 * agent it stands for the user: a person glyph on a muted disc. Decorative:
 * the text beside it always names who it is.
 */
export function QaAvatar({
	agent,
	className,
	size,
}: {
	agent: InterfaceAgent | null;
	className?: string;
	size: QaAvatarSize;
}) {
	if (!agent) {
		return (
			<span
				aria-hidden="true"
				className={cn(
					"flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
					SIZE[size],
					className
				)}
			>
				<UserRound className="size-[62%]" strokeWidth={2} />
			</span>
		);
	}
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

const STACK_LIMIT = 3;

/** Up to three overlapping faces; the ring matches the surface behind them. */
export function QaFacepile({
	agents,
	size = 20,
}: {
	agents: readonly InterfaceAgent[];
	size?: 16 | 20;
}) {
	if (agents.length === 0) {
		return <QaAvatar agent={null} size={size} />;
	}
	return (
		<span aria-hidden="true" className="flex shrink-0 -space-x-1.5">
			{agents.slice(0, STACK_LIMIT).map((agent) => (
				<QaAvatar
					agent={agent}
					className="ring-2 ring-background"
					key={agent.id}
					size={size}
				/>
			))}
		</span>
	);
}
