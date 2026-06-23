// packages/client/src/types.ts
//
// Shared type definitions for the @ryu/client SDK. Wire shapes from Core use
// snake_case; the SDK surfaces camelCase for TypeScript consumers.

/** Options passed to createRyuClient(). */
export interface RyuClientOptions {
	/** Base URL of the Core server, e.g. "http://localhost:7980". */
	baseUrl: string;
	/** Optional bearer token for authenticated nodes. */
	token?: string;
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
	systemPrompt: string | null;
	tools: string[];
	updatedAt: string | null;
	version: string;
}

/** A chat message sent to or received from an agent. */
export interface Message {
	content: string;
	role: "user" | "assistant" | "system";
}

/** A single chunk emitted by the SSE stream from /api/chat/stream. */
export interface StreamChunk {
	content?: string;
	type: "text" | "done" | "error";
}

/** A named document collection backed by a sqlite-vec vector store. */
export interface Space {
	/** Unix milliseconds. */
	createdAt: number;
	description: string | null;
	documentCount: number;
	id: string;
	name: string;
	/** Unix milliseconds. */
	updatedAt: number;
}

/** A ranked chunk returned from a Space KNN search. */
export interface SpaceMatch {
	chunkId: string;
	content: string;
	/** Squared L2 distance from the query vector (smaller is closer). */
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
