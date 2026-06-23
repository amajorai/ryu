// packages/client/src/index.ts
//
// Public surface of @ryu/client. Import createRyuClient and any types you need
// from this single entry point.

export { AgentsAPI } from "./agents";
export { createRyuClient, RyuClient } from "./client";
export { SessionsAPI } from "./sessions";
export { SpacesAPI } from "./spaces";

export type {
	Agent,
	AgentSummary,
	Conversation,
	Message,
	RyuClientOptions,
	Space,
	SpaceMatch,
	StreamChunk,
} from "./types";
