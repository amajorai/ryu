// Single source of truth for Ryu's capability scopes. Both new auth surfaces
// consume THIS one vocabulary, which is the whole point:
//   - the `apiKey` plugin stores them as access-control "statements"
//     (resource -> allowed actions) on each scoped token, and
//   - the `mcp` / OAuth provider advertises + grants them as flat
//     OAuth scope strings ("resource:action") to MCP clients.
// A scoped API token and an MCP OAuth token therefore describe the SAME blast
// radius. Core stays the resource server that honours the scope; the Gateway is
// where "allowed / measured / paid" is enforced downstream (see AGENTS.md, the
// Core-vs-Gateway rule). Add a capability here once and it is grantable through
// both doors.

import { z } from "zod";

import { ADMIN_ROLE, WAITLIST_ROLE } from "./lib/waitlist.ts";

export type RyuStatements = Record<string, string[]>;

export const PERSONAL_TOKEN_TYPES = ["classic", "fine-grained"] as const;
export type PersonalTokenType = (typeof PERSONAL_TOKEN_TYPES)[number];

// resource -> the actions it supports, most-permissive last. `manage` implies the
// destructive create/update/delete surface; `read` is always the floor.
export const RYU_CAPABILITIES = {
	chat: ["read", "write"],
	agents: ["read", "manage"],
	workflows: ["read", "run", "manage"],
	tools: ["read", "exec"],
	memory: ["read", "write"],
	gateway: ["route"],
	vault: ["write"],
	files: ["read", "write"],
	// Ryu Messaging (hosted SMS, WhatsApp, voice and phone numbers). `manage`
	// sends messages and buys, releases and configures numbers, all of which
	// spend wallet credit; the org's `messaging.read` / `messaging.manage` RBAC
	// still gates a personal key on top of its scopes.
	messaging: ["read", "manage"],
	// Hosted Ryu Mail (`/api/mail`). `read` lists inboxes, messages, threads,
	// drafts and settings; `send` also sends, replies, forwards and works
	// drafts; `manage` also creates and deletes inboxes, domains, lists, pods
	// and webhooks. The org's `mail.read` / `mail.manage` RBAC still gates the
	// key on every call (packages/api/src/lib/mail-api-key-auth.ts).
	mail: ["read", "send", "manage"],
	// The organization prompt registry (`/api/control-plane/orgs/:orgId/prompts`).
	// `read` lists, resolves and diffs prompts; `manage` also creates, commits,
	// moves labels and deletes. The org's `agent.view` / `agent.edit` /
	// `agent.delete` RBAC still gates the key on every call
	// (packages/api/src/lib/prompt-api-key-auth.ts).
	prompts: ["read", "manage"],
} as const satisfies RyuStatements;

export type RyuResource = keyof typeof RYU_CAPABILITIES;

/**
 * Resources only the hosted control plane honours. Core's node capability
 * vocabulary (`apps/core/src/authorization/mod.rs`) has no counterpart, and it
 * refuses a delegation naming an unknown capability, so these scopes must
 * never be signed into a node delegation.
 */
export const HOSTED_ONLY_RESOURCES: readonly RyuResource[] = [
	"messaging",
	"mail",
	"prompts",
];

// RYU_CAPABILITIES is `as const`, so Object.entries yields a union of literal
// tuples whose collapsed element type breaks `.includes`/spread. Read it back as
// plain `readonly string[]` values for these derivations.
const CAPABILITY_ENTRIES = Object.entries(RYU_CAPABILITIES).map(
	([resource, actions]): [string, readonly string[]] => [resource, actions]
);

/** Human names for each resource, shared by key and OAuth consent screens. */
export const RYU_RESOURCE_LABELS: Record<RyuResource, string> = {
	chat: "Chat",
	agents: "Agents",
	workflows: "Workflows",
	tools: "Tools",
	memory: "Memory",
	gateway: "Gateway",
	vault: "Vault",
	files: "Files",
	messaging: "Messaging",
	mail: "Mail",
	prompts: "Prompts",
};

/**
 * Access levels, GitHub fine-grained style. Levels are CUMULATIVE: choosing an
 * action grants it and every less-permissive action listed before it in
 * {@link RYU_CAPABILITIES} (so "write" also grants "read").
 */
export const NO_ACCESS = "none";
const ACCESS_LEVEL_LABELS: Record<string, string> = {
	read: "Read",
	write: "Read & write",
	run: "Read & run",
	exec: "Read & execute",
	manage: "Admin",
	route: "Route requests",
	send: "Read & send",
};

// Per-resource wording where the generic label would mislead: a messaging
// `manage` key sends paid messages, which "Admin" does not convey.
const RESOURCE_ACCESS_LEVEL_LABELS: Partial<
	Record<RyuResource, Record<string, string>>
> = {
	messaging: { manage: "Read, send & manage numbers" },
	mail: { manage: "Read, send & manage inboxes" },
	prompts: { manage: "Read, commit & manage prompts" },
};

export interface AccessLevelOption {
	label: string;
	/** `none`, or the most-permissive action the level grants. */
	value: string;
}

/** The selectable levels for one resource, least to most permissive. */
export function accessLevelOptions(resource: RyuResource): AccessLevelOption[] {
	const actions: readonly string[] = RYU_CAPABILITIES[resource];
	return [
		{ value: NO_ACCESS, label: "No access" },
		...actions.map((action, index) => {
			const label =
				RESOURCE_ACCESS_LEVEL_LABELS[resource]?.[action] ??
				ACCESS_LEVEL_LABELS[action] ??
				action;
			return {
				value: action,
				// A single-action resource has nothing to be cumulative over.
				label:
					index === 0 && action !== "read"
						? label.replace(/^Read & /, "")
						: label,
			};
		}),
	];
}

export type AccessLevels = Partial<Record<RyuResource, string>>;

/** Expand per-resource levels into the cumulative "resource:action" scopes. */
export function accessLevelsToScopes(levels: AccessLevels): string[] {
	const out: string[] = [];
	for (const [resource, actions] of CAPABILITY_ENTRIES) {
		const level = levels[resource as RyuResource];
		const index = level ? actions.indexOf(level) : -1;
		for (const action of actions.slice(0, index + 1)) {
			out.push(`${resource}:${action}`);
		}
	}
	return out;
}

/** The highest level each resource holds in a flat scope list. */
export function accessLevelsFromScopes(scopes: readonly string[]) {
	const held = new Set(scopes);
	const out: Record<string, string> = {};
	for (const [resource, actions] of CAPABILITY_ENTRIES) {
		let level = NO_ACCESS;
		for (const action of actions) {
			if (held.has(`${resource}:${action}`)) {
				level = action;
			}
		}
		out[resource] = level;
	}
	return out as Record<RyuResource, string>;
}

/** Preset: every resource at its most permissive level. */
export function fullAccessLevels(resources: readonly RyuResource[]) {
	const out: AccessLevels = {};
	for (const resource of resources) {
		const actions: readonly string[] = RYU_CAPABILITIES[resource];
		out[resource] = actions.at(-1) ?? NO_ACCESS;
	}
	return out;
}

/** Preset: `read` wherever a resource has it, nothing elsewhere. */
export function readOnlyAccessLevels(resources: readonly RyuResource[]) {
	const out: AccessLevels = {};
	for (const resource of resources) {
		const actions: readonly string[] = RYU_CAPABILITIES[resource];
		out[resource] = actions.includes("read") ? "read" : NO_ACCESS;
	}
	return out;
}

// Standard OIDC scopes an OAuth client may request alongside Ryu scopes.
export const OIDC_STANDARD_SCOPES = [
	"openid",
	"profile",
	"email",
	"offline_access",
] as const;

// Flat "resource:action" scope strings for the OAuth/OIDC provider (MCP clients
// request these). Derived from RYU_CAPABILITIES so the two vocabularies can never
// drift apart.
export const RYU_OAUTH_SCOPES: string[] = Object.entries(
	RYU_CAPABILITIES
).flatMap(([resource, actions]) =>
	actions.map((action) => `${resource}:${action}`)
);

/**
 * The hosted-only scopes an OAuth (MCP) client may request: hosted MCP's
 * control-plane Mail tools (`apps/server/src/hosted-mcp-services.ts`) honour
 * them through Mail's own route-class authorization
 * (`packages/api/src/lib/mail-oauth-principal.ts`). `mail:manage` reaches
 * only the routes a hosted tool needs (today `mail_create_inbox`), and it is
 * one of the {@link OAUTH_OPT_IN_SCOPES}: never granted by default. Messaging
 * stays API-key only because its one write scope also buys and releases
 * numbers, and the `prompts` scopes stay API-key only because the prompt
 * registry refuses OAuth access tokens.
 */
export const RYU_MCP_HOSTED_SCOPES: readonly string[] = [
	"mail:read",
	"mail:send",
	"mail:manage",
];

/**
 * OAuth scopes a client gets only when it names them explicitly and the user
 * chooses them on the consent screen: they are left out of a dynamically
 * registered client's default scopes, out of the scopes an authorize request
 * without `scope` asks for ({@link defaultAuthorizeScopes}), and are not
 * preselected on consent. `mail:manage` creates Mail inboxes, which use the
 * organization's inbox allowance.
 */
export const OAUTH_OPT_IN_SCOPES: readonly string[] = ["mail:manage"];

// The capability scopes an OAuth (MCP) client may request: every node scope,
// plus RYU_MCP_HOSTED_SCOPES. Any other hosted-only scope is left out, because
// no service honours it for an OAuth token, so a consent for it would promise
// access nothing grants and would silently start working if a service later
// accepted OAuth tokens. API keys keep the full RYU_OAUTH_SCOPES vocabulary.
export const RYU_MCP_OAUTH_SCOPES: string[] = RYU_OAUTH_SCOPES.filter(
	(scope) =>
		RYU_MCP_HOSTED_SCOPES.includes(scope) ||
		!(HOSTED_ONLY_RESOURCES as readonly string[]).includes(
			scope.split(":")[0] ?? ""
		)
);

// Every scope the MCP/OIDC provider advertises as supported (and so the only
// scopes it lets a client request): the standard OIDC claims plus the
// OAuth-grantable capability scopes.
export const RYU_SUPPORTED_SCOPES: string[] = [
	...OIDC_STANDARD_SCOPES,
	...RYU_MCP_OAUTH_SCOPES,
];

/**
 * The scopes a client gets when it does not choose: what a dynamically
 * registered client without `scope` is registered for. Every supported scope
 * except the {@link OAUTH_OPT_IN_SCOPES}.
 */
export const RYU_DEFAULT_OAUTH_SCOPES: string[] = RYU_SUPPORTED_SCOPES.filter(
	(scope) => !OAUTH_OPT_IN_SCOPES.includes(scope)
);

/**
 * The scopes an authorize request that omits `scope` asks for: the client's
 * registered scopes (or, when it has none on record, every supported scope)
 * without the {@link OAUTH_OPT_IN_SCOPES}. Better Auth would otherwise ask
 * for all of them, opt-in ones included.
 */
export function defaultAuthorizeScopes(
	clientScopes: readonly string[] | null | undefined
): string[] {
	return (clientScopes ?? RYU_SUPPORTED_SCOPES).filter(
		(scope) => !OAUTH_OPT_IN_SCOPES.includes(scope)
	);
}

// Recognised on a stored grant: every capability scope, so a grant issued
// before a scope stopped being advertised still verifies (its hosted-only
// scopes are simply honoured by nothing).
const RYU_SUPPORTED_SCOPE_SET = new Set<string>([
	...OIDC_STANDARD_SCOPES,
	...RYU_OAUTH_SCOPES,
]);
const RYU_OAUTH_SCOPE_SET = new Set(RYU_OAUTH_SCOPES);

/** Parse the OAuth `scope` value used by Better Auth's opaque token rows. */
const oauthScopesSchema = z
	.union([
		z.string().transform((value) => value.split(/\s+/)),
		z.array(z.string().catch("")),
	])
	.catch(() => [])
	.transform((values) => [
		...new Set(values.map((value) => value.trim()).filter(Boolean)),
	]);

export const parseOAuthScopes = oauthScopesSchema.parse;

export function findUnknownOAuthScopes(scopes: readonly string[]): string[] {
	return scopes.filter((scope) => !RYU_SUPPORTED_SCOPE_SET.has(scope));
}

/**
 * Downscope a grant for a node delegation. OIDC scopes never cross the hosted
 * MCP boundary and an omitted request means "all granted Ryu capabilities".
 */
export function intersectOAuthScopes(
	granted: readonly string[],
	requested?: readonly string[]
): string[] {
	const grantedCapabilities = new Set(
		granted.filter((scope) => RYU_OAUTH_SCOPE_SET.has(scope))
	);
	if (!requested) {
		return [...grantedCapabilities];
	}
	return [...new Set(requested)].filter((scope) =>
		grantedCapabilities.has(scope)
	);
}

// Validate + convert a flat list of "resource:action" scope strings (what a key
// UI sends) into the AC statement map the apiKey plugin stores as a key's
// permissions. Unknown scopes are dropped, so a caller can never widen a key
// beyond RYU_OAUTH_SCOPES.
export function scopesToStatements(scopes: string[]) {
	const allowed = new Set(RYU_OAUTH_SCOPES);
	const out: RyuStatements = {};
	for (const scope of scopes) {
		if (!allowed.has(scope)) {
			continue;
		}
		const [resource, action] = scope.split(":");
		if (!(resource && action)) {
			continue;
		}
		if (out[resource]) {
			out[resource].push(action);
		} else {
			out[resource] = [action];
		}
	}
	return out;
}

// Inverse of scopesToStatements: flatten a stored permissions map back to the
// flat "resource:action" scope strings for display.
export function statementsToScopes(
	statements: RyuStatements | null | undefined
): string[] {
	if (!statements) {
		return [];
	}
	const out: string[] = [];
	for (const [resource, actions] of Object.entries(statements)) {
		for (const action of actions) {
			out.push(`${resource}:${action}`);
		}
	}
	return out;
}

// Clamp a requested statement map to a ceiling: keep only the resources +
// actions the ceiling also grants. This enforces the "explicit scopes may only
// NARROW below the creator's role, never widen past it" invariant when a key is
// minted with explicit permissions (which bypass the plugin's own
// defaultPermissions ceiling).
export function intersectStatements(
	requested: RyuStatements,
	ceiling: RyuStatements
) {
	const out: RyuStatements = {};
	for (const [resource, actions] of Object.entries(requested)) {
		const allowed = ceiling[resource];
		if (!allowed) {
			continue;
		}
		const kept = actions.filter((action) => allowed.includes(action));
		if (kept.length > 0) {
			out[resource] = kept;
		}
	}
	return out;
}

/**
 * Resolve the permissions carried by a personal token.
 *
 * Classic tokens receive the complete capability set available to the caller.
 * Fine-grained tokens can only narrow that set through explicit scopes. Neither
 * mode can exceed the caller's server-side role ceiling.
 */
export function permissionsForPersonalToken(input: {
	ceiling: RyuStatements;
	scopes: string[];
	tokenType: PersonalTokenType;
}) {
	if (input.tokenType === "classic") {
		return withoutOptInScopes(input.ceiling);
	}
	return intersectStatements(scopesToStatements(input.scopes), input.ceiling);
}

function allCapabilities() {
	const out: RyuStatements = {};
	for (const [resource, actions] of CAPABILITY_ENTRIES) {
		out[resource] = [...actions];
	}
	return out;
}

function readOnlyCapabilities() {
	const out: RyuStatements = {};
	for (const [resource, actions] of CAPABILITY_ENTRIES) {
		if (actions.includes("read")) {
			out[resource] = ["read"];
		}
	}
	return out;
}

// Role -> the statements minted onto a new API key when the caller does not
// specify explicit permissions. Mirrors the waitlist role model in
// auth.model.ts: `admin` gets everything; a waitlisted user is read-only; a
// normal/approved user (role "user", "approved", or absent for grandfathered
// accounts) gets full read+write but NOT destructive `manage`, except
// `messaging:manage` (sending is that product's ordinary use) and
// `mail:manage` and `prompts:manage`, which are in the ceiling so a key can
// choose them explicitly but are never granted implicitly ({@link OPT_IN_ONLY_SCOPES}): use
// {@link implicitPermissionsForRole} for a key minted without explicit scopes.
// A key is still checked against the org's `messaging.manage` / `mail.*` / `agent.*` RBAC
// on every call, and an org key is capped at mint by its creator's org
// permissions. A key can always be created with narrower explicit permissions;
// this only sets the ceiling.
export function defaultPermissionsForRole(role?: string | null) {
	if (role === ADMIN_ROLE) {
		return allCapabilities();
	}
	if (role === WAITLIST_ROLE) {
		return readOnlyCapabilities();
	}
	return {
		chat: ["read", "write"],
		agents: ["read"],
		workflows: ["read", "run"],
		tools: ["read", "exec"],
		memory: ["read", "write"],
		gateway: ["route"],
		files: ["read", "write"],
		messaging: ["read", "manage"],
		mail: ["read", "send", "manage"],
		prompts: ["read", "manage"],
	};
}

/**
 * Scopes inside a role's ceiling that a key only gets when its creator picks
 * them: Mail's ordinary use is `mail:send`, while `mail:manage` creates and
 * deletes inboxes, domains, webhooks and their secrets; `prompts:manage`
 * commits versions, moves the labels production code resolves, and deletes
 * prompts.
 */
export const OPT_IN_ONLY_SCOPES: readonly string[] = [
	"mail:manage",
	"prompts:manage",
];

/** `statements` without the {@link OPT_IN_ONLY_SCOPES}. */
export function withoutOptInScopes(statements: RyuStatements): RyuStatements {
	const out: RyuStatements = {};
	for (const [resource, actions] of Object.entries(statements)) {
		const kept = actions.filter(
			(action) => !OPT_IN_ONLY_SCOPES.includes(`${resource}:${action}`)
		);
		if (kept.length > 0) {
			out[resource] = kept;
		}
	}
	return out;
}

/**
 * The statements a key minted WITHOUT explicit scopes receives (a classic
 * token, or a native create with no permissions): the role ceiling minus the
 * opt-in-only scopes.
 */
export function implicitPermissionsForRole(
	role?: string | null
): RyuStatements {
	return withoutOptInScopes(defaultPermissionsForRole(role));
}
