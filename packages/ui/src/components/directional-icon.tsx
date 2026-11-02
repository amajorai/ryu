import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ComponentProps } from "react";

/** Tailwind class that mirrors a horizontal glyph when the page is right-to-left. */
const DIRECTIONAL_ICON_CLASS = "rtl:-scale-x-100";

/**
 * A Hugeicons glyph that points along the reading direction: arrows, chevrons,
 * Back and Next affordances. It renders unchanged in left-to-right layouts and
 * mirrors horizontally under `dir="rtl"`, so "forward" keeps pointing toward the
 * inline end. Use plain `HugeiconsIcon` for glyphs that must not mirror (logos,
 * media playback, checkmarks, glyphs already pinned to a physical edge).
 */
function DirectionalIcon({
	className,
	...props
}: ComponentProps<typeof HugeiconsIcon>) {
	return (
		<HugeiconsIcon
			className={cn(DIRECTIONAL_ICON_CLASS, className)}
			data-directional-icon=""
			{...props}
		/>
	);
}

export { DIRECTIONAL_ICON_CLASS, DirectionalIcon };
