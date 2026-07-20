import { createContext, type ReactNode, useContext } from "react";
import { type UseSpacesResult, useSpaces } from "@/src/hooks/useSpaces.ts";

/**
 * Shares one Spaces list + mutations across the whole app so the Spaces page
 * and the sidebar's Spaces section stay in sync. Without this, each surface ran
 * its own `useSpaces()` instance, so a space created in the page never showed up
 * in the sidebar (and vice versa) until a remount. Mirrors `ChatHistoryContext`.
 */
const SpacesContext = createContext<UseSpacesResult | null>(null);

export function useSpacesContext(): UseSpacesResult {
	const ctx = useContext(SpacesContext);
	if (!ctx) {
		throw new Error("useSpacesContext must be used within SpacesProvider");
	}
	return ctx;
}

export function SpacesProvider({ children }: { children: ReactNode }) {
	const value = useSpaces();
	return (
		<SpacesContext.Provider value={value}>{children}</SpacesContext.Provider>
	);
}
