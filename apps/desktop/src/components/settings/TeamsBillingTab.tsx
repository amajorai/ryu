import { Robot01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	hostedAgentIncludedCreditUsd,
	hostedAgentMonthlyPriceUsd,
	TEAMS_MAX_SEATS,
	TEAMS_MIN_SEATS,
} from "@ryu/blocks/web/pricing.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { sileo } from "sileo";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { useStepUp } from "@/src/components/StepUpDialog.tsx";
import { useBillingStatusStream } from "@/src/hooks/useBillingStatusStream.ts";
import { useCreditGrants } from "@/src/hooks/useCreditGrants.ts";
import { fetchMyPermissions } from "@/src/lib/api/org.ts";
import { useActiveOrgId } from "@/src/lib/api/orgs.ts";
import {
	checkoutOrganizationPlan,
	fetchOrgRole,
	fetchSubscriptionStatus,
	fetchTeamsSeatStatus,
	fetchWallet,
	hasTeamsBillingAuth,
	type OrganizationPlanId,
	openBillingPortalUrl,
	TeamsBillingError,
	updateTeamsSeats,
} from "@/src/lib/api/teams-billing.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";
import {
	formatCreditExpiry,
	normalizeTeamsSeatCount,
	planLabel,
	planMonthlyAmount,
} from "./TeamsBillingTab-pricing.ts";
import { TeamsBillingReviewDialog } from "./TeamsBillingTab-review-dialog.tsx";
import { TeamsBillingSeatsSection } from "./TeamsBillingTab-seats-section.tsx";
import {
	TeamsBillingAccessUnavailable,
	TeamsBillingLoadFailed,
	TeamsBillingNoOrganization,
	TeamsBillingSignedOut,
} from "./TeamsBillingTab-status-cards.tsx";
import { TeamsBillingWalletSection } from "./TeamsBillingTab-wallet-section.tsx";

export { planMonthlyAmount } from "./TeamsBillingTab-pricing.ts";

/**
 * Desktop mirror of the organization Teams seat-billing surface.
 *
 * The organization member count is the access boundary and Polar owns the
 * billed quantity. The AI-credit pool is bundled by billed seat count and
 * shared. Only owners and `billing.manage` holders can mutate billing; the
 * control-plane server is authoritative.
 */
function TeamsBillingTabForOrg({
	activeOrgId,
}: {
	activeOrgId: string | null;
}) {
	const authed = hasTeamsBillingAuth();
	const stepUp = useStepUp();
	const tl = useLiteralMessages();

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
		queryFn:
			organizationId === null || organizationId === undefined
				? skipToken
				: () => fetchOrgRole(organizationId),
	});
	const permissionsQuery = useQuery({
		enabled: authed && Boolean(organizationId),
		queryKey: ["teams-org-permissions", organizationId],
		queryFn:
			organizationId === null || organizationId === undefined
				? skipToken
				: () => fetchMyPermissions(organizationId),
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
			: subQuery.data?.plan === "teams-lite"
				? "teams-lite"
				: subQuery.data?.plan === "teams"
					? "teams"
					: null;
	const isOrganizationPlan = organizationPlanId !== null;
	const seatMinimum = seatStatus?.minRequired ?? TEAMS_MIN_SEATS;
	const previewSeatCount = normalizeTeamsSeatCount(seatText, seatMinimum);
	const previewMonthlyPrice = hostedAgentMonthlyPriceUsd(
		organizationPlanId ?? "teams",
		previewSeatCount
	);
	const previewCreditPool = hostedAgentIncludedCreditUsd(
		organizationPlanId ?? "teams",
		previewSeatCount
	);
	const includedCreditBundle = hostedAgentIncludedCreditUsd(
		organizationPlanId ?? "teams",
		TEAMS_MIN_SEATS
	);

	useEffect(() => {
		const currentSeats = seatStatus?.billedSeats ?? seatStatus?.minRequired;
		setSeatText(String(currentSeats ?? TEAMS_MIN_SEATS));
	}, [seatStatus?.billedSeats, seatStatus?.minRequired]);

	if (!authed) {
		return <TeamsBillingSignedOut />;
	}

	const noOrg = !activeOrgId;
	if (noOrg) {
		return <TeamsBillingNoOrganization />;
	}

	const loadFailed =
		subQuery.isError ||
		walletQuery.isError ||
		roleQuery.isError ||
		seatQuery.isError;
	if (loadFailed) {
		return (
			<TeamsBillingLoadFailed
				onRetry={() => {
					subQuery.refetch().catch(() => undefined);
					walletQuery.refetch().catch(() => undefined);
					roleQuery.refetch().catch(() => undefined);
					seatQuery.refetch().catch(() => undefined);
				}}
			/>
		);
	}

	const role = roleQuery.data ?? null;
	// Same rule the billing routes enforce: owners and holders of
	// `billing.manage` (the Billing role or a custom role). Admins do not.
	// The role alone settles an owner; anyone else waits on the permission
	// read, so a pending or failed read never silently hides a Billing-role
	// member's controls. Only a successful read without the grant hides them;
	// a failed background refetch keeps the last answer it already has.
	const permissionsDecide = roleQuery.isSuccess && role !== "owner";
	const permissions = permissionsQuery.data;
	const accessPending =
		roleQuery.isLoading || (permissionsDecide && permissionsQuery.isLoading);
	const accessFailed =
		permissionsDecide && permissions === undefined && permissionsQuery.isError;
	const canManage =
		role === "owner" ||
		(permissionsDecide && (permissions?.includes("billing.manage") ?? false));
	const loading =
		subQuery.isLoading ||
		walletQuery.isLoading ||
		seatQuery.isLoading ||
		accessPending;
	const currentPlanId = subQuery.data?.plan;
	const currentSeats =
		seatStatus?.billedSeats ?? seatStatus?.minRequired ?? TEAMS_MIN_SEATS;
	const currentAmount = planMonthlyAmount(
		subQuery.data?.plan,
		organizationPlanId ? { seats: currentSeats } : {}
	);
	const currentDetail = isOrganizationPlan
		? seatStatus?.bonusSeats
			? tl(
					"{currentSeats} billed seats + {bonusSeats} negotiated · {memberCount} active members · shared workspace access",
					{
						bonusSeats: String(seatStatus.bonusSeats),
						currentSeats: String(currentSeats),
						memberCount: String(seatStatus?.memberCount ?? 0),
					}
				)
			: tl(
					"{currentSeats} billed seats · {memberCount} active members · shared workspace access",
					{
						currentSeats: String(currentSeats),
						memberCount: String(seatStatus?.memberCount ?? 0),
					}
				)
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
				title: tl("Teams self-serve covers up to {maxSeats} seats", {
					maxSeats: String(TEAMS_MAX_SEATS),
				}),
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
			setSeatText(String(updated.seats));
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
						<SkeletonRows />
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
									? tl(
											seatStatus?.bonusSeats
												? "Your organization is on {plan} at {amount} ({capacity} member capacity: {currentSeats} billed + {bonusSeats} negotiated · {memberCount} active members)."
												: "Your organization is on {plan} at {amount} ({capacity} member capacity: {currentSeats} billed · {memberCount} active members).",
											{
												amount: currentAmount,
												bonusSeats: String(seatStatus?.bonusSeats ?? 0),
												capacity: String(
													seatStatus?.includedSeats ?? currentSeats
												),
												currentSeats: String(currentSeats),
												memberCount: String(seatStatus?.memberCount ?? 0),
												plan: planLabel(organizationPlanId),
											}
										)
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
				{!loading && accessFailed ? (
					<TeamsBillingAccessUnavailable
						isFetching={permissionsQuery.isFetching}
						onRetry={() => {
							permissionsQuery.refetch().catch(() => undefined);
						}}
					/>
				) : null}
			</SettingsSection>

			{isOrganizationPlan && (
				<TeamsBillingSeatsSection
					currentSeats={currentSeats}
					includedCreditBundle={includedCreditBundle}
					organizationPlanId={organizationPlanId}
					seatStatus={seatStatus}
				/>
			)}

			<TeamsBillingWalletSection
				providerAllocations={providerAllocations}
				subQuery={subQuery}
				walletQuery={walletQuery}
			/>

			<TeamsBillingReviewDialog
				currentAmount={currentAmount}
				currentDetail={currentDetail}
				currentPlanId={currentPlanId}
				includedCreditBundle={includedCreditBundle}
				organizationPlanId={organizationPlanId}
				previewCreditPool={previewCreditPool}
				previewMonthlyPrice={previewMonthlyPrice}
				previewSeatCount={previewSeatCount}
				reviewError={reviewError}
				reviewOpen={reviewOpen}
				reviewPending={reviewPending}
				setReviewError={setReviewError}
				setReviewOpen={setReviewOpen}
				startCheckout={startCheckout}
			/>
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
