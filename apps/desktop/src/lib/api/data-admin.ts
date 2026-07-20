// apps/desktop/src/lib/api/data-admin.ts
//
// Typed client for Core's "danger zone" bulk-delete endpoints (`/api/data/*`).
// All the actual delete logic lives in Core (`apps/core/src/server/data_admin.rs`);
// this is a thin visual layer. Consumed by the Settings → Danger Zone tab.

import { type ApiTarget, request } from "./client.ts";

/** A category of user data the danger zone can irreversibly wipe. */
export type DataCategory =
	| "chats"
	| "spaces"
	| "memory"
	| "monitors"
	| "meetings";

/** How many items each category currently holds (for the confirm preview). */
export interface DataCounts {
	chats: number;
	meetings: number;
	memory: number;
	monitors: number;
	spaces: number;
}

/** Read the per-category item counts so the UI can say "Delete all 42 chats?". */
export async function fetchDataCounts(target: ApiTarget): Promise<DataCounts> {
	const json = await request<Partial<DataCounts>>(target, "/api/data/counts");
	return {
		chats: json.chats ?? 0,
		spaces: json.spaces ?? 0,
		memory: json.memory ?? 0,
		monitors: json.monitors ?? 0,
		meetings: json.meetings ?? 0,
	};
}

/**
 * Irreversibly delete every item in one category. Returns the number of
 * top-level items removed.
 */
export async function clearDataCategory(
	target: ApiTarget,
	category: DataCategory
): Promise<number> {
	const json = await request<{ removed?: number }>(target, "/api/data/clear", {
		method: "POST",
		body: { category },
	});
	return json?.removed ?? 0;
}
