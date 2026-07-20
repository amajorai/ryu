import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";
import { useIsActiveTab, useTabsContext } from "./TabsContext.tsx";

interface TitleBarState {
	actions: ReactNode;
	title: ReactNode;
}

interface TitleBarContextValue extends TitleBarState {
	setActions: (actions: ReactNode) => void;
	setTitle: (title: ReactNode) => void;
}

const TitleBarContext = createContext<TitleBarContextValue | null>(null);

export function TitleBarProvider({ children }: { children: ReactNode }) {
	const [title, setTitle] = useState<ReactNode>(null);
	const [actions, setActions] = useState<ReactNode>(null);

	return (
		<TitleBarContext.Provider value={{ title, actions, setTitle, setActions }}>
			{children}
		</TitleBarContext.Provider>
	);
}

export function useTitleBarContext() {
	const ctx = useContext(TitleBarContext);
	if (!ctx) {
		throw new Error("useTitleBarContext must be used inside TitleBarProvider");
	}
	return ctx;
}

/**
 * Hook for pages to declaratively push their title and optional right-side
 * actions into the shared titlebar. Only the active tab's instance runs —
 * inactive tabs are silently suppressed. Also syncs string titles to the
 * tab strip label.
 */
export function useTitleBar(title: ReactNode, actions?: ReactNode) {
	const { setTitle, setActions } = useTitleBarContext();
	const isActive = useIsActiveTab();
	const { activeTabId, updateTabTitle } = useTabsContext();

	useEffect(() => {
		if (!isActive) {
			return;
		}
		setTitle(title);
		return () => setTitle(null);
		// biome-ignore lint/correctness/useExhaustiveDependencies: intentional — title is the dep
	}, [title, setTitle, isActive]);

	useEffect(() => {
		if (!isActive) {
			return;
		}
		setActions(actions ?? null);
		return () => setActions(null);
		// biome-ignore lint/correctness/useExhaustiveDependencies: intentional — actions is the dep
	}, [actions, setActions, isActive]);

	// Sync string titles to the tab strip label so the tab shows e.g. the
	// conversation name instead of "New chat".
	useEffect(() => {
		if (!(isActive && activeTabId) || typeof title !== "string" || !title) {
			return;
		}
		updateTabTitle(activeTabId, title);
	}, [title, isActive, activeTabId, updateTabTitle]);
}
