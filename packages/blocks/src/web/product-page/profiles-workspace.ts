import type { StageProductSlug } from "../backgrounds/stage-routes.ts";
import type {
	ProductArchetypeId,
	ProductAvailabilityRow,
	ProductProfile,
} from "./profile-types.ts";
import { CHROME_PROFILE } from "./profiles-workspace-chrome.ts";

/**
 * Product profiles for Bot, Agent, Desktop, OS and Chrome extension
 * (unit workspace). Every entry is grounded: each item names its source, and
 * ./profile-grounding.ts checks the file and quote exist. Prices are computed
 * from `PUBLISHED_PRICING`, never typed by hand. What a page needs:
 * `ARCHETYPE_REQUIREMENTS` in ./archetypes.ts and `profileGaps` in ./profiles.ts.
 *
 * Each availability matrix answers "where does it run" in that product's own
 * terms: Bot by app and device, Agent by the node it opens on, Desktop by
 * operating system, OS by its rollout per desktop, and Ryu for Chrome (in
 * ./profiles-workspace-chrome.ts) by the places it appears in the browser. A platform is listed only where a source
 * names it; Firefox and Edge are left out because no store listing exists.
 */
export const ARCHETYPE = "workspace" satisfies ProductArchetypeId;

export const PROFILE_SLUGS = [
	"bot",
	"agent",
	"desktop",
	"os",
	"chrome-extension",
] as const satisfies readonly StageProductSlug[];

export type ProfileSlug = (typeof PROFILE_SLUGS)[number];

const DOCS = "apps/fumadocs/content/docs";
const BOT_DOC = `${DOCS}/surfaces/desktop/bot.mdx`;
const AGENT_DOC = `${DOCS}/surfaces/desktop/agent.mdx`;
const OS_DOC = `${DOCS}/surfaces/desktop/ryu-os.mdx`;
const DESKTOP_DOC = `${DOCS}/surfaces/desktop/index.mdx`;
const INSTALL_DOC = `${DOCS}/learn/academy/essentials/install-and-setup.mdx`;
const WEBAPP_DOC = `${DOCS}/surfaces/webapp.mdx`;
const MOBILE_BOT_DOC = `${DOCS}/mobile/bot.mdx`;
const DOWNLOAD_PAGE = "apps/web/src/app/download/page-client.tsx";
const WORKSPACE_CATALOG =
	"packages/blocks/src/web/data/catalog/connections-os.tsx";
const DESKTOP_CATALOG =
	"packages/blocks/src/web/data/catalog/desktop-devices.tsx";

/** The interface comparison row that keeps Gateway settings in Agent. */
const GATEWAY_SETTINGS_ROW = {
	path: AGENT_DOC,
	quote: "Not available; switch to Agent",
} as const;

/** The OS command bar shortcut, which names each desktop OS. */
const OS_SHORTCUT = {
	path: WORKSPACE_CATALOG,
	quote:
		"Press ⌘K (Ctrl+K on Windows and Linux) to open an App or return to an open window.",
} as const;

const BOT_AVAILABILITY: readonly ProductAvailabilityRow[] = [
	{
		platform: "Ryu Desktop",
		state: "available",
		note: "New installs open in Bot. Switch to Agent or OS from the Ryu lockup.",
		source: {
			path: AGENT_DOC,
			quote: "The Desktop app opens new users in **Bot**.",
		},
	},
	{
		platform: "Ryu Bot app",
		state: "available",
		note: "Published beside each stable Ryu release. Its updates install Ryu Bot only, on the stable and beta channels.",
		source: {
			path: BOT_DOC,
			quote:
				"Ryu Bot is also published as a standalone app (**Ryu Bot**) alongside each stable Ryu release.",
		},
	},
	{
		platform: "Phone, tablet, watch, TV and car",
		state: "planned",
		note: "Native Ryu Bot apps reach each device once its App Store or Google Play build is listed.",
		source: {
			path: MOBILE_BOT_DOC,
			quote: "Availability on each platform depends on its store release.",
		},
	},
];

const BOT_PROFILE: ProductProfile = {
	facts: [
		{
			label: "To start",
			value: "Sign in with a Ryu account and an active subscription",
			source: {
				path: BOT_DOC,
				quote:
					"Sign in with a Ryu account, keep an active subscription, and start a conversation.",
			},
		},
		{
			label: "Model",
			value: "Ryu-managed routing, with no provider key or model picker",
			source: {
				path: BOT_DOC,
				quote:
					"Ryu-managed model routing, with no provider key or model picker to configure.",
			},
		},
		{
			label: "Default route",
			value: "Auto cloud, until an owner or admin sets the Bot realm default",
			source: {
				path: BOT_DOC,
				quote: "If no custom value is saved, Bot uses **Auto cloud**",
			},
		},
		{
			label: "Approvals",
			value: "Approve or deny pending actions from the Bot pulse card",
			source: {
				path: BOT_DOC,
				quote:
					"lets you approve or deny them through the existing Core and Gateway approval path.",
			},
		},
	],
	availability: BOT_AVAILABILITY,
	compareSlugs: ["chatgpt", "poke"],
	related: [
		{ label: "Ryu 101", href: "/guides/ryu-101", kind: "guide" },
		{
			label: "Recipes to start from",
			href: "/guides/ryu-recipes",
			kind: "guide",
		},
		{
			label: "How cross-device sync works",
			href: "/help/how-cross-device-sync-works",
			kind: "help",
		},
	],
	docs: [
		{
			label: "Bot",
			path: "/docs/surfaces/desktop/bot",
			description: "Sign-in, the Bot pulse card, and admin defaults.",
		},
		{
			label: "Ryu Bot apps",
			path: "/docs/mobile/bot",
			description: "Phone, tablet, watch, TV, and car.",
		},
		{
			label: "Interfaces",
			path: "/docs/surfaces/desktop/interfaces",
			description: "Switch between Bot, Agent, and OS.",
		},
	],
};

const AGENT_PROFILE: ProductProfile = {
	facts: [
		{
			label: "Who can open it",
			value:
				"On a Ryu-managed node, members whose role grants Gateway configuration",
			source: {
				path: AGENT_DOC,
				quote:
					"only organization members whose role grants Gateway configuration",
			},
		},
		{
			label: "Runtime",
			value:
				"The same Core, Gateway, sandbox and device-access runtime as Bot and OS",
			source: {
				path: AGENT_DOC,
				quote:
					"All three realms run on the same Core, Gateway, Pi, sandbox, and device-access runtime.",
			},
		},
		{
			label: "Run review",
			value: "Every model and tool call in a run, with timing and errors",
			source: {
				path: WORKSPACE_CATALOG,
				quote:
					"Agent lists every model and tool call in a run, with timing and errors",
			},
		},
		{
			label: "Gateway settings",
			value: "Only in Agent; Bot and OS do not show them",
			source: GATEWAY_SETTINGS_ROW,
		},
		{
			label: "On startup",
			value: "Open in the last realm used, or always in Bot, Agent or OS",
			source: {
				path: AGENT_DOC,
				quote:
					"**Bot**, **Agent**, or **OS** always open that realm when the Desktop app starts.",
			},
		},
	],
	availability: [
		{
			platform: "Ryu Desktop",
			state: "available",
			note: "Agent is a mode of Ryu Desktop, not a separate runtime.",
			source: {
				path: WORKSPACE_CATALOG,
				quote: "Agent is a mode of Ryu Desktop, on the same Core and Gateway.",
			},
		},
		{
			platform: "Ryu-managed node",
			state: "available",
			note: "Owners and admins by default. Members without that role stay in Bot.",
			source: {
				path: AGENT_DOC,
				quote: "A user without access to Agent is kept in Bot",
			},
		},
		{
			platform: "Self-hosted or local node",
			state: "available",
			note: "Opens directly in Agent. Core still checks the credential you connected with.",
			source: { path: AGENT_DOC, quote: "these nodes open directly in Agent" },
		},
	],
	compareSlugs: ["braintrust", "copilot-studio"],
	related: [
		{
			label: "Managing a team of agents",
			href: "/guides/managing-a-team-of-agents",
			kind: "guide",
		},
		{
			label: "How to set per-agent budgets",
			href: "/blog/how-to-set-per-agent-budgets",
			kind: "blog",
		},
		{
			label: "How to set up an AI agent audit trail",
			href: "/blog/how-to-set-up-ai-agent-audit-trail",
			kind: "blog",
		},
	],
	docs: [
		{
			label: "Agent",
			path: "/docs/surfaces/desktop/agent",
			description: "Who can open it and how the realms compare.",
		},
		{
			label: "Observability",
			path: "/docs/surfaces/desktop/observability",
			description: "Run traces and their export settings.",
		},
		{
			label: "Interfaces",
			path: "/docs/surfaces/desktop/interfaces",
			description: "Every interface in the desktop switcher.",
		},
	],
};

const DESKTOP_PROFILE: ProductProfile = {
	facts: [
		{
			label: "Bundles",
			value: "Ryu Core, the local backend, so there is nothing else to install",
			source: {
				path: INSTALL_DOC,
				quote:
					"The desktop app bundles **Ryu Core**, the local backend, so you do not install anything separately.",
			},
		},
		{
			label: "First run",
			value: "Onboarding sets up a complete local stack in the background",
			source: {
				path: INSTALL_DOC,
				quote: "Onboarding installs a complete local stack in the background",
			},
		},
		{
			label: "Realms",
			value: "Bot, Agent and OS, all showing the same conversations",
			source: {
				path: DESKTOP_DOC,
				quote: "All three show the same conversations.",
			},
		},
		{
			label: "Models",
			value: "Local models, your own keys, or a Ryu plan",
			source: {
				path: DESKTOP_CATALOG,
				quote: "Use local models, your own keys, or a Ryu plan.",
			},
		},
		{
			label: "Command palette",
			value: "Cmd/Ctrl-K, to search or compose",
			source: {
				path: DESKTOP_DOC,
				quote: "Press `Cmd/Ctrl-K` to open the command palette.",
			},
		},
	],
	availability: [
		{
			platform: "macOS",
			state: "available",
			note: "Apple silicon and Intel.",
			source: { path: DOWNLOAD_PAGE, quote: "macOS (Apple silicon and Intel)" },
		},
		{
			platform: "Windows",
			state: "available",
			note: "Windows 10 or 11, 64-bit.",
			source: { path: DOWNLOAD_PAGE, quote: "Windows 10 or 11 (64-bit)" },
		},
		{
			platform: "Linux",
			state: "available",
			note: "x64 as .deb, .rpm, or AppImage.",
			source: {
				path: DOWNLOAD_PAGE,
				quote: "Linux (x64 .deb, .rpm, and AppImage)",
			},
		},
		{
			platform: "Web browser",
			state: "early-access",
			note: "The browser app reuses the Desktop shell. Hosted access needs an account that has cleared the waitlist.",
			source: {
				path: WEBAPP_DOC,
				quote:
					"The hosted workspace requires a Ryu account that has cleared the waitlist",
			},
		},
	],
	compareSlugs: ["lm-studio", "jan", "open-webui"],
	related: [
		{ label: "Ryu 101", href: "/guides/ryu-101", kind: "guide" },
		{
			label: "Running coding agents side by side",
			href: "/guides/running-coding-agents-side-by-side",
			kind: "guide",
		},
		{
			label: "How to run Claude Code and Codex side by side",
			href: "/blog/how-to-run-claude-code-and-codex-side-by-side",
			kind: "blog",
		},
		{
			label: "How cross-device sync works",
			href: "/help/how-cross-device-sync-works",
			kind: "help",
		},
	],
	docs: [
		{
			label: "Desktop app",
			path: "/docs/surfaces/desktop",
			description: "Realms, the user guide, and privacy controls.",
		},
		{
			label: "Install Ryu",
			path: "/docs/start-here/getting-started/install",
			description: "Install the app, or run it from source.",
		},
		{
			label: "Models",
			path: "/docs/surfaces/desktop/models",
			description: "Local models, provider keys, and defaults.",
		},
	],
};

const OS_PROFILE: ProductProfile = {
	facts: [
		{
			label: "What it is",
			value: "A view inside Ryu Desktop, not a second runtime",
			source: { path: OS_DOC, quote: "OS is a view, not a second runtime." },
		},
		{
			label: "Rollout",
			value: "Off by default, and turned on per account",
			source: {
				path: AGENT_DOC,
				quote: "OS is off by default and rolls out per account.",
			},
		},
		{
			label: "Dock",
			value:
				"App Launcher, Mission Control, Chat, Spaces, Tools, Skills, Apps and Review",
			source: {
				path: WORKSPACE_CATALOG,
				quote:
					"The dock holds App Launcher, Mission Control, Chat, Spaces, Tools, Skills, Apps, and Review.",
			},
		},
		{
			label: "Shared with Agent",
			value: "Core sessions, Gateway policies, permissions and tab state",
			source: {
				path: OS_DOC,
				quote:
					"It uses the same Core sessions, Gateway policies, permissions, and tab state",
			},
		},
		{
			label: "Gateway settings",
			value: "Switch to Agent to change them",
			source: GATEWAY_SETTINGS_ROW,
		},
	],
	availability: [
		{
			platform: "Ryu Desktop on macOS",
			state: "early-access",
			note: "Press ⌘K to open an App or return to an open window.",
			source: OS_SHORTCUT,
		},
		{
			platform: "Ryu Desktop on Windows and Linux",
			state: "early-access",
			note: "Press Ctrl+K to open an App or return to an open window.",
			source: OS_SHORTCUT,
		},
	],
	compareSlugs: ["zo-computer", "genspark"],
	related: [
		{
			label: "Ryu Interfaces: 69 ways to see your agents",
			href: "/blog/ryu-interfaces",
			kind: "blog",
		},
	],
	docs: [
		{
			label: "OS",
			path: "/docs/surfaces/desktop/ryu-os",
			description: "The dock, windows, and App Launcher.",
		},
		{
			label: "Interfaces",
			path: "/docs/surfaces/desktop/interfaces",
			description: "Availability and how to switch.",
		},
		{
			label: "Agent",
			path: "/docs/surfaces/desktop/agent",
			description: "How Bot, Agent, and OS compare.",
		},
	],
};

export const PROFILES: Partial<Record<ProfileSlug, ProductProfile>> = {
	bot: BOT_PROFILE,
	agent: AGENT_PROFILE,
	desktop: DESKTOP_PROFILE,
	os: OS_PROFILE,
	"chrome-extension": CHROME_PROFILE,
};
