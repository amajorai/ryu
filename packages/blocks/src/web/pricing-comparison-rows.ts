import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	businessIncludedCreditUsd,
	businessMonthlyPriceUsd,
} from "./business-pricing.ts";
import {
	ENGLISH_PRICING_FORMAT,
	type PricingFormat,
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

const englishLiteral: LiteralMessage = (source, values) =>
	formatMessage(source, values);

/**
 * How one comparison render words and formats its figures: the English
 * published copy by default, the reader's language and number format on screen.
 */
export interface ComparisonFormat {
	format: PricingFormat;
	tl: LiteralMessage;
}

export const ENGLISH_COMPARISON_FORMAT: ComparisonFormat = {
	format: ENGLISH_PRICING_FORMAT,
	tl: englishLiteral,
};

/** A whole-dollar price: "$1,200" in English, "1.200 $" in German. */
export const usd = (
	amount: number,
	{ format }: ComparisonFormat = ENGLISH_COMPARISON_FORMAT
): string => format.price(amount);

export const recurring = (
	monthly: number,
	isYearly: boolean,
	fmt: ComparisonFormat = ENGLISH_COMPARISON_FORMAT
): string =>
	isYearly
		? fmt.tl("{price}/yr", { price: usd(annualTotalPrice(monthly), fmt) })
		: fmt.tl("{price}/mo", { price: usd(monthly, fmt) });

export const gib = (
	value: number,
	{ format }: ComparisonFormat = ENGLISH_COMPARISON_FORMAT
): string => `${format.count(value)} GiB`;
export const gb = (
	value: number,
	{ format }: ComparisonFormat = ENGLISH_COMPARISON_FORMAT
): string => `${format.count(value)} GB`;

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

export function priceRow(
	isYearly: boolean,
	seats: number,
	fmt: ComparisonFormat = ENGLISH_COMPARISON_FORMAT
): ComparisonRow {
	const { tl } = fmt;
	const forSeats = (price: string) =>
		tl("{price} for {seats, plural, one {# seat} other {# seats}}", {
			price,
			seats,
		});
	return {
		id: "price",
		label: isYearly ? "Price, billed yearly" : "Price, billed monthly",
		...(isYearly ? { hint: "Yearly billing includes two months free" } : {}),
		values: {
			pro: recurring(PRO_MONTHLY_USD, isYearly, fmt),
			plus: recurring(PLUS_MONTHLY_USD, isYearly, fmt),
			max: recurring(MAX_MONTHLY_USD, isYearly, fmt),
			"desktop-license": tl("{price} once", {
				price: usd(DESKTOP_LICENSE_LAUNCH_USD, fmt),
			}),
			"marketplace-membership": isYearly
				? tl("{price}/yr", { price: usd(MARKETPLACE_PASS_YEARLY_USD, fmt) })
				: tl("{price}/mo", { price: usd(MARKETPLACE_PASS_MONTHLY_USD, fmt) }),
			teams: forSeats(
				recurring(hostedAgentMonthlyPriceUsd("teams", seats), isYearly, fmt)
			),
			business: forSeats(
				recurring(businessMonthlyPriceUsd(seats), isYearly, fmt)
			),
			enterprise: tl("Custom"),
		},
	};
}

export function creditsRow(
	seats: number,
	fmt: ComparisonFormat = ENGLISH_COMPARISON_FORMAT
): ComparisonRow {
	return {
		id: "included-credits",
		label: "Included AI credits each month",
		hint: "Organization pools are shared and grow with seats",
		values: {
			pro: usd(PRO_INCLUDED_USD, fmt),
			plus: usd(PLUS_INCLUDED_USD, fmt),
			max: usd(MAX_INCLUDED_USD, fmt),
			"desktop-license": false,
			"marketplace-membership": false,
			teams: usd(hostedAgentIncludedCreditUsd("teams", seats), fmt),
			business: usd(businessIncludedCreditUsd(seats), fmt),
			enterprise: CONTRACTED,
		},
	};
}
