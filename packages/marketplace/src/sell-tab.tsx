// packages/marketplace/src/sell-tab.tsx
//
// "Become a seller" Stripe Connect onboarding + payout status. Surface-agnostic:
// the seller state comes from the injected host (`useSellerStatus`) and onboarding
// opens the hosted Stripe URL through the host's `openExternal` (Tauri shell on
// desktop, navigation on web). Payout state is granted async by the server webhook,
// so the host hook re-fetches on window focus.

import {
	Building01Icon,
	CheckmarkBadge04Icon,
	Download01Icon,
	Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { formatMinorCurrency } from "@ryu/ui/lib/number-format.ts";
import { useCallback } from "react";
import { sileo } from "sileo";
import VerifiedBadge from "./catalog/chrome/verified-badge.tsx";
import {
	type MarketplaceMembershipState,
	useMarketplaceHost,
} from "./host.tsx";
import { SellerReportsPanel } from "./seller-reports.tsx";
import { NoOrgState, SignedOutState } from "./states.tsx";
import type { SellerOnboardingStatus } from "./types.ts";

const SELLER_STATUS_LABEL: Record<SellerOnboardingStatus, string> = {
	none: "Not started",
	pending: "In progress",
	active: "Active",
	restricted: "Restricted",
};

function useMissingMembershipReport(): MarketplaceMembershipState {
	return {
		authed: false,
		error: null,
		loading: false,
		refresh: async () => {
			// no-op when the host does not supply Membership reporting
		},
		report: null,
	};
}

const MISSING_MEMBERSHIP_REPORT_HOOK = useMissingMembershipReport;

/** CTA label for the seller payout button based on onboarding state. */
export function payoutButtonLabel(
	payoutsEnabled: boolean,
	onboardingStatus: SellerOnboardingStatus
): string {
	if (payoutsEnabled) {
		return "Manage seller account";
	}
	if (onboardingStatus === "pending") {
		return "Continue onboarding";
	}
	return "Set up payouts";
}

export function SellTab() {
	const {
		openExternal,
		openOrganization,
		openSignIn,
		useMembershipReport,
		useSellerStatus,
	} = useMarketplaceHost();
	const { status, loading, error, authed, onboard, onboarding, refresh } =
		useSellerStatus();
	const membership = (useMembershipReport ?? MISSING_MEMBERSHIP_REPORT_HOOK)();

	const handleOnboard = useCallback(async () => {
		try {
			const url = await onboard();
			await openExternal(url);
			sileo.success({
				title: "Opening seller onboarding…",
				description:
					"Complete Stripe's verification in your browser. Your payout status updates here when you return.",
			});
		} catch (e) {
			const message =
				e instanceof Error ? e.message : "Could not start onboarding.";
			sileo.error({ title: message });
		}
	}, [onboard, openExternal]);

	if (!authed) {
		return (
			<SignedOutState
				action={
					openSignIn ? (
						<Button onClick={() => void openSignIn()} size="sm">
							Sign in
						</Button>
					) : null
				}
				description="Selling paid items is tied to your organization. Sign in to set up payouts."
				title="Sign in to become a seller"
			/>
		);
	}
	if (error && error.kind === "no_org") {
		return (
			<NoOrgState
				action={
					openOrganization ? (
						<Button onClick={() => void openOrganization()} size="sm">
							Choose an organization
						</Button>
					) : null
				}
				message={error.message}
				title="No organization selected"
			/>
		);
	}

	const onboardingStatus = status?.onboardingStatus ?? "none";
	const payoutsEnabled = status?.payoutsEnabled ?? false;
	const stripeIdentityStatus = status?.stripeIdentityStatus ?? "none";
	const stripeUnavailable = error && error.kind === "stripe";
	const membershipTotals = membership.report?.currencies[0] ?? null;

	return (
		<div className="mx-auto max-w-2xl px-6 py-8">
			<div className="mb-6 flex items-center justify-between">
				<h2 className="font-medium text-lg">Marketplace & payouts</h2>
				<Button onClick={() => refresh()} size="sm" variant="ghost">
					<HugeiconsIcon className="mr-2 size-3.5" icon={Refresh01Icon} />
					Refresh
				</Button>
			</div>

			<div className="rounded-lg bg-card p-5">
				<div className="flex items-start gap-3">
					<HugeiconsIcon
						className="mt-0.5 size-6 text-muted-foreground"
						icon={Building01Icon}
					/>
					<div className="flex-1">
						<p className="font-medium text-sm">Payout status</p>
						{loading && !status ? (
							<Spinner className="mt-2 size-4" />
						) : (
							<div className="mt-1 flex items-center gap-2">
								<Badge variant={payoutsEnabled ? "default" : "secondary"}>
									{SELLER_STATUS_LABEL[onboardingStatus]}
								</Badge>
								{payoutsEnabled ? (
									<Badge className="gap-1" variant="secondary">
										<HugeiconsIcon
											className="size-3.5 text-success"
											icon={CheckmarkBadge04Icon}
										/>
										Payouts enabled
									</Badge>
								) : null}
							</div>
						)}
						{stripeIdentityStatus === "verified" ? (
							<div className="mt-3 flex items-center gap-2 text-muted-foreground text-xs">
								<VerifiedBadge publisherTrust="blue" />
								<span>Identity verified via Stripe Connect</span>
							</div>
						) : stripeIdentityStatus === "restricted" ? (
							<p className="mt-3 text-destructive text-xs">
								Stripe identity verification needs attention before the blue
								publisher mark can be shown.
							</p>
						) : null}
					</div>
				</div>

				<p className="mt-4 text-muted-foreground text-sm">
					Publish organization-owned skills, plugins, and tools on the Ryu
					Marketplace. Free listings do not require Connect. Paid listings use
					organization payouts through Stripe Connect — Stripe handles identity,
					bank, and tax verification, and Ryu never sees your details. A
					platform commission is deducted per sale.
				</p>

				{stripeUnavailable ? (
					<p className="mt-4 rounded-md bg-muted/40 px-3 py-2 text-muted-foreground text-sm">
						Seller onboarding is unavailable: Stripe is not configured on this
						server.
					</p>
				) : (
					<div className="mt-5">
						<Button loading={onboarding} onClick={handleOnboard}>
							{!onboarding && (
								<HugeiconsIcon className="mr-2 size-4" icon={Download01Icon} />
							)}
							{payoutButtonLabel(payoutsEnabled, onboardingStatus)}
						</Button>
						{error && !stripeUnavailable ? (
							<p className="mt-3 text-destructive text-xs">{error.message}</p>
						) : null}
					</div>
				)}
			</div>

			{useMembershipReport && membership.authed ? (
				<div className="mt-5 rounded-lg border border-primary/20 bg-primary/5 p-5">
					<div className="flex items-start justify-between gap-3">
						<div>
							<p className="font-medium text-sm">A Major Pass</p>
							<p className="mt-1 text-muted-foreground text-sm">
								Opt supported paid apps into the A Major Pass publisher pool.
								Ryu allocates 70% of A Major Pass revenue to opted-in publishers
								using weighted app usage.
							</p>
						</div>
						<Badge variant="outline">Recurring plans only</Badge>
					</div>
					<p className="mt-3 text-muted-foreground text-xs">
						One-time buyer licenses remain separate. A publisher payout requires
						a completed Stripe Connect setup.
					</p>
					{membership.loading && !membership.report ? (
						<div className="mt-4 flex items-center gap-2 text-muted-foreground text-sm">
							<Spinner className="size-4" />
							Loading A Major Pass totals…
						</div>
					) : membership.error ? (
						<p className="mt-4 text-destructive text-xs">
							{membership.error.message}
						</p>
					) : membership.report ? (
						<div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
							<div>
								<p className="font-medium text-base">
									{membership.report.eligibleListingCount}
								</p>
								<p className="text-muted-foreground text-xs">
									Eligible paid apps
								</p>
							</div>
							<div>
								<p className="font-medium text-base">
									{formatMinorCurrency(
										membershipTotals?.pendingMinor ?? 0,
										membershipTotals?.currency ?? "usd"
									)}
								</p>
								<p className="text-muted-foreground text-xs">Pending</p>
							</div>
							<div>
								<p className="font-medium text-base">
									{formatMinorCurrency(
										membershipTotals?.paidMinor ?? 0,
										membershipTotals?.currency ?? "usd"
									)}
								</p>
								<p className="text-muted-foreground text-xs">Paid out</p>
							</div>
							<div>
								<p className="font-medium text-base">
									{membershipTotals?.usageCount ?? 0}
								</p>
								<p className="text-muted-foreground text-xs">Usage signals</p>
							</div>
						</div>
					) : null}
				</div>
			) : null}

			<SellerReportsPanel />
		</div>
	);
}
