import { cn } from "@ryu/ui/lib/utils.ts";
import { sidebarFloatingChrome } from "@/src/hooks/useSidebarVariant.ts";

/**
 * Geometry of the docked Ask Ryu rail. The rail is a logical inline-END dock:
 * the main navigation sidebar sits at the inline start (the shared <Sidebar>
 * uses `start-0`), so pinning the rail with `end-*` keeps the two on opposite
 * edges in both directions (physical right in LTR, physical left in RTL).
 * Layout reserves the matching `padding-inline-end` (`#assistantReserve`).
 *
 * Floating variant = inset rounded card; inset variant = flush rail. Both start
 * below the titlebar while it is shown. Below `md` the rail spans the viewport
 * (`start-*` and `end-*`), and from `md` it is a 380px column at the inline end.
 */
export function assistantDockFrameClassName({
	floatingChrome,
	titleBarClearsContent,
}: {
	floatingChrome: boolean;
	titleBarClearsContent: boolean;
}): string {
	let geometry: string;
	if (titleBarClearsContent) {
		geometry = floatingChrome
			? cn("start-2 end-2 top-12 bottom-2", sidebarFloatingChrome)
			: "top-[54px] end-0 bottom-0 start-0 md:start-auto";
	} else {
		geometry = floatingChrome
			? cn("inset-y-0 start-2 end-2 bottom-2", sidebarFloatingChrome)
			: "inset-y-0 end-0 start-0 md:start-auto";
	}
	return cn(
		"fixed z-40 flex flex-col overflow-hidden bg-sidebar text-sidebar-foreground md:start-auto md:w-[380px]",
		geometry
	);
}
