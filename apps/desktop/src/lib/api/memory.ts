// apps/desktop/src/lib/api/memory.ts
//
// Typed client for Core's long-term memory endpoints (`/api/memory`). A memory
// is a durable fact/preference/directive the agent recalls across sessions,
// carrying metadata (scope level, category, importance, when-to-use, tags) the
// Memory library in the unified Library surfaces for browse/create/edit/delete.
// Wire shapes are snake_case (see Core's memory handlers); this module maps them
// to camelCase so callers stay idiomatic, and maps back on write.

import { type ApiTarget, request } from "./client.ts";

/**
 * Scope level a memory lives at. `user` = every node/project this user touches;
 * `node` = this machine only; `project` = a specific project/folder (paired with
 * a `scopeId`).
 */
export type MemoryScope = "user" | "node" | "project";

/** The classification of a memory, driving how/when it's recalled. */
export type MemoryCategory =
	| "user_fact"
	| "preference"
	| "domain_knowledge"
	| "organization"
	| "project_context"
	| "relationship"
	| "directive"
	| "procedure"
	| "event"
	| "other";

/** Selectable scope levels, in display order. */
export const MEMORY_SCOPES: MemoryScope[] = ["user", "node", "project"];

/** Selectable categories, in display order. */
export const MEMORY_CATEGORIES: MemoryCategory[] = [
	"user_fact",
	"preference",
	"domain_knowledge",
	"organization",
	"project_context",
	"relationship",
	"directive",
	"procedure",
	"event",
	"other",
];

/** Human labels for the scope levels. */
export const MEMORY_SCOPE_LABELS: Record<MemoryScope, string> = {
	user: "User",
	node: "Node",
	project: "Project",
};

/** Human labels for the categories. */
export const MEMORY_CATEGORY_LABELS: Record<MemoryCategory, string> = {
	user_fact: "User fact",
	preference: "Preference",
	domain_knowledge: "Domain knowledge",
	organization: "Organization",
	project_context: "Project context",
	relationship: "Relationship",
	directive: "Directive",
	procedure: "Procedure",
	event: "Event",
	other: "Other",
};

/** The lowest and highest importance a memory can carry (inclusive). */
export const MIN_IMPORTANCE = 1;
export const MAX_IMPORTANCE = 5;

/** A durable long-term memory, mapped to camelCase for the UI. */
export interface Memory {
	/** The agent that authored this memory, or null if user-created. */
	authorAgentId: string | null;
	category: MemoryCategory;
	content: string;
	/** Unix milliseconds. */
	createdAt: number;
	id: string;
	/** 1..5; higher recalls more eagerly. */
	importance: number;
	scope: MemoryScope;
	/** The project/folder id when `scope === "project"`, else null. */
	scopeId: string | null;
	tags: string[];
	/** Unix milliseconds. */
	updatedAt: number;
	/** A hint describing the situations this memory should be recalled in. */
	whenToUse: string | null;
}

/** Fields accepted when creating a memory. Only `content` is required. */
export interface MemoryCreate {
	agentId?: string;
	category?: MemoryCategory;
	content: string;
	importance?: number;
	scope?: MemoryScope;
	scopeId?: string | null;
	tags?: string[];
	whenToUse?: string | null;
}

/**
 * Fields accepted when updating a memory. Every key is optional; omit a key to
 * leave it unchanged. For `scopeId` / `whenToUse`, pass an explicit `null` to
 * CLEAR the stored value (Core distinguishes "absent" from "null").
 */
export interface MemoryUpdate {
	category?: MemoryCategory;
	content?: string;
	importance?: number;
	scope?: MemoryScope;
	scopeId?: string | null;
	tags?: string[];
	whenToUse?: string | null;
}

/** Filters for {@link listMemories}. All optional. */
export interface MemoryQuery {
	category?: MemoryCategory;
	limit?: number;
	scope?: MemoryScope;
	scopeId?: string;
}

interface MemoryWire {
	author_agent_id?: string | null;
	category?: string;
	content: string;
	created_at?: number;
	id: string;
	importance?: number;
	scope?: string;
	scope_id?: string | null;
	tags?: string[];
	updated_at?: number;
	when_to_use?: string | null;
}

function toScope(value: string | undefined): MemoryScope {
	return value === "node" || value === "project" ? value : "user";
}

function toCategory(value: string | undefined): MemoryCategory {
	return MEMORY_CATEGORIES.includes(value as MemoryCategory)
		? (value as MemoryCategory)
		: "other";
}

function toMemory(m: MemoryWire): Memory {
	return {
		id: m.id,
		content: m.content,
		scope: toScope(m.scope),
		scopeId: m.scope_id ?? null,
		category: toCategory(m.category),
		importance: m.importance ?? MIN_IMPORTANCE,
		whenToUse: m.when_to_use ?? null,
		tags: m.tags ?? [],
		authorAgentId: m.author_agent_id ?? null,
		createdAt: m.created_at ?? 0,
		updatedAt: m.updated_at ?? 0,
	};
}

/** List memories, most-recently-updated first, optionally filtered. */
export async function listMemories(
	target: ApiTarget,
	query: MemoryQuery = {}
): Promise<Memory[]> {
	const params = new URLSearchParams();
	if (query.scope) {
		params.set("scope", query.scope);
	}
	if (query.scopeId) {
		params.set("scope_id", query.scopeId);
	}
	if (query.category) {
		params.set("category", query.category);
	}
	if (query.limit !== undefined) {
		params.set("limit", String(query.limit));
	}
	const qs = params.toString();
	const json = await request<{ memories?: MemoryWire[] }>(
		target,
		qs ? `/api/memory?${qs}` : "/api/memory"
	);
	return (json.memories ?? []).map(toMemory);
}

/** Fetch a single memory by id. */
export async function getMemory(
	target: ApiTarget,
	id: string
): Promise<Memory> {
	const json = await request<{ memory: MemoryWire }>(
		target,
		`/api/memory/${id}`
	);
	return toMemory(json.memory);
}

/** Create a new memory and return it. */
export async function createMemory(
	target: ApiTarget,
	input: MemoryCreate
): Promise<Memory> {
	const body: Record<string, unknown> = { content: input.content };
	if (input.scope !== undefined) {
		body.scope = input.scope;
	}
	if (input.scopeId !== undefined) {
		body.scope_id = input.scopeId;
	}
	if (input.category !== undefined) {
		body.category = input.category;
	}
	if (input.importance !== undefined) {
		body.importance = input.importance;
	}
	if (input.whenToUse !== undefined) {
		body.when_to_use = input.whenToUse;
	}
	if (input.tags !== undefined) {
		body.tags = input.tags;
	}
	if (input.agentId !== undefined) {
		body.agent_id = input.agentId;
	}
	const json = await request<{ memory: MemoryWire }>(target, "/api/memory", {
		method: "POST",
		body,
	});
	return toMemory(json.memory);
}

/**
 * Update a memory. Only the keys present in `update` are sent; omitting a key
 * leaves it unchanged. Pass `scopeId: null` / `whenToUse: null` to clear those
 * fields (an explicit `null` is forwarded on the wire).
 */
export async function updateMemory(
	target: ApiTarget,
	id: string,
	update: MemoryUpdate
): Promise<Memory> {
	const body: Record<string, unknown> = {};
	if ("content" in update) {
		body.content = update.content;
	}
	if ("scope" in update) {
		body.scope = update.scope;
	}
	// Presence check (not truthiness) so an explicit null clears the field.
	if ("scopeId" in update) {
		body.scope_id = update.scopeId ?? null;
	}
	if ("category" in update) {
		body.category = update.category;
	}
	if ("importance" in update) {
		body.importance = update.importance;
	}
	if ("whenToUse" in update) {
		body.when_to_use = update.whenToUse ?? null;
	}
	if ("tags" in update) {
		body.tags = update.tags;
	}
	const json = await request<{ memory: MemoryWire }>(
		target,
		`/api/memory/${id}`,
		{ method: "PUT", body }
	);
	return toMemory(json.memory);
}

/** Delete a memory. Returns whether a row was removed. */
export async function deleteMemory(
	target: ApiTarget,
	id: string
): Promise<boolean> {
	const json = await request<{ removed?: boolean; success?: boolean }>(
		target,
		`/api/memory/${id}`,
		{ method: "DELETE" }
	);
	return json?.removed ?? json?.success ?? false;
}
