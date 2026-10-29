import type { ProductExplainer } from "./explainer-types.ts";

/** Build products: what you assemble agents, workflows, and apps from. */
export const BUILD_EXPLAINERS: Record<string, ProductExplainer> = {
	agents: {
		statement:
			"An agent in Ryu is yours to assemble. Choose its models, tools, memory, and instructions, change any part later, and package it as an App to share and install anywhere.",
		steps: [
			{
				title: "Pick the models",
				description: "Set separate chat, voice, and image models on one agent.",
			},
			{
				title: "Add tools and instructions",
				description:
					"Choose its tools, memory, and instructions. Earlier prompt versions are kept.",
			},
			{
				title: "Use or share it",
				description:
					"@mention it in a chat beside other agents, or package it as an App.",
			},
		],
		worksWith: ["workflows", "skills", "mcp", "marketplace"],
	},
	workflows: {
		statement:
			"Workflows chain agents, tools, skills, and other workflows on a visual canvas. Each finished step is saved, so a run can retry, wait for approval, and resume after a restart.",
		steps: [
			{
				title: "Add steps",
				description: "Each step is an agent, tool, skill, or another workflow.",
			},
			{
				title: "Choose a trigger",
				description:
					"Start manually, on a schedule, from a webhook, or from an app event.",
			},
			{
				title: "Let it run",
				description:
					"Fan a task out to specialist agents and merge their results. Finished steps are saved.",
			},
		],
		worksWith: ["agents", "skills", "cloud"],
	},
	skills: {
		statement:
			"Skills brings open-standard Agent Skills into Ryu. Search skills.sh, install in one click, and the skill lands in the standard folder other agents read too.",
		steps: [
			{ title: "Search", description: "Search skills.sh for what you need." },
			{
				title: "Install",
				description:
					"Install in one click. It is saved locally and ready right away, with no restart.",
			},
			{
				title: "Loads on demand",
				description:
					"Each skill's description loads up front; its full instructions load only when needed.",
			},
		],
		worksWith: ["agents", "marketplace", "mcp"],
	},
	mcp: {
		statement:
			"MCP connects agents to tools. Add any MCP server to Ryu and choose which agents may use its tools, or point Claude Desktop, Cursor, and other MCP hosts at your Ryu server with ryu-mcp.",
		steps: [
			{
				title: "Add a server",
				description:
					"Add any MCP server. Desktop automation and screen capture come built in.",
			},
			{
				title: "Choose who can use it",
				description: "Pick which agents may call its tools.",
			},
			{
				title: "Approve risky calls",
				description: "Risky tool calls wait for your approval before they run.",
			},
		],
		worksWith: ["connections", "agents", "connect"],
	},
	connections: {
		statement:
			"Connections sign your agents in to Gmail, Slack, and the other apps your team uses, so they can send the email or open the PR. Risky actions wait for your approval, and agents never see raw tokens.",
		steps: [
			{
				title: "Connect an account",
				description: "Sign an agent in to Gmail, Slack, and more.",
			},
			{
				title: "Scope its actions",
				description:
					"Choose which actions each agent may call. Ryu blocks the rest.",
			},
			{
				title: "Approve the risky ones",
				description: "Send, post, and merge wait for your approval by default.",
			},
		],
		worksWith: ["mcp", "agents", "connect"],
	},
	cli: {
		statement:
			"The Ryu CLI is the Ryu runtime in your terminal. Chat, run agents, and manage servers from the command line, headless or scripted, and pick up the same threads as Ryu Desktop.",
		steps: [
			{
				title: "Sign in",
				description: "Run ryu-cli login and confirm the code in your browser.",
			},
			{
				title: "Pick a server",
				description:
					"Switch between your saved servers, your org's nodes, and mesh peers.",
			},
			{
				title: "Chat or script",
				description:
					"Chat in the terminal, or pipe output as JSON on a server with no screen.",
			},
		],
		worksWith: ["core", "desktop", "red-team"],
	},
	sdk: {
		statement:
			"The Ryu SDK lets you define agents, workflows, tools, and skills in TypeScript behind one interface, then pack them into an App with one command.",
		steps: [
			{
				title: "Scaffold",
				description:
					"create-ryu-app sets up a project that matches the App manifest.",
			},
			{
				title: "Define",
				description:
					"Write agents, workflows, tools, and skills. Model calls go through the Gateway.",
			},
			{
				title: "Pack",
				description: "One command packs them into an App you can install.",
			},
		],
		worksWith: ["gateway", "extensions", "marketplace"],
	},
	marketplace: {
		statement:
			"The Marketplace is an app store for AI agents: apps, skills, models, workflows, themes, and more, installed in one click. Each app declares what it needs, and the Gateway enforces it.",
		steps: [
			{
				title: "Search",
				description: "One search box covers the whole marketplace.",
			},
			{
				title: "See what it needs",
				description:
					"Each app declares what it can reach, and you grant it at install.",
			},
			{
				title: "Install and manage",
				description: "Install in one click, and disable an app anytime.",
			},
		],
		worksWith: ["skills", "extensions", "desktop"],
	},
	extensions: {
		statement:
			"Extensions add tools, model providers, and screens to Ryu as plugins. Plugins run in open-source Ryu Core, so they extend Ryu Desktop without changing it.",
		steps: [
			{ title: "Build", description: "Build a plugin with the Ryu SDK." },
			{ title: "Pack", description: "Pack it as an installable app." },
			{
				title: "Install safely",
				description:
					"Ryu checks its permissions when you install, enable, disable, or update it.",
			},
		],
		worksWith: ["sdk", "marketplace", "core"],
	},
};
