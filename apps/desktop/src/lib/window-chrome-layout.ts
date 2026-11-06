/** Marks the title bar's nav-cluster gap so the compact rail, which replaces
 *  the cluster at narrow widths, can retire it (see `CompactRail.css`). */
const NAV_CLUSTER_RESERVE = "ryu-nav-cluster-reserve";

interface WindowChromeLayoutOptions {
	isMac: boolean;
	isMobile: boolean;
	nativeWindowChrome: boolean;
}

export interface WindowChromeLayout {
	navClusterPosition: string;
	navClusterReserve: string;
	pageActionsMargin: string;
}

/**
 * Where the shell's own chrome goes around the native window controls.
 *
 * The native controls stay PHYSICAL under a right-to-left UI language: the
 * macOS traffic lights are drawn at the top-left by `window_chrome.rs`, and the
 * Windows caption buttons are pinned top-right by `decorumTitlebar.ts` (with
 * `direction: ltr` on their bar in `index.css`). The app language can differ
 * from the OS language, so nothing mirrors them. The reading direction is a
 * CSS concern (`rtl:` variants), so a live language switch re-lays the chrome
 * without a re-render.
 *
 * - Without native controls (Webapp, extension, phone widths) everything is
 *   logical: the cluster sits at the inline-start corner, over the sidebar.
 * - macOS: left to right, the cluster sits beside the lights and the reserve
 *   holds both. Right to left, the cluster follows the sidebar to the right,
 *   and the title-bar actions (now at the physical left) clear the lights.
 * - Windows/Linux: the caption buttons own the top-right in both directions,
 *   so the cluster stays at the top-left. Right to left, the inline-start
 *   reserve (now on the right) holds the caption buttons and the actions
 *   (now on the left) clear the cluster.
 */
export function windowChromeLayout({
	isMac,
	isMobile,
	nativeWindowChrome,
}: WindowChromeLayoutOptions): WindowChromeLayout {
	if (isMobile) {
		return {
			navClusterPosition: "top-2 start-2",
			navClusterReserve: `${NAV_CLUSTER_RESERVE} w-[4.5rem]`,
			pageActionsMargin: "me-2",
		};
	}

	if (!nativeWindowChrome) {
		return {
			navClusterPosition: "top-4 start-6",
			navClusterReserve: `${NAV_CLUSTER_RESERVE} w-40`,
			pageActionsMargin: "me-2",
		};
	}

	if (isMac) {
		return {
			navClusterPosition: "top-4 start-24 rtl:start-6",
			navClusterReserve: `${NAV_CLUSTER_RESERVE} w-48 rtl:w-40`,
			pageActionsMargin: "me-2 rtl:me-24",
		};
	}

	return {
		navClusterPosition: "top-4 left-6",
		navClusterReserve: `${NAV_CLUSTER_RESERVE} w-40 rtl:w-48`,
		pageActionsMargin: "me-48 rtl:me-40",
	};
}

/**
 * Padding for a full-width top bar drawn by a surface that replaces the
 * titlebar (the OS desktop's menu bar, an interface's top bar): it clears the
 * macOS traffic lights on the physical left and the Windows/Linux caption
 * buttons on the physical right, whatever the reading direction, because the
 * native controls do not mirror (see `windowChromeLayout`). Browser builds
 * have no native controls and keep their normal gutters.
 */
export function topBarInsets({
	isMac,
	nativeWindowChrome,
}: Omit<WindowChromeLayoutOptions, "isMobile">): string {
	if (!nativeWindowChrome) {
		return "";
	}
	return isMac ? "pl-24 sm:pl-24" : "pr-48 sm:pr-48";
}

/**
 * Which native controls a compact rail at the inline-start edge shares a
 * corner with: `CompactRail.css` keys the rail's width and the title bar's
 * reserve to this, together with the root's `dir`.
 */
export function compactRailNativeControls({
	isMac,
	nativeWindowChrome,
}: Omit<WindowChromeLayoutOptions, "isMobile">):
	| ""
	| "caption-buttons"
	| "traffic-lights" {
	if (!nativeWindowChrome) {
		return "";
	}
	return isMac ? "traffic-lights" : "caption-buttons";
}
