import {
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
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

import type { ResourceVisibility } from "@/src/lib/resource-visibility.ts";
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
			{ method: "POST", body: { value } },
			responseCodec1
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
 * Marks the title user-chosen so auto-rename never overwrites it. Resolves false
 * on any transport failure so the caller can keep its optimistic local title and
 * not block the UI.
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
			{ method: "POST", body: { title } },
			responseCodec2
		);
		return true;
	} catch {
		return false;
	}
}

/** Assign a conversation to a workspace folder, or detach it with `null`. */
export async function setConversationFolder(
	target: ApiTarget,
	id: string,
	folderPath: string | null
): Promise<boolean> {
	try {
		await request<{ ok?: boolean }>(
			target,
			`/api/conversations/${encodeURIComponent(id)}/folder`,
			{ method: "POST", body: { folder_path: folderPath } },
			responseCodec3
		);
		return true;
	} catch {
		return false;
	}
}

/**
 * Link or unlink a GitHub pull request to a conversation
 * (`POST /api/conversations/:id/pull-requests`). Resolves to the conversation's
 * full linked list. Throws so the caller can show Core's validation message.
 */
export async function setConversationPullRequestLinked(
	target: ApiTarget,
	id: string,
	url: string,
	linked: boolean
): Promise<string[]> {
	const response = await request(
		target,
		`/api/conversations/${encodeURIComponent(id)}/pull-requests`,
		{ method: "POST", body: { linked, url } },
		linkedPullRequestsResponseCodec
	);
	return (response.linked_pull_requests ?? []).filter(
		(value): value is string => isNativeText(value)
	);
}

/** One past title for a conversation (`GET /api/conversations/:id/title-history`). */
export interface TitleHistoryEntry {
	createdAt: number;
	id: string;
	/** `"auto"` | `"user"` | `"derived"`. */
	source: string;
	title: string;
}

/**
 * Fetch title history for a conversation (oldest → newest). Returns `[]` on
 * failure so hover previews stay quiet.
 */
export async function getConversationTitleHistory(
	target: ApiTarget,
	id: string
): Promise<TitleHistoryEntry[]> {
	try {
		const res = await request<{
			history?: Array<{
				created_at?: number;
				id?: string;
				source?: string;
				title?: string;
			}>;
		}>(
			target,
			`/api/conversations/${encodeURIComponent(id)}/title-history`,
			undefined,
			responseCodec4
		);
		const rows = Array.isArray(res.history) ? res.history : [];
		return rows.flatMap((row) => {
			if (
				!(
					isNativeText(row.id) &&
					isNativeText(row.title) &&
					isNativeText(row.source) &&
					isNativeNumber(row.created_at)
				)
			) {
				return [];
			}
			return [
				{
					id: row.id,
					title: row.title,
					source: row.source,
					createdAt: row.created_at,
				},
			];
		});
	} catch {
		return [];
	}
}

/**
 * Set or clear a conversation glyph (`POST /api/conversations/:id/icon`).
 * Resolves false on any transport failure so the caller can keep its optimistic
 * local glyph and not block the UI.
 */
export async function setConversationIcon(
	target: ApiTarget,
	id: string,
	icon: unknown | null
): Promise<boolean> {
	try {
		await request<{ ok?: boolean }>(
			target,
			`/api/conversations/${encodeURIComponent(id)}/icon`,
			{ method: "POST", body: { icon } },
			responseCodec5
		);
		return true;
	} catch {
		return false;
	}
}

/** Set a conversation's private or shared visibility. */
export async function setConversationVisibility(
	target: ApiTarget,
	id: string,
	visibility: ResourceVisibility,
	teamId?: string | null
): Promise<boolean> {
	try {
		await request<{ ok?: boolean }>(
			target,
			`/api/conversations/${encodeURIComponent(id)}/visibility`,
			{
				method: "POST",
				body: {
					visibility,
					...(visibility === "team" && teamId
						? { team_id: teamId }
						: undefined),
				},
			},
			responseCodec6
		);
		return true;
	} catch {
		return false;
	}
}

/** Regenerate a title on demand; rejects so callers can display the model failure. */
export async function regenerateConversationTitle(
	target: ApiTarget,
	id: string
): Promise<string> {
	const result = await request<{ title?: string }>(
		target,
		`/api/conversations/${encodeURIComponent(id)}/retitle`,
		{ method: "POST" },
		responseCodec7
	);
	const title = result.title?.trim();
	if (!title) {
		throw new Error("No title was generated");
	}
	return title;
}

// Response codecs validate the consumed native DTO fields and retain JSON extension fields.
const responseCodec1 = z
	.object({ ok: z.boolean().optional() })
	.catchall(gatewayJsonValueSchema);
const responseCodec2 = z
	.object({ ok: z.boolean().optional() })
	.catchall(gatewayJsonValueSchema);
const responseCodec3 = z
	.object({ ok: z.boolean().optional() })
	.catchall(gatewayJsonValueSchema);
const responseCodec4 = z
	.object({
		history: z
			.array(
				z
					.object({
						created_at: z.number().optional(),
						id: z.string().optional(),
						source: z.string().optional(),
						title: z.string().optional(),
					})
					.catchall(gatewayJsonValueSchema)
			)
			.optional(),
	})
	.catchall(gatewayJsonValueSchema);
const responseCodec5 = z
	.object({ ok: z.boolean().optional() })
	.catchall(gatewayJsonValueSchema);
const responseCodec6 = z
	.object({ ok: z.boolean().optional() })
	.catchall(gatewayJsonValueSchema);
const responseCodec7 = z
	.object({ title: z.string().optional() })
	.catchall(gatewayJsonValueSchema);
const linkedPullRequestsResponseCodec = z
	.object({
		linked_pull_requests: z.array(gatewayJsonValueSchema).optional(),
	})
	.catchall(gatewayJsonValueSchema);
