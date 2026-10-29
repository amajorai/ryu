"use client";

// The pricing block's public entry. Every importer reads this module; the
// prices, card chrome, plan cards, grids and instance picker live in the
// sibling `pricing-*` modules re-exported below. Keep the re-exports named:
// this is a client boundary, and `export *` is not allowed across one.

export {
	BUSINESS_ADDITIONAL_SEAT_USD,
	BUSINESS_BASE_MONTHLY_USD,
	BUSINESS_CREDIT_BUNDLE_SIZE,
	BUSINESS_INCLUDED_CREDIT_USD,
	BUSINESS_INCLUDED_SEATS,
	businessIncludedCreditUsd,
	businessMonthlyPriceUsd,
} from "./business-pricing.ts";
export {
	type PricingAppearance,
	PricingAppearanceProvider,
	type PricingCtaVariant,
	PricingCtaVariantProvider,
} from "./pricing-appearance.tsx";
export {
	PricingAudienceToggle,
	PricingBillingToggle,
	PricingDeploymentToggle,
} from "./pricing-controls.tsx";
export {
	MAX_FAMILY_SHARING_MEMBERS,
	MaxPlanCard,
	PlusPlanCard,
	ProPlanCard,
} from "./pricing-individual-cards.tsx";
export {
	type PricingCloudInstance,
	type PricingCloudLocation,
	PricingInstancePicker,
} from "./pricing-instance-picker.tsx";
export {
	LifetimePlanCard,
	MarketplacePassPlanCard,
} from "./pricing-license-cards.tsx";
export {
	EnterprisePlanCard,
	HostedAgentPlanCard,
	TeamsPlanCard,
} from "./pricing-organization-cards.tsx";
export { PricingPlanGrid } from "./pricing-plan-grid.tsx";
export {
	ALWAYS_ON_SERVER_COPY,
	annualTotalPrice,
	type CloudHostingTier,
	type CurrentPricingPlan,
	effectiveMonthlyPrice,
	HOSTED_AGENT_SLIDER_MIN,
	type HostedAgentPricingPlanId,
	hostedAgentIncludedCreditUsd,
	hostedAgentMonthlyPriceUsd,
	MARKETPLACE_PASS_MONTHLY_USD,
	MARKETPLACE_PASS_YEARLY_USD,
	MAX_INCLUDED_USD,
	MAX_MIN_SEATS,
	MAX_MONTHLY_USD,
	PLUS_INCLUDED_USD,
	PLUS_MONTHLY_USD,
	PRICING_AUDIENCE_PLANS,
	PRO_INCLUDED_USD,
	PRO_MONTHLY_USD,
	type PricingAudience,
	type PricingDeployment,
	type PricingPlanSlug,
	SINGAPORE_SERVER_COPY,
	TEAMS_AGENT_STANDARD_USD,
	TEAMS_INCLUDED_CREDIT_BUNDLE_SIZE,
	TEAMS_INCLUDED_PER_BUNDLE_USD,
	TEAMS_INCLUDED_USD,
	TEAMS_LITE_ADDITIONAL_SEAT_USD,
	TEAMS_LITE_INCLUDED_CREDIT_BUNDLE_SIZE,
	TEAMS_LITE_INCLUDED_PER_BUNDLE_USD,
	TEAMS_LITE_INCLUDED_USD,
	TEAMS_LITE_MONTHLY_PER_SEAT_USD,
	TEAMS_LITE_MONTHLY_USD,
	TEAMS_MONTHLY_PER_SEAT_USD,
	TEAMS_MONTHLY_USD,
} from "./pricing-plan-prices.ts";
export {
	HOSTED_AGENT_SLIDER_MAX,
	normalizeTeamsSeatCount,
	TEAMS_MAX_SEATS,
	TEAMS_MIN_SEATS,
} from "./pricing-seat-model.ts";
export {
	SelfHostedLicensedCard,
	SelfHostedOssCard,
	SelfHostedPlanGrid,
} from "./pricing-self-hosted.tsx";
