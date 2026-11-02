// The tabs a "Close tabs before/after this one" item closes. The ranges are
// logical: "before" is every lower index and "after" every higher one, which is
// the inline start and end of the strip in either reading direction (the strip
// mirrors under dir="rtl", so index 0 sits at the physical right there).
// Pinned tabs survive bulk closes, the way they do in Chrome.

interface ClosableTab {
	id: string;
	pinned?: boolean;
}

export interface TabCloseRanges<T extends ClosableTab> {
	after: T[];
	before: T[];
}

export function tabCloseRanges<T extends ClosableTab>(
	tabs: readonly T[],
	index: number
): TabCloseRanges<T> {
	if (index < 0 || index >= tabs.length) {
		return { after: [], before: [] };
	}
	const closable = (tab: T) => !tab.pinned;
	return {
		after: tabs.slice(index + 1).filter(closable),
		before: tabs.slice(0, index).filter(closable),
	};
}
