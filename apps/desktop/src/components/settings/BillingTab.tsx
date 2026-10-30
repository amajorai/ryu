import { Share08Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { settingsApi, useSubscription } from "@ryu/settings";
import { Button } from "@ryu/ui/components/button.tsx";
import type { PlanTier } from "@ryu/ui/components/plan-badge.tsx";
import { planTierLabel } from "@ryu/ui/components/plan-badge.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { formatMinorCurrency } from "@ryu/ui/lib/number-format.ts";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { sileo } from "sileo";
import { useSession } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { useStepUp } from "@/src/components/StepUpDialog.tsx";
import { useOrgBillingStatus } from "@/src/hooks/useOrgBillingStatus.ts";
import { useActiveOrgId } from "@/src/lib/api/orgs.ts";
import { formatDate } from "@/src/lib/timezone.ts";
import { DesktopAccessSection } from "./BillingTab-desktop-access.tsx";
import { SpendControlsSection } from "./BillingTab-spend-controls.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

export function BillingTab() {
	const tl = useLiteralMessages();
	const { data: session, isPending: sessionPending } = useSession();
	const activeOrgId = useActiveOrgId();
	const {
		hasProSubscription,
		isTrialing,
		daysLeftInTrial,
		isLifetime,
		lifetime,
		planInterval,
		isLoading: subLoading,
	} = useSubscription({
		accountId: session?.user?.id ?? null,
		organizationId: activeOrgId,
		enabled: !sessionPending,
	});
	const { plan: organizationPlan } = useOrgBillingStatus();
	const stepUp = useStepUp();

	const [pendingAction, setPendingAction] = useState<
		"manage" | "lifetime" | null
	>(null);

	const { data: invoicesData, isLoading: invoicesLoading } = useQuery({
		// Keyed on the active org even though the request carries no org: invoices
		// are billed to the org the session is scoped to, so without the id in the
		// key the previous workspace's invoices are served from cache for a paint
		// after a switch, before the invalidation's refetch lands.
		queryKey: ["billing-invoices", activeOrgId],
		queryFn: settingsApi.billing.getInvoices,
	});

	const plan: PlanTier | null = organizationPlan;

	const handleManageSubscription = async () => {
		setPendingAction("manage");
		try {
			const portal = await stepUp.guard("billing", () =>
				settingsApi.billing.getPortalUrl()
			);
			if (portal === null) {
				return;
			}
			const { url } = portal;
			await openExternal(url);
		} catch {
			sileo.error({
				title: "Failed to open subscription portal. Please try again.",
			});
		} finally {
			setPendingAction(null);
		}
	};

	const handleLifetimeCheckout = async () => {
		setPendingAction("lifetime");
		try {
			const checkout = await stepUp.guard("billing", () =>
				settingsApi.billing.createLifetimeCheckout()
			);
			if (checkout === null) {
				return;
			}
			const { url } = checkout;
			await openExternal(url);
		} catch {
			sileo.error({ title: "Failed to open checkout. Please try again." });
		} finally {
			setPendingAction(null);
		}
	};

	const lifetimePending = pendingAction === "lifetime";

	// The plan row's footer: interval or trial status, under the card rather
	// than stacked inside the row.
	let planDescription: ReactNode;
	if (isTrialing) {
		planDescription = (
			<>
				{tl("You're on a free trial.")}{" "}
				{planInterval
					? tl("Billed {planInterval}ly after trial ends.", { planInterval })
					: ""}
				{daysLeftInTrial > 0 ? (
					<span className="mt-1 block text-status-destructive">
						{tl(
							"Trial ends in {daysLeftInTrial, plural, one {# day} other {# days}}",
							{ daysLeftInTrial }
						)}
					</span>
				) : null}
			</>
		);
	} else if (hasProSubscription && !isLifetime) {
		planDescription =
			planInterval === "month" ? "Monthly subscription" : "Annual subscription";
	}

	// A null plan only means the organization status named none (still loading,
	// user-scoped, or a membership plan), not that nothing is paid: fall back to
	// the subscription state rather than claiming "No paid plan".
	let currentPlanLabel = "No paid plan";
	if (plan) {
		currentPlanLabel = planTierLabel(plan);
	} else if (hasProSubscription || isLifetime) {
		currentPlanLabel = "Paid plan";
	}

	return (
		// The billing organization is the nav's org switcher, always in view
		// beside this pane, so the pane does not repeat it as a section.
		<div>
			<DesktopAccessSection />
			<SettingsSection title="Current plan">
				{subLoading ? (
					<SkeletonRows rows={1} />
				) : (
					<SettingsGroup>
						<SettingsItem
							actions={
								hasProSubscription && !isLifetime ? (
									<Button
										loading={pendingAction === "manage"}
										onClick={handleManageSubscription}
										size="sm"
										variant="outline"
									>
										{pendingAction !== "manage" && (
											<HugeiconsIcon icon={Share08Icon} size={14} />
										)}
										Manage subscription
									</Button>
								) : undefined
							}
							description={planDescription}
							title={currentPlanLabel}
						/>
					</SettingsGroup>
				)}
			</SettingsSection>

			<SpendControlsSection />

			<SettingsSection title="Lifetime access">
				{subLoading ? (
					<SkeletonRows rows={1} />
				) : (
					<SettingsGroup>
						<SettingsItem
							actions={
								<Button
									className="shrink-0"
									loading={lifetimePending}
									onClick={handleLifetimeCheckout}
									size="sm"
									variant="outline"
								>
									{!lifetimePending && (
										<HugeiconsIcon icon={Share08Icon} size={14} />
									)}
									{isLifetime
										? lifetime?.expired
											? "Renew — buy lifetime again"
											: "Extend — buy lifetime again"
										: "Get lifetime access"}
								</Button>
							}
							description={
								isLifetime && lifetime ? (
									<>
										{tl("Updates included until {date}", {
											date: formatDate(lifetime.updatesExpiresAt, {
												year: "numeric",
												month: "long",
												day: "numeric",
											}),
										})}
										{lifetime.expired && (
											<span className="mt-1 block text-status-destructive">
												Updates expired. Buy lifetime access again at the
												current price to extend them.
											</span>
										)}
									</>
								) : (
									"Pay once, own it forever. Includes 1 year of updates."
								)
							}
							title="Lifetime"
						/>
					</SettingsGroup>
				)}
			</SettingsSection>

			<SettingsSection title="Invoice history">
				{invoicesLoading ? (
					<SkeletonRows rows={1} />
				) : invoicesData?.invoices?.length ? (
					<SettingsGroup>
						{invoicesData.invoices.map((invoice) => (
							<SettingsItem
								actions={
									<span className="text-sm tabular-nums">
										{formatMinorCurrency(invoice.amount, invoice.currency)}
									</span>
								}
								description={
									<span className="capitalize">{invoice.status}</span>
								}
								key={invoice.id}
								title={formatDate(invoice.createdAt, {
									year: "numeric",
									month: "short",
									day: "numeric",
								})}
							/>
						))}
					</SettingsGroup>
				) : (
					<p className="py-3 text-muted-foreground text-sm">No invoices yet.</p>
				)}
			</SettingsSection>
			{stepUp.dialog}
		</div>
	);
}
