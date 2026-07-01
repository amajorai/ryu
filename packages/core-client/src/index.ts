// packages/core-client/src/index.ts
//
// The shared, platform-agnostic Core/Gateway client. Surfaces (desktop, mobile,
// extension) import domain modules by subpath — e.g.
//   import { fetchAgents } from "@ryuhq/core-client/agents"
//   import { type ApiTarget, request } from "@ryuhq/core-client/client"
// This root re-exports only the HTTP primitives so a consumer can pull the
// target/request types without reaching for a subpath. Domain modules are NOT
// re-exported here on purpose (avoid a kitchen-sink barrel — see CLAUDE.md).
export {
	type ApiTarget,
	apiUrl,
	BUYER_TOKEN_HEADER,
	buyerTokenHeader,
	makeHeaders,
	type RequestOptions,
	request,
	setBuyerTokenProvider,
} from "./client.ts";
