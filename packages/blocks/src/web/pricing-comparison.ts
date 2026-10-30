import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { BUSINESS_INCLUDED_SEATS } from "./business-pricing.ts";
import {
	formatBps,
	formatCount,
	PRICING_COPY,
	PUBLISHED_PRICING,
} from "./data/standalone-pricing.ts";
import { MAX_FAMILY_SHARING_MEMBERS } from "./pricing.tsx";
import {
	CONTRACTED,
	type ComparisonOptions,
	type ComparisonPlan,
	type ComparisonPlanId,
	type ComparisonSection,
	PLAN_CAPABILITIES,
	PLAN_NAMES,
	RUNNING_BOXES_BY_PLAN,
	SPACE_STORAGE_GB_BY_PLAN,
} from "./pricing-comparison-plans.ts";
import {
	catalogRow,
	creditsRow,
	DEPOSIT_FEE_BPS_BY_PLAN,
	gb,
	gib,
	hasManagedServer,
	MAIL_BY_PLAN,
	mail,
	onlyRow,
	priceRow,
} from "./pricing-comparison-rows.ts";
import {
	normalizeTeamsSeatCount,
	TEAMS_MAX_SEATS,
	TEAMS_MIN_SEATS,
} from "./pricing-seat-model.ts";

export type {
	ComparisonCatalogPlanId,
	ComparisonCell,
	ComparisonOptions,
	ComparisonPlan,
	ComparisonPlanId,
	ComparisonRow,
	ComparisonSection,
} from "./pricing-comparison-plans.ts";
export {
	DESKTOP_LICENSE_LAUNCH_USD,
	PLAN_CAPABILITIES,
	RUNNING_BOXES_BY_PLAN,
	SPACE_STORAGE_GB_BY_PLAN,
} from "./pricing-comparison-plans.ts";

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

/** English formatting for callers outside a React tree (tests, plain code). */
const englishLiteral: LiteralMessage = (source, values) =>
	formatMessage(source, values);

/**
 * The comparison rows for the columns on screen. A row none of those columns
 * has (every cell a dash) is dropped, so Enterprise-only terms never fill the
 * individual table with dashes and personal extras stay off the organization one.
 */
export function comparisonSections(
	options: ComparisonOptions,
	tl: LiteralMessage = englishLiteral
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
					hint: tl(
						"{depositFeeMinimum} minimum; Ryu keeps at most {depositFeeCap} per top-up",
						{
							depositFeeMinimum: PRICING_COPY.depositFeeMinimum,
							depositFeeCap: PRICING_COPY.depositFeeCap,
						}
					),
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
