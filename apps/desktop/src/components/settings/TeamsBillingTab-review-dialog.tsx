import { TEAMS_AGENT_STANDARD_USD } from "@ryu/blocks/web/pricing.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { BeforeAfterSummary } from "@ryu/ui/components/before-after-summary.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { formatMicroUsd } from "@ryu/ui/lib/number-format.ts";
import type { OrganizationPlanId } from "@/src/lib/api/teams-billing.ts";
import {
	formatMonthlyUsd,
	planLabel,
	poolBundleRule,
} from "./TeamsBillingTab-pricing.ts";

/** The before/after review shown before Ryu opens the Teams checkout. */
export function TeamsBillingReviewDialog({
	currentAmount,
	currentDetail,
	currentPlanId,
	includedCreditBundle,
	organizationPlanId,
	previewCreditPool,
	previewMonthlyPrice,
	previewSeatCount,
	reviewError,
	reviewOpen,
	reviewPending,
	setReviewError,
	setReviewOpen,
	startCheckout,
}: {
	currentAmount: string;
	currentDetail: string;
	currentPlanId: string | null | undefined;
	includedCreditBundle: number;
	organizationPlanId: OrganizationPlanId | null;
	previewCreditPool: number;
	previewMonthlyPrice: number;
	previewSeatCount: number;
	reviewError: string | null;
	reviewOpen: boolean;
	reviewPending: boolean;
	setReviewError: (value: string | null) => void;
	setReviewOpen: (value: boolean) => void;
	startCheckout: () => Promise<void>;
}) {
	const tl = useLiteralMessages();
	return (
		<Dialog
			onOpenChange={(open) => {
				setReviewOpen(open);
				if (!open) {
					setReviewError(null);
				}
			}}
			open={reviewOpen}
		>
			<DialogContent showCloseButton={!reviewPending}>
				<DialogHeader>
					<DialogTitle>Review plan change</DialogTitle>
					<DialogDescription>
						Review the organization plan and member-seat quantity before Ryu
						opens the secure checkout.
					</DialogDescription>
				</DialogHeader>
				<BeforeAfterSummary
					current={{
						amount: currentAmount,
						detail: currentDetail,
						eyebrow: "Current",
						label: planLabel(currentPlanId),
					}}
					footer={{
						detail: tl(
							"Shared AI pool: {pool}/mo. It adds {bundle} for {rule}. Each additional billed member seat is {seatPrice}/mo.",
							{
								bundle: `$${includedCreditBundle}`,
								pool: formatMicroUsd(Math.round(previewCreditPool * 1_000_000)),
								rule: poolBundleRule(organizationPlanId, tl),
								seatPrice: `$${TEAMS_AGENT_STANDARD_USD}`,
							}
						),
						label: "New allowance",
						value: `${previewSeatCount} member seats`,
					}}
					next={{
						amount: formatMonthlyUsd(previewMonthlyPrice),
						detail: tl(
							"{seats} member seats · shared workspace · seat changes prorate and charge now",
							{ seats: String(previewSeatCount) }
						),
						eyebrow: "New",
						label: planLabel(organizationPlanId ?? "teams"),
					}}
				/>
				{reviewError ? (
					<p className="text-sm text-status-destructive" role="alert">
						{reviewError}
					</p>
				) : null}
				<DialogFooter>
					<DialogClose
						disabled={reviewPending}
						render={<Button disabled={reviewPending} variant="ghost" />}
					>
						Cancel
					</DialogClose>
					<Button loading={reviewPending} onClick={() => void startCheckout()}>
						Continue to checkout
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
