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

const GRANT_META = new Map<string, GrantMeta>(
	Object.entries({
		"usage:read": {
			label: "Read usage summaries",
			description:
				"Read permitted usage summaries and aggregate budget information.",
		},
		"usage:audit": {
			label: "Read administrative audit records",
			description:
				"Read node-wide Gateway records, including commands, errors, and activity from other users. Requires node administrator approval.",
		},
		"subscriptions:read": {
			label: "See your subscription accounts",
			description:
				"See which subscription logins are saved for each provider (names may be email addresses) and how much of each one's limit is left. Never sees passwords or tokens.",
		},
		// App host-bridge capabilities (the four an app reaches via window.ryu).
		"spaces:docs": {
			label: "Manage its Space documents",
			description:
				"Create, read, and update the documents this app owns inside your Spaces.",
		},
		"hook:side-model": {
			label: "Use AI models",
			description:
				"Send prompts to a model to generate content on your behalf.",
		},
		"hook:run-agent": {
			label: "Run AI agents",
			description:
				"Start a read-only tool-using agent that can look at your connected tools and data.",
		},
		"hook:run-agent:write": {
			label: "Run AI agents that make changes",
			description:
				"Start an agent that can edit files, apply patches, and run commands on your behalf.",
		},
		"storage:kv": {
			label: "Store app data on this device",
			description:
				"Save its own settings and state locally, isolated to this app.",
		},
		"ui:toast": {
			label: "Show temporary messages",
			description:
				"Show short status or result messages in Ryu while you are using the app.",
		},
		"ui:declarative-http": {
			label: "Load app data in Ryu views",
			description:
				"Let Ryu load and change this app's declared records through the selected node.",
		},
		"native:haptics": {
			label: "Use haptic feedback",
			description: "Give you bounded tactile feedback on supported devices.",
		},
		"native:notifications": {
			label: "Send native notifications",
			description:
				"Show a bounded notification on a supported phone, browser, or desktop host.",
		},
		"native:live_activities": {
			label: "Update live status",
			description:
				"Update a bounded Live Activity or ongoing run status on supported devices.",
		},
		"notifications:send": {
			label: "Send Ryu notifications",
			description:
				"Add a notification to your Ryu inbox when a subscribed event occurs.",
		},
		// The reviewed tool-plane scope from the Gateway allowlist. It gates the
		// `tools.call`, `providers.call`/`providers.status`/`providers.authorize`
		// and `mcp.callTool` kernel capabilities, so the copy covers connected
		// tools AND managed providers. Keep it identical to the desktop table.
		"tools.invoke": {
			label: "Use your connected tools",
			description:
				"Run tools connected to Ryu and request work from Ryu-managed providers. Paid provider requests can use your Ryu credits.",
		},
		// Common coarse OS-style grants (kept from the prior InstalledSection map).
		fs: {
			label: "Access your files",
			description: "Read and change your files.",
		},
		"fs.read": { label: "Read your files", description: "Read your files." },
		"fs.write": {
			label: "Change your files",
			description: "Modify your files.",
		},
		net: {
			label: "Access the internet",
			description: "Make network requests.",
		},
		"net.fetch": {
			label: "Access the internet",
			description: "Make network requests.",
		},
		http: {
			label: "Access the internet",
			description: "Make network requests.",
		},
		clipboard: {
			label: "Use the clipboard",
			description: "Read from and write to your clipboard.",
		},
		notifications: {
			label: "Show notifications",
			description: "Send you desktop notifications.",
		},
		shell: {
			label: "Run commands on your computer",
			description: "Execute shell commands on this device.",
		},
		chat: {
			label: "Read and write chats",
			description: "Read and post messages in your chats.",
		},
		// Keys must be lower-case: lookups lowercase the grant first.
		"chat.sendfollowup": {
			label: "Send follow-up messages",
			description: "Post a follow-up turn into the current chat.",
		},
		"assistant:context": {
			label: "Talk to your assistant about its page",
			description:
				"Tell the Ask Ryu assistant what this app is showing, guide how it answers while the app is open, and ask it a question on your behalf.",
		},
		calendar: {
			label: "Access your calendar",
			description: "Read and edit your calendar.",
		},
		contacts: {
			label: "Access your contacts",
			description: "Read your contacts.",
		},
	})
);

const GRANT_SEPARATORS = /[._:\-/]+/g;

/** Plain-English label for a grant identifier, with a humanized fallback for
 *  unknown grants (e.g. `foo:bar` → "Foo bar"). Inherited object names are
 *  unknown identifiers too; only authored registry entries supply labels. */
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
