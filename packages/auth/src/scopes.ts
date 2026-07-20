// Single source of truth for Ryu's capability scopes. Both new auth surfaces
// consume THIS one vocabulary, which is the whole point:
//   - the `apiKey` plugin stores them as access-control "statements"
//     (resource -> allowed actions) on each scoped token, and
//   - the `mcp` / `oidcProvider` provider advertises + grants them as flat
//     OAuth scope strings ("resource:action") to MCP clients.
// A scoped API token and an MCP OAuth token therefore describe the SAME blast
// radius. Core stays the resource server that honours the scope; the Gateway is
// where "allowed / measured / paid" is enforced downstream (see AGENTS.md, the
// Core-vs-Gateway rule). Add a capability here once and it is grantable through
// both doors.

import { ADMIN_ROLE, WAITLIST_ROLE } from "./lib/waitlist.ts";

export type RyuStatements = Record<string, string[]>;

// resource -> the actions it supports, most-permissive last. `manage` implies the
// destructive create/update/delete surface; `read` is always the floor.
export const RYU_CAPABILITIES = {
	chat: ["read", "write"],
	agents: ["read", "manage"],
	workflows: ["read", "run", "manage"],
	tools: ["read", "exec"],
	memory: ["read", "write"],
	gateway: ["route"],
	files: ["read", "write"],
} as const satisfies RyuStatements;

export type RyuResource = keyof typeof RYU_CAPABILITIES;

// Standard OIDC scopes an MCP client may also request alongside Ryu scopes.
export const OIDC_STANDARD_SCOPES = ["openid", "profile", "email"] as const;

// Flat "resource:action" scope strings for the OAuth/OIDC provider (MCP clients
// request these). Derived from RYU_CAPABILITIES so the two vocabularies can never
// drift apart.
export const RYU_OAUTH_SCOPES: string[] = Object.entries(
	RYU_CAPABILITIES
).flatMap(([resource, actions]) =>
	actions.map((action) => `${resource}:${action}`)
);

// Every scope the MCP/OIDC provider advertises as supported: the standard OIDC
// claims plus Ryu's capability scopes.
export const RYU_SUPPORTED_SCOPES: string[] = [
	...OIDC_STANDARD_SCOPES,
	...RYU_OAUTH_SCOPES,
];

// RYU_CAPABILITIES is `as const`, so Object.entries yields a union of literal
// tuples whose collapsed element type breaks `.includes`/spread. Read it back as
// plain `readonly string[]` values for these derivations.
const CAPABILITY_ENTRIES = Object.entries(RYU_CAPABILITIES) as [
	string,
	readonly string[],
][];

// Validate + convert a flat list of "resource:action" scope strings (what a key
// UI sends) into the AC statement map the apiKey plugin stores as a key's
// permissions. Unknown scopes are dropped, so a caller can never widen a key
// beyond RYU_OAUTH_SCOPES.
export function scopesToStatements(scopes: string[]): RyuStatements {
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
): RyuStatements {
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

function allCapabilities(): RyuStatements {
	const out: RyuStatements = {};
	for (const [resource, actions] of CAPABILITY_ENTRIES) {
		out[resource] = [...actions];
	}
	return out;
}

function readOnlyCapabilities(): RyuStatements {
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
// accounts) gets full read+write but NOT destructive `manage`. A key can always
// be created with narrower explicit permissions; this only sets the default
// ceiling.
export function defaultPermissionsForRole(role?: string | null): RyuStatements {
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
	};
}
