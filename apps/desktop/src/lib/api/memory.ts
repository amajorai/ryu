import { z } from "zod";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
// apps/desktop/src/lib/api/memory.ts
//
// Typed client for Core's long-term memory endpoints (`/api/memory`). A memory
// is a durable fact/preference/directive the agent recalls across sessions,
// carrying metadata (scope level, category, importance, when-to-use, tags) the
// Memory library in the unified Library surfaces for browse/create/edit/delete.
// Wire shapes are snake_case (see Core's memory handlers); this module maps them
// to camelCase so callers stay idiomatic, and maps back on write.

import { ApiError, type ApiTarget, request } from "./client.ts";

const jsonResponseSchema = z.looseObject({
	include_sensitive_topics: z.boolean().optional(),
});
const edgesResponseSchema = z.looseObject({
	kind: z.string(),
	memory_id: z.string(),
	source: z.string(),
	target: z.string(),
	weight: z.number(),
});
const nodesResponseSchema = z.looseObject({
	agent_id: z.string().optional(),
	id: z.string(),
	kind: z.union([
		z.literal("memory"),
		z.literal("topic"),
		z.literal("person"),
		z.literal("category"),
		z.literal("scope"),
		z.literal("agent"),
	]),
	label: z.string(),
	memory_id: z.string().optional(),
	normalized: z.string(),
	scope: z.string().optional(),
	scope_id: z.string().optional(),
	sensitive: z.boolean(),
});
const graphResponseSchema = z.looseObject({
	edges: z.array(edgesResponseSchema).optional(),
	memory_count: z.number().optional(),
	nodes: z.array(nodesResponseSchema).optional(),
	truncated: z.boolean().optional(),
});
const memoriesResponseSchema = z.looseObject({
	author_agent_id: z.union([z.null(), z.string()]).optional(),
	category: z.string().optional(),
	content: z.string(),
	created_at: z.number().optional(),
	id: z.string(),
	importance: z.number().optional(),
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
const commitsResponseSchema = z.looseObject({
	author: z.string(),
	files: z.array(z.string()),
	hash: z.string(),
	subject: z.string(),
	timestamp: z.string(),
});
const jsonResponseSchema7 = z.looseObject({
	commits: z.array(commitsResponseSchema).optional(),
	configured: z.boolean().optional(),
	path: z.string().optional(),
});
const proposalsResponseSchema = z.looseObject({
	created_at: z.number().optional(),
	current: z.union([z.null(), memoriesResponseSchema]).optional(),
	id: z.string(),
	proposed: memoriesResponseSchema,
	reason: z.union([z.null(), z.string()]).optional(),
	source: z.union([z.null(), z.string()]).optional(),
	status: z.string().optional(),
});
const reviewResponseSchema = z.looseObject({
	generated_at: z.number().optional(),
	mode: z.string().optional(),
	proposals: z.array(proposalsResponseSchema).optional(),
	summary: z.union([z.null(), z.string()]).optional(),
});
const jsonResponseSchema8 = z.looseObject({
	review: reviewResponseSchema.optional(),
	proposals: z.array(proposalsResponseSchema).optional(),
});
const jsonResponseSchema9 = z.looseObject({
	review: reviewResponseSchema.optional(),
	proposals: z.array(proposalsResponseSchema).optional(),
});
const jsonResponseSchema10 = z.looseObject({ memory: memoriesResponseSchema });
const settingsResponseSchema = z.looseObject({
	automatic: z.boolean().optional(),
	quiet_hours_end: z.number().optional(),
	quiet_hours_start: z.number().optional(),
});
const jsonResponseSchema11 = z.looseObject({
	settings: settingsResponseSchema.optional(),
});
const jsonResponseSchema12 = z.looseObject({
	settings: settingsResponseSchema.optional(),
});
const activityResponseSchema = z.looseObject({
	count: z.number().optional(),
	label: z.string().optional(),
	trend: z.union([z.null(), z.number()]).optional(),
});
const insightsResponseSchema = z.looseObject({
	body: z.string().optional(),
	id: z.string(),
	title: z.string().optional(),
	tone: z.string().optional(),
});
const topicsResponseSchema = z.looseObject({
	count: z.number().optional(),
	name: z.string(),
	summary: z.union([z.null(), z.string()]).optional(),
});
const getReflectDashboardResponseSchema = z.looseObject({
	activity: z.array(activityResponseSchema).optional(),
	generated_at: z.number().optional(),
	insights: z.array(insightsResponseSchema).optional(),
	period: z.string().optional(),
	topics: z.array(topicsResponseSchema).optional(),
});
const aiFluencyObservationsResponseSchema = z.looseObject({
	detail: z.string().optional(),
	evidence_count: z.number().optional(),
	id: z.string(),
	title: z.string().optional(),
});
const metricsResponseSchema = z.looseObject({
	active_days: z.number().optional(),
	activity_count: z.number().optional(),
	conversation_count: z.number().optional(),
	message_count: z.number().optional(),
});
const periodResponseSchema = z.looseObject({
	from: z.number().optional(),
	to: z.number().optional(),
});
const topicsResponseSchema2 = z.looseObject({
	conversation_count: z.number().optional(),
	label: z.string(),
	message_count: z.number().optional(),
});
const usageResponseSchema = z.looseObject({
	ai_fluency_observations: z
		.array(aiFluencyObservationsResponseSchema)
		.optional(),
	metrics: metricsResponseSchema.optional(),
	period: periodResponseSchema.optional(),
	topics: z.array(topicsResponseSchema2).optional(),
});
const settingsResponseSchema2 = z.looseObject({
	break_nudges: z.boolean().optional(),
	quiet_hours_enabled: z.boolean().optional(),
	quiet_hours_end: z.number().optional(),
	quiet_hours_start: z.number().optional(),
});
const jsonResponseSchema13 = z.looseObject({
	settings: settingsResponseSchema2.optional(),
});
const jsonResponseSchema14 = z.looseObject({
	settings: settingsResponseSchema2.optional(),
});
const usageReviewSettingsResponseSchema = z.looseObject({
	enabled: z.boolean().optional(),
});

/** The refusal Core returns while the opt-in usage review is turned off. */
const USAGE_REVIEW_DISABLED = "usage_review_disabled";
/** Core's default for the Reflect break-nudge preference (off). */
const DEFAULT_BREAK_NUDGES = false;

/** The review cadence Dream can use when it looks for durable memories. */
export type DreamReviewMode = "manual" | "automatic";

/** A time window shown by Reflect. */
export type ReflectPeriod = "7d" | "30d" | "90d";

export const REFLECT_PERIODS: ReflectPeriod[] = ["7d", "30d", "90d"];

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
	limit?: number;
	scope?: MemoryScope;
	scopeId?: string;
}

/** A bounded commit entry from the explicitly configured memory Git source. */
export interface MemoryGitTraceCommit {
	author: string;
	files: string[];
	hash: string;
	subject: string;
	timestamp: string;
}

export interface MemoryGitTrace {
	commits: MemoryGitTraceCommit[];
	configured: boolean;
	path: string;
}

/** A proposed memory returned by Dream before it is written to the store. */
export interface MemoryProposal {
	createdAt: number;
	current: Memory | null;
	id: string;
	proposed: Memory;
	reason: string | null;
	source: string | null;
	status: "pending" | "accepted" | "rejected";
}

export interface DreamReview {
	generatedAt: number;
	mode: DreamReviewMode;
	proposals: MemoryProposal[];
	summary: string | null;
}

export interface DreamSettings {
	automatic: boolean;
	quietHoursEnd: number;
	quietHoursStart: number;
}

export interface ReflectActivity {
	count: number;
	label: string;
	trend: number | null;
}

export interface ReflectTopic {
	count: number;
	name: string;
	summary: string | null;
}

export interface ReflectInsight {
	body: string;
	id: string;
	title: string;
	tone: "positive" | "neutral" | "notice";
}

export interface ReflectDashboard {
	activity: ReflectActivity[];
	generatedAt: number;
	insights: ReflectInsight[];
	period: ReflectPeriod;
	topics: ReflectTopic[];
}

export interface ReflectSettings {
	breakNudges: boolean;
	quietHoursEnabled: boolean;
	quietHoursEnd: number;
	quietHoursStart: number;
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

/** Typed graph projection returned by Core's memory graph endpoint. */
export type MemoryGraphNodeKind =
	| "memory"
	| "topic"
	| "person"
	| "category"
	| "scope"
	| "agent";

export interface MemoryGraphNode {
	agent_id?: string;
	id: string;
	kind: MemoryGraphNodeKind;
	label: string;
	memory_id?: string;
	normalized: string;
	scope?: string;
	scope_id?: string;
	sensitive: boolean;
}

export interface MemoryGraphEdge {
	kind: string;
	memory_id: string;
	source: string;
	target: string;
	weight: number;
}

export interface MemoryGraphSnapshot {
	edges: MemoryGraphEdge[];
	memoryCount: number;
	nodes: MemoryGraphNode[];
	truncated: boolean;
}

interface MemoryProposalWire {
	created_at?: number;
	current?: MemoryWire | null;
	id: string;
	proposed: MemoryWire;
	reason?: string | null;
	source?: string | null;
	status?: string;
}

interface ReflectDashboardWire {
	activity?: Array<{
		count?: number;
		label?: string;
		trend?: number | null;
	}>;
	generated_at?: number;
	insights?: Array<{
		body?: string;
		id: string;
		title?: string;
		tone?: string;
	}>;
	period?: string;
	topics?: Array<{
		count?: number;
		name: string;
		summary?: string | null;
	}>;
}

interface DreamSettingsWire {
	automatic?: boolean;
	quiet_hours_end?: number;
	quiet_hours_start?: number;
}

interface ReflectSettingsWire {
	break_nudges?: boolean;
	quiet_hours_enabled?: boolean;
	quiet_hours_end?: number;
	quiet_hours_start?: number;
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
		sensitiveTopics: m.sensitive_topics ?? [],
	};
}

function toReviewMode(value: string | undefined): DreamReviewMode {
	return value === "automatic" ? "automatic" : "manual";
}

function toProposal(m: MemoryProposalWire): MemoryProposal {
	return {
		createdAt: m.created_at ?? 0,
		current: m.current ? toMemory(m.current) : null,
		id: m.id,
		reason: m.reason ?? null,
		proposed: toMemory(m.proposed),
		source: m.source ?? null,
		status:
			m.status === "accepted" || m.status === "rejected" ? m.status : "pending",
	};
}

function toPeriod(value: string | undefined): ReflectPeriod {
	return REFLECT_PERIODS.find((period) => period === value) ?? "7d";
}

function toTone(value: string | undefined): ReflectInsight["tone"] {
	return value === "positive" || value === "notice" ? value : "neutral";
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

/** Fetch the access-filtered typed graph used by the Memory Library. */
export async function getMemoryGraph(
	target: ApiTarget,
	query: {
		agentId?: string;
		maxEdges?: number;
		maxNodes?: number;
		projectId?: string;
	} = {}
): Promise<MemoryGraphSnapshot> {
	const params = new URLSearchParams();
	if (query.agentId) {
		params.set("agent_id", query.agentId);
	}
	if (query.projectId) {
		params.set("project_id", query.projectId);
	}
	if (query.maxNodes !== undefined) {
		params.set("max_nodes", String(query.maxNodes));
	}
	if (query.maxEdges !== undefined) {
		params.set("max_edges", String(query.maxEdges));
	}
	const suffix = params.toString();
	const graph = await request(
		target,
		suffix ? `/api/memory/graph?${suffix}` : "/api/memory/graph",
		undefined,
		graphResponseSchema
	);
	return {
		edges: graph.edges ?? [],
		memoryCount: graph.memory_count ?? 0,
		nodes: graph.nodes ?? [],
		truncated: graph.truncated ?? false,
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

/** Read recent commits from the configured `memory/` Git source. */
export async function getMemoryGitTrace(
	target: ApiTarget,
	path = "memory",
	limit = 20
): Promise<MemoryGitTrace> {
	const query = new URLSearchParams({ path, limit: String(limit) });
	const json = await request(
		target,
		`/api/memory/git/trace?${query.toString()}`,
		undefined,
		jsonResponseSchema7
	);
	return {
		commits: json.commits ?? [],
		configured: json.configured ?? false,
		path: json.path ?? path,
	};
}

// ── Dream review ──────────────────────────────────────────────────────────────
// These endpoints are intentionally kept in the desktop client until the Core
// surface lands. Keeping the wire contract here lets the UI ship against the
// expected routes without inventing a second transport or leaking snake_case
// into components.

const DREAM_REVIEW_PATH = "/api/memory/dream/review";

export async function getDreamReview(target: ApiTarget): Promise<DreamReview> {
	const json = await request(
		target,
		DREAM_REVIEW_PATH,
		undefined,
		jsonResponseSchema8
	);
	const review = json.review ?? {};
	return {
		generatedAt: review.generated_at ?? 0,
		mode: toReviewMode(review.mode),
		proposals: (review.proposals ?? json.proposals ?? []).map(toProposal),
		summary: review.summary ?? null,
	};
}

export async function runDreamReview(
	target: ApiTarget,
	mode: DreamReviewMode = "manual"
): Promise<DreamReview> {
	const json = await request(
		target,
		DREAM_REVIEW_PATH,
		{ method: "POST", body: { mode } },
		jsonResponseSchema9
	);
	const review = json.review ?? {};
	return {
		generatedAt: review.generated_at ?? Date.now(),
		mode: toReviewMode(review.mode ?? mode),
		proposals: (review.proposals ?? json.proposals ?? []).map(toProposal),
		summary: review.summary ?? null,
	};
}

export async function acceptMemoryProposal(
	target: ApiTarget,
	proposalId: string
): Promise<Memory> {
	const json = await request(
		target,
		`${DREAM_REVIEW_PATH}/proposals/${encodeURIComponent(proposalId)}/accept`,
		{ method: "POST" },
		jsonResponseSchema10
	);
	return toMemory(json.memory);
}

export async function rejectMemoryProposal(
	target: ApiTarget,
	proposalId: string
): Promise<void> {
	await request(
		target,
		`${DREAM_REVIEW_PATH}/proposals/${encodeURIComponent(proposalId)}/reject`,
		{ method: "POST" },
		gatewayJsonValueSchema
	);
}

export async function getDreamSettings(
	target: ApiTarget
): Promise<DreamSettings> {
	const json = await request(
		target,
		`${DREAM_REVIEW_PATH}/settings`,
		undefined,
		jsonResponseSchema11
	);
	const settings = json.settings ?? {};
	return {
		automatic: settings.automatic ?? false,
		quietHoursEnd: settings.quiet_hours_end ?? 8,
		quietHoursStart: settings.quiet_hours_start ?? 22,
	};
}

export async function updateDreamSettings(
	target: ApiTarget,
	settings: Partial<DreamSettings>
): Promise<DreamSettings> {
	const body: DreamSettingsWire = {};
	if (settings.automatic !== undefined) {
		body.automatic = settings.automatic;
	}
	if (settings.quietHoursStart !== undefined) {
		body.quiet_hours_start = settings.quietHoursStart;
	}
	if (settings.quietHoursEnd !== undefined) {
		body.quiet_hours_end = settings.quietHoursEnd;
	}
	const json = await request(
		target,
		`${DREAM_REVIEW_PATH}/settings`,
		{ method: "PATCH", body },
		jsonResponseSchema12
	);
	const next = json.settings ?? {};
	return {
		automatic: next.automatic ?? settings.automatic ?? false,
		quietHoursEnd: next.quiet_hours_end ?? settings.quietHoursEnd ?? 8,
		quietHoursStart: next.quiet_hours_start ?? settings.quietHoursStart ?? 22,
	};
}

// ── Reflect dashboard ─────────────────────────────────────────────────────────

export async function getReflectDashboard(
	target: ApiTarget,
	period: ReflectPeriod
): Promise<ReflectDashboard> {
	let json: ReflectDashboardWire;
	try {
		json = await request(
			target,
			`/api/memory/reflect?period=${encodeURIComponent(period)}`,
			undefined,
			getReflectDashboardResponseSchema
		);
	} catch (error) {
		// Reflect's richer route is additive. Older nodes already expose the
		// privacy-gated usage review, so use it as the activity/topic source until
		// the dedicated Reflect projection is available.
		if (
			!(error instanceof ApiError && [404, 405, 501].includes(error.status))
		) {
			throw error;
		}
		const days = period === "90d" ? 90 : period === "30d" ? 30 : 7;
		const to = Date.now();
		const usage = await request(
			target,
			`/api/usage-review?from=${to - days * 24 * 60 * 60 * 1000}&to=${to}`,
			undefined,
			usageResponseSchema
		);
		const metrics = usage.metrics ?? {};
		json = {
			activity: [
				{
					count: metrics.conversation_count ?? 0,
					label: "Conversations",
					trend: null,
				},
				{ count: metrics.message_count ?? 0, label: "Messages", trend: null },
				{ count: metrics.active_days ?? 0, label: "Active days", trend: null },
			],
			generated_at: usage.period?.to ?? to,
			insights: (usage.ai_fluency_observations ?? []).map((item) => ({
				body: item.detail,
				id: item.id,
				title: item.title,
				tone: "neutral",
			})),
			period,
			topics: (usage.topics ?? []).map((item) => ({
				count: item.conversation_count ?? item.message_count ?? 0,
				name: item.label,
				summary: item.message_count ? `${item.message_count} messages` : null,
			})),
		};
	}
	return {
		activity: (json.activity ?? []).map((item) => ({
			count: item.count ?? 0,
			label: item.label ?? "Activity",
			trend: item.trend ?? null,
		})),
		generatedAt: json.generated_at ?? 0,
		insights: (json.insights ?? []).map((item) => ({
			body: item.body ?? "",
			id: item.id,
			title: item.title ?? "Insight",
			tone: toTone(item.tone),
		})),
		period: toPeriod(json.period ?? period),
		topics: (json.topics ?? []).map((item) => ({
			count: item.count ?? 0,
			name: item.name,
			summary: item.summary ?? null,
		})),
	};
}

/**
 * Whether `error` is Core's `403 usage_review_disabled` refusal. Reflect is a
 * projection of the opt-in usage review, so a node that has not turned usage
 * review on refuses the dashboard with this code rather than failing.
 */
export function isUsageReviewDisabled(error: unknown): boolean {
	return (
		error instanceof ApiError &&
		error.status === 403 &&
		(error.code === USAGE_REVIEW_DISABLED ||
			error.serverMessage === USAGE_REVIEW_DISABLED)
	);
}

/**
 * Turn on the node's opt-in usage review (`PUT /api/usage-review/settings`).
 * Only `enabled` is sent, so existing exclusions are kept. Resolves to the
 * node's persisted `enabled` value.
 */
export async function enableUsageReview(target: ApiTarget): Promise<boolean> {
	const json = await request(
		target,
		"/api/usage-review/settings",
		{ method: "PUT", body: { enabled: true } },
		usageReviewSettingsResponseSchema
	);
	return json.enabled ?? false;
}

export async function getReflectSettings(
	target: ApiTarget
): Promise<ReflectSettings> {
	const json = await request(
		target,
		"/api/memory/reflect/settings",
		undefined,
		jsonResponseSchema13
	);
	const settings = json.settings ?? {};
	return {
		breakNudges: settings.break_nudges ?? DEFAULT_BREAK_NUDGES,
		quietHoursEnabled: settings.quiet_hours_enabled ?? true,
		quietHoursEnd: settings.quiet_hours_end ?? 8,
		quietHoursStart: settings.quiet_hours_start ?? 22,
	};
}

export async function updateReflectSettings(
	target: ApiTarget,
	settings: Partial<ReflectSettings>
): Promise<ReflectSettings> {
	const body: ReflectSettingsWire = {};
	if (settings.breakNudges !== undefined) {
		body.break_nudges = settings.breakNudges;
	}
	if (settings.quietHoursEnabled !== undefined) {
		body.quiet_hours_enabled = settings.quietHoursEnabled;
	}
	if (settings.quietHoursStart !== undefined) {
		body.quiet_hours_start = settings.quietHoursStart;
	}
	if (settings.quietHoursEnd !== undefined) {
		body.quiet_hours_end = settings.quietHoursEnd;
	}
	const json = await request(
		target,
		"/api/memory/reflect/settings",
		{ method: "PATCH", body },
		jsonResponseSchema14
	);
	const next = json.settings ?? {};
	return {
		breakNudges:
			next.break_nudges ?? settings.breakNudges ?? DEFAULT_BREAK_NUDGES,
		quietHoursEnabled:
			next.quiet_hours_enabled ?? settings.quietHoursEnabled ?? true,
		quietHoursEnd: next.quiet_hours_end ?? settings.quietHoursEnd ?? 8,
		quietHoursStart: next.quiet_hours_start ?? settings.quietHoursStart ?? 22,
	};
}
