"use client";

import { type KeyboardEvent, useRef, useState } from "react";
import { nextTabIndex, type TabOrientation } from "./tab-keys.ts";

/**
 * Selection and roving focus for a tab list: only the selected tab is in the
 * tab order, arrow keys select and focus the neighbouring tab.
 */
export function useRovingTabs(count: number, orientation: TabOrientation) {
	const [selected, setSelected] = useState(0);
	const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		const next = nextTabIndex(selected, event.key, count, orientation);
		if (next === null) {
			return;
		}
		event.preventDefault();
		setSelected(next);
		tabRefs.current[next]?.focus();
	};

	const registerTab = (index: number) => (node: HTMLButtonElement | null) => {
		tabRefs.current[index] = node;
	};

	return { selected, setSelected, onKeyDown, registerTab };
}
