// apps/desktop/src/lib/api/org.ts
//
// Typed reads for the org (workspace) roster surface. Like teams-billing.ts,
// this targets the identity/control-plane server (:3000, BACKEND_URL) with the
// Better-Auth session bearer token — org membership is a "what is allowed /
// shared" concern owned by the control plane (packages/api control-plane
// router), not the Core node.
//
//   GET /api/control-plane/orgs                 -> my orgs + my role in each
//   GET /api/control-plane/orgs/:orgId/members  -> the org roster (member-visible)
//
// Reads only. Member role changes / removals / invites are owned by Better
// Auth's organization plugin and are performed on the web `/organizations`
// surface; the desktop links out for those.

import { BACKEND_URL, TOKEN_KEY } from "@/lib/auth-client.ts";

export type OrgRole = "owner" | "admin" | "member" | "viewer" | null;

/** One organization the caller belongs to, with the caller's role in it. */
export interface OrgSummary {
	createdAt?: string;
	id: string;
	name: string;
	role: OrgRole;
	slug?: string;
}

/** One membership row in an org roster. */
export interface OrgMember {
	createdAt?: string;
	role: OrgRole;
	userId: string;
}

/**
 * The canonical permission vocabulary. MUST match byte-for-byte the Rust +
 * control-plane `PERMISSIONS` lists (org/team RBAC contract). Used as the matrix
 * columns/rows in the roles editor and to validate a custom role's permission
 * set. The built-in role -> permission mapping is NOT duplicated here: the server
 * synthesises the four built-ins in `GET /roles`, so the desktop only needs the
 * vocabulary, never the mapping (one source of truth, no drift).
 */
export const PERMISSIONS = [
	"gateway.view",
	"gateway.configure",
	"workflow.view",
	"workflow.run",
	"workflow.edit",
	"workflow.delete",
	"space.read",
	"space.write",
	"space.delete",
	"agent.view",
	"agent.run",
	"agent.edit",
	"tool.exec",
	"members.manage",
	"roles.manage",
	"billing.manage",
	"audit.view",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** A role in an org: the four synthesised built-ins plus any custom roles. */
export interface OrgRoleDef {
	builtin: boolean;
	key: string;
	name: string;
	permissions: string[];
}

function authToken(): string | null {
	try {
		return localStorage.getItem(TOKEN_KEY);
	} catch {
		return null;
	}
}

/** True when the caller has a session token (the org surface requires sign-in). */
export function hasOrgAuth(): boolean {
	return Boolean(authToken());
}

const BASE = `${BACKEND_URL.replace(/\/$/, "")}/api/control-plane`;

async function get<T>(path: string): Promise<T> {
	const token = authToken();
	const resp = await fetch(`${BASE}${path}`, {
		headers: token ? { Authorization: `Bearer ${token}` } : {},
	});
	if (!resp.ok) {
		throw new Error(`Request failed: ${resp.status}`);
	}
	return (await resp.json()) as T;
}

/** The organizations the signed-in user belongs to, with their role in each. */
export async function fetchOrgs(): Promise<OrgSummary[]> {
	const { organizations } = await get<{ organizations: OrgSummary[] }>("/orgs");
	return organizations;
}

/** The member roster for an org. Any member may read it. */
export async function fetchOrgMembers(orgId: string): Promise<OrgMember[]> {
	const { members } = await get<{ members: OrgMember[] }>(
		`/orgs/${encodeURIComponent(orgId)}/members`
	);
	return members;
}

/** Body-carrying control-plane mutation (POST / PUT / DELETE) with the session
 * bearer. Mirrors {@link get} but for writes; parses an optional JSON reply. */
async function send<T>(
	method: "POST" | "PUT" | "DELETE",
	path: string,
	body?: unknown
): Promise<T> {
	const token = authToken();
	const headers: Record<string, string> = {};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	if (body !== undefined) {
		headers["Content-Type"] = "application/json";
	}
	const resp = await fetch(`${BASE}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!resp.ok) {
		throw new Error(`Request failed: ${resp.status}`);
	}
	const text = await resp.text();
	return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * The roles defined in an org: the four built-ins (owner / admin / member /
 * viewer) synthesised by the server with their permission sets, plus any custom
 * roles. Any member may read this.
 */
export async function listRoles(orgId: string): Promise<OrgRoleDef[]> {
	const { roles } = await get<{ roles: OrgRoleDef[] }>(
		`/orgs/${encodeURIComponent(orgId)}/roles`
	);
	return roles;
}

/** Create a custom role. Requires `roles.manage`. */
export async function createRole(
	orgId: string,
	role: { key: string; name: string; permissions: string[] }
): Promise<void> {
	await send<unknown>("POST", `/orgs/${encodeURIComponent(orgId)}/roles`, role);
}

/** Update a custom role's name / permissions. Requires `roles.manage`; the
 * server refuses to edit a built-in. */
export async function updateRole(
	orgId: string,
	roleKey: string,
	patch: { name: string; permissions: string[] }
): Promise<void> {
	await send<unknown>(
		"PUT",
		`/orgs/${encodeURIComponent(orgId)}/roles/${encodeURIComponent(roleKey)}`,
		patch
	);
}

/** Delete a custom role (cascades its assignments). Requires `roles.manage`;
 * the server refuses to delete a built-in. */
export async function deleteRole(
	orgId: string,
	roleKey: string
): Promise<void> {
	await send<unknown>(
		"DELETE",
		`/orgs/${encodeURIComponent(orgId)}/roles/${encodeURIComponent(roleKey)}`
	);
}

/** The custom role keys assigned to a member (on top of their built-in tier).
 * Any member may read this. */
export async function getMemberRoles(
	orgId: string,
	userId: string
): Promise<string[]> {
	const { roleKeys } = await get<{ roleKeys: string[] }>(
		`/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}/roles`
	);
	return roleKeys;
}

/** Set the custom role keys assigned to a member. Requires `roles.manage`. */
export async function setMemberRoles(
	orgId: string,
	userId: string,
	roleKeys: string[]
): Promise<void> {
	await send<unknown>(
		"PUT",
		`/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}/roles`,
		{ roleKeys }
	);
}

/** The caller's own effective permissions in an org (built-in tier UNION every
 * custom role granted). Self-scoped; any signed-in member may read their own. */
export async function fetchMyPermissions(orgId: string): Promise<string[]> {
	const { permissions } = await get<{ permissions: string[] }>(
		`/me/permissions?orgId=${encodeURIComponent(orgId)}`
	);
	return permissions;
}
