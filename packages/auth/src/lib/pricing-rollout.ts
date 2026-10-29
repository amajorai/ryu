export const PRICING_BILLING_MODES = ["annual", "monthly", "both"] as const;
export type PricingBillingMode = (typeof PRICING_BILLING_MODES)[number];
export const PRICING_BILLING_EXPERIMENT = "pricing.billing_periods.v1";

export function pricingBillingMode(value: unknown): PricingBillingMode {
	return value === "annual" || value === "monthly" ? value : "both";
}
