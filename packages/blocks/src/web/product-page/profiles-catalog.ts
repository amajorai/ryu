import type { StageProductSlug } from "../backgrounds/stage-routes.ts";
import type {
	ProductArchetypeId,
	ProductCatalogItem,
	ProductProfile,
} from "./profile-types.ts";

/**
 * Product profiles for Marketplace and Connections
 * (unit catalog). Every entry is grounded: each item names its source, and
 * ./profile-grounding.ts checks the file and quote exist. Prices are computed
 * from `PUBLISHED_PRICING`, never typed by hand. What a page needs:
 * `ARCHETYPE_REQUIREMENTS` in ./archetypes.ts and `profileGaps` in ./profiles.ts.
 *
 * Each catalog is the thing the product is a directory of: Marketplace lists
 * its listing kinds (each card opens that kind's web Marketplace page, a
 * segment of `KIND_SEGMENTS` in apps/web/src/lib/marketplace-catalog.server.ts),
 * and Connections lists the access levels a connected account can be given.
 */
export const ARCHETYPE = "catalog" satisfies ProductArchetypeId;

export const PROFILE_SLUGS = [
	"marketplace",
	"connections",
] as const satisfies readonly StageProductSlug[];

export type ProfileSlug = (typeof PROFILE_SLUGS)[number];

const DOCS = "apps/fumadocs/content/docs";
const STORE_DOC = `${DOCS}/surfaces/desktop/user-guide/store.mdx`;
const PUBLISH_DOC = `${DOCS}/extend/develop/extensions/marketplace.mdx`;
const CONNECTIONS_DOC = `${DOCS}/surfaces/desktop/user-guide/tools-and-connections.mdx`;
const MARKETPLACE_CATALOG =
	"packages/blocks/src/web/data/catalog/marketplace-red-team.tsx";

/** Listing kinds, in the Browse order of `MARKETPLACE_BROWSE_KINDS`. */
const LISTING_KINDS: readonly ProductCatalogItem[] = [
	{
		title: "Apps",
		description:
			"Complete experiences you use inside Ryu, like Tests or Learning.",
		href: "/marketplace/apps",
		source: {
			path: STORE_DOC,
			quote:
				"**Apps** are complete experiences you use inside Ryu, like Tests or Learning.",
		},
	},
	{
		title: "Skills",
		description:
			"A SKILL.md and optional files that add instructions to a chat turn.",
		href: "/marketplace/skills",
		source: {
			path: `${DOCS}/core/skills-catalog.mdx`,
			quote:
				"Skills are Agent Skills (a `SKILL.md` plus optional resource files) that inject instructions into a chat turn.",
		},
	},
	{
		title: "Plugins",
		description:
			"Add capabilities to Ryu, such as tools, skills, agents, and workflows.",
		href: "/marketplace/plugins",
		source: {
			path: STORE_DOC,
			quote:
				"**Plugins** add capabilities to Ryu, such as tools, skills, agents, and workflows.",
		},
	},
	{
		title: "MCP servers",
		description: "Servers that provide tools your agents can call.",
		href: "/marketplace/mcp",
		source: {
			path: STORE_DOC,
			quote: "**MCP (Model Context Protocol) servers** that provide tools",
		},
	},
	{
		title: "Models",
		description: "Models to run on your node, with a check that they fit it.",
		href: "/marketplace/models",
		source: { path: STORE_DOC, quote: "models (with a device-fit check)" },
	},
	{
		title: "Agent Templates",
		description: "Agent definitions you can tailor, share, and publish.",
		href: "/marketplace/agents",
		source: {
			path: PUBLISH_DOC,
			quote: "it is a customized definition that can be shared and published",
		},
	},
	{
		title: "Language Packs",
		description:
			"Data-only packs that translate Ryu on web, desktop, mobile, Island, and in apps.",
		href: "/marketplace/language-packs",
		source: {
			path: `${DOCS}/extend/develop/extensions/language-packs.mdx`,
			quote:
				"data-only language packs that localize Ryu web, desktop, mobile, extension, Island, and Companion apps",
		},
	},
	{
		title: "Output Styles",
		description: "Reusable profiles for how an agent words its answers.",
		href: "/marketplace/output-styles",
		source: {
			path: `${DOCS}/extend/develop/api-reference/core/index.mdx`,
			quote: "Reusable response profiles and their user-authored source files.",
		},
	},
	{
		title: "Bundles",
		description:
			"A signed set of listings. Each member installs through its own installer and keeps its own permissions.",
		href: "/marketplace/bundles",
		source: {
			path: PUBLISH_DOC,
			quote:
				"calls the member's normal installer, so it keeps its own verification and permission boundary",
		},
	},
];

/** The connection access review, one card per level, in the docs' order. */
const ACCESS_LEVELS: readonly ProductCatalogItem[] = [
	{
		title: "Risk-based (recommended)",
		description:
			"Safe reads flow normally. Ryu asks before risky writes or deletes.",
		source: {
			path: CONNECTIONS_DOC,
			quote:
				"Safe reads flow normally; Ryu's default smart approval policy asks before risky writes or deletes.",
		},
	},
	{
		title: "Read only",
		description:
			"View and search only. Create, change, send, and delete actions are blocked.",
		source: {
			path: CONNECTIONS_DOC,
			quote:
				"View and search only. Create, change, send, and delete actions are blocked.",
		},
	},
	{
		title: "Write access",
		description: "View, create, update, and send. Delete actions stay blocked.",
		source: {
			path: CONNECTIONS_DOC,
			quote: "View, create, update, and send. Delete actions stay blocked.",
		},
	},
	{
		title: "Full access, including delete",
		description:
			"View, create, update, send, and known delete actions. Ryu still confirms destructive actions.",
		source: {
			path: CONNECTIONS_DOC,
			quote:
				"View, create, update, send, and known delete actions. Ryu's destructive-action confirmation still applies.",
		},
	},
];

const MARKETPLACE_PROFILE: ProductProfile = {
	facts: [
		{
			label: "Listing kinds in all",
			value: "15",
			source: { path: MARKETPLACE_CATALOG, quote: "15 kinds of listings" },
		},
		{
			label: "Package source",
			value: "Your GitHub repository",
			source: {
				path: PUBLISH_DOC,
				quote: "GitHub is the package source of truth",
			},
		},
		{
			label: "Releases",
			value: "Immutable .ryupack assets",
			source: {
				path: PUBLISH_DOC,
				quote: "create an immutable `.ryupack` Release;",
			},
		},
		{
			label: "Signing",
			value: "Signed by the Gateway",
			source: { path: PUBLISH_DOC, quote: "let the Gateway sign it;" },
		},
		{
			label: "Web and desktop",
			value: "Same sections, same order",
			source: {
				path: STORE_DOC,
				quote:
					"The web Marketplace at `/marketplace` and the desktop Store share the same sections, in this order:",
			},
		},
	],
	catalog: {
		title: "What you can install",
		subtitle:
			"The main listing kinds, not every one. Each has its own page in the web Marketplace.",
		// A selection of the kinds: the count reads "shown here", while the
		// at-a-glance fact gives the full total.
		countLabel: "Shown here",
		items: LISTING_KINDS,
	},
	docs: [
		{
			label: "Store",
			path: "/docs/surfaces/desktop/user-guide/store",
			description: "Browse and install apps, models, skills, and plugins.",
		},
		{
			label: "Install and manage downloads",
			path: "/docs/surfaces/desktop/user-guide/store-installation",
		},
		{
			label: "Buy and sell in the Marketplace",
			path: "/docs/surfaces/desktop/user-guide/marketplace",
		},
		{
			label: "Publish to the Marketplace",
			path: "/docs/extend/develop/extensions/marketplace",
			description: "From a GitHub repository to a signed listing.",
		},
	],
	related: [
		{
			label: "Community marketplaces",
			href: "/docs/extend/develop/extensions/community-marketplace",
			kind: "docs",
		},
		{
			label: "Portable packages",
			href: "/docs/extend/develop/extensions/portable-packages",
			kind: "docs",
		},
	],
};

const CONNECTIONS_PROFILE: ProductProfile = {
	facts: [
		{
			label: "Default access",
			value: "Risk-based",
			source: {
				path: CONNECTIONS_DOC,
				quote: "The default is **Risk-based**.",
			},
		},
		{
			label: "Enforced",
			value: "On your node, before the credential is used",
			source: {
				path: CONNECTIONS_DOC,
				quote:
					"enforces it before it uses the provider credential. The provider's OAuth scopes and the agent's tool allowlist are separate checks.",
			},
		},
		{
			label: "Token storage",
			value: "The node's encrypted identity storage",
			source: {
				path: CONNECTIONS_DOC,
				quote: "provider token in the node's encrypted identity storage.",
			},
		},
		{
			label: "Missing sign-in",
			value: "The run pauses and asks you to sign in",
			source: {
				path: CONNECTIONS_DOC,
				quote:
					"It pauses the run and asks you to sign in to that app before the action runs.",
			},
		},
	],
	catalog: {
		title: "How much each account may do",
		subtitle:
			"Pick a level before you sign in. Ryu stores it with the connection and enforces it before it uses the credential.",
		items: ACCESS_LEVELS,
	},
	docs: [
		{
			label: "Tools and Connections",
			path: "/docs/surfaces/desktop/user-guide/tools-and-connections",
			description: "Connect accounts and choose what agents may do with them.",
		},
		{
			label: "Unified tool catalog",
			path: "/docs/core/unified-tool-catalog",
		},
		{ label: "MCP registry", path: "/docs/core/mcp-registry" },
	],
	related: [
		{
			label: "How to connect AI agents to your tools with MCP",
			href: "/blog/how-to-connect-ai-agents-tools-mcp",
			kind: "blog",
		},
		{
			label: "MCP tools: a connection and permission checklist",
			href: "/blog/best-mcp-servers-tools",
			kind: "blog",
		},
		{ label: "Ryu 101", href: "/guides/ryu-101", kind: "guide" },
	],
	compareSlugs: ["composio", "zapier"],
};

export const PROFILES: Partial<Record<ProfileSlug, ProductProfile>> = {
	marketplace: MARKETPLACE_PROFILE,
	connections: CONNECTIONS_PROFILE,
};
