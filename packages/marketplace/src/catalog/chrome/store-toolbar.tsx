// packages/marketplace/src/catalog/chrome/store-toolbar.tsx
//
// Moved verbatim from apps/desktop/src/components/store/storeToolbar.tsx. Lets a
// mounted section publish its filter/sort panel up into the store's floating
// bottom bar. `useStoreToolbar` is already null-safe (no provider = no-op), so it
// works unchanged on web where no bottom bar exists. Desktop re-exports this.

import type { IconSvgElement } from "@hugeicons/react";
import {
	createContext,
	type DependencyList,
	type ReactNode,
	useContext,
	useEffect,
	useRef,
} from "react";

export interface StoreToolbarConfig {
	/** Filter/sort/util controls that morph up above the bottom bar. */
	panel?: ReactNode;
	panelIcon?: IconSvgElement;
	panelLabel?: string;
}

type SetToolbar = (config: StoreToolbarConfig | null) => void;

const StoreToolbarContext = createContext<SetToolbar | null>(null);

export const StoreToolbarProvider = StoreToolbarContext.Provider;

/**
 * Publish the active section's filter panel into the Store's floating bottom
 * bar, and clear it on unmount so the bar always mirrors the section on screen.
 */
export function useStoreToolbar(
	config: StoreToolbarConfig | null,
	deps: DependencyList
): void {
	const setToolbar = useContext(StoreToolbarContext);
	const configRef = useRef(config);
	configRef.current = config;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `deps` is the caller-owned change signal; the latest config is read via configRef, not closed over.
	useEffect(() => {
		setToolbar?.(configRef.current);
		return () => setToolbar?.(null);
	}, [setToolbar, ...deps]);
}
