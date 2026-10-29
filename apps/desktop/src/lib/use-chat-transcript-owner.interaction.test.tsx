import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	useChatTranscriptOwner,
	useOwnedChatMessages,
	useStopReplacedChat,
} from "./use-chat-transcript-owner";

const httpFetch = globalThis.fetch;
const HttpResponse = globalThis.Response;
const HttpRequest = globalThis.Request;
const HttpAbortController = globalThis.AbortController;
const HttpAbortSignal = globalThis.AbortSignal;
const HttpReadableStream = globalThis.ReadableStream;
const HttpTransformStream = globalThis.TransformStream;
const HttpTextDecoderStream = globalThis.TextDecoderStream;
if (typeof document === "undefined") GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(globalThis, "ReadableStream", HttpReadableStream);
Reflect.set(globalThis, "TransformStream", HttpTransformStream);
Reflect.set(globalThis, "TextDecoderStream", HttpTextDecoderStream);
Reflect.set(globalThis, "AbortController", HttpAbortController);
Reflect.set(globalThis, "AbortSignal", HttpAbortSignal);
let clientAborts: string[];
let cancelledStreams = 0;
let holdStream = false;
let releaseStream: (() => void) | undefined;
let sendSettlements: string[];
let root: Root;
let container: HTMLDivElement;
let server: ReturnType<typeof Bun.serve>;
let releaseHistory: (() => void) | undefined;
let historyStarted: (() => void) | undefined;
let writes: Array<{
	auth: string | null;
	jwt: string | null;
	id: string;
	conversation: string;
}>;
let readCompletions: string[];
let view:
	| { isCurrent: () => boolean; id: string; setter: (next: never[]) => void }
	| undefined;
function Harness({
	token = "A-token",
	jwt = "A-jwt",
	url,
	conversation = "shared",
}: {
	token?: string;
	jwt?: string;
	url: string;
	conversation?: string;
}) {
	const owner = useChatTranscriptOwner(
		{ url, token, userJwt: jwt },
		conversation
	);
	const chat = useChat({
		id: owner.sdkId,
		transport: new DefaultChatTransport({
			fetch: Object.assign(
				(
					input: Parameters<typeof httpFetch>[0],
					init?: Parameters<typeof httpFetch>[1]
				) => {
					const request = new HttpRequest(input, init);
					request.signal.addEventListener(
						"abort",
						() => {
							clientAborts.push(
								request.headers.get("Authorization") ?? "missing"
							);
						},
						{ once: true }
					);
					return httpFetch(request);
				},
				{ preconnect: httpFetch.preconnect }
			),
			api: `${url.replace(/\/$/, "")}/stream`,
			headers: { Authorization: `Bearer ${token}`, "X-Ryu-User-Jwt": jwt },
			body: { conversation_id: conversation },
		}),
	});
	useStopReplacedChat(chat.stop);
	const setMessages = useOwnedChatMessages(owner.isCurrent, chat.setMessages);
	const [draft, setDraft] = useState("unsent private draft");
	view = { isCurrent: owner.isCurrent, id: owner.sdkId, setter: setMessages };
	useEffect(() => {
		let cancelled = false;
		void httpFetch(`${url.replace(/\/$/, "")}/history`, {
			headers: { Authorization: `Bearer ${token}`, "X-Ryu-User-Jwt": jwt },
		}).then(async (response) => {
			const text = await response.text();
			readCompletions.push(text);
			if (!cancelled && owner.isCurrent())
				setMessages([
					{ id: "history", role: "assistant", parts: [{ type: "text", text }] },
				]);
		});
		return () => {
			cancelled = true;
		};
	}, [url, token, jwt, owner.isCurrent, setMessages]);
	return (
		<>
			<textarea value={draft} onChange={(e) => setDraft(e.target.value)} />
			<button
				onClick={() => {
					void chat.sendMessage({ text: "new turn" }).then(() => {
						sendSettlements.push(owner.sdkId);
					});
				}}
			>
				Send
			</button>
			<output>
				{chat.messages
					.map((m) =>
						m.parts
							.filter((p) => p.type === "text")
							.map((p) => p.text)
							.join("")
					)
					.join("|")}
			</output>
			<span>{chat.status}</span>
			<pre>{chat.error?.message}</pre>
		</>
	);
}
beforeEach(() => {
	writes = [];
	cancelledStreams = 0;
	clientAborts = [];
	holdStream = false;
	releaseStream = undefined;
	sendSettlements = [];
	readCompletions = [];
	view = undefined;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/history" && request.method === "GET") {
				if (request.headers.get("Authorization") === "Bearer held-A") {
					historyStarted?.();
					await new Promise<void>((resolve) => {
						releaseHistory = resolve;
					});
				}
				return new HttpResponse(
					`${url.hostname === "localhost" ? "node-B:" : ""}${request.headers.get("Authorization")}/${request.headers.get("X-Ryu-User-Jwt")}`
				);
			}
			if (url.pathname === "/stream" && request.method === "POST") {
				const body = (await request.json()) as {
					id: string;
					conversation_id: string;
				};
				writes.push({
					auth: request.headers.get("Authorization"),
					jwt: request.headers.get("X-Ryu-User-Jwt"),
					id: body.id,
					conversation: body.conversation_id,
				});
				const frames = [
					{ type: "start", messageId: "reply" },
					{ type: "text-start", id: "reply-text" },
					{
						type: "text-delta",
						id: "reply-text",
						delta: `reply:${request.headers.get("Authorization")}`,
					},
					{ type: "text-end", id: "reply-text" },
					{ type: "finish", finishReason: "stop" },
				];

				if (holdStream) {
					const encoded = (frame: unknown) =>
						new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`);
					let cancelled = false;
					const stream = new HttpReadableStream({
						start(controller) {
							for (const frame of frames.slice(0, 3))
								controller.enqueue(encoded(frame));
							releaseStream = () => {
								if (cancelled) return;
								controller.enqueue(
									encoded({
										type: "text-delta",
										id: "reply-text",
										delta: ":late-A",
									})
								);
								for (const frame of frames.slice(3))
									controller.enqueue(encoded(frame));
								controller.enqueue(
									new TextEncoder().encode("data: [DONE]\n\n")
								);
								controller.close();
							};
						},
						cancel() {
							cancelled = true;
							cancelledStreams++;
						},
					});
					return new HttpResponse(stream, {
						headers: {
							"Content-Type": "text/event-stream",
							"x-vercel-ai-ui-message-stream": "v1",
						},
					});
				}
				return new HttpResponse(
					frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") +
						"data: [DONE]\n\n",
					{
						headers: {
							"Content-Type": "text/event-stream",
							"x-vercel-ai-ui-message-stream": "v1",
						},
					}
				);
			}
			throw new Error(`Unexpected real HTTP ${request.method} ${url.pathname}`);
		},
	});
});
afterEach(async () => {
	releaseHistory?.();
	releaseStream?.();
	releaseStream = undefined;
	releaseHistory = undefined;
	historyStarted = undefined;
	await act(async () => root.unmount());
	container.remove();
	server.stop(true);
});
function currentView() {
	if (!view) throw new Error("Actual mounted transcript owner is absent");
	return view;
}
async function render(props: Partial<Parameters<typeof Harness>[0]> = {}) {
	await act(async () =>
		root.render(<Harness url={server.url.origin} {...props} />)
	);
}
async function settle(expected: string) {
	await act(async () => {
		await Bun.sleep(5);
	});
	expect(container.querySelector("output")?.textContent).toBe(expected);
}
async function eventually(expected: string) {
	for (let i = 0; i < 100; i++) {
		await act(async () => {
			await Bun.sleep(5);
		});
		if (container.querySelector("output")?.textContent === expected) return;
	}
	if (container.querySelector("pre")?.textContent)
		throw new Error(container.querySelector("pre")?.textContent ?? "SDK error");
	expect(container.querySelector("output")?.textContent).toBe(expected);
}
for (const field of ["url", "token", "jwt"] as const) {
	test(`${field} authority change replaces actual SDK history, retains composer, and sends with current authority`, async () => {
		await render();
		await eventually("Bearer A-token/A-jwt");
		const previous = currentView();
		const textarea = container.querySelector("textarea");
		const next =
			field === "url"
				? { url: server.url.origin.replace("127.0.0.1", "localhost") }
				: field === "token"
					? { token: "B-token" }
					: { jwt: "B-jwt" };
		await render(next);
		expect(previous?.isCurrent()).toBe(false);
		expect(view?.id).not.toBe(previous?.id);
		expect(view?.id).not.toContain("A-token");
		expect(view?.id).not.toContain("A-jwt");
		expect(container.querySelector("textarea")).toBe(textarea);
		expect(textarea?.value).toBe("unsent private draft");
		const token = field === "token" ? "B-token" : "A-token";
		const jwt = field === "jwt" ? "B-jwt" : "A-jwt";
		const history = `${field === "url" ? "node-B:" : ""}Bearer ${token}/${jwt}`;
		await eventually(history);
		await act(async () => {
			container.querySelector("button")?.click();
		});
		await eventually(`${history}|new turn|reply:Bearer ${token}`);
		expect(writes).toEqual([
			{
				auth: `Bearer ${token}`,
				jwt,
				id: currentView().id,
				conversation: "shared",
			},
		]);
		// The actual SDK's stable setter would otherwise write through its new Chat ref.
		await act(async () => previous?.setter([]));
		await settle(`${history}|new turn|reply:Bearer ${token}`);
	});
}
test("A to B to A creates a fresh owner; a held old HTTP read cannot restore old transcript", async () => {
	const started = new Promise<void>((resolve) => {
		historyStarted = resolve;
	});
	await render({ token: "held-A" });
	await started;
	const old = currentView();
	await render({ token: "B" });
	await eventually("Bearer B/A-jwt");
	await render({ token: "A-token" });
	await eventually("Bearer A-token/A-jwt");
	expect(view?.id).not.toBe(old?.id);
	expect(old?.isCurrent()).toBe(false);
	releaseHistory?.();
	for (
		let i = 0;
		i < 100 && !readCompletions.includes("Bearer held-A/A-jwt");
		i++
	) {
		await act(async () => {
			await Bun.sleep(5);
		});
	}
	expect(readCompletions).toContain("Bearer held-A/A-jwt");
	expect(container.querySelector("output")?.textContent).toBe(
		"Bearer A-token/A-jwt"
	);
});
test("same authority and draft promotion preserve the current SDK transcript; unmount invalidates writes", async () => {
	await render({ conversation: "draft-1" });
	await eventually("Bearer A-token/A-jwt");
	const before = currentView();
	await act(async () => container.querySelector("button")?.click());
	await eventually("Bearer A-token/A-jwt|new turn|reply:Bearer A-token");
	await render({ conversation: "draft-1" });
	expect(view?.id).toBe(before?.id);
	expect(before?.isCurrent()).toBe(true);
	await settle("Bearer A-token/A-jwt|new turn|reply:Bearer A-token");
	await act(async () => root.unmount());
	expect(view?.isCurrent()).toBe(false);
});

test("same-authority render keeps a real live stream; authority replacement aborts only the old transport", async () => {
	await render();
	await eventually("Bearer A-token/A-jwt");
	holdStream = true;
	await act(async () => container.querySelector("button")?.click());
	await eventually("Bearer A-token/A-jwt|new turn|reply:Bearer A-token");
	const old = currentView();
	expect(container.querySelector("span")?.textContent).toBe("streaming");
	await render();
	expect(view?.id).toBe(old?.id);
	expect(container.querySelector("span")?.textContent).toBe("streaming");
	expect(clientAborts).toEqual([]);
	expect(cancelledStreams).toBe(0);
	await render({ token: "B-token" });
	await eventually("Bearer B-token/A-jwt");
	expect(old?.isCurrent()).toBe(false);
	for (let i = 0; i < 100 && !clientAborts.includes("Bearer A-token"); i++) {
		await act(async () => {
			await Bun.sleep(5);
		});
	}
	expect(clientAborts).toEqual(["Bearer A-token"]);
	for (let i = 0; i < 100 && cancelledStreams === 0; i++) {
		await act(async () => {
			await Bun.sleep(5);
		});
	}
	expect(cancelledStreams).toBe(1);
	releaseStream?.();
	releaseStream = undefined;
	for (
		let i = 0;
		i < 100 && !sendSettlements.includes(old?.id ?? "missing");
		i++
	) {
		await act(async () => {
			await Bun.sleep(5);
		});
	}
	expect(sendSettlements).toContain(old.id);
	expect(container.querySelector("output")?.textContent).toBe(
		"Bearer B-token/A-jwt"
	);
	expect(container.querySelector("span")?.textContent).toBe("ready");
	holdStream = false;
	await act(async () => container.querySelector("button")?.click());
	await eventually("Bearer B-token/A-jwt|new turn|reply:Bearer B-token");
	expect(writes.map((write) => write.auth)).toEqual([
		"Bearer A-token",
		"Bearer B-token",
	]);
	expect(clientAborts).toEqual(["Bearer A-token"]);
});

test("without randomUUID the actual SDK mounts, preserves equivalent authority, isolates ABA and keeps authenticated send and composer working", async () => {
	const cryptoObject = globalThis.crypto;
	const descriptor = Object.getOwnPropertyDescriptor(
		cryptoObject,
		"randomUUID"
	);
	Object.defineProperty(cryptoObject, "randomUUID", {
		configurable: true,
		value: undefined,
	});
	try {
		await render();
		await eventually("Bearer A-token/A-jwt");
		const a = currentView();
		const textarea = container.querySelector("textarea");
		await render();
		expect(currentView().id).toBe(a.id);
		expect(a.isCurrent()).toBe(true);
		await render({ token: "B-token" });
		await eventually("Bearer B-token/A-jwt");
		const b = currentView();
		expect(b.id).not.toBe(a.id);
		expect(a.isCurrent()).toBe(false);
		await render({ token: "A-token" });
		await eventually("Bearer A-token/A-jwt");
		const returned = currentView();
		expect(returned.id).not.toBe(a.id);
		expect(returned.id).not.toBe(b.id);
		expect(b.isCurrent()).toBe(false);
		expect(container.querySelector("textarea")).toBe(textarea);
		expect(textarea?.value).toBe("unsent private draft");
		await act(async () => container.querySelector("button")?.click());
		await eventually("Bearer A-token/A-jwt|new turn|reply:Bearer A-token");
		expect(writes).toEqual([
			{
				auth: "Bearer A-token",
				jwt: "A-jwt",
				id: returned.id,
				conversation: "shared",
			},
		]);
		expect(returned.id).not.toContain("A-token");
		expect(returned.id).not.toContain("A-jwt");
	} finally {
		if (descriptor)
			Object.defineProperty(cryptoObject, "randomUUID", descriptor);
		else Reflect.deleteProperty(cryptoObject, "randomUUID");
	}
});
