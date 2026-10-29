import { Box, Cable, Cloud, Cpu, Key, Shield } from "lucide-react";
import { ProductFigure } from "../../product-figure.tsx";
import { BoxNetworkVisual } from "../../product-row-visuals.tsx";
import {
	BoxVisual,
	ConnectTenantsVisual,
	ConnectVisual,
	GatewayBaseUrlVisual,
} from "../../visuals.tsx";
import type { Product } from "../product-types.ts";
import {
	BOOK_DEMO,
	CloudChannelsVisual,
	CloudScheduleVisual,
	DOWNLOAD,
	EARLY_ACCESS,
	HOSTED_AGENTS_DOCS,
	PassportFetchVisual,
	readTheDocs,
	SEE_PLANS,
} from "./shared.tsx";

/** Core, Gateway, Passport, Connect, Cloud and Box, in catalogue order (see `../products.tsx`). */
export const CORE_TO_BOX: Product[] = [
	/* ============================ PLATFORM ========================== */
	{
		slug: "core",
		name: "Ryu Core",
		navLabel: "Core",
		category: "Platform",
		tagline: "The local-first runtime every agent, session, and tool runs on.",
		Icon: Cpu,
		hero: {
			eyebrow: "Ryu Core",
			title: "Open-source runtime for developers and servers",
			// core.md C3, C11.
			subtitle:
				"Run Claude Code, Codex, Gemini CLI, or any OpenAI-compatible agent, headless or in Docker. Chat runs locally after a one-time model download.",
			primaryCta: DOWNLOAD,
			secondaryCta: readTheDocs("/docs/core"),
			visual: <ProductFigure figure="core-engines" />,
		},
		bento: {
			title: "What Core runs",
			items: [
				{
					title: "Sub-agents and workflows",
					description:
						"An agent can hand steps to sub-agents and workflows, and Core runs them all.",
				},
				{
					title: "Sessions and memory",
					description:
						"Conversation history, encrypted long-term memory, and searchable Spaces, built in.",
				},
				{
					title: "Tools via MCP",
					description:
						"Choose the MCP tools each agent may use. The Gateway scans and audits shell commands.",
				},
				{
					title: "Git-native workspace",
					description:
						"Each run gets its own worktree. Review the diff, then merge or open a PR.",
				},
				{
					title: "Runs anywhere",
					description:
						"Run it on a Mac, a Windows or Linux PC, or a server with Docker.",
				},
			],
		},
		faq: [
			{
				q: "Is Ryu Core open source?",
				a: "Yes. Core and the Gateway are open source and self‑hostable. Ryu Desktop is source-available; the web app and cloud backend are closed.",
			},
			{
				q: "Do I need an API key or the cloud to use it?",
				a: "No. On first run Core downloads llama.cpp and Gemma 4, then chats locally. Bring your own keys or a subscription only when you want hosted models.",
			},
			{
				q: "What does Core collect by default?",
				a: "Diagnostics export is off by default. Product analytics and crash reports are on by default and can be turned off in Settings → Privacy.",
			},
		],
		cta: {
			title: "Ready to run agents locally?",
			subtitle: "",
			primaryCta: DOWNLOAD,
			secondaryCta: readTheDocs("/docs/core"),
		},
	},

	{
		slug: "gateway",
		name: "Ryu Gateway",
		navLabel: "Gateway",
		category: "Platform",
		standalone: true,
		tagline: "Route, protect, and audit model and tool calls through one API.",
		Icon: Shield,
		hero: {
			eyebrow: "Ryu Gateway",
			title: "Control model and tool access",
			subtitle:
				"One API for model and tool calls. Route, protect, and audit each one without rewriting your agent.",
			primaryCta: readTheDocs("/docs/standalone/gateway"),
			secondaryCta: BOOK_DEMO,
			visual: <ProductFigure figure="gateway-pipeline" />,
		},
		splits: [
			{
				title: "Connect an existing agent",
				description:
					"The Gateway is an OpenAI-compatible proxy. Swap the base URL on an agent you already built, and every call it routes follows your rules.",
				visual: <GatewayBaseUrlVisual />,
			},
		],
		bento: {
			title: "What the Gateway controls",
			subtitle:
				"Core decides what runs. The Gateway decides what is allowed, measured, and paid for.",
			items: [
				{
					title: "Security firewall",
					description:
						"Checks every request for prompt injection and jailbreaks before it reaches a model.",
				},
				{
					title: "Sensitive data",
					description:
						"Finds personal data and secrets in requests and replies, then blocks (default) or redacts them.",
				},
				{
					title: "Routing with fallback",
					// gateway.md G7: the breaker opens after 5 consecutive failures.
					description:
						"Falls back to another model and pauses a provider after 5 failures in a row.",
				},
				{
					title: "Budgets and cost",
					description:
						"Budgets per agent, user, team, or key, with hard stops and optional semantic caching.",
				},
				{
					title: "Evals and audit",
					description:
						"Score responses with evals. Audit is on by default and always runs last.",
				},
				{
					title: "Key vault",
					description: "Bring your own keys. Agents never see a raw secret.",
				},
			],
		},
		faq: [
			{
				q: "Which providers can it route to?",
				a: "Agents call it in the OpenAI, Anthropic, or Gemini API format. Your routing config picks the provider for each model, with a fallback chain when one fails.",
			},
			{
				q: "Does my data leave my infrastructure?",
				a: "Self-hosted, the Gateway runs in your infrastructure, and calls leave it only for the providers you route to. Its audit log keeps usage metadata, not prompt text.",
			},
			{
				q: "What happens when the firewall flags a request?",
				a: "By default it is blocked with a 403 and never reaches a provider. You can instead redact the flagged text and continue, or log a warning, and set that per org or agent.",
			},
		],
		cta: {
			title: "Ready to control every call?",
			subtitle: "Run it standalone or underneath Ryu Desktop and Ryu Cloud.",
			primaryCta: readTheDocs("/docs/standalone/gateway"),
			secondaryCta: BOOK_DEMO,
		},
	},

	{
		slug: "passport",
		name: "Ryu Passport",
		navLabel: "Passport",
		category: "Agent APIs",
		standalone: true,
		status: "early-access",
		tagline:
			"An encrypted identity vault for agents and the sessions they are allowed to use.",
		Icon: Key,
		hero: {
			eyebrow: "Ryu Passport · Early access",
			title: "Safe sign‑ins for agents",
			subtitle:
				"Keep the sessions your agents use in an encrypted vault. Re-login is always a manual step.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: readTheDocs("/docs/standalone/passport"),
			visual: <ProductFigure figure="passport-cabinet" />,
		},
		splits: [
			{
				title: "Agents get the page, not the key",
				description:
					"Passport makes the upstream fetch itself and redacts any credential echoed back, so only content reaches the agent.",
				visual: <PassportFetchVisual />,
			},
		],
		bento: {
			title: "Every sign-in in one place",
			items: [
				{
					title: "Profiles and domains",
					description:
						"Group per-domain connections under one profile and bind it to an agent.",
				},
				{
					title: "Import a session",
					description:
						"Log in with a provider you trust, import the session, and re-import when it expires.",
				},
				{
					title: "Audited reads",
					description: "Each read by Core or the Gateway is audited.",
				},
				{
					title: "Tenant-separated",
					description: "Each tenant gets its own encrypted store and profiles.",
				},
				// gateway.md P14; apps/passport/src/mcp.rs.
				{
					title: "MCP sign-ins",
					description: "Also keeps sign-ins for remote MCP servers.",
				},
			],
		},
		faq: [
			{
				q: "Is Passport a browser automation engine?",
				a: "No. Passport stores sign-ins and tracks when they expire. A browser or capture tool can plug in as a source; today you import sessions by hand.",
			},
			{
				q: "Can Passport run without Ryu Core?",
				a: "Yes. The standalone service uses the same encrypted vault as Core, with its own tokens and data directory.",
			},
		],
		cta: {
			title: "Ready to secure agent sign-ins?",
			subtitle: "Run it beside your agents, or under Ryu Core and the Gateway.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: readTheDocs("/docs/standalone/passport"),
		},
	},

	{
		slug: "connect",
		name: "Ryu Connect",
		navLabel: "Connect",
		category: "Agent APIs",
		standalone: true,
		status: "early-access",
		tagline: "Hosted tools and Skills behind one API.",
		Icon: Cable,
		hero: {
			eyebrow: "Ryu Connect · Early access",
			title: "One API for agent tools",
			subtitle:
				"Serve MCP servers, Skills, and hosted tools behind one API. Provider secrets stay out of your app.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: readTheDocs("/docs/standalone/connect"),
			visual: <ConnectVisual />,
		},
		splits: [
			{
				title: "Each customer sees only its tools",
				description:
					"Choose which hosted Skills and tools each customer can discover and call.",
				visual: <ConnectTenantsVisual />,
			},
		],
		bento: {
			title: "Built for products with many customers",
			items: [
				{
					title: "Hosted Skills",
					description:
						"Skills are served to MCP clients as readable resources.",
				},
				{
					// gateway.md C2: apps/connect/src/mcp.ts:1-60.
					title: "Any MCP client",
					description:
						"Point existing MCP clients at your hosted Skills and tools.",
				},
				{
					title: "MCP or REST",
					description:
						"Reach the same tools through the MCP protocol or a REST API.",
				},
				{
					title: "Trigger events",
					description:
						"Events from connected apps wait in an inbox until your service picks them up.",
				},
			],
		},
		faq: [
			{
				q: "Does Connect replace the Gateway or Core?",
				a: "No. Connect hosts and runs its own registered tools. Core runs agents, and the Gateway handles model routing and policy. A compatibility mode can forward to an existing Core and Gateway.",
			},
			{
				q: "How is Connect different from Connections?",
				a: "Connections is for your agents; Ryu Connect embeds the same sign-ins in your own product.",
			},
			{
				q: "Where do connected accounts live?",
				a: "With our app-connection provider, Composio. Connect keeps the provider key on the server and only lets each customer use its own accounts.",
			},
		],
		cta: {
			title: "Ready to host your agent tools?",
			subtitle: "",
			primaryCta: EARLY_ACCESS,
			secondaryCta: readTheDocs("/docs/standalone/connect"),
		},
	},

	{
		slug: "cloud",
		name: "Ryu Cloud",
		navLabel: "Cloud",
		category: "Platform",
		tagline: "Managed hosting that runs your agents.",
		Icon: Cloud,
		hero: {
			eyebrow: "Ryu Cloud",
			title: "Run your agents on Ryu Cloud",
			// services.md: base-node.ts:74-84, 191-224; feature-flags.ts:255-264.
			subtitle:
				"Managed cloud nodes for your agents. Teams and Business plans include one, in the EU or Singapore.",
			primaryCta: SEE_PLANS,
			secondaryCta: readTheDocs(HOSTED_AGENTS_DOCS),
			visual: <CloudChannelsVisual />,
		},
		// services.md C3, C10.
		splits: [
			{
				title: "Runs while your devices sleep",
				description:
					"Scheduled and event-driven runs keep going on your cloud node when your devices are off, with optional per-step retries.",
				visual: <CloudScheduleVisual />,
			},
		],
		bento: {
			title: "What a node gives you",
			items: [
				// base-node.ts:191-224; cloud-node-access.ts:8-23.
				{
					title: "Managed node included",
					description:
						"Eligible plans include one managed node; team plans can add more.",
				},
				// services.md C13.
				{
					title: "Gateway rules apply",
					description:
						"Model and tool calls routed through the Gateway get its firewall, budgets, and audit log.",
				},
				// base-node.ts:64-84.
				{
					title: "EU or Singapore",
					description: "Run your node in the EU or Singapore.",
				},
				// services.md C7, C15.
				{
					title: "Yours to move",
					description:
						"Built on open-source Ryu Core and Gateway, which you can self‑host.",
				},
			],
		},
		faq: [
			{
				q: "How do I get a node?",
				a: "Teams and Business plans include one managed node, and team plans can add more. Choose a plan on the pricing page.",
			},
			{
				q: "Am I locked in?",
				a: "No. Agents run on open-source Ryu Core and Gateway, so you can move them to your own machines. Chat channels need your own bot credentials there.",
			},
		],
		cta: {
			title: "Ready to host your agents?",
			subtitle: "",
			primaryCta: SEE_PLANS,
			secondaryCta: readTheDocs(HOSTED_AGENTS_DOCS),
		},
	},

	{
		slug: "box",
		name: "Ryu Box",
		navLabel: "Box",
		category: "Agent APIs",
		standalone: true,
		status: "early-access",
		tagline: "An isolated workspace for agent runs and previews.",
		Icon: Box,
		hero: {
			eyebrow: "Ryu Box · Early access",
			title: "A workspace for each agent",
			subtitle:
				"Each Box is isolated and can be forked. Files last through stop, resume, and fork for up to 7 days.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: readTheDocs("/docs/standalone/box"),
			visual: <BoxVisual />,
		},
		splits: [
			{
				title: "Choose its network reach",
				description:
					"Each Box runs with no network, an allowlist of up to 64 hosts, or public access through a filter that blocks private addresses.",
				visual: <BoxNetworkVisual />,
			},
		],
		bento: {
			title: "Somewhere safe to work",
			items: [
				{
					title: "Lifecycle API",
					description:
						"Create, run, stop or delete from your backend, or let Ryu Core control it.",
				},
				{
					title: "Files and previews",
					description:
						"Artifacts and preview links stay with the workspace that produced them.",
				},
				{
					title: "Linux sizes",
					description:
						"Small, default, and large sizes, up to 8 vCPU and 16 GiB.",
				},
				// services.md B7; contracts.ts:56-57.
				{
					title: "Secrets per Box",
					description:
						"Up to 32 secrets and 64 environment variables, set per Box.",
				},
			],
		},
		faq: [
			{
				q: "Is Ryu Box a model provider?",
				a: "No. Box is the execution workspace. Core runs the agent, the Gateway applies rules to its model and tool calls, and you choose the model or provider separately.",
			},
			{
				q: "Can I use Box without Ryu Desktop?",
				a: "Yes. Box has its own API, callable from your service or an agent. Hosted access is enabled per organization.",
			},
		],
		cta: {
			title: "Ready to give agents a workspace?",
			subtitle: "",
			primaryCta: EARLY_ACCESS,
			secondaryCta: readTheDocs("/docs/standalone/box"),
		},
	},
];
