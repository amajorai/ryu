import {
	type MarketplaceHost,
	MarketplaceHostProvider,
} from "@ryu/marketplace/host";
import type { ReactNode } from "react";
import { useState } from "react";

export {
	contributedTabForSection,
	resolveStoreSection,
	storeTabGroup,
	storeTabSectionValue,
} from "../../src/hooks/useContributedStoreTabs.ts";

const emptyLicenses = {
	error: null,
	isLicensed: () => false,
	licenses: [],
	loading: false,
	refresh: async () => undefined,
};
const host: MarketplaceHost = {
	openExternal: () => undefined,
	startPurchase: async () => {
		throw new Error("No checkout in this proof");
	},
	useLicenses: () => ({
		...emptyLicenses,
		authed: !location.search.includes("signed-out"),
	}),
	useSellerStatus: () => ({
		authed: false,
		error: null,
		loading: false,
		onboard: async () => "",
		onboarding: false,
		refresh: async () => undefined,
		status: null,
	}),
};
export function DesktopMarketplaceHost({ children }: { children: ReactNode }) {
	return (
		<MarketplaceHostProvider host={host}>{children}</MarketplaceHostProvider>
	);
}
export function DesktopCatalogHost({ children }: { children: ReactNode }) {
	return <>{children}</>;
}
export function useStorePrefetch() {}
export function useStoreSectionCounts() {
	return { bundles: 1 };
}
export function useContributedStoreTabs() {
	return [];
}
export function useStoreViewMode(
	_section: string,
	initial: "grid" | "list" | "showcase"
) {
	return useState(initial);
}
