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
import { LicensesTab, licenseIsManageable } from "./licenses-tab.tsx";
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
		entitlementUntil:
			over.entitlementUntil === undefined ? null : over.entitlementUntil,
		stripeSubscriptionId:
			over.stripeSubscriptionId === undefined
				? null
				: over.stripeSubscriptionId,
	};
}

function makeHost(
	over: Partial<LicensesState>,
	hostOver: Partial<MarketplaceHost> = {}
): MarketplaceHost {
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
		...hostOver,
	};
}

function render(
	over: Partial<LicensesState>,
	hostOver: Partial<MarketplaceHost> = {},
	layout: "page" | "settings" = "page"
): string {
	return renderToStaticMarkup(
		<MarketplaceHostProvider host={makeHost(over, hostOver)}>
			<LicensesTab layout={layout} />
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

	test("a subscription set to end says its renewal is off", () => {
		const html = render({
			licenses: [
				makeLicense({
					cancelAtPeriodEnd: true,
					id: "lic_s",
					stripeSubscriptionId: "sub_1",
				}),
			],
		});
		expect(html).toContain("Renewal off");
		expect(render({ licenses: [makeLicense()] })).not.toContain("Renewal off");
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

describe("LicensesTab — manage action", () => {
	const subscription = makeLicense({
		id: "lic_sub",
		itemName: "Monthly thing",
		stripeSubscriptionId: "sub_1",
	});
	const oneTime = makeLicense({ id: "lic_once", itemName: "Once thing" });

	test("only a subscription license is manageable", () => {
		expect(licenseIsManageable(subscription)).toBe(true);
		expect(licenseIsManageable(oneTime)).toBe(false);
	});

	test("a host that can open a license gets Manage on subscription rows only", () => {
		const html = render(
			{ licenses: [subscription, oneTime] },
			{ openLicense: () => undefined }
		);
		expect(html).toContain('aria-label="Manage Monthly thing"');
		expect(html).not.toContain('aria-label="Manage Once thing"');
	});

	test("a host without openLicense renders no Manage action", () => {
		const html = render({ licenses: [subscription] });
		expect(html).not.toContain("Manage");
	});
});

describe("LicensesTab — settings layout", () => {
	test("the page layout keeps its own frame and title", () => {
		const html = render({ licenses: [makeLicense()] });
		expect(html).toContain("max-w-2xl");
		expect(html).toContain("My licenses");
	});

	test("a settings pane drops the page frame for a Licenses section", () => {
		const html = render({ licenses: [makeLicense()] }, {}, "settings");
		expect(html).not.toContain("max-w-2xl");
		expect(html).not.toContain("<h2");
		expect(html).toContain("Licenses");
		expect(html).toContain("Refresh");
		expect(html).toContain('data-slot="item"');
		expect(html).toContain("Thing");
		expect(html).toContain("v1.2.3");
		expect(html).toContain("19.99");
	});

	test("settings states keep their copy and actions", () => {
		expect(
			render({ error: { kind: "network", message: "offline" } }, {}, "settings")
		).toContain("load your licenses");
		const empty = render(
			{ licenses: [] },
			{ openMarketplace: () => undefined },
			"settings"
		);
		expect(empty).toContain("No purchases yet");
		expect(empty).toContain("Browse the marketplace");
	});

	test("settings rows keep the Manage action for subscriptions", () => {
		const html = render(
			{
				licenses: [
					makeLicense({
						itemName: "Monthly thing",
						stripeSubscriptionId: "sub_1",
					}),
				],
			},
			{ openLicense: () => undefined },
			"settings"
		);
		expect(html).toContain('aria-label="Manage Monthly thing"');
	});
});
