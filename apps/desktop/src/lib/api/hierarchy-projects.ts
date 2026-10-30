import { z } from "zod";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
import { type ApiTarget, request } from "./client.ts";
import { acknowledgedMainThreadId } from "./hierarchy-main-thread-id.ts";
import {
	defaultsResponseSchema,
	EMPTY_SCOPE_DEFAULT,
	type ScopeDefault,
} from "./hierarchy-scope-default.ts";

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
