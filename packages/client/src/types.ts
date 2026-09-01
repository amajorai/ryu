// packages/client/src/types.ts
//
// Shared type definitions for the @ryuhq/client SDK. Wire shapes from Core use
// snake_case; the SDK surfaces camelCase for TypeScript consumers.

/** Options passed to createRyuClient(). */
export type RyuFetch = (
	input: RequestInfo | URL,
	init?: RequestInit
) => Promise<Response>;

export interface RyuClientOptions {
	/** Base URL of the Core server, e.g. "http://localhost:7980". */
	baseUrl: string;
	/**
	 * HTTP implementation. React Native / Expo apps can pass `expo/fetch` for
	 * response-body streaming; browser, Bun, Deno, and Node use global fetch by
	 * default.
	 */
	fetch?: RyuFetch;
	/** Optional bearer token for authenticated nodes. */
	token?: string;
	/**
	 * Verified end-user JWT for an organization-bound Core. This is deliberately
	 * separate from the node bearer token; Core uses it for per-user/team tenancy.
	 * A provider is evaluated for every request so callers can rotate sessions.
	 */
	userJwt?: string | (() => string | null);
}

/** A lightweight agent summary as returned by GET /api/agents. */
export interface AgentSummary {
	builtIn: boolean;
	createdAt: string | null;
	description: string | null;
	engine: string | null;
	id: string;
	installed: boolean | null;
	installHint: string | null;
	locked: boolean;
	model: string | null;
	name: string;
	systemPrompt: string | null;
	/** Optional role/title badge shown beside the agent name. */
	title: string;
	version: string | null;
}

/** Full agent record returned by GET /api/agents/:id. */
export interface Agent {
	builtIn: boolean;
	createdAt: string | null;
	description: string | null;
	engine: string | null;
	id: string;
	locked: boolean;
	model: string | null;
	name: string;
	/** Persona identity and the reusable personality profile assigned to this agent. */
	persona: AgentPersona | null;
	systemPrompt: string | null;
	/** Optional role/title badge shown beside the agent name. */
	title: string;
	tools: string[];
	updatedAt: string | null;
	version: string;
}

/** Agent presentation and optional output-style personality profile. */
export interface AgentPersona {
	display_name: string | null;
	output_style_id?: string | null;
	tone: string | null;
}

/** A chat message sent to or received from an agent. */
export interface Message {
	content: string;
	role: "user" | "assistant" | "system";
}

/** Controls the flagship Ryu assistant's explanatory vocabulary. */
export type RyuResponseMode = "everyday" | "developer";

/** A single chunk emitted by the SSE stream from /api/chat/stream. */
export interface StreamChunk {
	content?: string;
	type: "text" | "done" | "error";
}

/** The retrieval algorithm Core uses for a Space. */
export type RetrievalMode = "graph" | "vector";

/** A named document collection backed by a sqlite-vec vector store. */
export interface Space {
	/** Unix milliseconds. */
	createdAt: number;
	description: string | null;
	documentCount: number;
	id: string;
	name: string;
	retrievalMode: RetrievalMode;
	/** Unix milliseconds. */
	updatedAt: number;
}

/** A single ranked chunk returned from a Space search. */
export interface SpaceMatch {
	chunkId: string;
	content: string;
	/**
	 * **Do not rank on this field, and do not read magnitudes off it.** It used to
	 * be documented as "squared L2 distance from the query vector", which is only
	 * ever true of one of the three ways a chunk can end up in this array:
	 *
	 * - a vector-mode KNN hit carries its real `vec0` distance (smaller is closer);
	 * - a graph-mode traversal hit is assigned the constant `0.0`;
	 * - a chunk pulled in by `[[page]]`-link expansion (which runs in **both**
	 *   modes) is assigned the constant `1.0`.
	 *
	 * The last two are placeholders, not measurements. On top of that Core's bge
	 * reranker re-orders the survivors **without rewriting `distance`**, so array
	 * order — not this number — is the ranking. Sorting by `distance` un-does the
	 * rerank; averaging or thresholding it mixes a metric with two constants.
	 */
	distance: number;
	documentId: string;
}

/** A conversation session stored by Core. */
export interface Conversation {
	agentId: string | null;
	createdAt: string | null;
	id: string;
	title: string | null;
	updatedAt: string | null;
}
