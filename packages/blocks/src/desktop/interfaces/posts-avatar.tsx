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

export type PostsAvatarSize = 16 | 20 | 24 | 32;

/**
 * A hairline inside every face so pale dither tiles keep their edge on light
 * themes. Drawn above the image, so it reads the same on pictures and art.
 */
const AVATAR_EDGE =
	"relative after:pointer-events-none after:absolute after:inset-0 after:z-10 after:rounded-full after:ring-1 after:ring-foreground/10 after:ring-inset after:content-['']";

/**
 * The cut-out ring for faces on a feed row, tracking the row's hover and
 * focus tint (`ROW_HOVER` in the feed) so the overlap always matches the
 * surface behind it.
 */
export const ROW_FACE_RING =
	"ring-background group-hover/post:ring-muted group-has-[:focus-visible]/post:ring-muted";

const SIZE: Record<PostsAvatarSize, string> = {
	16: "size-4",
	20: "size-5",
	24: "size-6",
	32: "size-8",
};

/**
 * An agent's picture, or Ryu's generative dither tile seeded by id. With no
 * agent it stands for the user: a quiet person glyph on a muted disc.
 * Decorative: the surrounding row always names who it is.
 */
export function PostsAvatar({
	agent,
	className,
	size,
}: {
	agent: InterfaceAgent | null;
	className?: string;
	size: PostsAvatarSize;
}) {
	if (!agent) {
		return (
			<span
				aria-hidden="true"
				className={cn(
					"flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
					AVATAR_EDGE,
					SIZE[size],
					className
				)}
			>
				<UserRound className="size-[60%]" strokeWidth={2} />
			</span>
		);
	}
	const seed = ditherAvatarSeed({ id: agent.id, name: agent.name });
	return (
		<Avatar
			aria-hidden="true"
			className={cn(AVATAR_EDGE, SIZE[size], className)}
		>
			{agent.avatarUrl ? <AvatarImage alt="" src={agent.avatarUrl} /> : null}
			<AvatarFallback appearance="artwork" className="overflow-hidden bg-muted">
				<DitherAvatar animate={false} className="size-full" name={seed} />
			</AvatarFallback>
		</Avatar>
	);
}

const FACEPILE_LIMIT = 4;

/**
 * Overlapping faces with a `+n` tail. The ring matches the surface behind it
 * (pass `ringClassName`) so each face reads as cut out of the row.
 */
export function PostsFacepile({
	agents,
	label,
	limit = FACEPILE_LIMIT,
	ringClassName = "ring-background",
	size = 20,
}: {
	agents: readonly InterfaceAgent[];
	/** Accessible summary; defaults to the names. */
	label?: string;
	limit?: number;
	ringClassName?: string;
	size?: 20 | 24;
}) {
	if (agents.length === 0) {
		return null;
	}
	const shown = agents.slice(0, limit);
	const extra = agents.length - shown.length;
	return (
		<span
			aria-label={label ?? agents.map((agent) => agent.name).join(", ")}
			className="flex shrink-0 -space-x-1"
			role="img"
		>
			{shown.map((agent) => (
				<PostsAvatar
					agent={agent}
					className={cn("ring-2", ringClassName)}
					key={agent.id}
					size={size}
				/>
			))}
			{extra > 0 ? (
				<span
					aria-hidden="true"
					className={cn(
						"z-10 flex items-center justify-center rounded-full bg-muted font-medium text-[10px] text-muted-foreground tabular-nums ring-2",
						size === 20 ? "size-5" : "size-6",
						ringClassName
					)}
				>
					+{extra}
				</span>
			) : null}
		</span>
	);
}
