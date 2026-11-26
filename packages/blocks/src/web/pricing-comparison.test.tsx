import { describe, expect, it } from "bun:test";
import {
	boxConcurrencyFor,
	boxIncludedStorageGib,
	currentPlanVersionFor,
	DEPOSIT_FEE_BPS_BY_PLAN,
	emailQuotaForPlan,
	LIFETIME_LAUNCH_PRICE_USD,
	monthlyCreditPoolMicroUsdForSeats,
	monthlyPriceMicroUsdForSeats,
	PLANS,
	type PlanId,
	planLimit,
	planVersionFor,
} from "@ryu/auth/lib/plans";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatBps, formatCount } from "./data/standalone-pricing.ts";
import {
	type ComparisonCatalogPlanId,
	type ComparisonOptions,
	type ComparisonPlanId,
	type ComparisonSection,
	comparisonPlans,
	comparisonSections,
	DESKTOP_LICENSE_LAUNCH_USD,
	PLAN_CAPABILITIES,
	RUNNING_BOXES_BY_PLAN,
	recommendedComparisonPlan,
	SPACE_STORAGE_GB_BY_PLAN,
} from "./pricing-comparison.ts";
import { PricingComparisonTable } from "./pricing-comparison-table.tsx";
import { TEAMS_MAX_SEATS, TEAMS_MIN_SEATS } from "./pricing-seat-model.ts";

const MICRO_USD_PER_USD = 1_000_000;
const BYTES_PER_GIB = 1024 ** 3;

const CATALOG_PLANS = [
	"desktop-license",
	"marketplace-membership",
	"plus",
	"pro",
	"max",
	"teams",
	"business",
] as const satisfies readonly ComparisonCatalogPlanId[];

const ALL_COLUMNS = {
	audience: "individual",
	aMajorPassEnabled: true,
	familySharingEnabled: true,
	plusPublicEnabled: true,
	productCount: 12,
} as const satisfies ComparisonOptions;

const usd = (amount: number): string => `$${formatCount(amount)}`;

const version = (plan: PlanId) =>
	planVersionFor(plan, currentPlanVersionFor(plan));

const catalogPriceUsd = (plan: PlanId, seats: number): number =>
	monthlyPriceMicroUsdForSeats({
		plan: PLANS[plan],
		seats,
		version: version(plan),
	}) / MICRO_USD_PER_USD;

const catalogPoolUsd = (plan: PlanId, seats: number): number =>
	monthlyCreditPoolMicroUsdForSeats({
		plan: PLANS[plan],
		seats,
		version: version(plan),
	}) / MICRO_USD_PER_USD;

/** Every cell of one row, for both audiences (individual and organization). */
function cellsOf(
	rowId: string,
	options: Partial<ComparisonOptions> = {}
): unknown {
	const cells: Partial<Record<ComparisonPlanId, unknown>> = {};
	for (const audience of ["individual", "business"] as const) {
		const sections = comparisonSections({
			...ALL_COLUMNS,
			...options,
			audience,
		});
		const row = sections
			.flatMap((section) => section.rows)
			.find((candidate) => candidate.id === rowId);
		if (!row) {
			continue;
		}
		for (const plan of comparisonPlans({ ...ALL_COLUMNS, audience })) {
			cells[plan.id] = row.values[plan.id];
		}
	}
	return cells;
}

/** Widens a literal-typed mirror so it compares against catalog numbers. */
const mirror = (value: object): unknown => value;

const rowIds = (sections: readonly ComparisonSection[]): string[] =>
	sections.flatMap((section) => section.rows.map((row) => row.id));

describe("plan comparison mirrors the billing catalog", () => {
	it("declared mirrors match plans.ts", () => {
		expect(DESKTOP_LICENSE_LAUNCH_USD).toBe(LIFETIME_LAUNCH_PRICE_USD);
		for (const plan of CATALOG_PLANS) {
			expect(mirror({ plan, running: RUNNING_BOXES_BY_PLAN[plan] })).toEqual({
				plan,
				running: boxConcurrencyFor(plan, TEAMS_MIN_SEATS).maxRunning,
			});
			expect(mirror({ plan, gb: SPACE_STORAGE_GB_BY_PLAN[plan] })).toEqual({
				plan,
				gb: planLimit(plan, "spaceStorageLimitGb"),
			});
			expect(mirror({ plan, ...PLAN_CAPABILITIES[plan] })).toEqual({
				plan,
				brandingRemovable: PLANS[plan].emailBrandingRemovable,
				managedAi: PLANS[plan].managedInference,
				marketplaceApps: PLANS[plan].marketplaceApps,
				organization: PLANS[plan].audience === "organization",
			});
		}
	});

	it("monthly and yearly prices match the current version rows", () => {
		for (const seats of [TEAMS_MIN_SEATS, 6, 10, 23, TEAMS_MAX_SEATS]) {
			for (const isYearly of [false, true]) {
				const suffix = isYearly ? "/yr" : "/mo";
				const total = (monthly: number) =>
					usd(isYearly ? monthly * 10 : monthly) + suffix;
				expect(cellsOf("price", { isYearly, seats })).toEqual({
					pro: total(catalogPriceUsd("pro", 1)),
					plus: total(catalogPriceUsd("plus", 1)),
					max: total(catalogPriceUsd("max", 1)),
					"desktop-license": `${usd(LIFETIME_LAUNCH_PRICE_USD)} once`,
					"marketplace-membership": total(
						catalogPriceUsd("marketplace-membership", 1)
					),
					teams: `${total(catalogPriceUsd("teams", seats))} for ${seats} seats`,
					business: `${total(catalogPriceUsd("business", seats))} for ${seats} seats`,
					enterprise: "Custom",
				});
			}
		}
	});

	it("included credits match the catalog pool at the selected seats", () => {
		for (const seats of [TEAMS_MIN_SEATS, 6, 10, 14, 15, TEAMS_MAX_SEATS]) {
			expect(cellsOf("included-credits", { seats })).toEqual({
				pro: usd(catalogPoolUsd("pro", 1)),
				plus: usd(catalogPoolUsd("plus", 1)),
				max: usd(catalogPoolUsd("max", 1)),
				"desktop-license": false,
				"marketplace-membership": false,
				teams: usd(catalogPoolUsd("teams", seats)),
				business: usd(catalogPoolUsd("business", seats)),
				enterprise: "Contracted",
			});
		}
		// The Enterprise hand-off (51+) keeps the cards' 50-seat anchor.
		expect(cellsOf("included-credits", { seats: TEAMS_MAX_SEATS + 1 })).toEqual(
			cellsOf("included-credits", { seats: TEAMS_MAX_SEATS })
		);
	});

	it("deposit fees, mail, and storage match the enforced quotas", () => {
		const fromCatalog = (read: (plan: ComparisonCatalogPlanId) => unknown) => ({
			...Object.fromEntries(CATALOG_PLANS.map((plan) => [plan, read(plan)])),
			enterprise: "Contracted",
		});
		expect(cellsOf("deposit-fee")).toEqual(
			fromCatalog((plan) => formatBps(DEPOSIT_FEE_BPS_BY_PLAN[plan]))
		);
		expect(cellsOf("mailboxes")).toEqual(
			fromCatalog((plan) => {
				const limit = emailQuotaForPlan(plan).inboxLimit;
				return limit === Number.POSITIVE_INFINITY
					? "Unlimited"
					: formatCount(limit);
			})
		);
		expect(cellsOf("monthly-emails")).toEqual(
			fromCatalog((plan) =>
				formatCount(emailQuotaForPlan(plan).monthlySendLimit)
			)
		);
		expect(cellsOf("stored-mail")).toEqual(
			fromCatalog(
				(plan) =>
					`${formatCount(emailQuotaForPlan(plan).storageLimitBytes / BYTES_PER_GIB)} GiB`
			)
		);
		expect(cellsOf("remove-branding")).toEqual(
			fromCatalog((plan) => PLANS[plan].emailBrandingRemovable)
		);
		expect(cellsOf("space-storage")).toEqual(
			fromCatalog(
				(plan) => `${formatCount(planLimit(plan, "spaceStorageLimitGb"))} GB`
			)
		);
		expect(cellsOf("running-boxes")).toEqual(
			fromCatalog((plan) =>
				formatCount(boxConcurrencyFor(plan, TEAMS_MIN_SEATS).maxRunning)
			)
		);
		expect(cellsOf("box-storage")).toEqual(
			fromCatalog((plan) => `${formatCount(boxIncludedStorageGib(plan))} GiB`)
		);
		expect(cellsOf("managed-ai")).toEqual({
			...fromCatalog((plan) => PLANS[plan].managedInference),
			enterprise: true,
		});
		expect(cellsOf("marketplace-apps")).toEqual(
			fromCatalog((plan) => PLANS[plan].marketplaceApps)
		);
	});
});

describe("plan comparison columns", () => {
	it("follows the shelf and its rollout flags", () => {
		const ids = (options: ComparisonOptions) =>
			comparisonPlans(options).map((plan) => plan.id);
		expect(ids({ audience: "individual" })).toEqual([
			"pro",
			"max",
			"desktop-license",
		]);
		expect(ids(ALL_COLUMNS)).toEqual([
			"pro",
			"max",
			"plus",
			"desktop-license",
			"marketplace-membership",
		]);
		expect(ids({ ...ALL_COLUMNS, audience: "business" })).toEqual([
			"teams",
			"business",
			"enterprise",
		]);
	});

	it("never shows private plans or server specs", () => {
		const html = [
			renderToStaticMarkup(createElement(PricingComparisonTable, ALL_COLUMNS)),
			renderToStaticMarkup(
				createElement(PricingComparisonTable, {
					...ALL_COLUMNS,
					audience: "business",
				})
			),
		].join("\n");
		expect(html).not.toContain("Teams Lite");
		expect(html).not.toMatch(/vCPU|\bRAM\b|\bCPX?\d|\bCX\d|Hetzner/u);
		const withoutPlus = renderToStaticMarkup(
			createElement(PricingComparisonTable, {
				...ALL_COLUMNS,
				plusPublicEnabled: false,
			})
		);
		expect(withoutPlus).not.toContain(">Plus<");
	});

	it("drops rows no visible column has", () => {
		const individual = rowIds(comparisonSections(ALL_COLUMNS));
		const organization = rowIds(
			comparisonSections({ ...ALL_COLUMNS, audience: "business" })
		);
		expect(individual).toContain("priority-support");
		expect(individual).toContain("family-sharing");
		expect(individual).not.toContain("sso-scim");
		expect(organization).toContain("sso-scim");
		expect(organization).not.toContain("priority-support");
		expect(organization).not.toContain("family-sharing");
		expect(
			rowIds(comparisonSections({ audience: "individual" }))
		).not.toContain("family-sharing");
		expect(
			rowIds(comparisonSections({ audience: "individual" }))
		).not.toContain("all-products");
	});

	it("renders an accessible table", () => {
		const html = renderToStaticMarkup(
			createElement(PricingComparisonTable, ALL_COLUMNS)
		);
		expect(html).toContain("<table");
		expect(html).toContain("<caption");
		expect(html).toContain('scope="col"');
		expect(html).toContain('scope="row"');
		expect(html).toContain('scope="colgroup"');
		expect(html).toContain('<span class="sr-only">Included</span>');
		expect(html).toContain('<span class="sr-only">Not included</span>');
	});

	it("gives the phone's one plan column the width for any plan", () => {
		// Business is shown first for organizations, but its hidden neighbours
		// leave the grid, so it sits in the first plan column on a phone.
		const html = renderToStaticMarkup(
			createElement(PricingComparisonTable, { audience: "business", seats: 5 })
		);
		const cols = html
			.slice(html.indexOf("<colgroup"), html.indexOf("</colgroup>"))
			.match(/<col\b[^>]*>/gu);
		expect(cols).toHaveLength(4);
		expect(cols?.[1]).not.toContain("max-md:w-0");
		expect(cols?.[2]).toContain("max-md:w-0");
		expect(cols?.[3]).toContain("max-md:w-0");
	});

	it("keeps plan names and prices in a sticky header row", () => {
		const html = renderToStaticMarkup(
			createElement(PricingComparisonTable, {
				audience: "business",
				isYearly: false,
				seats: 10,
			})
		);
		const head = html.slice(html.indexOf("<thead"), html.indexOf("</thead>"));
		expect(
			head.match(/sticky top-\[var\(--pricing-sticky-top,0px\)\]/gu)
		).toHaveLength(4);
		const price = (plan: PlanId) =>
			`${usd(catalogPriceUsd(plan, 10))}/mo for 10 seats`;
		expect(head).toContain(price("teams"));
		expect(head).toContain(price("business"));
		expect(head).toContain("Custom");
		// The page never scrolls sideways: no horizontal scroller around the table.
		expect(html).toContain('<div class="overflow-clip rounded-2xl');
		expect(html.slice(html.indexOf("<table"))).not.toContain("overflow-x-auto");
	});

	it("marks the column the shelf highlights as recommended, once", () => {
		expect(recommendedComparisonPlan({ audience: "individual" })).toBe("pro");
		expect(
			recommendedComparisonPlan({
				audience: "business",
				seats: TEAMS_MAX_SEATS,
			})
		).toBe("business");
		expect(
			recommendedComparisonPlan({
				audience: "business",
				seats: TEAMS_MAX_SEATS + 1,
			})
		).toBe("enterprise");
		for (const options of [
			ALL_COLUMNS,
			{ ...ALL_COLUMNS, audience: "business" },
		] as const) {
			const html = renderToStaticMarkup(
				createElement(PricingComparisonTable, options)
			);
			expect(html.match(/>Recommended</gu)).toHaveLength(1);
		}
	});

	it("folds each group behind a button and offers a plan switcher for phones", () => {
		const html = renderToStaticMarkup(
			createElement(PricingComparisonTable, ALL_COLUMNS)
		);
		const sections = comparisonSections(ALL_COLUMNS);
		// Server render: every group open, so the table is complete without JavaScript.
		expect(html.match(/aria-expanded="true"/gu)).toHaveLength(sections.length);
		expect(html).not.toContain('aria-expanded="false"');
		for (const section of sections) {
			expect(html).toContain(`data-comparison-section="${section.id}"`);
		}
		expect(html).toContain('data-testid="pricing-comparison-plan-switcher"');
		for (const plan of comparisonPlans(ALL_COLUMNS)) {
			expect(html).toContain(`data-plan="${plan.id}"`);
		}
		// One plan at a time below `md`: the other columns are hidden there only.
		expect(html).toContain("max-md:hidden");
	});

	it("explains unclear rows in one line and ends with a call to action", () => {
		const html = renderToStaticMarkup(
			createElement(PricingComparisonTable, {
				...ALL_COLUMNS,
				audience: "business",
			})
		);
		const hints = comparisonSections(ALL_COLUMNS)
			.flatMap((section) => section.rows)
			.filter((row) => row.hint);
		expect(hints.map((row) => row.id)).toEqual(
			expect.arrayContaining(["always-on-server", "bring-your-own-keys"])
		);
		const cta = html.slice(html.indexOf('data-testid="pricing-compare-cta"'));
		expect(cta).toContain('href="#plans"');
		expect(cta).toContain('href="/contact"');
		expect(
			renderToStaticMarkup(createElement(PricingComparisonTable, ALL_COLUMNS))
		).not.toContain('href="/contact"');
	});

	it("passes the billing terms through the translator", () => {
		const wrap = (source: string) => `[de] ${source}`;
		const billing = comparisonSections(ALL_COLUMNS, wrap, "de")
			.flatMap((section) => section.rows)
			.find((row) => row.id === "billing-terms");
		expect(billing?.values.pro).toBe("[de] Monthly or yearly");
		expect(billing?.values.enterprise).toBe("[de] Annual contract");
	});
});
