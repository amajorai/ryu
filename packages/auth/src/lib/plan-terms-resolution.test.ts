import { describe, expect, it } from "bun:test";
import {
	bindingFor,
	currentRowFor,
	isCurrentRow,
	LEGACY_SHARED_PRODUCT_MAX_VERSION,
	PLAN_IDS,
	PLAN_VERSIONS,
	PLANS,
	type PlanVersion,
	type PlanVersionCatalog,
	planByProductId,
	planIdFromStamp,
	planProductIndex,
	planVersionFor,
	resolveEntitlement,
	resolveProductId,
	resolveSubscriptionRow,
} from "./plans.ts";

/** Every env var resolves to a distinct, recognisable product id. */
const read = (key: string): string => `id_${key}`;

const productFor = (
	plan: (typeof PLAN_IDS)[number],
	interval: "monthly" | "yearly"
) => {
	const binding = PLANS[plan].bindings[interval];
	if (!binding) {
		throw new Error(`${plan} has no ${interval} binding`);
	}
	return resolveProductId(binding, read);
};

/** A future Teams v6 that owns its products, as every new row must. */
const TEAMS_V5 = PLAN_VERSIONS.teams.find(
	(candidate) => candidate.version === 5
);
if (!TEAMS_V5) {
	throw new Error("teams v5 missing");
}
const TEAMS_V6: PlanVersion = {
	...TEAMS_V5,
	bindings: {
		monthly: {
			productIdDefault: "polar_product_teams_v6_monthly",
			productIdEnv: "POLAR_PRODUCT_TEAMS_V6_MONTHLY",
		},
		yearly: {
			productIdDefault: "polar_product_teams_v6_yearly",
			productIdEnv: "POLAR_PRODUCT_TEAMS_V6_YEARLY",
		},
	},
	monthlyPriceMicroUsd: 55_000_000,
	shippedOn: "2027-01-01",
	version: 6,
};
const WITH_TEAMS_V6: PlanVersionCatalog = {
	...PLAN_VERSIONS,
	teams: [...PLAN_VERSIONS.teams, TEAMS_V6],
};

describe("resolveSubscriptionRow", () => {
	it("is behaviour-identical to planVersionFor for every shared product and stamp", () => {
		for (const plan of PLAN_IDS) {
			for (const interval of ["monthly", "yearly", "one_time"] as const) {
				const binding = PLANS[plan].bindings[interval];
				if (!binding) {
					continue;
				}
				const productId = resolveProductId(binding, read);
				const stamps = [
					undefined,
					null,
					"",
					"999",
					"not-a-number",
					...PLAN_VERSIONS[plan].map((row) => row.version),
					...PLAN_VERSIONS[plan].map((row) => String(row.version)),
				];
				for (const planVersion of stamps) {
					const resolved = resolveSubscriptionRow(
						{ planVersion, productId },
						read
					);
					expect(resolved?.plan.id).toBe(plan);
					expect(resolved?.interval).toBe(interval);
					expect(resolved?.row).toBe(planVersionFor(plan, planVersion));
				}
			}
		}
	});

	it("reports how it chose the row", () => {
		const productId = productFor("pro", "monthly");
		expect(
			resolveSubscriptionRow({ planVersion: "4", productId }, read)?.source
		).toBe("metadata");
		expect(
			resolveSubscriptionRow({ planVersion: "99", productId }, read)?.source
		).toBe("fallback");
		expect(resolveSubscriptionRow({ productId }, read)?.row.version).toBe(1);
	});

	it("resolves a foreign plan stamp to the newest shared row, never a guessed old one", () => {
		// A Teams Lite v1 customer who changed plan onto the Teams product keeps
		// their Teams Lite stamp; Teams v1 ($49, $15 pool) must not be guessed.
		const resolved = resolveSubscriptionRow(
			{
				planStamp: "teams-lite-monthly",
				planVersion: "1",
				productId: productFor("teams", "monthly"),
			},
			read
		);
		expect(resolved?.source).toBe("foreign_stamp");
		expect(resolved?.row.version).toBe(LEGACY_SHARED_PRODUCT_MAX_VERSION.teams);
		// The same plan's slug stamp is not foreign.
		expect(
			resolveSubscriptionRow(
				{
					planStamp: "teams-monthly",
					planVersion: "4",
					productId: productFor("teams", "monthly"),
				},
				read
			)?.source
		).toBe("metadata");
	});

	it("normalises checkout slug and bare plan stamps", () => {
		expect(planIdFromStamp("pro-monthly")).toBe("pro");
		expect(planIdFromStamp("teams-lite-yearly")).toBe("teams-lite");
		expect(planIdFromStamp("teams")).toBe("teams");
		expect(planIdFromStamp("lifetime")).toBeNull();
		expect(planIdFromStamp(42)).toBeNull();
	});

	it("returns null for an unknown or missing product", () => {
		expect(
			resolveSubscriptionRow({ productId: "prod_unknown" }, read)
		).toBeNull();
		expect(resolveSubscriptionRow({ productId: null }, read)).toBeNull();
	});

	it("resolves a row-owned product to its row whatever the metadata says", () => {
		// The migrated case: Polar cannot re-stamp metadata, so a v5 stamp stays
		// on a subscription that now sits on the v6 product.
		const resolved = resolveSubscriptionRow(
			{ planVersion: "5", productId: "id_POLAR_PRODUCT_TEAMS_V6_MONTHLY" },
			read,
			WITH_TEAMS_V6
		);
		expect(resolved?.source).toBe("product");
		expect(resolved?.row.version).toBe(6);
		expect(resolved?.plan.id).toBe("teams");
	});

	it("keeps the legacy product's rows to the legacy versions", () => {
		const index = planProductIndex(read, WITH_TEAMS_V6);
		const legacy = index.get(productFor("teams", "monthly"));
		expect(legacy?.kind).toBe("legacy");
		expect(legacy?.rows.map((row) => row.version)).toEqual([1, 2, 3, 4, 5]);
		expect(bindingFor("teams", TEAMS_V6, "monthly")?.productIdEnv).toBe(
			"POLAR_PRODUCT_TEAMS_V6_MONTHLY"
		);
		// A row after the legacy max with no bindings sells on nothing.
		expect(
			bindingFor("teams", { ...TEAMS_V6, bindings: undefined }, "monthly")
		).toBeNull();
	});

	it("keeps cell stamps only when they match the row's variant and regions", () => {
		const productId = productFor("teams", "monthly");
		expect(
			resolveSubscriptionRow(
				{ planVersion: "5", productId, variantStamp: "hetzner:standard:sin" },
				read
			)?.cell
		).toEqual({ capacity: "standard", provider: "hetzner", region: "sin" });
		expect(
			resolveSubscriptionRow(
				{ planVersion: "5", productId, variantStamp: "vultr:standard:eu" },
				read
			)?.cell
		).toBeNull();
	});
});

describe("product index", () => {
	it("gives every product id exactly one owner", () => {
		const seen = new Map<string, string>();
		for (const plan of PLAN_IDS) {
			for (const [interval, binding] of Object.entries(PLANS[plan].bindings)) {
				const id = resolveProductId(binding, read);
				expect(seen.has(id)).toBe(false);
				seen.set(id, `${plan}:${interval}`);
			}
			for (const row of PLAN_VERSIONS[plan]) {
				for (const binding of Object.values(row.bindings ?? {})) {
					const id = resolveProductId(binding, read);
					expect(seen.has(id)).toBe(false);
					seen.set(id, `${plan}:v${row.version}`);
				}
			}
		}
		expect(planByProductId(read).size).toBe(seen.size);
	});

	it("feeds resolveEntitlement the row a migrated product owns", () => {
		const legacy = resolveEntitlement(
			{
				planVersion: "5",
				productId: productFor("teams", "monthly"),
				seats: 10,
				status: "active",
			},
			null,
			read
		);
		expect(legacy.plan).toBe("teams");
		expect(legacy.monthlyCreditPoolMicroUsd).toBe(100_000_000);
	});
});

describe("current rows", () => {
	it("sells exactly one row per recurring plan in every region", () => {
		for (const plan of PLAN_IDS) {
			for (const region of ["eu", "sin"] as const) {
				const row = currentRowFor(plan, {
					capacity: "standard",
					provider: "hetzner",
					region,
				});
				expect(row?.version).toBe(
					PLAN_VERSIONS[plan].find((r) => isCurrentRow(plan, r))?.version
				);
			}
		}
		expect(
			currentRowFor("teams", {
				capacity: "standard",
				provider: "vultr",
				region: "eu",
			})
		).toBeNull();
	});
});
