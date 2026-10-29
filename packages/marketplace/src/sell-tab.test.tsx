// Tests for the seller onboarding tab: the pure `payoutButtonLabel` CTA selector
// plus render-through-the-host coverage of the payout-status states (signed out,
// no org, Stripe-unavailable, active-with-payouts, restricted, and a surfaced
// onboarding error). Static markup, no DOM — mirrors host.test.tsx.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	type MarketplaceHost,
	MarketplaceHostProvider,
	type SellerState,
} from "./host.tsx";
import {
	payoutButtonLabel,
	payoutsHandoffCopy,
	SellTab,
	startSellerPayouts,
} from "./sell-tab.tsx";
import type { SellerStatus } from "./types.ts";

describe("payoutButtonLabel", () => {
	test("payouts enabled -> manage account (wins over onboarding status)", () => {
		expect(payoutButtonLabel(true, "pending")).toBe("Manage seller account");
		expect(payoutButtonLabel(true, "none")).toBe("Manage seller account");
	});

	test("not enabled + pending -> continue onboarding", () => {
		expect(payoutButtonLabel(false, "pending")).toBe("Continue onboarding");
	});

	test("not enabled + none/active/restricted -> set up payouts", () => {
		expect(payoutButtonLabel(false, "none")).toBe("Set up payouts");
		expect(payoutButtonLabel(false, "restricted")).toBe("Set up payouts");
		expect(payoutButtonLabel(false, "active")).toBe("Set up payouts");
	});
});

function makeStatus(over: Partial<SellerStatus> = {}): SellerStatus {
	return {
		onboardingStatus: "none",
		payoutsEnabled: false,
		stripeConnectAccountId: null,
		stripeIdentityStatus: "none",
		...over,
	};
}

function makeHost(
	over: Partial<SellerState>,
	hostOver: Partial<MarketplaceHost> = {}
): MarketplaceHost {
	const seller: SellerState = {
		authed: true,
		error: null,
		loading: false,
		onboard: () => Promise.resolve(""),
		onboarding: false,
		refresh: () => undefined,
		status: null,
		...over,
	};
	return {
		openExternal: () => undefined,
		startPurchase: () => Promise.resolve({ alreadyLicensed: false, url: "" }),
		useLicenses: () => {
			throw new Error("unused");
		},
		useSellerStatus: () => seller,
		...hostOver,
	};
}

function render(
	over: Partial<SellerState>,
	hostOver: Partial<MarketplaceHost> = {},
	layout: "page" | "settings" = "page"
): string {
	return renderToStaticMarkup(
		<MarketplaceHostProvider host={makeHost(over, hostOver)}>
			<SellTab layout={layout} />
		</MarketplaceHostProvider>
	);
}

describe("SellTab — states", () => {
	test("signed out shows the become-a-seller prompt", () => {
		const html = render({ authed: false });
		expect(html).toContain("Sign in to become a seller");
	});

	test("no-org error shows the no-organization state", () => {
		const html = render({
			error: { kind: "no_org", message: "Pick an org." },
		});
		expect(html).toContain("No organization selected");
	});

	test("Stripe-unavailable error hides the CTA and explains why", () => {
		const html = render({
			error: { kind: "stripe", message: "no stripe" },
			status: makeStatus(),
		});
		expect(html).toContain("Stripe is not configured on this server");
		expect(html).not.toContain("Set up payouts");
	});

	test("active with payouts enabled shows the enabled badge and manage CTA", () => {
		const html = render({
			status: makeStatus({ onboardingStatus: "active", payoutsEnabled: true }),
		});
		expect(html).toContain("Payouts enabled");
		expect(html).toContain("Active");
		expect(html).toContain("Manage seller account");
	});

	test("restricted status renders the Restricted label and set-up CTA", () => {
		const html = render({
			status: makeStatus({ onboardingStatus: "restricted" }),
		});
		expect(html).toContain("Restricted");
		expect(html).toContain("Set up payouts");
	});

	test("pending onboarding shows the continue CTA", () => {
		const html = render({
			status: makeStatus({ onboardingStatus: "pending" }),
		});
		expect(html).toContain("In progress");
		expect(html).toContain("Continue onboarding");
	});

	test("a non-Stripe error is surfaced beneath the CTA", () => {
		const html = render({
			error: { kind: "network", message: "onboarding failed to load" },
			status: makeStatus(),
		});
		expect(html).toContain("onboarding failed to load");
	});
});

describe("startSellerPayouts", () => {
	test("prefers the host's in-app payouts view over a hosted link", async () => {
		const calls: string[] = [];
		const path = await startSellerPayouts({
			onboard: () => {
				calls.push("onboard");
				return Promise.resolve("https://connect.stripe.test/setup");
			},
			openExternal: (url) => {
				calls.push(`external:${url}`);
			},
			openSellerPayouts: () => {
				calls.push("in-app");
			},
		});
		expect(path).toBe("in-app");
		expect(calls).toEqual(["in-app"]);
	});

	test("without one, mints a hosted onboarding link and opens it", async () => {
		const calls: string[] = [];
		const path = await startSellerPayouts({
			onboard: () => {
				calls.push("onboard");
				return Promise.resolve("https://connect.stripe.test/setup");
			},
			openExternal: (url) => {
				calls.push(`external:${url}`);
			},
		});
		expect(path).toBe("hosted");
		expect(calls).toEqual([
			"onboard",
			"external:https://connect.stripe.test/setup",
		]);
	});

	test("an onboarding failure surfaces to the caller", async () => {
		await expect(
			startSellerPayouts({
				onboard: () => Promise.reject(new Error("no stripe")),
				openExternal: () => undefined,
			})
		).rejects.toThrow("no stripe");
	});
});

describe("SellTab — payout handoff copy", () => {
	test("a host with its own payouts view says setup opens here", () => {
		const html = render(
			{ status: makeStatus() },
			{ openSellerPayouts: () => undefined }
		);
		expect(html).toContain(payoutsHandoffCopy(true));
		expect(html).not.toContain("in your browser");
	});

	test("a hosted-link surface says Stripe opens in the browser", () => {
		const html = render({ status: makeStatus() });
		expect(html).toContain("opens in your browser");
	});
});

describe("SellTab — settings layout", () => {
	test("the page layout keeps its own frame and title", () => {
		const html = render({ status: makeStatus() });
		expect(html).toContain("max-w-2xl");
		expect(html).toContain("Marketplace &amp; payouts");
	});

	test("a settings pane drops the page frame for a Payouts section", () => {
		const html = render(
			{
				status: makeStatus({
					onboardingStatus: "active",
					payoutsEnabled: true,
				}),
			},
			{},
			"settings"
		);
		expect(html).not.toContain("max-w-2xl");
		expect(html).not.toContain("<h2");
		expect(html).not.toContain("Marketplace &amp; payouts");
		expect(html).toContain("Payouts");
		expect(html).toContain("Refresh");
		expect(html).toContain("Payout status");
		expect(html).toContain("Payouts enabled");
		expect(html).toContain("Manage seller account");
		expect(html).toContain("opens in your browser");
	});

	test("settings keeps the Stripe-unavailable and error copy", () => {
		const unavailable = render(
			{
				error: { kind: "stripe", message: "no stripe" },
				status: makeStatus(),
			},
			{},
			"settings"
		);
		expect(unavailable).toContain("Stripe is not configured on this server");
		expect(unavailable).not.toContain("Set up payouts");
		expect(
			render(
				{
					error: { kind: "network", message: "onboarding failed to load" },
					status: makeStatus(),
				},
				{},
				"settings"
			)
		).toContain("onboarding failed to load");
	});

	test("A Major Pass is a plain settings section, not a highlight box", () => {
		const html = render(
			{ status: makeStatus() },
			{
				useMembershipReport: () => ({
					authed: true,
					error: null,
					loading: false,
					refresh: () => undefined,
					report: {
						currencies: [
							{
								currency: "usd",
								failedMinor: 0,
								paidMinor: 500,
								pendingMinor: 1200,
								usageCount: 7,
							},
						],
						eligibleListingCount: 3,
					},
				}),
			},
			"settings"
		);
		expect(html).toContain("A Major Pass");
		expect(html).toContain("Recurring plans only");
		expect(html).toContain("Eligible paid apps");
		expect(html).toContain("12.00");
		expect(html).not.toContain("bg-primary/5");
	});
});
