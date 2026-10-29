import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { DownloadSettings } from "@/src/lib/api/downloads.ts";
import type { Node } from "@/src/store/useNodeStore.ts";

const nativeFetch = globalThis.fetch;
const HttpResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// Passive transport guard: no response fabrication and no hook/auth alias.
const ownedOrigins = new Set<string>();
const rejectedEgress: string[] = [];
function requireOwned(input: string | URL | Request) {
	const address =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.href
				: input.url;
	const origin = new URL(address).origin;
	if (!ownedOrigins.has(origin)) {
		rejectedEgress.push(origin);
		console.error("DOWNLOAD_REJECTED_EGRESS", origin);
		throw new Error("Private downloads fixture refuses unowned network origin");
	}
}
const transparentFetch = (
	...args: Parameters<typeof nativeFetch>
): ReturnType<typeof nativeFetch> => {
	requireOwned(args[0]);
	return nativeFetch(...args);
};
globalThis.fetch = Object.assign(transparentFetch, {
	preconnect: (...args: Parameters<typeof nativeFetch.preconnect>) => {
		requireOwned(args[0]);
		return nativeFetch.preconnect(...args);
	},
});
const { createChatPageNativeDependencies } = await import(
	"@/e2e/harness/chat-page-native-http-dependencies.ts"
);
const nativeUnexpected: string[] = [];
const dependencies = createChatPageNativeDependencies(localStorage);
Reflect.set(window, "__TAURI_INTERNALS__", {
	metadata: {
		currentWindow: { label: "main" },
		currentWebview: { label: "main" },
	},
	invoke: async (command: string, args: Record<string, unknown> = {}) => {
		const result = dependencies.invoke(command, args);
		if (!result.handled) {
			nativeUnexpected.push(command);
			throw new Error(`Unimplemented native dependency ${command}`);
		}
		return result.value;
	},
	transformCallback: () => {
		nativeUnexpected.push("transformCallback");
		throw new Error("No native subscription belongs to this control");
	},
});
const { DownloadConcurrencyControl } = await import(
	"./DownloadConcurrencyControl.tsx"
);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const initialNodeState = useNodeStore.getState();
const { apiUrl } = await import("@/src/lib/api/client.ts");
let physicalPolicies = new Map<string, DownloadSettings>();
interface Call {
	authorization: string | null;
	body: unknown;
	method: string;
	status: number | null;
	url: string;
	userJwt: string | null;
}
interface Gate {
	promise: Promise<void>;
	resolve: () => void;
}
let gates: Gate[] = [];
function gate(): Gate {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	const value = { promise, resolve };
	gates.push(value);
	return value;
}
let calls: Call[];
let unexpected: string[];
let policies: Map<string, DownloadSettings>;
// Every fixture authority carries a managed-node JWT (`jwt-a` / `jwt-b`).
type FixtureNode = Node & { userJwt: string };
let a: FixtureNode;
let b: FixtureNode;
let nextReadStatus: number | null;
let nextWriteStatus: number;
let heldRead: Gate | null;
let heldWrite: Gate | null;
let servers: Bun.Server<undefined>[];
let root: Root | null;
let container: HTMLDivElement;
let client: QueryClient;
function key(node: Node) {
	return JSON.stringify([
		apiUrl(node, "/api/downloads/settings"),
		node.token ?? null,
		node.userJwt ?? null,
	]);
}
function view(mode: "auto" | "manual" = "auto", slots = 2): DownloadSettings {
	return {
		mode,
		manual_slots: slots,
		effective_slots: mode === "auto" ? 2 : slots,
		min_slots: 1,
		max_slots: 8,
		measured_bps: 0,
		env_locked: false,
	};
}
function start(): Bun.Server<undefined> {
	const server = Bun.serve<undefined>({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request: Request): Promise<Response> {
			const url = new URL(request.url);
			const method = request.method;
			const call: Call = {
				url: url.origin,
				method,
				authorization: request.headers.get("authorization"),
				userJwt: request.headers.get("x-ryu-user-jwt"),
				body: method === "PUT" ? await request.json() : null,
				status: null,
			};
			calls.push(call);
			const identity = JSON.stringify([
				apiUrl({ url: url.origin, token: null }, "/api/downloads/settings"),
				(call.authorization ?? "").replace(/^Bearer /, ""),
				call.userJwt,
			]);
			const knownAuthority = policies.has(identity);
			const physicalEndpoint = apiUrl(
				{ url: url.origin, token: null },
				"/api/downloads/settings"
			);
			const current = physicalPolicies.get(physicalEndpoint);
			const reply = (value: unknown, status = 200) => {
				call.status = status;
				return HttpResponse.json(value, { status });
			};
			if (
				url.pathname !== "/api/downloads/settings" ||
				url.search !== "" ||
				!knownAuthority ||
				!current ||
				!["GET", "PUT"].includes(method)
			) {
				unexpected.push(`${method} ${request.url} unknown/auth`);
				return reply({ error: "Unowned request" }, 403);
			}
			if (method === "GET") {
				const status = nextReadStatus;
				nextReadStatus = null;
				const wait = heldRead;
				heldRead = null;
				if (wait) {
					await wait.promise;
				}
				return status
					? reply({ error: "Settings read refused" }, status)
					: reply({ ...current });
			}
			const body = call.body as { mode?: unknown; max_concurrent?: unknown };
			if (
				!body ||
				Object.keys(body).some(
					(name) => name !== "mode" && name !== "max_concurrent"
				) ||
				(body.mode !== "auto" && body.mode !== "manual") ||
				(body.max_concurrent !== undefined &&
					!(
						typeof body.max_concurrent === "number" &&
						Number.isInteger(body.max_concurrent) &&
						body.max_concurrent >= 0
					))
			) {
				unexpected.push("Invalid PUT body");
				return reply({ error: "Invalid settings" }, 400);
			}
			const status = current.env_locked ? 409 : nextWriteStatus;
			nextWriteStatus = 200;
			const wait = heldWrite;
			heldWrite = null;
			if (wait) {
				await wait.promise;
			}
			if (status !== 200) {
				return reply(
					{
						error: current.env_locked
							? "Concurrency is pinned by the environment"
							: "Settings persist refused",
					},
					status
				);
			}
			const slots =
				typeof body.max_concurrent === "number"
					? Math.max(1, Math.min(8, body.max_concurrent))
					: current.manual_slots;
			const next: DownloadSettings = {
				...current,
				mode: body.mode,
				manual_slots: slots,
				effective_slots: body.mode === "manual" ? slots : 2,
			};
			physicalPolicies.set(physicalEndpoint, next);
			return reply(next);
		},
	});
	ownedOrigins.add(`http://127.0.0.1:${server.port}`);
	console.log("DOWNLOAD_FIXTURE_ORIGIN", `http://127.0.0.1:${server.port}`);
	return server;
}
async function pause() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 5));
	});
}
async function until(predicate: () => boolean, label: string) {
	for (let i = 0; i < 160 && !predicate(); i++) {
		await pause();
	}
	if (!predicate()) {
		throw new Error(`Timed out: ${label}`);
	}
}
function trigger(): HTMLButtonElement {
	const value = document.querySelector<HTMLButtonElement>('[role="combobox"]');
	if (!value) {
		throw new Error("Shipping concurrency selector not mounted");
	}
	return value;
}
async function choose(label: string) {
	await act(async () => trigger().click());
	await pause();
	const option = [
		...document.querySelectorAll<HTMLElement>('[role="option"]'),
	].find((item) => item.textContent?.trim() === label);
	if (!option) {
		throw new Error(`No actual Select option ${label}`);
	}
	await act(async () => option.click());
	await pause();
}
async function mount() {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client}>
				<DownloadConcurrencyControl />
			</QueryClientProvider>
		)
	);
}
async function node(node: Node) {
	await act(async () =>
		useNodeStore.setState({
			nodes: [node],
			localNodes: [node],
			cloudNodes: [],
			defaultNode: node.name,
			autoSelect: false,
			autoSelectedNode: null,
			tabOverrides: {},
		})
	);
	await pause();
}
async function ready(text: string) {
	await until(
		() =>
			document
				.querySelector('[role="combobox"]')
				?.textContent?.includes(text) === true,
		`actual saved selector ${text}`
	);
}
const writes = () => calls.filter((call) => call.method === "PUT");
async function read(node: Node): Promise<DownloadSettings> {
	const response = await globalThis.fetch(
		apiUrl(node, "/api/downloads/settings"),
		{
			headers: {
				authorization: `Bearer ${node.token}`,
				"x-ryu-user-jwt": node.userJwt ?? "",
			},
		}
	);
	if (response.status !== 200) {
		throw new Error(`Independent read returned ${response.status}`);
	}
	return response.json();
}
beforeEach(async () => {
	calls = [];
	unexpected = [];
	nativeUnexpected.length = 0;
	policies = new Map();
	physicalPolicies = new Map();
	nextReadStatus = null;
	nextWriteStatus = 200;
	heldRead = null;
	heldWrite = null;
	gates = [];
	servers = [];
	root = null;
	localStorage.clear();
	client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnWindowFocus: false },
			mutations: { retry: false },
		},
	});
	const server = start();
	servers.push(server);
	a = {
		name: "a",
		url: `http://127.0.0.1:${server.port}`,
		token: "node-a",
		userJwt: "jwt-a",
	};
	b = { ...a, name: "b", token: "node-b", userJwt: "jwt-b" };
	policies.set(key(a), view());
	policies.set(key(b), view());
	physicalPolicies.set(apiUrl(a, "/api/downloads/settings"), view());
	await node(a);
});
afterEach(async () => {
	for (const gate of gates) {
		gate.resolve();
	}
	heldRead?.resolve();
	heldWrite?.resolve();
	await act(async () => root?.unmount());
	container?.remove();
	client.clear();
	for (const server of servers) {
		server.stop(true);
		ownedOrigins.delete(`http://127.0.0.1:${server.port}`);
	}
	useNodeStore.setState(initialNodeState);
	if (unexpected.length || nativeUnexpected.length || rejectedEgress.length) {
		throw new Error(
			JSON.stringify({ unexpected, nativeUnexpected, rejectedEgress })
		);
	}
});
afterAll(() => {
	globalThis.fetch = nativeFetch;
});
test("real selector409 keeps acknowledged mode, identical retry persists manual slots, Auto omits slot override and independent GET/remount preserves it", async () => {
	await mount();
	await ready("Auto");
	nextWriteStatus = 409;
	await choose("3 at a time");
	await until(() => writes()[0]?.status === 409, "physical409 settled");
	expect(trigger().textContent).toContain("Auto");
	await until(
		() =>
			document
				.querySelector('[role="alert"]')
				?.textContent?.includes("Could not save download settings") === true,
		"visible rejected-save error"
	);
	expect(await read(a)).toEqual(view());
	await choose("3 at a time");
	await ready("3 at a time");
	expect(
		writes().map((call) => ({
			body: call.body,
			status: call.status,
			authorization: call.authorization,
			userJwt: call.userJwt,
		}))
	).toEqual(
		[409, 200].map((status) => ({
			body: { mode: "manual", max_concurrent: 3 },
			status,
			authorization: "Bearer node-a",
			userJwt: "jwt-a",
		}))
	);
	await choose("Auto");
	await ready("Auto");
	expect(writes().at(-1)?.body).toEqual({ mode: "auto" });
	expect(await read(a)).toEqual(view("auto", 3));
	await act(async () => root?.unmount());
	container.remove();
	await mount();
	await ready("Auto");
	expect(await read(a)).toEqual(view("auto", 3));
});
for (const status of [403, 503]) {
	test(`actual initial GET${status} remains visible/refused with Retry and no destructive PUT`, async () => {
		nextReadStatus = status;
		await mount();
		await until(
			() =>
				calls.some((call) => call.method === "GET" && call.status === status),
			"refused physical GET"
		);
		await until(
			() =>
				document
					.querySelector('[role="alert"]')
					?.textContent?.includes("Could not load download settings") === true,
			"visible refused-read error"
		);
		expect(document.querySelector('[role="combobox"]') === null).toBe(true);
		expect(writes()).toEqual([]);
		const retry = [
			...document.querySelectorAll<HTMLButtonElement>("button"),
		].find((button) => button.textContent === "Retry");
		expect(retry).toBeDefined();
		await act(async () => retry?.click());
		await ready("Auto");
		expect(writes()).toEqual([]);
		expect(await read(a)).toEqual(view());
	});
}
test("real environment-pinned view disables selector and transmits no PUT", async () => {
	physicalPolicies.set(apiUrl(a, "/api/downloads/settings"), {
		...view("manual", 4),
		env_locked: true,
	});
	await mount();
	await ready("4 at a time");
	expect(trigger().disabled).toBe(true);
	await act(async () => trigger().click());
	expect(writes()).toEqual([]);
	expect(document.body.textContent).toContain(
		"Set by RYU_MAX_CONCURRENT_DOWNLOADS on this node"
	);
});
for (const axis of ["URL", "token", "JWT"] as const) {
	async function switchTarget(seedFreshPolicy = true) {
		if (axis === "URL") {
			const server = start();
			servers.push(server);
			b = { ...a, name: "b", url: `http://127.0.0.1:${server.port}` };
		} else {
			b = {
				...a,
				name: "b",
				...(axis === "token" ? { token: "node-b" } : { userJwt: "jwt-b" }),
			};
		}
		policies.set(key(b), view());
		if (seedFreshPolicy) {
			physicalPolicies.set(
				apiUrl(b, "/api/downloads/settings"),
				view("manual", 5)
			);
		}
		await node(b);
	}
	test(`held old ${axis} initial GET cannot expose previous settings after new connection has loaded`, async () => {
		const old = gate();
		heldRead = old;
		await mount();
		await until(
			() => calls.some((call) => call.method === "GET" && call.status === null),
			"physical initial GET held"
		);
		await switchTarget();
		await ready("5 at a time");
		old.resolve();
		await until(
			() =>
				calls.some(
					(call) =>
						call.method === "GET" &&
						call.url === a.url &&
						call.authorization === "Bearer node-a" &&
						call.userJwt === "jwt-a" &&
						call.status === 200
				),
			"old physical read settled"
		);
		await pause();
		expect(trigger().textContent).toContain("5 at a time");
		expect(writes()).toEqual([]);
	});
	test(`warm ${axis} authority cache never exposes previous connection setting and reads exact new credentials`, async () => {
		await mount();
		await ready("Auto");
		await switchTarget();
		await ready("5 at a time");
		expect(
			calls.some(
				(call) =>
					call.method === "GET" &&
					call.url === b.url &&
					call.authorization === `Bearer ${b.token}` &&
					call.userJwt === b.userJwt
			)
		).toBe(true);
		expect(writes()).toEqual([]);
	});
	if (axis !== "URL") {
		test(`warm ${axis} change with GET403 cannot offer a previously authorized writable selector`, async () => {
			await mount();
			await ready("Auto");
			nextReadStatus = 403;
			await switchTarget();
			await until(
				() =>
					document
						.querySelector('[role="alert"]')
						?.textContent?.includes("Could not load download settings") ===
					true,
				"visible new authority403"
			);
			expect(document.querySelector('[role="combobox"]') === null).toBe(true);
			expect(writes()).toEqual([]);
			const retry = [
				...document.querySelectorAll<HTMLButtonElement>("button"),
			].find((button) => button.textContent === "Retry");
			await act(async () => retry?.click());
			await ready("5 at a time");
			expect(writes()).toEqual([]);
		});
	}
	if (axis === "URL") {
		for (const status of [200, 409]) {
			test(`held old ${axis} PUT${status} cannot publish result/error or unlock current connection save`, async () => {
				await mount();
				await ready("Auto");
				const old = gate();
				heldWrite = old;
				nextWriteStatus = status;
				await choose("3 at a time");
				await until(() => writes().length === 1, "old physical request held");
				expect(trigger().disabled).toBe(true);
				await act(async () => trigger().click());
				expect(writes()).toHaveLength(1);
				expect(writes()[0]?.status).toBeNull();
				await switchTarget();
				await ready("5 at a time");
				expect(trigger().disabled).toBe(false);
				const fresh = gate();
				heldWrite = fresh;
				await choose("6 at a time");
				await until(() => writes().length === 2, "new physical request held");
				old.resolve();
				await until(
					() =>
						client.getMutationCache().getAll()[0]?.state.status ===
						(status === 200 ? "success" : "error"),
					"old real SDK mutation settled"
				);
				await pause();
				expect(trigger().disabled).toBe(true);
				expect(trigger().textContent).toContain("5 at a time");
				expect(document.querySelector('[role="alert"]') === null).toBe(true);
				fresh.resolve();
				await ready("6 at a time");
				expect(await read(b)).toEqual(view("manual", 6));
				expect(await read(a)).toEqual(
					status === 200 ? view("manual", 3) : view()
				);
			});
		}
	}
	if (axis !== "URL") {
		for (const status of [200, 409]) {
			test(`same physical endpoint ${axis} rotation waits PUT${status} then reads node-wide policy before editing`, async () => {
				physicalPolicies.set(
					apiUrl(a, "/api/downloads/settings"),
					view("manual", 2)
				);
				await mount();
				await ready("2 at a time");
				const old = gate();
				heldWrite = old;
				nextWriteStatus = status;
				await choose("6 at a time");
				await until(
					() => writes().length === 1,
					"old authenticated PUT dispatched"
				);
				const readsBefore = calls.filter(
					(call) => call.method === "GET"
				).length;
				await switchTarget(false);
				await pause();
				expect(document.querySelector('[role="combobox"]') === null).toBe(true);
				expect(calls.filter((call) => call.method === "GET")).toHaveLength(
					readsBefore
				);
				expect(writes()).toHaveLength(1);
				expect(
					physicalPolicies.get(apiUrl(a, "/api/downloads/settings"))
				).toEqual(view("manual", 2));
				old.resolve();
				await ready(status === 200 ? "6 at a time" : "2 at a time");
				expect(document.querySelector('[role="alert"]') === null).toBe(true);
				expect(
					calls.some(
						(call) =>
							call.method === "GET" &&
							call.authorization === `Bearer ${b.token}` &&
							call.userJwt === b.userJwt &&
							call.status === 200
					)
				).toBe(true);
				const acknowledged =
					status === 200 ? view("manual", 6) : view("manual", 2);
				expect(await read(a)).toEqual(acknowledged);
				expect(await read(b)).toEqual(acknowledged);
				const fresh = gate();
				heldWrite = fresh;
				await choose("4 at a time");
				await until(
					() => writes().length === 2,
					"current authenticated write held"
				);
				expect(writes()[1]?.body).toEqual({
					mode: "manual",
					max_concurrent: 4,
				});
				expect(writes()[1]?.authorization).toBe(`Bearer ${b.token}`);
				expect(writes()[1]?.userJwt).toBe(b.userJwt ?? null);
				expect(
					physicalPolicies.get(apiUrl(a, "/api/downloads/settings"))
				).toEqual(acknowledged);
				fresh.resolve();
				await ready("4 at a time");
				expect(await read(a)).toEqual(view("manual", 4));
				expect(await read(b)).toEqual(view("manual", 4));
				expect(physicalPolicies.size).toBe(1);
			});
		}
	}
}
for (const status of [200, 409]) {
	test(`returning A while old PUT${status} is pending cannot start a replacement write and reads canonical acknowledgment before editing`, async () => {
		await mount();
		await ready("Auto");
		const old = gate();
		heldWrite = old;
		nextWriteStatus = status;
		await choose("3 at a time");
		await until(() => writes().length === 1, "held A write");
		await node(b);
		await pause();
		expect(document.querySelector('[role="combobox"]') === null).toBe(true);
		const readsBefore = calls.filter(
			(call) => call.method === "GET" && call.authorization === "Bearer node-a"
		).length;
		await node(a);
		expect(document.querySelector('[role="combobox"]') === null).toBe(true);
		expect(writes()).toHaveLength(1);
		expect(
			calls.filter(
				(call) =>
					call.method === "GET" && call.authorization === "Bearer node-a"
			)
		).toHaveLength(readsBefore);
		old.resolve();
		await ready(status === 200 ? "3 at a time" : "Auto");
		expect(
			calls.filter(
				(call) =>
					call.method === "GET" && call.authorization === "Bearer node-a"
			).length
		).toBeGreaterThan(readsBefore);
		expect(document.querySelector('[role="alert"]') === null).toBe(true);
		await choose("4 at a time");
		await ready("4 at a time");
		expect(await read(a)).toEqual(view("manual", 4));
		expect(await read(b)).toEqual(view("manual", 4));
	});
}
test("physical teardown with an already-sent write waits on fresh remount and reads actual saved result without stale error", async () => {
	await mount();
	await ready("Auto");
	const old = gate();
	heldWrite = old;
	await choose("3 at a time");
	await until(() => writes().length === 1, "held before physical detach");
	await act(async () => root?.unmount());
	container.remove();
	await mount();
	expect(document.querySelector('[role="combobox"]') === null).toBe(true);
	old.resolve();
	await ready("3 at a time");
	expect(await read(a)).toEqual(view("manual", 3));
	expect(document.querySelector('[role="alert"]') === null).toBe(true);
	expect(writes()).toHaveLength(1);
});
test("same-turn real selection then committed B→A acquires the pending barrier before any HTTP mutation dispatch", async () => {
	await mount();
	await ready("Auto");
	const old = gate();
	heldWrite = old;
	await act(async () => trigger().click());
	await pause();
	const option = [
		...document.querySelectorAll<HTMLElement>('[role="option"]'),
	].find((item) => item.textContent?.trim() === "3 at a time");
	expect(option).toBeDefined();
	const readsBefore = calls.filter(
		(call) => call.method === "GET" && call.authorization === "Bearer node-a"
	).length;
	await act(async () => {
		// Native DOM handler schedules its genuine Tanstack mutation. The external
		// store handoffs commit before yielding to that scheduled async dispatch.
		option?.click();
		flushSync(() =>
			useNodeStore.setState({
				nodes: [b],
				localNodes: [b],
				defaultNode: b.name,
			})
		);
		flushSync(() =>
			useNodeStore.setState({
				nodes: [a],
				localNodes: [a],
				defaultNode: a.name,
			})
		);
	});
	await until(() => writes().length === 1, "original physical PUT dispatched");
	expect(document.querySelector('[role="combobox"]') === null).toBe(true);
	expect(
		calls.filter(
			(call) => call.method === "GET" && call.authorization === "Bearer node-a"
		)
	).toHaveLength(readsBefore);
	expect(writes()[0]?.body).toEqual({ mode: "manual", max_concurrent: 3 });
	old.resolve();
	await ready("3 at a time");
	expect(
		calls.filter(
			(call) => call.method === "GET" && call.authorization === "Bearer node-a"
		).length
	).toBeGreaterThan(readsBefore);
	expect(await read(a)).toEqual(view("manual", 3));
});

for (const status of [200, 409] as const) {
	test(`SDK-equivalent trailing slash waits for physical-node PUT${status} acknowledgement before fresh canonical GET`, async () => {
		const canonicalEndpoint = apiUrl(a, "/api/downloads/settings");
		physicalPolicies.set(canonicalEndpoint, view("manual", 2));
		await mount();
		await ready("2 at a time");
		const original = await read(a);
		expect(original).toEqual(view("manual", 2));
		const old = gate();
		heldWrite = old;
		nextWriteStatus = status;
		await choose("6 at a time");
		await until(() => writes().length === 1, "physical node write held");
		expect(writes()[0]?.body).toEqual({ mode: "manual", max_concurrent: 6 });
		expect(writes()[0]?.status).toBeNull();
		expect(trigger().disabled).toBe(true);
		const slash = { ...a, url: `${a.url}/` };
		expect(apiUrl(slash, "/api/downloads/settings")).toBe(canonicalEndpoint);
		const readsBefore = calls.filter((call) => call.method === "GET").length;
		await node(slash);
		expect(document.querySelector('[role="combobox"]') === null).toBe(true);
		expect(calls.filter((call) => call.method === "GET")).toHaveLength(
			readsBefore
		);
		expect(writes()).toHaveLength(1);
		expect(physicalPolicies.get(canonicalEndpoint)).toEqual(original);
		old.resolve();
		await ready(status === 200 ? "6 at a time" : "2 at a time");
		expect(
			calls.filter((call) => call.method === "GET").length
		).toBeGreaterThan(readsBefore);
		expect(document.querySelector('[role="alert"]') === null).toBe(true);
		const acknowledged = status === 200 ? view("manual", 6) : original;
		expect(await read(slash)).toEqual(acknowledged);
		expect(await read(a)).toEqual(acknowledged);
		expect(physicalPolicies.size).toBe(1);
		expect(physicalPolicies.get(canonicalEndpoint)).toEqual(acknowledged);
		expect(
			writes().map((call) => ({
				body: call.body,
				status: call.status,
				authorization: call.authorization,
				userJwt: call.userJwt,
			}))
		).toEqual([
			{
				body: { mode: "manual", max_concurrent: 6 },
				status,
				authorization: "Bearer node-a",
				userJwt: "jwt-a",
			},
		]);
		await choose("4 at a time");
		await ready("4 at a time");
		expect(await read(a)).toEqual(view("manual", 4));
		expect(await read(slash)).toEqual(view("manual", 4));
	});
}

// SDK apiUrl strips one trailing slash before rejecting an empty base. The
// identity resource must defer that refusal to the query, keeping Retry reachable.
test("SDK-empty slash target shows refused read and Retry, then recovers on a valid node without any invalid-target HTTP", async () => {
	await node({ ...a, url: "/" });
	await mount();
	await until(
		() =>
			document
				.querySelector('[role="alert"]')
				?.textContent?.includes("Could not load download settings") === true,
		"invalid target query error"
	);
	expect(document.querySelector('[role="combobox"]') === null).toBe(true);
	expect(calls).toHaveLength(0);
	const retry = [
		...document.querySelectorAll<HTMLButtonElement>("button"),
	].find((button) => button.textContent === "Retry");
	expect(retry).toBeDefined();
	await act(async () => retry?.click());
	await pause();
	expect(calls).toHaveLength(0);
	expect(document.querySelector('[role="alert"]')?.textContent).toContain(
		"Could not load download settings"
	);
	await node(a);
	await ready("Auto");
	expect(await read(a)).toEqual(view());
	expect(writes()).toEqual([]);
});
