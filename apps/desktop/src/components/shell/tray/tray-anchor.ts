/**
 * Pure anchor maths for the sidebar Inbox and Downloads tray (`tray-morph.tsx`).
 *
 * The tray box is portaled out of the sidebar and positioned `fixed` over the
 * trigger's slot, so its coordinates are window coordinates. The sidebar sits
 * at the inline start of the window: on the left under LTR and on the right
 * under RTL. The box is pinned to the trigger's inline-start edge and grows
 * toward the inline end, so the value returned here is an `inset-inline-start`
 * offset: the distance from the window's left edge under LTR and from its right
 * edge under RTL. Measuring the left edge under RTL put the 23rem panel's left
 * edge at the trigger and grew it off the right of the window.
 */

export type TrayDirection = "ltr" | "rtl";

/** The trigger slot's window rectangle, as `getBoundingClientRect` reports it. */
export interface TrayTriggerRect {
	bottom: number;
	left: number;
	right: number;
}

export interface TrayViewport {
	innerHeight: number;
	innerWidth: number;
}

export interface SidebarTrayAnchor {
	bottom: number;
	/** Offset from the window's inline-start edge (left in LTR, right in RTL). */
	inlineStart: number;
}

export interface SidebarTrayAnchorOptions {
	/** Keep-off distance from the window's inline-end edge for the open panel. */
	gutter: number;
	/** The open panel's maximum width, before it is narrowed to the viewport. */
	maxPanelWidth: number;
	/** How far the closed box hangs past the trigger slot on its pinned edges. */
	slotOffset: number;
}

/**
 * Where the sidebar tray box sits, measured from the bottom and inline-start
 * edges of the window. The offset is never negative (the box never starts off
 * the window's start edge) and never so large that the open panel, at its
 * viewport-narrowed width, would cross the gutter at the inline-end edge.
 */
export function sidebarTrayAnchor(
	rect: TrayTriggerRect,
	viewport: TrayViewport,
	direction: TrayDirection,
	options: SidebarTrayAnchorOptions
): SidebarTrayAnchor {
	const { gutter, maxPanelWidth, slotOffset } = options;
	const fromStartEdge =
		direction === "rtl"
			? viewport.innerWidth - rect.right - slotOffset
			: rect.left - slotOffset;
	const panelWidth = Math.min(maxPanelWidth, viewport.innerWidth - 2 * gutter);
	const maximumStart = Math.max(0, viewport.innerWidth - panelWidth - gutter);
	return {
		bottom: viewport.innerHeight - rect.bottom - slotOffset,
		inlineStart: Math.min(Math.max(0, fromStartEdge), maximumStart),
	};
}

/**
 * The open panel's transform origin. Sidebar trays grow from the trigger's
 * inline-start corner; menu-bar trays hang from the window's top-right
 * controls, which stay physical (see the window-chrome note in the RTL
 * ratchet baseline).
 */
export function trayPanelOrigin(
	placement: "menubar" | "sidebar",
	direction: TrayDirection
): "top left" | "top right" {
	if (placement === "menubar" || direction === "rtl") {
		return "top right";
	}
	return "top left";
}
