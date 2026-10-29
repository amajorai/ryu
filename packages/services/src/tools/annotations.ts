// packages/services/src/tools/annotations.ts
//
// The annotation sets the registry's tools share.

import type { RyuToolAnnotations } from "./types.ts";

/** Reads Ryu state and changes nothing. */
export const READ: RyuToolAnnotations = Object.freeze({
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
});

/** Reaches the outside world (sends, runs a model, may bill) and is not safe to repeat. */
export const SEND: RyuToolAnnotations = Object.freeze({
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
});
