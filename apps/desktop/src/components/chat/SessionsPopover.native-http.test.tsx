import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
const nativeFetch = globalThis.fetch,
	NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { SessionsPopover } = await import("./SessionsPopover.tsx");
let root: Root, container: HTMLDivElement;
let server: ReturnType<typeof Bun.serve>;
let target: { url: string; token: string; userJwt: string };
let calls: { path: string; token: string | null; jwt: string | null }[],
	unexpected: string[];
let hold: "sessions" | "audit" | null, release: (() => void) | undefined;
let armed: boolean, refuse: boolean, consumed: number, received: number;
function session(identity: string, status: string, index: number) {
	return {
		id: `${identity}-${index}`,
		conversation_id: "conversation",
		created_at: 1000,
		updated_at: 2000 + index,
		runnable_id: `${identity} worker ${index}`,
		runnable_kind: "agent",
		status,
	};
}
beforeEach(() => {
	calls = [];
	unexpected = [];
	hold = null;
	release = undefined;
	armed = false;
	refuse = false;
	consumed = 0;
	received = 0;
	globalThis.fetch = Object.assign(
		async (...args: Parameters<typeof nativeFetch>) => {
			const response = await nativeFetch(...args);
			received++;
			const original = response.json.bind(response);
			response.json = async () => {
				const value = await original();
				consumed++;
				return value;
			};
			const originalText = response.text.bind(response);
			response.text = async () => {
				const value = await originalText();
				consumed++;
				return value;
			};
			return response;
		},
		{ preconnect: nativeFetch.preconnect.bind(nativeFetch) }
	);
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const u = new URL(request.url),
				token = request.headers.get("authorization"),
				jwt = request.headers.get("x-ryu-user-jwt");
			const path = u.pathname + u.search;
			calls.push({ path, token, jwt });
			if (
				request.method !== "GET" ||
				!["Bearer node-a", "Bearer node-b"].includes(token ?? "") ||
				!["user-a", "user-b"].includes(jwt ?? "")
			) {
				unexpected.push(request.method + " " + path);
				return NativeResponse.json({}, { status: 401 });
			}
			const identity =
				token === "Bearer node-b" ||
				jwt === "user-b" ||
				u.pathname.startsWith("/alternate/")
					? "B"
					: "A";
			const sessionPath =
				u.pathname.replace("/alternate", "") ===
					"/api/conversations/conversation/sessions" && !u.search;
			const auditPath =
				u.pathname.replace("/alternate", "") === "/api/gateway/audit" &&
				u.search === "?session_id=conversation&limit=200";
			if (!sessionPath && !auditPath) {
				unexpected.push(path);
				return NativeResponse.json({}, { status: 503 });
			}
			const held =
				armed &&
				identity === "A" &&
				((hold === "sessions" && sessionPath) ||
					(hold === "audit" && auditPath));
			if (held) {
				armed = false;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			if (held && refuse)
				return NativeResponse.json({ error: "old refused" }, { status: 503 });
			if (sessionPath)
				return NativeResponse.json({
					sessions: ["idle", "running", "completed", "failed"].map((s, i) =>
						session(held ? "Retired A" : identity, s, i)
					),
				});
			return NativeResponse.json({
				reachable: true,
				count: 4,
				entries: [
					{
						event_type: "model_call",
						cost_micro_usd: identity === "B" ? 5000000 : 1000000,
						latency_ms: 500,
					},
					{
						event_type: "model_call",
						cost_micro_usd: 2000000,
						latency_ms: 1000,
					},
					{
						event_type: "tool_call",
						cost_micro_usd: 9000000,
						latency_ms: 9000,
					},
					{ event_type: null, cost_micro_usd: null, latency_ms: 100 },
				],
			});
		},
	});
	target = {
		url: server.url.toString().replace(/\/$/, ""),
		token: "node-a",
		userJwt: "user-a",
	};
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	release?.();
	await act(async () => root.unmount());
	server.stop(true);
	container.remove();
	globalThis.fetch = nativeFetch;
	expect(unexpected).toEqual([]);
});
async function render() {
	await act(async () =>
		root.render(
			<SessionsPopover conversationId="conversation" target={target} />
		)
	);
}
async function until(check: () => boolean) {
	const end = Date.now() + 3000;
	while (!check()) {
		if (Date.now() > end)
			throw Error(
				"UI did not settle " +
					document.body.textContent +
					" " +
					JSON.stringify(calls)
			);
		await act(async () => {
			await Bun.sleep(5);
		});
	}
}
function trigger() {
	const b = container.querySelector<HTMLButtonElement>(
		'button[aria-label="Sessions"]'
	);
	if (!b) throw Error("Missing Sessions trigger");
	return b;
}
async function toggle() {
	await act(async () => trigger().click());
}
function text() {
	return document.body.textContent ?? "";
}
async function settledResponse(previous: number) {
	await until(() => consumed > previous);
	await act(async () => {
		await new Promise<void>((r) => queueMicrotask(r));
	});
}
test("real authenticated session rows sort newest first, show each status color and model-only cost/latency", async () => {
	await render();
	await toggle();
	await until(() => text().includes("3 calls"));
	const rows = [...document.querySelectorAll("li")];
	expect(rows.map((r) => r.textContent?.includes("A worker 3"))[0]).toBe(true);
	for (const [status, color] of [
		["idle", "bg-muted-foreground/40"],
		["running", "bg-warning"],
		["completed", "bg-success"],
		["failed", "bg-destructive"],
	])
		expect(
			document.querySelector(`[aria-label="${status}"]`)?.className
		).toContain(color);
	expect(text()).toContain("$3.00");
	expect(text()).toContain("1.6s");
	expect(calls).toEqual([
		{
			path: "/api/conversations/conversation/sessions",
			token: "Bearer node-a",
			jwt: "user-a",
		},
		{
			path: "/api/gateway/audit?session_id=conversation&limit=200",
			token: "Bearer node-a",
			jwt: "user-a",
		},
	]);
});
for (const dimension of ["URL", "token", "JWT", "ABA"] as const)
	test(`old held session read cannot replace current rows after ${dimension} rotation`, async () => {
		hold = "sessions";
		armed = true;
		await render();
		await toggle();
		await until(() => !!release);
		const original = target;
		target =
			dimension === "URL"
				? { ...target, url: target.url + "/alternate" }
				: dimension === "token"
					? { ...target, token: "node-b" }
					: { ...target, userJwt: "user-b" };
		await render();
		await until(() => text().includes("B worker 3"));
		if (dimension === "ABA") {
			target = original;
			await render();
			await until(() => text().includes("A worker 3"));
		}
		const before = consumed;
		release?.();
		await settledResponse(before);
		expect(text()).toContain(dimension === "ABA" ? "A worker 3" : "B worker 3");
		expect(text()).not.toContain("Retired A worker");
		if (dimension !== "ABA") expect(text()).not.toContain("A worker");
	});
test("old held refusal cannot publish an error in current JWT scope", async () => {
	hold = "sessions";
	armed = true;
	refuse = true;
	await render();
	await toggle();
	await until(() => !!release);
	target = { ...target, userJwt: "user-b" };
	await render();
	await until(() => text().includes("B worker 3"));
	const previous = received;
	release?.();
	await until(() => received > previous);
	await act(async () => {
		await new Promise<void>((r) => queueMicrotask(r));
	});
	expect(text()).toContain("B worker 3");
	expect(text()).not.toContain("Failed to load sessions: 503");
});
test("close and reopen issues an explicit fresh session read after refusal", async () => {
	hold = "sessions";
	armed = true;
	refuse = true;
	await render();
	await toggle();
	await until(() => !!release);
	release?.();
	await until(() => text().includes("Failed to load sessions: 503"));
	await toggle();
	refuse = false;
	await toggle();
	await until(() => text().includes("A worker 3"));
	expect(text()).not.toContain("Failed to load sessions: 503");
	expect(calls.filter((c) => c.path.includes("/sessions")).length).toBe(2);
});

for (const refused of [false, true])
	test(`retired audit ${refused ? "refusal" : "rollup"} cannot replace current model cost`, async () => {
		hold = "audit";
		armed = true;
		refuse = refused;
		await render();
		await toggle();
		await until(() => !!release);
		target = { ...target, userJwt: "user-b" };
		await render();
		await until(() => text().includes("$7.00"));
		const previous = consumed;
		release?.();
		await until(() => consumed > previous);
		await act(async () => {
			await new Promise<void>((r) => queueMicrotask(r));
		});
		expect(text()).toContain("$7.00");
		expect(text()).toContain("3 calls");
		expect(text()).toContain("B worker 3");
		expect(text()).not.toContain("$3.00");
	});
