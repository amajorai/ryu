import {
	CheckmarkBadge04Icon,
	ColorsIcon,
	Home01Icon,
	LayerIcon,
	Link01Icon,
	PackageIcon,
	PlugSocketIcon,
	Settings01Icon,
	Store01Icon,
	Tag01Icon,
} from "@hugeicons/core-free-icons";
import { REALM_ICONS } from "../realm-icons.ts";
import type { StoreSectionTab } from "./store-chrome.ts";

/**
 * The built-in Marketplace navigation contract.
 *
 * Web and desktop deliberately import this same value. A host may append a
 * contributed tab, but it must not re-declare or reorder the built-in surface.
 */
export const MARKETPLACE_SECTION_TABS = [
	{ value: "home", label: "Home", icon: Home01Icon, group: "discover" },
	{
		value: "bundles",
		label: "Bundles",
		icon: PackageIcon,
		group: "discover",
	},
	{
		value: "integrations",
		label: "Integrations",
		icon: Link01Icon,
		group: "discover",
	},
	{ value: "apps", label: "Apps", icon: REALM_ICONS.apps, group: "discover" },
	{
		value: "plugins",
		label: "Plugins",
		icon: REALM_ICONS.plugins,
		group: "discover",
	},
	{
		value: "models",
		label: "Models",
		icon: REALM_ICONS.models,
		group: "discover",
	},
	{
		value: "skills",
		label: "Skills",
		icon: REALM_ICONS.skills,
		group: "discover",
	},
	{ value: "mcp", label: "MCP", icon: REALM_ICONS.mcp, group: "discover" },
	{
		value: "agents",
		label: "Agents",
		icon: REALM_ICONS.agents,
		group: "discover",
	},
	{ value: "engines", label: "Engines", icon: LayerIcon, group: "discover" },
	{
		value: "workflows",
		label: "Workflow Templates",
		icon: REALM_ICONS.workflows,
		group: "discover",
	},
	{ value: "themes", label: "Themes", icon: ColorsIcon, group: "discover" },
	{
		value: "marketplaces",
		label: "Marketplaces",
		icon: Settings01Icon,
		group: "discover",
	},
	{ value: "browse", label: "Browse", icon: Store01Icon, group: "money" },
	{
		value: "connections",
		label: "Connections",
		icon: PlugSocketIcon,
		group: "money",
	},
	{
		value: "licenses",
		label: "My licenses",
		icon: CheckmarkBadge04Icon,
		group: "money",
	},
	{ value: "sell", label: "Sell", icon: Tag01Icon, group: "money" },
] satisfies StoreSectionTab[];

export type MarketplaceSection =
	(typeof MARKETPLACE_SECTION_TABS)[number]["value"];

export const MARKETPLACE_SECTION_VALUES = MARKETPLACE_SECTION_TABS.map(
	(section) => section.value
);

/** The category filters inside the shared Browse tab. Hosts may render the
 * results differently when their purchase API differs, but they must expose
 * this same category set and order. */
export const MARKETPLACE_BROWSE_KINDS = [
	{ value: "app", label: "Apps" },
	{ value: "skill", label: "Skills" },
	{ value: "plugin", label: "Plugins" },
	{ value: "mcp", label: "MCP" },
	{ value: "model", label: "Models" },
	{
		value: "agent",
		label: "Agent Templates",
	},
	{ value: "stack_template", label: "Stack Templates" },
	{ value: "workflow", label: "Workflows" },
	{ value: "theme", label: "Themes" },
	{ value: "language_pack", label: "Language Packs" },
	{ value: "space", label: "Spaces" },
	{ value: "profile", label: "Profiles" },
	{ value: "output_style", label: "Output Styles" },
	{ value: "bundle", label: "Bundles" },
] as const;

/** Return the user-facing label for a Marketplace Browse kind. Wire values stay
 * singular and stable; this helper keeps cards, empty states, and command
 * results from exposing the raw `agent` kind when the listing is a template. */
export function marketplaceBrowseKindLabel(value: string): string {
	return (
		MARKETPLACE_BROWSE_KINDS.find((kind) => kind.value === value)?.label ??
		value
	);
}

/** One canonical Home shelf. Hosts provide cards; this package owns the order,
 * title, empty copy, and the section that receives "See all". For you is a
 * separate optional block above these shelves, not another catalog shelf. */
export const MARKETPLACE_HOME_SHELVES = [
	{
		emptyLabel: "No models found.",
		key: "models",
		section: "models",
		title: "Popular models",
	},
	{
		emptyLabel: "No skills found.",
		key: "skills",
		section: "skills",
		title: "Featured skills",
	},
	{
		emptyLabel: "No MCP servers found.",
		key: "mcp",
		section: "mcp",
		title: "MCP servers",
	},
	{
		emptyLabel: "No agents found.",
		key: "agents",
		section: "agents",
		title: "Agents",
	},
	{
		emptyLabel: "No apps found.",
		key: "apps",
		section: "apps",
		title: "Apps",
	},
	{
		emptyLabel: "No plugins found.",
		key: "plugins",
		section: "plugins",
		title: "Plugins",
	},
] as const;

export type MarketplaceHomeShelfKey =
	(typeof MARKETPLACE_HOME_SHELVES)[number]["key"];

export type MarketplaceHomeShelfDefinition =
	(typeof MARKETPLACE_HOME_SHELVES)[number];

export function marketplaceHomeShelfDefinition(
	key: MarketplaceHomeShelfKey
): MarketplaceHomeShelfDefinition {
	return MARKETPLACE_HOME_SHELVES.find(
		(shelf) => shelf.key === key
	) as MarketplaceHomeShelfDefinition;
}
