import type { ProductExplainer } from "./explainer-types.ts";

/** Workspaces: where people hand work to agents. */
export const WORKSPACE_EXPLAINERS: Record<string, ProductExplainer> = {
	bot: {
		statement:
			"Bot is managed AI you hand a task to, with nothing to set up. It uses your organization's default model, keeps the task's context in one thread, and waits for your approval before it reaches an important app, person, or system.",
		steps: [
			{
				title: "Hand it a task",
				description: "No model or provider to choose.",
			},
			{
				title: "Keep talking",
				description: "Stay in the same thread; Bot keeps the task's context.",
			},
			{
				title: "Approve before it acts",
				description:
					"Bot pauses before an important app, person, or system and waits for you.",
			},
		],
		worksWith: ["agent"],
	},
	agent: {
		statement:
			"Agent is where you run Ryu your way. Set the models, tools, and approvals your team uses, then review every model and tool call in a run, with its timing, errors, and cost.",
		steps: [
			{
				title: "Set it up",
				description: "Choose the models, tools, and approvals your team uses.",
			},
			{
				title: "Run",
				description: "Every routed model call is recorded.",
			},
			{
				title: "Review",
				description:
					"See each step's timing and errors, and each run's cost against your budget.",
			},
		],
		worksWith: ["bot", "gateway"],
	},
	os: {
		statement:
			"OS is a desktop workspace for agents, apps, and windows. Open apps from the dock, keep each task in its own window, and jump anywhere with ⌘K. It runs on the same agents, Core, and permissions as Ryu Desktop.",
		steps: [
			{
				title: "Open an App",
				description:
					"Apps you install appear in the launcher beside the built-ins.",
			},
			{
				title: "Work in windows",
				description:
					"Keep each task in its own window. ⌘K (Ctrl+K on Windows and Linux) jumps to any app or window.",
			},
			{
				title: "Check in",
				description:
					"Mission Control shows what each chat did and what is still outstanding.",
			},
		],
		worksWith: ["desktop", "marketplace"],
	},
	desktop: {
		statement:
			"Ryu Desktop is the Ryu app for your computer. Chat with agents, connect tools, manage models, and review runs in one app, with local models, your own keys, or a Ryu plan.",
		steps: [
			{
				title: "Choose your models",
				description: "Use local models, your own keys, or a Ryu plan.",
			},
			{
				title: "Bring your history",
				description:
					"Import Claude Code and Codex threads, plus ChatGPT and Claude exports.",
			},
			{
				title: "Run coding agents",
				description:
					"Pick a folder and branch, run agents in their own worktrees, then apply the diff or open a PR.",
			},
		],
		worksWith: ["core", "marketplace", "cli"],
	},
	island: {
		statement:
			"Ryu Island is a planned screen-aware companion: a small island that expands only when it has something useful, and suggests your next step from on-screen context read on your device.",
	},
	mobile: {
		statement:
			"Ryu Mobile is coming to iPhone and Android. Chat with the agents on your Ryu server, or run small open models on the phone, even offline.",
	},
	"chrome-extension": {
		statement:
			"Ryu for Chrome is a page-aware companion in your browser. Summarize the page, ask about a selection, or save it to Ryu without leaving the tab. It reads the active tab only when you allow it.",
		steps: [
			{
				title: "Open it",
				description:
					"Type “ryu” in the address bar, or start from the New Tab home.",
			},
			{
				title: "Ask about the page",
				description:
					"Summarize the page, ask about a selection, or run a saved prompt.",
			},
			{
				title: "Approve actions",
				description:
					"Page changes, navigation, downloads, and uploads need a one-time approval.",
			},
		],
	},
	devices: {
		statement:
			"Ryu Devices are a planned watch, necklace, and e-ink desk display that talk only to your own Ryu server, over Wi-Fi or through your phone over Bluetooth.",
	},
};
