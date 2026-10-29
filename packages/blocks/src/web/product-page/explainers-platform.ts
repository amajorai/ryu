import type { ProductExplainer } from "./explainer-types.ts";

/** Platform products: Core, Gateway, Cloud, Agents as a Service, Red Teaming. */
export const PLATFORM_EXPLAINERS: Record<string, ProductExplainer> = {
	core: {
		statement:
			"Ryu Core is the open-source, local-first runtime every agent, session, and tool runs on. It runs Claude Code, Codex, Gemini CLI, or any OpenAI-compatible agent, headless or in Docker, on a Mac, a Windows or Linux PC, or a server.",
		steps: [
			{
				title: "Install it where you work",
				description:
					"Run it on a Mac, a Windows or Linux PC, or a server with Docker.",
			},
			{
				title: "Bring an agent",
				description:
					"Run Claude Code, Codex, Gemini CLI, or any OpenAI-compatible agent, and choose the MCP tools each one may use.",
			},
			{
				title: "Review the result",
				description:
					"Each run gets its own worktree. Review the diff, then merge or open a PR.",
			},
		],
		builtFor: [
			{
				title: "Developers",
				description:
					"Run coding agents in their own Git worktrees and review every diff before it lands.",
			},
			{
				title: "Servers",
				description:
					"Run agents headless or in Docker. Chat runs locally after a one-time model download.",
			},
		],
		worksWith: ["gateway", "cloud", "desktop", "cli"],
	},
	gateway: {
		statement:
			"Ryu Gateway is one OpenAI-compatible API for model and tool calls. Point an agent you already built at it, and every call it routes is checked, routed, budgeted, and audited by your rules, without rewriting the agent.",
		steps: [
			{
				title: "Swap the base URL",
				description:
					"Point an existing agent at the Gateway's OpenAI-compatible endpoint.",
			},
			{
				title: "Set your rules",
				description:
					"Bring your own keys, then set budgets per agent, user, team, or key.",
			},
			{
				title: "Every call is checked",
				description:
					"Requests are screened for prompt injection, jailbreaks, personal data, and secrets, then routed with fallback and audited.",
			},
		],
		worksWith: ["core", "cloud", "red-team", "sdk"],
	},
	cloud: {
		statement:
			"Ryu Cloud is managed hosting for your agents: a cloud node in the EU or Singapore that keeps scheduled and event-driven runs going while your devices are off. It is built on open-source Ryu Core and Gateway, so you can self-host the same stack.",
		steps: [
			{
				title: "Get a node",
				description:
					"Teams and Business plans include one managed node; team plans can add more.",
			},
			{
				title: "Pick a region",
				description: "Run your node in the EU or Singapore.",
			},
			{
				title: "Let runs continue",
				description:
					"Scheduled and event-driven runs keep going on the node, with optional per-step retries.",
			},
		],
		builtFor: [
			{
				title: "Teams and Business plans",
				description: "Both include one managed node, in the EU or Singapore.",
			},
			{
				title: "Always-on runs",
				description:
					"Scheduled and event-driven runs keep going while your devices sleep.",
			},
		],
		worksWith: ["core", "gateway", "workflows"],
	},
	"agents-as-a-service": {
		statement:
			"Agents as a Service is hands-on help with your first agent. Tell us the task and the tools it uses, and we help scope and set it up on standard Ryu, so you can take it in-house later.",
		steps: [
			{
				title: "Describe the task",
				description: "Tell us the task and the tools it uses.",
			},
			{
				title: "Agree the approval points",
				description: "We agree which steps wait for your approval.",
			},
			{
				title: "Run it where you choose",
				description: "It runs on a Ryu cloud node or on your own machines.",
			},
		],
		worksWith: ["cloud", "gateway", "agents"],
	},
	"red-team": {
		statement:
			"Red Teaming is a self-serve tool in Ryu Desktop and the CLI. It runs ten built-in probes against each agent, from prompt injection to tool abuse and harmful output, and shows which ones it withstands.",
		steps: [
			{
				title: "Pick an agent",
				description: "Start a run from Ryu Desktop or the CLI.",
			},
			{
				title: "Run the probes",
				description:
					"Ten built-in probes cover injection and leaks, tool abuse, and harmful output.",
			},
			{
				title: "Tune from the results",
				description:
					"The Gateway's evaluators score each probe. Use the results to tune your firewall and evals.",
			},
		],
		worksWith: ["gateway", "desktop", "cli"],
	},
};
