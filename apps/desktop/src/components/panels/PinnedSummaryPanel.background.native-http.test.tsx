import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
const nativeFetch = globalThis.fetch,
	NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { PinnedSummaryPanel } = await import(
	"./PinnedSummaryPanel.tsx"
);
let root: Root,
	container: HTMLDivElement,
	server: ReturnType<typeof Bun.serve>,
	client: InstanceType<typeof QueryClient>;
let target: { url: string; token: string; userJwt: string };
let calls: {
		method: string;
		path: string;
		token: string | null;
		jwt: string | null;
		body: unknown;
	}[],
	unexpected: string[],
	holdB: boolean,
	releaseB: (() => void) | undefined;
let completedStopResponses: number;
let removed: Set<string>,
	refuse: boolean,
	holdAStop: boolean,
	releaseAStop: (() => void) | undefined;
function process(label: string) {
	return {
		command: label,
		cwd: "/owned/project",
		elapsed_ms: 1000,
		kind: "shell",
		label,
		pid: 123,
		process_id: "same/process",
		producer: "@ryu/pi-shell",
		running: true,
		started_at: 1,
	};
}
beforeEach(() => {
	completedStopResponses = 0;
	globalThis.fetch = Object.assign(
		async (...args: Parameters<typeof nativeFetch>): Promise<Response> => {
			const response = await nativeFetch(...args);
			if (args[1]?.method === "POST") {
				const nativeText = response.text.bind(response);
				response.text = () => {
					const result = nativeText();
					void result.then(
						() => {
							completedStopResponses++;
						},
						() => {
							completedStopResponses++;
						}
					);
					return result;
				};
			}
			return response;
		},
		{ preconnect: nativeFetch.preconnect.bind(nativeFetch) }
	);
	calls = [];
	unexpected = [];
	holdB = false;
	releaseB = undefined;
	removed = new Set();
	refuse = false;
	holdAStop = false;
	releaseAStop = undefined;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url),
				token = request.headers.get("authorization"),
				jwt = request.headers.get("x-ryu-user-jwt");
			const body = request.method === "POST" ? await request.json() : null;
			calls.push({
				method: request.method,
				path: url.pathname + url.search,
				token,
				jwt,
				body,
			});
			if (
				!(
					(token === "Bearer node-a" &&
						(jwt === "user-a" || jwt === "user-b")) ||
					(token === "Bearer node-b" && jwt === "user-a")
				)
			) {
				unexpected.push("Unknown credential pair");
				return NativeResponse.json(
					{ error: "Unauthenticated fixture caller" },
					{ status: 401 }
				);
			}
			const identity =
				token === "Bearer node-b" || jwt === "user-b" ? "b" : "a";
			if (
				request.method === "GET" &&
				url.pathname === "/api/background/processes" &&
				url.search === "?running_only=true"
			) {
				if (identity === "b" && holdB)
					await new Promise<void>((resolve) => {
						releaseB = resolve;
					});
				return NativeResponse.json({
					processes: removed.has(identity)
						? []
						: [process(identity === "a" ? "Private worker A" : "Worker B")],
				});
			}
			if (
				request.method === "POST" &&
				url.pathname === "/api/background/processes/same%2Fprocess/stop" &&
				JSON.stringify(body) === "{}"
			) {
				if (identity === "a" && holdAStop)
					await new Promise<void>((resolve) => {
						releaseAStop = resolve;
					});
				if (refuse) {
					refuse = false;
					return NativeResponse.json({ error: "Denied Stop" }, { status: 503 });
				}
				removed.add(identity);
				return NativeResponse.json({
					ok: true,
					process_id: "same/process",
					requested: true,
				});
			}
			unexpected.push(request.method + " " + url.pathname + url.search);
			return NativeResponse.json(
				{ error: "Unexpected route" },
				{ status: 503 }
			);
		},
	});
	target = {
		url: server.url.toString().replace(/\/$/, ""),
		token: "node-a",
		userJwt: "user-a",
	};
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	releaseB?.();
	releaseAStop?.();
	await act(async () => root.unmount());
	client.clear();
	server.stop(true);
	container.remove();
	globalThis.fetch = nativeFetch;
});
async function render() {
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<PinnedSummaryPanel
					conversationId={null}
					folder={null}
					target={target}
					cowork={{ chatStatus: "ready", messages: [], runId: null, target }}
				/>
			</QueryClientProvider>
		)
	);
}
async function until(check: () => boolean) {
	const end = Date.now() + 3000;
	while (!check()) {
		if (Date.now() > end)
			throw Error(
				"Actual process UI did not settle " +
					JSON.stringify({ calls, unexpected, text: container.textContent })
			);
		await act(async () => {
			await Bun.sleep(10);
		});
	}
}
function button(name: string) {
	const result = [
		...container.querySelectorAll<HTMLButtonElement>("button"),
	].find(
		(b) =>
			b.getAttribute("aria-label") === name || b.textContent?.trim() === name
	);
	if (!result) throw Error("Missing real button " + name);
	return result;
}
async function open() {
	await until(() =>
		[...container.querySelectorAll("button")].some((b) =>
			b.textContent?.startsWith("Background processes")
		)
	);
	const section = [
		...container.querySelectorAll<HTMLButtonElement>("button"),
	].find((b) => b.textContent?.startsWith("Background processes"));
	if (!section) throw Error("No real process section");
	await act(async () => section.click());
	await until(
		() => container.textContent?.includes("Private worker A") === true
	);
}
test("actual Stop refuses without removing work, retries exact authenticated request and remount reads server removal", async () => {
	await render();
	await open();
	refuse = true;
	await act(async () => button("Stop Private worker A").click());
	await until(
		() =>
			container.textContent?.includes("Could not stop process. Try again.") ===
			true
	);
	expect(removed.size).toBe(0);
	expect(container.textContent).toContain("Private worker A");
	await act(async () => button("Stop Private worker A").click());
	await until(
		() =>
			removed.has("a") && !container.textContent?.includes("Private worker A")
	);
	expect(calls.filter((c) => c.method === "POST")).toEqual(
		[1, 2].map(() => ({
			method: "POST",
			path: "/api/background/processes/same%2Fprocess/stop",
			token: "Bearer node-a",
			jwt: "user-a",
			body: {},
		}))
	);
	await act(async () => root.unmount());
	client.clear();
	root = createRoot(container);
	await render();
	await until(() => calls.filter((c) => c.method === "GET").length >= 3);
	expect(container.textContent).not.toContain("Private worker A");
	expect(unexpected).toEqual([]);
});
for (const field of ["token", "userJwt"] as const)
	test(`same-URL ${field} rotation never exposes actionable cached A processes during B read`, async () => {
		await render();
		await open();
		holdB = true;
		target = { ...target, [field]: field === "token" ? "node-b" : "user-b" };
		await render();
		// Allow any actual authority-owned GET to reach its held server boundary. A cache
		// sharing bug might issue no B read; the old sensitive row must still disappear.
		await act(async () => {
			await Bun.sleep(30);
		});
		expect(container.textContent).not.toContain("Private worker A");
		expect(
			[...container.querySelectorAll("button")].some(
				(b) =>
					b.getAttribute("aria-label") === "Stop Private worker A" &&
					!b.disabled
			)
		).toBe(false);
		expect(calls.filter((c) => c.method === "POST")).toEqual([]);
		holdB = false;
		releaseB?.();
		await until(() => container.textContent?.includes("Worker B") === true);
		expect(unexpected).toEqual([]);
	});

for (const status of [200, 503])
	test(`held A Stop ${status} acknowledgement cannot alter B process list or errors`, async () => {
		await render();
		await open();
		holdAStop = true;
		refuse = status === 503;
		await act(async () => button("Stop Private worker A").click());
		await until(() => calls.some((c) => c.method === "POST"));
		target = { ...target, userJwt: "user-b" };
		await render();
		await until(() => container.textContent?.includes("Worker B") === true);
		expect(button("Stop Worker B").disabled).toBe(false);
		const bReads = calls.filter(
			(c) => c.method === "GET" && c.jwt === "user-b"
		).length;
		releaseAStop?.();
		await until(() => completedStopResponses === 1);
		await act(async () => {
			await Promise.resolve();
		});
		expect(container.textContent).toContain("Worker B");
		expect(container.textContent).not.toContain(
			"Could not stop process. Try again."
		);
		expect(
			calls.filter((c) => c.method === "GET" && c.jwt === "user-b").length
		).toBe(bReads);
		expect(calls.filter((c) => c.method === "POST")).toEqual([
			{
				method: "POST",
				path: "/api/background/processes/same%2Fprocess/stop",
				token: "Bearer node-a",
				jwt: "user-a",
				body: {},
			},
		]);
		expect(removed.has("b")).toBe(false);
		expect(unexpected).toEqual([]);
	});
test("same-turn repeated Stop click sends one held request and reads its acknowledged removal", async () => {
	await render();
	await open();
	holdAStop = true;
	await act(async () => {
		const stop = button("Stop Private worker A");
		stop.click();
		stop.click();
	});
	await until(() => calls.some((c) => c.method === "POST"));
	expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
	releaseAStop?.();
	await until(
		() =>
			removed.has("a") && !container.textContent?.includes("Private worker A")
	);
	expect(unexpected).toEqual([]);
});

for (const status of [200, 503])
	test(`returning A cannot duplicate held Stop and reconciles its ${status} acknowledgement before a fresh action`, async () => {
		await render();
		await open();
		holdAStop = true;
		refuse = status === 503;
		await act(async () => button("Stop Private worker A").click());
		await until(() => calls.some((c) => c.method === "POST"));
		target = { ...target, userJwt: "user-b" };
		await render();
		await until(() => container.textContent?.includes("Worker B") === true);
		target = { ...target, userJwt: "user-a" };
		await render();
		await until(
			() => container.textContent?.includes("Private worker A") === true
		);
		expect(button("Stop Private worker A").disabled).toBe(true);
		expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
		const aReads = calls.filter(
			(c) => c.method === "GET" && c.jwt === "user-a"
		).length;
		holdAStop = false;
		releaseAStop?.();
		await until(
			() =>
				calls.filter((c) => c.method === "GET" && c.jwt === "user-a").length >
				aReads
		);
		expect(container.textContent).not.toContain(
			"Could not stop process. Try again."
		);
		if (status === 503) {
			await until(() => !button("Stop Private worker A").disabled);
			await act(async () => button("Stop Private worker A").click());
		}
		await until(
			() =>
				removed.has("a") && !container.textContent?.includes("Private worker A")
		);
		expect(
			calls.filter((c) => c.method === "POST" && c.jwt === "user-b")
		).toEqual([]);
		expect(removed.has("b")).toBe(false);
		expect(unexpected).toEqual([]);
	});
