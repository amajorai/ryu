// The realm list behind `product-realms.ts`, split out to keep that module
// under the file-size limit. Import from `product-realms.ts`, which re-exports it.

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
