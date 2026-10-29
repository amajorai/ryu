import type { ProductExplainer } from "./explainer-types.ts";

/** Agent APIs: the standalone services a product can give its agents. */
export const AGENT_API_EXPLAINERS: Record<string, ProductExplainer> = {
	passport: {
		statement:
			"Ryu Passport is an encrypted identity vault for agents. It keeps the sessions your agents are allowed to use, makes the upstream fetch itself, and redacts any credential echoed back, so only content reaches the agent.",
		steps: [
			{
				title: "Import a session",
				description:
					"Log in with a provider you trust, then import the session into Passport.",
			},
			{
				title: "Bind it to an agent",
				description:
					"Group per-domain connections under a profile and bind that profile to an agent.",
			},
			{
				title: "Every read is audited",
				description:
					"Each read by Core or the Gateway is audited. Re-login is always a manual step.",
			},
		],
		worksWith: ["core", "gateway", "connections"],
	},
	connect: {
		statement:
			"Ryu Connect serves MCP servers, Skills, and hosted tools behind one API, for products with many customers. You choose which tools each customer can discover and call, and provider secrets stay out of your app.",
		steps: [
			{
				title: "Host your tools",
				description:
					"Serve hosted Skills, MCP servers, and tools behind one API.",
			},
			{
				title: "Scope each customer",
				description: "Choose which tools each customer can discover and call.",
			},
			{
				title: "Call over MCP or REST",
				description:
					"Point existing MCP clients at it, or use the REST API. Events from connected apps wait in an inbox for your service.",
			},
		],
		builtFor: [
			{
				title: "Products with many customers",
				description:
					"Each customer sees only the hosted Skills and tools you choose.",
			},
			{
				title: "Existing MCP clients",
				description:
					"Point the MCP clients you already use at your hosted Skills and tools.",
			},
		],
		worksWith: ["connections", "mcp", "skills", "gateway"],
	},
	box: {
		statement:
			"Ryu Box is an isolated, forkable Linux workspace for agent runs and previews. Files last through stop, resume, and fork for up to 7 days, and you choose how far each Box can reach the network.",
		steps: [
			{
				title: "Create a Box",
				description:
					"Create one from your backend, or let Ryu Core control it. Sizes go up to 8 vCPU and 16 GiB.",
			},
			{
				title: "Set its access",
				description:
					"Add up to 32 secrets and 64 environment variables, and choose no network, an allowlist of up to 64 hosts, or filtered public access.",
			},
			{
				title: "Run, fork, or stop",
				description:
					"Run work, fork the workspace, or stop and resume it. Its artifacts and preview links stay with it.",
			},
		],
		builtFor: [
			{
				title: "Agent runs",
				description:
					"Each run gets an isolated workspace it can fork, stop, and resume.",
			},
			{
				title: "Previews",
				description:
					"Artifacts and preview links stay with the workspace that produced them.",
			},
		],
		worksWith: ["core", "notify"],
	},
	notify: {
		statement:
			"Ryu Notify is one API for durable events, live progress, and approvals. Each event keeps its source, type, recipient, and JSON data together, survives restarts, and reaches signed webhooks with retries.",
		steps: [
			{
				title: "Publish an event",
				description:
					"Send structured events with a source, type, recipient, and JSON data.",
			},
			{
				title: "Stream progress",
				description:
					"Run up to 64 live progress streams per account. Attach up to three links to the run or dashboard a person needs.",
			},
			{
				title: "Deliver reliably",
				description:
					"Deliveries go to signed webhooks and other HTTP channels, with up to five attempts and backoff that grows to 30 minutes.",
			},
		],
		worksWith: ["box", "mail"],
	},
	mail: {
		statement:
			"Ryu Mail gives each agent an email inbox it can send from and receive into over an API. Run it with Ryu or on its own.",
		steps: [
			{
				title: "Create an inbox",
				description:
					"List, create, rename, and remove inboxes through one API.",
			},
			{
				title: "Accept only verified mail",
				description:
					"Each inbox has its own signing secret. Mail without a valid, recent signature is rejected.",
			},
			{
				title: "Keep the record",
				description:
					"Message metadata, bodies, and attachment records stay in Ryu Mail. Rotate a secret without recreating the inbox.",
			},
		],
		worksWith: ["notify"],
	},
	messaging: {
		statement:
			"Ryu Messaging lets agents lease phone numbers and send SMS, MMS, WhatsApp, and voice messages through one API, billed at the AWS price with no markup.",
		steps: [
			{
				title: "Lease a number",
				description:
					"Lease local and toll-free numbers by country, renewed every 30 days from credits.",
			},
			{
				title: "Quote, then send",
				description:
					"See the hold for any destination and channel first. Every send takes an idempotency key, so a retry never charges twice.",
			},
			{
				title: "Hear back",
				description:
					"Replies, delivery results, and number changes arrive as signed webhooks. Recipients who reply STOP are refused.",
			},
		],
	},
	sites: {
		statement:
			"Ryu Sites saves each website build and deploys only the version you approve. Every deploy rescans that exact version, and a detected credential stops it.",
		steps: [
			{
				title: "Save a version",
				description:
					"Each build is saved as an immutable version. Saving a new one never changes what is deployed.",
			},
			{
				title: "Review it",
				description: "Choose the saved version you want visitors to see.",
			},
			{
				title: "Deploy",
				description:
					"The deploy rescans that version, then serves it on its own isolated address.",
			},
		],
		worksWith: ["desktop"],
	},
	hire: {
		statement:
			"Ryu Hire brings in a specialist agent for one task, with nothing to install. It is in early access; today you can install Marketplace apps and run them in Ryu Desktop.",
		stepsTitle: "How it is planned to work",
		steps: [
			{
				title: "Choose a specialist",
				description: "Find an agent by the outcome you need.",
			},
			{
				title: "Review the request",
				description:
					"See the connections and context the run asks for before you approve.",
			},
			{
				title: "Run once",
				description:
					"It runs with only the access you approved, and its inputs, output, and status stay together.",
			},
		],
		worksWith: ["marketplace", "desktop"],
	},
	compute: {
		statement:
			"Ryu Compute is planned: rent CPU or GPU capacity for one bounded job, in a fresh workspace with no login to the host, ending with a receipt for its duration and cost.",
	},
	share: {
		statement:
			"Ryu Share is planned: offer your computer's spare CPU or GPU capacity during hours you publish, only while it is idle, with payouts that follow verified usage.",
	},
};
