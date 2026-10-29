import { expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentChat } from "./agent-chat.tsx";

test("renders a host-owned conversation header above the chat stage", () => {
	const markup = renderToStaticMarkup(
		<AgentChat
			conversationHeader={
				<header data-testid="conversation-header">Ryu</header>
			}
			messages={[
				{
					id: "user-1",
					parts: [{ text: "Hello", type: "text" }],
					role: "user",
				} satisfies UIMessage,
			]}
			onSend={() => undefined}
			onStop={() => undefined}
			status="ready"
		/>
	);

	const headerIndex = markup.indexOf('data-testid="conversation-header"');
	const transcriptIndex = markup.indexOf(
		'data-slot="message-scroller-viewport"'
	);

	expect(headerIndex).toBeGreaterThanOrEqual(0);
	expect(transcriptIndex).toBeGreaterThan(headerIndex);
});

test("renders an assistant-only page-tool result", () => {
	const markup = renderToStaticMarkup(
		<AgentChat
			assistantName="Ryu"
			messages={[
				{
					id: "page-tool-result",
					parts: [
						{
							text: "list_agent_skills result: - local skill",
							type: "text",
						},
					],
					role: "assistant",
				} satisfies UIMessage,
			]}
			onSend={() => undefined}
			onStop={() => undefined}
			status="ready"
		/>
	);

	expect(markup).toContain("list_agent_skills result: - local skill");
	expect(markup).toContain('data-transcript-anchor-id="page-tool-result"');
});

test("app context and quoted text stay above an editable composer", () => {
	const markup = renderToStaticMarkup(
		<AgentChat
			composerHeader={<div data-testid="app-context">Selected bolt</div>}
			messages={[]}
			onSend={() => undefined}
			onStop={() => undefined}
			quote="Quoted selection"
			status="ready"
		/>
	);
	const contextIndex = markup.indexOf('data-testid="app-context"');
	const inputIndex = markup.indexOf("<textarea");
	expect(contextIndex).toBeGreaterThanOrEqual(0);
	expect(inputIndex).toBeGreaterThan(contextIndex);
	expect(markup).toContain("Quoted selection");
});
