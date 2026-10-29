import {
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
	request,
} from "@ryuhq/core-client/client";
import { z } from "zod";
import {
	type ConversationWire,
	conversationDate,
	conversationListResponseSchema,
} from "./conversation-response.ts";

const conversationPartsSchema = z.json().optional();
type ConversationParts = z.infer<typeof conversationPartsSchema>;
const forkConversationSchema = z.object({
	conversation: z.object({ id: z.string().min(1) }),
});
const resumedMessageSchema = z.object({
	id: z.string(),
	content: z.string(),
	role: z.string(),
	parts: conversationPartsSchema,
});
const resumedConversationSchema = z.object({
	id: z.string(),
	messages: z.array(resumedMessageSchema),
	title: z.string().nullable().catch(null),
});
const conversationTitleSchema = z.object({ title: z.string().min(1) });
const deletedConversationSchema = z.object({
	removed: z.boolean().catch(false),
});

export interface ResumedConversationMessage {
	content: string;
	id: string;
	parts?: ConversationParts;
	role: string;
}

export interface ResumedConversation {
	id: string;
	messages: ResumedConversationMessage[];
	title: string | null;
}

const conversationCountSchema = z.number().nullable().catch(null);

/** One row of Core's conversation list, normalised for display. */
export interface ConversationRow {
	date: string | null;
	id: string;
	messageCount: number | null;
	title: string;
}

function toConversationRow(wire: ConversationWire): ConversationRow {
	const trimmed = wire.title?.trim();
	const date = conversationDate(wire.updated_at);
	return {
		id: wire.id,
		title: trimmed && trimmed.length > 0 ? trimmed : "untitled",
		messageCount: conversationCountSchema.parse(wire.message_count),
		date: date && date.length > 0 ? date : null,
	};
}

/**
 * List Core's conversations in the order Core returns them (most recent
 * first), optionally capped at `limit`. The response is `{ conversations }` or
 * a bare array; `{}` reads as an empty list. No typed core-client module
 * exposes the bare list, so this reads it through the shared HTTP primitive.
 */
export async function listRecentConversations(
	target: ApiTarget,
	limit?: number
): Promise<ConversationRow[]> {
	const json = await request(
		target,
		"/api/conversations",
		{},
		conversationListResponseSchema
	);
	const rows = Array.isArray(json) ? json : (json.conversations ?? []);
	const capped = limit === undefined ? rows : rows.slice(0, limit);
	return capped.map(toConversationRow);
}

function conversationPath(conversationId: string): string {
	return `/api/conversations/${encodeURIComponent(conversationId)}`;
}

/** Load a persisted conversation so the TUI can resume it. */
export async function resumeConversation(
	target: ApiTarget,
	conversationId: string
): Promise<ResumedConversation> {
	const response = await fetchForTarget(target)(
		apiUrl(target, conversationPath(conversationId)),
		{
			headers: makeHeaders(target.token, target.userJwt),
		}
	);
	if (!response.ok) {
		throw new Error(`Resume conversation failed: ${response.status}`);
	}
	const parsed = resumedConversationSchema.safeParse(await response.json());
	if (!parsed.success) {
		throw new Error("Resume conversation returned an invalid conversation");
	}
	return {
		id: parsed.data.id,
		title: parsed.data.title,
		messages: parsed.data.messages.map((message) => ({
			id: message.id,
			role: message.role,
			content: message.content,
			parts: message.parts,
		})),
	};
}

/** Rename a persisted conversation using Core's user-title endpoint. */
export async function renameConversation(
	target: ApiTarget,
	conversationId: string,
	title: string
): Promise<string> {
	const normalizedTitle = title.trim();
	if (normalizedTitle.length === 0) {
		throw new Error("Conversation title must not be empty");
	}
	const response = await fetchForTarget(target)(
		apiUrl(target, `${conversationPath(conversationId)}/title`),
		{
			method: "POST",
			headers: makeHeaders(target.token, target.userJwt),
			body: JSON.stringify({ title: normalizedTitle }),
		}
	);
	if (!response.ok) {
		throw new Error(`Rename conversation failed: ${response.status}`);
	}
	const parsed = conversationTitleSchema.safeParse(await response.json());
	if (!parsed.success) {
		throw new Error("Rename conversation returned no title");
	}
	return parsed.data.title;
}

/** Permanently delete a conversation through Core. */
export async function deleteConversation(
	target: ApiTarget,
	conversationId: string
): Promise<boolean> {
	const response = await fetchForTarget(target)(
		apiUrl(target, conversationPath(conversationId)),
		{
			method: "DELETE",
			headers: makeHeaders(target.token, target.userJwt),
		}
	);
	if (!response.ok) {
		throw new Error(`Delete conversation failed: ${response.status}`);
	}
	const parsed = deletedConversationSchema.safeParse(await response.json());
	return parsed.success && parsed.data.removed;
}

/** Set the server-backed pinned state for a conversation. */
export async function setConversationPinned(
	target: ApiTarget,
	conversationId: string,
	pinned: boolean
): Promise<void> {
	const response = await fetchForTarget(target)(
		apiUrl(
			target,
			`/api/conversations/${encodeURIComponent(conversationId)}/pinned`
		),
		{
			method: "POST",
			headers: makeHeaders(target.token, target.userJwt),
			body: JSON.stringify({ value: pinned }),
		}
	);
	if (!response.ok) {
		throw new Error(
			`${pinned ? "Pin" : "Unpin"} conversation failed: ${response.status}`
		);
	}
}

/**
 * Fork a conversation on Core. Omitting messageId copies the whole history;
 * Core accepts a message id when the caller wants a branch at a specific turn.
 */
export async function forkConversation(
	target: ApiTarget,
	conversationId: string,
	messageId?: string
): Promise<string> {
	const response = await fetchForTarget(target)(
		apiUrl(
			target,
			`/api/conversations/${encodeURIComponent(conversationId)}/fork`
		),
		{
			method: "POST",
			headers: makeHeaders(target.token, target.userJwt),
			body:
				messageId === undefined
					? undefined
					: JSON.stringify({ message_id: messageId }),
		}
	);
	if (!response.ok) {
		throw new Error(`Fork conversation failed: ${response.status}`);
	}
	const parsed = forkConversationSchema.safeParse(await response.json());
	if (!parsed.success) {
		throw new Error("Fork conversation returned no conversation id");
	}
	return parsed.data.conversation.id;
}
