// packages/client/src/index.ts
//
// Public surface of @ryuhq/client. Import createRyuClient and any types you need
// from this single entry point.

export { type AgentRunOptions, AgentsAPI } from "./agents.ts";
export { createRyuClient, RyuClient } from "./client.ts";
export { SessionsAPI } from "./sessions.ts";
export {
	type RetrievalModeCancellation,
	type RetrievalModeChange,
	type RetrievalModeJob,
	type RetrievalModeStatus,
	SpacesAPI,
} from "./spaces.ts";

export type {
	Agent,
	AgentSummary,
	Conversation,
	Message,
	RetrievalMode,
	RyuClientOptions,
	RyuFetch,
	RyuResponseMode,
	Space,
	SpaceMatch,
	StreamChunk,
} from "./types.ts";
