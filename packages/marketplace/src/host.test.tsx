// Contract test for the MarketplaceHost seam: the shared money-layer components
// render off the injected host and degrade cleanly when signed out. Renders to
// static markup (no DOM), like the other package tests in this repo.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	type LicensesState,
	type MarketplaceHost,
	MarketplaceHostProvider,
	type SellerState,
} from "./host.tsx";
import { LicensesTab } from "./licenses-tab.tsx";
import { SellTab } from "./sell-tab.tsx";
import { formatPrice } from "./types.ts";

function makeHost(over: {
	licenses?: Partial<LicensesState>;
	seller?: Partial<SellerState>;
}): MarketplaceHost {
	const licenses: LicensesState = {
		authed: false,
		error: null,
		isLicensed: () => false,
		licenses: [],
		loading: false,
		refresh: () => {
			// no-op for the static render
		},
		...over.licenses,
	};
	const seller: SellerState = {
		authed: false,
		error: null,
		loading: false,
		onboard: () => Promise.resolve(""),
		onboarding: false,
		refresh: () => {
			// no-op for the static render
		},
		status: null,
		...over.seller,
	};
	return {
		openExternal: () => {
			// no-op
		},
		startPurchase: () => Promise.resolve({ alreadyLicensed: false, url: "" }),
		useLicenses: () => licenses,
		useSellerStatus: () => seller,
	};
}

describe("MarketplaceHost seam", () => {
	test("LicensesTab renders the signed-out state from the host", () => {
		const host = makeHost({ licenses: { authed: false } });
		const html = renderToStaticMarkup(
			<MarketplaceHostProvider host={host}>
				<LicensesTab />
			</MarketplaceHostProvider>
		);
		expect(html).toContain("Sign in to view your licenses");
	});

	test("SellTab renders the signed-out state from the host", () => {
		const host = makeHost({ seller: { authed: false } });
		const html = renderToStaticMarkup(
			<MarketplaceHostProvider host={host}>
				<SellTab />
			</MarketplaceHostProvider>
		);
		expect(html).toContain("Sign in to become a seller");
	});

	test("LicensesTab surfaces the no-org host error", () => {
		const host = makeHost({
			licenses: {
				authed: true,
				error: { kind: "no_org", message: "Pick an organization first." },
			},
		});
		const html = renderToStaticMarkup(
			<MarketplaceHostProvider host={host}>
				<LicensesTab />
			</MarketplaceHostProvider>
		);
		expect(html).toContain("No organization selected");
		expect(html).toContain("Pick an organization first.");
	});

	test("formatPrice renders minor units as localized currency", () => {
		expect(formatPrice(1999, "usd")).toContain("19.99");
	});
});
