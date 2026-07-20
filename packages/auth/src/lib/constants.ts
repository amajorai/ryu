import { PLANS, type PolarBinding, resolveProductId } from "./plans.ts";

const bindingFor = (binding: PolarBinding | undefined): PolarBinding => {
	if (!binding) {
		throw new Error("Plan catalog is missing an expected Polar binding");
	}
	return binding;
};

/**
 * Legacy Polar product list, kept for the billing router's slug-based lookups
 * (e.g. `lifetime`). The plan-backed slugs (pro/max monthly + yearly, the
 * desktop license) now DERIVE their product id from the single source of truth
 * in `plans.ts` (env-driven), so there is one place a product id lives.
 *
 * Prefer importing from `plans.ts` for new code; this list exists for backward
 * compatibility with the existing checkout/subscription-status handlers.
 */
export const POLAR_PRODUCTS = [
	{
		productId: resolveProductId(bindingFor(PLANS.pro.bindings.monthly)),
		slug: "pro-monthly",
	},
	{
		productId: resolveProductId(bindingFor(PLANS.pro.bindings.yearly)),
		slug: "pro-yearly",
	},
	{
		productId: resolveProductId(
			bindingFor(PLANS["desktop-license"].bindings.one_time)
		),
		slug: "lifetime",
	},
	{
		productId: resolveProductId(bindingFor(PLANS.max.bindings.monthly)),
		slug: "max-monthly",
	},
	{
		productId: resolveProductId(bindingFor(PLANS.max.bindings.yearly)),
		slug: "max-yearly",
	},
	{
		// Teams was offered in the pricing grid but had NO entry here, so both
		// Teams checkout buttons resolved no product and failed. Wire both
		// intervals (per-seat products; the seat price id lives on the binding).
		productId: resolveProductId(bindingFor(PLANS.teams.bindings.monthly)),
		slug: "teams-monthly",
	},
	{
		productId: resolveProductId(bindingFor(PLANS.teams.bindings.yearly)),
		slug: "teams-yearly",
	},
	// Ryu Cloud instances are now billed via a single ad-hoc Polar product
	// (`POLAR_PRODUCT_CLOUD_INSTANCE`) with a per-checkout price computed live
	// from the Hetzner catalog — there are no per-tier cloud products to list
	// here. The free BASE node has no product (it is granted by Max). See
	// `cloud-tiers.ts` + `packages/api/src/routers/billing.ts`.
];
