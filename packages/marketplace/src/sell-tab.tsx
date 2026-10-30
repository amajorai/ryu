// packages/marketplace/src/sell-tab.tsx
//
// "Become a seller" Stripe Connect onboarding + payout status. Surface-agnostic:
// the seller state comes from the injected host (`useSellerStatus`). A host with
// its own payouts view (`openSellerPayouts`, web: Stripe's embedded Connect
// components in a modal) opens that; otherwise onboarding opens the hosted
// Stripe URL through the host's `openExternal` (Tauri shell on desktop). Payout
// state is granted async by the server webhook, so the host hook re-fetches on
// window focus. `layout="settings"` renders the same states as iOS-style
// settings sections (no page frame or h2) for the organization console; the
// default `"page"` keeps the Store/marketplace tab framing.

import {
	Building01Icon,
	CheckmarkBadge04Icon,
	Download01Icon,
	Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@ryu/blocks/desktop/settings-items.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { formatMinorCurrency } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useCallback } from "react";
import { sileo } from "sileo";
import { CreatorProfileEditor } from "./creators/creator-profile-editor.tsx";
import {
	type MarketplaceMembershipReport,
	type MarketplaceMembershipState,
	useMarketplaceHost,
} from "./host.tsx";
import { SellerReportsPanel } from "./seller-reports.tsx";
import { NoOrgState, SignedOutState } from "./states.tsx";
import type { SellerOnboardingStatus } from "./types.ts";

const SELLER_STATUS_LABEL = {
	none: "Not started",
	pending: "In progress",
	active: "Active",
	restricted: "Restricted",
} satisfies Record<SellerOnboardingStatus, string>;

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

/**
 * Open payout setup: the host's own payouts view when it has one, otherwise a
 * fresh Stripe-hosted onboarding link opened externally.
 */
export async function startSellerPayouts(input: {
	onboard: () => Promise<string>;
	openExternal: (url: string) => Promise<void> | void;
	openSellerPayouts?: () => Promise<void> | void;
}): Promise<"in-app" | "hosted"> {
	if (input.openSellerPayouts) {
		await input.openSellerPayouts();
		return "in-app";
	}
	const url = await input.onboard();
	await input.openExternal(url);
	return "hosted";
}

/** Where the payout setup happens, said under the CTA. */
export function payoutsHandoffCopy(inApp: boolean): string {
	return inApp
		? "Verification, bank details, and payouts open here, powered by Stripe."
		: "Stripe's verification opens in your browser. Your payout status updates here when you return.";
}

const PAYOUTS_DESCRIPTION =
	"Publish organization-owned skills, plugins, and tools on the Ryu Marketplace. Free listings do not require Connect. Paid listings use organization payouts through Stripe Connect — Stripe handles identity, bank, and tax verification, and Ryu never sees your details. A platform commission is deducted per sale.";

const STRIPE_UNAVAILABLE_COPY =
	"Seller onboarding is unavailable: Stripe is not configured on this server.";

const MEMBERSHIP_POOL_COPY =
	"Opt supported paid apps into the A Major Pass publisher pool. Ryu allocates 70% of A Major Pass revenue to opted-in publishers using weighted app usage.";

const MEMBERSHIP_LICENSES_COPY =
	"One-time buyer licenses remain separate. A publisher payout requires a completed Stripe Connect setup.";

/** The onboarding-status badge, plus "Payouts enabled" once Stripe allows it. */
function PayoutStatusBadges({
	onboardingStatus,
	payoutsEnabled,
}: {
	onboardingStatus: SellerOnboardingStatus;
	payoutsEnabled: boolean;
}) {
	return (
		<>
			<Badge variant={payoutsEnabled ? "default" : "secondary"}>
				{SELLER_STATUS_LABEL[onboardingStatus]}
			</Badge>
			{payoutsEnabled ? (
				<Badge variant="secondary">
					<HugeiconsIcon
						className="size-3.5 text-status-success"
						icon={CheckmarkBadge04Icon}
					/>
					Payouts enabled
				</Badge>
			) : null}
		</>
	);
}

/** The four A Major Pass totals (eligible apps, pending, paid out, usage). */
function MembershipTotalsGrid({
	className,
	report,
}: {
	className?: string;
	report: MarketplaceMembershipReport;
}) {
	const totals = report.currencies[0] ?? null;
	return (
		<div
			className={cn("grid grid-cols-2 gap-3 text-sm sm:grid-cols-4", className)}
		>
			<div>
				<p className="font-medium text-xl tabular-nums">
					{report.eligibleListingCount}
				</p>
				<p className="text-detail text-muted-foreground">Eligible paid apps</p>
			</div>
			<div>
				<p className="font-medium text-xl tabular-nums">
					{formatMinorCurrency(
						totals?.pendingMinor ?? 0,
						totals?.currency ?? "usd"
					)}
				</p>
				<p className="text-detail text-muted-foreground">Pending</p>
			</div>
			<div>
				<p className="font-medium text-xl tabular-nums">
					{formatMinorCurrency(
						totals?.paidMinor ?? 0,
						totals?.currency ?? "usd"
					)}
				</p>
				<p className="text-detail text-muted-foreground">Paid out</p>
			</div>
			<div>
				<p className="font-medium text-xl tabular-nums">
					{totals?.usageCount ?? 0}
				</p>
				<p className="text-detail text-muted-foreground">Usage signals</p>
			</div>
		</div>
	);
}

/**
 * `className` adjusts the outer frame (e.g. to align with a host page).
 * `layout="settings"` drops the page frame and header for a settings pane.
 */
export function SellTab({
	className,
	layout = "page",
}: {
	className?: string;
	/** Its own Store/marketplace page (default), or a settings pane. */
	layout?: "page" | "settings";
} = {}) {
	const {
		openExternal,
		openOrganization,
		openSellerPayouts,
		openSignIn,
		useMembershipReport,
		useSellerStatus,
	} = useMarketplaceHost();
	const { status, loading, error, authed, onboard, onboarding, refresh } =
		useSellerStatus();
	const membership = (useMembershipReport ?? MISSING_MEMBERSHIP_REPORT_HOOK)();

	const handleOnboard = useCallback(async () => {
		try {
			const path = await startSellerPayouts({
				onboard,
				openExternal,
				openSellerPayouts,
			});
			if (path === "in-app") {
				return;
			}
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
	}, [onboard, openExternal, openSellerPayouts]);

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
	const showMembership = Boolean(useMembershipReport && membership.authed);
	const refreshButton = (
		<Button onClick={() => refresh()} size="sm" variant="ghost">
			<HugeiconsIcon className="mr-2 size-3.5" icon={Refresh01Icon} />
			Refresh
		</Button>
	);

	if (layout === "settings") {
		return (
			<div className={cn("space-y-6", className)}>
				<SettingsSection
					caption={PAYOUTS_DESCRIPTION}
					headerAction={refreshButton}
					title="Payouts"
				>
					<SettingsGroup>
						<SettingsItem
							actions={
								loading && !status ? (
									<Spinner className="size-4" />
								) : (
									<PayoutStatusBadges
										onboardingStatus={onboardingStatus}
										payoutsEnabled={payoutsEnabled}
									/>
								)
							}
							title="Payout status"
						/>
						{stripeIdentityStatus === "verified" ? (
							<SettingsItem
								actions={
									<HugeiconsIcon
										aria-hidden="true"
										className="size-4 text-status-success"
										icon={CheckmarkBadge04Icon}
									/>
								}
								title="Identity verified via Stripe Connect"
							/>
						) : null}
						{stripeIdentityStatus === "restricted" ? (
							<SettingsItem title="Identity verification">
								<p className="text-status-destructive text-xs">
									Stripe identity verification needs attention in Stripe.
								</p>
							</SettingsItem>
						) : null}
						{stripeUnavailable ? (
							<SettingsItem
								description={STRIPE_UNAVAILABLE_COPY}
								title="Seller onboarding"
							/>
						) : (
							<SettingsItem
								actions={
									<Button
										loading={onboarding}
										onClick={handleOnboard}
										size="sm"
									>
										{payoutButtonLabel(payoutsEnabled, onboardingStatus)}
									</Button>
								}
								description={payoutsHandoffCopy(Boolean(openSellerPayouts))}
								title="Payout account"
							/>
						)}
					</SettingsGroup>
					{error && !stripeUnavailable ? (
						<p className="px-3.5 text-status-destructive text-xs">
							{error.message}
						</p>
					) : null}
				</SettingsSection>

				{showMembership ? (
					<SettingsSection
						caption={`${MEMBERSHIP_POOL_COPY} ${MEMBERSHIP_LICENSES_COPY}`}
						headerAction={<Badge variant="outline">Recurring plans only</Badge>}
						title="A Major Pass"
					>
						{membership.loading && !membership.report ? (
							<SettingsCard className="flex items-center gap-2 text-muted-foreground text-sm">
								<Spinner className="size-4" />
								Loading A Major Pass totals…
							</SettingsCard>
						) : membership.error ? (
							<SettingsCard>
								<p className="text-status-destructive text-xs">
									{membership.error.message}
								</p>
							</SettingsCard>
						) : membership.report ? (
							<SettingsCard>
								<MembershipTotalsGrid report={membership.report} />
							</SettingsCard>
						) : null}
					</SettingsSection>
				) : null}

				<CreatorProfileEditor layout="settings" />

				<SellerReportsPanel layout="settings" />
			</div>
		);
	}

	return (
		<div className={cn("mx-auto max-w-2xl px-6 py-8", className)}>
			<div className="mb-6 flex items-center justify-between">
				<h2 className="font-medium text-lg">Marketplace & payouts</h2>
				{refreshButton}
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
								<PayoutStatusBadges
									onboardingStatus={onboardingStatus}
									payoutsEnabled={payoutsEnabled}
								/>
							</div>
						)}
						{stripeIdentityStatus === "verified" ? (
							<div className="mt-3 flex items-center gap-2 text-muted-foreground text-xs">
								<HugeiconsIcon
									className="size-3.5 text-status-success"
									icon={CheckmarkBadge04Icon}
								/>
								<span>Identity verified via Stripe Connect</span>
							</div>
						) : stripeIdentityStatus === "restricted" ? (
							<p className="mt-3 text-status-destructive text-xs">
								Stripe identity verification needs attention in Stripe.
							</p>
						) : null}
					</div>
				</div>

				<p className="mt-4 text-muted-foreground text-sm">
					{PAYOUTS_DESCRIPTION}
				</p>

				{stripeUnavailable ? (
					<p className="mt-4 rounded-lg bg-muted/40 px-3 py-2 text-muted-foreground text-sm">
						{STRIPE_UNAVAILABLE_COPY}
					</p>
				) : (
					<div className="mt-5">
						<Button loading={onboarding} onClick={handleOnboard}>
							{!onboarding && (
								<HugeiconsIcon className="mr-2 size-4" icon={Download01Icon} />
							)}
							{payoutButtonLabel(payoutsEnabled, onboardingStatus)}
						</Button>
						<p className="mt-3 text-muted-foreground text-xs">
							{payoutsHandoffCopy(Boolean(openSellerPayouts))}
						</p>
						{error && !stripeUnavailable ? (
							<p className="mt-3 text-status-destructive text-xs">
								{error.message}
							</p>
						) : null}
					</div>
				)}
			</div>

			{showMembership ? (
				<div className="mt-5 rounded-lg border border-primary/20 bg-primary/5 p-5">
					<div className="flex items-start justify-between gap-3">
						<div>
							<p className="font-medium text-sm">A Major Pass</p>
							<p className="mt-1 text-muted-foreground text-sm">
								{MEMBERSHIP_POOL_COPY}
							</p>
						</div>
						<Badge variant="outline">Recurring plans only</Badge>
					</div>
					<p className="mt-3 text-muted-foreground text-xs">
						{MEMBERSHIP_LICENSES_COPY}
					</p>
					{membership.loading && !membership.report ? (
						<div className="mt-4 flex items-center gap-2 text-muted-foreground text-sm">
							<Spinner className="size-4" />
							Loading A Major Pass totals…
						</div>
					) : membership.error ? (
						<div className="mt-4 flex flex-wrap items-center gap-3">
							<p className="text-status-destructive text-xs">
								{membership.error.message}
							</p>
							<Button
								onClick={() => void membership.refresh()}
								size="sm"
								variant="outline"
							>
								Try again
							</Button>
						</div>
					) : membership.report ? (
						<MembershipTotalsGrid className="mt-4" report={membership.report} />
					) : null}
				</div>
			) : null}

			<CreatorProfileEditor />

			<SellerReportsPanel />
		</div>
	);
}
