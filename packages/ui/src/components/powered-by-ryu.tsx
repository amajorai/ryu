import { cn } from "../lib/utils.ts";

/**
 * "Powered by Ryu" — the badge on Ryu surfaces that live on other people's pages
 * (embedded agents, the assistant widget). It is the React twin of the markup app
 * sidecars stamp on published sites (`@ryu/sidecar-runtime/branding`): same link,
 * same campaign tags, so every badge reports back the same way.
 *
 * Whether to render it is the caller's call, from the owner's plan
 * (`canRemovePoweredByRyu` in `@ryu/auth/lib/plans`). This component only draws.
 */

export const POWERED_BY_RYU_URL = "https://ryuhq.com";

/** The badge's link, tagged with the surface that showed it. */
export function poweredByRyuHref(source: string): string {
	const url = new URL(POWERED_BY_RYU_URL);
	url.searchParams.set("utm_source", source);
	url.searchParams.set("utm_medium", "powered_by");
	url.searchParams.set("utm_campaign", "badge");
	return url.toString();
}

export interface PoweredByRyuBadgeProps {
	className?: string;
	/** `floating` pins it to the viewport corner; `inline` flows with its parent. */
	placement?: "floating" | "inline";
	/** Short slug naming the surface, reported as `utm_source`. */
	source: string;
}

export function PoweredByRyuBadge({
	className,
	placement = "inline",
	source,
}: PoweredByRyuBadgeProps) {
	return (
		<a
			aria-label="Powered by Ryu — make your own"
			className={cn(
				"inline-flex items-center gap-1.5 rounded-full bg-neutral-950/90 py-1.5 pr-2.5 pl-2 font-medium text-white text-xs leading-none shadow-md backdrop-blur-sm transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				placement === "floating" && "fixed right-3 bottom-3 z-50",
				className
			)}
			data-ryu-powered-by={source}
			href={poweredByRyuHref(source)}
			rel="noopener"
			target="_blank"
		>
			<svg
				aria-hidden="true"
				fill="none"
				height="14"
				viewBox="0 0 24 24"
				width="14"
			>
				<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" fill="#facc15" />
			</svg>
			<span>
				Powered by <strong className="font-bold">Ryu</strong>
			</span>
		</a>
	);
}
