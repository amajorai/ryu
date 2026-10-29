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
import { MessageSquareText } from "lucide-react";

/** Pixel sizes the Desk uses: rail rows, stacks, list rows, details. */
export type DeskAvatarSize = 16 | 20 | 24 | 32 | 36;

/** The surface an avatar sits on, so its presence notch is cut from it. */
export type DeskSurface =
	| "accent"
	| "background"
	| "sidebar"
	| "sidebar-accent";

/** Ring (the notch) and fill (the hollow) for each surface: literal classes. */
const SURFACE: Record<DeskSurface, { fill: string; ring: string }> = {
	accent: { fill: "bg-accent", ring: "ring-accent" },
	background: { fill: "bg-background", ring: "ring-background" },
	sidebar: { fill: "bg-sidebar", ring: "ring-sidebar" },
	"sidebar-accent": { fill: "bg-sidebar-accent", ring: "ring-sidebar-accent" },
};

const SIZE: Record<DeskAvatarSize, string> = {
	16: "size-4",
	20: "size-5",
	24: "size-6",
	32: "size-8",
	36: "size-9",
};

const DOT: Record<DeskAvatarSize, string> = {
	16: "size-1.5",
	20: "size-2.5 border-2",
	24: "size-2.5 border-2",
	32: "size-3 border-2",
	36: "size-3 border-2",
};

/**
 * An agent's picture, or the generative dither tile the rest of Ryu falls
 * back to (seeded by id, so it survives renames). Decorative: the row around
 * it names the agent. While the agent is working a hollow success ring sits
 * on the corner, cut out of `surface`. It is a ring, not a solid dot, so it
 * never reads as the solid unread dot in themes whose primary is green; at
 * 16px (the rail, which has no unread dots) it is a small solid dot.
 */
export function DeskAvatar({
	agent,
	className,
	presence = false,
	size,
	surface = "background",
}: {
	agent: InterfaceAgent | undefined;
	className?: string;
	presence?: boolean;
	size: DeskAvatarSize;
	/** The surface under the avatar. */
	surface?: DeskSurface;
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
				<MessageSquareText className="size-1/2" />
			</span>
		);
	}
	const seed = ditherAvatarSeed({ id: agent.id, name: agent.name });
	return (
		<span
			aria-hidden="true"
			className={cn("relative inline-flex shrink-0", className)}
		>
			<Avatar className={SIZE[size]}>
				{agent.avatarUrl ? <AvatarImage alt="" src={agent.avatarUrl} /> : null}
				<AvatarFallback
					appearance="artwork"
					className="overflow-hidden bg-muted"
				>
					<DitherAvatar animate={false} className="size-full" name={seed} />
				</AvatarFallback>
			</Avatar>
			{presence && agent.status === "working" ? (
				<span
					className={cn(
						"absolute -right-0.5 -bottom-0.5 rounded-full",
						// Too small for a hollow ring at 16px: a solid dot with a
						// hairline notch, beside a label that already names the agent.
						size === 16
							? "bg-success ring-1"
							: cn("border-success ring-2", SURFACE[surface].fill),
						DOT[size],
						SURFACE[surface].ring
					)}
					data-presence="working"
				/>
			) : null}
		</span>
	);
}

const STACK_LIMIT = 3;

/** Overlapping participant faces with a `+n` tail. Decorative. */
export function DeskAvatarStack({
	agents,
	surface = "background",
}: {
	agents: InterfaceAgent[];
	surface?: DeskSurface;
}) {
	const surfaceRing = SURFACE[surface].ring;
	const shown = agents.slice(0, STACK_LIMIT);
	const extra = agents.length - shown.length;
	return (
		<span aria-hidden="true" className="flex shrink-0 -space-x-1.5">
			{shown.map((agent) => (
				<DeskAvatar
					agent={agent}
					className={cn("rounded-full ring-2", surfaceRing)}
					key={agent.id}
					size={20}
				/>
			))}
			{extra > 0 ? (
				<span
					className={cn(
						"z-10 flex size-5 items-center justify-center rounded-full bg-muted font-medium text-[10px] text-muted-foreground ring-2",
						surfaceRing
					)}
				>
					+{extra}
				</span>
			) : null}
		</span>
	);
}
