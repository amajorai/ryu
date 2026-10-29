import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";

/**
 * The one focus indicator Moments uses: the theme's own ring colour with a
 * thin background gap, so it stays visible on the wash without shouting.
 */
export const MOMENTS_FOCUS =
	"outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background";

/** The one shortcut-hint style Moments uses, for every key it names. */
export const MOMENTS_KBD =
	"h-5 min-w-5 rounded-md bg-foreground/[0.06] px-1.5 text-foreground/70";

const SIZE = {
	lg: { box: "size-7", text: "text-xs" },
	md: { box: "size-5", text: "text-[10px]" },
	sm: { box: "size-4", text: "text-[9px]" },
} as const;

/**
 * A small monochrome source glyph, as MercuryOS marks where a module comes
 * from: the agent's picture in greyscale, else its initial. Colour stays
 * reserved for status. Decorative: the surrounding text names the agent.
 */
export function MomentsGlyph({
	agent,
	className,
	size = "sm",
}: {
	agent: InterfaceAgent | undefined;
	className?: string;
	size?: keyof typeof SIZE;
}) {
	const initial = agent?.name.trim().charAt(0).toUpperCase() ?? "";
	return (
		<Avatar
			aria-hidden="true"
			className={cn(SIZE[size].box, "shrink-0 before:hidden", className)}
		>
			{agent?.avatarUrl ? (
				<AvatarImage alt="" className="grayscale" src={agent.avatarUrl} />
			) : null}
			<AvatarFallback
				className={cn(
					"bg-muted font-medium text-foreground/80 leading-none",
					SIZE[size].text,
					!agent && "border border-foreground/30 border-dashed bg-transparent"
				)}
			>
				{initial}
			</AvatarFallback>
		</Avatar>
	);
}
