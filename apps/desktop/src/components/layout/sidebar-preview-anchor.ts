/** Rows inside an element carrying this attribute anchor their preview to the
 * boundary's trailing edge instead of to the row itself. */
export const SIDEBAR_PREVIEW_BOUNDARY_SELECTOR =
	"[data-sidebar-preview-boundary]";

export interface SidebarPreviewAnchor {
	contextElement: Element;
	getBoundingClientRect: () => DOMRect;
}

/**
 * Where a sidebar row's hover preview attaches. Inside a preview boundary (the
 * sidebar) the anchor is a zero-width line on the boundary's inline-end edge at
 * the row's height, so the card opens beside the sidebar rather than over it:
 * the physical right edge in LTR, the physical left edge in RTL, where the
 * sidebar sits on the right of the screen.
 */
export function sidebarPreviewAnchor(
	trigger: HTMLElement | null,
	dir: "ltr" | "rtl"
): HTMLElement | SidebarPreviewAnchor | null {
	if (!trigger) {
		return null;
	}
	const boundary = trigger.closest<HTMLElement>(
		SIDEBAR_PREVIEW_BOUNDARY_SELECTOR
	);
	if (!boundary) {
		return trigger;
	}
	return {
		contextElement: trigger,
		getBoundingClientRect: () => {
			const triggerRect = trigger.getBoundingClientRect();
			const boundaryRect = boundary.getBoundingClientRect();
			return DOMRect.fromRect({
				height: triggerRect.height,
				width: 0,
				x: dir === "rtl" ? boundaryRect.left : boundaryRect.right,
				y: triggerRect.top,
			});
		},
	};
}
