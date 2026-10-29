import type { UIMessage } from "ai";
import { createRoot } from "react-dom/client";
import { AgentChat } from "../../components/agent-elements/agent-chat.tsx";
import { ChatDisplayPrefs } from "../../src/components/chat/ChatDisplayPrefsProvider.tsx";
import type { createMessageDecorator } from "../../src/lib/chat-message-decoration.ts";
import "../../src/index.css";

type DatedFixtureMessage = ReturnType<
	ReturnType<typeof createMessageDecorator<UIMessage>>
>[number];

const startedAt = Date.UTC(2026, 0, 1, 0, 0, 0);
const achievedAt = startedAt + 4 * 60 * 60 * 1000 + 2 * 1000;

const messages = [
	{
		createdAt: new Date(startedAt),
		id: "goal-proof-user",
		parts: [{ text: "Finish the release checklist.", type: "text" }],
		role: "user",
	},
	{
		createdAt: new Date(achievedAt),
		id: "goal-proof-assistant",
		parts: [
			{
				text: "The release checklist is complete and the final result is ready.",
				type: "text",
			},
		],
		role: "assistant",
	},
] satisfies DatedFixtureMessage[];

function Story() {
	return (
		<main className="flex h-screen flex-col bg-background text-foreground">
			<header className="shrink-0 border-border border-b bg-card/80 px-6 py-4 backdrop-blur">
				<p className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
					Ending-turn proof
				</p>
				<h1 className="font-semibold text-xl tracking-tight">
					Goal completion stays with the finished reply
				</h1>
			</header>
			<section className="min-h-0 flex-1">
				<ChatDisplayPrefs>
					<AgentChat
						assistantName="Ryu"
						conversationKey="goal-completion-proof"
						currentUser={{ id: "proof-user", name: "You" }}
						goalCompletion={{
							achievedAt,
							messageId: "goal-proof-assistant",
							startedAt,
						}}
						initialScrollBehavior="bottom"
						messages={messages}
						onBranch={() => undefined}
						onSend={() => undefined}
						onStop={() => undefined}
						showCopyToolbar
						status="ready"
					/>
				</ChatDisplayPrefs>
			</section>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
