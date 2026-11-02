// The platform story's copy and link data. Split from `platform-story.tsx`.

import {
	Blocks,
	Bot,
	Cloud,
	Code2,
	Cpu,
	GitBranch,
	Globe2,
	Layers3,
	Link2,
	type LucideIcon,
	MonitorSmartphone,
	Network,
	ScanSearch,
	Settings2,
	ShieldCheck,
	Smartphone,
	Terminal,
	Workflow,
} from "lucide-react";
import type { Route } from "next";
import { copyMarker as t } from "./copy-marker.ts";
import { docsHref } from "./data/resources.tsx";

/**
 * The `/products/[slug]` pages the story links. Typed routes accept a dynamic
 * route only through its literal path, so `Route` alone would reject them.
 */
export type PlatformProductHref =
	| "/products/core"
	| "/products/gateway"
	| "/products/sdk";

export interface PlatformLayer {
	description: string;
	group: "Infra" | "Platform" | "Interfaces / surfaces";
	href: Route<PlatformProductHref>;
	icon: LucideIcon;
	id: string;
	name: string;
	positioning: string;
	verb: string;
}

export const PLATFORM_LAYERS: readonly PlatformLayer[] = [
	{
		description: "Deploy Ryu in the cloud.",
		group: "Infra",
		href: "/platform#infra",
		icon: Cloud,
		id: "deploy",
		name: "Deploy",
		positioning: "Deploy Ryu in the cloud.",
		verb: t("Cloud"),
	},
	{
		description: "Add Ryu capabilities to an existing product.",
		group: "Platform",
		href: "/products/sdk",
		icon: Code2,
		id: "sdk",
		name: "SDK",
		positioning: "Add Ryu capabilities to an existing product.",
		verb: t("Integrate"),
	},
	{
		description: "Run models, agents, tools, memory and workflows.",
		group: "Platform",
		href: "/products/core",
		icon: Cpu,
		id: "core",
		name: "Core",
		positioning: "Run models, agents, tools, memory and workflows.",
		verb: t("Run"),
	},
	{
		description: "Secure model access, spending and providers.",
		group: "Platform",
		href: "/products/gateway",
		icon: ShieldCheck,
		id: "gateway",
		name: "Gateway",
		positioning: "Secure model access, spending and providers.",
		verb: t("Secure"),
	},
	{
		description: "Chat with Ryu through the Bot interface.",
		group: "Interfaces / surfaces",
		href: "/bot",
		icon: Bot,
		id: "bot",
		name: "Bot",
		positioning: "Chat with Ryu through the Bot interface.",
		verb: t("Chat"),
	},
	{
		description: "Configure Ryu from the control panel.",
		group: "Interfaces / surfaces",
		href: "/agent",
		icon: Settings2,
		id: "console",
		name: "Agent",
		positioning: "Configure Ryu from the control panel.",
		verb: t("Configure"),
	},
	{
		description: "Use ready-made applications for business workflows.",
		group: "Interfaces / surfaces",
		href: "/marketplace",
		icon: Workflow,
		id: "apps",
		name: "Apps",
		positioning: "Use ready-made applications for business workflows.",
		verb: t("Use"),
	},
];

export const PRIMITIVES = [
	"Models",
	"Agents",
	"Tools",
	"Memory",
	"RAG",
	"Workflows",
	"Policies",
	"Servers",
	"Surfaces",
	"Apps",
] as const;

export interface IntegrationPath {
	description: string;
	href: string;
	icon: LucideIcon;
	label: string;
	token: string;
}

export const INTEGRATION_PATHS: readonly IntegrationPath[] = [
	{
		description:
			"Point OpenAI, Anthropic, Gemini, or a raw HTTP client at one governed endpoint.",
		href: "/products/gateway",
		icon: Network,
		label: "Gateway endpoint",
		token: "/v1",
	},
	{
		description:
			"Author typed agents, workflows, tools, and skills, or embed chat in your own UI.",
		href: docsHref("/docs/extend/develop/sdk"),
		icon: Blocks,
		label: "SDK",
		token: "@ryuhq/sdk",
	},
	{
		description:
			"Expose a Core server to MCP hosts or bring external MCP servers into the tool catalog.",
		href: docsHref("/docs/extend/integrate/mcp-integration"),
		icon: Link2,
		label: "MCP",
		token: "ryu-mcp",
	},
	{
		description:
			"Drive agent subprocesses with ACP or connect remote agents with A2A.",
		href: docsHref("/docs/extend/integrate/acp-integration"),
		icon: Bot,
		label: "ACP + A2A",
		token: "agent protocols",
	},
	{
		description:
			"Package capabilities as Apps, sandboxed iframe widgets, standalone companions, or plugins from a starter project.",
		href: docsHref("/docs/extend/develop/extensions/ryu-apps"),
		icon: Workflow,
		label: "Apps + widgets",
		token: "manifest.json · create-ryu-app",
	},
	{
		description:
			"Run the same work from Desktop, mobile, browser, terminal, or a website's local server.",
		href: docsHref("/docs/surfaces"),
		icon: MonitorSmartphone,
		label: "Every surface",
		token: "local → cloud",
	},
	{
		description:
			"Run saved agents and allowlisted tools inside a GitHub workflow.",
		href: docsHref("/docs/ci/github-actions"),
		icon: GitBranch,
		label: "GitHub Actions",
		token: "amajorai/ryu@v1",
	},
	{
		description:
			"Use a managed Ryu or provider subscription, bring provider keys, or self-host the server in your environment.",
		href: "/platform#infra",
		icon: Globe2,
		label: "Managed or self-hosted",
		token: "BYOK · BYOS",
	},
];

export interface Capability {
	description: string;
	href: string;
	icon: LucideIcon;
	name: string;
}

export const CAPABILITIES: readonly Capability[] = [
	{
		description:
			"Local GGUF, safetensors, and MLX models, hosted providers, BYOK, routing, fallback, and caching.",
		href: "/products/core",
		icon: Cpu,
		name: t("Models + providers"),
	},
	{
		description:
			"Agents, sub-agents, teams, workflows, sessions, durable runs, and human approvals.",
		href: docsHref("/docs/core/workflows"),
		icon: Bot,
		name: t("Agents + orchestration"),
	},
	{
		description:
			"Spaces, long-term memory, embeddings, retrieval, conversation search, and RAG.",
		href: docsHref("/docs/core/memory"),
		icon: Layers3,
		name: t("Knowledge + memory"),
	},
	{
		description:
			"Vision models, OCR, document parsing, image and media workflows, voice, and transcription.",
		href: docsHref("/docs/core/mcp-registry"),
		icon: ScanSearch,
		name: t("Multimodal + OCR"),
	},
	{
		description:
			"Train LoRA or QLoRA adapters locally or remotely, then merge the result into a model you can run.",
		href: docsHref("/docs/apps/finetune"),
		icon: Terminal,
		name: t("Fine-tuning"),
	},
	{
		description:
			"Permissions, firewall, DLP, budgets, rate limits, approvals, evals, and an audit trail.",
		href: "/products/gateway",
		icon: ShieldCheck,
		name: t("Governance + spend"),
	},
	{
		description:
			"Browser-local models, in-page tools, and an explicit path to a visitor's own Ryu server.",
		href: docsHref("/docs/surfaces/browser-extension"),
		icon: Globe2,
		name: t("Browser + local AI"),
	},
	{
		description:
			"On-device mobile models plus native notifications, files, camera, haptics, and background status.",
		href: docsHref("/docs/surfaces/mobile"),
		icon: Smartphone,
		name: t("Mobile + device AI"),
	},
];

export interface ShowcaseItem {
	description: string;
	external?: boolean;
	href: string;
	icon: LucideIcon;
	label: string;
	name: string;
}

export const SHOWCASE: readonly ShowcaseItem[] = [
	{
		description:
			"An external product using @ryuhq/client to route text generation through Ryu Core.",
		external: true,
		href: "https://github.com/amajorai/updatenight",
		icon: Code2,
		label: "External app",
		name: "Update Night",
	},
	{
		description:
			"Ryu's own app catalog: focused workflows backed by sidecars, companions, and shared platform seams.",
		href: docsHref("/docs/apps"),
		icon: Workflow,
		label: "Ryu-built software",
		name: t("Ryu Apps"),
	},
	{
		description:
			"A website or browser extension can run a small model locally or call a server the visitor controls.",
		href: docsHref("/docs/surfaces/browser-extension"),
		icon: MonitorSmartphone,
		label: "Web + browser",
		name: t("Local AI in the tab"),
	},
	{
		description:
			"Agents and allowlisted tools become steps in a repeatable CI workflow with the same Core contract.",
		href: docsHref("/docs/ci/github-actions"),
		icon: GitBranch,
		label: "Automation",
		name: t("Ryu in GitHub"),
	},
];
