/* @jsxImportSource @opentui/react */
import { afterEach, expect, test } from "bun:test";
import { TextareaRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { act } from "react";
import { z } from "zod";
import { App } from "../App.tsx";

const chatRequestFieldsSchema = z.looseObject({
	acp_config: z.record(z.string(), z.string()).optional(),
	acp_mode: z.string().optional(),
	acp_model: z.string().optional(),
	agent_id: z.string().optional(),
	conversation_id: z.string().optional(),
	enable_long_term: z.boolean(),
	messages: z.array(
		z.looseObject({
			role: z.enum(["user", "assistant"]),
			content: z.array(
				z.looseObject({ type: z.literal("text"), text: z.string() })
			),
		})
	),
	plugin_flags: z.record(z.string(), z.boolean()).optional(),
	team_id: z.string().optional(),
	workflow_id: z.string().optional(),
});
type ChatRequestObservation = z.infer<typeof chatRequestFieldsSchema>;
const chatRequestObservationSchema = z.custom<ChatRequestObservation>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		chatRequestFieldsSchema.safeParse(value).success
);

const nativeBodyString = z.string();
const realFetch = globalThis.fetch;
let setup: Awaited<ReturnType<typeof testRender>> | null = null;

afterEach(() => {
	setup?.renderer.destroy();
	setup = null;
	globalThis.fetch = realFetch;
});

test("pasted terminal input followed immediately by Enter submits the complete prompt", async () => {
	let captured: ChatRequestObservation | undefined;
	const fakeFetch = (
		...args: Parameters<typeof fetch>
	): ReturnType<typeof fetch> => {
		const [input, init] = args;
		const url = input instanceof Request ? input.url : String(input);
		if (url.endsWith("/api/chat/stream")) {
			const body = nativeBodyString.safeParse(init?.body);
			captured = chatRequestObservationSchema.parse(
				JSON.parse(body.success ? body.data : "{}")
			);
			return Promise.resolve(
				new Response('data: {"type":"finish"}\n\n', {
					headers: { "Content-Type": "text/event-stream" },
				})
			);
		}
		return Promise.resolve(new Response("Unavailable", { status: 404 }));
	};
	globalThis.fetch = Object.assign(fakeFetch, {
		preconnect: realFetch.preconnect,
	});
	setup = await testRender(
		<App target={{ url: "http://127.0.0.1:19000", token: null }} />,
		{ width: 120, height: 34 }
	);
	await setup.renderOnce();
	const input = setup.renderer.currentFocusedRenderable;
	if (!(input instanceof TextareaRenderable)) {
		throw new Error("Chat composer was not focused");
	}
	act(() => {
		input.insertText("Verify Ryu in Herdr");
		setup?.mockInput.pressEnter();
	});
	for (let frame = 0; frame < 20 && captured === undefined; frame++) {
		await setup.renderOnce();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	expect(captured).toMatchObject({
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: "Verify Ryu in Herdr" }],
			},
		],
	});
});
