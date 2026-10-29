import type { DesktopGateVerdict } from "@ryu/auth/lib/plans";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { navUserProofState } from "./navuser-interactions-proof.runtime.ts";

const verdict: DesktopGateVerdict = {
	daysLeftInTrial: 0,
	managedInference: true,
	marketplaceApps: true,
	paywalled: false,
	plan: "pro",
	proUnlocked: true,
	reason: "subscription",
};

const entitlement = {
	canUse: () => true,
	ready: true,
	refresh: async () => undefined,
	requestUpgrade: () => navUserProofState().upgradeRequests.push("upgrade"),
	verdict,
};

const EntitlementContext = createContext(entitlement);

export function EntitlementProvider({ children }: { children: ReactNode }) {
	return (
		<EntitlementContext.Provider value={entitlement}>
			{children}
		</EntitlementContext.Provider>
	);
}

export function useEntitlementContext() {
	return useContext(EntitlementContext);
}

const tabs = {
	activeTabId: "navuser-proof-tab",
	openTab: (path: string) => {
		navUserProofState().openTabs.push(path);
		return "navuser-proof-tab";
	},
	tabs: [],
};

export const TabsContext = createContext(tabs);

export function TabsProvider({ children }: { children: ReactNode }) {
	return <TabsContext.Provider value={tabs}>{children}</TabsContext.Provider>;
}

export function useTabsContext() {
	return useContext(TabsContext);
}

export function useTabSelector<T>(selector: (state: typeof tabs) => T): T {
	return selector(useTabsContext());
}

export function useCurrentTabId(): string | undefined {
	return undefined;
}

export function useIsActiveTab(): boolean {
	return true;
}

const spaces = {
	create: async () => null,
	createDatabase: async () => undefined,
	createPage: async () => undefined,
	createSpace: async () => null,
	spaces: [],
};
const SpacesContext = createContext(spaces);

export function SpacesProvider({ children }: { children: ReactNode }) {
	const value = useMemo(() => spaces, []);
	return (
		<SpacesContext.Provider value={value}>{children}</SpacesContext.Provider>
	);
}

export function useSpacesContext() {
	return useContext(SpacesContext);
}

// Anything the proof does not override comes from the real modules, so new
// exports there do not break this harness.
export * from "../../src/contexts/entitlement-context.tsx";
export * from "../../src/contexts/SpacesContext.tsx";
export * from "../../src/contexts/TabsContext.tsx";
