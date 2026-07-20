"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@ryu/ui/components/avatar";
import { DitherAvatar } from "@ryu/ui/components/dither-kit/avatar";
import { cn } from "@ryu/ui/lib/utils.ts";

/**
 * One avatar for every entity that can have a picture — user, organization,
 * team, agent, subagent, marketplace author.
 *
 * The point is the FALLBACK. Everywhere previously rendered either initials or
 * a generic building/person glyph, so an org with no logo looked identical to
 * every other org with no logo. Here an empty avatar falls back to a generative
 * dithered pixel avatar seeded off `name` (or `seed`), so it is unique, stable,
 * and recognisable without anyone uploading anything.
 *
 * `seed` exists because the display name is not always a good identity key: two
 * workspaces can both be called "Personal". Pass a stable id there and the
 * avatar stops changing when the entity is renamed.
 */
export function EntityAvatar({
	className,
	name,
	seed,
	size = "default",
	src,
	hue,
}: {
	className?: string;
	/** Display name, used for alt text and as the default dither seed. */
	name: string;
	/** Stable identity key (e.g. org id). Falls back to `name`. */
	seed?: string;
	size?: "default" | "sm" | "lg";
	/** Uploaded image; when absent or broken the dither avatar shows through. */
	src?: string | null;
	/** Optional hue override (0–360) so a surface can theme its placeholders. */
	hue?: number;
}) {
	return (
		<Avatar className={cn(className)} size={size}>
			{src ? <AvatarImage alt={name} src={src} /> : null}
			<AvatarFallback className="overflow-hidden bg-transparent p-0">
				<DitherAvatar
					className="size-full"
					hue={hue}
					name={seed || name || "ryu"}
				/>
			</AvatarFallback>
		</Avatar>
	);
}
