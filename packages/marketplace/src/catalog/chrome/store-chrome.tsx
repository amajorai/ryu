// packages/marketplace/src/catalog/chrome/store-chrome.tsx
//
// Moved from apps/desktop/src/components/store/storeChrome.tsx. The section-tab
// context that the left list header renders. `StoreSectionTab` is declared
// locally (was imported from @ryu/blocks/desktop/store) so the package carries no
// desktop-block dependency. The desktop path re-exports the provider + hook.
//
// Unlike the desktop original, `useStoreChromeOptional` does NOT throw when no
// provider is mounted — the shared list header falls back to rendering no tabs so
// the same component works on web (no store chrome) and desktop (with chrome).

import type { IconSvgElement } from "@hugeicons/react";
import { createContext, useContext } from "react";

/** One section tab in the store's left-column pill nav. Structurally identical
 *  to @ryu/blocks/desktop/store's StoreSectionTab. */
export interface StoreSectionTab {
	/** Optional cluster key; a divider is drawn where the group changes. */
	group?: string;
	icon: IconSvgElement;
	label: string;
	value: string;
}

export interface StoreChromeValue {
	active: string;
	onSelect: (value: string) => void;
	sections: StoreSectionTab[];
}

const StoreChromeContext = createContext<StoreChromeValue | null>(null);

export const StoreChromeProvider = StoreChromeContext.Provider;

/** Throwing accessor kept for desktop callers that require the provider. */
export function useStoreChrome(): StoreChromeValue {
	const value = useContext(StoreChromeContext);
	if (!value) {
		throw new Error("useStoreChrome must be used within StoreChromeProvider");
	}
	return value;
}

/** Non-throwing accessor: returns null when no chrome provider is mounted (web),
 *  so the shared list header can render without the section-tab row. */
export function useStoreChromeOptional(): StoreChromeValue | null {
	return useContext(StoreChromeContext);
}
