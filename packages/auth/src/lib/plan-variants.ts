import { z } from "zod";

/**
 * PLAN VARIANTS — the dimensions one plan version can be sold along.
 *
 * A plan version (`PLAN_VERSIONS` in `plans.ts`) is a price and a pool. A
 * VARIANT is where and on what that price is delivered: which infrastructure
 * provider runs the included server, and which pricing region the buyer is in.
 * A subscription records the CELL it bought (`provider:capacity:region`) in its
 * server-set checkout metadata, so a later provider or regional price change can
 * be scoped to exactly the subscribers it affects.
 *
 * WHAT IS LIVE TODAY. One provider (Hetzner), two pricing regions (`eu`, `sin`)
 * and ONE capacity. Every plan includes the same base server (founder decision,
 * 2026-10-19), and the organization plans' same-price `cpx22` stock fallback is
 * a placement detail, not something a customer buys or is billed for. So
 * `capacity` is a dimension with a single value: it is kept so a future
 * capacity offer is a new value here plus new rows, not a schema change, and it
 * must never be used to charge for stock.
 *
 * Client-safe: types and pure helpers only, no product ids or env names.
 */

/** Infrastructure providers a plan variant may name. */
export const PLAN_PROVIDERS = ["hetzner", "vultr", "ovh"] as const;
export type PlanProvider = (typeof PLAN_PROVIDERS)[number];

/**
 * Providers the platform can actually provision today. A row naming any other
 * provider is refused by the catalog invariants until its provisioner, cost
 * rows and node profiles exist.
 */
export const PROVISIONABLE_PROVIDERS = [
	"hetzner",
] as const satisfies readonly PlanProvider[];

/**
 * Capacity offers. ONE value: every plan has one base server. Do not add a
 * value without a founder pricing decision; a capacity that depends on stock
 * would bill customers for something they did not choose.
 */
export const PLAN_CAPACITIES = ["standard"] as const;
export type PlanCapacity = (typeof PLAN_CAPACITIES)[number];

/** Pricing regions. Hetzner `sin` is Singapore; every other location is `eu`. */
export const PLAN_REGIONS = ["eu", "sin"] as const;
export type PlanRegion = (typeof PLAN_REGIONS)[number];

/** A calendar date, `YYYY-MM-DD`, interpreted as 00:00 UTC. */
export type IsoDate = `${number}-${number}-${number}`;

/** What a version row is sold on, independent of region. */
export interface PlanVariant {
	readonly capacity: PlanCapacity;
	readonly provider: PlanProvider;
}
export type PlanVariantKey = `${PlanProvider}:${PlanCapacity}`;

/** A variant in one pricing region: exactly what one subscription bought. */
export interface PlanVariantCell extends PlanVariant {
	readonly region: PlanRegion;
}
export type PlanVariantCellKey =
	`${PlanProvider}:${PlanCapacity}:${PlanRegion}`;

/** The variant of every row that does not declare one. */
export const DEFAULT_VARIANT: PlanVariant = {
	provider: "hetzner",
	capacity: "standard",
};

/** The regions a row serves when it does not declare them: both. */
export const LEGACY_REGIONS: readonly PlanRegion[] = ["eu", "sin"];

/** The default cell (new checkouts with no pinned region). */
export const DEFAULT_CELL: PlanVariantCell = {
	...DEFAULT_VARIANT,
	region: "eu",
};

export const variantKey = (variant: PlanVariant): PlanVariantKey =>
	`${variant.provider}:${variant.capacity}`;

export const cellKey = (cell: PlanVariantCell): PlanVariantCellKey =>
	`${cell.provider}:${cell.capacity}:${cell.region}`;

const cellKeySchema = z
	.string()
	.transform((raw) => raw.trim().toLowerCase().split(":"))
	.pipe(
		z.tuple([
			z.enum(PLAN_PROVIDERS),
			z.enum(PLAN_CAPACITIES),
			z.enum(PLAN_REGIONS),
		])
	);

/** Parse a stamped cell key; anything that is not a known triple is null. */
export const parseCellKey = (raw: unknown): PlanVariantCell | null => {
	const parsed = cellKeySchema.safeParse(raw);
	if (!parsed.success) {
		return null;
	}
	const [provider, capacity, region] = parsed.data;
	return { provider, capacity, region };
};

/** The pricing region a provider location belongs to. */
export const regionForLocation = (
	location: string | null | undefined
): PlanRegion => (location?.trim().toLowerCase() === "sin" ? "sin" : "eu");

/** A representative provider location for a pricing region (for node lookups). */
export const representativeLocationForRegion = (region: PlanRegion): string =>
	region === "sin" ? "sin" : "nbg1";

/** The provider locations whose price defines a region's cost (the highest wins). */
export const REGION_COST_LOCATIONS: Readonly<
	Record<PlanRegion, readonly string[]>
> = {
	eu: ["nbg1", "fsn1", "hel1"],
	sin: ["sin"],
};
