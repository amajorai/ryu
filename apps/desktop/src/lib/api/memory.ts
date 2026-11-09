// apps/desktop/src/lib/api/memory.ts
//
// Typed client for Core's long-term memory endpoints (`/api/memory`). A memory
// is a durable fact/preference/directive the agent recalls across sessions,
// carrying metadata (scope level, category, importance, when-to-use, tags) the
// Memory library in the unified Library surfaces for browse/create/edit/delete.
// Wire shapes are snake_case (see Core's memory handlers); this module maps them
// to camelCase so callers stay idiomatic, and maps back on write. Dream
// (`memory-dream.ts`), Reflect (`memory-reflect.ts`), the graph
// (`memory-graph.ts`) and the Git trace (`memory-git-trace.ts`) have their own
// clients.

import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";

const jsonResponseSchema = z.looseObject({
	include_sensitive_topics: z.boolean().optional(),
});
/** A memory on the wire. Shared with the Dream client (`memory-dream.ts`). */
export const memoriesResponseSchema = z.looseObject({
	author_agent_id: z.union([z.null(), z.string()]).optional(),
	category: z.string().optional(),
	content: z.string(),
	created_at: z.number().optional(),
	id: z.string(),
	importance: z.number().optional(),
	lifecycle: z.string().optional(),
	scope: z.string().optional(),
	scope_id: z.union([z.null(), z.string()]).optional(),
	sensitive_topics: z.array(z.string()).optional(),
	tags: z.array(z.string()).optional(),
	updated_at: z.number().optional(),
	when_to_use: z.union([z.null(), z.string()]).optional(),
});
const jsonResponseSchema2 = z.looseObject({
	memories: z.array(memoriesResponseSchema).optional(),
});
const jsonResponseSchema3 = z.looseObject({ memory: memoriesResponseSchema });
const jsonResponseSchema4 = z.looseObject({ memory: memoriesResponseSchema });
const jsonResponseSchema5 = z.looseObject({ memory: memoriesResponseSchema });
const jsonResponseSchema6 = z.looseObject({
	removed: z.boolean().optional(),
	success: z.boolean().optional(),
});

/**
 * Scope level a memory lives at. `agent` = one agent; `user` = every
 * node/project this user touches;
 * `node` = this machine only; `project` = a specific project/folder (paired with
 * a `scopeId`).
 */
export type MemoryScope = "agent" | "user" | "node" | "project" | "org";

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
export const MEMORY_SCOPES: MemoryScope[] = [
	"agent",
	"user",
	"node",
	"project",
	"org",
];

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
export const MEMORY_SCOPE_LABELS = {
	agent: "Agent",
	user: "User",
	node: "Node",
	project: "Project",
	org: "Organization",
} satisfies Record<MemoryScope, string>;

/**
 * The scope levels in everyday words.
 *
 * "Node" is the one that actually blocks a reader. It is Ryu's term for one
 * installation — this laptop, or a cloud machine you added — and it is the word
 * used everywhere in the product's own plumbing, so it stays as the technical
 * label. But a person deciding where a remembered fact should live is choosing
 * "everywhere I go" versus "only here", and "Node" answers neither question. The
 * rest are already plain and change only enough to read as a set.
 */
export const MEMORY_SCOPE_FRIENDLY_LABELS = {
	agent: "This agent",
	user: "Just me",
	node: "This device",
	project: "This project",
	org: "My organization",
} satisfies Record<MemoryScope, string>;

/** Human labels for the categories. */
export const MEMORY_CATEGORY_LABELS = {
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
} satisfies Record<MemoryCategory, string>;

/**
 * The categories in everyday words.
 *
 * These are the knowledge-representation names for the kinds of thing an agent
 * can remember, and three of them ("Domain knowledge", "Directive", "Procedure")
 * read as a taxonomy rather than as a choice. A user filing something they told
 * their assistant is picking between "a fact about me", "a rule to follow" and
 * "the steps for doing something" — so friendly mode says that. The technical
 * names stay reachable for anyone matching them against the API's category values.
 */
export const MEMORY_CATEGORY_FRIENDLY_LABELS = {
	user_fact: "About me",
	preference: "Preference",
	domain_knowledge: "Subject knowledge",
	organization: "About my organization",
	project_context: "About this project",
	relationship: "People",
	directive: "Rule to follow",
	procedure: "How to do something",
	event: "Something that happened",
	other: "Other",
} satisfies Record<MemoryCategory, string>;

/** Scope labels in the caller's current vocabulary. */
export function memoryScopeLabels(
	friendly: boolean
): Record<MemoryScope, string> {
	return friendly ? MEMORY_SCOPE_FRIENDLY_LABELS : MEMORY_SCOPE_LABELS;
}

/** Category labels in the caller's current vocabulary. */
export function memoryCategoryLabels(
	friendly: boolean
): Record<MemoryCategory, string> {
	return friendly ? MEMORY_CATEGORY_FRIENDLY_LABELS : MEMORY_CATEGORY_LABELS;
}

/** Only `active` memories are recalled; the rest are history: replaced by a
 *  revision, retired by Dream (`archived`), or undone (`retracted`). */
export type MemoryLifecycle =
	| "active"
	| "superseded"
	| "archived"
	| "retracted";

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
	lifecycle: MemoryLifecycle;
	scope: MemoryScope;
	/** The project/folder id when `scope === "project"`, else null. */
	scopeId: string | null;
	/** Special-category topics detected in this memory, if any. */
	sensitiveTopics: string[];
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
	/** Also list superseded, archived and retracted memories. */
	includeHistory?: boolean;
	limit?: number;
	scope?: MemoryScope;
	scopeId?: string;
}
/** A memory in Core's snake_case wire shape. */
export interface MemoryWire {
	author_agent_id?: string | null;
	category?: string;
	content: string;
	created_at?: number;
	id: string;
	importance?: number;
	lifecycle?: string;
	scope?: string;
	scope_id?: string | null;
	sensitive_topics?: string[];
	tags?: string[];
	updated_at?: number;
	when_to_use?: string | null;
}

/** Core create/update payload, using the read contract's existing wire names. */
type MemoryWrite = Partial<
	Pick<
		MemoryWire,
		| "content"
		| "scope"
		| "scope_id"
		| "category"
		| "importance"
		| "when_to_use"
		| "tags"
	>
> & { agent_id?: MemoryCreate["agentId"] };

/** Per-user, per-node memory privacy settings. */
export interface MemorySettings {
	includeSensitiveTopics: boolean;
}

/**
 * Decode a wire scope string.
 *
 * Derived from {@link MEMORY_SCOPES} rather than an inline literal list: the
 * previous hard-coded check silently coerced ANY unrecognized scope to `"user"`,
 * and because {@link MemoryEditor} seeds its form state from the decoded value and
 * writes it straight back on save, merely opening and saving a broader-scoped
 * memory would DOWNGRADE it to private user scope. Widening the union is now
 * enough to keep that from happening again.
 *
 * An unknown scope still falls back to `"user"` — the narrowest, most private
 * level — so a value from a newer node fails closed rather than being displayed
 * as more widely shared than it is.
 */
function toScope(value: string | undefined): MemoryScope {
	return MEMORY_SCOPES.find((scope) => scope === value) ?? "user";
}

function toCategory(value: string | undefined): MemoryCategory {
	return MEMORY_CATEGORIES.find((category) => category === value) ?? "other";
}

const LIFECYCLES: MemoryLifecycle[] = ["superseded", "archived", "retracted"];

/** Nodes from before lifecycles listed only active memories. */
function toLifecycle(value: string | undefined): MemoryLifecycle {
	return LIFECYCLES.find((lifecycle) => lifecycle === value) ?? "active";
}

/** Map a wire memory to the camelCase {@link Memory} the UI uses. */
export function toMemory(m: MemoryWire): Memory {
	return {
		id: m.id,
		content: m.content,
		scope: toScope(m.scope),
		scopeId: m.scope_id ?? null,
		category: toCategory(m.category),
		importance: m.importance ?? MIN_IMPORTANCE,
		lifecycle: toLifecycle(m.lifecycle),
		whenToUse: m.when_to_use ?? null,
		tags: m.tags ?? [],
		authorAgentId: m.author_agent_id ?? null,
		createdAt: m.created_at ?? 0,
		updatedAt: m.updated_at ?? 0,
		sensitiveTopics: m.sensitive_topics ?? [],
	};
}

/** Read the server-authoritative sensitive-topic consent for this node/user. */
export async function getMemorySettings(
	target: ApiTarget
): Promise<MemorySettings> {
	const json = await request(
		target,
		"/api/memory/settings",
		undefined,
		jsonResponseSchema
	);
	return { includeSensitiveTopics: json.include_sensitive_topics ?? false };
}

/** Persist the server-authoritative sensitive-topic consent for this node/user. */
export async function setMemorySettings(
	target: ApiTarget,
	settings: Partial<MemorySettings>
): Promise<MemorySettings> {
	const json = await request(
		target,
		"/api/memory/settings",
		{
			method: "PUT",
			body: {
				include_sensitive_topics: settings.includeSensitiveTopics ?? false,
			},
		},
		jsonResponseSchema
	);
	return {
		includeSensitiveTopics:
			json.include_sensitive_topics ?? settings.includeSensitiveTopics ?? false,
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
	if (query.includeHistory) {
		params.set("include_history", "true");
	}
	const qs = params.toString();
	const json = await request(
		target,
		qs ? `/api/memory?${qs}` : "/api/memory",
		undefined,
		jsonResponseSchema2
	);
	return (json.memories ?? []).map(toMemory);
}

/** Fetch a single memory by id. */
export async function getMemory(
	target: ApiTarget,
	id: string
): Promise<Memory> {
	const json = await request(
		target,
		`/api/memory/${id}`,
		undefined,
		jsonResponseSchema3
	);
	return toMemory(json.memory);
}

/** Create a new memory and return it. */
export async function createMemory(
	target: ApiTarget,
	input: MemoryCreate
): Promise<Memory> {
	const body: MemoryWrite = { content: input.content };
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
	const json = await request(
		target,
		"/api/memory",
		{
			method: "POST",
			body,
		},
		jsonResponseSchema4
	);
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
	const body: MemoryWrite = {};
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
	const json = await request(
		target,
		`/api/memory/${id}`,
		{ method: "PUT", body },
		jsonResponseSchema5
	);
	return toMemory(json.memory);
}

/** Delete a memory. Returns whether a row was removed. */
export async function deleteMemory(
	target: ApiTarget,
	id: string
): Promise<boolean> {
	const json = await request(
		target,
		`/api/memory/${id}`,
		{ method: "DELETE" },
		jsonResponseSchema6
	);
	return json?.removed ?? json?.success ?? false;
}
