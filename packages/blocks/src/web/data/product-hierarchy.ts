import type { LucideIcon } from "lucide-react";
import {
	Bot,
	Cloud,
	Code2,
	Cpu,
	Settings2,
	ShieldCheck,
	Workflow,
} from "lucide-react";
import type { LandingCardTone } from "../landing-card-tones.ts";

export type ProductHierarchyId =
	| "deploy"
	| "sdk"
	| "core"
	| "gateway"
	| "bot"
	| "console"
	| "apps";

export interface ProductHierarchyRealm {
	description: string;
	group: "Infra" | "Platform" | "Interfaces / surfaces";
	href: string;
	icon: LucideIcon;
	id: ProductHierarchyId;
	label: string;
	tone: LandingCardTone;
	verb: string;
}

export const PRODUCT_HIERARCHY: readonly ProductHierarchyRealm[] = [
	{
		description: "Deploy Ryu in the cloud.",
		group: "Infra",
		href: "/platform#infra",
		icon: Cloud,
		id: "deploy",
		label: "Deploy",
		tone: "orange",
		verb: "Cloud",
	},
	{
		description: "Add Ryu capabilities to an existing product.",
		group: "Platform",
		href: "/products/sdk",
		icon: Code2,
		id: "sdk",
		label: "SDK",
		tone: "blue",
		verb: "Integrate",
	},
	{
		description: "Run models, agents, tools, memory and workflows.",
		group: "Platform",
		href: "/products/core",
		icon: Cpu,
		id: "core",
		label: "Core",
		tone: "purple",
		verb: "Run",
	},
	{
		description: "Secure model access, spending and providers.",
		group: "Platform",
		href: "/products/gateway",
		icon: ShieldCheck,
		id: "gateway",
		label: "Gateway",
		tone: "yellow",
		verb: "Secure",
	},
	{
		description: "Chat with Ryu through the Bot interface.",
		group: "Interfaces / surfaces",
		href: "/bot",
		icon: Bot,
		id: "bot",
		label: "Bot",
		tone: "teal",
		verb: "Chat",
	},
	{
		description: "Configure Ryu from the control panel.",
		group: "Interfaces / surfaces",
		href: "/agent",
		icon: Settings2,
		id: "console",
		label: "Agent",
		tone: "pink",
		verb: "Configure",
	},
	{
		description: "Use ready-made applications for business workflows.",
		group: "Interfaces / surfaces",
		href: "/marketplace",
		icon: Workflow,
		id: "apps",
		label: "Apps",
		tone: "green",
		verb: "Use",
	},
];
