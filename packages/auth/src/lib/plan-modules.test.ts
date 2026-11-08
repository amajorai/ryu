import { describe, expect, it } from "bun:test";
import * as catalog from "./plan-catalog.ts";
import * as core from "./plan-core.ts";
import * as fees from "./plan-fees.ts";
import * as limits from "./plan-limits.ts";
import * as quotas from "./plan-quotas.ts";
import * as serviceRates from "./plan-service-rates.ts";
import * as subscription from "./plan-subscription.ts";
import * as versionCatalog from "./plan-version-catalog.ts";
import * as versionRows from "./plan-version-rows.ts";
import * as plans from "./plans.ts";

/**
 * `plans.ts` was split by responsibility into these modules and re-exports
 * them, so every `@ryu/auth/lib/plans` import keeps working. This pins that
 * the public surface is the union of the parts, binding for binding.
 */
const PARTS = {
	catalog,
	core,
	fees,
	limits,
	quotas,
	serviceRates,
	subscription,
	versionCatalog,
	versionRows,
} as const;

describe("plans.ts module split", () => {
	it("re-exports every binding of every part unchanged", () => {
		const surface: Record<string, unknown> = plans;
		for (const [part, exports] of Object.entries(PARTS)) {
			for (const [name, value] of Object.entries(exports)) {
				expect(`${part}.${name}:${surface[name] === value}`).toBe(
					`${part}.${name}:true`
				);
			}
		}
	});

	it("never exports the same name from two parts", () => {
		const owners = new Map<string, string>();
		for (const [part, exports] of Object.entries(PARTS)) {
			for (const name of Object.keys(exports)) {
				expect(owners.get(name) ?? part).toBe(part);
				owners.set(name, part);
			}
		}
	});

	it("keeps the catalog and its version rows wired together", () => {
		expect(plans.PLANS.business.id).toBe("business");
		expect(
			plans.planVersionFor("business", plans.currentPlanVersionFor("business"))
				.version
		).toBe(plans.CURRENT_PLAN_VERSION_BY_PLAN.business);
	});
});
