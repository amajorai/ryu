// apps/desktop/src/lib/api/activity.ts
//
// Typed client for the Core activity API (`/api/activity/*`): the unified feed of
// everything the node's modules emit (monitor alerts, quests, approvals,
// meetings, runs, manual notes). Field names are snake_case to match Core's serde
// shapes exactly. The canonical SSE frame codec lives in `@ryuhq/core-client/activity`;
// stream consumers use authenticated fetch so the selected node token is retained.

import {
	type ActivityInput,
	type ActivityItem,
	activityCreateReplySchema,
	activityListReplySchema,
} from "@ryuhq/core-client/activity.ts";
import { type ApiTarget, request } from "./client.ts";

export type {
	ActivityInput,
	ActivityItem,
	ActivityLevel,
} from "@ryuhq/core-client/activity.ts";

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
	const json = await request(target, path, undefined, activityListReplySchema);
	return json.items ?? [];
}

export async function createActivity(
	target: ApiTarget,
	body: ActivityInput
): Promise<ActivityItem> {
	const json = await request(
		target,
		"/api/activity",
		{ method: "POST", body },
		activityCreateReplySchema
	);
	if (!json.item) {
		throw new Error(json.error ?? "failed to create activity item");
	}
	return json.item;
}
