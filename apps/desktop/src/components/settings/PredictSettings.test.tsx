import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { PredictConfig } from "@/src/lib/api/predict.ts";
import type { Node } from "@/src/store/useNodeStore.ts";
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { EntitlementProvider } = await import(
	"@/src/contexts/entitlement-context.tsx"
);
const { PredictSettings } = await import("./PredictSettings.tsx");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { queryClient } = await import("@/src/lib/query-client.ts");
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
const firstConfig: PredictConfig = {
	model: "first/model",
	effort: "high",
	maxChars: 100,
	debounceMs: 120,
	appAllowlist: ["FirstApp"],
};
const destinations = [
	second,
	{ ...second, url: first.url },
	{ ...first, name: "new-user", userJwt: second.userJwt },
];
const secondConfig: PredictConfig = {
	model: "second/model",
	effort: "low",
	maxChars: 360,
	debounceMs: 640,
	appAllowlist: ["SecondApp"],
};
interface Call {
	url: string;
	method: string;
	authorization: string | null;
	userJwt: string | null;
	body: PredictConfig | null;
}
let calls: Call[];
let respond: (call: Call) => Response | Promise<Response>;
function call(
	node: Node,
	method: string,
	body: PredictConfig | null = null
): Call {
	return {
		url: `${node.url}/api/predict/config`,
		method,
		authorization: `Bearer ${node.token}`,
		userJwt: node.userJwt ?? null,
		body,
	};
}
function pending() {
	let resolve!: (response: Response) => void;
	const promise = new Promise<Response>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}
beforeEach(() => {
	calls = [];
	queryClient.clear();
	useNodeStore.setState({
		nodes: [first],
		defaultNode: first.name,
		autoSelect: false,
	});
	respond = (request) =>
		Response.json(
			request.authorization === "Bearer first-token" &&
				request.userJwt === first.userJwt
				? firstConfig
				: secondConfig
		);
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (!url.includes("/api/predict/config")) {
				if (url.includes("catalog"))
					return Response.json({ providers: [], thinkingLevels: [] });
				return Response.json([]);
			}
			const headers = new Headers(init?.headers);
			const record: Call = {
				url,
				method: init?.method ?? "GET",
				authorization: headers.get("authorization"),
				userJwt: headers.get("x-ryu-user-jwt"),
				body: init?.body ? JSON.parse(String(init.body)) : null,
			};
			calls.push(record);
			return await respond(record);
		},
		{ preconnect: originalFetch.preconnect }
	);
});
afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) root.unmount();
	});
	queryClient.clear();
	useNodeStore.setState(originalState);
	document.body.replaceChildren();
	globalThis.fetch = originalFetch;
});
async function settle() {
	await act(async () => {
		await Bun.sleep(20);
	});
}
async function mount() {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () =>
		root.render(
			<QueryClientProvider client={queryClient}>
				<EntitlementProvider>
					<PredictSettings />
				</EntitlementProvider>
			</QueryClientProvider>
		)
	);
	await settle();
	return root;
}
async function select(node: Node) {
	await act(async () =>
		useNodeStore.setState({ nodes: [node], defaultNode: node.name })
	);
	await settle();
}
function allowedApps(): HTMLTextAreaElement {
	const input =
		document.querySelector<HTMLTextAreaElement>("#predict-allowlist");
	if (!input) throw new Error("Missing allowed apps setting");
	return input;
}
function debounce(): HTMLInputElement {
	const input = document.querySelector<HTMLInputElement>("#predict-debounce");
	if (!input) throw new Error("Missing debounce setting");
	return input;
}
async function fill(value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value"
		)?.set?.call(allowedApps(), value);
		allowedApps().dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function blur() {
	await act(async () =>
		allowedApps().dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
	);
	await settle();
}
async function retry() {
	const button = [...document.querySelectorAll("button")].find(
		(element) => element.textContent?.trim() === "Retry"
	);
	if (!button) throw new Error("Missing actionable Retry");
	await act(async () => button.click());
	await settle();
}
for (const destination of destinations) {
	test(`loads and saves the selected URL/token/user authority (${destination.name}, ${destination.url}, ${destination.userJwt}) without copying the previous config`, async () => {
		await mount();
		expect(allowedApps().value).toBe("FirstApp");
		await fill("unsaved old node");
		await select(destination);
		expect(allowedApps().value).toBe("SecondApp");
		expect(debounce().value).toBe("640");
		await fill(" Browser, Notes\n Terminal ");
		await blur();
		expect(calls).toEqual([
			call(first, "GET"),
			call(destination, "GET"),
			call(destination, "PUT", {
				...secondConfig,
				appAllowlist: ["Browser", "Notes", "Terminal"],
			}),
		]);
	});
	test(`an old delayed read cannot replace current authority (${destination.name}, ${destination.url}, ${destination.userJwt})`, async () => {
		const oldRead = pending();
		respond = (request) =>
			request.authorization === "Bearer first-token" &&
			request.userJwt === first.userJwt
				? oldRead.promise
				: Response.json(secondConfig);
		await mount();
		await select(destination);
		expect(allowedApps().value).toBe("SecondApp");
		await act(async () => oldRead.resolve(Response.json(firstConfig)));
		await settle();
		expect(allowedApps().value).toBe("SecondApp");
		expect(debounce().value).toBe("640");
		expect(calls).toEqual([call(first, "GET"), call(destination, "GET")]);
	});
}
for (const destination of destinations) {
	for (const status of [200, 503]) {
		test(`old HTTP ${status} write cannot rollback or unlock the new node's pending save (${destination.name}, ${destination.url}, ${destination.userJwt})`, async () => {
			const oldWrite = pending();
			const newWrite = pending();
			respond = (request) =>
				request.method === "GET"
					? Response.json(
							request.authorization === "Bearer first-token" &&
								request.userJwt === first.userJwt
								? firstConfig
								: secondConfig
						)
					: request.authorization === "Bearer first-token" &&
							request.userJwt === first.userJwt
						? oldWrite.promise
						: newWrite.promise;
			await mount();
			await fill("Old change");
			await blur();
			expect(allowedApps().disabled).toBe(true);
			await select(destination);
			await fill("New change");
			await blur();
			expect(allowedApps().disabled).toBe(true);
			await act(async () => oldWrite.resolve(Response.json({}, { status })));
			await settle();
			expect(allowedApps().value).toBe("New change");
			expect(allowedApps().disabled).toBe(true);
			expect(document.querySelector('[role="alert"]')).toBeNull();
			await blur();
			expect(calls.filter((entry) => entry.method === "PUT")).toHaveLength(2);
			await act(async () => newWrite.resolve(Response.json({})));
			await settle();
			expect(allowedApps().disabled).toBe(false);
			expect(calls).toEqual([
				call(first, "GET"),
				call(first, "PUT", { ...firstConfig, appAllowlist: ["Old change"] }),
				call(destination, "GET"),
				call(destination, "PUT", {
					...secondConfig,
					appAllowlist: ["New change"],
				}),
			]);
		});
	}
}

test("equivalent node objects preserve unsaved allowlist draft without another config read", async () => {
	await mount();
	await fill("Draft app");
	await select({ ...first });
	expect(allowedApps().value).toBe("Draft app");
	expect(calls).toEqual([call(first, "GET")]);
});
test("a refused save restores durable controls, retries the exact change and survives remount", async () => {
	let durable = firstConfig;
	let refuse = true;
	respond = (request) => {
		if (request.method === "GET") return Response.json(durable);
		if (refuse)
			return Response.json({ error: "permission refused" }, { status: 403 });
		durable = request.body ?? durable;
		return Response.json({});
	};
	const root = await mount();
	await fill("Wanted app");
	await blur();
	expect(allowedApps().value).toBe("FirstApp");
	expect(debounce().value).toBe("120");
	expect(document.querySelector('[role="alert"]')?.textContent).toContain(
		"couldn't save"
	);
	refuse = false;
	await retry();
	expect(allowedApps().value).toBe("Wanted app");
	await act(async () => root.unmount());
	roots.splice(roots.indexOf(root), 1);
	await mount();
	expect(allowedApps().value).toBe("Wanted app");
	const next = { ...firstConfig, appAllowlist: ["Wanted app"] };
	expect(calls).toEqual([
		call(first, "GET"),
		call(first, "PUT", next),
		call(first, "PUT", next),
		call(first, "GET"),
	]);
});
test("a refused config read blocks overwriting unknown settings and retries the read", async () => {
	let unavailable = true;
	respond = () =>
		unavailable
			? Response.json({ error: "no permission" }, { status: 403 })
			: Response.json(firstConfig);
	await mount();
	expect(allowedApps().disabled).toBe(true);
	expect(debounce().disabled).toBe(true);
	await fill("Must not overwrite unknown config");
	await blur();
	expect(calls).toEqual([call(first, "GET")]);
	unavailable = false;
	await retry();
	expect(allowedApps().disabled).toBe(false);
	expect(allowedApps().value).toBe("FirstApp");
	expect(calls).toEqual([call(first, "GET"), call(first, "GET")]);
});

for (const [draft, expected] of [
	["-15", 0],
	["9000", 5000],
	["not-a-number", 400],
] as const) {
	test(`debounce draft ${draft} persists its valid bounded value and preserves sibling settings`, async () => {
		let durable = firstConfig;
		respond = (request) => {
			if (request.method === "PUT") durable = request.body ?? durable;
			return Response.json(durable);
		};
		const root = await mount();
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value"
			)?.set?.call(debounce(), draft);
			debounce().dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(debounce().value).toBe(draft);
		expect(calls).toEqual([call(first, "GET")]);
		await act(async () =>
			debounce().dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
		);
		await settle();
		expect(debounce().value).toBe(String(expected));
		expect(calls).toEqual([
			call(first, "GET"),
			call(first, "PUT", { ...firstConfig, debounceMs: expected }),
		]);
		await act(async () => root.unmount());
		roots.splice(roots.indexOf(root), 1);
		await mount();
		expect(debounce().value).toBe(String(expected));
	});
}
