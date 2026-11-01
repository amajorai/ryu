import { useIsMobile } from "@ryu/ui/hooks/use-mobile.ts";
import { useEffect, useState } from "react";
import { announceLocalStorageChange } from "@/src/lib/same-document-storage-event.ts";
import { isDetachedTabWindow } from "@/src/lib/tab-transfer.ts";

/** Tab layout preference: the compact title-bar strip, sidebar list, center-pane
    scroll track, or infinite canvas. Window-local + reactive across the
    TitleBar, sidebar, settings, and context menus via the same localStorage +
    `storage`-event pattern as the other desktop UI prefs. */
export const TAB_LAYOUT_VALUES = [
	"horizontal",
	"vertical",
	"scroll",
	"canvas",
] as const;

export type TabLayout = (typeof TAB_LAYOUT_VALUES)[number];

export const TAB_LAYOUT_OPTIONS = [
	{ label: "Horizontal tabs", value: "horizontal" },
	{ label: "Vertical tabs", value: "vertical" },
	{ label: "Scrollable tabs", value: "scroll" },
	{ label: "Infinite canvas", value: "canvas" },
] as const satisfies ReadonlyArray<{ label: string; value: TabLayout }>;

const KEY = "ryu_tab_layout";

export function parseTabLayout(value: string | null): TabLayout {
	if (
		value === "horizontal" ||
		value === "vertical" ||
		value === "scroll" ||
		value === "canvas"
	) {
		return value;
	}
	return "horizontal";
}

function read(): TabLayout {
	return parseTabLayout(localStorage.getItem(KEY));
}

export function useTabLayout(): TabLayout {
	const [layout, setLayout] = useState<TabLayout>(read);
	// At phone widths the sidebar is a Sheet, so a vertical strip living inside
	// it would put the open tabs behind an overlay. Force horizontal there — the
	// stored preference is untouched and comes back on a wide viewport.
	const isMobile = useIsMobile();

	useEffect(() => {
		const handler = () => setLayout(read());
		window.addEventListener("storage", handler);
		return () => window.removeEventListener("storage", handler);
	}, []);

	return isMobile || isDetachedTabWindow() ? "horizontal" : layout;
}

export function setTabLayout(layout: TabLayout) {
	localStorage.setItem(KEY, layout);
	// Same-document listeners don't get the native `storage` event, so broadcast
	// one ourselves — every useTabLayout() consumer re-reads on this.
	announceLocalStorageChange(KEY);
}
