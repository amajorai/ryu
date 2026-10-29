// Browser proof for the real AgentChat transcript: creating or editing a goal
// appends a user-authored message and the message carries the goal annotation.

import type { UIMessage } from "ai";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentChat } from "../../components/agent-elements/agent-chat.tsx";
import { ChatDisplayPrefs } from "../../src/components/chat/ChatDisplayPrefsProvider.tsx";
import "../../src/index.css";

interface GoalProofMetadata {
	goal?: boolean;
}
type GoalProofMessage = UIMessage<GoalProofMetadata>;

function makeMessage(
	id: string,
	role: UIMessage["role"],
	text: string,
	metadata?: GoalProofMetadata
): GoalProofMessage {
	return {
		id,
		metadata,
		parts: [{ text, type: "text" }],
		role,
	};
}

const initialMessages: GoalProofMessage[] = [
	makeMessage("proof-user", "user", "Show me how goal messages should look."),
	makeMessage(
		"proof-assistant",
		"assistant",
		"A goal is echoed in the transcript as a user message and marked below the bubble."
	),
];

function Story() {
	const [goalDraft, setGoalDraft] = useState(
		"Finish the feature and verify it in the browser."
	);
	const [messages, setMessages] = useState(initialMessages);
	const goalSequence = useRef(0);
	const goalCount = messages.filter(
		(message) => message.metadata?.goal === true
	).length;

	const appendGoalMessage = () => {
		const text = goalDraft.trim();
		if (!text) {
			return;
		}
		const id = `proof-goal-${goalSequence.current}`;
		goalSequence.current += 1;
		setMessages((previous) => [
			...previous,
			makeMessage(id, "user", text, { goal: true }),
		]);
	};

	return (
		<main className="flex h-screen flex-col bg-background text-foreground">
			<header className="shrink-0 border-border border-b bg-card/80 px-6 py-4 backdrop-blur">
				<div className="mx-auto flex max-w-5xl flex-wrap items-end justify-between gap-4">
					<div>
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
							Transcript proof
						</p>
						<h1 className="font-semibold text-xl tracking-tight">
							Goal messages appear in the chat
						</h1>
						<p className="mt-1 max-w-xl text-muted-foreground text-sm">
							Create a goal, then edit it. Each action is represented by a user
							message with the Sent as goal annotation.
						</p>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<label className="sr-only" htmlFor="goal-proof-input">
							Goal text
						</label>
						<input
							className="h-9 min-w-72 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
							data-testid="goal-input"
							id="goal-proof-input"
							onChange={(event) => setGoalDraft(event.target.value)}
							value={goalDraft}
						/>
						<button
							className="h-9 rounded-md bg-primary px-3 font-medium text-primary-foreground text-sm"
							data-testid="create-goal"
							onClick={appendGoalMessage}
							type="button"
						>
							Create goal
						</button>
						<button
							className="h-9 rounded-md border px-3 font-medium text-sm disabled:cursor-not-allowed disabled:opacity-50"
							data-testid="edit-goal"
							disabled={goalCount === 0}
							onClick={appendGoalMessage}
							type="button"
						>
							Edit goal
						</button>
						<output
							className="rounded-full bg-muted px-3 py-1 text-muted-foreground text-xs"
							data-testid="goal-message-count"
						>
							Goal messages: {goalCount}
						</output>
					</div>
				</div>
			</header>
			<section className="min-h-0 flex-1">
				<ChatDisplayPrefs>
					<AgentChat
						conversationKey="goal-message-proof"
						currentUser={{ id: "proof-user", name: "You" }}
						messages={messages}
						onBranch={() => undefined}
						onEditMessage={() => undefined}
						onSend={() => undefined}
						onStop={() => undefined}
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
