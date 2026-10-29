import {
	Blocks,
	Bot,
	Cable,
	Monitor,
	Settings2,
	Terminal as TerminalIcon,
} from "lucide-react";
import { ConsoleWorkflowVisual } from "../../console-workflow-visual.tsx";
import {
	ApprovalCardVisual,
	SdkContractVisual,
} from "../../product-row-visuals.tsx";
import {
	BotHeroVisual,
	CliVisual,
	CommandBarVisual,
	ConnectionsVisual,
	OsVisual,
	SdkVisual,
} from "../../visuals.tsx";
import type { Product } from "../product-types.ts";
import {
	BOOK_DEMO,
	CliResumeVisual,
	ConnectionsScopeVisual,
	DOWNLOAD,
	EARLY_ACCESS,
	RunTraceVisual,
	readTheDocs,
} from "./shared.tsx";

/** Connections, CLI, SDK, Bot, Agent and OS, in catalogue order (see `../products.tsx`). */
export const CONNECTIONS_TO_OS: Product[] = [
	{
		slug: "connections",
		name: "Connections",
		navLabel: "Connections",
		category: "Build",
		tagline: "Link your Gmail, Slack, and other accounts to any Ryu agent.",
		Icon: Cable,
		hero: {
			eyebrow: "Connections",
			title: "Connect the apps your team uses",
			// gateway.md N1, N9; Connect FAQ.
			subtitle:
				"Sign your agents in to Gmail, Slack, and more so they can act there. Building for your customers? Use Ryu Connect.",
			primaryCta: DOWNLOAD,
			secondaryCta: BOOK_DEMO,
			visual: <ConnectionsVisual />,
		},
		splits: [
			{
				title: "Let agents act in your accounts",
				description:
					"Connections give an agent signed-in access to the apps your work runs on, so it can send the email or open the PR, with your approval for risky actions.",
				// gateway.md N5, N9: approvals/policy.rs:81-110.
				visual: <ConnectionsScopeVisual />,
			},
		],
		bento: {
			title: "Access you control",
			items: [
				{
					// gateway.md N9; approvals/policy.rs:81-110.
					title: "Risky actions ask",
					description:
						"Send, post, and merge wait for your approval by default.",
				},
				{
					title: "No raw tokens",
					description:
						"Composio holds the tokens, and agents call actions by name.",
				},
				{
					title: "Scoped actions",
					description:
						"Choose which actions each agent may call; Ryu blocks the rest.",
				},
			],
		},
		faq: [
			{
				q: "How is this different from MCP?",
				a: "MCP is the protocol for tools. Connections add managed sign-in, so agents can act in your accounts.",
			},
			// gateway.md N3, N4.
			{
				q: "Where are my credentials stored?",
				a: "With Composio. Ryu keeps only its Composio API key, and agents call actions by name, never with tokens.",
			},
		],
		cta: {
			title: "Ready to connect your apps?",
			subtitle: "",
			primaryCta: DOWNLOAD,
			secondaryCta: BOOK_DEMO,
		},
	},

	{
		slug: "cli",
		name: "Ryu CLI",
		navLabel: "CLI",
		category: "Build",
		tagline: "The Ryu runtime in your terminal: chat, runs, and servers.",
		Icon: TerminalIcon,
		hero: {
			eyebrow: "Ryu CLI",
			title: "Use Ryu from your terminal",
			subtitle: "Chat, run agents, and manage servers from the command line.",
			primaryCta: readTheDocs("/docs/surfaces/cli/getting-started"),
			secondaryCta: DOWNLOAD,
			visual: <CliVisual />,
		},
		splits: [
			{
				title: "Pick up where you left off",
				description:
					"Resume a conversation from any terminal or from Ryu Desktop; both see the same thread.",
				visual: <CliResumeVisual />,
			},
		],
		bento: {
			title: "Built for the shell",
			items: [
				{
					title: "Headless and scriptable",
					description:
						"Pipe output as JSON, or run it on a server with no screen.",
				},
				{
					title: "Switch servers",
					description:
						"Switch between your saved servers, your org's nodes, and mesh peers.",
				},
				{
					title: "Sign in anywhere",
					description:
						"Run ryu-cli login and confirm the code in your browser.",
				},
			],
		},
		faq: [
			{
				q: "Is the CLI as capable as the desktop?",
				a: "Yes for agent runs: it talks to the same Ryu Core as Desktop, with the same tools, memory, and rules.",
			},
			{
				q: "Does the CLI update itself?",
				a: "Official builds can, when Automatic updates is on. It checks the download and switches on the next launch, never mid-session.",
			},
		],
		cta: {
			title: "Ready to work from the terminal?",
			subtitle: "",
			primaryCta: readTheDocs("/docs/surfaces/cli/getting-started"),
			secondaryCta: DOWNLOAD,
			note: "Install Ryu, then run ryu-cli in any terminal.",
		},
	},

	{
		slug: "sdk",
		name: "Ryu SDK",
		navLabel: "SDK",
		category: "Build",
		tagline: "Define agents, workflows, tools, and skills in code.",
		Icon: Blocks,
		hero: {
			eyebrow: "Ryu SDK",
			title: "Build agents with the Ryu SDK",
			subtitle: "Define agents, workflows, tools, and skills in TypeScript.",
			primaryCta: readTheDocs("/docs/extend/develop/sdk"),
			secondaryCta: DOWNLOAD,
			visual: <SdkVisual />,
		},
		splits: [
			{
				title: "One interface for everything",
				description:
					"Agents, workflows, tools, and skills share one interface, so they fit together. One command packs them into an App you can install.",
				visual: <SdkContractVisual />,
			},
		],
		bento: {
			title: "What the SDK includes",
			items: [
				{
					title: "Gateway-routed models",
					description:
						"Every model call goes through Ryu's Gateway for routing, budgets, and audit.",
				},
				{
					title: "MCP built in",
					description: "Includes an MCP server and client for your tools.",
				},
				{
					title: "Project scaffold",
					description:
						"create-ryu-app sets up a project that matches the App manifest.",
				},
			],
		},
		cta: {
			title: "Ready to build with the SDK?",
			subtitle: "",
			primaryCta: readTheDocs("/docs/extend/develop/sdk"),
			secondaryCta: DOWNLOAD,
		},
	},

	/* ========================== WORKSPACES ========================= */
	{
		slug: "bot",
		name: "Bot",
		navLabel: "Bot",
		category: "Workspaces",
		tagline: "Hand off a task to managed AI, with nothing to set up.",
		Icon: Bot,
		hero: {
			eyebrow: "Bot",
			title: "Get work done with managed AI",
			subtitle: "Hand off a task to managed AI with nothing to set up.",
			primaryCta: DOWNLOAD,
			secondaryCta: BOOK_DEMO,
			visual: <BotHeroVisual />,
		},
		splits: [
			{
				title: "Approve before it acts",
				description:
					"Bot pauses before a task reaches an important app, person, or system, and waits for your approval.",
				visual: (
					<ApprovalCardVisual
						action="Post the summary to #launch"
						app="Slack"
					/>
				),
			},
		],
		bento: {
			title: "Built for handoff",
			items: [
				{
					title: "No setup",
					description:
						"No model or provider to choose. Bot uses your organization's default.",
				},
				{
					title: "One thread",
					description:
						"Keep talking in the same thread, and Bot keeps the task's context.",
				},
				{
					title: "Admin controls",
					description: "Admins set what Bot may reach from Agent.",
				},
			],
		},
		cta: {
			title: "Ready to hand off a task?",
			subtitle: "",
			primaryCta: DOWNLOAD,
			secondaryCta: BOOK_DEMO,
			// workspaces.md B10.
			note: "Download Ryu and sign in with a subscription to use Bot.",
		},
	},

	{
		slug: "agent",
		name: "Agent",
		navLabel: "Agent",
		category: "Workspaces",
		tagline:
			"Run Ryu with the models, tools, permissions, and records you choose.",
		Icon: Settings2,
		hero: {
			eyebrow: "Agent",
			title: "Run your agents your way",
			subtitle:
				"Set the models, tools, and approvals your team uses, and review past runs.",
			primaryCta: DOWNLOAD,
			secondaryCta: BOOK_DEMO,
			visual: <ConsoleWorkflowVisual />,
		},
		splits: [
			{
				title: "Review the steps of a run",
				description:
					"Agent lists every model and tool call in a run, with timing and errors, so you can tune the next run.",
				visual: <RunTraceVisual />,
			},
		],
		bento: {
			title: "Control and audit",
			items: [
				{
					title: "Budgets and cost",
					description: "See each run's cost against your budget.",
				},
				{
					title: "Audit trail",
					description: "Every routed model call is recorded.",
				},
				{
					title: "Admin access",
					description: "On Ryu-managed nodes, only admins can open Agent.",
				},
			],
		},
		faq: [
			{
				q: "Is Agent a separate runtime?",
				a: "No. Agent is a mode of Ryu Desktop, on the same Core and Gateway.",
			},
			{
				q: "Can I use my own model and server?",
				a: "Yes. Agent can operate managed or self‑hosted nodes and can use local, Ryu-managed, or provider models according to your configuration.",
			},
		],
		cta: {
			title: "Ready to operate your agents?",
			subtitle: "",
			primaryCta: DOWNLOAD,
			secondaryCta: BOOK_DEMO,
			note: "Opens inside Ryu Desktop.",
		},
	},

	{
		slug: "os",
		name: "OS",
		navLabel: "OS",
		category: "Workspaces",
		status: "early-access",
		tagline: "A desktop workspace for agents, apps, and windows.",
		Icon: Monitor,
		hero: {
			eyebrow: "OS · Early access",
			title: "Work across your Ryu apps",
			subtitle: "Open apps from the dock and keep each task in its own window.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: BOOK_DEMO,
			visual: <OsVisual />,
		},
		splits: [
			{
				// workspaces.md O2: OsDesktopSurface.tsx:80-95.
				title: "Jump to any app or window",
				description:
					"Press ⌘K (Ctrl+K on Windows and Linux) to open an App or return to an open window.",
				cta: { label: "See Ryu Desktop", href: "/products/desktop" },
				visual: <CommandBarVisual />,
			},
		],
		bento: {
			title: "A desktop for agent work",
			items: [
				{
					title: "Installed Apps",
					description:
						"Apps you install appear in the launcher beside the built-ins.",
				},
				{
					title: "Mission Control",
					description: "See what each chat did and what is still outstanding.",
				},
				{
					title: "Same Ryu underneath",
					description: "Same agents, Core, and permissions as Ryu Desktop.",
				},
			],
		},
		faq: [
			{
				q: "Is OS a separate operating system?",
				a: "No. OS is a workspace mode of Ryu Desktop. It is rolling out to early access users first.",
			},
			{
				q: "What can I open in OS?",
				a: "The dock holds App Launcher, Mission Control, Chat, Spaces, Tools, Skills, Apps, and Review.",
			},
		],
		cta: {
			title: "Ready to try OS?",
			subtitle: "",
			primaryCta: EARLY_ACCESS,
			secondaryCta: BOOK_DEMO,
		},
	},
];
