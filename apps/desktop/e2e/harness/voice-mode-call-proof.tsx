import {
	InputBar,
	type InputBarProps,
} from "@ryu/blocks/desktop/agent-elements/input-bar.tsx";
import type { ChatStatus, UIMessage } from "ai";
import { ThemeProvider } from "next-themes";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentChat } from "../../components/agent-elements/agent-chat.tsx";
import { ChatDisplayPrefs } from "../../src/components/chat/ChatDisplayPrefsProvider.tsx";
import { useVoiceLiveCall } from "../../src/components/voice/VoiceCallComposer.tsx";
import type { VoiceMode } from "../../src/hooks/useVoiceMode.ts";
import "../../src/index.css";

const LEVELS = [
	0.12, 0.24, 0.46, 0.32, 0.76, 0.58, 0.9, 0.42, 0.68, 0.3, 0.5, 0.22,
];

const TURNS: VoiceMode["turns"] = [
	{
		id: "u-1",
		role: "user",
		text: "Can you walk me through the next step?",
	},
	{
		id: "a-1",
		role: "assistant",
		text: "Absolutely. I will keep the next step focused and easy to follow.",
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

function ProofInputBar(props: InputBarProps) {
	return (
		<InputBar
			{...props}
			voice={{ transcribe: async () => "" }}
			voiceMode={{ onStart: () => undefined }}
		/>
	);
}

function Proof() {
	const [elapsedSeconds, setElapsedSeconds] = useState(84);
	const [messages, setMessages] = useState<UIMessage[]>([]);
	const [muted, setMuted] = useState(false);
	const [status, setStatus] = useState<ChatStatus>("ready");
	const [voiceActive, setVoiceActive] = useState(true);

	useEffect(() => {
		if (!voiceActive) {
			return;
		}
		const timer = window.setInterval(
			() => setElapsedSeconds((current) => current + 1),
			1000
		);
		return () => window.clearInterval(timer);
	}, [voiceActive]);

	const voice: VoiceMode = {
		agentName: "Ryu Assistant",
		active: voiceActive,
		caption: "",
		error: null,
		elapsedSeconds,
		interrupt: () => undefined,
		levels: muted ? Array.from({ length: 24 }, () => 0) : LEVELS,
		muted,
		phase: "listening",
		start: () => undefined,
		stop: () => setVoiceActive(false),
		toggleMute: () => setMuted((current) => !current),
		transcript: "",
		turns: TURNS,
	};
	const voiceMode = useVoiceLiveCall(voice);
	const handleSend = useCallback((next: { content: string; role: "user" }) => {
		setMessages([message("proof-user", "user", next.content)]);
		setStatus("ready");
	}, []);

	return (
		<ChatDisplayPrefs>
			<div className="flex h-screen flex-col bg-background">
				<output className="sr-only" data-testid="voice-text-sent">
					{messages.at(-1)?.parts[0]?.type === "text"
						? messages.at(-1)?.parts[0]?.text
						: ""}
				</output>
				<AgentChat
					attachments={{ onAttach: () => undefined }}
					messages={messages}
					onSend={handleSend}
					onStop={() => setStatus("ready")}
					slots={{ InputBar: ProofInputBar }}
					status={status}
					voiceMode={voiceMode}
				/>
			</div>
		</ChatDisplayPrefs>
	);
}

createRoot(document.getElementById("root")!).render(
	<ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
		<Proof />
	</ThemeProvider>
);
