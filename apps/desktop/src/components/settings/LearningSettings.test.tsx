import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { Node } from "@/src/store/useNodeStore.ts";
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { LearningSettings } = await import("./LearningSettings.tsx");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const originalFetch = globalThis.fetch;
const originalState = useNodeStore.getState();
const roots: Root[] = [];
const first: Node = {
	name: "first",
	url: "https://first.fixture",
	token: "first-token",
	userJwt: "first-user",
};
const second: Node = {
	name: "second",
	url: "https://second.fixture",
	token: "second-token",
	userJwt: "second-user",
};
const destinations = [
	second,
	{ ...second, url: first.url },
	{ ...first, name: "new-user", userJwt: second.userJwt },
];
interface Call {
	url: string;
	method: string;
	token: string | null;
	userJwt: string | null;
	body: { value: string } | null;
}
let calls: Call[];
let respond: (call: Call) => Response | Promise<Response>;
function preference(value: boolean) {
	return Response.json({ value: String(value) });
}
function pending() {
	let resolve!: (response: Response) => void;
	const promise = new Promise<Response>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function select(node: Node) {
	useNodeStore.setState({
		nodes: [node],
		defaultNode: node.name,
		autoSelect: false,
	});
}
function expected(node: Node, key: string, value: string): Call {
	return {
		url: `${node.url}/api/preferences/${key}`,
		method: "PUT",
		token: `Bearer ${node.token}`,
		userJwt: node.userJwt ?? null,
		body: { value },
	};
}
beforeEach(() => {
	calls = [];
	select(first);
	respond = () => preference(false);
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			const call: Call = {
				url: String(input),
				method: init?.method ?? "GET",
				token: headers.get("authorization"),
				userJwt: headers.get("x-ryu-user-jwt"),
				body: init?.body ? JSON.parse(String(init.body)) : null,
			};
			calls.push(call);
			return await respond(call);
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
	useNodeStore.setState(originalState);
});
async function settle() {
	await act(async () => {
		await Bun.sleep(5);
	});
}
async function mount() {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () => root.render(<LearningSettings />));
	await settle();
}
function control(name = "Learn skills from my chats") {
	const element = document.querySelector<HTMLElement>(
		`[role="switch"][aria-label="${name}"]`
	);
	if (!element) throw new Error(`Missing consent control ${name}`);
	return element;
}
async function click(name?: string) {
	await act(async () => control(name).click());
	await settle();
}
for (const destination of destinations) {
	test(`consent reads follow semantic authority ${destination.url}/${destination.token}/${destination.userJwt}`, async () => {
		respond = (call) =>
			preference(
				call.token !== `Bearer ${first.token}` || call.userJwt !== first.userJwt
			);
		await mount();
		expect(control().getAttribute("aria-checked")).toBe("false");
		await act(async () => select(destination));
		await settle();
		expect(control().getAttribute("aria-checked")).toBe("true");
		await click();
		expect(calls.filter((call) => call.method === "PUT")).toEqual([
			expected(destination, "learning.skills-enabled", "false"),
		]);
	});
	for (const status of [200, 403])
		test(`old ${status} save cannot rollback or unlock new consent ${destination.url}/${destination.token}/${destination.userJwt}`, async () => {
			const old = pending();
			const current = pending();
			respond = (call) =>
				call.method === "PUT"
					? call.token === `Bearer ${first.token}` &&
						call.userJwt === first.userJwt
						? old.promise
						: current.promise
					: preference(
							call.token !== `Bearer ${first.token}` ||
								call.userJwt !== first.userJwt
						);
			await mount();
			await click();
			await act(async () => select(destination));
			await settle();
			expect(control().getAttribute("aria-checked")).toBe("true");
			await click();
			await act(async () =>
				old.resolve(
					Response.json(
						status === 200 ? { ok: true } : { error: "Permission denied" },
						{ status }
					)
				)
			);
			await settle();
			expect(control().getAttribute("aria-checked")).toBe("false");
			await click();
			expect(control().getAttribute("aria-checked")).toBe("false");
			expect(calls.filter((call) => call.method === "PUT")).toEqual([
				expected(first, "learning.skills-enabled", "true"),
				expected(destination, "learning.skills-enabled", "false"),
			]);
			await act(async () => current.resolve(Response.json({ ok: true })));
			await settle();
			await click();
			expect(calls.filter((call) => call.method === "PUT").at(-1)).toEqual(
				expected(destination, "learning.skills-enabled", "true")
			);
		});
}
test("equivalent node objects preserve the pending consent and do not reread", async () => {
	const write = pending();
	respond = (call) =>
		call.method === "PUT" ? write.promise : preference(false);
	await mount();
	await click();
	const initialReads = calls.filter((call) => call.method === "GET");
	await act(async () => select({ ...first }));
	await settle();
	await click();
	expect(control().getAttribute("aria-checked")).toBe("true");
	expect(calls.filter((call) => call.method === "GET")).toEqual(initialReads);
	expect(calls.filter((call) => call.method === "PUT")).toEqual([
		expected(first, "learning.skills-enabled", "true"),
	]);
	await act(async () => write.resolve(Response.json({ ok: true })));
	await settle();
});

test("late initial consent does not replace the selected node", async () => {
	const old = pending();
	respond = (call) =>
		call.token === `Bearer ${first.token}` ? old.promise : preference(false);
	await mount();
	await act(async () => select(second));
	await settle();
	await act(async () => old.resolve(preference(true)));
	await settle();
	expect(control().getAttribute("aria-checked")).toBe("false");
	expect(
		calls.filter((call) => call.token === `Bearer ${second.token}`)
	).toHaveLength(2);
});
test("failed consent read blocks mutation until a real retry", async () => {
	respond = () =>
		Response.json({ error: "Permission denied" }, { status: 403 });
	await mount();
	await click();
	expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
	respond = () => preference(true);
	const retry = [...document.querySelectorAll("button")].find(
		(button) => button.textContent === "Retry"
	);
	if (!retry) throw new Error("Missing read retry");
	await act(async () => retry.click());
	await settle();
	expect(control().getAttribute("aria-checked")).toBe("true");
});
for (const name of ["Learn skills from my chats", "Train my local model"])
	test(`${name} refuses duplicate pending writes and retries with durable readback`, async () => {
		const write = pending();
		const stored = new Map<string, string>();
		respond = (call) =>
			call.method === "PUT"
				? write.promise
				: preference(stored.get(call.url) === "true");
		await mount();
		await act(async () => {
			control(name).click();
			control(name).click();
		});
		await settle();
		expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
		await act(async () =>
			write.resolve(
				Response.json({ error: "Permission denied" }, { status: 403 })
			)
		);
		await settle();
		expect(control(name).getAttribute("aria-checked")).toBe("false");
		respond = (call) => {
			if (call.method === "PUT") {
				stored.set(call.url, call.body?.value ?? "false");
				return Response.json({ ok: true });
			}
			return preference(stored.get(call.url) === "true");
		};
		await click(name);
		expect(control(name).getAttribute("aria-checked")).toBe("true");
		const key = name.startsWith("Learn")
			? "learning.skills-enabled"
			: "learning.enabled";
		expect(calls.filter((call) => call.method === "PUT")).toEqual([
			expected(first, key, "true"),
			expected(first, key, "true"),
		]);
		await act(async () => roots[0]?.unmount());
		roots.shift();
		await mount();
		expect(control(name).getAttribute("aria-checked")).toBe("true");
		expect(
			control(
				name.startsWith("Learn")
					? "Train my local model"
					: "Learn skills from my chats"
			).getAttribute("aria-checked")
		).toBe("false");
	});
