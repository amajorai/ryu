/**
 * Roving-focus keyboard rules for the product-page tab lists (WAI-ARIA tabs
 * pattern, automatic activation): arrows move to the neighbouring tab and wrap,
 * Home and End jump to the ends. Arrows that run across the list's orientation
 * are ignored, so a vertical list leaves Left/Right to the page. A horizontal
 * list follows the reading direction: under RTL, ArrowLeft moves to the next tab.
 */
export type TabOrientation = "horizontal" | "vertical" | "both";

/** The inline reading direction the tab row lays out in. */
export type TabDirection = "ltr" | "rtl";

/** Left and Right swap under RTL; Up and Down never do. */
function inlineKey(key: string, direction: TabDirection): string {
	if (direction !== "rtl") {
		return key;
	}
	if (key === "ArrowLeft") {
		return "ArrowRight";
	}
	if (key === "ArrowRight") {
		return "ArrowLeft";
	}
	return key;
}

/** "both" is for a list that is a row on phones and a column from lg up. */
const PREVIOUS: Record<TabOrientation, readonly string[]> = {
	horizontal: ["ArrowLeft"],
	vertical: ["ArrowUp"],
	both: ["ArrowLeft", "ArrowUp"],
};

const NEXT: Record<TabOrientation, readonly string[]> = {
	horizontal: ["ArrowRight"],
	vertical: ["ArrowDown"],
	both: ["ArrowRight", "ArrowDown"],
};

/** The tab index a key moves to, or null when the key is not a tab key. */
export function nextTabIndex(
	current: number,
	key: string,
	count: number,
	orientation: TabOrientation = "horizontal",
	direction: TabDirection = "ltr"
): number | null {
	const logical = inlineKey(key, direction);
	if (count <= 0) {
		return null;
	}
	if (key === "Home") {
		return 0;
	}
	if (key === "End") {
		return count - 1;
	}
	if (PREVIOUS[orientation].includes(logical)) {
		return (current - 1 + count) % count;
	}
	if (NEXT[orientation].includes(logical)) {
		return (current + 1) % count;
	}
	return null;
}

/** Stable DOM ids for a tab and its panel within one tab list. */
export function tabIds(groupId: string, tabId: string) {
	const safe = `${groupId}-${tabId}`.replace(/[^\w-]/g, "-");
	return { tab: `${safe}-tab`, panel: `${safe}-panel` };
}
