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
import { useCallback } from "react";
import { sileo } from "sileo";
import { useMarketplaceHost } from "./host.tsx";
import { NoOrgState, SignedOutState } from "./states.tsx";
import type { SellerOnboardingStatus } from "./types.ts";

const SELLER_STATUS_LABEL: Record<SellerOnboardingStatus, string> = {
	none: "Not started",
	pending: "In progress",
	active: "Active",
	restricted: "Restricted",
};

/** CTA label for the seller payout button based on onboarding state. */
function payoutButtonLabel(
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
	const { useSellerStatus, openExternal } = useMarketplaceHost();
	const { status, loading, error, authed, onboard, onboarding, refresh } =
		useSellerStatus();

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
				description="Selling paid items is tied to your organization. Sign in to set up payouts."
				title="Sign in to become a seller"
			/>
		);
	}
	if (error && error.kind === "no_org") {
		return (
			<NoOrgState message={error.message} title="No organization selected" />
		);
	}

	const onboardingStatus = status?.onboardingStatus ?? "none";
	const payoutsEnabled = status?.payoutsEnabled ?? false;
	const stripeUnavailable = error && error.kind === "stripe";

	return (
		<div className="mx-auto max-w-2xl px-6 py-8">
			<div className="mb-6 flex items-center justify-between">
				<h2 className="font-semibold text-lg">Become a seller</h2>
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
					</div>
				</div>

				<p className="mt-4 text-muted-foreground text-sm">
					Sell skills, plugins, and tools on the Ryu Marketplace. Payouts run
					through Stripe Connect — Stripe handles identity, bank, and tax
					verification, and Ryu never sees your details. A platform commission
					is deducted per sale.
				</p>

				{stripeUnavailable ? (
					<p className="mt-4 rounded-md bg-muted/40 px-3 py-2 text-muted-foreground text-sm">
						Seller onboarding is unavailable: Stripe is not configured on this
						server.
					</p>
				) : (
					<div className="mt-5">
						<Button disabled={onboarding} onClick={handleOnboard}>
							{onboarding ? (
								<Spinner className="mr-2 size-4" />
							) : (
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
		</div>
	);
}
