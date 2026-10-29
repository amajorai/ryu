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

/** Pixel sizes the Board uses: card stacks, column headers, the panel header. */
export type BoardAvatarSize = 20 | 24 | 28;

const SIZE: Record<BoardAvatarSize, string> = {
	20: "size-5",
	24: "size-6",
	28: "size-7",
};

/**
 * An agent's picture, or the generative dither tile the rest of Ryu falls back
 * to (seeded by id, so it survives renames). Decorative: the surrounding card
 * or header names the agent.
 */
export function BoardAvatar({
	agent,
	className,
	name,
	size,
}: {
	agent?: InterfaceAgent;
	className?: string;
	name: string;
	size: BoardAvatarSize;
}) {
	const seed = ditherAvatarSeed({ id: agent?.id, name: agent?.name ?? name });
	return (
		<Avatar aria-hidden="true" className={cn(SIZE[size], className)}>
			{agent?.avatarUrl ? <AvatarImage alt="" src={agent.avatarUrl} /> : null}
			<AvatarFallback appearance="artwork" className="overflow-hidden bg-muted">
				<DitherAvatar animate={false} className="size-full" name={seed} />
			</AvatarFallback>
		</Avatar>
	);
}

const STACK_LIMIT = 3;

/**
 * Overlapping participant faces with a `+n` tail. The ring takes the card's
 * own surface color so each face reads as cut out of the card in every theme.
 */
export function BoardAvatarStack({ agents }: { agents: InterfaceAgent[] }) {
	if (agents.length === 0) {
		return (
			<span className="text-muted-foreground text-xs">No agent assigned</span>
		);
	}
	const shown = agents.slice(0, STACK_LIMIT);
	const extra = agents.length - shown.length;
	const names = agents.map((agent) => agent.name).join(", ");
	return (
		<span className="flex min-w-0 items-center gap-1.5">
			<span className="flex shrink-0 -space-x-1.5">
				{shown.map((agent) => (
					<BoardAvatar
						agent={agent}
						className="ring-2 ring-card"
						key={agent.id}
						name={agent.name}
						size={20}
					/>
				))}
				{extra > 0 ? (
					<span
						aria-hidden="true"
						className="z-10 flex size-5 items-center justify-center rounded-full bg-muted font-medium text-[10px] text-muted-foreground ring-2 ring-card"
					>
						+{extra}
					</span>
				) : null}
			</span>
			<span className="truncate text-muted-foreground text-xs">
				<span className="sr-only">With </span>
				{agents.length === 1 ? agents[0]?.name : names}
			</span>
		</span>
	);
}
