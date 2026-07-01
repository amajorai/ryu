// packages/client/src/client.ts
//
// RyuClient: the top-level entry point for the @ryuhq/client SDK. Instantiates
// each domain API class and exposes them as typed namespaces on the client.
//
// Usage:
//   import { createRyuClient } from "@ryuhq/client";
//   const client = createRyuClient({ baseUrl: "http://localhost:7980" });
//   for await (const chunk of client.agents.stream("pi", messages)) { ... }

import { AgentsAPI } from "./agents.ts";
import { SessionsAPI } from "./sessions.ts";
import { SpacesAPI } from "./spaces.ts";
import type { RyuClientOptions } from "./types.ts";

export class RyuClient {
	/** Agent CRUD and chat streaming. */
	readonly agents: AgentsAPI;
	/** Conversation session listing and retrieval. */
	readonly sessions: SessionsAPI;
	/** Spaces / RAG document collection search. */
	readonly spaces: SpacesAPI;

	constructor(options: RyuClientOptions) {
		this.agents = new AgentsAPI(options);
		this.sessions = new SessionsAPI(options);
		this.spaces = new SpacesAPI(options);
	}
}

/**
 * Create a new RyuClient connected to a Core instance.
 *
 * @example
 * ```ts
 * const client = createRyuClient({ baseUrl: "http://localhost:7980" });
 * const agents = await client.agents.list();
 * ```
 */
export function createRyuClient(options: RyuClientOptions): RyuClient {
	return new RyuClient(options);
}
