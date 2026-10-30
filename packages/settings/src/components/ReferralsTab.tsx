"use client";

import { Button } from "@ryu/ui/components/button.tsx";
import { SensitiveDataScope } from "@ryu/ui/components/sensitive-value.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import type { CommissionRule } from "../utils/api-client.ts";
import { settingsApi } from "../utils/api-client.ts";
import {
	CashCommissionSection,
	PayoutAccountSection,
	RecentCommissionsSection,
} from "./referrals/cash-commission-sections.tsx";
import { DefaultCommissionSection } from "./referrals/default-commission-section.tsx";
import { EnableAffiliateSection } from "./referrals/enable-affiliate-section.tsx";
import { InvitePassSection } from "./referrals/invite-pass-section.tsx";
import {
	CREDITS_KEY,
	DASHBOARD_KEY,
	DEFAULT_RULE,
} from "./referrals/referrals-format.ts";
import { ReferralCreditsSection } from "./shared/referral-credits-section.tsx";

export interface ReferralsTabProps {
	/**
	 * Name printed on the invite pass. Optional because neither surface's tab
	 * owns a session — the desktop dialog and the web profile page each already
	 * have the signed-in user on hand and pass it down. Absent, the card renders
	 * unpersonalised rather than guessing.
	 */
	holderName?: string | null;
	/**
	 * The pass's metal ring follows the app's RESOLVED theme, not the OS. Both
	 * shells have a manual toggle that can disagree with `prefers-color-scheme`,
	 * and the ring is the one part of the card that cannot read the difference on
	 * its own — see `PassCardShell.metalTheme`.
	 */
	metalTheme?: "auto" | "dark" | "light";
	onOpenExternal?: (url: string) => Promise<void> | void;
	/**
	 * Open the surface's own payouts view for the organization that receives
	 * commission payouts (web: Stripe's embedded Connect components in a
	 * modal). Absent, payout setup opens Stripe's hosted onboarding link
	 * through `onOpenExternal` (or a new tab).
	 */
	onOpenPayouts?: (payoutOrgId: string) => Promise<void> | void;
}

export function ReferralsTab(props: ReferralsTabProps) {
	return (
		<SensitiveDataScope>
			<ReferralsTabContent {...props} />
		</SensitiveDataScope>
	);
}

function ReferralsTabContent({
	holderName,
	metalTheme = "auto",
	onOpenExternal,
	onOpenPayouts,
}: ReferralsTabProps) {
	const queryClient = useQueryClient();
	const [copied, setCopied] = useState(false);
	const [editorOpen, setEditorOpen] = useState(false);
	const [rule, setRule] = useState<CommissionRule>(DEFAULT_RULE);

	const { data, isError, isLoading, refetch } = useQuery({
		queryKey: DASHBOARD_KEY,
		queryFn: settingsApi.affiliate.get,
	});
	// The pass's footer facts. Deliberately NOT gated on the affiliate opt-in:
	// credit attribution runs from sign-up whether or not the cash program is on,
	// so a card that showed nothing until someone enabled commissions would be
	// hiding referrals they already have.
	const { data: credits } = useQuery({
		queryKey: CREDITS_KEY,
		queryFn: settingsApi.referrals.credits,
	});

	const invalidate = () =>
		queryClient.invalidateQueries({ queryKey: DASHBOARD_KEY });

	const openExternal = async (url: string) => {
		if (onOpenExternal) {
			await onOpenExternal(url);
			return;
		}
		window.open(url, "_blank", "noopener,noreferrer");
	};

	const enableMutation = useMutation({
		mutationFn: settingsApi.affiliate.enable,
		onSuccess: () => {
			invalidate();
			sileo.success({ title: "Affiliate program enabled" });
		},
		onError: (e) =>
			sileo.error({
				title: e instanceof Error ? e.message : "Failed to enable program",
			}),
	});

	const onboardMutation = useMutation({
		mutationFn: () =>
			settingsApi.affiliate.onboard({
				returnUrl: window.location.href,
				refreshUrl: window.location.href,
			}),
		// The onboard call also binds the active organization as the payout org,
		// so it runs on both paths; an in-app surface then opens its own payouts
		// view for that org instead of Stripe's hosted link.
		onSuccess: async (result) => {
			invalidate();
			if (onOpenPayouts) {
				await onOpenPayouts(result.payoutOrgId);
				return;
			}
			await openExternal(result.url);
		},
		onError: (e) =>
			sileo.error({
				title: e instanceof Error ? e.message : "Failed to start onboarding",
			}),
	});

	const payoutMutation = useMutation({
		mutationFn: settingsApi.affiliate.payout,
		onSuccess: () => {
			invalidate();
			sileo.success({ title: "Payout started" });
		},
		onError: (e) =>
			sileo.error({
				title: e instanceof Error ? e.message : "Failed to start payout",
			}),
	});

	const commissionMutation = useMutation({
		mutationFn: (next: CommissionRule | null) =>
			settingsApi.affiliate.setDefaultCommission(next),
		onSuccess: () => {
			invalidate();
			sileo.success({ title: "Default commission saved" });
		},
		onError: (e) =>
			sileo.error({
				title: e instanceof Error ? e.message : "Failed to save commission",
			}),
	});

	const handleCopy = async () => {
		if (!data?.referralLink) {
			return;
		}
		await navigator.clipboard.writeText(data.referralLink);
		setCopied(true);
		setTimeout(() => setCopied(false), 1800);
	};

	const openEditor = () => {
		setRule(data?.defaultCommission ?? DEFAULT_RULE);
		setEditorOpen((prev) => !prev);
	};

	if (isLoading) {
		return <SkeletonRows label="Loading referrals" />;
	}

	if (isError || !data) {
		return (
			<div className="flex min-h-12 items-center justify-between gap-6 py-3">
				<p className="text-muted-foreground text-sm">
					Couldn't load your affiliate dashboard. Please try again.
				</p>
				<Button
					className="shrink-0"
					onClick={() => void refetch()}
					size="sm"
					type="button"
					variant="outline"
				>
					Retry
				</Button>
			</div>
		);
	}

	const { stats, payout } = data;
	const payoutsActive = payout.onboardingStatus === "active";
	const canManagePayouts = Boolean(onOpenPayouts && data.payoutOrgId);

	return (
		<div>
			<InvitePassSection
				copied={copied}
				credits={credits}
				data={data}
				holderName={holderName}
				metalTheme={metalTheme}
				onCopy={handleCopy}
			/>

			<ReferralCreditsSection />

			{data.enabled ? null : (
				<EnableAffiliateSection
					onEnable={() => enableMutation.mutate()}
					pending={enableMutation.isPending}
				/>
			)}

			{data.enabled ? (
				<>
					<CashCommissionSection stats={stats} />

					<PayoutAccountSection
						approvedMinor={stats.approvedMinor}
						canManagePayouts={canManagePayouts}
						onboardPending={onboardMutation.isPending}
						onManagePayouts={() => {
							if (onOpenPayouts && data.payoutOrgId) {
								void onOpenPayouts(data.payoutOrgId);
							}
						}}
						onOnboard={() => onboardMutation.mutate()}
						onPayout={() => payoutMutation.mutate()}
						payoutPending={payoutMutation.isPending}
						payoutsActive={payoutsActive}
					/>

					<DefaultCommissionSection
						editorOpen={editorOpen}
						hasDefaultCommission={Boolean(data.defaultCommission)}
						onClear={() => commissionMutation.mutate(null)}
						onSave={() => commissionMutation.mutate(rule)}
						onToggleEditor={openEditor}
						rule={rule}
						savePending={commissionMutation.isPending}
						setRule={setRule}
					/>

					<RecentCommissionsSection commissions={data.recentCommissions} />
				</>
			) : null}
		</div>
	);
}
