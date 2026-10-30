// Shapes of the agent account catalog (see ./agentAccountCatalog.ts).

import type { AgentIdentityMode } from "./agentIdentity.ts";

// ── Shapes ──────────────────────────────────────────────────────────────────

export type AccountSectionId =
	| "treg"
	| "connected-apps"
	| "model-providers"
	| "mcp-sign-ins"
	| "saved-keys"
	| "desktop"
	| "own-logins"
	| "own-connected-apps"
	| "not-listed";

export type AccountSectionOwner = "platform" | "yours" | "own";

/** One account the agent may be allowed, as a picker row. */
export interface AvailableAccount {
	/** A second line of context: the account id, profile, user name… */
	detail: string | null;
	key: string;
	section: AccountSectionId;
	/** Connection state worth showing ("Expired", "Sign in again", "2FA"). */
	status: string | null;
	title: string;
}

export interface AccountSection {
	/** Shown when the section has no rows and no error. */
	empty: string;
	/** Why the section could not be loaded; its rows may be incomplete. */
	error: string | null;
	id: AccountSectionId;
	owner: AccountSectionOwner;
	rows: AvailableAccount[];
	title: string;
}

export interface AvailableAccounts {
	/** Groups the identity mode hides, with why (desktop's one-line note). */
	hiddenGroups: string[];
	sections: AccountSection[];
}

/** The Core calls the catalog makes. GET returns parsed JSON; errors throw. */
export interface AccountCatalogCore {
	get: (path: string) => Promise<unknown>;
	post: (path: string, body: unknown) => Promise<unknown>;
}

export interface AvailableAccountsInput {
	/** The saved agent; `null` for an agent with no record yet. */
	agentId: string | null;
	engine: string | null;
	identityMode: AgentIdentityMode;
	/** The mode Core holds; apps of its own need it saved. Defaults to `identityMode`. */
	savedIdentityMode?: AgentIdentityMode | null;
}
