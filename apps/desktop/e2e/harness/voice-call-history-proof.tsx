import {
	InputBar,
	type InputBarProps,
} from "@ryu/blocks/desktop/agent-elements/input-bar.tsx";
import type { UIMessage } from "ai";
import { ThemeProvider } from "next-themes";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentChat } from "../../components/agent-elements/agent-chat.tsx";
import { ChatDisplayPrefs } from "../../src/components/chat/ChatDisplayPrefsProvider.tsx";
import { useVoiceLiveCall } from "../../src/components/voice/VoiceCallComposer.tsx";
import { useVoiceMode } from "../../src/hooks/useVoiceMode.ts";
import "../../src/index.css";

function ProofInputBar(props: InputBarProps) {
	return <InputBar {...props} voice={{ transcribe: async () => "" }} />;
}

function Proof() {
	const conversationId =
		new URLSearchParams(window.location.search).get("conversation") ??
		"voice-history-proof";
	const [messages, setMessages] = useState<UIMessage[]>([]);
	const voice = useVoiceMode(
		{ url: window.location.origin, token: null },
		{
			conversationId,
			agentName: "Ryu Assistant",
			onCallEnded: (summary) => {
				setMessages((current) =>
					current.some((message) => message.id === summary.messageId)
						? current
						: [
								...current,
								{
									id: summary.messageId,
									role: "user",
									parts: [{ type: "text", text: summary.content }],
								},
							]
				);
			},
		}
	);
	useEffect(() => {
		const live = new URLSearchParams(window.location.search).has("live");
		fetch(live ? `/api/conversations/${conversationId}` : "/proof-history")
			.then((response) => response.json())
			.then((history) => {
				if (!live) {
					setMessages(history);
					return;
				}
				setMessages(
					(history.messages ?? []).map(
						(message: {
							id: string;
							role: UIMessage["role"];
							content: string;
						}) => ({
							id: message.id,
							role: message.role,
							parts: [{ type: "text", text: message.content }],
						})
					)
				);
			})
			.catch(() => setMessages([]));
	}, [conversationId]);
	const voiceLiveCall = useVoiceLiveCall(voice);
	return (
		<ChatDisplayPrefs>
			<div className="flex h-screen flex-col bg-background">
				<header className="flex items-center justify-between border-b px-6 py-3 text-sm">
					<span className="font-medium">Ryu Assistant</span>
					<button
						className="rounded-lg bg-muted px-3 py-2"
						onClick={voice.start}
						type="button"
					>
						Start voice call
					</button>
				</header>
				{voice.error ? (
					<p className="px-6 text-status-destructive" role="alert">
						{voice.error}
					</p>
				) : null}
				<AgentChat
					messages={messages}
					onSend={() => undefined}
					onStop={() => undefined}
					slots={{ InputBar: ProofInputBar }}
					status="ready"
					voiceMode={voiceLiveCall}
				/>
			</div>
		</ChatDisplayPrefs>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
			<Proof />
		</ThemeProvider>
	);
}
