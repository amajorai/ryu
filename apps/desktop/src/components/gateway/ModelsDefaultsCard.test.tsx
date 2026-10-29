import {
	afterEach,
	beforeEach,
	expect,
	mock,
	setDefaultTimeout,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { ScopeDefault } from "@/src/lib/api/hierarchy.ts";

const HttpResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// Waits below are condition-based, never fixed sleeps, so a loaded host only
// makes a case slower. The bound is for capacity, not for correctness.
setDefaultTimeout(60_000);
// Every request the card and its pickers make goes through the page's fetch.
// Count each one until its whole body has arrived, so "nothing in flight"
// means the app holds every byte it asked for. The body is read here and handed
// on in a response of the same class with the same status, headers and bytes
// (happy-dom's `clone()` cannot be drained without emptying the original).
const pageFetch = globalThis.fetch;
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
let inFlight = 0;
globalThis.fetch = Object.assign(
	async (...args: Parameters<typeof fetch>) => {
		inFlight++;
		try {
			const response = await pageFetch(...args);
			const body = await response.arrayBuffer();
			const PageResponse = response.constructor as typeof Response;
			return new PageResponse(
				NULL_BODY_STATUSES.has(response.status) ? null : body,
				{
					headers: response.headers,
					status: response.status,
					statusText: response.statusText,
				}
			);
		} finally {
			inFlight--;
		}
	},
	{ preconnect: pageFetch.preconnect }
);
let target: ApiTarget;
let canConfigure: boolean;
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => target,
}));
const { createRoot } = await import("react-dom/client");
const { ModelsDefaultsCard } = await import("./ModelsDefaultsCard.tsx");
const { EntitlementProvider } = await import(
	"@/src/contexts/entitlement-context.tsx"
);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const originalNodeState = useNodeStore.getState();
const { queryClient } = await import("@/src/lib/query-client.ts");
const client = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const servers: { stop(force?: boolean): void }[] = [];
let secondUrl: string;
const roots: Root[] = [];
const first = {
	url: "",
	token: "one-token",
	userJwt: "one-user",
};
interface Call {
	authorization: string | null;
	body: ScopeDefault | null;
	identity: string | null;
	method: string;
	url: URL;
}
let calls: Call[];
let handler: (call: Call) => Response | Promise<Response>;
function defaults(model: string): ScopeDefault {
	return {
		coordinatorModel: `coordinator-${model}`,
		coordinatorProvider: "coordinator-provider",
		coordinatorEffort: "high",
		model: `thread-${model}`,
		provider: "thread-provider",
		effort: "low",
	};
}
function effective() {
	return {
		levels: {
			agent: null,
			agent_binding_model: null,
			global: {
				model: "lane-model",
				provider: "lane-provider",
				effort: "medium",
			},
			project: null,
			project_agent: null,
			session: null,
			settings: null,
		},
		resolved: {
			model: "lane-model",
			provider: "lane-provider",
			effort: "medium",
			model_source: "global",
			effort_source: "global",
		},
	};
}
// Responses a case is deliberately holding, and how many fixture requests are
// parked on one. A parked request is the case's own doing, so it does not count
// as unfinished work when deciding the page has settled.
const holds = new Map<Promise<Response>, (response: Response) => void>();
let parked = 0;
function deferred() {
	let release!: (response: Response) => void;
	const promise = new Promise<Response>((done) => {
		release = done;
	});
	const resolve = (response: Response) => {
		holds.delete(promise);
		release(response);
	};
	holds.set(promise, resolve);
	return { promise, resolve };
}
async function answer(
	response: Response | Promise<Response>
): Promise<Response> {
	if (!(response instanceof Promise && holds.has(response))) {
		return await response;
	}
	parked++;
	try {
		return await response;
	} finally {
		parked--;
	}
}
beforeEach(() => {
	target = { ...first };
	canConfigure = true;
	calls = [];
	client.clear();
	queryClient.clear();
	handler = (call) =>
		HttpResponse.json(
			call.url.pathname === "/api/scope-defaults"
				? {
						defaults: {
							global: defaults("a"),
							"project:untouched": defaults("project"),
						},
					}
				: effective()
		);
	const serve = () =>
		Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const respond = async () => {
					const url = new URL(request.url);
					const call: Call = {
						url,
						method: request.method,
						authorization: request.headers.get("authorization"),
						identity: request.headers.get("x-ryu-user-jwt"),
						body: request.method === "PUT" ? await request.json() : null,
					};
					if (
						url.pathname.startsWith("/api/scope-defaults") ||
						url.pathname === "/api/hierarchy/effective-defaults"
					) {
						calls.push(call);
						return await answer(handler(call));
					}
					if (url.pathname.endsWith("/catalog")) {
						return HttpResponse.json({
							providers: [],
							thinkingLevels: ["low", "medium", "high"],
						});
					}
					if (url.pathname === "/api/agents") {
						return HttpResponse.json({ agents: [] });
					}
					if (url.pathname === "/api/engine/active") {
						return HttpResponse.json({ engine: null, model: null });
					}
					if (url.pathname === "/api/engines") {
						return HttpResponse.json({ engines: [] });
					}
					if (url.pathname.startsWith("/api/preferences/")) {
						return HttpResponse.json({ value: null });
					}
					return HttpResponse.json(
						{
							error: `Unexpected fixture route ${request.method} ${url.pathname}`,
						},
						{ status: 404 }
					);
				};
				if (request.method === "OPTIONS") {
					return new HttpResponse(null, {
						status: 204,
						headers: {
							"Access-Control-Allow-Origin": "*",
							"Access-Control-Allow-Headers":
								"authorization,content-type,x-ryu-user-jwt",
							"Access-Control-Allow-Methods": "GET,PUT,DELETE,OPTIONS",
						},
					});
				}
				const response = await respond();
				response.headers.set("Access-Control-Allow-Origin", "*");
				return response;
			},
		});
	const one = serve();
	const two = serve();
	servers.push(one, two);
	first.url = one.url.origin;
	secondUrl = two.url.origin;
	target = { ...first };
	useNodeStore.setState({
		nodes: [{ ...first, name: "role-fixture", managed: false }],
		defaultNode: "role-fixture",
		autoSelect: false,
	});
});
afterEach(async () => {
	// Hold the fixture sockets open until every request has its answer: unmount
	// first so nothing new starts, release anything a case still holds, cancel
	// query retries, and only stop the servers once no request is in flight.
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	for (const release of [...holds.values()]) {
		release(HttpResponse.json({ error: "case ended" }, { status: 503 }));
	}
	await Promise.all([client.cancelQueries(), queryClient.cancelQueries()]);
	await until("drained fixture requests", () => inFlight === 0);
	queryClient.clear();
	client.clear();
	useNodeStore.setState(originalNodeState);
	for (const server of servers.splice(0)) {
		await server.stop(true);
	}
	document.body.replaceChildren();
});
function view() {
	return (
		<QueryClientProvider client={client}>
			<EntitlementProvider>
				<ModelsDefaultsCard canConfigure={canConfigure} target={target} />
			</EntitlementProvider>
		</QueryClientProvider>
	);
}
async function turn() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}
const UNTIL_BOUND_MS = 45_000;
/** Turn the event loop until `found` holds; fail naming `what` if it never does. */
async function until<T>(
	what: string,
	found: () => T | null | undefined | false
): Promise<T> {
	const deadline = Date.now() + UNTIL_BOUND_MS;
	for (;;) {
		const value = found();
		if (value) {
			return value;
		}
		if (Date.now() > deadline) {
			throw new Error(`Missing ${what}`);
		}
		await turn();
	}
}
function busy() {
	return (
		inFlight !== parked ||
		client.isFetching() > 0 ||
		client.isMutating() > 0 ||
		queryClient.isFetching() > 0 ||
		queryClient.isMutating() > 0
	);
}
/**
 * Settle on work, not on time: every request the page started has been
 * answered (or is parked on a response the case holds), React Query has nothing
 * pending, and three event-loop turns in a row start nothing new.
 */
async function settle() {
	let quiet = 0;
	await until("a settled page", () => {
		quiet = busy() ? 0 : quiet + 1;
		return quiet > 3;
	});
}
async function mount() {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () => root.render(view()));
	await settle();
	return root;
}
async function switchTarget(root: Root, next: ApiTarget) {
	target = next;
	await act(async () => root.render(view()));
	await settle();
}
function findButton(name: string) {
	return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
		(button) =>
			(button.getAttribute("aria-label") ?? button.textContent?.trim()) === name
	);
}
async function click(name: string) {
	const button = await until(name, () => findButton(name));
	await act(async () => button.click());
	await settle();
}
function button(name: string) {
	const button = findButton(name);
	if (!button) {
		throw new Error(`Missing ${name}`);
	}
	return button;
}
async function effort(role: "Coordinator" | "Thread", value: string) {
	await click(`${role} effort`);
	const option = await until(`${role} effort option ${value}`, () => {
		const popupId = button(`${role} effort`).getAttribute("aria-controls");
		const popup = popupId ? document.getElementById(popupId) : null;
		return [
			...(popup?.querySelectorAll<HTMLElement>('[role="option"]') ?? []),
		].find((option) => option.textContent?.trim() === value);
	});
	await act(async () => option.click());
	await settle();
}
async function remount(root: Root) {
	await act(async () => root.unmount());
	roots.splice(roots.indexOf(root), 1);
	return await mount();
}
for (const name of ["URL", "token", "JWT"] as const) {
	test(`old successful ${name} authority save cannot replace new policy or unlock its pending write`, async () => {
		const second = {
			...first,
			...(name === "URL"
				? { url: secondUrl }
				: name === "token"
					? { token: "two-token" }
					: { userJwt: "two-user" }),
		};
		const old = deferred();
		const fresh = deferred();
		handler = (call) =>
			call.method === "PUT"
				? call.authorization === "Bearer one-token" &&
					call.identity === "one-user" &&
					call.url.origin === first.url
					? old.promise
					: fresh.promise
				: HttpResponse.json(
						call.url.pathname === "/api/scope-defaults"
							? {
									defaults: {
										global: defaults(
											call.authorization === "Bearer one-token" &&
												call.identity === "one-user" &&
												call.url.origin === first.url
												? "a"
												: "b"
										),
									},
								}
							: effective()
					);
		const root = await mount();
		await effort("Thread", "High");
		await click("Save");
		await switchTarget(root, second);
		expect(button("Thread model").textContent).toContain("thread-b");
		await effort("Coordinator", "Low");
		await click("Save");
		await act(async () => old.resolve(HttpResponse.json({ success: true })));
		await settle();
		expect(button("Thread model").textContent).toContain("thread-b");
		expect(button("Save").disabled).toBe(true);
		await act(async () => fresh.resolve(HttpResponse.json({ success: true })));
		await settle();
		expect(button("Thread model").textContent).toContain("thread-b");
		expect(
			calls
				.filter((call) => call.method === "PUT")
				.map((call) => [
					call.url.href,
					call.authorization,
					call.identity,
					call.body,
				])
		).toEqual([
			[
				`${first.url}/api/scope-defaults/global`,
				"Bearer one-token",
				"one-user",
				{ ...defaults("a"), effort: "high" },
			],
			[
				`${second.url}/api/scope-defaults/global`,
				`Bearer ${second.token}`,
				second.userJwt,
				{ ...defaults("b"), coordinatorEffort: "low" },
			],
		]);
	});
}
test("equivalent target objects preserve dirty role edits without another read", async () => {
	const root = await mount();
	await effort("Thread", "High");
	const reads = calls.length;
	await switchTarget(root, { ...first });
	expect(button("Thread effort").textContent).toContain("High");
	expect(button("Save").disabled).toBe(false);
	expect(calls).toHaveLength(reads);
});
test("all role fields persist, refusal retains draft for retry, and reset clears only the global scope", async () => {
	let stored: ScopeDefault | null = defaults("a");
	const project = defaults("project");
	let reject = true;
	handler = (call) => {
		if (call.method === "PUT") {
			if (reject) {
				return HttpResponse.json({ error: "Refused" }, { status: 403 });
			}
			stored = call.body;
			return HttpResponse.json({ success: true });
		}
		if (call.method === "DELETE") {
			stored = null;
			return HttpResponse.json({ success: true });
		}
		return HttpResponse.json(
			call.url.pathname === "/api/scope-defaults"
				? {
						defaults: {
							...(stored ? { global: stored } : {}),
							"project:untouched": project,
						},
					}
				: effective()
		);
	};
	const root = await mount();
	await effort("Thread", "High");
	await effort("Coordinator", "Low");
	await click("Save");
	expect(stored).toEqual(defaults("a"));
	expect(button("Save").disabled).toBe(false);
	reject = false;
	await click("Save");
	expect(stored).toEqual({
		...defaults("a"),
		effort: "high",
		coordinatorEffort: "low",
	});
	await remount(root);
	expect(button("Thread effort").textContent).toContain("High");
	expect(button("Coordinator effort").textContent).toContain("Low");
	await click("Reset to defaults");
	expect(stored).not.toBeNull();
	await click("Apply now");
	expect(stored).toBeNull();
	expect(project).toEqual(defaults("project"));
	expect(button("Thread model").textContent).toContain("lane-model");
	const writes = calls.filter((call) => call.method !== "GET");
	expect(
		writes.map((call) => [
			call.url.pathname,
			call.method,
			call.body,
			call.authorization,
			call.identity,
		])
	).toEqual([
		[
			"/api/scope-defaults/global",
			"PUT",
			{ ...defaults("a"), effort: "high", coordinatorEffort: "low" },
			"Bearer one-token",
			"one-user",
		],
		[
			"/api/scope-defaults/global",
			"PUT",
			{ ...defaults("a"), effort: "high", coordinatorEffort: "low" },
			"Bearer one-token",
			"one-user",
		],
		[
			"/api/scope-defaults/global",
			"DELETE",
			null,
			"Bearer one-token",
			"one-user",
		],
	]);
});
test("failed stored reads block saving unknown policy and retry loads current values without a write", async () => {
	let fail = true;
	handler = (call) =>
		call.url.pathname === "/api/scope-defaults"
			? fail
				? HttpResponse.json({ error: "Forbidden" }, { status: 403 })
				: HttpResponse.json({ defaults: { global: defaults("recovered") } })
			: HttpResponse.json(effective());
	await mount();
	expect(document.body.textContent).toContain("Couldn't load");
	expect(document.querySelector('[aria-label="Thread model"]')).toBeNull();
	fail = false;
	await click("Retry");
	expect(button("Thread model").textContent).toContain("thread-recovered");
	expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
});
test("a Retry answered after a newer Retry cannot replace the newer stored read", async () => {
	// Retry stays clickable until a read lands, so two reads can overlap. The
	// older one must not overwrite the form with values the newer read replaced:
	// the next save writes every field and would copy the stale record back.
	let reads = 0;
	const held = deferred();
	let stored = defaults("newest");
	handler = (call) => {
		if (call.method === "PUT") {
			stored = call.body!;
			return HttpResponse.json({ success: true });
		}
		if (call.url.pathname !== "/api/scope-defaults") {
			return HttpResponse.json(effective());
		}
		reads++;
		if (reads === 1) {
			return HttpResponse.json({ error: "Forbidden" }, { status: 403 });
		}
		if (reads === 2) {
			return held.promise;
		}
		return HttpResponse.json({ defaults: { global: stored } });
	};
	await mount();
	expect(document.body.textContent).toContain("Couldn't load");
	await click("Retry");
	expect(document.body.textContent).toContain("Couldn't load");
	await click("Retry");
	expect(button("Thread model").textContent).toContain("thread-newest");
	await act(async () =>
		held.resolve(HttpResponse.json({ defaults: { global: defaults("stale") } }))
	);
	await settle();
	expect(button("Thread model").textContent).toContain("thread-newest");
	expect(button("Coordinator model").textContent).toContain(
		"coordinator-newest"
	);
	await effort("Thread", "High");
	await click("Save");
	expect(stored).toEqual({ ...defaults("newest"), effort: "high" });
});
test("pending duplicate Save cannot issue two global policy writes", async () => {
	const pending = deferred();
	handler = (call) =>
		call.method === "PUT"
			? pending.promise
			: HttpResponse.json(
					call.url.pathname === "/api/scope-defaults"
						? { defaults: { global: defaults("a") } }
						: effective()
				);
	await mount();
	await effort("Thread", "High");
	const save = button("Save");
	await act(async () => {
		save.click();
		save.click();
	});
	await settle();
	expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
	await act(async () => pending.resolve(HttpResponse.json({ success: true })));
	await settle();
});
for (const role of ["Coordinator", "Thread"] as const) {
	test(`${role} custom model and inherit clear persist only their own role while preserving the other role`, async () => {
		let stored = defaults("a");
		handler = (call) => {
			if (call.method === "PUT") {
				stored = call.body!;
				return HttpResponse.json({ success: true });
			}
			return HttpResponse.json(
				call.url.pathname === "/api/scope-defaults"
					? { defaults: { global: stored } }
					: effective()
			);
		};
		const root = await mount();
		await click(`${role} model`);
		const input = await until("the real custom-model entry", () =>
			document.querySelector<HTMLInputElement>('[aria-label="Custom model id"]')
		);
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value"
			)?.set?.call(input, "  custom-role-model  ");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await click("Use this model");
		await click("Save");
		await click("Apply now");
		const expected =
			role === "Coordinator"
				? {
						...defaults("a"),
						coordinatorModel: "custom-role-model",
						coordinatorProvider: "",
					}
				: { ...defaults("a"), model: "custom-role-model", provider: "" };
		expect(stored).toEqual(expected);
		await remount(root);
		expect(button(`${role} model`).textContent).toContain("custom-role-model");
		await click(`Use the default ${role.toLowerCase()} model`);
		await click("Save");
		await click("Apply now");
		const inherited =
			role === "Coordinator"
				? { ...expected, coordinatorModel: "" }
				: { ...expected, model: "" };
		expect(stored).toEqual(inherited);
		expect(
			calls
				.filter((call) => call.method === "PUT")
				.map((call) => [
					call.url.pathname,
					call.authorization,
					call.identity,
					call.body,
				])
		).toEqual([
			["/api/scope-defaults/global", "Bearer one-token", "one-user", expected],
			["/api/scope-defaults/global", "Bearer one-token", "one-user", inherited],
		]);
	});
}
test("a caller without configure permission can read both roles but cannot edit, save or reset them", async () => {
	canConfigure = false;
	await mount();
	for (const role of ["Coordinator", "Thread"]) {
		expect(button(`${role} model`).disabled).toBe(true);
		expect(button(`${role} effort`).disabled).toBe(true);
		await click(`${role} model`);
	}
	expect(document.querySelector('[aria-label="Custom model id"]')).toBeNull();
	expect(
		[...document.querySelectorAll("button")].some((element) =>
			["Save", "Reset to defaults"].includes(element.textContent?.trim() ?? "")
		)
	).toBe(false);
	expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
	expect(
		calls
			.filter(
				(call) => call.url.pathname === "/api/hierarchy/effective-defaults"
			)
			.map((call) => [
				call.url.searchParams.get("inherited_only"),
				call.url.searchParams.get("thread_role"),
				call.authorization,
				call.identity,
			])
	).toEqual([
		["true", "main", "Bearer one-token", "one-user"],
		["true", null, "Bearer one-token", "one-user"],
	]);
});
test("absent and null delegation preserve the same authority's unsaved role draft", async () => {
	target = { ...first, userJwt: null };
	const root = await mount();
	await effort("Thread", "High");
	const reads = calls.length;
	await switchTarget(root, { ...first, userJwt: undefined });
	expect(button("Thread effort").textContent).toContain("High");
	expect(button("Save").disabled).toBe(false);
	expect(calls).toHaveLength(reads);
});
function cacheDialog() {
	return document.querySelector('[role="alertdialog"]');
}
test("a model change asks before resetting the prompt cache, Cancel writes nothing, and effort-only saves never ask", async () => {
	let stored = defaults("a");
	handler = (call) => {
		if (call.method === "PUT") {
			stored = call.body!;
			return HttpResponse.json({ success: true });
		}
		return HttpResponse.json(
			call.url.pathname === "/api/scope-defaults"
				? { defaults: { global: stored } }
				: effective()
		);
	};
	await mount();
	await effort("Thread", "High");
	await click("Save");
	expect(cacheDialog()).toBeNull();
	expect(stored).toEqual({ ...defaults("a"), effort: "high" });
	await click("Thread model");
	const input = await until("the real custom-model entry", () =>
		document.querySelector<HTMLInputElement>('[aria-label="Custom model id"]')
	);
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(input, "switched-model");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await click("Use this model");
	await click("Save");
	expect(cacheDialog()?.textContent).toContain(
		"Apply now? This resets the prompt cache"
	);
	expect(cacheDialog()?.textContent).toContain(
		"Every thread that inherits the node-wide default switches model"
	);
	await click("Cancel");
	await until("the closed confirmation", () => cacheDialog() === null);
	expect(stored).toEqual({ ...defaults("a"), effort: "high" });
	expect(button("Thread model").textContent).toContain("switched-model");
	expect(button("Save").disabled).toBe(false);
	await click("Save");
	await click("Apply now");
	expect(stored).toEqual({
		...defaults("a"),
		effort: "high",
		model: "switched-model",
		provider: "",
	});
	expect(calls.filter((call) => call.method === "PUT")).toHaveLength(2);
});
