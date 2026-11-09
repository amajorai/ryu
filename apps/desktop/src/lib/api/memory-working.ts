// apps/desktop/src/lib/api/memory-working.ts
//
// Typed client for an agent's working memory history
// (`/api/memory/working/history`): the caller's recent versions of one
// scratchpad, newest first. The wire contract and mapping are shared with
// `@ryuhq/core-client/working-memory`; this module sends the request through
// Desktop's transport so it keeps Desktop's credentials and `ApiError`.

import {
	toWorkingMemoryVersion,
	type WorkingMemoryRef,
	type WorkingMemoryVersion,
	workingMemoryHistoryPath,
	workingMemoryHistorySchema,
} from "@ryuhq/core-client/working-memory.ts";
import { type ApiTarget, request } from "./client.ts";

export type {
	WorkingMemoryRef,
	WorkingMemoryScope,
	WorkingMemoryVersion,
} from "@ryuhq/core-client/working-memory.ts";
export { WORKING_MEMORY_HISTORY_LIMIT } from "@ryuhq/core-client/working-memory.ts";

/**
 * Read the caller's recent versions of a working-memory document, newest
 * first. Core only ever returns the caller's own versions, capped at
 * `WORKING_MEMORY_HISTORY_LIMIT`; `limit` asks for fewer.
 */
export async function getWorkingMemoryHistory(
	target: ApiTarget,
	ref: WorkingMemoryRef,
	limit?: number
): Promise<WorkingMemoryVersion[]> {
	const json = await request(
		target,
		workingMemoryHistoryPath(ref, limit),
		undefined,
		workingMemoryHistorySchema
	);
	return json.versions.map(toWorkingMemoryVersion);
}
