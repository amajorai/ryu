import { policyGlobCovers } from "@ryu/db/models/policy-glob";
import { z } from "zod";
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
	| "Network"
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
			"Allow members to install and update apps and plugins, add custom MCP servers, import OpenAPI or GraphQL tools, and install skills from a source. Organization nodes refuse these when it is off.",
		enforcement: "api",
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
			"Allow members to update (reinstall a newer build of) local engines. Organization nodes refuse updates when it is off.",
		enforcement: "api",
		group: "Engines",
		key: "engines.update",
		name: "Engine updates",
	},
	{
		defaultEnabled: true,
		description:
			"Control Bot surface visibility in the website; node and organization authorization remain authoritative.",
		enforcement: "ui",
		group: "Ryu surfaces",
		key: "bot.access",
		name: "Bot access",
	},
	{
		defaultEnabled: true,
		description:
			"Control Agent surface visibility in the website; node and organization authorization remain authoritative.",
		enforcement: "ui",
		group: "Ryu surfaces",
		key: "console.access",
		name: "Agent access",
	},
	{
		defaultEnabled: true,
		description:
			"Allow members to route their cloud nodes' web traffic through their own computer. When off, routes stop and traffic returns to the cloud network path.",
		enforcement: "api",
		group: "Network",
		key: "network.local_egress",
		name: "Allow local egress routing",
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
	{
		defaultEnabled: true,
		description:
			"Allow hosted web search billed to the organization's credit balance. Applies organization-wide; your own search provider keys are unaffected.",
		enforcement: "api",
		group: "Products",
		key: "products.web_search",
		name: "Hosted web search",
	},
	{
		defaultEnabled: false,
		description:
			"Allow members and organization API keys to run hosted Managed Agents sessions.",
		enforcement: "api",
		group: "Products",
		key: "products.managed_agents",
		name: "Managed Agents",
	},
	{
		defaultEnabled: false,
		description:
			"Allow members and organization API keys to lease phone numbers and send SMS, MMS, WhatsApp, and voice messages billed to the organization's credits.",
		enforcement: "api",
		group: "Products",
		key: "products.messaging",
		name: "Ryu Messaging",
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

/**
 * Resolve a member's value: member override, then team overrides, then org
 * override, then default. A member in several teams gets the strictest team
 * value: any team turning a feature off wins over another turning it on.
 */
export function resolveOrganizationFeature(
	feature: OrganizationFeatureDefinition,
	organizationOverride?: boolean | null,
	memberOverride?: boolean | null,
	teamOverrides: readonly (boolean | null | undefined)[] = []
): boolean {
	const member = z.boolean().safeParse(memberOverride);
	if (member.success) {
		return member.data;
	}
	const teams = teamOverrides.flatMap((value) => {
		const parsed = z.boolean().safeParse(value);
		return parsed.success ? [parsed.data] : [];
	});
	if (teams.length > 0) {
		return teams.every(Boolean);
	}
	const organization = z.boolean().safeParse(organizationOverride);
	if (organization.success) {
		return organization.data;
	}
	return feature.defaultEnabled;
}

/**
 * Whether the organization policy's `allowedFeatures` permits a feature. An
 * empty list places no restriction; otherwise the key must match one of the
 * globs (`*`, `?`, case-insensitive). This gates the toggles above: a feature
 * the policy does not allow stays off whatever its toggle says.
 */
export function featureAllowedByPolicy(
	key: string,
	allowedFeatures: readonly string[]
): boolean {
	return (
		allowedFeatures.length === 0 ||
		allowedFeatures.some((pattern) => policyGlobCovers(pattern, key))
	);
}
