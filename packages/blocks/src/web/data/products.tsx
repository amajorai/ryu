import { buttonVariants } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import {
	Blocks,
	Bot,
	Box,
	Boxes,
	Bug,
	Cable,
	Chrome,
	Cloud,
	Command,
	Cpu,
	Gem,
	GitBranch,
	Globe,
	HeartHandshake,
	Layers,
	Mic,
	Monitor,
	Plug,
	Puzzle,
	Radio,
	Shield,
	Smartphone,
	Sparkles,
	Store,
	Terminal as TerminalIcon,
	Zap,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import type {
	BentoItem,
	CtaLink,
	FeatureSplit,
	Highlight,
} from "../sections.tsx";
import {
	AgentsAsServiceVisual,
	AgentsVisual,
	ChromeVisual,
	CliVisual,
	CloudVisual,
	CodePaneSplit,
	CommandBarVisual,
	ConnectionsVisual,
	CoreVisual,
	DesktopVisual,
	DevicesVisual,
	ExtensionsVisual,
	GatewayVisual,
	IslandVisual,
	MarketplaceVisual,
	McpVisual,
	MobileVisual,
	RedTeamVisual,
	SdkVisual,
	SkillsVisual,
	WorkflowsVisual,
} from "../visuals.tsx";

/* Shared CTAs ------------------------------------------------------- */

const EARLY_ACCESS: CtaLink = {
	label: "Get Early Access",
	href: "https://j14.notion.site/2940023f0e838023810ce36edf2e3893?pvs=105",
	external: true,
};
const BOOK_DEMO: CtaLink = {
	label: "Book a Demo",
	href: "https://cal.com/jiaweing/ryu-demo",
	external: true,
};
const DOWNLOAD: CtaLink = { label: "Download", href: "/download" };
const SKILLS_GITHUB: CtaLink = {
	label: "Agent skills on GitHub",
	href: "https://github.com/amajorai/ryu/tree/main/apps/skills",
	external: true,
};
const MCP_GITHUB: CtaLink = {
	label: "ryu-mcp on GitHub",
	href: "https://github.com/amajorai/ryu/tree/main/apps/mcp",
	external: true,
};

function githubBentoAction(cta: CtaLink) {
	return (
		<Link
			className={cn(buttonVariants({ variant: "ghost" }), "inline-flex")}
			href={cta.href}
			rel="noopener noreferrer"
			target="_blank"
		>
			{cta.label}
		</Link>
	);
}

export type ProductCategory =
	| "Platform"
	| "Build"
	| "Developers"
	| "Surfaces"
	| "Ecosystem";

export interface Product {
	bento: {
		eyebrow?: string;
		title: string;
		subtitle?: string;
		items: BentoItem[];
	};
	category: ProductCategory;
	cta: {
		title: string;
		subtitle: string;
		primaryCta: CtaLink;
		secondaryCta?: CtaLink;
		note?: string;
	};
	faq?: { q: string; a: string }[];
	hero: {
		eyebrow: string;
		title: string;
		subtitle: string;
		primaryCta: CtaLink;
		secondaryCta?: CtaLink;
		visual: ReactNode;
	};
	highlights?: Highlight[];
	Icon: typeof Cpu;
	name: string;
	navLabel: string;
	overviewVisual?: ReactNode;
	slug: string;
	splits?: FeatureSplit[];
	tagline: string;
}

export const products: Product[] = [
	/* ============================ PLATFORM ========================== */
	{
		slug: "core",
		name: "Ryu Core",
		navLabel: "Core",
		category: "Platform",
		tagline: "The local-first runtime every agent, session, and tool runs on.",
		Icon: Cpu,
		hero: {
			eyebrow: "Ryu Core · open source",
			title: "The runtime under every agent.",
			subtitle:
				"One local binary that runs sessions, memory, tools, workflows, and sub-agents. The platform any agent can run on, headless and encrypted, no cloud required.",
			primaryCta: DOWNLOAD,
			secondaryCta: EARLY_ACCESS,
			visual: <CoreVisual />,
		},
		highlights: [
			{
				title: "Any engine",
				description:
					"Claude Code, Codex, Gemini, Pi, or any OpenAI-compatible runtime, wrapped, never reimplemented.",
			},
			{
				title: "Doesn't start from zero",
				description:
					"Bring your existing Claude and Codex conversations. Your context comes with you.",
			},
			{
				title: "Runs everywhere",
				description:
					"Any model, any provider, any OS. Local on install with llama.cpp and Gemma 4.",
			},
			{
				title: "No telemetry",
				description:
					"Encrypted by default, no telemetry by default. You own the data and the binary.",
			},
		],
		bento: {
			eyebrow: "What runs",
			title: "Orchestration that decides what runs.",
			subtitle:
				"Core owns sessions and execution, then hands every model call to the Gateway. Local-first, headless-first, modular.",
			items: [
				{
					title: "Sessions & memory",
					description:
						"Conversation history, encrypted long-term memory, and Spaces with RAG over sqlite-vec, built in.",
					icon: Boxes,
				},
				{
					title: "Any engine, wrapped",
					description:
						"Spawn any agent runtime and stream it. Swap engines from config, never touch your code.",
					icon: Cpu,
				},
				{
					title: "Tools via MCP",
					description:
						"An MCP registry injects allowlisted tools into agent sessions with Gateway governance on every call.",
					icon: Plug,
				},
				{
					title: "Git-native workspace",
					description:
						"Per-run worktrees, diff capture, and merge or PR apply. Parity with Codex and Cursor agents.",
					icon: GitBranch,
				},
				{
					title: "Sub-agents & workflows",
					description:
						"A workflow DAG and sub-agent delegation, so agents call agents and workflows as steps.",
					icon: Bot,
				},
				{
					title: "Multi-node",
					description:
						"Run it on your laptop, your Pi, a Mac mini, a server. Agents live where they need to work.",
					icon: Globe,
				},
			],
		},
		splits: [
			{
				eyebrow: "Local-first",
				title: "Your machine is the backend.",
				description:
					"Core is a single binary that downloads, verifies, and supervises engines and tools for you. No containers to babysit, no keys to leak, nothing leaves your device unless you say so.",
				bullets: [
					"Installs and health-checks ~16 sidecars with one robust pipeline",
					"Works fully offline with bundled Gemma 4",
					"Every model call still routes through the Gateway",
				],
				visual: <WorkflowsVisual />,
			},
		],
		faq: [
			{
				q: "Is Ryu Core open source?",
				a: "Yes. Core and the Gateway are open-sourced and self-hostable. The desktop, web, and cloud backend are the closed UX and identity layer.",
			},
			{
				q: "Do I need an API key or the cloud to use it?",
				a: "No. Core runs fully local on install with llama.cpp and Gemma 4. Bring your own keys or a subscription only when you want hosted models.",
			},
			{
				q: "Which engines can it run?",
				a: "Claude Code, Codex, Gemini CLI, Pi, ZeroClaw, and any OpenAI-compatible runtime. The engine is a swappable default, never hardcoded.",
			},
		],
		cta: {
			title: "Run the whole stack locally.",
			subtitle:
				"Download Ryu and Core comes with it, the open, self-hostable runtime that orchestrates any engine.",
			primaryCta: DOWNLOAD,
			secondaryCta: BOOK_DEMO,
			note: "Open source · Self-hostable · No telemetry by default",
		},
	},

	{
		slug: "gateway",
		name: "Ryu Gateway",
		navLabel: "Gateway",
		category: "Platform",
		tagline:
			"The moat: firewall, model routing, budgets, evals, and audit on every call.",
		Icon: Shield,
		hero: {
			eyebrow: "Ryu Gateway · the moat",
			title: "A firewall in front of any agent.",
			subtitle:
				"One base-URL swap puts routing, PII and DLP, prompt-injection defense, budgets, evals, and audit in front of agents you already run. This is how you make agents reliable in production.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: BOOK_DEMO,
			visual: <GatewayVisual />,
		},
		highlights: [
			{
				title: "Reliable in production",
				description:
					"Fallback, rate-limit, circuit breaking, and caching so agents survive the real world.",
			},
			{
				title: "Lower AI cost",
				description:
					"Per-agent budgets and exact plus semantic caching cut spend on every call.",
			},
			{
				title: "Per-attribute routing",
				description:
					"An agent's chat, voice, and image calls can each go to a different provider.",
			},
			{
				title: "On the path today",
				description:
					"Already governs the default chat path in Core. Adopt it without rewiring.",
			},
		],
		bento: {
			eyebrow: "What's allowed, shared, measured & paid for",
			title: "The control layer agents are missing.",
			subtitle:
				"Core decides what runs. The Gateway decides what is allowed, shared, measured, and paid for, and governs every model call.",
			items: [
				{
					title: "Security firewall",
					description:
						"Prompt-injection and jailbreak detection on every request, before it reaches a model.",
					icon: Shield,
				},
				{
					title: "PII & DLP",
					description:
						"Redact and block sensitive data on egress, configurable per agent, team, or org.",
					icon: Shield,
				},
				{
					title: "Dynamic routing",
					description:
						"Switch models on the fly with fallback and circuit breaking. No code changes.",
					icon: GitBranch,
				},
				{
					title: "Budgets & cost",
					description:
						"Per-agent budgets, real-time token tracking, semantic cache, and hard ceilings.",
					icon: Zap,
				},
				{
					title: "Evals & audit",
					description:
						"Promptfoo-style evals, prompt versioning, and a full audit trail of every governed call.",
					icon: Sparkles,
				},
				{
					title: "BYOK key vault",
					description:
						"Bring your own keys; the Gateway holds them so agents never see a raw secret.",
					icon: Plug,
				},
			],
		},
		splits: [
			{
				eyebrow: "Drop-in",
				title: "Point any agent at it. Done.",
				description:
					"The Gateway is an OpenAI-compatible proxy. Swap the base URL on an agent you already built and every call is governed, with no SDK changes and no refactor.",
				bullets: [
					"Works with LangChain, Mastra, Claude Code, Codex, or your own loop",
					"Self-hostable and air-gappable, your traffic never leaves your infra",
					"OpenRouter sits upstream as a provider, not your control layer",
				],
				visual: <GatewayVisual />,
			},
		],
		faq: [
			{
				q: "Can I use the Gateway with agents I've already built?",
				a: "Yes. It's an OpenAI-compatible proxy. Point your agent's base URL at your Gateway instance and it works immediately, no SDK changes.",
			},
			{
				q: "Does my data leave my infrastructure?",
				a: "With the Gateway self-hosted, all traffic stays inside your infra. Ryu never stores your prompts or responses on our servers.",
			},
			{
				q: "How does the firewall work?",
				a: "Every routed request passes a prompt-injection filter that detects and blocks common attacks before they reach the model. Sensitivity is configurable per agent or org.",
			},
		],
		cta: {
			title: "Put a firewall in front of your agents.",
			subtitle:
				"Adopt the Gateway as a team, buy it as an enterprise. One config change, total control.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: BOOK_DEMO,
			note: "Open core · Self-hostable · Routing · DLP · Budgets · Audit",
		},
	},

	{
		slug: "cloud",
		name: "Ryu Cloud",
		navLabel: "Cloud",
		category: "Platform",
		tagline: "We build, host, and run your agents. Agents that don't sleep.",
		Icon: Cloud,
		hero: {
			eyebrow: "Ryu Cloud · managed",
			title: "Enterprise agents without enterprise cost.",
			subtitle:
				"We audit, build, deploy, and host agents for your business, and ship them into Telegram, Slack, WhatsApp, and Discord. End-to-end managed infrastructure for AI agents.",
			primaryCta: BOOK_DEMO,
			secondaryCta: EARLY_ACCESS,
			visual: <CloudVisual />,
		},
		highlights: [
			{
				title: "Agents that don't sleep",
				description:
					"24/7 cloud automations keep working even when your devices are off.",
			},
			{
				title: "Out of the box",
				description:
					"Custom-made platform means agents that work for your business on day one.",
			},
			{
				title: "Managed end-to-end",
				description:
					"Deployment, scaling, monitoring, retries, and uptime. You write the agent, we run it.",
			},
			{
				title: "Cross-device fleet",
				description:
					"Run on cloud, a Mac mini, a Pi, or your laptop, with node selection and sync.",
			},
		],
		bento: {
			eyebrow: "We run it for you",
			title: "Your agents, fully operated.",
			subtitle:
				"Open core plus managed cloud. We host the infrastructure and sell customized agents built on the same platform you can self-host.",
			items: [
				{
					title: "Built and audited",
					description:
						"We design the agent, wire the tools, and harden it through the Gateway for you.",
					icon: Cloud,
				},
				{
					title: "Channel bots",
					description:
						"Ship the same agent into Telegram, Slack, WhatsApp, and Discord onto Core sessions.",
					icon: Bot,
				},
				{
					title: "24/7 automations",
					description:
						"Scheduled and event-driven runs that never sleep, with retries and alerting.",
					icon: Zap,
				},
				{
					title: "Multi-node fleet",
					description:
						"Cross-device sync and node selection: prefer a remote node, else compute locally.",
					icon: Globe,
				},
				{
					title: "Starter kits",
					description:
						"Templates and customized agents, vertically tailored to your business.",
					icon: Blocks,
				},
				{
					title: "Governed & private",
					description:
						"Every call still passes the Gateway firewall, budgets, and audit trail.",
					icon: Shield,
				},
			],
		},
		splits: [
			{
				eyebrow: "For businesses",
				title: "We make agents work for your business.",
				description:
					"Most teams can't staff an AI platform team. Ryu Cloud is that team, plus the platform. We build the agent around your workflows and host it so it's reliable from the first day.",
				bullets: [
					"Customized agents built on the open Ryu platform, zero lock-in",
					"SG and SEA SMEs to enterprise, priced below the hours it saves",
					"Bring it in-house anytime, the runtime is open source",
				],
				visual: <AgentsVisual />,
			},
		],
		faq: [
			{
				q: "What does Ryu Cloud actually do?",
				a: "We audit your workflows, build the agents, deploy them, and host them 24/7, including bots in your messaging channels. It's managed infrastructure plus a build service.",
			},
			{
				q: "Am I locked in?",
				a: "No. Everything runs on the open Ryu Core and Gateway. You can self-host the exact same agents whenever you want.",
			},
			{
				q: "Who is it for?",
				a: "Businesses that want production agents without standing up an AI platform team, from SG and SEA SMEs to larger enterprises.",
			},
		],
		cta: {
			title: "Let us run your agents.",
			subtitle:
				"Book a demo and we'll scope, build, and host agents for your business, on infrastructure you could self-host.",
			primaryCta: BOOK_DEMO,
			secondaryCta: EARLY_ACCESS,
			note: "Managed · Customized agents · Channel bots · 24/7",
		},
	},

	{
		slug: "agents-as-a-service",
		name: "Agents as a Service",
		navLabel: "Agents as a Service",
		category: "Platform",
		tagline: "We build your AI agents for you, white-glove, for free.",
		Icon: HeartHandshake,
		hero: {
			eyebrow: "Agents as a Service · white-glove",
			title: "We'll build your agents for you. Free.",
			subtitle:
				"Our business is shipping premade AI agents for businesses. We embed with your team and build them around your workflows, the way Palantir deploys engineers, but at no cost.",
			primaryCta: BOOK_DEMO,
			secondaryCta: EARLY_ACCESS,
			visual: <AgentsAsServiceVisual />,
		},
		highlights: [
			{
				title: "White-glove",
				description:
					"We embed with your team, scope the work, and build the agent for you.",
			},
			{
				title: "Free to build",
				description:
					"No build fee. Forward-deployed help, the Palantir model, without the price tag.",
			},
			{
				title: "Yours to keep",
				description:
					"Built on the open Ryu platform, so you own it and can self-host anytime.",
			},
			{
				title: "Production-ready",
				description:
					"Memory, routing, observability, and security built in from day one.",
			},
		],
		bento: {
			eyebrow: "Our business",
			title: "Premade agents, built around you.",
			subtitle:
				"Most people think our business is the platform. It isn't, the platform is what lets us build and ship customized agents for businesses, fast.",
			items: [
				{
					title: "We scope it",
					description:
						"We learn your workflows and design the agent and tools to fit them.",
					icon: HeartHandshake,
				},
				{
					title: "We build it",
					description:
						"Built on Ryu Core and the Gateway, wired to your apps via Connections.",
					icon: Bot,
				},
				{
					title: "We ship it",
					description:
						"Deployed and hosted on Ryu Cloud, or handed to you to self-host.",
					icon: Cloud,
				},
				{
					title: "Zero lock-in",
					description:
						"It's standard Ryu underneath, no proprietary trap, take it in-house anytime.",
					icon: Shield,
				},
			],
		},
		splits: [
			{
				eyebrow: "Why free",
				title: "The platform is how we build, fast.",
				description:
					"Because every agent runs on the same Ryu core, building a customized one is days, not months. That speed is our edge, so the build is free and the relationship is the business.",
				bullets: [
					"Horizontal platform covers many use cases, not one vertical",
					"Enterprise-grade agents without enterprise cost",
					"From SG and SEA SMEs to larger teams",
				],
				visual: <CloudVisual />,
			},
		],
		faq: [
			{
				q: "Is it really free to build?",
				a: "Yes. We build the agent white-glove at no cost. The platform makes builds fast enough that the ongoing relationship, not a build fee, is the business.",
			},
			{
				q: "Do I own the agent?",
				a: "Yes. It's built on the open Ryu platform, so you can keep it, change it, and self-host it whenever you want. Zero lock-in.",
			},
			{
				q: "Why not specialize in one vertical?",
				a: "Ryu is deliberately horizontal so it covers many use cases. The platform bridges the gap that lets us build customized agents for any business.",
			},
		],
		cta: {
			title: "Tell us what you need. We'll build it.",
			subtitle:
				"Book a demo and we'll scope and build your first AI agent, white-glove, for free.",
			primaryCta: BOOK_DEMO,
			secondaryCta: EARLY_ACCESS,
			note: "White-glove · Free build · Zero lock-in",
		},
	},

	/* ============================= BUILD =========================== */
	{
		slug: "agents",
		name: "Agents",
		navLabel: "Agents",
		category: "Build",
		tagline: "Build your own agent. Every slot swappable, nothing locked in.",
		Icon: Bot,
		hero: {
			eyebrow: "Agents · Pokémon cards",
			title: "Build an agent like a card.",
			subtitle:
				"Independently swappable slots for chat, voice, image, memory, tools, persona, and policy. No two cards alike, none locked in.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: DOWNLOAD,
			visual: <AgentsVisual />,
		},
		highlights: [
			{
				title: "Build your own",
				description:
					"Start from Pi, swap any slot, and ship a card no one else has.",
			},
			{
				title: "LLM council",
				description:
					"@mention several agents into one chat and let them debate to a better answer.",
			},
			{
				title: "Self-improving",
				description:
					"Agents that learn from memory and evals, getting more reliable over time.",
			},
			{
				title: "Zero lock-in",
				description:
					"BYOA, BYOK, BYOS. Every attribute is a swappable default.",
			},
		],
		bento: {
			eyebrow: "BYO everything",
			title: "Swap any slot, lock to nothing.",
			subtitle:
				"Pi ships built-in; 'Ryu' is Pi with the Gateway on top. Every attribute is a swappable default via one registry.",
			items: [
				{
					title: "Swappable models",
					description:
						"Pick a different model for chat, STT, TTS, and image-gen on the same agent.",
					icon: Cpu,
				},
				{
					title: "Tools & MCP",
					description:
						"Attach any MCP server or Runnable. Allowlist per agent, governed by the Gateway.",
					icon: Plug,
				},
				{
					title: "Memory & Spaces",
					description:
						"Give an agent long-term memory and RAG over your Spaces, or none at all.",
					icon: Boxes,
				},
				{
					title: "Persona & policy",
					description:
						"Tune persona, then bind a Gateway policy for routing, budgets, and guardrails.",
					icon: Shield,
				},
				{
					title: "Council chat",
					description:
						"Run multiple agents in one conversation and compare their answers side by side.",
					icon: Bot,
				},
				{
					title: "Versioned & shareable",
					description:
						"Agents are Apps: package them in ryu.json, share them, install them on the fly.",
					icon: Blocks,
				},
			],
		},
		faq: [
			{
				q: "What's the difference between Pi and Ryu?",
				a: "Pi is the built-in agent that works on install. 'Ryu' is Pi with the Gateway on top, the flagship car-around-the-engine demo.",
			},
			{
				q: "Can I change the model an agent uses?",
				a: "Yes, per attribute. Chat, voice, image, and embeddings are each swappable defaults via one registry, never hardcoded.",
			},
			{
				q: "What is council chat?",
				a: "An LLM council: @mention several agents into one conversation so they can collaborate or be compared on the same task.",
			},
		],
		cta: {
			title: "Your agent, your slots.",
			subtitle:
				"Start from Pi, swap what you want, and ship a card no one else has.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: BOOK_DEMO,
			note: "BYOA · BYOK · BYOS · Zero lock-in",
		},
	},

	{
		slug: "workflows",
		name: "Workflows",
		navLabel: "Workflows",
		category: "Build",
		tagline: "Chain agents and tools into durable, visual pipelines.",
		Icon: GitBranch,
		hero: {
			eyebrow: "Workflows",
			title: "Chain agents, no glue code.",
			subtitle:
				"Compose agents, tools, and sub-agents into a DAG. Branch, fan out, and synthesize on a canvas, not in custom orchestration code.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: DOWNLOAD,
			visual: <WorkflowsVisual />,
		},
		highlights: [
			{
				title: "Visual canvas",
				description:
					"Drag nodes, draw edges, branch on output. The canvas is the orchestration.",
			},
			{
				title: "Durable by design",
				description:
					"Restate-backed steps with retries and human-in-the-loop checkpoints.",
			},
			{
				title: "Runnable steps",
				description:
					"Every step is an agent, tool, skill, or another workflow.",
			},
			{
				title: "Governed throughout",
				description:
					"Every model call inside a workflow still routes through the Gateway.",
			},
		],
		bento: {
			eyebrow: "Runnables as steps",
			title: "Orchestration you can see.",
			subtitle:
				"Every step is a Runnable: an agent, tool, skill, or another workflow. Peers, not a strict hierarchy.",
			items: [
				{
					title: "Visual DAG",
					description:
						"Drag nodes, draw edges, branch on output. The canvas is the orchestration.",
					icon: GitBranch,
				},
				{
					title: "Sub-agent delegation",
					description:
						"Fan a task out to specialist agents, then merge their results in one step.",
					icon: Bot,
				},
				{
					title: "Durable execution",
					description:
						"Restate-backed steps with retries and human-in-the-loop checkpoints.",
					icon: Cpu,
				},
				{
					title: "Triggers & schedules",
					description:
						"Kick off from a message, a webhook, or a cron. Runs persist and resume.",
					icon: Sparkles,
				},
				{
					title: "Governed throughout",
					description:
						"Every model call inside a workflow still routes through the Gateway.",
					icon: Shield,
				},
				{
					title: "Reusable everywhere",
					description:
						"Expose a workflow as a named tool so an agent can invoke it like any other.",
					icon: Plug,
				},
			],
		},
		faq: [
			{
				q: "Do I need to write orchestration code?",
				a: "No. You compose Runnables on a canvas. The DAG is the orchestration, and any workflow can be exposed back to an agent as a tool.",
			},
			{
				q: "Are workflows durable?",
				a: "Durable execution is on the roadmap via a Restate sidecar, with retries and human-in-the-loop checkpoints. The workflow DAG and sub-agent delegation ship today.",
			},
		],
		cta: {
			title: "Build the pipeline once.",
			subtitle:
				"Wire agents and tools into a workflow, then run it on demand, on a schedule, or as a tool.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: BOOK_DEMO,
			note: "Visual canvas · Durable steps · Gateway-governed",
		},
	},

	{
		slug: "skills",
		name: "Skills",
		navLabel: "Skills",
		category: "Build",
		tagline: "Browse and install Agent Skills from skills.sh in one click.",
		Icon: Sparkles,
		hero: {
			eyebrow: "Skills · open standard",
			title: "Give agents new skills, instantly.",
			subtitle:
				"Inside Ryu: search skills.sh and install in one click. Outside: ship SKILL.md files that teach Cursor, Claude Code, and any SKILL.md client how to set up and drive your node.",
			primaryCta: { label: "Browse Skills", href: "/products/marketplace" },
			secondaryCta: SKILLS_GITHUB,
			visual: <SkillsVisual />,
		},
		highlights: [
			{
				title: "Open standard",
				description:
					"Ryu speaks the Agent Skills standard natively, no proprietary format.",
			},
			{
				title: "One-click install",
				description:
					"Install writes SKILL.md locally and hot-reloads, no restart.",
			},
			{
				title: "Trigger-aware",
				description:
					"Front-matter is parsed so the right skill fires at the right time.",
			},
			{
				title: "Provenance tracked",
				description:
					"See what's installed, where it came from, and update on drift.",
			},
		],
		bento: {
			eyebrow: "Two directions",
			title: "Skills in the app, and skills for the app.",
			subtitle:
				"Install Agent Skills into Ryu from skills.sh, or publish SKILL.md instructions that teach external coding agents how to operate a Ryu node.",
			items: [
				{
					title: "Browse skills.sh",
					description:
						"Search the public directory with a featured default, right inside Ryu.",
					icon: Store,
				},
				{
					title: "One-click install",
					description:
						"Install writes SKILL.md locally and hot-reloads the registry, no restart.",
					icon: Sparkles,
				},
				{
					title: "Front-matter aware",
					description:
						"Descriptions and triggers are parsed so the right skill fires at the right time.",
					icon: Blocks,
				},
				{
					title: "Provenance tracked",
					description:
						"See what's installed, where it came from, and update when it drifts.",
					icon: GitBranch,
				},
				{
					title: "External agent skills",
					description:
						"apps/skills ships SKILL.md packages that teach Cursor, Claude Code, and other clients setup, MCP driving, and agent building.",
					icon: TerminalIcon,
					action: githubBentoAction(SKILLS_GITHUB),
					span: "md:col-span-2",
				},
			],
		},
		splits: [
			{
				eyebrow: "Inside Ryu",
				title: "Browse and install in one click.",
				description:
					"Search skills.sh from the desktop app, install Agent Skills into your local registry, and hot-reload without a restart.",
				bullets: [
					"skills.sh directory with featured defaults",
					"SKILL.md written locally with provenance tracked",
					"Front-matter triggers fire the right skill at the right time",
				],
				visual: <SkillsVisual />,
			},
			{
				eyebrow: "From Cursor & Claude Code",
				title: "Teach your coding agent to drive Ryu.",
				description:
					"apps/skills is a separate bundle of external skills—not installed into Ryu's registry. They are instructions an outside agent loads to set up a node and drive it through ryu-mcp.",
				bullets: [
					"setup-ryu walks end-to-end install and MCP wiring",
					"ryu-mcp, ryu-build-agent, and ryu-local-model cover day-two ops",
					"ryu-author-skill keeps the ecosystem self-extending",
				],
				cta: SKILLS_GITHUB,
				flip: true,
				visual: <CodePaneSplit />,
			},
		],
		faq: [
			{
				q: "Where do skills come from?",
				a: "Inside Ryu, from the public skills.sh directory—the same anonymous endpoints the official CLI uses. Installed skills live in your local skill registry.",
			},
			{
				q: "Do I have to restart after installing?",
				a: "No. Install writes the SKILL.md and hot-reloads the registry so the skill is available immediately.",
			},
			{
				q: "How do I use Ryu from Cursor or Claude Code?",
				a: "Point your agent at apps/skills in the Ryu repo—external SKILL.md files that teach setup, MCP driving, and agent building. They pair with the ryu-mcp server in apps/mcp.",
			},
		],
		cta: {
			title: "Level up your agents.",
			subtitle:
				"Install skills inside Ryu, or ship SKILL.md files that teach external agents how to drive your node.",
			primaryCta: { label: "Browse Skills", href: "/products/marketplace" },
			secondaryCta: SKILLS_GITHUB,
			note: "skills.sh in-app · apps/skills outward · Hot-reload",
		},
	},

	{
		slug: "mcp",
		name: "MCP",
		navLabel: "MCP",
		category: "Build",
		tagline: "250+ tools wired in. Give your agents superpowers.",
		Icon: Plug,
		hero: {
			eyebrow: "MCP · Model Context Protocol",
			title: "Every tool, zero wiring.",
			subtitle:
				"Inside Ryu: a 250+ tool registry bridged into agent sessions with Gateway governance. Outside: ryu-mcp exposes your Core node to Claude Desktop, Cursor, and any MCP host.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: MCP_GITHUB,
			visual: <McpVisual />,
		},
		highlights: [
			{
				title: "250+ tools",
				description:
					"A registry of ready tools, available to any agent instantly.",
			},
			{
				title: "Zero wiring",
				description:
					"No SDK, no glue, no manual auth. Turn it on and the agent can use it.",
			},
			{
				title: "Built-in servers",
				description:
					"Ghost desktop automation and Shadow capture ship in the registry.",
			},
			{
				title: "Governed calls",
				description:
					"Every tool call passes the same firewall, budgets, and audit as model calls.",
			},
		],
		bento: {
			eyebrow: "Two directions",
			title: "Tools in the app, and Ryu as a tool.",
			subtitle:
				"Wire MCP servers into Ryu agent sessions, or expose a running Core node to external MCP hosts through ryu-mcp.",
			items: [
				{
					title: "250+ tool registry",
					description:
						"GitHub, Slack, Postgres, browser, email, calendars, instantly available.",
					icon: Plug,
				},
				{
					title: "Bridged into sessions",
					description:
						"The MCP bridge injects allowlisted tools into agent loops with full governance.",
					icon: Bot,
				},
				{
					title: "Built-in servers",
					description:
						"Ghost desktop automation and Shadow capture plus search ship in the registry.",
					icon: Boxes,
				},
				{
					title: "Bring your own",
					description:
						"Add any MCP server via ryu.json with scoped permissions and a Gateway policy.",
					icon: Blocks,
				},
				{
					title: "Governed calls",
					description:
						"Every tool call passes the same firewall, budgets, and audit as model calls.",
					icon: Shield,
				},
				{
					title: "ryu-mcp server",
					description:
						"apps/mcp exposes a running Core node to Claude Desktop, Cursor, and other MCP hosts—with OAuth sign-in and 20+ tools.",
					icon: TerminalIcon,
					action: githubBentoAction(MCP_GITHUB),
					span: "md:col-span-2",
				},
			],
		},
		splits: [
			{
				eyebrow: "Inside Ryu",
				title: "A registry, bridged into every session.",
				description:
					"Ryu ships a 250+ MCP tool registry. The bridge injects allowlisted tools into agent loops, and every call is governed by the Gateway.",
				bullets: [
					"Ghost, Shadow, and community servers in one catalog",
					"Per-agent allowlists with firewall and audit on every call",
					"ACP-native tool loop closed end to end",
				],
				visual: <McpVisual />,
			},
			{
				eyebrow: "From Claude Desktop & Cursor",
				title: "Let outside agents drive your node.",
				description:
					"apps/mcp is an MCP server that points any host at a running Core node—agents, models, skills, workflows, and registered MCP tools over stdio JSON-RPC.",
				bullets: [
					"OAuth device grant shares sign-in with desktop and CLI",
					"ryu_ask, ryu_list_agents, ryu_call_mcp_tool, and 17 more tools",
					"Pairs with apps/skills for setup and day-two operations",
				],
				cta: MCP_GITHUB,
				flip: true,
				visual: <CodePaneSplit />,
			},
		],
		faq: [
			{
				q: "What is MCP?",
				a: "The Model Context Protocol, an open standard for connecting AI models to external tools and data. Ryu ships a 250+ tool registry that speaks it.",
			},
			{
				q: "How do tools reach my agent?",
				a: "The MCP bridge injects allowlisted tools into agent sessions, and every call is governed by the Gateway just like model calls.",
			},
			{
				q: "How do I connect Ryu to Claude Desktop or Cursor?",
				a: "Add apps/mcp to your host's MCP config. It exposes your Core node over stdio—health, agents, models, skills, workflows, and bridged MCP tools. See the README in apps/mcp for the exact JSON snippet.",
			},
		],
		cta: {
			title: "Plug your agents into everything.",
			subtitle:
				"Turn on tools inside Ryu, or expose your node to any MCP host with ryu-mcp.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: MCP_GITHUB,
			note: "In-app registry · apps/mcp outward · Gateway-governed",
		},
	},

	{
		slug: "connections",
		name: "Connections",
		navLabel: "Connections",
		category: "Build",
		tagline: "Connect your apps through Composio. Works everywhere.",
		Icon: Cable,
		hero: {
			eyebrow: "Connections · Composio",
			title: "Connect every app your agent needs.",
			subtitle:
				"Authenticate Gmail, Slack, Notion, GitHub, Stripe, and hundreds more through Composio. One consent, and your agents can act, governed on every call.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: DOWNLOAD,
			visual: <ConnectionsVisual />,
		},
		highlights: [
			{
				title: "Hundreds of apps",
				description:
					"Composio-powered connections to the SaaS your work already lives in.",
			},
			{
				title: "Managed auth",
				description:
					"OAuth handled for you. Tokens stay in the vault, agents never see secrets.",
			},
			{
				title: "Superpowers",
				description:
					"Read, write, and act across apps, not just chat about them.",
			},
			{
				title: "Works everywhere",
				description: "Any integration, on any agent, governed by the Gateway.",
			},
		],
		bento: {
			eyebrow: "Powered by Composio",
			title: "Real actions, not just answers.",
			subtitle:
				"The paradigm is shifting from apps for humans to tools for agents. Connections give your agents authenticated access to act in the real world.",
			items: [
				{
					title: "Composio catalog",
					description:
						"Hundreds of managed integrations available through one connection flow.",
					icon: Cable,
				},
				{
					title: "Managed OAuth",
					description:
						"Connect once; the Gateway holds the tokens so agents never touch a raw secret.",
					icon: Shield,
				},
				{
					title: "Act, don't just chat",
					description:
						"Send the email, open the PR, update the row. Agents take real actions.",
					icon: Zap,
				},
				{
					title: "Scoped & audited",
					description:
						"Grant per-connection scopes; every action is logged in the audit trail.",
					icon: GitBranch,
				},
			],
		},
		splits: [
			{
				eyebrow: "Tools for agents",
				title: "Built for the agentic internet.",
				description:
					"Instead of building another app for humans to click, expose what your product does as actions an agent can take for its user. Connections make that reach instant.",
				bullets: [
					"Any provider, any integration, works everywhere",
					"Per-connection scopes enforced by the Gateway",
					"The same tools across desktop, CLI, cloud, and bots",
				],
				visual: <McpVisual />,
			},
		],
		faq: [
			{
				q: "How is this different from MCP?",
				a: "MCP is the protocol and registry for tools. Connections add managed authentication via Composio so agents can act in your real SaaS accounts, with the Gateway holding the credentials.",
			},
			{
				q: "Where are my credentials stored?",
				a: "In the Gateway's key vault. Agents request actions; they never see the raw tokens, and every action is audited.",
			},
		],
		cta: {
			title: "Give your agents real reach.",
			subtitle:
				"Connect the apps your work runs on and let your agents act, safely.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: BOOK_DEMO,
			note: "Composio · Managed auth · Gateway-governed",
		},
	},

	/* =========================== DEVELOPERS ======================== */
	{
		slug: "cli",
		name: "CLI",
		navLabel: "CLI",
		category: "Developers",
		tagline: "The full runtime in your terminal: chat, runs, and nodes.",
		Icon: TerminalIcon,
		hero: {
			eyebrow: "Ryu CLI",
			title: "Ryu, in your terminal.",
			subtitle:
				"A fast TUI for chat, sidecar management, sessions, and LAN node discovery. The same Core path the desktop uses, from the command line.",
			primaryCta: DOWNLOAD,
			secondaryCta: EARLY_ACCESS,
			visual: <CliVisual />,
		},
		highlights: [
			{
				title: "Core-native",
				description:
					"Real agent runs through Core: tools, memory, and Gateway routing.",
			},
			{
				title: "Headless-first",
				description: "Script it, pipe it, run it on a server with no UI.",
			},
			{
				title: "Node discovery",
				description:
					"Finds Ryu nodes on your LAN and lets you pick where compute runs.",
			},
			{
				title: "Sessions persist",
				description: "Resume conversations and runs; history lives in Core.",
			},
		],
		bento: {
			eyebrow: "Headless-first",
			title: "Built for people who live in a shell.",
			subtitle:
				"Routes to Core for real agent runs, manages sidecars, and finds nodes on your network automatically.",
			items: [
				{
					title: "Chat & runs",
					description:
						"Talk to agents and launch runs that route through Core, tools, memory, and all.",
					icon: TerminalIcon,
				},
				{
					title: "Sidecar management",
					description:
						"Install, start, stop, and health-check engines and tools without leaving the TUI.",
					icon: Cpu,
				},
				{
					title: "Node discovery",
					description:
						"Auto-discover Ryu nodes on your LAN and pick where compute runs.",
					icon: Globe,
				},
				{
					title: "Sessions",
					description:
						"Resume conversations and runs; history persists in Core just like the app.",
					icon: GitBranch,
				},
			],
		},
		faq: [
			{
				q: "Is the CLI as capable as the desktop?",
				a: "For agent runs, yes. It routes to the same Core backend, so you get real tool loops, memory, and Gateway governance from the terminal.",
			},
		],
		cta: {
			title: "Drive Ryu from the command line.",
			subtitle: "Install the CLI and get the full runtime, no window required.",
			primaryCta: DOWNLOAD,
			secondaryCta: BOOK_DEMO,
			note: "TUI · Core-native · LAN node discovery",
		},
	},

	{
		slug: "sdk",
		name: "SDK",
		navLabel: "SDK",
		category: "Developers",
		tagline: "Runnable-native, gateway-mandatory. Build your own agents.",
		Icon: Blocks,
		hero: {
			eyebrow: "Ryu SDK",
			title: "Define agents in a few lines.",
			subtitle:
				"defineAgent, defineWorkflow, defineTool, defineSkill. Ryu's own Runnable-native SDK where every model call routes through the Gateway.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: { label: "create-ryu-app", href: "/products/extensions" },
			visual: <SdkVisual />,
		},
		highlights: [
			{
				title: "One contract",
				description:
					"Agent, workflow, tool, skill, and MCP server, all Runnables.",
			},
			{
				title: "Gateway-mandatory",
				description:
					"The model client always routes through the Gateway. Governance isn't optional.",
			},
			{
				title: "Depend on nothing",
				description:
					"References Mastra and AI SDK patterns, depends on neither.",
			},
			{
				title: "Pack & ship",
				description:
					"Bundle Runnables into an installable App with one command.",
			},
		],
		bento: {
			eyebrow: "One contract",
			title: "Everything is a Runnable.",
			subtitle:
				"Agent, Workflow, Tool, Skill, MCP-server: one input, run, output contract. Reference Mastra and AI SDK; depend on neither.",
			items: [
				{
					title: "Runnable factories",
					description:
						"defineAgent, defineWorkflow, defineTool, defineSkill, composable peers.",
					icon: Blocks,
					visual: <CodePaneSplit />,
					span: "md:col-span-2 md:row-span-2",
				},
				{
					title: "Gateway-mandatory",
					description:
						"The model client always routes through the Gateway. Governance isn't optional.",
					icon: Shield,
				},
				{
					title: "MCP built in",
					description:
						"First-class MCP server and client for tools and bridges.",
					icon: Plug,
				},
				{
					title: "ryu pack",
					description:
						"Bundle Runnables and ryu.json into an installable App with one command.",
					icon: Boxes,
				},
				{
					title: "Scaffolder",
					description:
						"create-ryu-app spins up a starter project validated against the manifest schema.",
					icon: TerminalIcon,
				},
			],
		},
		faq: [
			{
				q: "Why not just use Mastra or the AI SDK?",
				a: "Ryu's SDK is Runnable-native and gateway-mandatory by design. It references those patterns but depends on none, so you build your own agents without inheriting someone else's lock-in.",
			},
			{
				q: "What is a Runnable?",
				a: "The single contract unifying agents, workflows, tools, skills, and MCP servers: input, run, output. They compose as peers.",
			},
		],
		cta: {
			title: "Build on the orchestration layer.",
			subtitle:
				"Write Runnables, pack them as Apps, and ship them to the marketplace.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: BOOK_DEMO,
			note: "Runnable-native · Gateway-mandatory · MCP + ACP",
		},
	},

	/* =========================== SURFACES ========================== */
	{
		slug: "desktop",
		name: "Desktop App",
		navLabel: "Desktop App",
		category: "Surfaces",
		tagline: "The easiest way to get started with agents that don't sleep.",
		Icon: Monitor,
		hero: {
			eyebrow: "Ryu App · desktop",
			title: "Pick an agent, go.",
			subtitle:
				"The flagship app. Chat, councils, runs, models, spaces, and the Gateway, in one clean window. No terminal, no API keys, no MCP wiring.",
			primaryCta: DOWNLOAD,
			secondaryCta: EARLY_ACCESS,
			visual: <DesktopVisual />,
		},
		highlights: [
			{
				title: "As easy as an app",
				description:
					"Download, pick an agent, go. The hard problem Ryu solves is the UX.",
			},
			{
				title: "Doesn't start from zero",
				description:
					"Bring your existing Claude and Codex conversations with you.",
			},
			{
				title: "Git-native runs",
				description:
					"Active folder, branch, per-run worktree, diff, review, and apply.",
			},
			{
				title: "Everywhere you work",
				description:
					"Run it on your laptop, Mac mini, or server; agents live where they're needed.",
			},
		],
		bento: {
			eyebrow: "The primary surface",
			title: "Everything, one window.",
			subtitle:
				"The app is the product: making agents as easy as installing software is the hard problem, and it's treated as the product, not an afterthought.",
			items: [
				{
					title: "Chat & council",
					description:
						"Talk to one agent or @mention several into an LLM council in the same thread.",
					icon: Bot,
				},
				{
					title: "Runs & worktrees",
					description:
						"Launch background and parallel runs with per-run git worktrees and diffs.",
					icon: GitBranch,
				},
				{
					title: "Models & skills",
					description:
						"Browse and install GGUF models and Agent Skills from inside the app.",
					icon: Cpu,
				},
				{
					title: "Spaces & memory",
					description:
						"Organize knowledge into Spaces with RAG, and long-term memory per agent.",
					icon: Boxes,
				},
				{
					title: "Gateway built in",
					description:
						"Routing, firewall, budgets, and audit are one window away.",
					icon: Shield,
				},
				{
					title: "Command palette",
					description:
						"A clean, non-overwhelming IA with Cmd+K to jump anywhere.",
					icon: Zap,
				},
			],
		},
		splits: [
			{
				eyebrow: "Parity first",
				title: "Codex and Cursor parity, then more.",
				description:
					"Active working folder, git branch, per-run worktree, diff, review, and apply, plus a runs list and a clean information architecture. Table stakes done right, then the app store and companion on top.",
				bullets: [
					"Per-run worktrees keep parallel runs isolated",
					"Review the diff, then merge or open a PR",
					"App store, context companion, and sandboxes on the roadmap",
				],
				visual: <CoreVisual />,
			},
		],
		faq: [
			{
				q: "Do I need to know the terminal?",
				a: "No. The desktop app is the point: download it, pick an agent, and go. No API keys or MCP wiring required.",
			},
			{
				q: "Can I keep my existing agent history?",
				a: "Yes. Ryu can pick up your existing Claude and Codex conversations so your agent doesn't start from zero.",
			},
		],
		cta: {
			title: "The easiest way to start with agents.",
			subtitle:
				"Download the desktop app, pick an agent, and ship, no setup required.",
			primaryCta: DOWNLOAD,
			secondaryCta: BOOK_DEMO,
			note: "Desktop · Git-native · Gateway built in",
		},
	},

	{
		slug: "command-bar",
		name: "Command Bar",
		navLabel: "Command Bar",
		category: "Surfaces",
		tagline: "Quick access to your agents from anywhere on your desktop.",
		Icon: Command,
		hero: {
			eyebrow: "Command Bar",
			title: "Your agent, one shortcut away.",
			subtitle:
				"A Raycast-style command bar that calls your agents from anywhere on your desktop. Ask, run, and resume without switching apps, by keyboard or by voice.",
			primaryCta: DOWNLOAD,
			secondaryCta: EARLY_ACCESS,
			visual: <CommandBarVisual />,
		},
		highlights: [
			{
				title: "From anywhere",
				description: "A global hotkey opens Ryu over whatever you're doing.",
			},
			{
				title: "Ask or run",
				description: "Ask a question, launch an agent, or resume a run inline.",
			},
			{
				title: "Voice input",
				description: "Speak instead of type; speech to text, then an answer.",
			},
			{
				title: "Core-native",
				description: "Same agents, memory, and tools as the desktop app.",
			},
		],
		bento: {
			eyebrow: "Quick access",
			title: "AI at the speed of a keystroke.",
			subtitle:
				"The command bar puts your agents one shortcut away, so the fastest path to an answer is never leaving what you're doing.",
			items: [
				{
					title: "Global hotkey",
					description:
						"Summon Ryu over any app with a keystroke, ask, and dismiss.",
					icon: Command,
				},
				{
					title: "Ask, run, resume",
					description:
						"Ask a question, kick off an agent, or jump back into a run from one bar.",
					icon: Zap,
				},
				{
					title: "Voice input",
					description:
						"Talk to it: speech to text turns your words into an answer.",
					icon: Mic,
				},
				{
					title: "Core-native",
					description:
						"Routes through Core, so it's the same agents, memory, and tools.",
					icon: Boxes,
				},
			],
		},
		faq: [
			{
				q: "How is this different from the Island?",
				a: "The command bar is a you-initiated quick launcher, summoned by hotkey. Island is proactive, it watches context and suggests on its own. They share the same Core agents.",
			},
		],
		cta: {
			title: "Call your agent from anywhere.",
			subtitle:
				"Download Ryu and summon your agents with a keystroke or your voice.",
			primaryCta: DOWNLOAD,
			secondaryCta: BOOK_DEMO,
			note: "Global hotkey · Voice input · Core-native",
		},
	},

	{
		slug: "island",
		name: "Island",
		navLabel: "Island",
		category: "Surfaces",
		tagline: "The always-aware companion that suggests before you ask.",
		Icon: Radio,
		hero: {
			eyebrow: "Ryu Island · context companion",
			title: "The background agent that helps.",
			subtitle:
				"A dynamic-island overlay that watches your context and proactively suggests the next move, behind a per-capability consent gate. The world's first background agent that actually helps.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: DOWNLOAD,
			visual: <IslandVisual />,
		},
		highlights: [
			{
				title: "Always aware",
				description:
					"Reads your screen context locally and notices when you're stuck.",
			},
			{
				title: "Proactive",
				description: "Suggests the next step before you think to ask for it.",
			},
			{
				title: "Consent-gated",
				description:
					"Every capability is opt-in. Nothing runs without your say-so.",
			},
			{
				title: "Local-first",
				description:
					"Context monitoring and suggestions run on-device through Shadow.",
			},
		],
		bento: {
			eyebrow: "Proactive, not reactive",
			title: "Context that works for you.",
			subtitle:
				"Island pairs on-device screen context with a local model to suggest, and a mini chat onto Core when you want to act.",
			items: [
				{
					title: "Shadow context",
					description:
						"On-device capture and semantic memory feed the companion what's on screen.",
					icon: Radio,
				},
				{
					title: "Proactive suggestions",
					description:
						"A local model surfaces the next action as a chip when it can help.",
					icon: Sparkles,
				},
				{
					title: "Mini chat onto Core",
					description:
						"Tap to open a quick chat that routes to the same Core agents and tools.",
					icon: Bot,
				},
				{
					title: "Voice input",
					description:
						"Talk to it: speech to text turns your words into an answer, hands-free.",
					icon: Mic,
				},
				{
					title: "Consent gate",
					description:
						"Per-capability grants; the overlay only sees what you allow.",
					icon: Shield,
				},
				{
					title: "Morphing overlay",
					description:
						"A frameless, click-through island that expands only when there's something useful.",
					icon: Layers,
				},
				{
					title: "DLP on egress",
					description:
						"Anything that leaves your device passes the Gateway's data-loss prevention.",
					icon: Globe,
				},
			],
		},
		faq: [
			{
				q: "Does Island watch everything I do?",
				a: "Only what you allow. It's gated per capability and context monitoring runs on-device through Shadow; nothing leaves without passing the Gateway's DLP.",
			},
			{
				q: "What can it actually do?",
				a: "It notices your context, suggests the next step as a chip, and opens a mini chat onto your Core agents when you want to act on a suggestion.",
			},
		],
		cta: {
			title: "Let an agent watch your back.",
			subtitle:
				"Join early access for the always-aware companion that suggests before you ask.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: BOOK_DEMO,
			note: "On-device · Consent-gated · Proactive",
		},
	},

	{
		slug: "mobile",
		name: "Mobile App",
		navLabel: "Mobile App",
		category: "Surfaces",
		tagline: "Ryu in your pocket: on-device, with node selection.",
		Icon: Smartphone,
		hero: {
			eyebrow: "Ryu Mobile",
			title: "Your agent, in your pocket.",
			subtitle:
				"Chat with your agents on the go. On-device inference with Cactus Compute, or reach a node at home for heavier work.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: BOOK_DEMO,
			visual: <MobileVisual />,
		},
		highlights: [
			{
				title: "On-device",
				description:
					"Run small models locally with Cactus Compute, private and offline-capable.",
			},
			{
				title: "Node selection",
				description:
					"Reach a home or cloud node for heavy runs, else compute locally.",
			},
			{
				title: "Synced",
				description: "Conversations and runs sync across devices through Core.",
			},
			{
				title: "Governed",
				description:
					"Cloud calls from mobile still pass the firewall, budgets, and audit.",
			},
		],
		bento: {
			eyebrow: "Local-first, on mobile",
			title: "Private by default, wherever you are.",
			subtitle:
				"The mobile app brings agents to iOS and Android while keeping data on your device when you want it.",
			items: [
				{
					title: "On-device inference",
					description:
						"Run small models locally with Cactus Compute, private and offline-capable.",
					icon: Smartphone,
				},
				{
					title: "Node selection",
					description:
						"Prefer a reachable home or cloud node for heavy runs, else compute locally.",
					icon: Globe,
				},
				{
					title: "Same sessions",
					description:
						"Conversations and runs sync across devices through Core.",
					icon: GitBranch,
				},
				{
					title: "Gateway-governed",
					description:
						"Cloud calls from mobile still pass the firewall, budgets, and audit.",
					icon: Shield,
				},
			],
		},
		faq: [
			{
				q: "Does it work offline?",
				a: "Yes, for on-device models via Cactus Compute. For heavier work it can reach a node at home or in the cloud, your choice.",
			},
		],
		cta: {
			title: "Take Ryu with you.",
			subtitle:
				"Join early access for the mobile app and bring your agents everywhere.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: BOOK_DEMO,
			note: "iOS · Android · On-device · Node selection",
		},
	},

	{
		slug: "chrome-extension",
		name: "Chrome Extension",
		navLabel: "Chrome Extension",
		category: "Surfaces",
		tagline: "A context companion in your browser, with DLP on egress.",
		Icon: Chrome,
		hero: {
			eyebrow: "Chrome Extension",
			title: "An agent that sees your tab.",
			subtitle:
				"A side-panel companion that reads the page you're on, runs quick actions, and chats, with the Gateway's DLP guarding everything that leaves.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: DOWNLOAD,
			visual: <ChromeVisual />,
		},
		highlights: [
			{
				title: "Page-aware",
				description:
					"Summarize, extract, and ask about the tab you're viewing.",
			},
			{
				title: "Quick actions",
				description: "One-tap chips for the things you do most.",
			},
			{
				title: "DLP on egress",
				description:
					"The Gateway redacts and blocks sensitive data before anything is sent.",
			},
			{
				title: "Core-native",
				description:
					"Runs route through Core: same agents, memory, and tools as the desktop.",
			},
		],
		bento: {
			eyebrow: "Context companion",
			title: "Your browser, with an agent in it.",
			subtitle:
				"The extension reaches Core for real agent runs and the Gateway for governance, context where you already work.",
			items: [
				{
					title: "Page-aware",
					description:
						"Summarize, extract, and ask about the tab you're viewing.",
					icon: Chrome,
				},
				{
					title: "Quick actions",
					description:
						"One-tap chips for the things you do most, right in the side panel.",
					icon: Sparkles,
				},
				{
					title: "DLP on egress",
					description:
						"The Gateway redacts and blocks sensitive data before anything is sent.",
					icon: Shield,
				},
				{
					title: "Core-native",
					description:
						"Runs route through Core, same agents, memory, and tools as the desktop.",
					icon: Boxes,
				},
			],
		},
		faq: [
			{
				q: "Can it read pages behind a login?",
				a: "It reads the tab you're on, and the Gateway's DLP redacts and blocks sensitive data on egress so nothing leaks.",
			},
		],
		cta: {
			title: "Put an agent in your browser.",
			subtitle:
				"Join early access for the Chrome extension and the in-browser companion.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: BOOK_DEMO,
			note: "Side panel · Page-aware · Gateway DLP",
		},
	},

	{
		slug: "devices",
		name: "Devices",
		navLabel: "Devices",
		category: "Surfaces",
		tagline: "Always-aware, on-device AI in physical form. Coming soon.",
		Icon: Gem,
		hero: {
			eyebrow: "Ryu Devices · coming soon",
			title: "Always-aware AI you can wear.",
			subtitle:
				"Rings, pendants, and ambient devices with on-device context and local AI. The companion off your screen and into the world. Coming soon.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: BOOK_DEMO,
			visual: <DevicesVisual />,
		},
		highlights: [
			{
				title: "On-device AI",
				description: "Local inference for privacy, no screen required.",
			},
			{
				title: "Always aware",
				description: "Ambient context that understands your moment.",
			},
			{
				title: "Wearable",
				description: "Rings and pendants designed to disappear into your day.",
			},
			{
				title: "Ryu inside",
				description: "The same agents and memory, now ambient.",
			},
		],
		bento: {
			eyebrow: "Off the screen",
			title: "Ambient agents, in the world.",
			subtitle:
				"A new surface for the always-aware companion: physical devices that bring local AI and context with you everywhere.",
			items: [
				{
					title: "Local AI",
					description:
						"On-device models keep your context private and responsive.",
					icon: Cpu,
				},
				{
					title: "Always-aware context",
					description:
						"Ambient sensing that understands what you're doing without a screen.",
					icon: Radio,
				},
				{
					title: "Wearable form",
					description:
						"Rings, pendants, and more, designed to be invisible until needed.",
					icon: Gem,
				},
				{
					title: "Ryu inside",
					description:
						"Backed by the same Core agents, memory, and Gateway governance.",
					icon: Shield,
				},
			],
		},
		faq: [
			{
				q: "When are devices available?",
				a: "Devices are coming soon. Join early access to hear first and help shape what we build.",
			},
		],
		cta: {
			title: "Be first to wear Ryu.",
			subtitle:
				"Join early access for always-aware, on-device AI in physical form.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: BOOK_DEMO,
			note: "Rings · Pendants · Local AI · Coming soon",
		},
	},

	/* =========================== ECOSYSTEM ========================= */
	{
		slug: "marketplace",
		name: "Customize",
		navLabel: "Customize",
		category: "Ecosystem",
		tagline: "An app store for AI agents. Install agents, tools, and skills.",
		Icon: Box,
		hero: {
			eyebrow: "Customize",
			title: "We made an app store for AI agents.",
			subtitle:
				"Browse a catalog of agents, tools, and skills. Install with permission grants, enable on the fly, no terminal, no API keys, no wiring.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: DOWNLOAD,
			visual: <MarketplaceVisual />,
		},
		highlights: [
			{
				title: "Apps, not config",
				description:
					"Every listing is a ryu.json App bundling Runnables and a surface.",
			},
			{
				title: "One-click install",
				description:
					"Install and enable with clear permission grants. Disable just as fast.",
			},
			{
				title: "Built-in apps",
				description:
					"agentbrowser, spider, Ghost, Shadow, and promptfoo ship ready.",
			},
			{
				title: "Grants enforced",
				description:
					"Each app declares what it can reach; the Gateway enforces it.",
			},
		],
		bento: {
			eyebrow: "Apps, not config",
			title: "The store for the agent era.",
			subtitle:
				"Every listing is an App: a ryu.json manifest bundling Runnables and an optional companion surface.",
			items: [
				{
					title: "One-click install",
					description:
						"Install and enable apps with clear permission grants. Disable just as fast.",
					icon: Store,
				},
				{
					title: "Built-in apps",
					description:
						"agentbrowser, spider, Ghost, Shadow, promptfoo, and security packs ship ready.",
					icon: Boxes,
				},
				{
					title: "Permission grants",
					description:
						"Each app declares what it can reach; the Gateway enforces it.",
					icon: Shield,
				},
				{
					title: "Seeded catalog",
					description:
						"A curated catalog of agents, tools, and skills, growing with the community.",
					icon: Sparkles,
				},
			],
		},
		faq: [
			{
				q: "What's in an app?",
				a: "An app is a ryu.json manifest bundling Runnables, an optional companion surface, and the permissions it needs, validated and installed with grants.",
			},
		],
		cta: {
			title: "Find your next agent.",
			subtitle: "Browse the catalog and install your first app in a click.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: BOOK_DEMO,
			note: "Apps · ryu.json · Permission grants",
		},
	},

	{
		slug: "extensions",
		name: "Extensions",
		navLabel: "Extensions",
		category: "Ecosystem",
		tagline: "Extend every layer with the plugin runtime in OSS Core.",
		Icon: Puzzle,
		hero: {
			eyebrow: "Extensions · plugins",
			title: "Extensible at every level.",
			subtitle:
				"Ryu sits above every provider and harness, and the plugin runtime lives in open-source Core, so the app stays extensible the way VS Code and Codex are.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: { label: "Read the SDK", href: "/products/sdk" },
			visual: <ExtensionsVisual />,
		},
		highlights: [
			{
				title: "Manifest-driven",
				description:
					"Declare runnables, permissions, and a Gateway policy in ryu.json.",
			},
			{
				title: "Full lifecycle",
				description:
					"Install, enable, disable, and update with grant validation.",
			},
			{
				title: "Open runtime",
				description:
					"The plugin runtime is open source, so the closed app stays extensible.",
			},
			{
				title: "Third-party",
				description: "Build and publish plugins via the SDK.",
			},
		],
		bento: {
			eyebrow: "ryu.json",
			title: "One manifest, any Runnable.",
			subtitle:
				"Apps are declared in ryu.json: validated per kind, installed with grants, enabled on the fly.",
			items: [
				{
					title: "Manifest-driven",
					description:
						"Declare runnables, permissions, and a Gateway policy in ryu.json.",
					icon: Puzzle,
				},
				{
					title: "Lifecycle",
					description:
						"Install, enable, disable, and update, with grant validation at each step.",
					icon: GitBranch,
				},
				{
					title: "Third-party plugins",
					description:
						"Build and publish plugins via the SDK; the runtime is open source.",
					icon: Blocks,
				},
				{
					title: "Companion surfaces",
					description:
						"An app can ship a companion UI surface alongside its Runnables.",
					icon: Boxes,
				},
			],
		},
		faq: [
			{
				q: "Can third parties build extensions?",
				a: "Yes. The plugin runtime lives in open-source Core, and you build extensions with the Ryu SDK, packaged as ryu.json Apps.",
			},
		],
		cta: {
			title: "Extend Ryu your way.",
			subtitle:
				"Package Runnables into an App with a manifest and ship it to anyone.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: BOOK_DEMO,
			note: "ryu.json · Open plugin runtime · Grants",
		},
	},

	{
		slug: "red-team",
		name: "Red Teaming",
		navLabel: "Red Teaming",
		category: "Ecosystem",
		tagline: "Hack AI agents to test how good their agents really are.",
		Icon: Bug,
		hero: {
			eyebrow: "Red Teaming · service + product",
			title: "Hacking as a service, for agents.",
			subtitle:
				"We attack your AI agents the way an adversary would, prompt injection, data exfiltration, tool abuse, jailbreaks, so you find the holes before anyone else does.",
			primaryCta: BOOK_DEMO,
			secondaryCta: EARLY_ACCESS,
			visual: <RedTeamVisual />,
		},
		highlights: [
			{
				title: "Adversarial probes",
				description:
					"Hundreds of attacks across the OWASP LLM and agentic threat models.",
			},
			{
				title: "Find holes first",
				description: "See how your agent fails before an attacker shows you.",
			},
			{
				title: "Service + product",
				description: "Run it as a managed engagement or as a self-serve tool.",
			},
			{
				title: "Closes the loop",
				description:
					"Findings feed Gateway guardrails for self-improving defense.",
			},
		],
		bento: {
			eyebrow: "Offense informs defense",
			title: "Test your agents like an attacker.",
			subtitle:
				"Red teaming pairs with the Gateway firewall: we find the weaknesses, the Gateway closes them.",
			items: [
				{
					title: "Prompt injection",
					description:
						"Direct, indirect, and encoded injection probes against your agent and tools.",
					icon: Bug,
				},
				{
					title: "Data exfiltration",
					description:
						"Attempts to leak secrets, system prompts, and private context.",
					icon: Shield,
				},
				{
					title: "Tool abuse",
					description:
						"Coerce the agent into misusing its tools and connections.",
					icon: Plug,
				},
				{
					title: "Jailbreaks",
					description:
						"Best-of-N and multi-turn jailbreak attempts, scored and reported.",
					icon: Zap,
				},
				{
					title: "Scored report",
					description:
						"A prioritized findings report mapped to OWASP LLM and agentic risks.",
					icon: GitBranch,
				},
				{
					title: "Feeds the firewall",
					description:
						"Confirmed findings become Gateway guardrails, so defense improves itself.",
					icon: Sparkles,
				},
			],
		},
		splits: [
			{
				eyebrow: "Self-improving AI",
				title: "Every attack makes you stronger.",
				description:
					"Red teaming isn't a one-off audit. Findings flow into the Gateway as guardrails and evals, so each engagement hardens your agents against the next attack automatically.",
				bullets: [
					"Mapped to OWASP LLM Top 10 and agentic threat models",
					"Managed engagement or self-serve tooling",
					"Results wire directly into Gateway firewall and evals",
				],
				visual: <GatewayVisual />,
			},
		],
		faq: [
			{
				q: "Is this a service or a product?",
				a: "Both. We run managed red-team engagements, and the same probes are available as self-serve tooling so you can test continuously.",
			},
			{
				q: "What happens with the findings?",
				a: "You get a prioritized report mapped to OWASP LLM and agentic risks, and confirmed findings can be turned into Gateway guardrails so your defense improves itself.",
			},
		],
		cta: {
			title: "Break your agents before they do.",
			subtitle:
				"Book a red-team engagement and find the holes before an attacker does.",
			primaryCta: BOOK_DEMO,
			secondaryCta: EARLY_ACCESS,
			note: "Adversarial testing · OWASP-mapped · Feeds the firewall",
		},
	},
];

export const productMap: Record<string, Product> = Object.fromEntries(
	products.map((p) => [p.slug, p])
);

export function getProduct(slug: string): Product | undefined {
	return productMap[slug];
}

export const productCategories: ProductCategory[] = [
	"Platform",
	"Build",
	"Developers",
	"Surfaces",
	"Ecosystem",
];

export function productsByCategory(category: ProductCategory): Product[] {
	return products.filter((p) => p.category === category);
}
