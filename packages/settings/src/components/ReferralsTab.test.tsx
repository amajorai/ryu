import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { AffiliateDashboard } from "../utils/api-client.ts";
import { ReferralsTab } from "./ReferralsTab.tsx";

// Static markup over a pre-seeded query cache: no network, no DOM. Covers the
// payout account card's in-app payouts affordance.

function dashboard(over: Partial<AffiliateDashboard> = {}): AffiliateDashboard {
	return {
		defaultCommission: null,
		enabled: true,
		payout: {
			onboardingStatus: "active",
			payoutsEnabled: true,
			stripeConnectAccountId: "acct_1",
		},
		payoutOrgId: "org-pay",
		provider: "ryu",
		recentCommissions: [],
		referralCode: "CODE",
		referralLink: "https://ryuhq.com/r/CODE",
		stats: {
			approvedMinor: 0,
			currency: "usd",
			paidMinor: 0,
			pendingMinor: 0,
			reversedMinor: 0,
		},
		...over,
	};
}

function render(
	data: AffiliateDashboard,
	onOpenPayouts?: (payoutOrgId: string) => void
): string {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
		},
	});
	client.setQueryData(["affiliate", "dashboard"], data);
	client.setQueryData(["referrals", "credits"], null);
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<ReferralsTab onOpenPayouts={onOpenPayouts} />
		</QueryClientProvider>
	);
}

describe("ReferralsTab payout account", () => {
	test("an in-app surface can manage the connected payout account", () => {
		const html = render(dashboard(), () => undefined);
		expect(html).toContain("Payouts enabled");
		expect(html).toContain("Manage payout account");
	});

	test("without an in-app payouts view there is no manage action", () => {
		const html = render(dashboard());
		expect(html).toContain("Payouts enabled");
		expect(html).not.toContain("Manage payout account");
	});

	test("no payout org yet keeps the set-up action", () => {
		const html = render(
			dashboard({
				payout: {
					onboardingStatus: "none",
					payoutsEnabled: false,
					stripeConnectAccountId: null,
				},
				payoutOrgId: null,
			}),
			() => undefined
		);
		expect(html).toContain("Set up payouts");
		expect(html).not.toContain("Manage payout account");
	});
});
