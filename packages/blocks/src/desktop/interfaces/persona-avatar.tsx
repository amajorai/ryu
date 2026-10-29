import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import {
	DitherAvatar,
	ditherAvatarSeed,
} from "@ryu/ui/components/dither-kit/avatar.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";

/** Pixel sizes Persona uses: chips, list rows, feed posts, the profile header. */
export type PersonaAvatarSize = 20 | 24 | 32 | 40 | 48 | 72;

const SIZE: Record<PersonaAvatarSize, string> = {
	20: "size-5",
	24: "size-6",
	32: "size-8",
	40: "size-10",
	48: "size-12",
	72: "size-18",
};

/**
 * The presence mark is the same hollow success ring BoardStatusDot draws for
 * "working", scaled to the avatar, so the header, rail and status rows share
 * one shape for a live run.
 */
const DOT: Record<PersonaAvatarSize, string> = {
	20: "size-2 border-[1.5px] ring-[1.5px]",
	24: "size-2 border-[1.5px] ring-[1.5px]",
	32: "size-2.5 border-2 ring-2",
	40: "size-3 border-2 ring-2",
	48: "size-3 border-2 ring-2",
	72: "size-4 border-[3px] ring-3 bottom-0.5 right-0.5 @max-[639px]:right-0 @max-[639px]:bottom-0 @max-[639px]:size-3 @max-[639px]:border-2 @max-[639px]:ring-2",
};

/** The surface behind an avatar: the ring and the ring's hole take its colour. */
export type PersonaAvatarSurface = "background" | "sidebar" | "sidebar-accent";

const SURFACE: Record<PersonaAvatarSurface, string> = {
	background: "bg-background ring-background",
	sidebar: "bg-sidebar ring-sidebar",
	"sidebar-accent": "bg-sidebar-accent ring-sidebar-accent",
};

/**
 * An agent's face: its picture, or the generative dither tile Ryu falls back
 * to (seeded by id, so it survives renames). A presence ring marks a live run.
 * Decorative: the surrounding row or header names the agent.
 */
export function PersonaAvatar({
	agent,
	className,
	name,
	showPresence = false,
	size,
	surface = "background",
}: {
	agent?: InterfaceAgent;
	className?: string;
	name?: string;
	showPresence?: boolean;
	size: PersonaAvatarSize;
	/** The surface behind the avatar, so the presence ring reads as cut out. */
	surface?: PersonaAvatarSurface;
}) {
	const seed = ditherAvatarSeed({
		id: agent?.id,
		name: agent?.name ?? name ?? "Agent",
	});
	const working = showPresence && agent?.status === "working";
	return (
		<span
			aria-hidden="true"
			className={cn("relative inline-flex shrink-0", SIZE[size], className)}
		>
			<Avatar className="size-full">
				{agent?.avatarUrl ? <AvatarImage alt="" src={agent.avatarUrl} /> : null}
				<AvatarFallback
					appearance="artwork"
					className="overflow-hidden bg-muted"
				>
					<DitherAvatar animate={false} className="size-full" name={seed} />
				</AvatarFallback>
			</Avatar>
			{working ? (
				<span
					className={cn(
						"absolute right-0 bottom-0 rounded-full border-success",
						DOT[size],
						SURFACE[surface]
					)}
				/>
			) : null}
		</span>
	);
}
