import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
// apps/desktop/src/lib/api/hierarchy.ts
//
// Typed client for the Projects › Bots/Groups › Sessions hierarchy.
//
// Two owners, one client:
//   - Core owns the generic primitives (`/api/hierarchy/*`, `/api/scope-defaults*`):
//     where a thread sits, the one main thread per (project, owner), the sessions
//     a main thread spawned, and per-scope model defaults with their resolution.
//   - The Projects app (`@ryu/projects`, preinstalled) owns project records,
//     reached through its public mount `/api/projects/*`.
//
// Users talk to MAIN threads (a project's, a bot's, or a group's coordinator
// thread). The work happens in SESSIONS those threads spawn.

import { type ApiTarget, request } from "./client.ts";

const ensureMainThreadResponseSchema = z.looseObject({
	conversation_id: z.string().optional(),
});
const findMainThreadResponseSchema = z.looseObject({
	conversation_id: z.union([z.null(), z.string()]),
});
const sessionsResponseSchema = z.looseObject({
	agent_id: z.union([z.null(), z.string()]),
	id: z.string(),
	message_count: z.number(),
	project_id: z.string().optional(),
	run_status: z.union([z.null(), z.string()]),
	spawned_by_conversation_id: z.string().optional(),
	thread_role: z.string().optional(),
	title: z.union([z.null(), z.string()]),
	updated_at: z.number(),
});
const fetchThreadSessionsResponseSchema = z.looseObject({
	sessions: z.array(sessionsResponseSchema).optional(),
});
const defaultsResponseSchema = z.looseObject({
	coordinatorEffort: z.string().optional(),
	coordinatorModel: z.string().optional(),
	coordinatorProvider: z.string().optional(),
	effort: z.string(),
	model: z.string(),
	provider: z.string(),
});
const fetchScopeDefaultsResponseSchema = z.looseObject({
	defaults: z.record(z.string(), defaultsResponseSchema).optional(),
});
const levelsResponseSchema = z.looseObject({
	agent: z.union([z.null(), defaultsResponseSchema]),
	agent_binding_model: z.union([z.null(), z.string()]),
	global: z.union([z.null(), defaultsResponseSchema]),
	project: z.union([z.null(), defaultsResponseSchema]),
	project_agent: z.union([z.null(), defaultsResponseSchema]),
	session: z.union([z.null(), defaultsResponseSchema]),
	settings: z.union([z.null(), defaultsResponseSchema]),
});
const resolvedResponseSchema = z.looseObject({
	effort: z.string(),
	effort_source: z.union([
		z.null(),
		z.literal("agent"),
		z.literal("session"),
		z.literal("project_agent"),
		z.literal("agent_binding"),
		z.literal("project"),
		z.literal("settings"),
		z.literal("global"),
	]),
	model: z.string(),
	model_source: z.union([
		z.null(),
		z.literal("agent"),
		z.literal("session"),
		z.literal("project_agent"),
		z.literal("agent_binding"),
		z.literal("project"),
		z.literal("settings"),
		z.literal("global"),
	]),
	provider: z.string(),
});
const fetchEffectiveDefaultsResponseSchema = z.looseObject({
	levels: levelsResponseSchema,
	resolved: resolvedResponseSchema,
});
const rekeyProjectMemoryResponseSchema = z.looseObject({
	moved: z.number().optional(),
});
const membersResponseSchema = z.looseObject({
	id: z.string(),
	kind: z.union([z.literal("agent"), z.literal("group"), z.literal("user")]),
	mainThreadId: z.union([z.null(), z.string()]).optional(),
	name: z.string(),
});
const projectsResponseSchema = z.looseObject({
	coordinatorAgent: z.union([z.null(), z.string()]).optional(),
	coordinatorConversationId: z.union([z.null(), z.string()]).optional(),
	cwd: z.union([z.null(), z.string()]).optional(),
	defaults: defaultsResponseSchema.optional(),
	description: z.string(),
	icon: gatewayJsonValueSchema.optional(),
	id: z.string(),
	instructions: z.string().optional(),
	members: z.array(membersResponseSchema).optional(),
	name: z.string(),
	status: z.string(),
	updatedAt: z.number().optional(),
});
const fetchProjectsResponseSchema = z.looseObject({
	projects: z.array(projectsResponseSchema).optional(),
});
const ensureProjectMainThreadResponseSchema = z.looseObject({
	conversationId: z.string(),
});

export type OwnerKind = "agent" | "group" | "project";

/**
 * One scope's model default. Empty strings mean "not set at this level".
 *
 * `provider`/`model`/`effort` are the thread defaults (every thread in the
 * scope). The `coordinator*` fields override them for main threads only.
 */
export interface ScopeDefault {
	coordinatorEffort?: string;
	coordinatorModel?: string;
	coordinatorProvider?: string;
	effort: string;
	model: string;
	provider: string;
}

/** Which defaults a thread reads: main threads coordinate, sessions work. */
export type DefaultsRole = "coordinator" | "thread";

/** The node-wide scope set in Settings › Models. */
export const GLOBAL_SCOPE = "global";

/** The level a resolved default came from, most specific first. */
export type DefaultSource =
	| "session"
	| "project_agent"
	| "agent"
	| "agent_binding"
	| "project"
	| "settings"
	| "global";

export interface ResolvedDefault {
	effort: string;
	effort_source: DefaultSource | null;
	model: string;
	model_source: DefaultSource | null;
	provider: string;
}

export interface EffectiveDefaults {
	levels: {
		agent: ScopeDefault | null;
		agent_binding_model: string | null;
		global: ScopeDefault | null;
		project: ScopeDefault | null;
		project_agent: ScopeDefault | null;
		session: ScopeDefault | null;
		settings: ScopeDefault | null;
	};
	resolved: ResolvedDefault;
}

export const EMPTY_SCOPE_DEFAULT: ScopeDefault = {
	effort: "",
	model: "",
	provider: "",
};

/** `project:<id>`. */
export function projectScope(projectId: string): string {
	return `project:${projectId.trim()}`;
}

/** `agent:<id>`. */
export function agentScope(agentId: string): string {
	return `agent:${agentId.trim()}`;
}

/** `project:<p>/agent:<a>`. */
export function projectAgentScope(projectId: string, agentId: string): string {
	return `project:${projectId.trim()}/agent:${agentId.trim()}`;
}

/** Human label for where an inherited value comes from. */
export function defaultSourceLabel(
	source: DefaultSource | null,
	names: { agent?: string; project?: string } = {}
): string {
	switch (source) {
		case "session":
			return "Set for this session";
		case "project_agent":
			return `Inherited from ${names.agent ?? "this bot"} in ${names.project ?? "this project"}`;
		case "agent":
			return `Inherited from ${names.agent ?? "this bot"}`;
		case "agent_binding":
			return `${names.agent ?? "This bot"}'s own model`;
		case "project":
			return `Inherited from ${names.project ?? "this project"}`;
		case "settings":
			return "Inherited from Settings › Models";
		case "global":
			return "Inherited from your default";
		default:
			return "No default set";
	}
}

function query(params: Record<string, string | undefined | null | boolean>) {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null || value === "") {
			continue;
		}
		search.set(key, String(value));
	}
	const text = search.toString();
	return text ? `?${text}` : "";
}

function acknowledgedMainThreadId<TValue>(value: TValue): string {
	if (!(isNativeText(value) && value.trim()) || value !== value.trim()) {
		throw new Error(
			"The node returned no main thread id. Reload the project before opening its thread."
		);
	}
	return value;
}

/** Find or create the main thread of `(project, owner)`. */
export async function ensureMainThread(
	target: ApiTarget,
	input: {
		agentId?: string;
		ownerId: string;
		ownerKind: OwnerKind;
		projectId?: string;
		title?: string;
	}
): Promise<string> {
	const response = await request(
		target,
		"/api/hierarchy/main-threads",
		{
			method: "POST",
			body: {
				project_id: input.projectId,
				owner_kind: input.ownerKind,
				owner_id: input.ownerId,
				agent_id: input.agentId,
				title: input.title,
			},
		},
		ensureMainThreadResponseSchema
	);
	return acknowledgedMainThreadId(response.conversation_id);
}

/** The main thread of `(project, owner)`, or null when none exists yet. */
export async function findMainThread(
	target: ApiTarget,
	input: { ownerId: string; ownerKind: OwnerKind; projectId?: string }
): Promise<string | null> {
	const response = await request(
		target,
		`/api/hierarchy/main-threads${query({
			project_id: input.projectId,
			owner_kind: input.ownerKind,
			owner_id: input.ownerId,
		})}`,
		undefined,
		findMainThreadResponseSchema
	);
	return response.conversation_id ?? null;
}

/** Wire shape of a session row (a Core conversation summary). */
export interface SessionSummary {
	agent_id: string | null;
	id: string;
	message_count: number;
	project_id?: string;
	run_status: string | null;
	spawned_by_conversation_id?: string;
	thread_role?: string;
	title: string | null;
	updated_at: number;
}

/** Sessions a main thread spawned, newest activity first. */
export async function fetchThreadSessions(
	target: ApiTarget,
	conversationId: string
): Promise<SessionSummary[]> {
	const response = await request(
		target,
		`/api/hierarchy/threads/${encodeURIComponent(conversationId)}/sessions`,
		undefined,
		fetchThreadSessionsResponseSchema
	);
	return response.sessions ?? [];
}

/** Put a thread in a project, or take it out with `null`. `spawnedBy` files it
 * under a main thread (reachable from that thread's Sessions panel). */
export async function setThreadProject(
	target: ApiTarget,
	conversationId: string,
	projectId: string | null,
	spawnedBy?: string
): Promise<void> {
	await request(
		target,
		`/api/hierarchy/threads/${encodeURIComponent(conversationId)}/project`,
		{
			method: "PUT",
			body: { project_id: projectId, spawned_by_conversation_id: spawnedBy },
		},
		gatewayJsonValueSchema
	);
}

/** Set (or clear) an ad-hoc group main thread's coordination strategy. */
export async function setThreadCoordination(
	target: ApiTarget,
	conversationId: string,
	coordination: string | null
): Promise<void> {
	await request(
		target,
		`/api/hierarchy/threads/${encodeURIComponent(conversationId)}/coordination`,
		{ method: "PUT", body: { coordination } },
		gatewayJsonValueSchema
	);
}

/** Keep opaque scope keys within the defaults route during URL parsing. */
function scopeDefaultPath(scope: string): string {
	if (scope === "." || scope === "..") {
		throw new Error("Scope cannot be a URL dot segment");
	}
	return `/api/scope-defaults/${encodeURIComponent(scope)}`;
}

/** Write a scope default; an all-empty value resets it to inherited. */
export async function setScopeDefault(
	target: ApiTarget,
	scope: string,
	value: ScopeDefault
): Promise<void> {
	await request(
		target,
		scopeDefaultPath(scope),
		{
			method: "PUT",
			body: value,
		},
		gatewayJsonValueSchema
	);
}

/** Reset a scope to inherited. */
export async function clearScopeDefault(
	target: ApiTarget,
	scope: string
): Promise<void> {
	await request(
		target,
		scopeDefaultPath(scope),
		{ method: "DELETE" },
		gatewayJsonValueSchema
	);
}

/** Every stored scope default, keyed by scope. */
export async function fetchScopeDefaults(
	target: ApiTarget
): Promise<Record<string, ScopeDefault>> {
	const response = await request(
		target,
		"/api/scope-defaults",
		undefined,
		fetchScopeDefaultsResponseSchema
	);
	return response.defaults ?? {};
}

/**
 * One scope's prompt guidance (Core's `scope_guidance`): an optional goal and
 * an optional brief-replies toggle. Core injects both into the system prompt of
 * every thread in the scope, so a change is a one-time prompt-cache miss for
 * those threads; confirm with `promptEditCacheWarning` before saving.
 */
export interface ScopeGuidance {
	/** `null`/absent inherits (brief replies are on by default). */
	briefReplies?: boolean | null;
	goal: string;
}

const scopeGuidanceResponseSchema = z.looseObject({
	guidance: z
		.looseObject({
			briefReplies: z.boolean().nullish(),
			goal: z.string().optional(),
		})
		.optional(),
});
const scopeGuidanceWriteSchema = z.looseObject({
	promptChanged: z.boolean().optional(),
});

/** Keep opaque scope keys within the guidance route during URL parsing. */
function scopeGuidancePath(scope: string): string {
	if (scope === "." || scope === "..") {
		throw new Error("Scope cannot be a URL dot segment");
	}
	return `/api/scope-guidance/${encodeURIComponent(scope)}`;
}

/** Read one scope's guidance (empty when unset). */
export async function fetchScopeGuidance(
	target: ApiTarget,
	scope: string
): Promise<ScopeGuidance> {
	const response = await request(
		target,
		scopeGuidancePath(scope),
		undefined,
		scopeGuidanceResponseSchema
	);
	return {
		briefReplies: response.guidance?.briefReplies ?? null,
		goal: response.guidance?.goal ?? "",
	};
}

/**
 * Write one scope's guidance. Omitted fields keep their stored value. Resolves
 * to whether the system prompt actually changed (and so whether the scope's
 * threads take a cache miss on their next turn).
 */
export async function setScopeGuidance(
	target: ApiTarget,
	scope: string,
	value: Partial<ScopeGuidance>
): Promise<boolean> {
	const response = await request(
		target,
		scopeGuidancePath(scope),
		{ method: "PUT", body: value },
		scopeGuidanceWriteSchema
	);
	return response.promptChanged ?? true;
}

/** The effective defaults for `(project, agent)` and where each value comes from. */
export function fetchEffectiveDefaults(
	target: ApiTarget,
	input: {
		agentId?: string;
		inheritedOnly?: boolean;
		projectId?: string;
		role?: DefaultsRole;
		session?: Partial<ScopeDefault>;
	}
): Promise<EffectiveDefaults> {
	return request(
		target,
		`/api/hierarchy/effective-defaults${query({
			project_id: input.projectId,
			agent_id: input.agentId,
			session_provider: input.session?.provider,
			session_model: input.session?.model,
			session_effort: input.session?.effort,
			inherited_only: input.inheritedOnly || undefined,
			thread_role: input.role === "coordinator" ? "main" : undefined,
		})}`,
		undefined,
		fetchEffectiveDefaultsResponseSchema
	);
}

/** Move legacy folder-scoped project memory onto a project id. */
export async function rekeyProjectMemory(
	target: ApiTarget,
	fromScopeId: string,
	toProjectId: string
): Promise<number> {
	const response = await request(
		target,
		"/api/hierarchy/memory/rekey-project",
		{
			method: "POST",
			body: { from_scope_id: fromScopeId, to_project_id: toProjectId },
		},
		rekeyProjectMemoryResponseSchema
	);
	return response.moved ?? 0;
}

// ---------------------------------------------------------------------------
// Projects app (`@ryu/projects`)
// ---------------------------------------------------------------------------

export type ProjectMemberKind = "agent" | "group" | "user";

export interface ProjectMember {
	id: string;
	kind: ProjectMemberKind;
	mainThreadId?: string | null;
	name: string;
}

export interface ProjectRecord {
	coordinatorAgent?: string | null;
	/** The project's coordinator main thread. */
	coordinatorConversationId?: string | null;
	cwd?: string | null;
	defaults?: ScopeDefault;
	description: string;
	icon?: unknown;
	id: string;
	instructions?: string;
	members?: ProjectMember[];
	name: string;
	status: string;
	updatedAt?: number;
}

export interface NewProjectInput {
	coordinatorAgent?: string;
	cwd?: string;
	defaults?: ScopeDefault;
	description?: string;
	icon?: unknown;
	instructions?: string;
	name: string;
}

/** The node's projects, newest first. */
export async function fetchProjects(
	target: ApiTarget
): Promise<ProjectRecord[]> {
	const response = await request(
		target,
		"/api/projects/projects",
		undefined,
		fetchProjectsResponseSchema
	);
	return response.projects ?? [];
}

/** Create a project. Its coordinator main thread is created with it. */
export function createProject(
	target: ApiTarget,
	input: NewProjectInput
): Promise<ProjectRecord> {
	return request(
		target,
		"/api/projects/projects",
		{
			method: "POST",
			body: {
				name: input.name,
				description: input.description ?? "",
				instructions: input.instructions ?? "",
				icon: input.icon ?? null,
				coordinatorAgent: input.coordinatorAgent,
				cwd: input.cwd,
				defaults: input.defaults ?? EMPTY_SCOPE_DEFAULT,
				executionMode: "auto",
			},
		},
		projectsResponseSchema
	);
}

/** Ensure (and return) the project's coordinator main thread. */
export async function ensureProjectMainThread(
	target: ApiTarget,
	projectId: string
): Promise<string> {
	const response = await request(
		target,
		`/api/projects/projects/${encodeURIComponent(projectId)}/main-thread`,
		{ method: "POST" },
		ensureProjectMainThreadResponseSchema
	);
	return acknowledgedMainThreadId(response.conversationId);
}

/** Add a bot, Group, or person to a project. */
export function addProjectMember(
	target: ApiTarget,
	projectId: string,
	member: { id: string; kind: ProjectMemberKind; name?: string }
): Promise<ProjectRecord> {
	return request(
		target,
		`/api/projects/projects/${encodeURIComponent(projectId)}/members`,
		{ method: "POST", body: member },
		projectsResponseSchema
	);
}

/** Save a project's model defaults (written through to Core). */
export function saveProjectDefaults(
	target: ApiTarget,
	projectId: string,
	defaults: ScopeDefault
): Promise<ProjectRecord> {
	return request(
		target,
		`/api/projects/projects/${encodeURIComponent(projectId)}/defaults`,
		{ method: "PUT", body: defaults },
		projectsResponseSchema
	);
}
