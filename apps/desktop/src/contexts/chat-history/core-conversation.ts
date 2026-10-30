// Core's conversation wire shapes and their mapping to the desktop
// `Conversation`/`Message` model, plus the authenticated Core fetch helper.

import {
	jsonResponseDocumentSchema,
	type RyuJsonValue,
} from "@ryu/app-host/json-values";
import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { safeValidateUIMessages, type UIMessage } from "ai";
import {
	type AuthenticatedFetchOptions,
	authenticatedFetch,
} from "@/src/lib/api/client.ts";
import { parseContinuedOn } from "@/src/lib/continued-on.ts";
import { toResourceVisibility } from "@/src/lib/resource-visibility.ts";
import type { Conversation, Message, ThreadHierarchy } from "@/types/chat.ts";

// Server-side shape returned by Core's `GET /api/conversations`.
export interface CoreConversationSummary {
	agent_id: string | null;
	archived?: boolean;
	branch: string | null;
	/** RNP handoff marker; parsed by {@link parseContinuedOn}. */
	continued_on?: unknown;
	// Projects › Bots/Groups › Sessions hierarchy (flattened by Core).
	coordination?: string;
	created_at: number;
	folder_path: string | null;
	icon?: GlyphValue;
	id: string;
	/** Only present when the list was fetched with `?preview=1`. */
	last_message?: string;
	last_message_at?: number;
	last_message_role?: string;
	linked_pull_requests?: string[];
	message_count: number;
	owner_id?: string;
	owner_kind?: string;
	participants?: string[];
	pinned?: boolean;
	project_id?: string;
	run_status: string | null;
	spawned_by_conversation_id?: string;
	spawned_by_message_id?: string;
	thread_role?: string;
	title: string | null;
	updated_at: number;
	visibility?: string;
	worktree_path: string | null;
}

// Server-side shape returned by Core's `GET /api/conversations/:id`.
export interface CoreMessage {
	author_name?: string | null;
	author_user_id?: string | null;
	content: string;
	created_at: number;
	id: string;
	/** Set by Core's boot reconciliation on an assistant turn the node died in
	 * the middle of — its text/parts are whatever had been flushed. */
	interrupted?: boolean;
	metadata?: Record<string, RyuJsonValue>;
	origin_server?: string | null;
	parent_message_id?: string;
	/**
	 * Structured render parts (AI SDK reduced UIMessage `parts` array) captured
	 * server-side as an assistant turn streamed. Present only for assistant turns
	 * that ran tools/media after parts capture existed; absent otherwise (the
	 * client falls back to a text part from `content`).
	 */
	parts?: unknown[];
	persisted?: boolean;
	role: string;
	sibling_count?: number;
	sibling_ids?: string[];
	/** Version-tree fields from Core's active-path read. */
	sibling_index?: number;
	source?: string | null;
	widget_instance_id?: string | null;
}

export interface CoreConversationPage {
	has_older_messages?: boolean;
	messages?: CoreMessage[];
	older_messages_cursor?: string | null;
}

export const CHAT_HISTORY_PAGE_SIZE = 40;
// How long a hover/focus prefetch of a conversation's newest page stays usable.
export const HISTORY_PREFETCH_TTL_MS = 10_000;

async function validatedMessageParts(
	message: CoreMessage
): Promise<UIMessage["parts"] | undefined> {
	if (!(Array.isArray(message.parts) && message.parts.length > 0)) {
		return undefined;
	}
	const result = await safeValidateUIMessages({
		messages: [
			{
				id: message.id,
				parts: message.parts,
				role: message.role === "assistant" ? "assistant" : "user",
			},
		],
	});
	return result.success ? result.data[0]?.parts : undefined;
}

export async function mapCoreMessages(
	messages: CoreMessage[] | undefined
): Promise<Message[]> {
	return await Promise.all(
		(messages ?? []).map(async (m) => ({
			author:
				isNativeText(m.author_user_id) && m.author_user_id.trim()
					? {
							id: m.author_user_id,
							name:
								isNativeText(m.author_name) && m.author_name.trim()
									? m.author_name
									: undefined,
						}
					: undefined,
			id: m.id,
			// Every row returned by this history endpoint is already durable. Core's
			// wire shape predates the client-only marker, so do not wait for an
			// optional field that older nodes never send.
			persisted: true,
			role: m.role === "assistant" ? "assistant" : "user",
			content: m.content,
			metadata: jsonResponseDocumentSchema.safeParse(m.metadata).data,
			originServer: isNativeText(m.origin_server) ? m.origin_server : undefined,
			source: m.source ?? undefined,
			// Carry through the structured parts when Core has them, so the
			// chat page can rehydrate tool rows + cowork context instead of
			// only flat text (see ChatPage's hydration).
			parts: await validatedMessageParts(m),
			interrupted: m.interrupted === true,
			siblingIndex: m.sibling_index,
			siblingCount: m.sibling_count,
			siblingIds: m.sibling_ids,
			parentMessageId: m.parent_message_id,
			timestamp: m.created_at,
			widgetInstanceId: isNativeText(m.widget_instance_id)
				? m.widget_instance_id
				: undefined,
		}))
	);
}

export function coreFetch(
	url: string,
	token: string | null | undefined,
	path: string,
	options?: AuthenticatedFetchOptions,
	userJwt?: string | null
): Promise<Response> {
	return authenticatedFetch(
		{ url, token: token ?? null, userJwt: userJwt ?? null },
		path,
		options
	);
}

/** The title a conversation carries until it has been named — the only string
 * `seedTitleFromFirstMessage` is allowed to overwrite. */
export const UNTITLED = "New Chat";
/** Longest derived title, in characters. Matches Core's `derive_title` cap. */
const DERIVED_TITLE_MAX = 60;

/**
 * Mirror of Core's `derive_title` (apps/core/src/server/conversations.rs): the
 * first line of the message, capped at 60 characters with an ellipsis. Core runs
 * the same rule when it persists the turn; doing it client-side too is what makes
 * the sidebar row read as the message *immediately* instead of after the reply
 * lands. The two must stay byte-identical or the title visibly changes under the
 * user when the list refreshes.
 *
 * Returns null for a text-less message (an image- or file-only opener), matching
 * Core's `None` — better an honest placeholder than a title of "".
 */
export function deriveDraftTitle(content: string): string | null {
	const firstLine = content.trim().split("\n")[0]?.trim() ?? "";
	if (!firstLine) {
		return null;
	}
	const chars = [...firstLine];
	return chars.length <= DERIVED_TITLE_MAX
		? firstLine
		: `${chars.slice(0, DERIVED_TITLE_MAX).join("")}…`;
}

export function summaryToConversation(
	summary: CoreConversationSummary
): Conversation {
	return {
		id: summary.id,
		title: summary.title ?? UNTITLED,
		agentId: summary.agent_id ?? undefined,
		participants: summary.participants?.length
			? summary.participants
			: undefined,
		messages: [],
		createdAt: summary.created_at,
		updatedAt: summary.updated_at,
		folderPath: summary.folder_path ?? undefined,
		branch: summary.branch ?? undefined,
		worktreePath: summary.worktree_path ?? undefined,
		runStatus: summary.run_status ?? undefined,
		pinned: summary.pinned ?? false,
		archived: summary.archived ?? false,
		icon: summary.icon ?? null,
		lastMessage: summary.last_message,
		lastMessageRole: summary.last_message_role,
		lastMessageAt: summary.last_message_at,
		linkedPullRequests: summary.linked_pull_requests?.length
			? summary.linked_pull_requests
			: undefined,
		messageCount: summary.message_count,
		visibility: toResourceVisibility(summary.visibility),
		hierarchy: summaryToHierarchy(summary),
		continuedOn: parseContinuedOn(summary.continued_on),
	};
}

function summaryToHierarchy(summary: CoreConversationSummary): ThreadHierarchy {
	const ownerKind = summary.owner_kind;
	return {
		role: summary.thread_role === "main" ? "main" : "session",
		projectId: summary.project_id || undefined,
		ownerKind:
			ownerKind === "agent" || ownerKind === "group" || ownerKind === "project"
				? ownerKind
				: undefined,
		ownerId: summary.owner_id || undefined,
		coordination: summary.coordination || undefined,
		spawnedByConversationId: summary.spawned_by_conversation_id || undefined,
		spawnedByMessageId: summary.spawned_by_message_id || undefined,
	};
}
