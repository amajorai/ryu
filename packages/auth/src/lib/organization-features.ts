/**
 * Organization-owned feature controls.
 *
 * These are deliberately separate from `feature-flags.ts`: the latter is the
 * Ryu platform rollout catalog and is only changed by Ryu staff. This catalog
 * describes customer-owned access switches that an organization can apply to
 * everyone or override for one of its members.
 */

export type OrganizationFeatureGroup =
	| "Apps and marketplace"
	| "Engines"
	| "Products"
	| "Ryu surfaces";

/** Boundary where an organization control has authoritative effect today. */
export type OrganizationFeatureEnforcement = "api" | "ui";

export const ORGANIZATION_FEATURES = [
	{
		defaultEnabled: true,
		description:
			"Control Marketplace app discovery and purchase access for members.",
		enforcement: "api",
		group: "Apps and marketplace",
		key: "apps.marketplace",
		name: "Marketplace apps",
	},
	{
		defaultEnabled: true,
		description:
			"Control whether app-install controls are shown in the website; Core and node permissions remain authoritative for installation.",
		enforcement: "ui",
		group: "Apps and marketplace",
		key: "apps.install",
		name: "App installation",
	},
	{
		defaultEnabled: true,
		description:
			"Control Marketplace plugin discovery and purchase access for members.",
		enforcement: "api",
		group: "Apps and marketplace",
		key: "plugins.marketplace",
		name: "Marketplace plugins",
	},
	{
		defaultEnabled: true,
		description:
			"Control whether the engine catalog is shown in the website; local node policy remains authoritative.",
		enforcement: "ui",
		group: "Engines",
		key: "engines.catalog",
		name: "Engine catalog",
	},
	{
		defaultEnabled: true,
		description:
			"Control whether engine-update controls are shown in the website; Core and node permissions remain authoritative.",
		enforcement: "ui",
		group: "Engines",
		key: "engines.update",
		name: "Engine updates",
	},
	{
		defaultEnabled: true,
		description:
			"Control Ryu Bot surface visibility in the website; node and organization authorization remain authoritative.",
		enforcement: "ui",
		group: "Ryu surfaces",
		key: "bot.access",
		name: "Bot access",
	},
	{
		defaultEnabled: true,
		description:
			"Control Ryu Console surface visibility in the website; node and organization authorization remain authoritative.",
		enforcement: "ui",
		group: "Ryu surfaces",
		key: "console.access",
		name: "Console access",
	},
	{
		defaultEnabled: true,
		description: "Allow members to use organization-owned Ryu Box workspaces.",
		enforcement: "api",
		group: "Products",
		key: "products.box",
		name: "Ryu Box",
	},
	{
		defaultEnabled: true,
		description: "Allow members to use organization-owned Agent Inboxes.",
		enforcement: "api",
		group: "Products",
		key: "products.mail",
		name: "Agent Inboxes",
	},
	{
		defaultEnabled: true,
		description: "Allow members to receive organization notifications.",
		enforcement: "api",
		group: "Products",
		key: "products.notify",
		name: "Organization notifications",
	},
] as const;

export type OrganizationFeatureDefinition =
	(typeof ORGANIZATION_FEATURES)[number];
export type OrganizationFeatureKey = OrganizationFeatureDefinition["key"];

/** Look up a customer-owned feature without accepting arbitrary keys. */
export function organizationFeatureByKey(
	key: string
): OrganizationFeatureDefinition | undefined {
	return ORGANIZATION_FEATURES.find((feature) => feature.key === key);
}

/** Resolve a member's value: member override, then org override, then default. */
export function resolveOrganizationFeature(
	feature: OrganizationFeatureDefinition,
	organizationOverride?: boolean | null,
	memberOverride?: boolean | null
): boolean {
	if (typeof memberOverride === "boolean") {
		return memberOverride;
	}
	if (typeof organizationOverride === "boolean") {
		return organizationOverride;
	}
	return feature.defaultEnabled;
}
