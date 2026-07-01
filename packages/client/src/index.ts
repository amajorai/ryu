// packages/client/src/index.ts
//
// Public surface of @ryuhq/client. Import createRyuClient and any types you need
// from this single entry point.

export { AgentsAPI } from "./agents.ts";
export { createRyuClient, RyuClient } from "./client.ts";
export { SessionsAPI } from "./sessions.ts";
export { SpacesAPI } from "./spaces.ts";

export type {
	Agent,
	AgentSummary,
	Conversation,
	Message,
	RyuClientOptions,
	Space,
	SpaceMatch,
	StreamChunk,
} from "./types.ts";
