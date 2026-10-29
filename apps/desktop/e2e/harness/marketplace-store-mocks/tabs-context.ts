import { createContext, type ReactNode } from "react";
import type { useTabsContext as useDesktopTabsContext } from "../../../src/contexts/TabsContext.tsx";

type StoreTabState = Pick<ReturnType<typeof useDesktopTabsContext>, "openTab">;

const state: StoreTabState = {
	openTab: (path, options) => {
		window.dispatchEvent(
			new CustomEvent("marketplace-store:tab", { detail: path })
		);
		window.dispatchEvent(
			new CustomEvent("marketplace-store:tab-options", {
				detail: options ?? {},
			})
		);
		return "marketplace-store-proof-tab";
	},
};

export function useTabSelector<T>(selector: (value: StoreTabState) => T): T {
	return selector(state);
}

export function useCurrentTabId() {
	return undefined;
}

export function useTabStore<T>(selector: (value: StoreTabState) => T): T {
	return selector(state);
}

// The real Store page reaches shared desktop modules (contribution hosts, dock
// panels, chat surfaces) that import these bindings at module scope. They are
// never rendered inside the Store harness, but ES modules must still resolve
// every named import, so mirror the real module's provider-free defaults.
export const TabsContext = createContext<StoreTabState | null>(null);

export function useTabsContext(): StoreTabState {
	return state;
}

export function useIsActiveTab() {
	return true;
}

export function TabsStateProvider({ children }: { children: ReactNode }) {
	return children;
}

export function CurrentTabIdProvider({ children }: { children: ReactNode }) {
	return children;
}

export function IsActiveTabProvider({ children }: { children: ReactNode }) {
	return children;
}
