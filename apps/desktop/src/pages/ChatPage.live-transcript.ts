import type { LiveMessagesSource } from "@ryu/blocks/desktop/agent-elements/live-message-list.tsx";
import type { UIMessage } from "ai";
import { useCallback, useMemo, useRef } from "react";
import type { ChatSession } from "./ChatPage.session.ts";

export interface BlockedChatMessage {
	content: string;
	id: string;
	timestamp: number;
}

/**
 * #403: blocked sends stay visible as user messages after the real ones, even
 * though they were never sent.
 */
export function withBlockedMessages(
	messages: UIMessage[],
	blockedMessages: readonly BlockedChatMessage[]
) {
	if (blockedMessages.length === 0) {
		return messages;
	}
	const blocked = blockedMessages.map((bm) => ({
		id: bm.id,
		role: "user" as const,
		parts: [{ type: "text" as const, text: bm.content }],
		_blocked: true,
	}));
	return [...messages, ...blocked];
}

type VisibleMessages = ReturnType<typeof withBlockedMessages>;

interface LiveTranscriptPipeline<Processed extends UIMessage> {
	blockedMessages: readonly BlockedChatMessage[];
	merged: { messages: readonly UIMessage[] };
	processMessages: (visible: VisibleMessages) => Processed[];
}

/**
 * The transcript's view of the newest streamed messages. Null while the page's
 * own messages are current; otherwise the live messages through the page's
 * pipeline, cached per live snapshot and page render.
 */
function createLiveTranscriptSource(
	session: ChatSession,
	readPipeline: () => LiveTranscriptPipeline<UIMessage>
): LiveMessagesSource {
	let cache: {
		live: UIMessage[];
		pipeline: LiveTranscriptPipeline<UIMessage>;
		rendered: UIMessage[];
	} | null = null;
	return {
		subscribe: session.subscribeLive,
		getSnapshot: () => {
			const live = session.getLiveMessages();
			if (live === session.getPageMessages()) {
				cache = null;
				return null;
			}
			const pipeline = readPipeline();
			if (cache?.live !== live || cache.pipeline !== pipeline) {
				const processed = pipeline.processMessages(
					withBlockedMessages(live, pipeline.blockedMessages)
				);
				cache = {
					live,
					pipeline,
					rendered:
						pipeline.merged.messages.length > 0
							? [...pipeline.merged.messages, ...processed]
							: processed,
				};
			}
			return cache.rendered;
		},
	};
}

/**
 * The live transcript source for AgentChat, and an on-demand read of the newest
 * processed messages (copying the transcript mid-stream copies what is shown).
 */
export function useLiveTranscript<Processed extends UIMessage>(
	session: ChatSession,
	pipeline: LiveTranscriptPipeline<Processed>
) {
	// A new object per page render: the source's cache keys on it, so a page
	// render (new blocked messages, merged threads, labels) refreshes the view.
	const pipelineRef = useRef<LiveTranscriptPipeline<Processed>>(pipeline);
	pipelineRef.current = pipeline;
	const liveTranscriptMessages = useMemo(
		() => createLiveTranscriptSource(session, () => pipelineRef.current),
		[session]
	);
	const readLatestProcessedMessages = useCallback(() => {
		const { blockedMessages, processMessages } = pipelineRef.current;
		return processMessages(
			withBlockedMessages(session.getLiveMessages(), blockedMessages)
		);
	}, [session]);
	return { liveTranscriptMessages, readLatestProcessedMessages } as const;
}
