// Plain-English names + one-line descriptions for the permission grants an app
// (plugin) requests, so a non-technical user understands what they are approving
// or revoking instead of reading raw identifiers like `hook:run-agent`. Shared by
// the enable consent dialog (store) AND the per-app permissions / revocation view,
// so the vocabulary is consistent everywhere. Mirrors Core's grant strings
// (`bridge.rs` / manifest `permission_grants`); unknown grants humanize gracefully.

interface GrantMeta {
	description: string;
	label: string;
}

const GRANT_META = new Map<string, GrantMeta>([
	[
		"usage:read",
		{
			label: "Read usage summaries",
			description:
				"Read permitted usage summaries and aggregate budget information.",
		},
	],
	[
		"usage:audit",
		{
			label: "Read administrative audit records",
			description:
				"Read node-wide Gateway records, including commands, errors, and activity from other users. Requires node administrator approval.",
		},
	],
	// App host-bridge capabilities (the four an app reaches via window.ryu).
	[
		"spaces:docs",
		{
			label: "Manage its Space documents",
			description:
				"Create, read, and update the documents this app owns inside your Spaces.",
		},
	],
	[
		"hook:side-model",
		{
			label: "Use AI models",
			description:
				"Send prompts to a model to generate content on your behalf.",
		},
	],
	[
		"hook:run-self",
		{
			label: "Run its own automations on demand",
			description:
				"Let you trigger this app's turn hooks yourself — for example a menu row that re-runs it on one chat. It gains no permission it does not already have; this only adds a way to start it.",
		},
	],
	[
		"hook:run-agent",
		{
			label: "Run AI agents",
			description:
				"Start a read-only tool-using agent that can look at your connected tools and data.",
		},
	],
	[
		"hook:run-agent:write",
		{
			label: "Run AI agents that make changes",
			description:
				"Start an agent that can edit files, apply patches, and run commands on your behalf.",
		},
	],
	[
		"storage:kv",
		{
			label: "Store app data on this device",
			description:
				"Save its own settings and state locally, isolated to this app.",
		},
	],
	[
		"ui:toast",
		{
			label: "Show temporary messages",
			description:
				"Show short status or result messages in Ryu while you are using the app.",
		},
	],
	[
		"ui:declarative-http",
		{
			label: "Load app data in Ryu views",
			description:
				"Let Ryu load and change this app's declared records through the selected node.",
		},
	],
	[
		"crypto:seal",
		{
			label: "Encrypt its own data",
			description:
				"Protect the data it stores so it cannot be read off this device's disk. It cannot read other apps' data or reach the encryption key.",
		},
	],
	[
		"backups:app",
		{
			label: "Back up its own data",
			description:
				"Save and restore this app's encrypted snapshots using a backup destination you approve. It cannot access other apps' backups or storage credentials.",
		},
	],
	// The reviewed tool-plane scope from the Gateway allowlist. It gates the
	// `tools.call`, `providers.call`/`providers.status`/`providers.authorize`
	// and `mcp.callTool` kernel capabilities, so the copy covers connected tools
	// AND managed providers.
	[
		"tools.invoke",
		{
			label: "Use your connected tools",
			description:
				"Run tools connected to Ryu and request work from Ryu-managed providers. Paid provider requests can use your Ryu credits.",
		},
	],
	// Common coarse OS-style grants (kept from the prior InstalledSection map).
	[
		"fs",
		{
			label: "Access your files",
			description: "Read and change your files.",
		},
	],
	["fs.read", { label: "Read your files", description: "Read your files." }],
	[
		"fs.write",
		{ label: "Change your files", description: "Modify your files." },
	],
	[
		"net",
		{
			label: "Access the internet",
			description: "Make network requests.",
		},
	],
	[
		"net.fetch",
		{
			label: "Access the internet",
			description: "Make network requests.",
		},
	],
	[
		"http",
		{ label: "Access the internet", description: "Make network requests." },
	],
	[
		"clipboard",
		{
			label: "Use the clipboard",
			description: "Read from and write to your clipboard.",
		},
	],
	[
		"notifications",
		{
			label: "Show notifications",
			description: "Send you desktop notifications.",
		},
	],
	[
		"notifications:send-to-user",
		{
			label: "Notify organization members",
			description:
				"Deliver Inbox notifications to people in your organization or team.",
		},
	],
	[
		"shell",
		{
			label: "Run commands on your device",
			description: "Execute shell commands on this device.",
		},
	],
	[
		"chat",
		{
			label: "Read and write chats",
			description: "Read and post messages in your chats.",
		},
	],
	// Key MUST be lower-case: `grantLabel` lowercases the grant before the
	// lookup, so a camelCase key here silently never matches.
	[
		"chat.sendfollowup",
		{
			label: "Send follow-up messages",
			description: "Post a follow-up turn into the current chat.",
		},
	],
	[
		"widget:render",
		{
			label: "Show interactive cards in chat",
			description:
				"Render its own interactive interface inline in your conversation, instead of returning plain text.",
		},
	],
	[
		"calendar",
		{
			label: "Access your calendar",
			description: "Read and edit your calendar.",
		},
	],
	[
		"calendar:crud",
		{
			label: "Access your calendar",
			description: "Read and edit your scheduled runs and automations.",
		},
	],
	[
		"contacts",
		{
			label: "Access your contacts",
			description: "Read your contacts.",
		},
	],
	[
		"warmup:crud",
		{
			label: "Schedule keep-alive pings",
			description:
				"See which agents you have and what their usage limits say, and schedule its own short messages to them.",
		},
	],
	[
		"runs:failures",
		{
			label: "See failed runs",
			description:
				"Receive the instruction and error text of agent, scheduled, and workflow runs that fail, including runs it did not start.",
		},
	],
	[
		"approvals:request",
		{
			label: "Ask for your approval",
			description:
				"Queue a request in your approvals inbox. It cannot approve or reject anything itself.",
		},
	],
	[
		"runs:rerun-agent",
		{
			label: "Retry failed agent runs",
			description:
				"Run a failed agent task again with the same agent and instruction.",
		},
	],
	[
		"app:http:@ryu/recipes",
		{
			label: "Read your recipes",
			description:
				"Read the recipes recorded by the Recipes app so this app can offer them.",
		},
	],
	[
		"subscriptions:read",
		{
			label: "See your subscription accounts",
			description:
				"See which subscription logins are saved for each provider (names may be email addresses) and how much of each one's limit is left. Never sees passwords or tokens.",
		},
	],
]);

const GRANT_SEPARATORS = /[._:\-/]+/g;

/** Plain-English label for a grant identifier, with a humanized fallback for
 *  unknown grants (e.g. `foo:bar` → "Foo bar"). */
export function grantLabel(grant: string): string {
	const known = GRANT_META.get(grant.toLowerCase());
	if (known) {
		return known.label;
	}
	const words = grant.replace(GRANT_SEPARATORS, " ").trim();
	if (!words) {
		return grant;
	}
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One-line description of what a grant lets the app do, or `null` if unknown
 *  (callers can fall back to showing the raw identifier as a tooltip). */
export function grantDescription(grant: string): string | null {
	return GRANT_META.get(grant.toLowerCase())?.description ?? null;
}
