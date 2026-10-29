import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMessagesMarker } from "./agent-messages-marker.tsx";

const context = {
	current: { id: "builder", name: "Builder" },
	resolve: (id: string) =>
		({
			marketing: { id: "marketing", name: "Ryu Go-to-Market" },
			reviewer: { id: "reviewer", name: "Ryu Engineering" },
		})[id],
};

function sent(to: string, text: string, toolCallId: string) {
	return {
		input: { text, to },
		output: { from: "builder", ok: true, to },
		state: "output-available",
		toolCallId,
		type: "tool-mcp-agent-comms.agents.send",
	};
}

test("a fan-out reads as one 'Messaged N agents' marker with a roster trigger", () => {
	const markup = renderToStaticMarkup(
		<AgentMessagesMarker
			context={context}
			parts={[
				sent("reviewer", "Ship it?", "call-1"),
				sent("marketing", "Draft the post", "call-2"),
			]}
		/>
	);
	expect(markup).toContain('data-testid="agent-messages-marker"');
	expect(markup).toContain("Messaged");
	expect(markup).toContain("2 agents");
	expect(markup).toContain("Messaged Ryu Engineering, Ryu Go-to-Market");
	// The message text lives in the conversation view, not the transcript line.
	expect(markup).not.toContain("Ship it?");
});

test("a single recipient is named in the marker and opens its conversation", () => {
	const markup = renderToStaticMarkup(
		<AgentMessagesMarker
			context={context}
			parts={[sent("reviewer", "Ship it?", "call-1")]}
		/>
	);
	expect(markup).toContain("Ryu Engineering");
	expect(markup).toContain('aria-haspopup="dialog"');
	expect(markup).not.toContain("agents</span>");
});

test("refused sends are counted on the marker", () => {
	const markup = renderToStaticMarkup(
		<AgentMessagesMarker
			context={context}
			parts={[
				sent("reviewer", "Ship it?", "call-1"),
				{
					input: { text: "Loop", to: "marketing" },
					output: { ok: false, refused: "hop_limit" },
					state: "output-available",
					toolCallId: "call-2",
					type: "tool-mcp-agent-comms.agents.send",
				},
			]}
		/>
	);
	expect(markup).toContain("1 not delivered");
});

test("a call still streaming its arguments shows a pending line", () => {
	const markup = renderToStaticMarkup(
		<AgentMessagesMarker
			chatStatus="streaming"
			context={context}
			parts={[{ input: { to: "reviewer" }, state: "input-streaming" }]}
		/>
	);
	expect(markup).toContain("Messaging an agent…");
});
