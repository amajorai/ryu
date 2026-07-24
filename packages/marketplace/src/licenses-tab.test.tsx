// Render tests for the owned-licenses (purchase history) tab. Drives the
// LicensesBody state machine off the injected MarketplaceHost: signed-out,
// no-org, load-failure, empty, and a populated list whose rows carry the item
// name, kind, localized price, and a destructive badge for a refunded/disputed
// license. Static markup, no DOM — mirrors host.test.tsx.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	type LicensesState,
	type MarketplaceHost,
	MarketplaceHostProvider,
} from "./host.tsx";
import { LicensesTab } from "./licenses-tab.tsx";
import type { OwnedLicense } from "./types.ts";

function makeLicense(over: Partial<OwnedLicense> = {}): OwnedLicense {
	return {
		buyerOrgId: "org_1",
		buyerUserId: "user_1",
		currency: "usd",
		id: "lic_1",
		itemId: "com.example.thing",
		itemKind: "plugin",
		itemName: "Thing",
		itemVersion: "1.2.3",
		platformFeeMinor: 100,
		priceMinor: 1999,
		purchasedAt: "2026-06-01T00:00:00Z",
		status: "active",
		stripePaymentIntentId: "pi_1",
		...over,
	};
}

function makeHost(over: Partial<LicensesState>): MarketplaceHost {
	const licenses: LicensesState = {
		authed: true,
		error: null,
		isLicensed: () => false,
		licenses: [],
		loading: false,
		refresh: () => undefined,
		...over,
	};
	return {
		openExternal: () => undefined,
		startPurchase: () => Promise.resolve({ alreadyLicensed: false, url: "" }),
		useLicenses: () => licenses,
		useSellerStatus: () => {
			throw new Error("unused");
		},
	};
}

function render(over: Partial<LicensesState>): string {
	return renderToStaticMarkup(
		<MarketplaceHostProvider host={makeHost(over)}>
			<LicensesTab />
		</MarketplaceHostProvider>
	);
}

describe("LicensesTab — degrade-cleanly states", () => {
	test("signed out shows the sign-in prompt", () => {
		const html = render({ authed: false });
		expect(html).toContain("Sign in to view your licenses");
	});

	test("no-org error shows the no-organization state", () => {
		const html = render({
			authed: true,
			error: { kind: "no_org", message: "Pick an org." },
		});
		expect(html).toContain("No organization selected");
		expect(html).toContain("Pick an org.");
	});

	test("a non-no_org error with no licenses shows the load-failure empty", () => {
		const html = render({
			authed: true,
			error: { kind: "network", message: "offline" },
			licenses: [],
		});
		expect(html).toContain("load your licenses");
	});

	test("authed with no licenses and no error shows the no-purchases empty", () => {
		const html = render({ authed: true, licenses: [] });
		expect(html).toContain("No purchases yet");
	});
});

describe("LicensesTab — populated rows", () => {
	test("a row renders the item name, kind, and localized price", () => {
		const html = render({ licenses: [makeLicense()] });
		expect(html).toContain("Thing");
		expect(html).toContain("plugin");
		expect(html).toContain("19.99");
		expect(html).toContain("v1.2.3");
	});

	test("a missing item name falls back to the item id", () => {
		const html = render({
			licenses: [makeLicense({ itemName: null, itemId: "com.fallback.id" })],
		});
		expect(html).toContain("com.fallback.id");
	});

	test("an active license shows no status badge", () => {
		const html = render({ licenses: [makeLicense({ status: "active" })] });
		expect(html).not.toContain("refunded");
		expect(html).not.toContain("disputed");
	});

	test("a refunded license surfaces the status badge", () => {
		const html = render({
			licenses: [makeLicense({ id: "lic_r", status: "refunded" })],
		});
		expect(html).toContain("refunded");
	});

	test("a disputed license surfaces the status badge", () => {
		const html = render({
			licenses: [makeLicense({ id: "lic_d", status: "disputed" })],
		});
		expect(html).toContain("disputed");
	});

	test("the price honors the license currency", () => {
		const html = render({
			licenses: [makeLicense({ currency: "eur", priceMinor: 500 })],
		});
		expect(html).toContain("5.00");
	});
});
