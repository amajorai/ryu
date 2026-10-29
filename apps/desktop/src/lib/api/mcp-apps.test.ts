import { expect, spyOn, test } from "bun:test";
import { openMcpApp } from "./mcp-apps.ts";

test("pending activation reveals its thread and polls the unchanged idempotent request", async () => {
	const key = "e7a784ef-d1e8-4418-91b3-60f3aab78c2a";
	const bodies: (BodyInit | null | undefined)[] = [];
	let calls = 0;
	const preconnect = globalThis.fetch.preconnect;
	const transport = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			(
				_url: Parameters<typeof fetch>[0],
				options?: Parameters<typeof fetch>[1]
			) => {
				bodies.push(options?.body);
				calls += 1;
				const body =
					calls === 1
						? {
								status: "pending",
								idempotencyKey: key,
								conversationId: "app-conversation",
							}
						: {
								type: "data-tool-widget-available",
								data: {
									conversationId: "app-conversation",
									instanceId: "instance",
									serverId: "server",
									toolCallId: "call",
									toolName: "parts.open",
									toolInput: {},
									toolOutput: {},
									toolResponseMetadata: {},
									widgetAccessible: false,
									widget: {
										html: "<main>Parts</main>",
										mimeType: "text/html;profile=mcp-app",
									},
								},
							};
				return Promise.resolve(
					new Response(JSON.stringify(body), {
						status: calls === 1 ? 202 : 200,
						headers: { "content-type": "application/json" },
					})
				);
			},
			{ preconnect }
		)
	);
	try {
		const pending: (string | undefined)[] = [];
		const part = await openMcpApp(
			{ url: "http://fixture.test", token: "fixture" },
			{ toolId: "server.parts.open", agentId: "agent", idempotencyKey: key },
			{ onPending: (id) => pending.push(id) }
		);
		expect(pending).toEqual(["app-conversation"]);
		expect(part.data?.conversationId).toBe("app-conversation");
		expect(bodies).toHaveLength(2);
		expect(bodies[1]).toBe(bodies[0]);
		expect(String(bodies[0])).not.toContain("conversationId");
	} finally {
		transport.mockRestore();
	}
});

test("an aborted activation cannot fetch or publish another actor's pending thread", async () => {
	const transport = spyOn(globalThis, "fetch");
	const controller = new AbortController();
	controller.abort();
	try {
		await expect(
			openMcpApp(
				{ url: "http://fixture.test", token: "fixture" },
				{
					toolId: "server.parts.open",
					agentId: "agent",
					idempotencyKey: "e7a784ef-d1e8-4418-91b3-60f3aab78c2a",
				},
				{ signal: controller.signal }
			)
		).rejects.toThrow("canceled");
		expect(transport).not.toHaveBeenCalled();
	} finally {
		transport.mockRestore();
	}
});

test("an abort after the pending thread stops polling the opener", async () => {
	const controller = new AbortController();
	const key = "e7a784ef-d1e8-4418-91b3-60f3aab78c2a";
	const preconnect = globalThis.fetch.preconnect;
	const transport = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			() =>
				Promise.resolve(
					new Response(
						JSON.stringify({
							status: "pending",
							idempotencyKey: key,
							conversationId: "app-conversation",
						}),
						{ status: 202 }
					)
				),
			{ preconnect }
		)
	);
	try {
		await expect(
			openMcpApp(
				{ url: "http://fixture.test", token: "fixture" },
				{ toolId: "parts.open", agentId: "agent", idempotencyKey: key },
				{ signal: controller.signal, onPending: () => controller.abort() }
			)
		).rejects.toThrow("canceled");
		expect(transport).toHaveBeenCalledTimes(1);
	} finally {
		transport.mockRestore();
	}
});

test("a pending response cannot attach a different conversation", async () => {
	const key = "e7a784ef-d1e8-4418-91b3-60f3aab78c2a";
	const preconnect = globalThis.fetch.preconnect;
	const pending: string[] = [];
	const transport = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			() =>
				Promise.resolve(
					new Response(
						JSON.stringify({
							status: "pending",
							idempotencyKey: key,
							conversationId: "other-conversation",
						}),
						{ status: 202 }
					)
				),
			{ preconnect }
		)
	);
	try {
		await expect(
			openMcpApp(
				{ url: "http://fixture.test", token: "fixture" },
				{
					toolId: "parts.open",
					agentId: "agent",
					idempotencyKey: key,
					conversationId: "expected-conversation",
				},
				{
					onPending: (id) => {
						if (id) {
							pending.push(id);
						}
					},
				}
			)
		).rejects.toThrow("unexpected conversation");
		expect(pending).toEqual([]);
	} finally {
		transport.mockRestore();
	}
});
