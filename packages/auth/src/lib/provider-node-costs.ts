import type { IsoDate, PlanProvider, PlanRegion } from "./plan-variants.ts";

/**
 * THE ONE PROVIDER COST TABLE.
 *
 * Every number the platform knows about what a server costs Ryu lives here,
 * once: the margin guard (`plan-margin.ts`, `plan-economics.test.ts`), the
 * scheduled margin check (`plan-margin-check.ts` in the API) and the Hetzner
 * catalog's static fallback (`FALLBACK_SPECS` in `hetzner-catalog.ts`, which is
 * DERIVED from these rows) all read it. Before this table the reserves were
 * literals in a test file and the raw prices were literals in the catalog, so a
 * provider price change had to be noticed and copied into two places by hand.
 *
 * THESE ARE COST FLOORS, AND STALENESS HERE SELLS BELOW COST. The catalog marks
 * the raw price up and quotes it whenever the live API is unavailable, and the
 * margin guard trusts it, so a number that has drifted under the provider's real
 * price is a sale at a loss. Each `rawMonthlyUsd` is compute plus the primary
 * IPv4, in USD at the safety-floor FX rate, and the HIGHEST of the region's
 * locations. The scheduled margin check compares it with the live catalog every
 * day and raises a `cost_stale` alert when the live price is higher; when in
 * doubt round UP.
 *
 * SERVER-ONLY BY CONVENTION. Nothing customer-facing may import this module:
 * customers never see provider or machine-type names.
 */
export interface ProviderNodeCost {
	/** A provider price change already announced, applied ahead of time. */
	readonly announced?: readonly {
		readonly effectiveFrom: IsoDate;
		readonly rawMonthlyUsd: number;
		readonly source: string;
	}[];
	readonly cores: number;
	readonly diskGb: number;
	readonly memoryGb: number;
	/**
	 * A stricter reviewed reserve kept from before the 1.5x rule. It can only
	 * RAISE the reserve ({@link reserveMonthlyUsd}), never lower it.
	 */
	readonly minReserveUsd?: number;
	readonly provider: PlanProvider;
	/** Compute + primary IPv4, USD per month, highest across the region. */
	readonly rawMonthlyUsd: number;
	readonly region: PlanRegion;
	readonly source: string;
	readonly type: string;
	readonly verifiedOn: IsoDate;
}

const HETZNER_API_SNAPSHOT =
	"Hetzner Cloud API price list, converted at the $1.1643 safety-floor FX rate plus $0.60 IPv4 (docs/deploy-cloud.md)";

/**
 * Hetzner rows. Every type the platform can provision must have a row in each
 * region it can be provisioned in (`fallback_specs_cover_every_provisionable_type`
 * and the plan-economics coverage tests assert it).
 */
export const PROVIDER_NODE_COSTS: readonly ProviderNodeCost[] = [
	// Every plan's base server in the EU. Live net €5.49. The reviewed reserve
	// ($12) is above 1.5x raw ($11) and is kept.
	{
		provider: "hetzner",
		region: "eu",
		type: "cx23",
		cores: 2,
		memoryGb: 4,
		diskGb: 40,
		rawMonthlyUsd: 7.09,
		minReserveUsd: 12,
		source: HETZNER_API_SNAPSHOT,
		verifiedOn: "2026-10-19",
	},
	// Grandfathered Max node (the pre-2026-10-19 ladder). Live net €8.49.
	{
		provider: "hetzner",
		region: "eu",
		type: "cx33",
		cores: 4,
		memoryGb: 8,
		diskGb: 80,
		rawMonthlyUsd: 10.59,
		source: HETZNER_API_SNAPSHOT,
		verifiedOn: "2026-10-19",
	},
	// Grandfathered Teams / Teams Lite node. Live net €15.99.
	{
		provider: "hetzner",
		region: "eu",
		type: "cx43",
		cores: 8,
		memoryGb: 16,
		diskGb: 160,
		rawMonthlyUsd: 19.49,
		source: HETZNER_API_SNAPSHOT,
		verifiedOn: "2026-10-19",
	},
	// Grandfathered Business node. Live net €29.49. Reviewed reserve $55 kept.
	{
		provider: "hetzner",
		region: "eu",
		type: "cx53",
		cores: 16,
		memoryGb: 32,
		diskGb: 320,
		rawMonthlyUsd: 35.59,
		minReserveUsd: 55,
		source: HETZNER_API_SNAPSHOT,
		verifiedOn: "2026-10-19",
	},
	// Paid cloud-instance shape. €11.49 EU.
	{
		provider: "hetzner",
		region: "eu",
		type: "cpx12",
		cores: 1,
		memoryGb: 2,
		diskGb: 40,
		rawMonthlyUsd: 13.98,
		source: HETZNER_API_SNAPSHOT,
		verifiedOn: "2026-10-19",
	},
	// The organization plans' same-price EU stock fallback. €19.49 since June
	// 2026 (from €7.99): the same 2 vCPU / 4 GB as cx23 at about three times the
	// cost, never an upgrade.
	{
		provider: "hetzner",
		region: "eu",
		type: "cpx22",
		cores: 2,
		memoryGb: 4,
		diskGb: 80,
		rawMonthlyUsd: 23.59,
		source: HETZNER_API_SNAPSHOT,
		verifiedOn: "2026-10-19",
	},
	{
		provider: "hetzner",
		region: "eu",
		type: "cpx32",
		cores: 4,
		memoryGb: 8,
		diskGb: 160,
		rawMonthlyUsd: 42.59,
		source: HETZNER_API_SNAPSHOT,
		verifiedOn: "2026-10-19",
	},
	{
		provider: "hetzner",
		region: "eu",
		type: "ccx13",
		cores: 2,
		memoryGb: 8,
		diskGb: 80,
		rawMonthlyUsd: 51.09,
		source: HETZNER_API_SNAPSHOT,
		verifiedOn: "2026-10-19",
	},
	// Singapore. €15.49.
	{
		provider: "hetzner",
		region: "sin",
		type: "cpx12",
		cores: 1,
		memoryGb: 2,
		diskGb: 40,
		rawMonthlyUsd: 18.64,
		source: HETZNER_API_SNAPSHOT,
		verifiedOn: "2026-10-19",
	},
	// Singapore's organization-plan base server. Under the 1.5x rule its
	// reserve is $48, stricter than the $44 the guard used before; see the open
	// founder question in docs/pricing-versioning.md.
	{
		provider: "hetzner",
		region: "sin",
		type: "cpx22",
		cores: 2,
		memoryGb: 4,
		diskGb: 80,
		rawMonthlyUsd: 31.59,
		source: HETZNER_API_SNAPSHOT,
		verifiedOn: "2026-10-19",
	},
	// Grandfathered Singapore Business node.
	{
		provider: "hetzner",
		region: "sin",
		type: "cpx32",
		cores: 4,
		memoryGb: 8,
		diskGb: 160,
		rawMonthlyUsd: 58.59,
		source: HETZNER_API_SNAPSHOT,
		verifiedOn: "2026-10-19",
	},
	{
		provider: "hetzner",
		region: "sin",
		type: "ccx13",
		cores: 2,
		memoryGb: 8,
		diskGb: 80,
		rawMonthlyUsd: 64.09,
		source: HETZNER_API_SNAPSHOT,
		verifiedOn: "2026-10-19",
	},
];

/**
 * THE RESERVE RULE (founder decision): a plan is costed at 1.5x the raw
 * provider price of each node it includes, rounded up to whole dollars. The
 * 50% covers operations, automated backups (20% of the server price) and
 * ordinary drift.
 */
export const RESERVE_MULTIPLIER = 1.5;

/** How far ahead an announced provider price change is already applied. */
export const ANNOUNCED_LOOKAHEAD_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/** `max(ceil(raw x 1.5), minReserve)`: the rule never loosens a reviewed guard. */
export const reserveMonthlyUsd = (
	rawMonthlyUsd: number,
	minReserveUsd = 0
): number =>
	Math.max(Math.ceil(rawMonthlyUsd * RESERVE_MULTIPLIER), minReserveUsd);

/** A stable key for one cost row. */
export const nodeCostKey = (
	provider: PlanProvider,
	region: PlanRegion,
	type: string
): string => `${provider}:${region}:${type}`;

const costByKey = new Map<string, ProviderNodeCost>(
	PROVIDER_NODE_COSTS.map((row) => [
		nodeCostKey(row.provider, row.region, row.type),
		row,
	])
);

/** Thrown when a node type has no cost row: unpriced must never read as $0. */
export class UnpricedNodeTypeError extends Error {
	constructor(provider: PlanProvider, region: PlanRegion, type: string) {
		super(
			`no provider cost known for ${provider} ${type} in ${region}; add it to PROVIDER_NODE_COSTS before shipping anything that provisions it`
		);
		this.name = "UnpricedNodeTypeError";
	}
}

/** The cost row for a node, or a thrown {@link UnpricedNodeTypeError}. */
export const nodeCost = (
	provider: PlanProvider,
	region: PlanRegion,
	type: string
): ProviderNodeCost => {
	const row = costByKey.get(nodeCostKey(provider, region, type));
	if (!row) {
		throw new UnpricedNodeTypeError(provider, region, type);
	}
	return row;
};

/** Whether a cost row exists (for coverage checks). */
export const hasNodeCost = (
	provider: PlanProvider,
	region: PlanRegion,
	type: string
): boolean => costByKey.has(nodeCostKey(provider, region, type));

/**
 * The raw price the guard uses at `at`: the HIGHEST of the table, the live
 * catalog and any announced change taking effect within the lookahead. A live
 * price DROP never makes a margin look better than the reviewed table.
 */
export const effectiveRawUsd = (
	cost: ProviderNodeCost,
	at: Date,
	liveRawUsd?: number | null
): number => {
	let raw = cost.rawMonthlyUsd;
	if (typeof liveRawUsd === "number" && Number.isFinite(liveRawUsd)) {
		raw = Math.max(raw, liveRawUsd);
	}
	const horizon = at.getTime() + ANNOUNCED_LOOKAHEAD_DAYS * DAY_MS;
	for (const change of cost.announced ?? []) {
		if (Date.parse(`${change.effectiveFrom}T00:00:00Z`) <= horizon) {
			raw = Math.max(raw, change.rawMonthlyUsd);
		}
	}
	return raw;
};

/** A node reserve lookup: provider, region, type → USD per month. */
export type NodeReserveFn = (
	provider: PlanProvider,
	region: PlanRegion,
	type: string
) => number;

/**
 * The reserve lookup the margin engine takes. `live` maps
 * {@link nodeCostKey} → live raw USD; missing keys use the table.
 */
export const nodeReserveFn =
	(at: Date, live?: ReadonlyMap<string, number>): NodeReserveFn =>
	(provider, region, type) => {
		const cost = nodeCost(provider, region, type);
		return reserveMonthlyUsd(
			effectiveRawUsd(cost, at, live?.get(nodeCostKey(provider, region, type))),
			cost.minReserveUsd
		);
	};

/** The static catalog spec shape `hetzner-catalog.ts` quotes from. */
export interface FallbackServerSpec {
	cores: number;
	diskGb: number;
	memoryGb: number;
	monthlyUsd: number;
	monthlyUsdByLocation?: Readonly<Record<string, number>>;
	type: string;
}

/**
 * Derive the Hetzner catalog's static fallback from the cost table: the EU row
 * is the default price and the Singapore row (when any) is the `sin` override.
 * A type with only a Singapore row is keyed on its Singapore price.
 */
export const fallbackSpecsFromCostTable = (): Record<
	string,
	FallbackServerSpec
> => {
	const out: Record<string, FallbackServerSpec> = {};
	const hetzner = PROVIDER_NODE_COSTS.filter(
		(row) => row.provider === "hetzner"
	);
	for (const row of hetzner.filter((candidate) => candidate.region === "eu")) {
		out[row.type] = {
			type: row.type,
			cores: row.cores,
			memoryGb: row.memoryGb,
			diskGb: row.diskGb,
			monthlyUsd: row.rawMonthlyUsd,
		};
	}
	for (const row of hetzner.filter((candidate) => candidate.region === "sin")) {
		const existing = out[row.type];
		out[row.type] = existing
			? { ...existing, monthlyUsdByLocation: { sin: row.rawMonthlyUsd } }
			: {
					type: row.type,
					cores: row.cores,
					memoryGb: row.memoryGb,
					diskGb: row.diskGb,
					monthlyUsd: row.rawMonthlyUsd,
					monthlyUsdByLocation: { sin: row.rawMonthlyUsd },
				};
	}
	return out;
};
