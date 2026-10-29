// Standalone browser story for the empty-chat -> active-chat handoff. It mounts
// the real AgentChat and InputBar, then turns one submitted prompt into a small
// transcript so Chromium can measure the SAME composer slot while it moves from
// the centered start page to the bottom of the chat.

import type { ChatStatus, UIMessage } from "ai";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentChat } from "../../components/agent-elements/agent-chat.tsx";
import {
	AppLaunchpadGrid,
	type LaunchpadItem,
} from "../../src/components/chat/AppLaunchpad.tsx";
import { ChatDisplayPrefs } from "../../src/components/chat/ChatDisplayPrefsProvider.tsx";
import "../../src/index.css";

const RESPONSE_DELAY_MS = 900;

const LAUNCHPAD_ITEMS: LaunchpadItem[] = [
	{
		id: "app__browser",
		iconId: "lucide:globe",
		label: "Browser",
		seedId: "@ryu/browser",
	},
	{
		id: "app__drafts",
		iconId: "lucide:file-text",
		label: "Drafts",
		seedId: "@ryu/drafts",
	},
	{
		id: "app__mission",
		iconId: "lucide:radar",
		label: "Mission Control",
		seedId: "@ryu/mission-control",
	},
	{
		id: "app__teams",
		iconId: "lucide:users",
		label: "Teams",
		seedId: "@ryu/teams",
	},
];

function message(
	id: string,
	role: "assistant" | "user",
	text: string
): UIMessage {
	return {
		id,
		parts: [{ text, type: "text" }],
		role,
	};
}

/** A compact stand-in for the real header; its height matches the full greeting
 * so the handoff is measured against the same centered start-page geometry. */
function EmptyHeader() {
	return (
		<div
			className="flex h-42.5 flex-col items-center justify-end gap-2 pb-4"
			data-testid="empty-header"
		>
			<div className="flex size-12 items-center justify-center rounded-2xl bg-primary font-semibold text-primary-foreground text-xl">
				R
			</div>
			<div className="font-medium text-lg">What are we doing?</div>
			<div className="h-7 w-40 rounded-md bg-muted" />
		</div>
	);
}

function Story() {
	const [messages, setMessages] = useState<UIMessage[]>([]);
	const [status, setStatus] = useState<ChatStatus>("ready");

	useEffect(() => {
		console.info(
			`[chat-composer-transition] state=${messages.length === 0 ? "empty" : "active"} status=${status}`
		);
	}, [messages.length, status]);

	const handleSend = useCallback((next: { content: string; role: "user" }) => {
		const userMessage = message("proof-user", "user", next.content);
		setMessages([userMessage]);
		setStatus("submitted");
		console.info("[chat-composer-transition] submitted proof prompt");

		const timer = window.setTimeout(() => {
			setMessages([
				userMessage,
				message(
					"proof-assistant",
					"assistant",
					"The same composer settles below the transcript for the next turn."
				),
			]);
			setStatus("ready");
			console.info("[chat-composer-transition] active chat settled");
		}, RESPONSE_DELAY_MS);

		return () => window.clearTimeout(timer);
	}, []);

	return (
		<div className="flex h-screen flex-col bg-background">
			<div
				aria-live="polite"
				data-message-count={messages.length}
				data-status={status}
				data-testid="story-state"
			>
				<span className="sr-only">
					{messages.length === 0 ? "Empty chat" : "Active chat"}
				</span>
			</div>
			<div className="flex min-h-0 flex-1 flex-col">
				<ChatDisplayPrefs>
					<AgentChat
						assistantName="Ryu"
						attachments={{
							onAttach: () => {
								// The real chat wires the shared + menu to file attachments.
							},
						}}
						currentUser={{ id: "me", name: "You" }}
						emptyStateFooter={
							<AppLaunchpadGrid
								items={LAUNCHPAD_ITEMS}
								onOpen={() => {
									// The proof never launches an app.
								}}
							/>
						}
						emptyStateHeader={<EmptyHeader />}
						emptyStatePosition="center"
						messages={messages}
						onSend={handleSend}
						onStop={() => setStatus("ready")}
						status={status}
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
