import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
	useCurrentTabId,
	useIsActiveTab,
	useTabSelector,
} from "./TabsContext.tsx";

interface TitleBarState {
	actions: ReactNode;
	title: ReactNode;
}

interface TitleBarContextValue extends TitleBarState {
	setActions: (actions: ReactNode) => void;
	setTitle: (title: ReactNode) => void;
}

const TitleBarContext = createContext<TitleBarContextValue | null>(null);

const TitleBarSettersContext = createContext<Pick<
	TitleBarContextValue,
	"setTitle" | "setActions"
> | null>(null);

export function TitleBarProvider({ children }: { children: ReactNode }) {
	const [title, setTitle] = useState<ReactNode>(null);
	const [actions, setActions] = useState<ReactNode>(null);

	const setters = useMemo(() => ({ setTitle, setActions }), []);
	return (
		<TitleBarSettersContext.Provider value={setters}>
			<TitleBarContext.Provider
				value={{ title, actions, setTitle, setActions }}
			>
				{children}
			</TitleBarContext.Provider>
		</TitleBarSettersContext.Provider>
	);
}

export function useTitleBarContext() {
	const ctx = useContext(TitleBarContext);
	if (!ctx) {
		throw new Error("useTitleBarContext must be used inside TitleBarProvider");
	}
	return ctx;
}

export interface UseTitleBarOptions {
	/**
	 * Write a string title onto this tab's label in the tab strip (default true).
	 * A page that has no content of its own yet sets this to false so a
	 * placeholder title does not replace a label the tab was opened with. The
	 * title is still published to `useTitleBarContext().title` either way, but
	 * the shell reads only that context's `actions`: no window or title-bar text
	 * shows the page's title, so this option changes the tab label and nothing
	 * else a user can see.
	 */
	syncTabLabel?: boolean;
}

/**
 * Hook for pages to declaratively push their title and optional right-side
 * actions into the shared titlebar. Only the active tab's instance runs —
 * inactive tabs are silently suppressed. Also syncs string titles to the
 * tab strip label unless `options.syncTabLabel` is false.
 */
export function useTitleBar(
	title: ReactNode,
	actions?: ReactNode,
	options?: UseTitleBarOptions
) {
	const setters = useContext(TitleBarSettersContext);
	if (!setters) {
		throw new Error("useTitleBar must be used inside TitleBarProvider");
	}
	const { setTitle, setActions } = setters;
	const isActive = useIsActiveTab();
	const currentTabId = useCurrentTabId();
	const activeTabId = useTabSelector(
		(state) => currentTabId ?? (isActive ? state.activeTabId : undefined)
	);
	const updateTabTitle = useTabSelector((state) => state.updateTabTitle);

	useEffect(() => {
		if (!isActive) {
			return;
		}
		setTitle(title);
		return () => setTitle(null);
		// intentional — title is the dep
	}, [title, setTitle, isActive]);

	useEffect(() => {
		if (!isActive) {
			return;
		}
		setActions(actions ?? null);
		return () => setActions(null);
		// intentional — actions is the dep
	}, [actions, setActions, isActive]);

	// Sync string titles to the tab strip label so the tab shows e.g. the
	// conversation name instead of "New chat".
	const syncTabLabel = options?.syncTabLabel ?? true;
	useEffect(() => {
		if (
			!(syncTabLabel && isActive && activeTabId && isNativeText(title) && title)
		) {
			return;
		}
		updateTabTitle(activeTabId, title);
	}, [title, isActive, activeTabId, updateTabTitle, syncTabLabel]);
}
