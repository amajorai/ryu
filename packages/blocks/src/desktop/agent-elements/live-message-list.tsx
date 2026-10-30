"use client";

import type { UIMessage } from "ai";
import { useMemo, useSyncExternalStore } from "react";
import { MessageList } from "./message-list.tsx";
import type { MessageListProps } from "./message-list-types.ts";
import type { RenderedMessage } from "./utils/native-sdk-observation.ts";

/**
 * A transcript's newer messages, read outside the surface's own render. A host
 * whose page renders from a slower view of the conversation (one that skips
 * per-token text growth) hands the transcript this source, so each streamed
 * chunk re-renders the message list and nothing around it.
 */
export interface LiveMessagesSource {
	/** Messages newer than the surface's `messages` prop, or null when that
	 * prop is already current. Must return the same array until it changes. */
	getSnapshot(): UIMessage[] | null;
	subscribe(listener: () => void): () => void;
}

const NO_LIVE_MESSAGES: LiveMessagesSource = {
	getSnapshot: () => null,
	subscribe: () => () => undefined,
};

export interface LiveMessageListProps extends MessageListProps {
	liveMessages?: LiveMessagesSource;
	/** Extends live messages exactly as the surface extends its own. */
	withTranscriptExtras: (messages: UIMessage[]) => RenderedMessage[];
}

/** MessageList that follows `liveMessages` between the surface's renders. */
export function LiveMessageList({
	liveMessages,
	messages,
	withTranscriptExtras,
	...props
}: LiveMessageListProps) {
	const source = liveMessages ?? NO_LIVE_MESSAGES;
	const live = useSyncExternalStore(
		source.subscribe,
		source.getSnapshot,
		source.getSnapshot
	);
	const resolved = useMemo(
		() => (live ? withTranscriptExtras(live) : messages),
		[live, messages, withTranscriptExtras]
	);
	return <MessageList {...props} messages={resolved} />;
}
