// Standalone browser story for the chat preview rail overflow behavior. It
// mounts the REAL AgentChat surface so the rail is populated by the same
// user-turn TOC data that ChatPage passes through MessageList.

import type { UIMessage } from "ai";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentChat } from "../../components/agent-elements/agent-chat.tsx";
import { ChatDisplayPrefs } from "../../src/components/chat/ChatDisplayPrefsProvider.tsx";
import "../../src/index.css";

const HYDRATION_DELAY_MS = 60;
const TURN_COUNT = 28;

try {
	localStorage.setItem("ryu:open-chat-at-bottom", "true");
	localStorage.setItem("ryu:pin-user-message", "false");
} catch {
	// Persistence is best-effort; the providers fall back to their defaults.
}

function buildHistory(): UIMessage[] {
	const messages: UIMessage[] = [];
	for (let index = 0; index < TURN_COUNT; index += 1) {
		messages.push({
			id: `rail-user-${index}`,
			role: "user",
			parts: [
				{
					type: "text",
					text: `Message ${index + 1}: inspect the preview rail overflow behavior and keep this jump target easy to identify.`,
				},
			],
		});
		messages.push({
			id: `rail-assistant-${index}`,
			role: "assistant",
			parts: [
				{
					type: "text",
					text: `Reply ${index + 1}: this deliberately takes several lines so the transcript is taller than the viewport and the navigation has enough entries to collapse. `.repeat(
						4
					),
				},
			],
		});
	}
	return messages;
}

function Story() {
	const [messages, setMessages] = useState<UIMessage[]>([]);

	useEffect(() => {
		const timer = window.setTimeout(
			() => setMessages(buildHistory()),
			HYDRATION_DELAY_MS
		);
		return () => window.clearTimeout(timer);
	}, []);

	return (
		<div className="flex h-screen flex-col bg-background">
			<div
				data-message-count={messages.length}
				data-testid="story-state"
				data-turn-count={TURN_COUNT}
			/>
			<div className="flex min-h-0 flex-1 flex-col">
				<ChatDisplayPrefs>
					<AgentChat
						conversationKey="conv-preview-rail"
						currentUser={{ id: "me", name: "You" }}
						emptyStatePosition="center"
						messages={messages}
						onSend={() => {
							// This story only exercises navigation.
						}}
						onStop={() => {
							// Required by AgentChatProps; nothing streams here.
						}}
						status="ready"
					/>
				</ChatDisplayPrefs>
			</div>
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
