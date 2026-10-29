import { describe, expect, test } from "bun:test";
import {
	isSessionToolPart,
	sessionCardModel,
} from "./session-card-tool-logic.ts";

describe("session card", () => {
	test("recognises threads tool calls in every part shape", () => {
		expect(isSessionToolPart("dynamic-tool", "threads.create_thread")).toBe(
			true
		);
		expect(isSessionToolPart("tool-threads.send_message_to_thread")).toBe(true);
		expect(isSessionToolPart("dynamic-tool", "ryu.threads.create_thread")).toBe(
			true
		);
		expect(isSessionToolPart("dynamic-tool", "threads.read_thread")).toBe(
			false
		);
		expect(isSessionToolPart("tool-Bash")).toBe(false);
	});

	test("a created session reads as starting with its title and bot", () => {
		const model = sessionCardModel({
			input: { agent_id: "scout", title: "Audit PRs" },
			output: { ok: true, thread_id: "conv-1", title: "Audit PRs" },
			state: "output-available",
			toolName: "threads.create_thread",
			type: "dynamic-tool",
		});
		expect(model).toMatchObject({
			agentId: "scout",
			status: "starting",
			threadId: "conv-1",
			title: "Audit PRs",
		});
	});

	test("a dispatched message runs; a waited one is done with its reply", () => {
		const running = sessionCardModel({
			input: { message: "Go", thread_id: "conv-1" },
			output: {
				dispatched: true,
				ok: true,
				status: "running",
				thread_id: "conv-1",
			},
			state: "output-available",
			toolName: "threads.send_message_to_thread",
			type: "dynamic-tool",
		});
		expect(running?.status).toBe("running");
		const done = sessionCardModel({
			input: { thread_id: "conv-1", wait: true },
			output: {
				content: [
					{
						text: JSON.stringify({
							ok: true,
							reply: "All green.\nDetails",
							thread_id: "conv-1",
						}),
						type: "text",
					},
				],
			},
			state: "output-available",
			toolName: "threads.send_message_to_thread",
			type: "dynamic-tool",
		});
		expect(done).toMatchObject({ latest: "All green.", status: "done" });
	});

	test("a refused call is failed", () => {
		expect(
			sessionCardModel({
				output: { error: "not found", ok: false },
				state: "output-available",
				toolName: "threads.send_message_to_thread",
				type: "dynamic-tool",
			})?.status
		).toBe("failed");
	});
});

test("native inherited session fields retain independent fallback and opaque metadata", () => {
	class SessionReply {
		get thread_id() {
			return 123;
		}
		get title() {
			return "   ";
		}
		get reply() {
			return "\n Finished audit.\nMore detail";
		}
		get metadata() {
			throw new Error("unrelated native metadata must remain unread");
		}
	}
	const model = sessionCardModel({
		type: "threads.send_message_to_thread",
		state: "output-available",
		input: { thread_id: "input-thread", title: "Input title" },
		output: new SessionReply(),
	});
	expect(model).toMatchObject({
		threadId: "input-thread",
		title: "Input title",
		latest: "Finished audit.",
		status: "done",
	});
});

test("first native text envelope takes precedence even when its text is malformed", () => {
	let textReads = 0;
	const first = {
		get text() {
			textReads += 1;
			return "invalid-json";
		},
	};
	const model = sessionCardModel({
		type: "threads.create_thread",
		state: "output-available",
		input: { title: "Input fallback" },
		output: {
			content: [null, {}, first, { text: '{"title":"later text"}' }],
			title: "Outer title",
		},
	});
	expect(model?.title).toBe("Input fallback");
	expect(textReads).toBe(1);
});
