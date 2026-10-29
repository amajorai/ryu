import { Bot, Cpu, GitBranch, Plug, Share2, Sparkles } from "lucide-react";
import { ProductFigure } from "../../product-figure.tsx";
import {
	CouncilVisual,
	McpHostConfigVisual,
} from "../../product-row-visuals.tsx";
import {
	AgentsVisual,
	ComputeExchangeVisual,
	McpVisual,
	SkillsVisual,
} from "../../visuals.tsx";
import type { Product } from "../product-types.ts";
import {
	BOOK_DEMO,
	CodingAgentSkillsVisual,
	ComputeReceiptVisual,
	DOWNLOAD,
	EARLY_ACCESS,
	readTheDocs,
	SharePackageVisual,
	SKILLS_GITHUB,
	WorkflowResumeVisual,
} from "./shared.tsx";

/** Compute, Share, Agents, Workflows, Skills and MCP, in catalogue order (see `../products.tsx`). */
export const COMPUTE_TO_MCP: Product[] = [
	{
		slug: "compute",
		name: "Ryu Compute",
		navLabel: "Compute",
		category: "Agent APIs",
		status: "coming-soon",
		tagline: "Rent compute for a bounded run.",
		Icon: Cpu,
		hero: {
			eyebrow: "Ryu Compute · Coming soon",
			title: "Borrow the compute you need",
			// ComputeShareSurface.tsx:44-55.
			subtitle: "Planned: rent CPU or GPU capacity for one job.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: BOOK_DEMO,
			visual: <ComputeExchangeVisual mode="compute" />,
		},
		// The desktop preview's lease contract: ComputeShareSurface.tsx:75-93.
		splits: [
			{
				title: "A fresh workspace per job",
				description:
					"Each lease is planned to run in a fresh workspace with no login to the host, and to end with a receipt for its duration and cost.",
				visual: <ComputeReceiptVisual />,
			},
		],
		// ComputeShareSurface.tsx:51-55, 75-93, 488-490.
		bento: {
			title: "How a lease is planned",
			items: [
				{
					title: "Short leases",
					description: "Planned: 15 minutes, 1 hour, or 4 hours per job.",
				},
				{
					title: "Private host",
					description:
						"Planned: inputs and outputs cross the job boundary; host files stay put.",
				},
				{
					title: "Output to you",
					description: "Planned: job output returns only to the lease owner.",
				},
			],
		},
		cta: {
			title: "Ready to borrow compute?",
			subtitle: "",
			primaryCta: EARLY_ACCESS,
			secondaryCta: BOOK_DEMO,
		},
	},

	{
		slug: "share",
		name: "Ryu Share",
		navLabel: "Share",
		category: "Agent APIs",
		status: "coming-soon",
		tagline: "Share idle capacity without giving up your machine.",
		Icon: Share2,
		hero: {
			eyebrow: "Ryu Share · Coming soon",
			title: "Share your idle computer",
			// ComputeShareSurface.tsx:66-67; services.md H4.
			subtitle: "Planned: rent out your computer's spare CPU or GPU capacity.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: BOOK_DEMO,
			visual: <ComputeExchangeVisual mode="share" />,
		},
		// ComputeShareSurface.tsx:399, 488-490; services.md H3.
		splits: [
			{
				title: "What runs on your machine",
				description:
					"Designed so only approved jobs or signed agent packages run, and your node token and files stay on your computer.",
				visual: <SharePackageVisual />,
			},
		],
		// ComputeShareSurface.tsx:63-67, 411-445; services.md H4.
		bento: {
			title: "You stay in control",
			items: [
				{
					title: "Your schedule",
					description:
						"Planned: offer your computer only during hours you publish.",
				},
				{
					title: "Idle only",
					description: "Planned: accept jobs only when your computer is idle.",
				},
				{
					title: "Paid by usage",
					description: "Planned: payouts follow verified usage.",
				},
			],
		},
		cta: {
			title: "Ready to share idle capacity?",
			subtitle: "",
			primaryCta: EARLY_ACCESS,
			secondaryCta: BOOK_DEMO,
		},
	},

	/* ============================= BUILD =========================== */
	{
		slug: "agents",
		name: "Agents",
		navLabel: "Agents",
		category: "Build",
		tagline: "Build your own agent. Every part swappable, nothing locked in.",
		Icon: Bot,
		hero: {
			eyebrow: "Agents",
			title: "Build an agent for your workflow",
			subtitle:
				"Choose the models, tools, memory, and instructions your agent uses. Change any part later.",
			primaryCta: DOWNLOAD,
			secondaryCta: BOOK_DEMO,
			visual: <AgentsVisual />,
		},
		splits: [
			{
				title: "Ask several agents at once",
				description:
					"@mention several agents into one chat and each one replies in the thread.",
				visual: <CouncilVisual />,
			},
		],
		bento: {
			title: "What an agent includes",
			items: [
				{
					// core.md G2, G8.
					title: "One model per job",
					description:
						"Set separate chat, voice, and image models on one agent.",
				},
				{
					title: "Prompt versions kept",
					description:
						"Earlier versions of an agent's instructions are saved with it.",
				},
				{
					title: "Share as an App",
					description:
						"Package an agent as an App, share it, and install it anywhere.",
				},
			],
		},
		cta: {
			title: "Ready to build your agent?",
			subtitle: "",
			primaryCta: DOWNLOAD,
			secondaryCta: BOOK_DEMO,
		},
	},

	{
		slug: "workflows",
		name: "Workflows",
		navLabel: "Workflows",
		category: "Build",
		tagline: "Chain agents and tools into workflows you can see and resume.",
		Icon: GitBranch,
		hero: {
			eyebrow: "Workflows",
			title: "Build agent workflows",
			subtitle: "Connect agents, tools, and skills on a visual canvas.",
			primaryCta: DOWNLOAD,
			secondaryCta: BOOK_DEMO,
			visual: <ProductFigure figure="workflow-run" />,
		},
		// core.md W9: workflow/mod.rs:23-27, 507-530; store.rs:82-96.
		splits: [
			{
				title: "Runs survive restarts",
				description:
					"Each finished step is saved, so a run can retry, wait for approval, and resume.",
				visual: <WorkflowResumeVisual />,
			},
		],
		bento: {
			title: "What a workflow can do",
			items: [
				{
					title: "Sub-agent delegation",
					description:
						"Fan a task out to specialist agents, then merge their results in one step.",
				},
				{
					title: "Any step",
					description:
						"Each step is an agent, tool, skill, or another workflow.",
				},
				{
					title: "Triggers and schedules",
					description:
						"Start manually, on a schedule, from a webhook, or from an app event.",
				},
			],
		},
		cta: {
			title: "Ready to build a workflow?",
			subtitle: "",
			primaryCta: DOWNLOAD,
			secondaryCta: BOOK_DEMO,
		},
	},

	{
		slug: "skills",
		name: "Skills",
		navLabel: "Skills",
		category: "Build",
		tagline: "Browse and install Agent Skills in one click.",
		Icon: Sparkles,
		hero: {
			eyebrow: "Skills",
			title: "Add skills to your agents",
			subtitle:
				"Search skills.sh and install open-standard Agent Skills into your agents in one click.",
			primaryCta: DOWNLOAD,
			secondaryCta: BOOK_DEMO,
			visual: <SkillsVisual />,
		},
		splits: [
			{
				title: "Use Ryu from your coding agent",
				description:
					"A separate set of Agent Skills teaches Cursor, Claude Code, and other agents to set up a Ryu server and control it over MCP.",
				bullets: [
					"Build agents and run local models",
					"Write new skills of your own",
				],
				cta: SKILLS_GITHUB,
				visual: <CodingAgentSkillsVisual />,
			},
		],
		bento: {
			title: "Skills inside Ryu",
			items: [
				{
					// gateway.md S2: skills_catalog/mod.rs:8-11.
					title: "Shared skills folder",
					description:
						"Installs go to the standard Agent Skills folder other agents read.",
				},
				{
					title: "Ready instantly",
					description:
						"Installed skills are saved locally and available right away. No restart.",
				},
				{
					title: "Loads on demand",
					description:
						"Each skill's description loads up front; full instructions load only when needed.",
				},
				{
					title: "Track every source",
					description:
						"See what's installed and where it came from, and update it when the source changes.",
				},
			],
		},
		cta: {
			title: "Ready to add a skill?",
			subtitle: "",
			primaryCta: DOWNLOAD,
			secondaryCta: BOOK_DEMO,
		},
	},

	{
		slug: "mcp",
		name: "MCP",
		navLabel: "MCP",
		category: "Build",
		tagline: "Connect agents to configured MCP tools and services.",
		Icon: Plug,
		hero: {
			eyebrow: "MCP",
			title: "Connect agents and tools through MCP",
			subtitle:
				"Add any MCP server, then choose which agents may use its tools.",
			primaryCta: DOWNLOAD,
			secondaryCta: readTheDocs("/docs/extend/mcp/quickstart"),
			visual: <McpVisual />,
		},
		splits: [
			{
				title: "Use Ryu from any MCP host",
				description:
					"The ryu-mcp server points Claude Desktop, Cursor, and other MCP hosts at your running Ryu server: agents, models, skills, workflows, and tools.",
				visual: <McpHostConfigVisual />,
			},
		],
		bento: {
			title: "Tools inside Ryu",
			items: [
				{
					title: "One agent, one link",
					description: "Point an MCP app straight at a single Ryu agent.",
				},
				{
					title: "Built-in servers",
					description: "Desktop automation and screen capture come built in.",
				},
				{
					title: "Approval rules",
					description:
						"Risky tool calls wait for your approval before they run.",
				},
			],
		},
		faq: [
			{
				q: "What is MCP?",
				a: "The Model Context Protocol, an open standard for connecting AI models to external tools and data. Ryu agents can use the MCP servers you add.",
			},
			{
				q: "Does ryu-mcp need its own sign-in?",
				// gateway.md M7: apps/mcp/README.md "Authentication".
				a: "Yes, once. Run ryu-mcp login with the same Ryu account you use in Ryu Desktop and the CLI; ryu-mcp keeps its own session.",
			},
		],
		cta: {
			title: "Ready to plug in your tools?",
			subtitle: "",
			primaryCta: DOWNLOAD,
			secondaryCta: readTheDocs("/docs/extend/mcp/quickstart"),
		},
	},
];
