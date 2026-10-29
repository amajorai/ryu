import { describe, expect, it } from "bun:test";
import {
	agentMessageDelivery,
	isAgentMessageToolPart,
	readAgentMessagePayload,
	summarizeAgentMessageRun,
} from "./agent-message-tool-logic.ts";

describe("agent message transcript tool", () => {
	it("recognizes MCP send/ask parts without catching other tools", () => {
		expect(isAgentMessageToolPart("tool-mcp-agent-comms.agents.send")).toBe(
			true
		);
		expect(isAgentMessageToolPart("dynamic-tool", "agents.send")).toBe(true);
		expect(isAgentMessageToolPart("tool-mcp-agent-comms.agents.ask")).toBe(
			true
		);
		expect(isAgentMessageToolPart("tool-mcp-mail.send")).toBe(false);
	});

	it("reads the message from input and the host-derived sender from output", () => {
		expect(
			readAgentMessagePayload({
				input: { text: "The deploy is ready.", to: "research" },
				output: [
					{
						text: JSON.stringify({ from: "builder", ok: true, to: "research" }),
						type: "text",
					},
				],
			})
		).toEqual({
			from: "builder",
			kind: "send",
			text: "The deploy is ready.",
			to: "research",
		});
	});

	it("supports streamed JSON inputs before a result is available", () => {
		expect(
			readAgentMessagePayload({
				input: '{"text":"Still working","to":"reviewer"}',
				state: "input-available",
			})
		).toEqual({
			kind: "send",
			text: "Still working",
			to: "reviewer",
		});
	});

	it("reads an ask question and its returned peer reply", () => {
		expect(
			readAgentMessagePayload({
				input: {
					question: "Can you review the migration?",
					to: "reviewer",
				},
				output: {
					from: "builder",
					question: "Can you review the migration?",
					reply: "The migration is safe to ship.",
					to: "reviewer",
				},
				type: "tool-mcp-agent-comms.agents.ask",
			})
		).toEqual({
			from: "builder",
			kind: "ask",
			reply: "The migration is safe to ship.",
			text: "Can you review the migration?",
			to: "reviewer",
		});
	});

	it("waits for both the recipient and message before rendering a bubble", () => {
		expect(readAgentMessagePayload({ input: { to: "reviewer" } })).toBeNull();
		expect(readAgentMessagePayload({ input: { text: "hello" } })).toBeNull();
	});

	it("treats a Switchboard refusal and an unfinished call outside a live turn as undelivered", () => {
		const refused = {
			input: { text: "Loop back", to: "builder" },
			output: { ok: false, refused: "hop_limit" },
			state: "output-available",
		};
		expect(agentMessageDelivery(refused)).toBe("failed");
		const unfinished = {
			input: { text: "Hi", to: "builder" },
			state: "input-available",
		};
		expect(agentMessageDelivery(unfinished, "streaming")).toBe("sending");
		expect(agentMessageDelivery(unfinished)).toBe("failed");
		expect(
			agentMessageDelivery({ ...unfinished, state: "output-available" })
		).toBe("sent");
	});

	it("folds a fan-out into one conversation per recipient in first-contact order", () => {
		const summary = summarizeAgentMessageRun(
			[
				{
					input: { text: "Ship it?", to: "reviewer" },
					output: { from: "builder", ok: true, to: "reviewer" },
					state: "output-available",
					toolCallId: "call-1",
				},
				{
					input: { text: "Draft the post", to: "marketing" },
					output: { ok: false, refused: "hop_limit" },
					state: "output-available",
					toolCallId: "call-2",
				},
				{
					input: { text: "Also check the migration", to: "reviewer" },
					state: "input-available",
					toolCallId: "call-3",
				},
				{ input: { to: "ops" }, state: "input-streaming" },
			],
			"streaming"
		);
		expect(summary.peers.map((peer) => peer.peer)).toEqual([
			"reviewer",
			"marketing",
		]);
		const [reviewer, marketing] = summary.peers;
		expect(reviewer?.from).toBe("builder");
		expect(reviewer?.delivery).toBe("sending");
		expect(reviewer?.entries.map((entry) => entry.key)).toEqual([
			"call-1",
			"call-3",
		]);
		expect(marketing?.delivery).toBe("failed");
		expect(summary.unreadable).toEqual([{ delivery: "sending" }]);
	});
});
