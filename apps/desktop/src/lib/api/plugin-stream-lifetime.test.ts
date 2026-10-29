import { expect, mock, test } from "bun:test";

let response: Response;
let requestedPath = "";
mock.module("./client.ts", () => ({
	ApiError: class ApiError extends Error {},
	authenticatedFetch: (_target: unknown, path: string) => {
		requestedPath = path;
		return Promise.resolve(response);
	},
	buyerTokenHeader: () => ({}),
	makeHeaders: () => ({}),
	identityHeaders: () => ({}),
	request: () => Promise.resolve({}),
}));
const { pluginHostInvokeStream, ownAppEventStream } = await import(
	"./plugins.ts"
);
const target = { url: "http://fixture.test", token: null };
function source(text: string, closed = false) {
	let cancelled = 0;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			if (closed) {
				controller.close();
			}
		},
		cancel() {
			cancelled += 1;
		},
	});
	response = new Response(body);
	return { body, cancelled: () => cancelled };
}
const delta = (value: string) =>
	`data: ${JSON.stringify({ type: "text-delta", delta: value })}\n\n`;
const invoke = (
	kind: "host" | "app",
	onChunk: (value: string) => void,
	signal?: AbortSignal
) =>
	kind === "host"
		? pluginHostInvokeStream(target, "fixture", {}, { onChunk, signal })
		: ownAppEventStream(target, "@ryu/fixture", "/job/stream", {
				onFrame: onChunk,
				signal,
			});

test("terminal host marker cancels the response and ignores trailing frames", async () => {
	const stream = source(`${delta("first")}data: [DONE]\n\n${delta("late")}`);
	const chunks: string[] = [];
	await invoke("host", (chunk) => chunks.push(chunk));
	expect(chunks).toEqual(["first"]);
	expect(stream.cancelled()).toBe(1);
	expect(stream.body.locked).toBe(false);
});
test("host error frames release the response before rejecting", async () => {
	const stream = source(
		'data: {"type":"error","errorText":"Fixture error"}\n\n'
	);
	await expect(invoke("host", () => undefined)).rejects.toThrow(
		"Fixture error"
	);
	expect(stream.cancelled()).toBe(1);
	expect(stream.body.locked).toBe(false);
});
test("own-app streams read the companion's own ext-proxy mount", async () => {
	source(delta("first"), true);
	await invoke("app", () => undefined);
	expect(requestedPath).toBe("/api/ext/@ryu/fixture/job/stream");
});
test("own-app streams refuse a path outside the companion's mount", async () => {
	await expect(
		ownAppEventStream(target, "@ryu/fixture", "/../../plugins", {
			onFrame: () => undefined,
		})
	).rejects.toThrow("outside its own sidecar mount");
});
for (const kind of ["host", "app"] as const) {
	test(`${kind} consumer errors cancel and unlock the reader`, async () => {
		const stream = source(delta("first"));
		await expect(
			invoke(kind, () => {
				throw new Error("Consumer stopped");
			})
		).rejects.toThrow("Consumer stopped");
		expect(stream.cancelled()).toBe(1);
		expect(stream.body.locked).toBe(false);
	});
	test(`${kind} cancellation stops buffered frames`, async () => {
		const stream = source(delta("first") + delta("late"));
		const controller = new AbortController();
		let calls = 0;
		await invoke(
			kind,
			() => {
				calls += 1;
				controller.abort();
			},
			controller.signal
		);
		expect(calls).toBe(1);
		expect(stream.cancelled()).toBe(1);
		expect(stream.body.locked).toBe(false);
	});
	test(`${kind} clean end unlocks the response`, async () => {
		const stream = source(delta("first"), true);
		let calls = 0;
		await invoke(kind, () => {
			calls += 1;
		});
		expect(calls).toBe(1);
		expect(stream.body.locked).toBe(false);
	});
}
