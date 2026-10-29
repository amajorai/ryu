// packages/client/src/types.ts
//
// Shared type definitions for the @ryuhq/client SDK. Wire shapes from Core use
// snake_case; the SDK surfaces camelCase for TypeScript consumers.

import type { NotifyClientOptions } from "./notify.ts";

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
	/** Realtime transport for the Mail SDK. Core is the default; standalone targets the sidecar directly. */
	mailRealtime?: "core" | "standalone";
	/** Optional standalone Notify connection with its own tenant-scoped API key. */
	notify?: NotifyClientOptions;
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

/**
 * How an agent relates to the user's accounts, mirroring Core's
 * `AgentIdentityMode`: `managed` acts as the user with the accounts they have
 * connected, `individual` has its own accounts and logins and never touches
 * the user's, and `mixed` has its own accounts and can also use the user's
 * accounts that its allowlist permits.
 */
export type AgentIdentityMode = "managed" | "individual" | "mixed";

/** Full agent record returned by GET /api/agents/:id. */
export interface Agent {
	/**
	 * Account keys this agent may use (for example `provider:openai`,
	 * `composio:<connected_account_id>`, `platform:desktop`). `null` means no
	 * allowlist: every account its identity mode permits. `[]` allows none.
	 */
	accountAccess: string[] | null;
	builtIn: boolean;
	createdAt: string | null;
	description: string | null;
	engine: string | null;
	id: string;
	/** Whether the agent acts as the user, has its own identity, or both. */
	identityMode: AgentIdentityMode;
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

/** Fields accepted by `client.agents.create()` (POST /api/agents). */
export interface AgentCreateInput {
	/**
	 * Account allowlist. Omit or pass `null` for no allowlist (every account
	 * the identity mode permits); `[]` allows no accounts.
	 */
	accountAccess?: string[] | null;
	description?: string | null;
	engine?: string | null;
	/** Identity mode. Omit to let Core use its default (`managed`). */
	identityMode?: AgentIdentityMode;
	model?: string | null;
	name: string;
	systemPrompt?: string | null;
	/** Optional role/title badge shown beside the agent name. */
	title?: string;
	/**
	 * Tool/MCP allowlist. Omit for no MCP tools; `["*"]` opts into every
	 * current and future tool.
	 */
	tools?: string[];
}

/**
 * Fields accepted by `client.agents.update()` (PUT /api/agents/:id). Every
 * field is a patch: omit it to leave the saved value unchanged.
 */
export interface AgentUpdateInput {
	/**
	 * Account allowlist patch. Omit to leave unchanged, pass `null` to clear
	 * it back to unrestricted, or pass a list (including `[]`) to replace it.
	 */
	accountAccess?: string[] | null;
	description?: string;
	engine?: string;
	/**
	 * Optimistic-concurrency guard: the `updatedAt` you last loaded. When the
	 * agent changed since, Core rejects the update instead of overwriting it.
	 */
	expectedUpdatedAt?: string;
	identityMode?: AgentIdentityMode;
	model?: string;
	name?: string;
	systemPrompt?: string;
	/** Replaces the role/title. An empty string clears it. */
	title?: string;
	tools?: string[];
}

/**
 * Ryu ghost avatar settings, mirroring Core's `ExpressiveSpec`. Core stores
 * every field opaquely; clients normalize them when rendering.
 */
export interface AgentExpressiveAvatar {
	animated?: boolean;
	/** Named animation or the cycling `random` selection. */
	animation?: string | null;
	animationDuration?: number;
	behavior?: string;
	bodyStyle?: string;
	colors?: Record<string, string>;
	/**
	 * Halloween outfit for the `costume` variant: slot name (`palette`,
	 * `finish`, `eyes`, `headwear`, ...) to option id. Unknown slots or ids
	 * render as the plain ghost.
	 */
	costume?: Record<string, string>;
	/** Named mood or the cycling `random` selection. */
	expression?: string | null;
	eyeScale?: number;
	/** `3d` | `outline` | `outline-muted` | `default` | `expressive` | `costume`. */
	variant?: string;
}

/** Agent presentation and optional output-style personality profile. */
export interface AgentPersona {
	display_name: string | null;
	/** Ryu ghost avatar, including a costume outfit. Null/absent = none. */
	expressive?: AgentExpressiveAvatar | null;
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
