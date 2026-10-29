import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentChat } from "./agent-chat.tsx";

const liveCall = {
	actions: <button type="button">End call</button>,
	content: <span>On a call</span>,
};

test("live voice turns take a centered new chat out of the empty state", () => {
	const markup = renderToStaticMarkup(
		<AgentChat
			emptyStatePosition="center"
			messages={[]}
			onSend={() => undefined}
			onStop={() => undefined}
			status="ready"
			voiceMode={{
				active: true,
				liveCall,
				messages: [
					{
						id: "voice-call-u-1",
						metadata: { ryuEphemeral: true },
						parts: [{ text: "What is on my calendar?", type: "text" }],
						role: "user",
					},
				],
			}}
		/>
	);
	expect(markup).toContain('data-chat-state="active"');
	expect(markup).toContain("What is on my calendar?");
});

test("a centered new chat with no voice turns stays empty", () => {
	const markup = renderToStaticMarkup(
		<AgentChat
			emptyStatePosition="center"
			messages={[]}
			onSend={() => undefined}
			onStop={() => undefined}
			status="ready"
			voiceMode={{ active: true, liveCall }}
		/>
	);
	expect(markup).toContain('data-chat-state="empty"');
});
