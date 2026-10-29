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

/** Pixel sizes the Arena uses: wall cards (full, compact) and the panel header. */
export type ArenaAvatarSize = 28 | 32 | 40;

const SIZE: Record<ArenaAvatarSize, string> = {
	28: "size-7",
	32: "size-8",
	40: "size-10",
};

/**
 * An agent's picture, or the generative dither tile the rest of Ryu falls back
 * to (seeded like every other surface, so the face matches), as a square tile
 * the way ops walls show their members. Status is never drawn on the avatar:
 * the label beside the name is the one place it is said.
 */
export function ArenaAvatar({
	agent,
	name,
	size,
}: {
	agent: InterfaceAgent | undefined;
	name: string;
	size: ArenaAvatarSize;
}) {
	const seed = ditherAvatarSeed({ id: agent?.id, name: agent?.name ?? name });
	return (
		<span aria-hidden="true" className="inline-flex shrink-0">
			<Avatar
				className={cn(
					SIZE[size],
					"rounded-md bg-foreground/[0.06] before:rounded-md before:border-foreground/10"
				)}
			>
				{agent?.avatarUrl ? (
					<AvatarImage alt="" className="rounded-md" src={agent.avatarUrl} />
				) : null}
				<AvatarFallback
					appearance="artwork"
					className="overflow-hidden rounded-md bg-transparent"
				>
					<DitherAvatar animate={false} className="size-full" name={seed} />
				</AvatarFallback>
			</Avatar>
		</span>
	);
}
