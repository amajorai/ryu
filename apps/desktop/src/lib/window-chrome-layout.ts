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

export function windowChromeLayout({
	isMac,
	isMobile,
	nativeWindowChrome,
}: WindowChromeLayoutOptions): WindowChromeLayout {
	if (isMobile) {
		return {
			navClusterPosition: "top-2 left-2",
			navClusterReserve: `${NAV_CLUSTER_RESERVE} w-[4.5rem]`,
			pageActionsMargin: "mr-2",
		};
	}

	const hasMacTrafficLights = nativeWindowChrome && isMac;
	const hasRightCaptionButtons = nativeWindowChrome && !isMac;

	return {
		navClusterPosition: hasMacTrafficLights ? "top-4 left-24" : "top-4 left-6",
		navClusterReserve: `${NAV_CLUSTER_RESERVE} ${hasMacTrafficLights ? "w-48" : "w-40"}`,
		pageActionsMargin: hasRightCaptionButtons ? "mr-48" : "mr-2",
	};
}

/**
 * Padding for a full-width top bar drawn by a surface that replaces the
 * titlebar (the OS desktop's menu bar, an interface's top bar): it clears the
 * macOS traffic lights on the left and the Windows/Linux caption buttons on
 * the right, so neither covers the bar's own controls. Browser builds have no
 * native controls and keep their normal gutters.
 */
export function topBarInsets({
	isMac,
	nativeWindowChrome,
}: Omit<WindowChromeLayoutOptions, "isMobile">): string {
	if (!nativeWindowChrome) {
		return "";
	}
	return isMac ? "ps-24 sm:ps-24" : "pe-48 sm:pe-48";
}
