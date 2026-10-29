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

/** Pixel sizes the Channels interface uses: pickers, thread faces, sidebar DMs, headers, messages, intros. */
export type ChannelsAvatarSize = 16 | 20 | 24 | 36 | 72;

const SIZE: Record<ChannelsAvatarSize, string> = {
	16: "size-4",
	20: "size-5",
	24: "size-6",
	36: "size-9",
	72: "size-18",
};

/**
 * Rounded squares, not circles: the team-chat convention. The radius grows
 * with the tile (4px for row faces, 8px for message avatars) so every size
 * reads as the same shape. The root, its edge and the picture all share it.
 */
const RADIUS: Record<ChannelsAvatarSize, string> = {
	16: "rounded-artwork-mention before:rounded-artwork-mention *:rounded-artwork-mention",
	20: "rounded-artwork-mention before:rounded-artwork-mention *:rounded-artwork-mention",
	24: "rounded-sm before:rounded-sm *:rounded-sm",
	36: "rounded-md before:rounded-md *:rounded-md",
	72: "rounded-xl before:rounded-xl *:rounded-xl",
};

/**
 * Ryu's avatar: the agent's picture, or the same generative dither tile the
 * rest of the app falls back to, seeded by the agent's id so it never changes
 * on rename. Always decorative: the surrounding row names the person, so the
 * avatar stays silent for screen readers.
 */
export function ChannelsAvatar({
	agent,
	className,
	name,
	size,
}: {
	agent?: InterfaceAgent;
	className?: string;
	/** Display name when there is no agent (for example "You"). */
	name: string;
	size: ChannelsAvatarSize;
}) {
	const seed = ditherAvatarSeed({ id: agent?.id, name: agent?.name ?? name });
	return (
		<Avatar
			aria-hidden="true"
			className={cn(
				// A theme-following edge, so pastel tiles never melt into a light
				// surface; facepile rings (box-shadow) still cut out around it.
				"outline-1 outline-border -outline-offset-1",
				SIZE[size],
				RADIUS[size],
				className
			)}
		>
			{agent?.avatarUrl ? <AvatarImage alt="" src={agent.avatarUrl} /> : null}
			<AvatarFallback appearance="artwork" className="overflow-hidden bg-muted">
				<DitherAvatar animate={false} className="size-full" name={seed} />
			</AvatarFallback>
		</Avatar>
	);
}

/**
 * Presence marker: a filled success dot while the agent is working, a hollow
 * ring while it is idle. The cut-out ring takes the color of the surface the
 * avatar sits on (`ringClassName`), so it reads as a notch in every theme.
 */
export function PresenceDot({
	active,
	className,
	ringClassName = "bg-background",
}: {
	active: boolean;
	className?: string;
	/** Background utility matching the surface under the avatar. */
	ringClassName?: string;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"absolute -right-0.5 -bottom-0.5 flex size-3 items-center justify-center rounded-full",
				ringClassName,
				className
			)}
		>
			<span
				className={cn(
					"size-2 rounded-full",
					active ? "bg-success" : "border-[1.5px] border-current opacity-60"
				)}
			/>
		</span>
	);
}
