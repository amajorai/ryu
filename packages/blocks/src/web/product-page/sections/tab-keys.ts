/**
 * Roving-focus keyboard rules for the product-page tab lists (WAI-ARIA tabs
 * pattern, automatic activation): arrows move to the neighbouring tab and wrap,
 * Home and End jump to the ends. Arrows that run across the list's orientation
 * are ignored, so a vertical list leaves Left/Right to the page.
 */
export type TabOrientation = "horizontal" | "vertical" | "both";

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
	orientation: TabOrientation = "horizontal"
): number | null {
	if (count <= 0) {
		return null;
	}
	if (key === "Home") {
		return 0;
	}
	if (key === "End") {
		return count - 1;
	}
	if (PREVIOUS[orientation].includes(key)) {
		return (current - 1 + count) % count;
	}
	if (NEXT[orientation].includes(key)) {
		return (current + 1) % count;
	}
	return null;
}

/** Stable DOM ids for a tab and its panel within one tab list. */
export function tabIds(groupId: string, tabId: string) {
	const safe = `${groupId}-${tabId}`.replace(/[^\w-]/g, "-");
	return { tab: `${safe}-tab`, panel: `${safe}-panel` };
}
