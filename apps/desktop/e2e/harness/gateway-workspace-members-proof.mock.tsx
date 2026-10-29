import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { ReactNode } from "react";
import { type ProofJsonValue, parseProofJson } from "../fixture-json.ts";

export interface WorkspaceProofRequest {
	body: unknown;
	headers: Record<string, string>;
	method: string;
	path: string;
}

export interface WorkspaceProofServerState {
	activeOrganizationId: string;
	activeTeamId: string | null;
	assignments: Record<string, string[]>;
	members: Array<{ createdAt: string; role: string; userId: string }>;
	organizations: Array<{ id: string; name: string; role: string }>;
	roles: Array<{
		builtin: boolean;
		key: string;
		name: string;
		permissions: string[];
	}>;
}

export interface WorkspaceProof {
	assignmentWriteResults: Array<"failed" | "saved">;
	currentStepUpScope: string | null;
	delayMembers: boolean;
	delayOrgs: boolean;
	failAssignedRemaining: number;
	failAssignmentsRemaining: number;
	failMembersRemaining: number;
	failOrgsRemaining: number;
	failPermissionsRemaining: number;
	failRolesRemaining: number;
	failTeamsRemaining: number;
	requests: WorkspaceProofRequest[];
	server: WorkspaceProofServerState;
	snapshot: () => {
		assignmentWriteResults: Array<"failed" | "saved">;
		requests: WorkspaceProofRequest[];
		server: WorkspaceProofServerState;
		stepUpScopes: string[];
	};
	stepUpScopes: string[];
}

declare global {
	interface Window {
		__GATEWAY_WORKSPACE_EXTERNAL_URLS__?: string[];
		__GATEWAY_WORKSPACE_PROOF__?: WorkspaceProof;
	}
}

const SERVER_STATE_KEY = "gateway-workspace-members-proof-server";
const AUTH_TOKEN_STORAGE_KEY = "gateway-workspace-proof-token";

function defaultServerState(): WorkspaceProofServerState {
	return {
		activeOrganizationId: "org-atlas",
		activeTeamId: null,
		assignments: { "user-collab": ["workflow-editor"] },
		members: [
			{
				createdAt: "2026-09-01T00:00:00.000Z",
				role: "owner",
				userId: "user-owner",
			},
			{
				createdAt: "2026-09-02T00:00:00.000Z",
				role: "member",
				userId: "user-collab",
			},
			{
				createdAt: "2026-09-03T00:00:00.000Z",
				role: "viewer",
				userId: "user-viewer",
			},
		],
		organizations: [
			{ id: "org-personal", name: "Mira’s personal workspace", role: "owner" },
			{ id: "org-atlas", name: "Atlas Research", role: "owner" },
		],
		roles: [
			{
				builtin: true,
				key: "owner",
				name: "Owner",
				permissions: ["roles.manage", "gateway.configure", "workflow.edit"],
			},
			{
				builtin: true,
				key: "admin",
				name: "Admin",
				permissions: ["roles.manage", "gateway.configure"],
			},
			{
				builtin: true,
				key: "member",
				name: "Member",
				permissions: ["gateway.view"],
			},
			{
				builtin: true,
				key: "viewer",
				name: "Viewer",
				permissions: ["gateway.view"],
			},
			{
				builtin: false,
				key: "workflow-editor",
				name: "Workflow editor",
				permissions: ["workflow.edit"],
			},
		],
	};
}

function readServerState(): WorkspaceProofServerState {
	try {
		const stored = localStorage.getItem(SERVER_STATE_KEY);
		// SAFETY: This controlled Workspace proof restores the authored defaultServerState plus its validated team-string/null, role-string/filtered-permission, and every-string role-assignment mutations below. The actual proof spec only observes server snapshots; foreign storage edits or direct proof.server mutations are outside this fixture.
		return stored
			? (JSON.parse(stored) as WorkspaceProofServerState)
			: defaultServerState();
	} catch {
		return defaultServerState();
	}
}

function persistServerState(server: WorkspaceProofServerState): void {
	localStorage.setItem(SERVER_STATE_KEY, JSON.stringify(server));
}

function proofState(): WorkspaceProof {
	if (!window.__GATEWAY_WORKSPACE_PROOF__) {
		throw new Error("Gateway workspace proof fixture was not initialized.");
	}
	return window.__GATEWAY_WORKSPACE_PROOF__;
}

function queryFlag(name: string): boolean {
	return new URLSearchParams(window.location.search).get(name) === "1";
}

export function installGatewayWorkspaceFetch(): void {
	localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, "workspace-proof-token");
	const proof: WorkspaceProof = {
		assignmentWriteResults: [],
		currentStepUpScope: null,
		failAssignedRemaining: queryFlag("failAssignedOnce") ? 1 : 0,
		failAssignmentsRemaining: queryFlag("failAssignmentOnce") ? 1 : 0,
		failMembersRemaining: queryFlag("failMembersOnce") ? 1 : 0,
		failOrgsRemaining: queryFlag("failOrgsOnce") ? 1 : 0,
		failPermissionsRemaining: queryFlag("failPermissionsOnce") ? 1 : 0,
		failRolesRemaining: queryFlag("failRolesOnce") ? 1 : 0,
		failTeamsRemaining: queryFlag("failTeamsOnce") ? 1 : 0,
		delayMembers: queryFlag("delayMembers"),
		delayOrgs: queryFlag("delayOrgs"),
		requests: [],
		server: readServerState(),
		stepUpScopes: [],
		snapshot() {
			return {
				assignmentWriteResults: [...proof.assignmentWriteResults],
				requests: structuredClone(proof.requests),
				server: structuredClone(readServerState()),
				stepUpScopes: [...proof.stepUpScopes],
			};
		},
	};
	window.__GATEWAY_WORKSPACE_PROOF__ = proof;
	window.__GATEWAY_WORKSPACE_EXTERNAL_URLS__ = [];
	window.fetch = async (input, init) => {
		const rawUrl = input instanceof Request ? input.url : String(input);
		const url = new URL(rawUrl, window.location.href);
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		const headers = new Headers(
			init?.headers ?? (input instanceof Request ? input.headers : undefined)
		);
		let body: ProofJsonValue = null;
		if (isNativeText(init?.body)) {
			try {
				body = parseProofJson(init.body);
			} catch {
				body = init.body;
			}
		}
		proof.requests.push({
			body,
			headers: Object.fromEntries(headers.entries()),
			method,
			path: `${url.pathname}${url.search}`,
		});

		const server = readServerState();
		proof.server = server;
		const pathname = url.pathname;
		if (method === "GET" && pathname === "/api/fleet/status") {
			return jsonResponse({ enrolled: false });
		}

		const organizationMatch = pathname.match(
			/^\/api\/control-plane\/orgs\/([^/]+)(?:\/(.*))?$/
		);
		const orgId = organizationMatch?.[1];
		const orgSubpath = organizationMatch?.[2] ?? "";
		const orgPrefix = "/api/control-plane/orgs";

		if (method === "GET" && pathname === `${orgPrefix}`) {
			if (proof.delayOrgs) {
				await delay(700);
			}
			if (proof.failOrgsRemaining > 0) {
				proof.failOrgsRemaining -= 1;
				return jsonResponse(
					{ message: "workspace list temporarily unavailable" },
					503
				);
			}
			const organizations = queryFlag("emptyOrgs")
				? []
				: server.organizations.map((organization) => ({
						createdAt: null,
						id: organization.id,
						name: organization.name,
						role:
							queryFlag("readOnly") &&
							organization.id === server.activeOrganizationId
								? "viewer"
								: organization.role,
						slug: organization.id,
					}));
			return jsonResponse({ organizations });
		}

		if (method === "GET" && pathname === "/api/auth/get-session") {
			return jsonResponse({
				session: {
					activeOrganizationId: server.activeOrganizationId,
					activeTeamId: server.activeTeamId,
				},
			});
		}

		if (
			method === "GET" &&
			pathname === "/api/auth/organization/list-user-teams"
		) {
			if (proof.failTeamsRemaining > 0) {
				proof.failTeamsRemaining -= 1;
				return jsonResponse({ message: "teams temporarily unavailable" }, 503);
			}
			return jsonResponse([
				{ id: "team-platform", name: "Platform" },
				{ id: "team-design", name: "Design" },
			]);
		}

		if (
			method === "POST" &&
			pathname === "/api/auth/organization/set-active-team"
		) {
			// SAFETY: The mounted Workspace team selector calls setActiveTeam, which JSON-serializes an authored object body; this view leaves teamId unknown for the existing null/string checks below.
			const payload = body as { teamId?: unknown };
			if (!(payload.teamId === null || isNativeText(payload.teamId))) {
				return jsonResponse(
					{ message: "teamId must be a string or null" },
					400
				);
			}
			server.activeTeamId = payload.teamId;
			persistServerState(server);
			return jsonResponse({ status: true });
		}

		if (method === "GET" && pathname === "/api/control-plane/me/permissions") {
			if (proof.failPermissionsRemaining > 0) {
				proof.failPermissionsRemaining -= 1;
				return jsonResponse(
					{ message: "permissions temporarily unavailable" },
					503
				);
			}
			const permissionQuery = new URLSearchParams(url.search);
			if (permissionQuery.get("orgId") !== server.activeOrganizationId) {
				return jsonResponse({ message: "wrong active organization" }, 400);
			}
			return jsonResponse({
				permissions: queryFlag("readOnly")
					? ["gateway.view"]
					: [
							"roles.manage",
							"gateway.configure",
							"workflow.edit",
							"workflow.run",
						],
			});
		}

		if (!(organizationMatch && orgId)) {
			return jsonResponse(
				{ message: `unhandled fixture route: ${method} ${pathname}` },
				404
			);
		}
		if (orgId !== server.activeOrganizationId) {
			return jsonResponse({ message: "wrong active organization" }, 400);
		}

		if (method === "GET" && orgSubpath === "members") {
			if (proof.delayMembers) {
				await delay(700);
			}
			if (proof.failMembersRemaining > 0) {
				proof.failMembersRemaining -= 1;
				return jsonResponse(
					{ message: "member list temporarily unavailable" },
					503
				);
			}
			return jsonResponse({
				members: queryFlag("emptyMembers")
					? []
					: server.members.map((member) =>
							queryFlag("readOnly") && member.userId === "user-owner"
								? { ...member, role: "viewer" }
								: member
						),
			});
		}

		if (method === "GET" && orgSubpath === "roles") {
			if (proof.failRolesRemaining > 0) {
				proof.failRolesRemaining -= 1;
				return jsonResponse({ message: "roles temporarily unavailable" }, 503);
			}
			return jsonResponse({ roles: server.roles });
		}

		if (method === "GET" && /^members\/[^/]+\/roles$/.test(orgSubpath)) {
			const [, userId] = orgSubpath.match(/^members\/([^/]+)\/roles$/) ?? [];
			if (proof.failAssignedRemaining > 0 && userId === "user-collab") {
				proof.failAssignedRemaining -= 1;
				return jsonResponse(
					{ message: "member roles temporarily unavailable" },
					503
				);
			}
			if (!server.members.some((member) => member.userId === userId)) {
				return jsonResponse({ message: "member not found" }, 404);
			}
			const roleKeys = server.assignments[userId] ?? [];
			return jsonResponse({
				assignments: roleKeys.map((roleKey) => ({ roleKey, teamId: null })),
				roleKeys,
			});
		}

		if (orgSubpath === "roles" && method === "POST") {
			if (proof.currentStepUpScope !== "org.members") {
				return stepUpRequiredResponse();
			}
			if (queryFlag("readOnly")) {
				return jsonResponse({ message: "requires roles.manage" }, 403);
			}
			// SAFETY: The mounted Workspace RoleForm submits an authored object to createRole and the native send serializer; this view leaves every field unknown for the existing string/array checks below.
			const payload = body as {
				key?: unknown;
				name?: unknown;
				permissions?: unknown;
			};
			if (
				!(
					isNativeText(payload.key) &&
					isNativeText(payload.name) &&
					Array.isArray(payload.permissions)
				) ||
				server.roles.some((role) => role.key === payload.key)
			) {
				return jsonResponse({ message: "invalid or duplicate role" }, 400);
			}
			server.roles.push({
				builtin: false,
				key: payload.key,
				name: payload.name,
				permissions: payload.permissions.filter(
					(permission): permission is string => isNativeText(permission)
				),
			});
			persistServerState(server);
			return jsonResponse(server.roles.at(-1), 201);
		}

		if (orgSubpath.startsWith("roles/") && method === "PUT") {
			if (proof.currentStepUpScope !== "org.members") {
				return stepUpRequiredResponse();
			}
			if (queryFlag("readOnly")) {
				return jsonResponse({ message: "requires roles.manage" }, 403);
			}
			const roleKey = decodeURIComponent(orgSubpath.slice("roles/".length));
			const role = server.roles.find(
				(item) => item.key === roleKey && !item.builtin
			);
			// SAFETY: The mounted Workspace RoleForm submits an authored name/permissions object to updateRole and the native send serializer; this view leaves both fields unknown for the checks below.
			const payload = body as { name?: unknown; permissions?: unknown };
			if (
				!(
					role &&
					isNativeText(payload.name) &&
					Array.isArray(payload.permissions)
				)
			) {
				return jsonResponse({ message: "role update is invalid" }, 400);
			}
			role.name = payload.name;
			role.permissions = payload.permissions.filter(
				(permission): permission is string => isNativeText(permission)
			);
			persistServerState(server);
			return jsonResponse(role);
		}

		if (orgSubpath.startsWith("roles/") && method === "DELETE") {
			if (proof.currentStepUpScope !== "org.members") {
				return stepUpRequiredResponse();
			}
			if (queryFlag("readOnly")) {
				return jsonResponse({ message: "requires roles.manage" }, 403);
			}
			const roleKey = decodeURIComponent(orgSubpath.slice("roles/".length));
			server.roles = server.roles.filter(
				(role) => role.key !== roleKey || role.builtin
			);
			for (const [userId, roleKeys] of Object.entries(server.assignments)) {
				server.assignments[userId] = roleKeys.filter((key) => key !== roleKey);
			}
			persistServerState(server);
			return jsonResponse({ deleted: true, key: roleKey });
		}

		if (orgSubpath.startsWith("members/") && method === "PUT") {
			if (proof.currentStepUpScope !== "org.members") {
				return stepUpRequiredResponse();
			}
			if (queryFlag("readOnly")) {
				return jsonResponse({ message: "requires roles.manage" }, 403);
			}
			if (proof.failAssignmentsRemaining > 0) {
				proof.failAssignmentsRemaining -= 1;
				proof.assignmentWriteResults.push("failed");
				return jsonResponse(
					{ message: "assignment write temporarily unavailable" },
					503
				);
			}
			const match = orgSubpath.match(/^members\/([^/]+)\/roles$/);
			const userId = match?.[1];
			// SAFETY: The mounted Workspace member checkbox panel sends an authored { roleKeys } object via setMemberRoles; this view leaves roleKeys unknown for the complete array/string/catalog guard below.
			const payload = body as { roleKeys?: unknown };
			if (
				!(
					userId &&
					server.members.some((member) => member.userId === userId) &&
					Array.isArray(payload.roleKeys) &&
					payload.roleKeys.every(
						(roleKey) =>
							isNativeText(roleKey) &&
							server.roles.some((role) => role.key === roleKey && !role.builtin)
					)
				)
			) {
				return jsonResponse({ message: "invalid role assignment" }, 400);
			}
			// SAFETY: The preceding guard requires an array and checks every role key with the real native string guard and membership in the authored non-builtin role catalog before reaching this assignment.
			server.assignments[userId] = [...new Set(payload.roleKeys as string[])];
			persistServerState(server);
			proof.assignmentWriteResults.push("saved");
			return jsonResponse({ ok: true });
		}

		return jsonResponse(
			{ message: `unhandled fixture route: ${method} ${pathname}` },
			404
		);
	};
}

function stepUpRequiredResponse(): Response {
	return jsonResponse(
		{
			action: "manage workspace members",
			enrolmentRequired: false,
			error: "STEP_UP_REQUIRED",
			message: "Verify your identity to continue",
			methods: ["otp"],
			scope: "org.members",
		},
		403
	);
}

function jsonResponse<FixturePayload>(
	body: FixturePayload,
	status = 200
): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function delay(durationMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export const BACKEND_URL = window.location.origin;
export const FRONTEND_URL = window.location.origin;
export const TOKEN_KEY = AUTH_TOKEN_STORAGE_KEY;

export function useSession() {
	return {
		data: {
			user: {
				id: "user-owner",
				name: "Mira Owner",
			},
		},
		isPending: false,
	};
}

export function getActiveUserId(): string {
	return "user-owner";
}

export function useActiveNode() {
	return {
		name: "Gateway workspace proof node",
		token: "gateway-workspace-node-token",
		url: "http://127.0.0.1:18982",
	};
}

export async function openExternal(url: string): Promise<void> {
	const urls = window.__GATEWAY_WORKSPACE_EXTERNAL_URLS__ ?? [];
	urls.push(url);
	window.__GATEWAY_WORKSPACE_EXTERNAL_URLS__ = urls;
}

export async function openTabWindow(): Promise<void> {}

export function useStepUp() {
	return {
		// SAFETY: The authored null is a native ReactNode member and intentionally renders no step-up dialog in this controlled fixture.
		dialog: null as ReactNode,
		guard: async <T,>(
			scope: string,
			action: () => Promise<T>
		): Promise<T | null> => {
			const proof = proofState();
			proof.stepUpScopes.push(scope);
			if (scope !== "org.members") {
				throw new Error(`Unexpected step-up scope: ${scope}`);
			}
			proof.currentStepUpScope = scope;
			try {
				return await action();
			} finally {
				proof.currentStepUpScope = null;
			}
		},
	};
}
