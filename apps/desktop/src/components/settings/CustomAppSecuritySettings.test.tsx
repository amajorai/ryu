import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { CustomAppSecuritySettings } = await import(
	"./CustomAppSecuritySettings.tsx"
);
const originalFetch = globalThis.fetch;
const roots: Root[] = [];
const first: ApiTarget = {
	url: "https://first.fixture",
	token: "first-token",
	userJwt: "first-user",
};
const second: ApiTarget = {
	url: "https://second.fixture",
	token: "second-token",
	userJwt: "second-user",
};
interface RequestRecord {
	url: string;
	method: string;
	authorization: string | null;
	userJwt: string | null;
	body: { value: string } | null;
}
let requests: RequestRecord[];
let respond: (request: RequestRecord) => Response | Promise<Response>;
function preference(value: boolean) {
	return Response.json({ key: "enforce-custom-app-csp", value: String(value) });
}
function pendingResponse() {
	let resolve!: (response: Response) => void;
	const promise = new Promise<Response>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}
beforeEach(() => {
	requests = [];
	respond = () => preference(false);
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			const record: RequestRecord = {
				url: String(input),
				method: init?.method ?? "GET",
				authorization: headers.get("authorization"),
				userJwt: headers.get("x-ryu-user-jwt"),
				body: init?.body ? JSON.parse(String(init.body)) : null,
			};
			requests.push(record);
			return await respond(record);
		},
		{ preconnect: originalFetch.preconnect }
	);
});
afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) root.unmount();
	});
	document.body.replaceChildren();
	globalThis.fetch = originalFetch;
});
async function settle() {
	await act(async () => {
		await Bun.sleep(10);
	});
}
async function render(target: ApiTarget, existing?: Root) {
	const host = document.createElement("div");
	if (!existing) document.body.append(host);
	const root = existing ?? createRoot(host);
	if (!existing) roots.push(root);
	await act(async () =>
		root.render(<CustomAppSecuritySettings target={target} />)
	);
	await settle();
	return root;
}
function input() {
	const control = document.getElementById("enforce-custom-app-csp");
	if (!(control instanceof HTMLInputElement))
		throw new Error("Missing CSP setting input");
	return control;
}
async function click() {
	const control = document.querySelector<HTMLElement>('[role="switch"]');
	if (!control) throw new Error("Missing visible CSP setting switch");
	await act(async () => control.click());
	await settle();
}
function call(
	target: ApiTarget,
	method: string,
	value: string | null = null
): RequestRecord {
	return {
		url: `${target.url}/api/preferences/enforce-custom-app-csp`,
		method,
		authorization: `Bearer ${target.token}`,
		userJwt: target.userJwt ?? null,
		body: value === null ? null : { value },
	};
}
for (const destination of [
	second,
	{ ...second, url: first.url },
	{ ...first, userJwt: second.userJwt },
]) {
	test(`a failed old-node save cannot overwrite the new authority at ${destination.url} (${destination.token}, ${destination.userJwt})`, async () => {
		const write = pendingResponse();
		respond = (request) =>
			request.method === "PUT"
				? write.promise
				: preference(
						request.authorization === "Bearer first-token" &&
							request.userJwt === first.userJwt
					);
		const root = await render(first);
		expect(input().checked).toBe(true);
		await click();
		expect(input().checked).toBe(false);
		await render(destination, root);
		expect(input().checked).toBe(false);
		await act(async () =>
			write.resolve(
				Response.json({ error: "old node refused write" }, { status: 503 })
			)
		);
		await settle();
		expect(input().checked).toBe(false);
		expect(input().disabled).toBe(false);
		expect(requests).toEqual([
			call(first, "GET"),
			call(first, "PUT", "false"),
			call(destination, "GET"),
		]);
	});
}
for (const status of [200, 503]) {
	test(`settling the previous node with HTTP ${status} cannot unlock the new node's pending save`, async () => {
		const oldWrite = pendingResponse();
		const newWrite = pendingResponse();
		respond = (request) =>
			request.method === "GET"
				? preference(false)
				: request.authorization === "Bearer first-token"
					? oldWrite.promise
					: newWrite.promise;
		const root = await render(first);
		await click();
		expect(input().disabled).toBe(true);
		await render(second, root);
		expect(input().disabled).toBe(false);
		await click();
		expect(input().checked).toBe(true);
		expect(input().disabled).toBe(true);
		await act(async () =>
			oldWrite.resolve(
				Response.json(status === 200 ? { ok: true } : { error: "refused" }, {
					status,
				})
			)
		);
		await settle();
		expect(input().checked).toBe(true);
		expect(input().disabled).toBe(true);
		await click();
		expect(requests.filter((request) => request.method === "PUT")).toEqual([
			call(first, "PUT", "true"),
			call(second, "PUT", "true"),
		]);
		await act(async () => newWrite.resolve(Response.json({ ok: true })));
		await settle();
		expect(input().checked).toBe(true);
		expect(input().disabled).toBe(false);
	});
}
test("an equivalent target rerender keeps an optimistic setting and pending lock without another read", async () => {
	const write = pendingResponse();
	respond = (request) =>
		request.method === "PUT" ? write.promise : preference(false);
	const root = await render(first);
	await click();
	await render({ ...first }, root);
	expect(input().checked).toBe(true);
	expect(input().disabled).toBe(true);
	expect(requests).toEqual([call(first, "GET"), call(first, "PUT", "true")]);
	await act(async () => write.resolve(Response.json({ ok: true })));
	await settle();
	expect(input().disabled).toBe(false);
});
test("a current-node failure rolls back, then retries the exact authenticated value and reads persisted state", async () => {
	let saved = false;
	let refused = false;
	respond = (request) => {
		if (request.method === "GET") return preference(saved);
		if (!refused) {
			refused = true;
			return Response.json({ error: "write refused" }, { status: 503 });
		}
		saved = request.body?.value === "true";
		return Response.json({ ok: true });
	};
	const root = await render(first);
	await click();
	expect(input().checked).toBe(false);
	expect(input().disabled).toBe(false);
	await click();
	expect(input().checked).toBe(true);
	expect(saved).toBe(true);
	await act(async () => root.unmount());
	roots.splice(roots.indexOf(root), 1);
	document.body.replaceChildren();
	await render(first);
	expect(input().checked).toBe(true);
	expect(requests).toEqual([
		call(first, "GET"),
		call(first, "PUT", "true"),
		call(first, "PUT", "true"),
		call(first, "GET"),
	]);
});

test("rapid repeated activation sends one pending write instead of duplicate changes", async () => {
 const write = pendingResponse();
 respond = (request) => request.method === "PUT" ? write.promise : preference(false);
 await render(first);
 const control = document.querySelector<HTMLElement>('[role="switch"]');
 if (!control) throw new Error("Missing visible CSP setting switch");
 await act(async () => { control.click(); control.click(); });
 await settle();
 expect(requests.filter((request) => request.method === "PUT")).toEqual([call(first, "PUT", "true")]);
 expect(input().disabled).toBe(true);
 await act(async () => write.resolve(Response.json({ ok: true })));
 await settle();
 expect(input().disabled).toBe(false);
});
