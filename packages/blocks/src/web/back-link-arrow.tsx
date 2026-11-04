import { ArrowLeft02Icon } from "@hugeicons/core-free-icons";
import { DirectionalIcon } from "@ryu/ui/components/directional-icon.tsx";
import { cn } from "@ryu/ui/lib/utils";

/**
 * The leading arrow of a back link ("All opportunities", "Gallery"). Copy never
 * types a "←" glyph: Unicode bidi does not mirror it, so a translated back link
 * would point forward in a right-to-left page. This icon is sized to the
 * surrounding text, hidden from assistive tech (the link's accessible name
 * stays its words) and mirrors under `dir="rtl"`. It pairs with `LinkArrow`.
 */
export function BackLinkArrow({ className }: { className?: string }) {
	return (
		<DirectionalIcon
			aria-hidden="true"
			className={cn(
				"inline-block size-[1em] shrink-0 align-[-0.125em]",
				className
			)}
			icon={ArrowLeft02Icon}
		/>
	);
}
