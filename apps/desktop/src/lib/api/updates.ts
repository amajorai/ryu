// apps/desktop/src/lib/api/updates.ts
//
// Public control-plane feed of recent blog posts and changelog entries from
// Notion (packages/api `/api/updates/recent`). No auth required — same source
// as the marketing site's blog/changelog pages.

import { BACKEND_URL } from "@/lib/auth-client.ts";

export type RecentUpdateKind = "blog" | "changelog";

export type RecentUpdateItem =
	| {
			kind: "blog";
			id: string;
			title: string;
			slug: string;
			date: string;
			tag?: string;
	  }
	| {
			kind: "changelog";
			id: string;
			title: string;
			slug: string;
			date: string;
			version: string;
			type: string;
	  };

export interface RecentUpdatesResponse {
	items: RecentUpdateItem[];
}

const BASE = `${BACKEND_URL.replace(/\/$/, "")}/api/updates`;

/** Fetch the merged recent blog + changelog feed (newest first). */
export async function fetchRecentUpdates(options?: {
	limit?: number;
	kind?: RecentUpdateKind;
}): Promise<RecentUpdateItem[]> {
	const params = new URLSearchParams();
	if (options?.limit) {
		params.set("limit", String(options.limit));
	}
	if (options?.kind) {
		params.set("kind", options.kind);
	}

	const query = params.toString();
	const url = query ? `${BASE}/recent?${query}` : `${BASE}/recent`;
	const resp = await fetch(url);
	if (!resp.ok) {
		throw new Error(`Failed to load updates: ${resp.status}`);
	}

	const json = (await resp.json()) as RecentUpdatesResponse;
	return json.items ?? [];
}
