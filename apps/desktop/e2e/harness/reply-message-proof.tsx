import type { UIMessage } from "ai";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentChat } from "../../components/agent-elements/agent-chat.tsx";
import "../../src/index.css";

const MESSAGES = [
	{
		id: "reply-own-message",
		parts: [{ text: "My own message to revisit", type: "text" }],
		role: "user",
	},
	{
		id: "reply-agent-message",
		parts: [
			{
				text: "The agent's answer is ready to quote in a follow-up.",
				type: "text",
			},
		],
		role: "assistant",
	},
	{
		id: "reply-other-message",
		metadata: {
			author: { id: "alex", name: "Alex" },
		},
		parts: [{ text: "Alex's message in the shared chat", type: "text" }],
		role: "user",
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

	return (
		<main
			className="min-h-screen bg-background px-6 py-10 text-foreground"
			data-testid="reply-message-proof"
		>
			<div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
				<header className="space-y-2">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
						Chat message actions
					</p>
					<h1 className="font-semibold text-3xl tracking-tight">
						Reply without selecting text
					</h1>
					<p className="max-w-2xl text-muted-foreground text-sm">
						The same quote composer works from the action icons on your message,
						an agent reply, or another person&apos;s message.
					</p>
				</header>

				<section
					aria-label="Reply message transcript"
					className="h-[590px] overflow-hidden rounded-3xl border border-border/70 bg-card/40 shadow-sm"
				>
					<AgentChat
						assistantAvatar={<AssistantAvatar />}
						assistantName="Ryu"
						currentUser={{ id: "me", name: "You" }}
						initialScrollBehavior="top"
						messages={MESSAGES}
						onClearQuote={() => setQuote(null)}
						onQuote={setQuote}
						onSend={() => undefined}
						onStop={() => undefined}
						quote={quote}
						showCopyToolbar
						status="ready"
					/>
				</section>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
