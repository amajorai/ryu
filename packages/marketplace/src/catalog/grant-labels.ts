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

const GRANT_META: Record<string, GrantMeta> = {
	// App host-bridge capabilities (the four an app reaches via window.ryu).
	"spaces:docs": {
		label: "Manage its Space documents",
		description:
			"Create, read, and update the documents this app owns inside your Spaces.",
	},
	"hook:side-model": {
		label: "Use AI models",
		description: "Send prompts to a model to generate content on your behalf.",
	},
	"hook:run-agent": {
		label: "Run AI agents",
		description:
			"Start a tool-using agent that can act with your connected tools and data.",
	},
	"storage:kv": {
		label: "Store app data on this device",
		description:
			"Save its own settings and state locally, isolated to this app.",
	},
	// Common coarse OS-style grants (kept from the prior InstalledSection map).
	fs: {
		label: "Access your files",
		description: "Read and change your files.",
	},
	"fs.read": { label: "Read your files", description: "Read your files." },
	"fs.write": { label: "Change your files", description: "Modify your files." },
	net: {
		label: "Access the internet",
		description: "Make network requests.",
	},
	"net.fetch": {
		label: "Access the internet",
		description: "Make network requests.",
	},
	http: { label: "Access the internet", description: "Make network requests." },
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
	"chat.sendFollowUp": {
		label: "Send follow-up messages",
		description: "Post a follow-up turn into the current chat.",
	},
	calendar: {
		label: "Access your calendar",
		description: "Read and edit your calendar.",
	},
	contacts: {
		label: "Access your contacts",
		description: "Read your contacts.",
	},
};

const GRANT_SEPARATORS = /[._:\-/]+/g;

/** Plain-English label for a grant identifier, with a humanized fallback for
 *  unknown grants (e.g. `foo:bar` → "Foo bar"). */
export function grantLabel(grant: string): string {
	const known = GRANT_META[grant.toLowerCase()];
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
	return GRANT_META[grant.toLowerCase()]?.description ?? null;
}
