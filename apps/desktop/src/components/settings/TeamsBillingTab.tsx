import { Robot01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	businessMonthlyPriceUsd,
	hostedAgentIncludedCreditUsd,
	TEAMS_AGENT_STANDARD_USD,
	TEAMS_MAX_SEATS,
	TEAMS_MIN_SEATS,
} from "@ryu/blocks/web/pricing.tsx";
import { BeforeAfterSummary } from "@ryu/ui/components/before-after-summary.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { CreditBalanceBreakdown } from "@ryu/ui/components/credit-balance-breakdown.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { formatMicroUsd } from "@ryu/ui/lib/number-format.ts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { sileo } from "sileo";
import { FRONTEND_URL } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { useStepUp } from "@/src/components/StepUpDialog.tsx";
import { useBillingStatusStream } from "@/src/hooks/useBillingStatusStream.ts";
import { useCreditGrants } from "@/src/hooks/useCreditGrants.ts";
import { useActiveOrgId } from "@/src/lib/api/orgs.ts";
import {
	checkoutOrganizationPlan,
	fetchOrgRole,
	fetchSubscriptionStatus,
	fetchTeamsSeatStatus,
	fetchWallet,
	type HostedAgentPlanId,
	hasTeamsBillingAuth,
	type OrganizationPlanId,
	openBillingPortalUrl,
	TeamsBillingError,
	updateTeamsSeats,
} from "@/src/lib/api/teams-billing.ts";
import { formatDate } from "@/src/lib/timezone.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/** Where a solo user goes to create or pick an organization. */
const ORGANIZATIONS_URL = `${FRONTEND_URL.replace(/\/$/, "")}/organizations`;

/** Friendly labels for the internal plan slugs the backend returns. */
const PLAN_LABELS: Record<string, string> = {
	free: "Free",
	hobby: "Hobby",
	max: "Max Plan",
	pro: "Pro Plan",
	teams: "Teams",
	business: "Business",
};

function planLabel(plan: string | null | undefined): string {
	if (!plan) {
		return "No plan";
	}
	return PLAN_LABELS[plan] ?? plan.charAt(0).toUpperCase() + plan.slice(1);
}

function normalizeTeamsSeatCount(
	value: string,
	minimum = TEAMS_MIN_SEATS
): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) {
		return minimum;
	}
	return Math.max(minimum, Math.floor(parsed));
}

function formatMonthlyUsd(value: number): string {
	return `${formatMicroUsd(Math.round(value * 1_000_000))}/mo`;
}

function legacyPlanAmount(plan: string | null | undefined): string {
	switch (plan) {
		case "max":
			return "$99/mo";
		case "pro":
			return "$49/mo";
		case "teams":
			return "$250/mo";
		case "business":
			return "$300/mo minimum";
		default:
			return "$0/mo";
	}
}

function formatCreditExpiry(value: string | null): string | null {
	if (!value) {
		return null;
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return null;
	}
	return `Expires ${formatDate(date, {
		day: "numeric",
		month: "short",
		year: "numeric",
	})}`;
}

/**
 * Desktop mirror of the organization Teams seat-billing surface.
 *
 * The organization member count is the access boundary and Polar owns the
 * billed quantity. The AI-credit pool is bundled by billed seat count and
 * shared. Only
 * owner/admin can mutate billing; the control-plane server is authoritative.
 */
function TeamsBillingTabForOrg({
	activeOrgId,
}: {
	activeOrgId: string | null;
}) {
	const authed = hasTeamsBillingAuth();
	const stepUp = useStepUp();

	const subQuery = useQuery({
		enabled: authed,
		queryKey: ["teams-subscription-status", activeOrgId],
		queryFn: fetchSubscriptionStatus,
	});
	const walletQuery = useQuery({
		enabled: authed,
		queryKey: ["teams-wallet", activeOrgId],
		queryFn: fetchWallet,
		retry: false,
	});
	const organizationId = subQuery.data?.organizationId ?? activeOrgId;
	const roleQuery = useQuery({
		enabled: authed && Boolean(organizationId),
		queryKey: ["teams-org-role", organizationId],
		queryFn: () => fetchOrgRole(organizationId as string),
	});
	const seatQuery = useQuery({
		enabled: authed && Boolean(organizationId),
		queryKey: ["teams-seat-status", organizationId],
		queryFn: fetchTeamsSeatStatus,
	});

	// Live webhook snapshots update the same subscription cache as the initial
	// request, so a plan or seat change made in another billing surface is
	// reflected here without a refresh.
	const queryClient = useQueryClient();
	const liveBilling = useBillingStatusStream();
	const { pools: grantPools } = useCreditGrants();
	const providerAllocations = useMemo(
		() =>
			grantPools.map((pool, index) => ({
				expiresAtLabel: formatCreditExpiry(pool.expiresAt),
				id: `${pool.label}-${index}`,
				isFreeProvider: pool.isFreeProvider,
				label: pool.label,
				remainingMicroUsd: pool.remainingMicroUsd,
			})),
		[grantPools]
	);
	useEffect(() => {
		if (!liveBilling) {
			return;
		}
		queryClient.setQueryData(
			["teams-subscription-status", activeOrgId],
			liveBilling.subscription
		);
	}, [liveBilling, queryClient, activeOrgId]);

	const [seatText, setSeatText] = useState(String(TEAMS_MIN_SEATS));
	const [reviewOpen, setReviewOpen] = useState(false);
	const [reviewPending, setReviewPending] = useState(false);
	const [reviewError, setReviewError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const seatStatus = seatQuery.data ?? null;
	const organizationPlanId: OrganizationPlanId | null =
		subQuery.data?.plan === "business"
			? "business"
			: subQuery.data?.plan === "teams"
				? "teams"
				: null;
	const isOrganizationPlan = organizationPlanId !== null;
	const seatMinimum = seatStatus?.minRequired ?? TEAMS_MIN_SEATS;
	const previewSeatCount = normalizeTeamsSeatCount(seatText, seatMinimum);
	const previewMonthlyPrice =
		organizationPlanId === "business"
			? businessMonthlyPriceUsd(previewSeatCount)
			: TEAMS_AGENT_STANDARD_USD * previewSeatCount;
	const previewCreditPool = hostedAgentIncludedCreditUsd(
		organizationPlanId ?? "teams",
		previewSeatCount
	);

	useEffect(() => {
		const currentSeats = seatStatus?.billedSeats ?? seatStatus?.minRequired;
		setSeatText(String(currentSeats ?? TEAMS_MIN_SEATS));
	}, [seatStatus?.billedSeats, seatStatus?.minRequired]);

	if (!authed) {
		return (
			<SettingsSection title="Teams">
				<p className="px-3 text-muted-foreground text-sm">
					Sign in to manage your organization&apos;s Teams seats.
				</p>
			</SettingsSection>
		);
	}

	const noOrg = !activeOrgId;
	if (noOrg) {
		return (
			<SettingsSection title="Teams">
				<SettingsCard>
					<div className="flex flex-col items-start gap-3">
						<p className="text-muted-foreground text-sm">
							Teams is an organization plan. Create or join an organization to
							set up shared credits and member seats.
						</p>
						<Button
							onClick={() => {
								openExternal(ORGANIZATIONS_URL).catch(() => undefined);
							}}
							size="sm"
						>
							Create or select an organization
						</Button>
					</div>
				</SettingsCard>
			</SettingsSection>
		);
	}

	const loadFailed =
		subQuery.isError ||
		walletQuery.isError ||
		roleQuery.isError ||
		seatQuery.isError;
	if (loadFailed) {
		return (
			<SettingsSection title="Teams">
				<SettingsCard>
					<div className="flex flex-col items-start gap-3">
						<p className="text-muted-foreground text-sm">
							We couldn&apos;t load your organization billing details. Check
							your connection and try again.
						</p>
						<Button
							onClick={() => {
								subQuery.refetch().catch(() => undefined);
								walletQuery.refetch().catch(() => undefined);
								roleQuery.refetch().catch(() => undefined);
								seatQuery.refetch().catch(() => undefined);
							}}
							size="sm"
							variant="ghost"
						>
							Try again
						</Button>
					</div>
				</SettingsCard>
			</SettingsSection>
		);
	}

	const role = roleQuery.data ?? null;
	const canManage = role === "owner" || role === "admin";
	const loading =
		subQuery.isLoading || walletQuery.isLoading || seatQuery.isLoading;
	const currentPlanId = subQuery.data?.plan as
		| HostedAgentPlanId
		| OrganizationPlanId
		| null;
	const currentSeats =
		seatStatus?.billedSeats ?? seatStatus?.minRequired ?? TEAMS_MIN_SEATS;
	const currentAmount = organizationPlanId
		? formatMonthlyUsd(
				organizationPlanId === "business"
					? businessMonthlyPriceUsd(currentSeats)
					: TEAMS_AGENT_STANDARD_USD * currentSeats
			)
		: legacyPlanAmount(subQuery.data?.plan);
	const currentDetail = isOrganizationPlan
		? `${currentSeats} billed seats${seatStatus?.bonusSeats ? ` + ${seatStatus.bonusSeats} negotiated` : ""} · ${seatStatus?.memberCount ?? 0} active members · shared workspace access`
		: subQuery.data?.plan
			? "Existing organization plan"
			: "No active Teams plan";

	const startCheckout = async () => {
		setReviewError(null);
		setReviewPending(true);
		try {
			const checkout = await stepUp.guard("billing", () =>
				checkoutOrganizationPlan(
					organizationPlanId ?? "teams",
					"monthly",
					previewSeatCount,
					organizationId
				)
			);
			if (checkout === null) {
				return;
			}
			const { url } = checkout;
			await openExternal(url);
			setReviewOpen(false);
		} catch (error) {
			const message =
				error instanceof TeamsBillingError
					? error.message
					: "Failed to start checkout.";
			setReviewError(message);
		} finally {
			setReviewPending(false);
		}
	};

	const saveSeats = async () => {
		if (previewSeatCount > TEAMS_MAX_SEATS) {
			sileo.error({
				title: `Teams self-serve covers up to ${TEAMS_MAX_SEATS} seats`,
				description: "Contact Enterprise for larger organizations.",
			});
			return;
		}
		setBusy(true);
		try {
			const updated = await stepUp.guard("billing", () =>
				updateTeamsSeats(previewSeatCount)
			);
			if (updated === null) {
				return;
			}
			await seatQuery.refetch();
			sileo.success({ title: "Teams seats updated" });
		} catch (error) {
			sileo.error({
				title:
					error instanceof TeamsBillingError
						? error.message
						: "Failed to update Teams seats",
			});
		} finally {
			setBusy(false);
		}
	};

	const manage = async () => {
		setBusy(true);
		try {
			const portal = await stepUp.guard("billing", () =>
				openBillingPortalUrl()
			);
			if (portal === null) {
				return;
			}
			const { url } = portal;
			await openExternal(url);
		} catch (error) {
			sileo.error({
				title:
					error instanceof TeamsBillingError
						? error.message
						: "Failed to open billing portal.",
			});
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="space-y-6">
			<SettingsSection title="Plan">
				{loading ? (
					<SettingsCard>
						<Spinner className="size-4" />
					</SettingsCard>
				) : (
					<SettingsGroup>
						<SettingsItem
							actions={
								canManage ? (
									isOrganizationPlan ? (
										<div className="flex items-center gap-2">
											<Input
												aria-label="Teams seats"
												className="w-24"
												max={TEAMS_MAX_SEATS}
												min={seatMinimum}
												onChange={(event) => setSeatText(event.target.value)}
												step={1}
												type="number"
												value={seatText}
											/>
											<Button
												disabled={busy}
												onClick={() => void saveSeats()}
												size="sm"
											>
												Save seats
											</Button>
											<Button
												disabled={busy}
												onClick={() => void manage()}
												size="sm"
												variant="ghost"
											>
												Manage billing
											</Button>
										</div>
									) : (
										<div className="flex items-center gap-2">
											<Input
												aria-label="Teams seats"
												className="w-24"
												max={TEAMS_MAX_SEATS}
												min={seatMinimum}
												onChange={(event) => setSeatText(event.target.value)}
												step={1}
												type="number"
												value={seatText}
											/>
											<Button
												disabled={busy}
												onClick={() => {
													setReviewError(null);
													setReviewOpen(true);
												}}
												size="sm"
											>
												Review Teams
											</Button>
										</div>
									)
								) : undefined
							}
							description={
								isOrganizationPlan
									? `Your organization is on ${planLabel(organizationPlanId)} (${seatStatus?.includedSeats ?? currentSeats} member capacity: ${currentSeats} billed${seatStatus?.bonusSeats ? ` + ${seatStatus.bonusSeats} negotiated` : ""} · ${seatStatus?.memberCount ?? 0} active members).`
									: "Subscribe your organization to Teams for shared managed inference and member seats."
							}
							title={
								<span className="flex items-center gap-2">
									<HugeiconsIcon
										className="size-4 text-muted-foreground"
										icon={Robot01Icon}
									/>
									{isOrganizationPlan
										? planLabel(organizationPlanId ?? "teams")
										: planLabel(subQuery.data?.plan)}
								</span>
							}
						/>
					</SettingsGroup>
				)}
			</SettingsSection>

			{isOrganizationPlan && (
				<SettingsSection title="Seats">
					<SettingsGroup>
						<SettingsItem
							description={`${seatStatus?.memberCount ?? 0} active members and ${seatStatus?.pendingInvitations ?? 0} pending invitations reserve seats. ${seatStatus?.allocatedSeats ?? 0} allocated of ${seatStatus?.includedSeats ?? "—"} capacity (${currentSeats} billed${seatStatus?.bonusSeats ? ` + ${seatStatus.bonusSeats} negotiated` : ""}); the shared pool adds $${organizationPlanId === "business" ? 100 : 50} per five billed seats.`}
							title="Member seats"
						/>
					</SettingsGroup>
				</SettingsSection>
			)}

			<SettingsSection title="Pooled wallet">
				{walletQuery.isLoading ? (
					<SettingsCard>
						<Spinner className="size-4" />
					</SettingsCard>
				) : (
					<SettingsCard>
						<CreditBalanceBreakdown
							balanceBreakdownAvailable={
								walletQuery.data?.wallet.balanceBreakdownAvailable
							}
							compact
							currency={walletQuery.data?.wallet.currency}
							onDemandCreditsMicroUsd={
								walletQuery.data?.wallet.topupBalanceMicroUsd ?? null
							}
							planAllowanceMicroUsd={
								subQuery.data?.entitlement.monthlyCreditPoolMicroUsd ?? null
							}
								planCreditsMicroUsd={
									walletQuery.data?.wallet.subscriptionBalanceMicroUsd ?? null
								}
								providerAllocations={
									walletQuery.data?.wallet.balanceBreakdownAvailable === false
										? (walletQuery.data.wallet.providerAllocations?.map(
												(allocation) => ({
													expiresAtLabel: formatCreditExpiry(
														allocation.expiresAt
													),
													id: allocation.poolId,
													isFreeProvider: allocation.isFreeProvider,
													label: allocation.label,
													remainingMicroUsd: allocation.remainingMicroUsd,
												})
											) ?? null)
										: providerAllocations
								}
							totalMicroUsd={walletQuery.data?.wallet.balanceMicroUsd ?? null}
						/>
					</SettingsCard>
				)}
			</SettingsSection>

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
							detail: `Shared AI pool: ${formatMicroUsd(Math.round(previewCreditPool * 1_000_000))}/mo. It adds $${organizationPlanId === "business" ? 100 : 50} per five billed seats. Each additional billed member seat is $${TEAMS_AGENT_STANDARD_USD}/mo.`,
							label: "New allowance",
							value: `${previewSeatCount} member seats`,
						}}
						next={{
							amount: formatMonthlyUsd(previewMonthlyPrice),
							detail: `${previewSeatCount} member seats · shared workspace · seat changes prorate and charge now`,
							eyebrow: "New",
							label: planLabel(organizationPlanId ?? "teams"),
						}}
					/>
					{reviewError ? (
						<p className="text-destructive text-sm" role="alert">
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
						<Button
							loading={reviewPending}
							onClick={() => void startCheckout()}
						>
							Continue to checkout
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			{stepUp.dialog}
		</div>
	);
}

/**
 * One instance per active workspace. Keying by the org clears the query,
 * live-stream, and agent input state together when the workspace
 * changes, so billing details never bleed between organizations.
 */
export function TeamsBillingTab() {
	const activeOrgId = useActiveOrgId();
	return (
		<TeamsBillingTabForOrg
			activeOrgId={activeOrgId}
			key={activeOrgId ?? "pending"}
		/>
	);
}
