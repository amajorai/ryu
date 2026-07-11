// The contract every tab module implements. The shell renders exactly one tab at
// a time (the active one) from the registry; an inactive tab is unmounted, so its
// hooks/keyboard handlers are not running. A tab therefore only needs to react to
// being mounted, but it still receives `active` so transient overlays/inputs can
// re-assert focus and so a tab that chooses to stay mounted in future can gate its
// own keyboard. For now active is always true for the mounted tab.

import type { ReactNode } from "react";

export interface TabProps {
	/** True while this tab is the visible/active one. Always true for the mounted
	 * tab today (the shell unmounts inactive tabs), but gate keyboard on it anyway
	 * so the tab is correct if it is ever kept mounted. */
	active: boolean;
}

export interface TabModule {
	/** The tab's React component. Receives {@link TabProps}. Typed as a plain
	 * function component (not ComponentType) so it satisfies the OpenTUI JSX
	 * element constraint under React 19's ReactNode (which includes Promise). */
	Component: (props: TabProps) => ReactNode;
	/** Optional single-letter mnemonic shown in the palette. The shell also maps
	 * the tab's 1-based position to a digit jump (1-9). */
	hotkey?: string;
	/** Stable id, matching apps/cli's SidebarTab (lowercased), e.g. "chat". */
	id: string;
	/** Sidebar label, e.g. "Chat". */
	title: string;
}
