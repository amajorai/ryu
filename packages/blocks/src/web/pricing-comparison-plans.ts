import { PUBLISHED_PRICING } from "./data/standalone-pricing.ts";
import type { PricingAudience } from "./pricing.tsx";

/** A plan column the comparison can show. Private plans other than Plus never appear. */
export type ComparisonPlanId =
	| "business"
	| "desktop-license"
	| "enterprise"
	| "marketplace-membership"
	| "max"
	| "plus"
	| "pro"
	| "teams";

/** A catalog plan id (everything but the unpriced Enterprise column). */
export type ComparisonCatalogPlanId = Exclude<ComparisonPlanId, "enterprise">;

export interface ComparisonPlan {
	readonly id: ComparisonPlanId;
	readonly name: string;
}

/** `true` renders a check, `false` a dash, and a string renders as the value. */
export type ComparisonCell = boolean | string;

export interface ComparisonRow {
	/** Short qualifier shown under the row label. */
	readonly hint?: string;
	readonly id: string;
	readonly label: string;
	readonly values: Readonly<Record<ComparisonPlanId, ComparisonCell>>;
}

export interface ComparisonSection {
	readonly id: string;
	readonly rows: readonly ComparisonRow[];
	readonly title: string;
}

export interface ComparisonOptions {
	/** A Major Pass is listed only while it is open for sale. */
	readonly aMajorPassEnabled?: boolean;
	/** Which shelf the page is showing; columns follow it. */
	readonly audience: PricingAudience;
	/** Max's family-sharing row follows the `billing.family_sharing` rollout. */
	readonly familySharingEnabled?: boolean;
	readonly isYearly?: boolean;
	/** Plus is a column only when `plans.plus_public` opens it. */
	readonly plusPublicEnabled?: boolean;
	/** Published product count; the row is omitted when it is unknown. */
	readonly productCount?: number;
	/** The organization seat count chosen on the page's seat selector. */
	readonly seats?: number;
}

/** One-time launch price of the local desktop license (`LIFETIME_LAUNCH_PRICE_USD`). */
export const DESKTOP_LICENSE_LAUNCH_USD = 129;

/**
 * Ryu Boxes one organization may run at once, by plan
 * (`PLAN_BOX_CONCURRENCY[...].running`). The desktop license and A Major Pass
 * carry no managed capacity, so they keep the trial row.
 */
export const RUNNING_BOXES_BY_PLAN = {
	"desktop-license": 1,
	"marketplace-membership": 1,
	plus: 2,
	pro: 2,
	max: 4,
	teams: 10,
	business: 20,
} as const satisfies Record<ComparisonCatalogPlanId, number>;

/** Hosted Space storage in GB (`planLimit(plan, "spaceStorageLimitGb")`). */
export const SPACE_STORAGE_GB_BY_PLAN = {
	"desktop-license": 20,
	"marketplace-membership": 1,
	plus: PUBLISHED_PRICING.spaceStorageGb.pro,
	pro: PUBLISHED_PRICING.spaceStorageGb.pro,
	max: 50,
	teams: 50,
	business: 50,
} as const satisfies Record<ComparisonCatalogPlanId, number>;

/**
 * Plan capability flags, mirroring `PLANS[plan]`: `managedInference`,
 * `marketplaceApps`, `emailBrandingRemovable`, and organization audience.
 */
export const PLAN_CAPABILITIES = {
	"desktop-license": {
		brandingRemovable: false,
		managedAi: false,
		marketplaceApps: false,
		organization: false,
	},
	"marketplace-membership": {
		brandingRemovable: false,
		managedAi: false,
		marketplaceApps: true,
		organization: false,
	},
	plus: {
		brandingRemovable: true,
		managedAi: true,
		marketplaceApps: true,
		organization: false,
	},
	pro: {
		brandingRemovable: true,
		managedAi: true,
		marketplaceApps: true,
		organization: false,
	},
	max: {
		brandingRemovable: true,
		managedAi: true,
		marketplaceApps: true,
		organization: false,
	},
	teams: {
		brandingRemovable: true,
		managedAi: true,
		marketplaceApps: true,
		organization: true,
	},
	business: {
		brandingRemovable: true,
		managedAi: true,
		marketplaceApps: true,
		organization: true,
	},
} as const satisfies Record<
	ComparisonCatalogPlanId,
	{
		brandingRemovable: boolean;
		managedAi: boolean;
		marketplaceApps: boolean;
		organization: boolean;
	}
>;

/** Enterprise numbers and terms are written into each contract. */
export const CONTRACTED = "Contracted";

export const PLAN_NAMES = {
	pro: "Pro",
	plus: "Plus",
	max: "Max",
	"desktop-license": "Local Desktop",
	"marketplace-membership": "A Major Pass",
	teams: "Teams",
	business: "Business",
	enterprise: "Enterprise",
} as const satisfies Record<ComparisonPlanId, string>;
