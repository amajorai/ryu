// How an agent works and whose accounts it may use, for the terminal.
//
// Shared by `ryu-cli agents` (src/cli/agents.ts) and the TUI agent editor
// (src/surfaces/agents). The copy mirrors the desktop picker
// (`packages/blocks/src/desktop/agent-identity-mode.tsx`) word for word; that
// module renders web components, so the strings are repeated here rather than
// imported. The account-key grammar mirrors Core's `AccountKey::parse`
// (`apps/core/src/agent_access.rs`): a key Core would drop grants nothing, so
// the terminal refuses to save one instead of storing a silent no-op.

import { TREG_ACCOUNT_KEY } from "@ryuhq/core-client/agent-account-access";
import type { AgentIdentityMode } from "@ryuhq/core-client/agents";

export type { AgentIdentityMode } from "@ryuhq/core-client/agents";

export const AGENT_IDENTITY_STEP_TITLE = "How should this agent work?";
export const AGENT_IDENTITY_STEP_SUBTITLE =
	"You can change this later in the agent's settings.";

export interface AgentIdentityModeOption {
	/** The caveat the desktop card adds after the summary; empty when none. */
	detail: string;
	/** A single-cell glyph drawn above the title on the terminal card. */
	glyph: string;
	summary: string;
	title: string;
}

export const AGENT_IDENTITY_MODE_OPTIONS = {
	managed: {
		title: "Acts as you",
		summary: "Works on your behalf with the accounts you've connected.",
		detail: "",
		glyph: "◉",
	},
	individual: {
		title: "Its own identity",
		summary: "Gets its own accounts and logins, and never touches yours.",
		detail:
			"Models Ryu routes for it run on Ryu credits or a local model, not your provider keys, and engines that use your own sign-in don't start for it.",
		glyph: "◇",
	},
	mixed: {
		title: "Both",
		summary:
			"Has its own accounts, and can also use the ones of yours you allow.",
		detail: "Its engine runs in a sandbox that hides Ryu's own data.",
		glyph: "◈",
	},
} as const satisfies Record<AgentIdentityMode, AgentIdentityModeOption>;

/** The order the cards and the mode list are shown in. */
export const AGENT_IDENTITY_MODE_ORDER: readonly AgentIdentityMode[] = [
	"managed",
	"individual",
	"mixed",
];

/** Ryu's own engine ("Ryu" in the engine picker), offered when Core refuses another. */
export const RYU_ENGINE_ID = "acp:pi";

/**
 * Whether an agent's engine is a remote A2A peer (`a2a:<peer>`). Such an agent
 * runs on another node under that node's accounts, so its identity mode and
 * account access describe nothing it does here. Mirrors desktop's
 * `isRemotePeerEngine` and Core's `agent_access::is_remote_peer_agent`.
 */
export function isRemotePeerEngine(engine: string | null | undefined): boolean {
	return engine?.trim().startsWith("a2a:") ?? false;
}

/** What is shown instead of the identity choice for a remote peer (desktop's copy). */
export const REMOTE_PEER_IDENTITY_NOTE = {
	title: "Runs on another node",
	description:
		"This agent is a remote A2A peer. It works with the accounts set up on that node, and Ryu reaches it with the credential you saved for the peer in A2A settings. None of your accounts here are handed to it, so there's no identity or account access to choose. Only an agent that acts as you with no account limit can hand work to it.",
} as const;

/** Parse a mode typed on the command line. Only the three wire values match. */
export function parseIdentityMode(
	value: string | null | undefined
): AgentIdentityMode | null {
	const trimmed = value?.trim().toLowerCase();
	return trimmed === "managed" ||
		trimmed === "individual" ||
		trimmed === "mixed"
		? trimmed
		: null;
}

/** "Acts as you (managed)". */
export function identityModeLabel(mode: AgentIdentityMode): string {
	return `${AGENT_IDENTITY_MODE_OPTIONS[mode].title} (${mode})`;
}

/** The desktop card's full description: the summary plus its caveat. */
export function identityModeDescription(mode: AgentIdentityMode): string {
	const option = AGENT_IDENTITY_MODE_OPTIONS[mode];
	return option.detail ? `${option.summary} ${option.detail}` : option.summary;
}

/** Whether the mode lets the agent use the user's own accounts. */
export function modeUsesYourAccounts(mode: AgentIdentityMode): boolean {
	return mode !== "individual";
}

/** Whether the mode gives the agent accounts of its own. */
export function modeHasOwnAccounts(mode: AgentIdentityMode): boolean {
	return mode !== "managed";
}

/** Move the selection one card left or right, wrapping at the ends. */
export function stepIdentityMode(
	mode: AgentIdentityMode,
	delta: -1 | 1
): AgentIdentityMode {
	const index = AGENT_IDENTITY_MODE_ORDER.indexOf(mode);
	const count = AGENT_IDENTITY_MODE_ORDER.length;
	return AGENT_IDENTITY_MODE_ORDER[(index + delta + count) % count] ?? mode;
}

// ── Account keys ────────────────────────────────────────────────────────────

type AccountKeyOwner = "platform" | "yours" | "own";

export interface AccountKeyKind {
	/** The key shape, for help text. */
	format: string;
	label: string;
	owner: AccountKeyOwner;
	prefix: string;
}

// Listed in display order. Prefixes include the colon, so `mcp:` never matches
// `mcp-secret:` and `agent:` never matches `agent-composio:`.
export const ACCOUNT_KEY_KINDS: readonly AccountKeyKind[] = [
	{
		prefix: "platform:treg",
		format: "platform:treg",
		label: "Treg",
		owner: "platform",
	},
	{
		prefix: "composio:",
		format: "composio:<connected-account-id>",
		label: "Connected apps",
		owner: "yours",
	},
	{
		prefix: "provider:",
		format: "provider:<id>",
		label: "Model providers",
		owner: "yours",
	},
	{
		prefix: "mcp:",
		format: "mcp:<profile>:<plugin>:<server>",
		label: "MCP sign-ins",
		owner: "yours",
	},
	{
		prefix: "mcp-secret:",
		format: "mcp-secret:<server-or-plugin>",
		label: "Services using your saved keys",
		owner: "yours",
	},
	{
		prefix: "platform:desktop",
		format: "platform:desktop",
		label: "Control of your desktop",
		owner: "yours",
	},
	{
		prefix: "agent-composio:",
		format: "agent-composio:<connected-account-id>",
		label: "Its own connected apps",
		owner: "own",
	},
	{
		prefix: "agent:",
		format: "agent:<vault-account-id>",
		label: "Its own logins",
		owner: "own",
	},
];

/** One line per key shape, for usage errors and help. */
export const ACCOUNT_KEY_FORMATS = ACCOUNT_KEY_KINDS.map(
	(kind) => `${kind.format}  (${kind.label})`
);

/**
 * The canonical form of one allowlist entry, or null when Core's
 * `AccountKey::parse` would drop it. Surrounding whitespace is trimmed like
 * Core does; whitespace inside the value is refused like Core does.
 */
export function parseAccountKey(raw: string): string | null {
	const trimmed = raw.trim();
	const colon = trimmed.indexOf(":");
	if (colon === -1) {
		return null;
	}
	const kind = trimmed.slice(0, colon);
	const rest = trimmed.slice(colon + 1);
	if (rest.length === 0 || rest.trim() !== rest) {
		return null;
	}
	switch (kind) {
		case "composio":
		case "provider":
		case "mcp-secret":
		case "agent":
		case "agent-composio":
			return `${kind}:${rest}`;
		case "platform":
			return rest === "treg" || rest === "desktop" ? `${kind}:${rest}` : null;
		case "mcp": {
			// `<profile>:<plugin>:<server>`: the profile is up to the first colon
			// and the server after the last, so a plugin id may hold colons.
			const first = rest.indexOf(":");
			const last = rest.lastIndexOf(":");
			if (first === -1 || last === first) {
				return null;
			}
			const profile = rest.slice(0, first);
			const plugin = rest.slice(first + 1, last);
			const server = rest.slice(last + 1);
			return profile && plugin && server ? `${kind}:${rest}` : null;
		}
		default:
			return null;
	}
}

/** The kind a (canonical) key belongs to, or null for one Core would drop. */
export function accountKeyKind(key: string): AccountKeyKind | null {
	if (parseAccountKey(key) === null) {
		return null;
	}
	for (const kind of ACCOUNT_KEY_KINDS) {
		if (
			kind.prefix.endsWith(":")
				? key.startsWith(kind.prefix)
				: key === kind.prefix
		) {
			return kind;
		}
	}
	return null;
}

/**
 * Why a saved key does nothing under the mode, or null when it applies. Your
 * accounts are unused by an agent with only its own identity, and its own
 * accounts by one that acts as you, the way the desktop editor hides them.
 */
export function accountKeyUnusedReason(
	key: string,
	mode: AgentIdentityMode
): string | null {
	const kind = accountKeyKind(key);
	if (!kind) {
		return "not a key Core recognises, so it allows nothing";
	}
	if (kind.owner === "yours" && !modeUsesYourAccounts(mode)) {
		return "not used: it has only its own identity";
	}
	if (kind.owner === "own" && !modeHasOwnAccounts(mode)) {
		return "not used: it acts as you";
	}
	return null;
}

/** Parse keys typed by the user; every one must be a key Core accepts. */
export function parseAccountKeys(raw: readonly string[]): {
	invalid: string[];
	keys: string[];
} {
	const keys: string[] = [];
	const invalid: string[] = [];
	for (const entry of raw) {
		const key = parseAccountKey(entry);
		if (key === null) {
			invalid.push(entry);
		} else if (!keys.includes(key)) {
			keys.push(key);
		}
	}
	return { invalid, keys };
}

// Treg's account key; a fresh limit keeps it, as desktop's limit does.
export { TREG_ACCOUNT_KEY } from "@ryuhq/core-client/agent-account-access";

/**
 * Add keys to an allowlist. Adding to "no limit" (`null`) starts a limited
 * list holding Treg and the added keys, so it narrows the agent rather than
 * widening it. Desktop's "Limit to selected accounts" also keeps Treg ticked;
 * every other account the agent could use before is left out.
 */
export function addAccountKeys(
	current: readonly string[] | null,
	keys: readonly string[]
): string[] {
	const next = current === null ? [TREG_ACCOUNT_KEY] : [...current];
	for (const key of keys) {
		if (!next.includes(key)) {
			next.push(key);
		}
	}
	return next;
}

/** Remove keys from a limited allowlist. "No limit" has nothing to remove. */
export function removeAccountKeys(
	current: readonly string[],
	keys: readonly string[]
): string[] {
	const removing = new Set(keys);
	return current.filter((key) => !removing.has(key));
}

const UNRESTRICTED_DETAIL: Record<AgentIdentityMode, string> = {
	managed:
		"It can use every account of yours you've connected, and Treg. Accounts you connect later are included.",
	individual:
		"It can use every account of its own, and Treg. It never uses yours.",
	mixed:
		"It can use its own accounts, every account of yours you've connected, and Treg. Accounts you connect later are included.",
};

/** "No limit", "Limited: none" or "Limited to 3 accounts". */
export function accountAccessHeadline(
	accountAccess: readonly string[] | null
): string {
	if (accountAccess === null) {
		return "No limit";
	}
	if (accountAccess.length === 0) {
		return "Limited: no accounts";
	}
	return `Limited to ${accountAccess.length} account${accountAccess.length === 1 ? "" : "s"}`;
}

/** The sentence under the headline. */
export function accountAccessNote(
	accountAccess: readonly string[] | null,
	mode: AgentIdentityMode
): string {
	if (accountAccess === null) {
		return UNRESTRICTED_DETAIL[mode];
	}
	const usable = accountAccess.filter(
		(key) => accountKeyUnusedReason(key, mode) === null
	);
	return usable.length === 0
		? "It can't use any accounts, or Treg."
		: "Only these accounts can be used. Accounts you connect later are not added automatically.";
}
