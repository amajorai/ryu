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
import { SellTab, payoutButtonLabel } from "./sell-tab.tsx";
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
		...over,
	};
}

function makeHost(over: Partial<SellerState>): MarketplaceHost {
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
	};
}

function render(over: Partial<SellerState>): string {
	return renderToStaticMarkup(
		<MarketplaceHostProvider host={makeHost(over)}>
			<SellTab />
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
