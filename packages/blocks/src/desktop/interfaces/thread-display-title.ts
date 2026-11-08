import { translate as tr } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { InterfaceThread } from "@ryuhq/protocol/interfaces";

/*
 * Display fallbacks for threads without a title. Interfaces render titles
 * inside `data-ryu-i18n="off"` spans and pass them as `{title}` values into
 * already-translated sentences, where the DOM localizer cannot reach them, so
 * the fallback must be translated before it is handed on. Hooks pass their
 * `tl`; models and helpers fall back to the module translator.
 */

/** The thread's trimmed title, or the localized "Untitled thread". */
export function threadDisplayTitle(
	thread: Pick<InterfaceThread, "title">,
	tl: LiteralMessage = tr
): string {
	return thread.title.trim() || tl("Untitled thread");
}

/** A post or row title, or the localized short "Untitled". */
export function untitledDisplayTitle(
	title: string | null | undefined,
	tl: LiteralMessage = tr
): string {
	return title?.trim() || tl("Untitled");
}

/** The localized "New conversation" heading for a thread not yet started. */
export function newConversationLabel(tl: LiteralMessage = tr): string {
	return tl("New conversation");
}

/** The localized "Conversation" region name used when a thread has no title. */
export function conversationLabel(tl: LiteralMessage = tr): string {
	return tl("Conversation");
}

/** A conversation's trimmed title, or the localized "Untitled conversation". */
export function untitledConversationTitle(
	title: string | null | undefined,
	tl: LiteralMessage = tr
): string {
	return title?.trim() || tl("Untitled conversation");
}

/** A forum topic's trimmed title, or the localized "Untitled topic". */
export function untitledTopicTitle(
	title: string | null | undefined,
	tl: LiteralMessage = tr
): string {
	return title?.trim() || tl("Untitled topic");
}
