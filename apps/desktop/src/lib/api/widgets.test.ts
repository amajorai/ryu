import { afterEach, describe, expect, mock, test } from "bun:test";
import { submitWidgetFollowUp, type WidgetFollowUpInput } from "./widgets.ts";

const originalFetch = globalThis.fetch;

const target = { token: "node-token", url: "http://127.0.0.1:7980" };
const input: WidgetFollowUpInput = {
	instanceId: "wgt-instance",
	prompt: "Use the selected row",
	toolCallId: "tool-call",
};

afterEach(() => {
	mock.restore();
	globalThis.fetch = originalFetch;
});

describe("submitWidgetFollowUp", () => {
	test("submits Core's gated prompt through the supplied chat transport", async () => {
		let requestInit: RequestInit | undefined;
		const fetchMock = mock((_input: URL | RequestInfo, init?: RequestInit) => {
			requestInit = init;
			return Promise.resolve(
				Response.json({
					ok: true,
					ticket: "wft-opaque",
					injected: {
						conversation_id: "conversation-1",
						origin_server: "com.ryu.example",
						prompt: "Use the selected row",
						role: "user",
						source: "widget",
						tool_call_id: "tool-call",
						widget_instance_id: "wgt-instance",
					},
				})
			);
		});
		globalThis.fetch = Object.assign(fetchMock, {
			preconnect: originalFetch.preconnect,
		});
		const sendMessage = mock(async () => undefined);

		await submitWidgetFollowUp(target, input, sendMessage);

		expect(sendMessage).toHaveBeenCalledWith(
			{
				metadata: {
					origin_server: "com.ryu.example",
					source: "widget",
					widget_instance_id: "wgt-instance",
				},
				text: input.prompt,
			},
			{ body: { widget_follow_up_ticket: "wft-opaque" } }
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(requestInit?.body).toBe(
			JSON.stringify({
				instance_id: input.instanceId,
				tool_call_id: input.toolCallId,
				prompt: input.prompt,
			})
		);
	});

	test("does not submit an untrusted or malformed Core response", async () => {
		globalThis.fetch = Object.assign(
			mock(() => Promise.resolve(Response.json({ ok: true, injected: {} }))),
			{ preconnect: originalFetch.preconnect }
		);
		const sendMessage = mock(async () => undefined);

		await expect(
			submitWidgetFollowUp(target, input, sendMessage)
		).rejects.toThrow("invalid widget follow-up envelope");
		expect(sendMessage).not.toHaveBeenCalled();
	});
});
