// Standalone proof for the live chat status row. It mounts the real MessageList
// with the same "user message + streaming turn" shape that produces the
// production planning row, so the screenshot proves the integration rather than
// only a standalone icon.

import { ChatDisplayPrefsProvider } from "@ryu/blocks/desktop/agent-elements/chat-display-prefs.tsx";
import type { UIMessage } from "ai";
import { createRoot } from "react-dom/client";
import { MessageList } from "../../components/agent-elements/message-list.tsx";
import "../../src/index.css";

const MESSAGES = [
	{
		id: "typing-indicator-user",
		role: "user",
		parts: [
			{
				type: "text",
				text: "Can you summarize the latest project updates?",
			},
		],
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
	return (
		<ChatDisplayPrefsProvider value={{ hideToolDetail: false }}>
			<main className="min-h-screen bg-background px-6 py-10 text-foreground">
				<div className="mx-auto max-w-3xl space-y-5">
					<header className="space-y-1">
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
							Live chat state
						</p>
						<h1 className="font-semibold text-2xl tracking-tight">
							A familiar typing cue
						</h1>
						<p className="text-muted-foreground text-sm">
							The live reply keeps its place in the transcript with a speech
							bubble and three animated dots.
						</p>
					</header>

					<section
						aria-label="Live chat transcript"
						className="h-[360px] overflow-hidden rounded-2xl border bg-card shadow-sm"
						data-testid="typing-indicator-proof"
					>
						<MessageList
							assistantAvatar={<AssistantAvatar />}
							assistantName="Ryu"
							currentUser={{ id: "me", name: "You" }}
							initialScrollBehavior="top"
							messages={MESSAGES}
							status="streaming"
						/>
					</section>
				</div>
			</main>
		</ChatDisplayPrefsProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
