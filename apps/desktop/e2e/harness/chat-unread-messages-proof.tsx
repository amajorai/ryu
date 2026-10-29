// Standalone browser proof for the production MessageList unread affordance.
// The controls below simulate a reader leaving the live edge, incoming replies
// arriving, a streamed reply growing in place, and the reader reaching the
// unread boundary.

import { ChatDisplayPrefsProvider } from "@ryu/blocks/desktop/agent-elements/chat-display-prefs.tsx";
import type { ChatStatus, UIMessage } from "ai";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageList } from "../../components/agent-elements/message-list.tsx";
import "../../src/index.css";

const INITIAL_TURN_COUNT = 12;

function userMessage(id: string, text: string): UIMessage {
	return {
		id,
		role: "user",
		parts: [{ type: "text", text }],
	};
}

function assistantMessage(id: string, text: string): UIMessage {
	return {
		id,
		role: "assistant",
		parts: [{ type: "text", text }],
	};
}

function buildHistory(): UIMessage[] {
	const messages: UIMessage[] = [];
	for (let index = 0; index < INITIAL_TURN_COUNT; index += 1) {
		messages.push(
			userMessage(
				`unread-proof-user-${index}`,
				`Question ${index + 1}: keep the transcript readable while I inspect an earlier answer.`
			)
		);
		messages.push(
			assistantMessage(
				`unread-proof-assistant-${index}`,
				`Reply ${index + 1}: this intentionally spans several lines so the reader can leave the live edge. `.repeat(
					4
				)
			)
		);
	}
	return messages;
}

function AssistantAvatar() {
	return (
		<span
			aria-hidden="true"
			className="flex size-full items-center justify-center rounded-full bg-primary/12 font-semibold text-primary text-xs"
		>
			R
		</span>
	);
}

function Story() {
	const [messages, setMessages] = useState<UIMessage[]>(buildHistory);
	const [status, setStatus] = useState<ChatStatus>("ready");
	const [replyBatch, setReplyBatch] = useState(0);

	const leaveLiveEdge = () => {
		const viewport = document.querySelector<HTMLElement>(
			'[data-slot="message-scroller-viewport"]'
		);
		if (!viewport) {
			return;
		}
		viewport.scrollTo({ top: 0, behavior: "auto" });
		viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
	};

	const receiveReplies = () => {
		const nextBatch = replyBatch + 1;
		setReplyBatch(nextBatch);
		setStatus("ready");
		setMessages((current) => [
			...current,
			assistantMessage(
				`unread-proof-assistant-new-${nextBatch}-1`,
				"A new reply arrived while you were reading above."
			),
			assistantMessage(
				`unread-proof-assistant-new-${nextBatch}-2`,
				"Here is another incoming reply with the latest context."
			),
			assistantMessage(
				`unread-proof-assistant-new-${nextBatch}-3`,
				"The third reply is included in the same unread boundary."
			),
		]);
	};

	const startStreamingReply = () => {
		setStatus("streaming");
		setMessages((current) => [
			...current,
			assistantMessage(
				"unread-proof-assistant-stream",
				"A streamed reply has started."
			),
		]);
	};

	const growStreamingReply = () => {
		setMessages((current) =>
			current.map((message) =>
				message.id === "unread-proof-assistant-stream"
					? assistantMessage(
							message.id,
							"A streamed reply has started and now has more text, but it is still one message."
						)
					: message
			)
		);
	};

	return (
		<ChatDisplayPrefsProvider
			value={{ hideToolDetail: false, pinUserMessage: false }}
		>
			<main className="flex h-screen flex-col bg-background text-foreground">
				<header className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-2 px-5 py-4">
					<div className="mr-auto min-w-0">
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
							Message list proof
						</p>
						<h1 className="font-semibold text-lg tracking-tight">
							Unread incoming replies
						</h1>
					</div>
					<button
						className="rounded-full border border-border px-3 py-1.5 font-medium text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						data-testid="leave-live-edge"
						onClick={leaveLiveEdge}
						type="button"
					>
						Scroll up
					</button>
					<button
						className="rounded-full border border-border px-3 py-1.5 font-medium text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						data-testid="receive-replies"
						onClick={receiveReplies}
						type="button"
					>
						Receive 3 replies
					</button>
					<button
						className="rounded-full border border-border px-3 py-1.5 font-medium text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						data-testid="start-streaming-reply"
						onClick={startStreamingReply}
						type="button"
					>
						Start streaming
					</button>
					<button
						className="rounded-full border border-border px-3 py-1.5 font-medium text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						data-testid="grow-streaming-reply"
						onClick={growStreamingReply}
						type="button"
					>
						Add streamed text
					</button>
					<button
						className="rounded-full border border-border px-3 py-1.5 font-medium text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						data-testid="finish-streaming-reply"
						onClick={() => setStatus("ready")}
						type="button"
					>
						Finish stream
					</button>
				</header>
				<div
					className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col overflow-hidden border-border border-x bg-card"
					data-testid="unread-message-proof"
				>
					<MessageList
						assistantAvatar={<AssistantAvatar />}
						assistantName="Ryu"
						conversationKey="unread-proof-conversation"
						currentUser={{ id: "me", name: "You" }}
						messages={messages}
						status={status}
					/>
				</div>
				<div
					aria-live="polite"
					className="sr-only"
					data-message-count={messages.length}
					data-status={status}
					data-testid="story-state"
				/>
			</main>
		</ChatDisplayPrefsProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
