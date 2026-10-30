import {
	businessIncludedCreditUsd,
	businessMonthlyPriceUsd,
} from "./business-pricing.ts";
import {
	formatCount,
	PUBLISHED_PRICING,
	type PublishedMailAllowance,
} from "./data/standalone-pricing.ts";
import {
	annualTotalPrice,
	hostedAgentIncludedCreditUsd,
	hostedAgentMonthlyPriceUsd,
	MARKETPLACE_PASS_MONTHLY_USD,
	MARKETPLACE_PASS_YEARLY_USD,
	MAX_INCLUDED_USD,
	MAX_MONTHLY_USD,
	PLUS_INCLUDED_USD,
	PLUS_MONTHLY_USD,
	PRO_INCLUDED_USD,
	PRO_MONTHLY_USD,
} from "./pricing.tsx";
import {
	CONTRACTED,
	type ComparisonCatalogPlanId,
	type ComparisonCell,
	type ComparisonPlanId,
	type ComparisonRow,
	DESKTOP_LICENSE_LAUNCH_USD,
	PLAN_CAPABILITIES,
} from "./pricing-comparison-plans.ts";

export const usd = (amount: number): string => `$${formatCount(amount)}`;

export const recurring = (monthly: number, isYearly: boolean): string =>
	isYearly ? `${usd(annualTotalPrice(monthly))}/yr` : `${usd(monthly)}/mo`;

export const gib = (value: number): string => `${formatCount(value)} GiB`;
export const gb = (value: number): string => `${formatCount(value)} GB`;

export const { mail } = PUBLISHED_PRICING;

/** The hosted-mail allowance each plan uses (`emailQuotaForPlan`). */
export const MAIL_BY_PLAN = {
	"desktop-license": mail.free,
	"marketplace-membership": mail.free,
	plus: mail.pro,
	pro: mail.pro,
	max: mail.max,
	teams: mail.organization,
	business: mail.organization,
} as const satisfies Record<ComparisonCatalogPlanId, PublishedMailAllowance>;

export const DEPOSIT_FEE_BPS_BY_PLAN = {
	"desktop-license": PUBLISHED_PRICING.depositFee.baseBps,
	"marketplace-membership": PUBLISHED_PRICING.depositFee.baseBps,
	plus: PUBLISHED_PRICING.depositFee.proBps,
	pro: PUBLISHED_PRICING.depositFee.proBps,
	max: PUBLISHED_PRICING.depositFee.teamBps,
	teams: PUBLISHED_PRICING.depositFee.teamBps,
	business: PUBLISHED_PRICING.depositFee.teamBps,
} as const satisfies Record<ComparisonCatalogPlanId, number>;

/** A row whose catalog plans read one mirror and whose Enterprise cell is fixed. */
export function catalogRow(
	read: (plan: ComparisonCatalogPlanId) => ComparisonCell,
	enterprise: ComparisonCell
): Record<ComparisonPlanId, ComparisonCell> {
	return {
		"desktop-license": read("desktop-license"),
		"marketplace-membership": read("marketplace-membership"),
		plus: read("plus"),
		pro: read("pro"),
		max: read("max"),
		teams: read("teams"),
		business: read("business"),
		enterprise,
	};
}

/** A row that only the listed plans carry. */
export function onlyRow(
	plans: readonly ComparisonPlanId[]
): Record<ComparisonPlanId, ComparisonCell> {
	return {
		"desktop-license": plans.includes("desktop-license"),
		"marketplace-membership": plans.includes("marketplace-membership"),
		plus: plans.includes("plus"),
		pro: plans.includes("pro"),
		max: plans.includes("max"),
		teams: plans.includes("teams"),
		business: plans.includes("business"),
		enterprise: plans.includes("enterprise"),
	};
}

export const hasManagedServer = (plan: ComparisonCatalogPlanId): boolean =>
	PLAN_CAPABILITIES[plan].managedAi;

export function priceRow(isYearly: boolean, seats: number): ComparisonRow {
	return {
		id: "price",
		label: isYearly ? "Price, billed yearly" : "Price, billed monthly",
		...(isYearly ? { hint: "Yearly billing includes two months free" } : {}),
		values: {
			pro: recurring(PRO_MONTHLY_USD, isYearly),
			plus: recurring(PLUS_MONTHLY_USD, isYearly),
			max: recurring(MAX_MONTHLY_USD, isYearly),
			"desktop-license": `${usd(DESKTOP_LICENSE_LAUNCH_USD)} once`,
			"marketplace-membership": isYearly
				? `${usd(MARKETPLACE_PASS_YEARLY_USD)}/yr`
				: `${usd(MARKETPLACE_PASS_MONTHLY_USD)}/mo`,
			teams: `${recurring(hostedAgentMonthlyPriceUsd("teams", seats), isYearly)} for ${seats} seats`,
			business: `${recurring(businessMonthlyPriceUsd(seats), isYearly)} for ${seats} seats`,
			enterprise: "Custom",
		},
	};
}

export function creditsRow(seats: number): ComparisonRow {
	return {
		id: "included-credits",
		label: "Included AI credits each month",
		hint: "Organization pools are shared and grow with seats",
		values: {
			pro: usd(PRO_INCLUDED_USD),
			plus: usd(PLUS_INCLUDED_USD),
			max: usd(MAX_INCLUDED_USD),
			"desktop-license": false,
			"marketplace-membership": false,
			teams: usd(hostedAgentIncludedCreditUsd("teams", seats)),
			business: usd(businessIncludedCreditUsd(seats)),
			enterprise: CONTRACTED,
		},
	};
}
