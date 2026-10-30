"use client";

import { Wallet01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import type { AffiliateStats, CommissionView } from "../../utils/api-client.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "../shared/settings-rows.tsx";
import { commissionStatusVariant, formatMoney } from "./referrals-format.ts";

export function CashCommissionSection({ stats }: { stats: AffiliateStats }) {
	return (
		<SettingsSection
			caption="Paid in money, not credits, once a referred friend subscribes."
			title="Cash commission"
		>
			<dl className="grid grid-cols-3 gap-6 py-3">
				<div className="flex flex-col gap-1">
					<dt className="text-detail text-muted-foreground">Pending</dt>
					<dd className="font-medium text-xl tabular-nums">
						{formatMoney(stats.pendingMinor, stats.currency)}
					</dd>
				</div>
				<div className="flex flex-col gap-1">
					<dt className="text-detail text-muted-foreground">Approved</dt>
					<dd className="font-medium text-xl tabular-nums">
						{formatMoney(stats.approvedMinor, stats.currency)}
					</dd>
				</div>
				<div className="flex flex-col gap-1">
					<dt className="text-detail text-muted-foreground">Paid</dt>
					<dd className="font-medium text-xl tabular-nums">
						{formatMoney(stats.paidMinor, stats.currency)}
					</dd>
				</div>
			</dl>
		</SettingsSection>
	);
}

export interface PayoutAccountSectionProps {
	approvedMinor: number;
	canManagePayouts: boolean;
	onboardPending: boolean;
	onManagePayouts: () => void;
	onOnboard: () => void;
	onPayout: () => void;
	payoutPending: boolean;
	payoutsActive: boolean;
}

export function PayoutAccountSection({
	approvedMinor,
	canManagePayouts,
	onboardPending,
	onManagePayouts,
	onOnboard,
	onPayout,
	payoutPending,
	payoutsActive,
}: PayoutAccountSectionProps) {
	return (
		<SettingsSection
			caption={
				payoutsActive
					? "Your Stripe account is connected and ready to receive payouts."
					: "Connect a Stripe account to receive your commission payouts."
			}
			title="Payout account"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						payoutsActive ? (
							<span className="text-muted-foreground text-sm">
								Payouts enabled
							</span>
						) : (
							<Button
								loading={onboardPending}
								onClick={onOnboard}
								size="sm"
								type="button"
								variant="outline"
							>
								{!onboardPending && (
									<HugeiconsIcon icon={Wallet01Icon} size={16} />
								)}
								Set up payouts
							</Button>
						)
					}
					key="status"
					title="Status"
				/>
				{payoutsActive && canManagePayouts ? (
					<SettingsItem
						actions={
							<Button
								onClick={onManagePayouts}
								size="sm"
								type="button"
								variant="outline"
							>
								Manage payout account
							</Button>
						}
						key="manage"
						title="Stripe account"
					/>
				) : null}
				{payoutsActive ? (
					<SettingsItem
						actions={
							<Button
								disabled={approvedMinor <= 0}
								loading={payoutPending}
								onClick={onPayout}
								size="sm"
								type="button"
								variant="outline"
							>
								{!payoutPending && (
									<HugeiconsIcon icon={Wallet01Icon} size={16} />
								)}
								Pay out approved balance
							</Button>
						}
						key="payout"
						title="Approved balance"
					/>
				) : null}
			</SettingsGroup>
		</SettingsSection>
	);
}

export function RecentCommissionsSection({
	commissions,
}: {
	commissions: CommissionView[];
}) {
	return (
		<SettingsSection title="Recent commissions">
			{commissions.length === 0 ? (
				<p className="py-3 text-muted-foreground text-sm">
					No commissions yet. Share your link to start earning.
				</p>
			) : (
				<SettingsGroup>
					{commissions.map((commission) => (
						<SettingsItem
							actions={
								// A badge only for the exceptional states (reversed,
								// rejected); a normal status is plain muted text.
								commissionStatusVariant(commission.status) === "destructive" ? (
									<Badge variant="destructive">{commission.status}</Badge>
								) : (
									<span className="text-muted-foreground text-sm">
										{commission.status}
									</span>
								)
							}
							description={
								<span className="tabular-nums">
									{formatMoney(
										commission.commissionAmountMinor,
										commission.currency
									)}
								</span>
							}
							key={commission.id}
							title={commission.sourceType}
						/>
					))}
				</SettingsGroup>
			)}
		</SettingsSection>
	);
}
