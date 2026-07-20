// apps/desktop/src/lib/api/activity.ts
//
// Typed client for the Core activity API (`/api/activity/*`): the unified feed of
// everything the node's modules emit (monitor alerts, quests, approvals,
// meetings, runs, manual notes). Field names are snake_case to match Core's serde
// shapes exactly. The live SSE stream lives in `activityStream.ts` and, following
// the repo convention, uses fetch + ReadableStream (not EventSource) so the node
// bearer token can ride as an `Authorization` header.

import { type ApiTarget, request } from "./client.ts";

export type ActivityLevel = "info" | "success" | "warning";

/** One record in the activity feed (mirrors Core's `ActivityItem`). */
export interface ActivityItem {
	agent_id: string | null;
	body: string | null;
	created_at: number;
	id: string;
	kind: string;
	level: ActivityLevel;
	metadata: Record<string, unknown>;
	session_id: string | null;
	source: string;
	title: string;
}

/** Body for `POST /api/activity`; `source` defaults to `"manual"` in Core. */
export interface ActivityInput {
	agent_id?: string | null;
	body?: string | null;
	kind: string;
	level?: ActivityLevel;
	metadata?: Record<string, unknown>;
	session_id?: string | null;
	source?: string;
	title: string;
}

export interface ListActivityOptions {
	before?: number;
	limit?: number;
}

export async function listActivity(
	target: ApiTarget,
	options: ListActivityOptions = {}
): Promise<ActivityItem[]> {
	const params = new URLSearchParams();
	if (options.limit !== undefined) {
		params.set("limit", String(options.limit));
	}
	if (options.before !== undefined) {
		params.set("before", String(options.before));
	}
	const query = params.toString();
	const path = query ? `/api/activity?${query}` : "/api/activity";
	const json = await request<{ items?: ActivityItem[] }>(target, path);
	return json.items ?? [];
}

export async function createActivity(
	target: ApiTarget,
	body: ActivityInput
): Promise<ActivityItem> {
	const json = await request<{ item?: ActivityItem; error?: string }>(
		target,
		"/api/activity",
		{ method: "POST", body }
	);
	if (!json.item) {
		throw new Error(json.error ?? "failed to create activity item");
	}
	return json.item;
}
