import {
	BUSINESS_INCLUDED_SEATS,
	businessIncludedCreditUsd,
	businessMonthlyPriceUsd,
} from "./business-pricing.ts";
import {
	formatBps,
	formatCount,
	PRICING_COPY,
	PUBLISHED_PRICING,
	type PublishedMailAllowance,
} from "./data/standalone-pricing.ts";
import {
	annualTotalPrice,
	hostedAgentIncludedCreditUsd,
	hostedAgentMonthlyPriceUsd,
	MARKETPLACE_PASS_MONTHLY_USD,
	MARKETPLACE_PASS_YEARLY_USD,
	MAX_FAMILY_SHARING_MEMBERS,
	MAX_INCLUDED_USD,
	MAX_MONTHLY_USD,
	PLUS_INCLUDED_USD,
	PLUS_MONTHLY_USD,
	PRO_INCLUDED_USD,
	PRO_MONTHLY_USD,
	type PricingAudience,
} from "./pricing.tsx";
import {
	normalizeTeamsSeatCount,
	TEAMS_MAX_SEATS,
	TEAMS_MIN_SEATS,
} from "./pricing-seat-model.ts";

/**
 * The detailed plan comparison under the public pricing cards.
 *
 * Every number here is a client-safe MIRROR, never a hand-typed copy of
 * pricing prose: prices and pools come from the card constants in
 * `./pricing.tsx` (checked by `pricing-catalog-drift.test.ts`), mail, deposit
 * fees, and Box storage from `PUBLISHED_PRICING` (checked by
 * `standalone-pricing.test.ts`), and the few figures that had no mirror yet are
 * declared below. `pricing-comparison.test.ts` renders every cell and checks it
 * against `@ryu/auth/lib/plans`, so a catalog change fails until this follows.
 *
 * The catalog itself is not imported: this renders in the browser, and the
 * catalog carries every Polar product id and env-var name.
 *
 * Feature rows that are not numbers (organization controls, Enterprise terms)
 * restate the plan cards' own bullets and the public billing docs; nothing
 * here is a capability the cards and docs do not already promise.
 */

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
const CONTRACTED = "Contracted";

const PLAN_NAMES = {
	pro: "Pro",
	plus: "Plus",
	max: "Max",
	"desktop-license": "Local Desktop",
	"marketplace-membership": "A Major Pass",
	teams: "Teams",
	business: "Business",
	enterprise: "Enterprise",
} as const satisfies Record<ComparisonPlanId, string>;

/**
 * The columns for the shelf on screen: the managed individual plans first
 * (Pro, Max, then Plus when `plans.plus_public` lists it), then Local Desktop
 * and A Major Pass when it is on sale; the organization grid is Teams,
 * Business, Enterprise.
 * Teams Lite is private and never a column.
 */
export function comparisonPlans(
	options: ComparisonOptions
): readonly ComparisonPlan[] {
	const ids: ComparisonPlanId[] =
		options.audience === "individual"
			? [
					"pro",
					"max",
					...(options.plusPublicEnabled ? (["plus"] as const) : []),
					"desktop-license",
					...(options.aMajorPassEnabled
						? (["marketplace-membership"] as const)
						: []),
				]
			: ["teams", "business", "enterprise"];
	return ids.map((id) => ({ id, name: PLAN_NAMES[id] }));
}

/** The seat count the organization columns are priced at (cards clamp at 50). */
export function comparisonSeats(seats: number | undefined): number {
	return Math.min(
		TEAMS_MAX_SEATS,
		normalizeTeamsSeatCount(seats ?? TEAMS_MIN_SEATS)
	);
}

const usd = (amount: number): string => `$${formatCount(amount)}`;

const recurring = (monthly: number, isYearly: boolean): string =>
	isYearly ? `${usd(annualTotalPrice(monthly))}/yr` : `${usd(monthly)}/mo`;

const gib = (value: number): string => `${formatCount(value)} GiB`;
const gb = (value: number): string => `${formatCount(value)} GB`;

const { mail } = PUBLISHED_PRICING;

/** The hosted-mail allowance each plan uses (`emailQuotaForPlan`). */
const MAIL_BY_PLAN = {
	"desktop-license": mail.free,
	"marketplace-membership": mail.free,
	plus: mail.pro,
	pro: mail.pro,
	max: mail.max,
	teams: mail.organization,
	business: mail.organization,
} as const satisfies Record<ComparisonCatalogPlanId, PublishedMailAllowance>;

const DEPOSIT_FEE_BPS_BY_PLAN = {
	"desktop-license": PUBLISHED_PRICING.depositFee.baseBps,
	"marketplace-membership": PUBLISHED_PRICING.depositFee.baseBps,
	plus: PUBLISHED_PRICING.depositFee.proBps,
	pro: PUBLISHED_PRICING.depositFee.proBps,
	max: PUBLISHED_PRICING.depositFee.teamBps,
	teams: PUBLISHED_PRICING.depositFee.teamBps,
	business: PUBLISHED_PRICING.depositFee.teamBps,
} as const satisfies Record<ComparisonCatalogPlanId, number>;

/** A row whose catalog plans read one mirror and whose Enterprise cell is fixed. */
function catalogRow(
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
function onlyRow(
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

const hasManagedServer = (plan: ComparisonCatalogPlanId): boolean =>
	PLAN_CAPABILITIES[plan].managedAi;

function priceRow(isYearly: boolean, seats: number): ComparisonRow {
	return {
		id: "price",
		label: isYearly ? "Price, billed yearly" : "Price, billed monthly",
		...(isYearly ? { hint: "Yearly billing includes two months free" } : {}),
		values: {
			pro: recurring(PRO_MONTHLY_USD, isYearly),
			plus: recurring(PLUS_MONTHLY_USD, isYearly),
			max: recurring(MAX_MONTHLY_USD, isYearly),
			"desktop-license": `${usd(DESKTOP_LICENSE_LAUNCH_USD)} once`,
			"marketplace-membership": isYearly
				? `${usd(MARKETPLACE_PASS_YEARLY_USD)}/yr`
				: `${usd(MARKETPLACE_PASS_MONTHLY_USD)}/mo`,
			teams: `${recurring(hostedAgentMonthlyPriceUsd("teams", seats), isYearly)} for ${seats} seats`,
			business: `${recurring(businessMonthlyPriceUsd(seats), isYearly)} for ${seats} seats`,
			enterprise: "Custom",
		},
	};
}

function creditsRow(seats: number): ComparisonRow {
	return {
		id: "included-credits",
		label: "Included AI credits each month",
		hint: "Organization pools are shared and grow with seats",
		values: {
			pro: usd(PRO_INCLUDED_USD),
			plus: usd(PLUS_INCLUDED_USD),
			max: usd(MAX_INCLUDED_USD),
			"desktop-license": false,
			"marketplace-membership": false,
			teams: usd(hostedAgentIncludedCreditUsd("teams", seats)),
			business: usd(businessIncludedCreditUsd(seats)),
			enterprise: CONTRACTED,
		},
	};
}

/**
 * The comparison rows for the columns on screen. A row none of those columns
 * has (every cell a dash) is dropped, so Enterprise-only terms never fill the
 * individual table with dashes and personal extras stay off the organization one.
 */
export function comparisonSections(
	options: ComparisonOptions
): readonly ComparisonSection[] {
	const isYearly = options.isYearly ?? false;
	const seats = comparisonSeats(options.seats);
	const plans = comparisonPlans(options);

	const sections: ComparisonSection[] = [
		{
			id: "price-and-credits",
			title: "Price and credits",
			rows: [
				priceRow(isYearly, seats),
				creditsRow(seats),
				{
					id: "deposit-fee",
					label: "Credit top-up deposit fee",
					hint: `${PRICING_COPY.depositFeeMinimum} minimum; Ryu keeps at most ${PRICING_COPY.depositFeeCap} per top-up`,
					values: catalogRow(
						(plan) => formatBps(DEPOSIT_FEE_BPS_BY_PLAN[plan]),
						CONTRACTED
					),
				},
			],
		},
		{
			id: "cloud-and-boxes",
			title: "Cloud and Boxes",
			rows: [
				{
					id: "always-on-server",
					label: "Always-on Ryu server",
					values: catalogRow(hasManagedServer, CONTRACTED),
				},
				{
					id: "singapore-server",
					label: "Server in Singapore",
					values: catalogRow(
						(plan) => PLAN_CAPABILITIES[plan].organization,
						CONTRACTED
					),
				},
				{
					id: "extra-cloud-computers",
					label: "Add or upgrade cloud computers",
					values: onlyRow(["teams", "business", "enterprise"]),
				},
				{
					id: "running-boxes",
					label: "Ryu Boxes running at once",
					hint: "Per organization",
					values: catalogRow(
						(plan) => formatCount(RUNNING_BOXES_BY_PLAN[plan]),
						CONTRACTED
					),
				},
				{
					id: "box-storage",
					label: "Included Box storage",
					values: catalogRow(
						(plan) =>
							gib(
								hasManagedServer(plan)
									? PUBLISHED_PRICING.box.includedStorageGib.paid
									: PUBLISHED_PRICING.box.includedStorageGib.trial
							),
						CONTRACTED
					),
				},
			],
		},
		{
			id: "mail-and-storage",
			title: "Mail and storage",
			rows: [
				{
					id: "mailboxes",
					label: "Agent Inbox mailboxes",
					values: catalogRow(
						(plan) =>
							PLAN_CAPABILITIES[plan].managedAi
								? "Unlimited"
								: formatCount(mail.free.inboxes),
						CONTRACTED
					),
				},
				{
					id: "monthly-emails",
					label: "Emails sent per month",
					hint: "Counted per recipient",
					values: catalogRow(
						(plan) => formatCount(MAIL_BY_PLAN[plan].monthlyEmails),
						CONTRACTED
					),
				},
				{
					id: "stored-mail",
					label: "Stored mail",
					values: catalogRow(
						(plan) => gib(MAIL_BY_PLAN[plan].storageGib),
						CONTRACTED
					),
				},
				{
					id: "remove-branding",
					label: "Remove Ryu branding from email",
					values: catalogRow(
						(plan) => PLAN_CAPABILITIES[plan].brandingRemovable,
						CONTRACTED
					),
				},
				{
					id: "space-storage",
					label: "Space storage",
					values: catalogRow(
						(plan) => gb(SPACE_STORAGE_GB_BY_PLAN[plan]),
						CONTRACTED
					),
				},
			],
		},
		{
			id: "agents-and-integrations",
			title: "Agents and integrations",
			rows: [
				{
					id: "managed-ai",
					label: "Ryu-managed cloud AI models",
					values: catalogRow((plan) => PLAN_CAPABILITIES[plan].managedAi, true),
				},
				{
					id: "bring-your-own-keys",
					label: "Bring your own API keys",
					values: catalogRow(() => true, true),
				},
				{
					id: "marketplace-apps",
					label: "Supported paid Marketplace apps",
					values: catalogRow(
						(plan) => PLAN_CAPABILITIES[plan].marketplaceApps,
						CONTRACTED
					),
				},
				...(options.productCount
					? [
							{
								id: "all-products",
								label:
									"Every released Ryu product, and early-access products as they open",
								values: catalogRow(
									(plan) => PLAN_CAPABILITIES[plan].managedAi,
									true
								),
							},
						]
					: []),
				...(options.familySharingEnabled
					? [
							{
								id: "family-sharing",
								label: "Family sharing",
								values: {
									...onlyRow([]),
									max: `Up to ${MAX_FAMILY_SHARING_MEMBERS - 1} family members`,
								},
							},
						]
					: []),
			],
		},
		{
			id: "team-and-admin",
			title: "Team and admin",
			rows: [
				{
					id: "people",
					label: "People included",
					values: {
						...catalogRow(() => "1 person", "Custom"),
						teams: `${TEAMS_MIN_SEATS}–${TEAMS_MAX_SEATS} seats`,
						business: `${BUSINESS_INCLUDED_SEATS}–${TEAMS_MAX_SEATS} seats`,
					},
				},
				{
					id: "shared-workspace",
					label: "Shared organization workspace and billing",
					values: onlyRow(["teams", "business", "enterprise"]),
				},
				{
					id: "access-controls",
					label: "Access controls, spend controls, and audit history",
					values: onlyRow(["teams", "business", "enterprise"]),
				},
				{
					id: "team-marketplace",
					label: "Team marketplace for skills and plugins",
					values: onlyRow(["teams", "business", "enterprise"]),
				},
				{
					id: "usage-analytics",
					label: "Shared usage analytics",
					values: onlyRow(["teams", "business", "enterprise"]),
				},
				{
					id: "sso-scim",
					label: "SSO and SCIM provisioning",
					values: onlyRow(["enterprise"]),
				},
				{
					id: "deployment",
					label: "Dedicated or self-hosted deployment",
					values: onlyRow(["enterprise"]),
				},
				{
					id: "data-region",
					label: "Choose your data region",
					values: onlyRow(["enterprise"]),
				},
			],
		},
		{
			id: "support-and-billing",
			title: "Support and billing",
			rows: [
				{
					id: "billing-terms",
					label: "Billing",
					values: {
						...catalogRow(() => "Monthly or yearly", "Annual contract"),
						"desktop-license": "One-time",
					},
				},
				{
					id: "priority-support",
					label: "Priority support",
					values: onlyRow(["max"]),
				},
				{
					id: "custom-sla",
					label: "Custom SLA and DPA",
					values: onlyRow(["enterprise"]),
				},
				{
					id: "onboarding",
					label: "Named contact and onboarding",
					values: onlyRow(["enterprise"]),
				},
				{
					id: "procurement",
					label: "Invoicing, purchase orders, and custom terms",
					values: onlyRow(["enterprise"]),
				},
			],
		},
	];

	return sections
		.map((section) => ({
			...section,
			rows: section.rows.filter((row) =>
				plans.some((plan) => row.values[plan.id] !== false)
			),
		}))
		.filter((section) => section.rows.length > 0);
}
