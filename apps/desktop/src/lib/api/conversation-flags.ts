// apps/desktop/src/lib/api/conversation-flags.ts
//
// Typed client for the server-backed pin/archive flags on a conversation
// (`POST /api/conversations/:id/pinned` and `/archived`). These write the same
// columns the coordinator `threads` tool sets, so a pin made in the desktop
// surfaces to every client (and a coordinator-pinned worker thread shows here).
//
// Both calls are best-effort: they resolve to `false` on any transport failure
// so the caller can keep its optimistic local state and not block the UI. The
// localStorage mirror in the sidebar remains the offline fallback.

import { type ApiTarget, request } from "./client.ts";

async function setFlag(
	target: ApiTarget,
	id: string,
	flag: "pinned" | "archived",
	value: boolean
): Promise<boolean> {
	try {
		await request<{ ok?: boolean }>(
			target,
			`/api/conversations/${encodeURIComponent(id)}/${flag}`,
			{ method: "POST", body: { value } }
		);
		return true;
	} catch {
		return false;
	}
}

/** Pin or unpin a conversation server-side. Resolves false on failure. */
export function setConversationPinned(
	target: ApiTarget,
	id: string,
	value: boolean
): Promise<boolean> {
	return setFlag(target, id, "pinned", value);
}

/** Archive or unarchive a conversation server-side. Resolves false on failure. */
export function setConversationArchived(
	target: ApiTarget,
	id: string,
	value: boolean
): Promise<boolean> {
	return setFlag(target, id, "archived", value);
}

/**
 * Manually rename a conversation server-side (`POST /api/conversations/:id/title`).
 * Marks the title user-chosen so Core's background auto-namer never overwrites
 * it. Resolves false on any transport failure so the caller can keep its
 * optimistic local title and not block the UI.
 */
export async function setConversationTitle(
	target: ApiTarget,
	id: string,
	title: string
): Promise<boolean> {
	try {
		await request<{ ok?: boolean }>(
			target,
			`/api/conversations/${encodeURIComponent(id)}/title`,
			{ method: "POST", body: { title } }
		);
		return true;
	} catch {
		return false;
	}
}
