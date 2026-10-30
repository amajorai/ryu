import {
	currentPlanVersionFor,
	monthlyPriceMicroUsdForSeats,
	PLAN_IDS,
	PLAN_VERSIONS,
	PLANS,
	type PlanId,
	type PlanVersion,
} from "@ryu/auth/lib/plans";
import { SELF_SERVE_MAX_SEATS } from "@ryu/auth/lib/seat-tiers";
import { TEAMS_MIN_SEATS } from "@ryu/blocks/web/pricing.tsx";
import type { LiteralMessage } from "@ryu/i18n/react";
import { formatMicroUsd } from "@ryu/ui/lib/number-format.ts";
import type { OrganizationPlanId } from "@/src/lib/api/teams-billing.ts";
import { formatDate } from "@/src/lib/timezone.ts";

/** Friendly labels for the internal plan slugs the backend returns. */
const PLAN_LABELS = new Map<string, string>([
	["free", "Free"],
	["hobby", "Hobby"],
	["max", "Max Plan"],
	["pro", "Pro Plan"],
	["teams", "Teams"],
	["teams-lite", "Teams Lite"],
	["business", "Business"],
]);

export function planLabel(plan: string | null | undefined): string {
	if (!plan) {
		return "No plan";
	}
	return PLAN_LABELS.get(plan) ?? plan.charAt(0).toUpperCase() + plan.slice(1);
}

export function normalizeTeamsSeatCount(
	value: string,
	minimum = TEAMS_MIN_SEATS
): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) {
		return minimum;
	}
	return Math.max(minimum, Math.floor(parsed));
}

export function formatMonthlyUsd(value: number): string {
	return `${formatMicroUsd(Math.round(value * 1_000_000))}/mo`;
}

const isCatalogPlanId = (plan: string): plan is PlanId =>
	(PLAN_IDS as readonly string[]).includes(plan);

/**
 * Stamped rows from retired offers whose charge one catalog row cannot
 * reproduce: the hosted-agent Pro/Max contracts priced a variable agent count
 * on top of the row's base, and the early Teams rows pre-date per-seat billing.
 * The display names no figure for them rather than inventing one.
 */
const UNPRICEABLE_LEGACY_VERSIONS: Partial<Record<PlanId, readonly number[]>> =
	{
		max: [2, 3],
		pro: [2, 3],
		teams: [1, 2, 3, 4],
	};

const isUnpriceableLegacyVersion = (
	plan: PlanId,
	version: PlanVersion
): boolean =>
	UNPRICEABLE_LEGACY_VERSIONS[plan]?.includes(version.version) ?? false;

/**
 * The monthly amount a subscription pays, from the billing catalog: the
 * stamped (grandfathered) plan version when known, otherwise today's list
 * price, at the billed seat count for organization plans. An unknown stamped
 * version falls back to the current price rather than guessing an older row.
 */
export function planMonthlyAmount(
	plan: string | null | undefined,
	contract: {
		planVersion?: number | string | null;
		seats?: number | null;
	} = {}
): string {
	if (plan === "desktop-license") {
		return "Paid once";
	}
	if (!(plan && isCatalogPlanId(plan))) {
		return "$0/mo";
	}
	const catalogPlan = PLANS[plan];
	const rows = PLAN_VERSIONS[plan];
	const stamped =
		contract.planVersion === null ||
		contract.planVersion === undefined ||
		contract.planVersion === ""
			? undefined
			: rows.find((row) => row.version === Number(contract.planVersion));
	const version =
		stamped ??
		rows.find((row) => row.version === currentPlanVersionFor(plan)) ??
		rows[0];
	if (isUnpriceableLegacyVersion(plan, version)) {
		return "Contract pricing";
	}
	const minimumSeats =
		catalogPlan.seatModel.kind === "per_seat"
			? catalogPlan.seatModel.minSeats
			: 1;
	const perSeat = catalogPlan.seatModel.kind === "per_seat";
	const billedSeats =
		perSeat && contract.seats && Number.isFinite(contract.seats)
			? Math.max(minimumSeats, Math.floor(contract.seats))
			: null;
	if (billedSeats !== null && billedSeats > SELF_SERVE_MAX_SEATS) {
		// Seat counts beyond self-serve are contracted, whatever the row's formula.
		return "Contract pricing";
	}
	let amountMicroUsd: number;
	try {
		amountMicroUsd = monthlyPriceMicroUsdForSeats({
			plan: catalogPlan,
			seats: billedSeats ?? minimumSeats,
			version,
		});
	} catch {
		// Seat counts beyond the self-serve price bands are contracted.
		return "Contract pricing";
	}
	const amount = `${formatMicroUsd(amountMicroUsd, "USD", 2)}/mo`;
	if (!perSeat || billedSeats !== null) {
		return amount;
	}
	return `${amount} minimum`;
}

/** How an organization plan's shared pool grows with billed seats. */
export function poolBundleRule(
	plan: OrganizationPlanId | null,
	tl: LiteralMessage
): string {
	return plan === "business"
		? tl("each completed five-seat bundle")
		: tl("each started five-seat bundle");
}

export function formatCreditExpiry(value: string | null): string | null {
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
