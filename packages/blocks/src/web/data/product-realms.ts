import type { LucideIcon } from "lucide-react";
import {
	Bell,
	Bot,
	Box,
	Cable,
	Cpu,
	Globe,
	Key,
	Mail,
	Monitor,
	Settings2,
	Share2,
	Shield,
	Zap,
} from "lucide-react";

/**
 * The small, public product vocabulary shared by the landing page and the
 * marketing header. The larger product catalogue remains in `products.tsx`;
 * this list is intentionally limited to the products people can choose.
 */
export type ProductRealmId =
	| "os"
	| "bot"
	| "console"
	| "gateway"
	| "connect"
	| "passport"
	| "box"
	| "mail"
	| "notify"
	| "sites"
	| "hire"
	| "compute"
	| "share";

export interface ProductRealm {
	description: string;
	href: string;
	icon: LucideIcon;
	id: ProductRealmId;
	label: string;
	shortLabel: string;
	type: "workspace" | "service";
}

export const PRODUCT_REALMS: readonly [ProductRealm, ...ProductRealm[]] = [
	{
		description: "A calm desktop workspace where your tools become windows.",
		href: "/products/os",
		icon: Monitor,
		id: "os",
		label: "OS",
		shortLabel: "OS",
		type: "workspace",
	},
	{
		description: "Managed AI you can ask for work without setting up a stack.",
		href: "/bot",
		icon: Bot,
		id: "bot",
		label: "Bot",
		shortLabel: "Bot",
		type: "workspace",
	},
	{
		description:
			"The operator surface for servers, models, permissions, and Apps.",
		href: "/agent",
		icon: Settings2,
		id: "console",
		label: "Agent",
		shortLabel: "Agent",
		type: "workspace",
	},
	{
		description:
			"Programmatic, governed calls to tools and Skills from any system.",
		href: "/products/gateway",
		icon: Shield,
		id: "gateway",
		label: "Ryu Gateway",
		shortLabel: "Gateway",
		type: "service",
	},
	{
		description:
			"MCP hosting, Skills, governed tools, and Composio behind one edge.",
		href: "/products/connect",
		icon: Cable,
		id: "connect",
		label: "Ryu Connect",
		shortLabel: "Connect",
		type: "service",
	},
	{
		description:
			"Encrypted identity connections for agents and their allowed sessions.",
		href: "/products/passport",
		icon: Key,
		id: "passport",
		label: "Ryu Passport",
		shortLabel: "Passport",
		type: "service",
	},
	{
		description:
			"A persistent, isolated workspace for agent runs and previews.",
		href: "/products/box",
		icon: Box,
		id: "box",
		label: "Ryu Box",
		shortLabel: "Box",
		type: "service",
	},
	{
		description:
			"API-first email inboxes for agents, with signed inbound mail.",
		href: "/products/mail",
		icon: Mail,
		id: "mail",
		label: "Ryu Mail",
		shortLabel: "Mail",
		type: "service",
	},
	{
		description:
			"Durable events, live activities, and channel delivery over HTTP.",
		href: "/products/notify",
		icon: Bell,
		id: "notify",
		label: "Ryu Notify",
		shortLabel: "Notify",
		type: "service",
	},
	{
		description:
			"Saved versions, secret-scanned deploys, and a separate visitor origin.",
		href: "/products/sites",
		icon: Globe,
		id: "sites",
		label: "Ryu Sites",
		shortLabel: "Sites",
		type: "service",
	},
	{
		description:
			"Early access: recruit a specialist for one run without installing it.",
		href: "/products/hire",
		icon: Zap,
		id: "hire",
		label: "Ryu Hire",
		shortLabel: "Hire",
		type: "service",
	},
	{
		description: "Rent governed CPU or GPU capacity for a bounded run.",
		href: "/products/compute",
		icon: Cpu,
		id: "compute",
		label: "Ryu Compute",
		shortLabel: "Compute",
		type: "service",
	},
	{
		description: "Share idle Ryu capacity without giving up your machine.",
		href: "/products/share",
		icon: Share2,
		id: "share",
		label: "Ryu Share",
		shortLabel: "Share",
		type: "service",
	},
] as const satisfies readonly ProductRealm[];

/**
 * The realms for `ids`, in order. `hiddenIds` drops realms the host has not
 * rolled out (a standalone service whose rollout flag is off) without editing
 * the shared realm data.
 */
export function productRealmsFor(
	ids: readonly ProductRealmId[],
	hiddenIds: readonly string[] = []
): ProductRealm[] {
	const hidden = new Set(hiddenIds);
	return ids.flatMap((id) => {
		if (hidden.has(id)) {
			return [];
		}
		const realm = PRODUCT_REALMS.find((candidate) => candidate.id === id);
		return realm ? [realm] : [];
	});
}

export function productRealm(id: ProductRealmId): ProductRealm {
	return PRODUCT_REALMS.find((realm) => realm.id === id) ?? PRODUCT_REALMS[0];
}

export type ProductNavStatus = "Early access" | "Coming soon";

export interface ProductNavItem {
	/**
	 * Plain-language summary of the product; at most 8 words. The header menus
	 * list bare names only.
	 */
	description: string;
	href: string;
	id?: ProductRealmId;
	label: string;
	status?: ProductNavStatus;
}

export interface ProductNavGroup {
	items: readonly ProductNavItem[];
	title: "Workspaces" | "Build" | "Platform" | "Agent APIs";
	/**
	 * Pre-release products in this group. The menus list only available products
	 * and leave these to /products; the data keeps the catalogue mapping checked.
	 */
	upcoming?: readonly ProductNavItem[];
}

/** Nav labels are bare names (Bot, Agent, Gateway): the menu already says Ryu. */
function navLabel(name: string): string {
	return name.replace(/^Ryu /, "");
}

function realmItem(id: ProductRealmId, description: string): ProductNavItem {
	const realm = productRealm(id);
	return { description, href: realm.href, id, label: navLabel(realm.label) };
}

/** A pre-release product: listed by its short catalogue nav label with its status. */
function upcomingItem(
	slug: string,
	label: string,
	status: ProductNavStatus,
	description: string
): ProductNavItem {
	// Realm-backed products keep their id so a closed rollout flag still drops
	// them from the nav data (`productNavGroupsFor`).
	const realm = PRODUCT_REALMS.find((candidate) => candidate.id === slug);
	return {
		description,
		href: `/products/${slug}`,
		...(realm ? { id: realm.id } : {}),
		label,
		status,
	};
}

/**
 * The single product taxonomy for the marketing header and the mobile sheet. It
 * mirrors the /products catalogue in `products.tsx` (group, name, and status per
 * product; product-realms.test.ts enforces this) without importing it, so the header
 * does not ship every product visual. Every label is the catalogue's bare nav label.
 * A group lists only products available today; products in early access or coming
 * soon stay on /products. Descriptions are shortened from each catalogue tagline.
 */
export const PRODUCT_NAV_GROUPS: readonly ProductNavGroup[] = [
	{
		title: "Workspaces",
		items: [
			realmItem("bot", "Managed AI without setting up a stack."),
			realmItem("console", "Operate servers, models, permissions, and Apps."),
			{
				description: "The easiest way to get started with agents.",
				href: "/products/desktop",
				label: "Desktop",
			},
		],
		upcoming: [
			upcomingItem(
				"os",
				"OS",
				"Early access",
				"A desktop workspace for agents and apps."
			),
			upcomingItem(
				"chrome-extension",
				"Chrome",
				"Early access",
				"A page-aware companion in your browser."
			),
			upcomingItem(
				"island",
				"Island",
				"Coming soon",
				"A screen-aware companion for the next step."
			),
			upcomingItem(
				"mobile",
				"Mobile",
				"Coming soon",
				"Chat with your agents from your phone."
			),
			upcomingItem(
				"devices",
				"Devices",
				"Coming soon",
				"Hardware companions for your Ryu server."
			),
		],
	},
	{
		title: "Build",
		items: [
			{
				description: "Build your own agent, nothing locked in.",
				href: "/products/agents",
				label: "Agents",
			},
			{
				description: "Chain agents and tools into durable pipelines.",
				href: "/products/workflows",
				label: "Workflows",
			},
			{
				description: "Install Agent Skills in one click.",
				href: "/products/skills",
				label: "Skills",
			},
			{
				description: "Browse and install agents, skills, and tools.",
				href: "/marketplace",
				label: "Marketplace",
			},
			{
				description: "Define agents, workflows, tools, and skills in code.",
				href: "/products/sdk",
				label: "SDK",
			},
		],
	},
	{
		title: "Platform",
		items: [
			{
				description: "The local-first runtime every agent runs on.",
				href: "/products/core",
				label: "Core",
			},
			realmItem("gateway", "Governed calls to tools and Skills."),
			{
				description: "We build, host, and run your agents.",
				href: "/products/cloud",
				label: "Cloud",
			},
			{
				description: "We scope and set up your first agent.",
				href: "/products/agents-as-a-service",
				label: "Agents as a Service",
			},
			{
				description: "Probe your agents for common security failures.",
				href: "/products/red-team",
				label: "Red Teaming",
			},
		],
	},
	{
		title: "Agent APIs",
		items: [realmItem("mail", "API-first email inboxes for agents.")],
		upcoming: [
			upcomingItem(
				"connect",
				"Connect",
				"Early access",
				"Hosted tools and Skills behind one API."
			),
			upcomingItem(
				"passport",
				"Passport",
				"Early access",
				"An encrypted identity vault for agents."
			),
			upcomingItem(
				"box",
				"Box",
				"Early access",
				"Isolated workspaces for agent runs."
			),
			upcomingItem(
				"notify",
				"Notify",
				"Early access",
				"Durable events and delivery over HTTP."
			),
			upcomingItem(
				"sites",
				"Sites",
				"Early access",
				"Save, review, and deploy websites."
			),
			upcomingItem(
				"hire",
				"Hire",
				"Early access",
				"A specialist agent for one task."
			),
			upcomingItem(
				"messaging",
				"Messaging",
				"Early access",
				"SMS, WhatsApp, and phone numbers for agents."
			),
			upcomingItem(
				"compute",
				"Compute",
				"Coming soon",
				"Rent compute for a bounded run."
			),
			upcomingItem(
				"share",
				"Share",
				"Coming soon",
				"Share idle capacity from your machine."
			),
		],
	},
];

const PRODUCT_PAGE_HREF = /^\/products\/([^/?#]+)$/u;

/** The `/products/<slug>` slug an item links to, or undefined for another route. */
export function productNavSlug(item: Pick<ProductNavItem, "href">) {
	return PRODUCT_PAGE_HREF.exec(item.href)?.[1];
}

/** A stable key for a nav item: its realm id, product slug, or route. */
export function productNavKey(item: ProductNavItem): string {
	return item.id ?? productNavSlug(item) ?? item.href.replace(/^\//u, "");
}

/**
 * `PRODUCT_NAV_GROUPS` without the products in `hiddenIds`, in order. An id
 * matches an item's realm id (a standalone service whose rollout flag is off)
 * or the slug of its `/products/<slug>` page (a product whose `catalog.*`
 * launch flag is off). A group left with nothing to show is dropped. The
 * shared nav data is never edited to hide a product.
 */
export function productNavGroupsFor(
	hiddenIds: readonly string[] = []
): ProductNavGroup[] {
	if (hiddenIds.length === 0) {
		return [...PRODUCT_NAV_GROUPS];
	}
	const hidden = new Set(hiddenIds);
	const visible = (item: ProductNavItem) =>
		!(hidden.has(item.id ?? "") || hidden.has(productNavSlug(item) ?? ""));
	return PRODUCT_NAV_GROUPS.flatMap((group) => {
		const items = group.items.filter(visible);
		const upcoming = group.upcoming?.filter(visible) ?? [];
		if (items.length === 0 && upcoming.length === 0) {
			return [];
		}
		return [
			{
				...group,
				items,
				...(upcoming.length > 0 ? { upcoming } : { upcoming: undefined }),
			},
		];
	});
}

/**
 * The groups the header menu and mobile sheet show: `productNavGroupsFor`
 * without the groups that have no available product left, so a group whose
 * services are all pre-release or behind a closed rollout flag (Agent APIs
 * while `services.mail` is off) does not render as an empty column.
 */
export function productMenuGroupsFor(
	hiddenIds: readonly string[] = []
): ProductNavGroup[] {
	return productNavGroupsFor(hiddenIds).filter(
		(group) => group.items.length > 0
	);
}

/** The available products the header menu lists, flattened in menu order. */
export function productMenuItemsFor(
	hiddenIds: readonly string[] = []
): ProductNavItem[] {
	return productMenuGroupsFor(hiddenIds).flatMap((group) => [...group.items]);
}

/**
 * Label for the muted pre-release line under a nav group: the shared status when
 * every item has one, otherwise "On the way", the /products group title.
 */
export function upcomingNavLabel(items: readonly ProductNavItem[]): string {
	const statuses = new Set(items.map((item) => item.status));
	const [only] = statuses;
	return statuses.size === 1 && only ? only : "On the way";
}
