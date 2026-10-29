import { afterEach, expect, test } from "bun:test";
import {
	type AppResponseValue,
	appResponseValueSchema,
} from "@ryuhq/core-client/app-request-json";
import type { ApiTarget } from "@ryuhq/core-client/client";
import {
	parseChatQuestion,
	respondToChatQuestion,
} from "../core/chatQuestion.ts";

const target: ApiTarget = { token: "secret", url: "http://node:7980" };
const realFetch = globalThis.fetch;

function startQuestionNode(recordBody: (body: AppResponseValue) => void) {
	return Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			recordBody(appResponseValueSchema.parse(await request.json()));
			return Response.json({ resolved: true });
		},
	});
}

const servers: ReturnType<typeof startQuestionNode>[] = [];

afterEach(() => {
	globalThis.fetch = realFetch;
	for (const server of servers.splice(0)) {
		server.stop(true);
	}
});

test("parses normalized Question input and rejects malformed options", () => {
	const question = parseChatQuestion({
		toolCallId: "call-1",
		questions: [
			{
				id: "q-1",
				title: "Pick",
				kind: "single",
				options: [
					{ id: "a", label: "A" },
					{ id: "b", label: "B" },
				],
			},
		],
	});
	expect(question?.toolCallId).toBe("call-1");
	expect(question?.questions[0]?.options).toHaveLength(2);
	expect(
		parseChatQuestion({ toolCallId: "call-1", questions: [{}] })
	).toBeNull();
});

test("posts typed answers to the Core question contract", async () => {
	let body: AppResponseValue;
	const server = startQuestionNode((value) => {
		body = value;
	});
	servers.push(server);
	globalThis.fetch = Object.assign(
		(...args: Parameters<typeof realFetch>) => {
			const request = new Request(...args);
			const url = new URL(request.url);
			return realFetch.call(
				globalThis,
				new Request(
					new URL(`${url.pathname}${url.search}`, server.url),
					request
				)
			);
		},
		{ preconnect: realFetch.preconnect }
	);
	const question = parseChatQuestion({
		toolCallId: "call-2",
		questions: [{ id: "q-1", title: "Name", kind: "text" }],
	});
	expect(question).not.toBeNull();
	await expect(
		respondToChatQuestion(target, "conv-1", question!, [
			{
				kind: "text",
				question_id: "q-1",
				text: "Ryu",
			},
		])
	).resolves.toBe(true);
	expect(body).toEqual({
		answers: [{ kind: "text", question_id: "q-1", text: "Ryu" }],
		conversation_id: "conv-1",
		tool_call_id: "call-2",
	});
});
