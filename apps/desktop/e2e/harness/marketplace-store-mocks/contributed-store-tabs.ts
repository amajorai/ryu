import {
	contributedTabForSection,
	resolveStoreSection,
	storeTabGroup,
	storeTabSectionValue,
} from "../../../src/hooks/useContributedStoreTabs.ts";
import type { PluginStoreTab } from "../../../src/lib/api/plugins.ts";

declare global {
	interface Window {
		__marketplaceStoreTabFixture?: { enabled: boolean; value: string };
	}
}

export {
	contributedTabForSection,
	resolveStoreSection,
	storeTabGroup,
	storeTabSectionValue,
};

const fixtureStoreTab: PluginStoreTab = {
	app_enabled: true,
	app_installed: true,
	group: "catalog",
	http_policy: "core",
	icon: "package-01",
	id: "fixture-library",
	plugin: "com.ryu.marketplace-fixture",
	spec: {
		empty: {
			description: "The local Store tab fixture has no matching entries.",
			title: "No fixture listings",
		},
		map: { description: "description", id: "id", title: "name" },
		searchFields: ["tags"],
		searchPlaceholder: "Search fixture catalog…",
		source: {
			http: { method: "GET", path: "/api/fixture/marketplace-store/catalog" },
			items: "items",
		},
	},
	title: "Fixture catalog",
};

export function useContributedStoreTabs(): PluginStoreTab[] {
	const enabled =
		new URLSearchParams(window.location.search).get("fixtureStoreTab") === "1";
	Object.assign(window, {
		__marketplaceStoreTabFixture: {
			enabled,
			value: window.location.search,
		},
	});
	return enabled ? [fixtureStoreTab] : [];
}
