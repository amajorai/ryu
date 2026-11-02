import {
	PRODUCT_REALMS,
	type ProductRealmId,
	productRealm,
} from "./product-realm-list.ts";

export {
	PRODUCT_REALMS,
	type ProductRealm,
	type ProductRealmId,
	productRealm,
	productRealmsFor,
} from "./product-realm-list.ts";

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

function realmItem(
	id: ProductRealmId,
	{ description }: { description: string }
): ProductNavItem {
	const realm = productRealm(id);
	return { description, href: realm.href, id, label: navLabel(realm.label) };
}

/** A pre-release product: listed by its short catalogue nav label with its status. */
function upcomingItem({
	description,
	label,
	slug,
	status,
}: {
	description: string;
	label: string;
	slug: string;
	status: ProductNavStatus;
}): ProductNavItem {
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
			realmItem("bot", {
				description: "Managed AI without setting up a stack.",
			}),
			realmItem("console", {
				description: "Operate servers, models, permissions, and Apps.",
			}),
			{
				description: "The easiest way to get started with agents.",
				href: "/products/desktop",
				label: "Desktop",
			},
		],
		upcoming: [
			upcomingItem({
				slug: "os",
				label: "OS",
				status: "Early access",
				description: "A desktop workspace for agents and apps.",
			}),
			upcomingItem({
				slug: "chrome-extension",
				label: "Chrome",
				status: "Early access",
				description: "A page-aware companion in your browser.",
			}),
			upcomingItem({
				slug: "island",
				label: "Island",
				status: "Coming soon",
				description: "A screen-aware companion for the next step.",
			}),
			upcomingItem({
				slug: "mobile",
				label: "Mobile",
				status: "Coming soon",
				description: "Chat with your agents from your phone.",
			}),
			upcomingItem({
				slug: "devices",
				label: "Devices",
				status: "Coming soon",
				description: "Hardware companions for your Ryu server.",
			}),
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
			realmItem("gateway", {
				description: "Governed calls to tools and Skills.",
			}),
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
		items: [
			realmItem("mail", { description: "API-first email inboxes for agents." }),
		],
		upcoming: [
			upcomingItem({
				slug: "connect",
				label: "Connect",
				status: "Early access",
				description: "Hosted tools and Skills behind one API.",
			}),
			upcomingItem({
				slug: "passport",
				label: "Passport",
				status: "Early access",
				description: "An encrypted identity vault for agents.",
			}),
			upcomingItem({
				slug: "box",
				label: "Box",
				status: "Early access",
				description: "Isolated workspaces for agent runs.",
			}),
			upcomingItem({
				slug: "notify",
				label: "Notify",
				status: "Early access",
				description: "Durable events and delivery over HTTP.",
			}),
			upcomingItem({
				slug: "sites",
				label: "Sites",
				status: "Early access",
				description: "Save, review, and deploy websites.",
			}),
			upcomingItem({
				slug: "hire",
				label: "Hire",
				status: "Early access",
				description: "A specialist agent for one task.",
			}),
			upcomingItem({
				slug: "messaging",
				label: "Messaging",
				status: "Early access",
				description: "SMS, WhatsApp, and phone numbers for agents.",
			}),
			upcomingItem({
				slug: "compute",
				label: "Compute",
				status: "Coming soon",
				description: "Rent compute for a bounded run.",
			}),
			upcomingItem({
				slug: "share",
				label: "Share",
				status: "Coming soon",
				description: "Share idle capacity from your machine.",
			}),
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
