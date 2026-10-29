import {
	replyThreadDescription,
	shouldSuggestReplyThread,
} from "@ryu/blocks/desktop/agent-elements/reply-thread.ts";
import type { MessageReply } from "@ryu/blocks/desktop/agent-elements/types.ts";
import type { UIMessage } from "ai";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentChat } from "../../components/agent-elements/agent-chat.tsx";
import "../../src/index.css";

const MESSAGES = [
	{
		id: "thread-user-1",
		parts: [{ text: "The original product decision", type: "text" }],
		role: "user",
	},
	{
		id: "thread-assistant-1",
		parts: [{ text: "Here is the first answer to revisit.", type: "text" }],
		role: "assistant",
	},
	{
		id: "thread-user-2",
		parts: [{ text: "A follow-up about the implementation", type: "text" }],
		role: "user",
	},
	{
		id: "thread-assistant-2",
		parts: [{ text: "The implementation can stay incremental.", type: "text" }],
		role: "assistant",
	},
	{
		id: "thread-user-3",
		parts: [{ text: "One more question about the trade-off", type: "text" }],
		role: "user",
	},
	{
		id: "thread-assistant-3",
		parts: [
			{ text: "The trade-off is easier to evaluate in context.", type: "text" },
		],
		role: "assistant",
	},
] satisfies UIMessage[];

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
	const [quote, setQuote] = useState<string | null>(null);
	const [reply, setReply] = useState<MessageReply | null>(null);
	const [created, setCreated] = useState(false);

	const handleReply = (next: MessageReply) => {
		setQuote(next.text);
		setReply(shouldSuggestReplyThread(next.chainLength) ? next : null);
	};

	return (
		<main
			className="min-h-screen bg-background px-6 py-10 text-foreground"
			data-testid="reply-thread-proof"
		>
			<div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
				<header className="space-y-2">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
						Focused reply threads
					</p>
					<h1 className="font-semibold text-3xl tracking-tight">
						Reply in context, then split when it gets long
					</h1>
					<p className="max-w-2xl text-muted-foreground text-sm">
						A reply keeps the quoted message in the composer. After three turns,
						the composer offers a focused thread that keeps the earlier context.
					</p>
				</header>

				<section
					aria-label="Reply thread transcript"
					className="h-[590px] overflow-hidden rounded-3xl border border-border/70 bg-card/40 shadow-sm"
				>
					<AgentChat
						assistantAvatar={<AssistantAvatar />}
						assistantName="Ryu"
						currentUser={{ id: "me", name: "You" }}
						infoBar={
							reply
								? {
										action: {
											label: "Create thread",
											onClick: () => {
												setCreated(true);
												setReply(null);
											},
										},
										description: replyThreadDescription(reply.chainLength),
										onClose: () => setReply(null),
										title: "Long reply chain",
									}
								: undefined
						}
						initialScrollBehavior="top"
						messages={MESSAGES}
						onClearQuote={() => {
							setQuote(null);
							setReply(null);
						}}
						onQuote={(text) => {
							setQuote(text);
							setReply(null);
						}}
						onReply={handleReply}
						onSend={() => undefined}
						onStop={() => undefined}
						quote={quote}
						showCopyToolbar
						status="ready"
					/>
				</section>

				{created ? (
					<p
						className="text-center text-muted-foreground text-sm"
						data-testid="thread-created"
					>
						Focused thread created with the quoted context.
					</p>
				) : null}
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
