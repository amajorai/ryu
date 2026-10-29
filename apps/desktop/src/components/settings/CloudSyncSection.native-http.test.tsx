import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { Node } from "@/src/store/useNodeStore.ts";

const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const ownedOrigins = new Set<string>();
const rejectedEgress: string[] = [];
interface TransportRead {
	decoded: boolean;
	id: number;
	jwt: string | null;
	method: string;
	token: string | null;
	url: string;
}
let transports: TransportRead[] = [];
let heldClientId: number | null = null;
let currentWriteId: number | null = null;
let currentReadId: number | null = null;
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
		throw new Error("Cloud sync proof refuses unowned network origin");
	}
	return address;
}
globalThis.fetch = Object.assign(
	async (...args: Parameters<typeof nativeFetch>) => {
		const address = requireOwned(args[0]);
		const requestInput =
			typeof args[0] === "string" || args[0] instanceof URL ? null : args[0];
		const method = (
			args[1]?.method ??
			requestInput?.method ??
			"GET"
		).toUpperCase();
		const headers = new Headers(args[1]?.headers ?? requestInput?.headers);
		const operation: TransportRead = {
			id: transports.length + 1,
			method,
			url: address,
			token: headers.get("authorization"),
			jwt: headers.get("x-ryu-user-jwt"),
			decoded: false,
		};
		transports.push(operation);
		if (method === "PUT" && holdNextWrite) {
			heldClientId = operation.id;
		}
		if (headers.get("authorization") === `Bearer ${node("B").token}`) {
			if (method === "PUT" && holdCurrentWrite) {
				currentWriteId = operation.id;
			}
			if (
				method === "GET" &&
				holdCurrentRead &&
				address.endsWith("/api/preferences/cloud-sync-enabled")
			) {
				currentReadId = operation.id;
			}
		}
		const response = await nativeFetch(...args);
		const text = response.text.bind(response);
		response.text = async () => {
			const body = await text();
			operation.decoded = true;
			return body;
		};
		return response;
	},
	{
		preconnect: (...args: Parameters<typeof nativeFetch.preconnect>) => {
			requireOwned(args[0]);
			return nativeFetch.preconnect(...args);
		},
	}
);
const { sileo } = await import("sileo");
const { createRoot } = await import("react-dom/client");
const { CloudSyncSection } = await import("./CloudSyncSection.tsx");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { apiUrl } = await import("@/src/lib/api/client.ts");
const { getCloudSyncEnabled, setCloudSyncEnabled } = await import(
	"@/src/lib/api/preferences.ts"
);
const originalNodeState = useNodeStore.getState();
type Slot = "A" | "B";
type Dimension = "URL" | "token" | "JWT" | "alias";
interface Call {
	body: unknown;
	jwt: string | null;
	method: string;
	path: string;
	settled: boolean;
	slot: Slot;
	token: string | null;
}
let server: ReturnType<typeof Bun.serve>;
let mode: Dimension;
let physical: Map<string, string>;
let calls: Call[];
let unexpected: string[];
let holdNextWrite = false;
let refuseHeldWrite = false;
let refuseNextWrite = false;
let releaseHeld: (() => void) | null = null;
let holdCurrentWrite = false;
let refuseCurrentWrite = false;
let holdCurrentRead = false;
let releaseCurrentWrite: (() => void) | null = null;
let releaseCurrentRead: (() => void) | null = null;
let root: Root;
let container: HTMLDivElement;
function node(slot: Slot): Node {
	return {
		name: slot,
		url:
			server.url.origin +
			(mode === "URL"
				? `/${slot}`
				: mode === "alias" && slot === "B"
					? "/shared/"
					: "/shared"),
		token: mode === "JWT" || mode === "alias" ? "shared-node" : `node-${slot}`,
		userJwt:
			mode === "token" || mode === "alias" ? "shared-user" : `user-${slot}`,
	};
}
// Core preferences belong to the canonical physical node, independent of
// admission token/JWT. Distinct URL prefixes model genuinely distinct nodes.
function canonicalUri(raw: string) {
	return apiUrl(
		{ url: raw, token: null },
		"/api/preferences/cloud-sync-enabled"
	);
}
function saved(slot: Slot) {
	return physical.get(canonicalUri(node(slot).url)) ?? "false";
}
function selected(slot: Slot) {
	const nodes = [node("A"), node("B")];
	useNodeStore.setState({
		nodes,
		localNodes: nodes,
		cloudNodes: [],
		defaultNode: slot,
		tabOverrides: {},
		autoSelect: false,
		autoSelectedNode: null,
	});
}
beforeEach(() => {
	sileo.clear();
	mode = "URL";
	physical = new Map();
	calls = [];
	unexpected = [];
	transports = [];
	heldClientId = null;
	currentWriteId = null;
	currentReadId = null;
	holdCurrentWrite = false;
	refuseCurrentWrite = false;
	holdCurrentRead = false;
	releaseCurrentWrite = null;
	releaseCurrentRead = null;
	holdNextWrite = false;
	refuseHeldWrite = false;
	refuseNextWrite = false;
	releaseHeld = null;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const token = request.headers.get("authorization");
			const jwt = request.headers.get("x-ryu-user-jwt");
			const offset = url.pathname.indexOf("/api/");
			const path = offset < 0 ? url.pathname : url.pathname.slice(offset);
			const slot = (["A", "B"] as const).find((candidate) => {
				const target = node(candidate);
				return (
					url.href === apiUrl(target, path) &&
					token === `Bearer ${target.token}` &&
					jwt === target.userJwt
				);
			});
			const resourceKey = url.href;
			const body: unknown =
				request.method === "PUT" ? await request.json() : null;
			if (
				!slot ||
				url.search ||
				!["/api/auth/status", "/api/preferences/cloud-sync-enabled"].includes(
					path
				) ||
				(path === "/api/auth/status" && request.method !== "GET") ||
				(path !== "/api/auth/status" &&
					!["GET", "PUT"].includes(request.method))
			) {
				unexpected.push(`${request.method} ${url.pathname}`);
				return NativeResponse.json(
					{ error: "Unknown finite cloud sync contract" },
					{ status: 400 }
				);
			}
			const call: Call = {
				slot,
				method: request.method,
				path,
				body,
				token,
				jwt,
				settled: false,
			};
			calls.push(call);
			if (path === "/api/auth/status") {
				call.settled = true;
				return NativeResponse.json({ authenticated: true });
			}
			if (request.method === "GET") {
				const value = physical.get(resourceKey) ?? "false";
				if (slot === "B" && holdCurrentRead) {
					holdCurrentRead = false;
					await new Promise<void>((resolve) => {
						releaseCurrentRead = resolve;
					});
				}
				call.settled = true;
				return NativeResponse.json({
					key: "cloud-sync-enabled",
					value,
				});
			}
			if (
				!body ||
				typeof body !== "object" ||
				Array.isArray(body) ||
				Object.keys(body).length !== 1 ||
				!("value" in body) ||
				(body.value !== "true" && body.value !== "false")
			) {
				unexpected.push("Malformed preference body");
				return NativeResponse.json(
					{ error: "Malformed preference" },
					{ status: 400 }
				);
			}
			const held = slot === "A" && holdNextWrite;
			const heldCurrent = slot === "B" && holdCurrentWrite;
			const refused =
				refuseNextWrite ||
				(held && refuseHeldWrite) ||
				(heldCurrent && refuseCurrentWrite);
			refuseNextWrite = false;
			if (held) {
				holdNextWrite = false;
				await new Promise<void>((resolve) => {
					releaseHeld = resolve;
				});
			}
			if (heldCurrent) {
				holdCurrentWrite = false;
				await new Promise<void>((resolve) => {
					releaseCurrentWrite = resolve;
				});
			}
			call.settled = true;
			if (refused) {
				return NativeResponse.json(
					{ error: "Retired A preference refused" },
					{ status: 503 }
				);
			}
			physical.set(resourceKey, body.value);
			return NativeResponse.json({
				key: "cloud-sync-enabled",
				value: physical.get(resourceKey) ?? "false",
			});
		},
	});
	physical.set(canonicalUri(`${server.url.origin}/A`), "false");
	physical.set(canonicalUri(`${server.url.origin}/B`), "true");
	ownedOrigins.add(server.url.origin);
	selected("A");
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	if (releaseCurrentWrite) {
		await consumedCurrentWrite();
	}
	if (releaseCurrentRead) {
		await consumedCurrentRead();
	}
	if (releaseHeld) {
		await consumedOldWrite();
	}
	await act(async () => root.unmount());
	server.stop(true);
	ownedOrigins.delete(server.url.origin);
	container.remove();
	useNodeStore.setState(originalNodeState, true);
	sileo.clear();
	// biome-ignore lint/suspicious/noMisplacedAssertion: Bun afterEach independently rejects unknown HTTP contracts for every real test.
	expect(unexpected).toEqual([]);
	// biome-ignore lint/suspicious/noMisplacedAssertion: Bun teardown independently rejects unowned network origins for every real test.
	expect(rejectedEgress).toEqual([]);
});
afterAll(() => {
	globalThis.fetch = nativeFetch;
	// biome-ignore lint/suspicious/noMisplacedAssertion: Bun teardown independently rejects unowned network origins for every real test.
	expect(rejectedEgress).toEqual([]);
});
async function until(check: () => boolean) {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= deadline) {
			throw new Error(
				"Cloud sync did not settle: " +
					document.body.textContent +
					" ledger=" +
					JSON.stringify(calls)
			);
		}
		await act(async () => {
			await Bun.sleep(5);
		});
	}
}
function control(): HTMLElement {
	const button = container.querySelector<HTMLElement>(
		'[role="switch"][aria-label="Sync my chats and Spaces across devices"]'
	);
	if (!button) {
		throw new Error("Shipping cloud sync switch not mounted");
	}
	return button;
}
const checked = () => control().getAttribute("aria-checked") === "true";
async function mount() {
	await act(async () =>
		root.render(
			<>
				<CloudSyncSection />
				<Toaster position="bottom-right" />
			</>
		)
	);
}
async function ready(value: boolean) {
	await until(
		() =>
			Boolean(container.querySelector('[role="switch"]')) &&
			control().getAttribute("aria-disabled") !== "true" &&
			checked() === value
	);
}
async function toggle() {
	await act(async () => control().click());
}
async function rotate(slot: Slot) {
	await act(async () => selected(slot));
}
async function consumedOldWrite() {
	const release = releaseHeld;
	if (!release) {
		throw new Error("No actual held A HTTP request");
	}
	await act(async () => {
		releaseHeld = null;
		release();
	});
	const id = heldClientId;
	if (id === null) {
		throw new Error("Held PUT has no actual transport identity");
	}
	await until(() =>
		transports.some((operation) => operation.id === id && operation.decoded)
	);
	const operation = transports.find((operation) => operation.id === id);
	// biome-ignore lint/suspicious/noMisplacedAssertion: Every caller is a real HTTP test; retain exact captured PUT response identity.
	expect(operation?.method).toBe("PUT");
	// biome-ignore lint/suspicious/noMisplacedAssertion: Every caller is a real HTTP test; retain exact captured preference response endpoint.
	expect(operation?.url).toContain("/api/preferences/cloud-sync-enabled");
	await act(async () => {
		await new Promise<void>((resolve) => queueMicrotask(resolve));
	});
}
async function readPersistedSync(target: Node): Promise<boolean> {
	let value: boolean | undefined;
	await act(async () => {
		value = await getCloudSyncEnabled(target);
	});
	if (value === undefined) {
		throw new Error("Actual SDK readback did not finish");
	}
	return value;
}
const writes = () => calls.filter((call) => call.method === "PUT");
test("same-authority refused sync save retains actual persisted Boolean, retries identical body and reads saved value after remount", async () => {
	await mount();
	await ready(false);
	refuseNextWrite = true;
	await toggle();
	await until(
		() =>
			document.body.textContent?.includes("Couldn't save your sync choice") ===
			true
	);
	expect(checked()).toBe(false);
	expect(saved("A")).toBe("false");
	expect(writes().map((call) => call.body)).toEqual([{ value: "true" }]);
	await toggle();
	await until(() => saved("A") === "true");
	expect(checked()).toBe(true);
	expect(writes().map((call) => call.body)).toEqual([
		{ value: "true" },
		{ value: "true" },
	]);
	await act(async () => root.unmount());
	root = createRoot(container);
	await mount();
	await ready(true);
	expect(
		calls.filter(
			(call) =>
				call.slot === "A" &&
				call.path === "/api/preferences/cloud-sync-enabled" &&
				call.method === "GET"
		)
	).toHaveLength(2);
	expect(
		writes().every(
			(call) => call.token === "Bearer node-A" && call.jwt === "user-A"
		)
	).toBe(true);
});
for (const dimension of ["URL", "token", "JWT"] as const) {
	test(`actual shipping sync control loads and writes current ${dimension} authority after same-component rotation`, async () => {
		mode = dimension;
		selected("A");
		await mount();
		await ready(false);
		if (dimension !== "URL") {
			await act(async () => {
				await setCloudSyncEnabled(node("B"), true);
			});
		}
		const beforeWrites = writes().length;
		await rotate("B");
		await ready(true);
		const currentRead = calls.find(
			(call) =>
				call.slot === "B" &&
				call.method === "GET" &&
				call.path === "/api/preferences/cloud-sync-enabled"
		);
		expect(currentRead).toBeDefined();
		await toggle();
		await until(() => saved("B") === "false");
		expect(checked()).toBe(false);
		expect(saved("A")).toBe("false");
		expect(writes().slice(beforeWrites)).toHaveLength(1);
		expect(writes()[beforeWrites]).toMatchObject({
			slot: "B",
			body: { value: "false" },
			token: `Bearer ${node("B").token}`,
			jwt: node("B").userJwt,
		});
		expect(await readPersistedSync(node("B"))).toBe(false);
	});
}
test("accepted captured A sync write preserves actual A resource while current B state and fresh read stay independent", async () => {
	await mount();
	await ready(false);
	holdNextWrite = true;
	await toggle();
	await until(() => releaseHeld !== null);
	await rotate("B");
	await ready(true);
	await toggle();
	await until(() => saved("B") === "false");
	await consumedOldWrite();
	expect(saved("A")).toBe("true");
	expect(checked()).toBe(false);
	expect(await readPersistedSync(node("B"))).toBe(false);
	expect(await readPersistedSync(node("A"))).toBe(true);
	expect(
		writes().map((call) => ({
			slot: call.slot,
			body: call.body,
			settled: call.settled,
		}))
	).toEqual([
		{ slot: "A", body: { value: "true" }, settled: true },
		{ slot: "B", body: { value: "false" }, settled: true },
	]);
});
for (const dimension of ["URL", "token", "JWT", "ABA"] as const) {
	test(`consumed retired A refusal cannot roll back current sync choice or publish error after ${dimension}`, async () => {
		mode = dimension === "ABA" ? "URL" : dimension;
		selected("A");
		await mount();
		await ready(false);
		holdNextWrite = true;
		refuseHeldWrite = true;
		await toggle();
		await until(() => releaseHeld !== null);
		if (dimension === "token" || dimension === "JWT") {
			await act(async () => {
				await setCloudSyncEnabled(node("B"), true);
			});
		}
		await rotate("B");
		await ready(true);
		if (dimension === "ABA") {
			await rotate("A");
			await ready(false);
			await toggle();
			await until(() => saved("A") === "true");
		}
		await consumedOldWrite();
		expect(checked()).toBe(true);
		expect(document.body.textContent).not.toContain(
			"Couldn't save your sync choice"
		);
		expect(await readPersistedSync(node(dimension === "ABA" ? "A" : "B"))).toBe(
			true
		);
		expect(writes()[0]).toMatchObject({
			slot: "A",
			body: { value: "true" },
			settled: true,
		});
		if (dimension !== "ABA") {
			expect(saved("A")).toBe(dimension === "URL" ? "false" : "true");
			expect(writes()).toHaveLength(dimension === "URL" ? 1 : 2);
		}
	});
}
for (const dimension of ["token", "JWT", "ABA", "alias"] as const) {
	test(`accepted captured write refreshes the one physical node through current authority after ${dimension}`, async () => {
		mode = dimension === "ABA" ? "token" : dimension;
		selected("A");
		await mount();
		await ready(false);
		holdNextWrite = true;
		await toggle();
		await until(() => releaseHeld !== null);
		await rotate("B");
		await ready(false);
		if (dimension === "ABA") {
			await rotate("A");
			await ready(false);
		}
		const current = node(dimension === "ABA" ? "A" : "B");
		const readsBeforeAck = calls.filter(
			(call) =>
				call.method === "GET" &&
				call.path === "/api/preferences/cloud-sync-enabled"
		).length;
		await consumedOldWrite();
		expect(saved("A")).toBe("true");
		expect(saved("B")).toBe("true");
		// Observe the SHIPPING consumer's reconciliation request before making
		// the independent SDK readback below. That read cannot satisfy this oracle.
		await until(
			() =>
				calls.filter(
					(call) =>
						call.method === "GET" &&
						call.path === "/api/preferences/cloud-sync-enabled"
				).length > readsBeforeAck
		);
		const refresh = calls
			.filter(
				(call) =>
					call.method === "GET" &&
					call.path === "/api/preferences/cloud-sync-enabled"
			)
			.at(-1);
		expect(refresh).toMatchObject({
			token: `Bearer ${current.token}`,
			jwt: current.userJwt,
			settled: true,
		});
		await ready(true);
		expect(await readPersistedSync(current)).toBe(true);
		expect(document.body.textContent).not.toContain(
			"Couldn't save your sync choice"
		);
		expect(writes()).toHaveLength(1);
		expect(writes()[0]).toMatchObject({
			slot: "A",
			body: { value: "true" },
			settled: true,
		});
	});
}
test("an invalid current node URL cannot render a usable sync switch or write the prior node", async () => {
	await mount();
	await ready(false);
	const before = calls.length;
	await act(async () => {
		const invalid = { ...node("B"), url: "" };
		useNodeStore.setState({
			nodes: [invalid],
			localNodes: [invalid],
			defaultNode: "B",
		});
	});
	await until(
		() =>
			container.textContent?.includes(
				"We couldn't read this node's sync settings."
			) === true
	);
	expect(container.querySelector('[role="switch"]') === null).toBe(true);
	expect(calls).toHaveLength(before);
	expect(writes()).toEqual([]);
	expect(saved("A")).toBe("false");
	const retry = [
		...container.querySelectorAll<HTMLButtonElement>("button"),
	].find((button) => button.textContent === "Retry");
	if (!retry) {
		throw new Error("Actual invalid-target retry action missing");
	}
	await act(async () => retry.click());
	await until(
		() =>
			container.textContent?.includes(
				"We couldn't read this node's sync settings."
			) === true
	);
	expect(container.querySelector('[role="switch"]') === null).toBe(true);
	expect(calls).toHaveLength(before);
	expect(writes()).toEqual([]);
});

// These holds pause genuine network responses while the one node-wide preference
// remains authoritative. They do not replace shipping request parsing or callbacks.
async function consumeCurrent(
	id: number | null,
	release: (() => void) | null,
	method: "GET" | "PUT"
) {
	if (id === null || release === null) {
		throw new Error("Actual held current transport missing");
	}
	await act(async () => release());
	await until(() =>
		transports.some((operation) => operation.id === id && operation.decoded)
	);
	const operation = transports.find((entry) => entry.id === id);
	// biome-ignore lint/suspicious/noMisplacedAssertion: Every caller is a real HTTP test; retain exact held response-method identity.
	expect(operation?.method).toBe(method);
	// biome-ignore lint/suspicious/noMisplacedAssertion: Every caller is a real HTTP test; retain exact held response admission token.
	expect(operation?.token).toBe(`Bearer ${node("B").token}`);
	// biome-ignore lint/suspicious/noMisplacedAssertion: Every caller is a real HTTP test; retain exact held response delegated identity.
	expect(operation?.jwt).toBe(node("B").userJwt);
	await act(async () => {
		await new Promise<void>((resolve) => queueMicrotask(resolve));
	});
}
async function consumedCurrentWrite() {
	const release = releaseCurrentWrite;
	releaseCurrentWrite = null;
	await consumeCurrent(currentWriteId, release, "PUT");
}
async function consumedCurrentRead() {
	const release = releaseCurrentRead;
	releaseCurrentRead = null;
	await consumeCurrent(currentReadId, release, "GET");
}
const preferenceReads = () =>
	calls.filter(
		(call) =>
			call.method === "GET" &&
			call.path === "/api/preferences/cloud-sync-enabled"
	);

test("current refusal after an accepted retired write rereads the physical node instead of restoring a stale Boolean", async () => {
	mode = "token";
	selected("A");
	await mount();
	await ready(false);
	holdNextWrite = true;
	await toggle();
	await until(() => releaseHeld !== null);
	await rotate("B");
	await ready(false);
	holdCurrentWrite = true;
	refuseCurrentWrite = true;
	await toggle();
	// A queue may dispatch B only after A settles; both policies retain the same exact request oracle.
	await consumedOldWrite();
	await until(() => releaseCurrentWrite !== null);
	const readsBeforeDenial = preferenceReads().length;
	await consumedCurrentWrite();
	await until(
		() =>
			document.body.textContent?.includes("Couldn't save your sync choice") ===
			true
	);
	await until(() => preferenceReads().length > readsBeforeDenial);
	await ready(true);
	expect(saved("A")).toBe("true");
	expect(saved("B")).toBe("true");
	expect(
		writes().map((call) => ({
			slot: call.slot,
			body: call.body,
			settled: call.settled,
		}))
	).toEqual([
		{ slot: "A", body: { value: "true" }, settled: true },
		{ slot: "B", body: { value: "true" }, settled: true },
	]);
	expect(preferenceReads().at(-1)).toMatchObject({
		slot: "B",
		token: `Bearer ${node("B").token}`,
		jwt: node("B").userJwt,
		settled: true,
	});
	expect(await readPersistedSync(node("B"))).toBe(true);
	await act(async () => root.unmount());
	root = createRoot(container);
	await mount();
	await ready(true);
});

test("a delayed reconciliation read cannot overwrite a newer accepted current-node sync choice", async () => {
	mode = "token";
	selected("A");
	await mount();
	await ready(false);
	holdNextWrite = true;
	await toggle();
	await until(() => releaseHeld !== null);
	await act(async () => {
		expect(await setCloudSyncEnabled(node("B"), true)).toBe(true);
	});
	await rotate("B");
	await ready(true);
	holdCurrentWrite = true;
	await toggle();
	holdCurrentRead = true;
	await consumedOldWrite();
	await until(
		() => releaseCurrentWrite !== null && releaseCurrentRead !== null
	);
	await consumedCurrentWrite();
	expect(saved("B")).toBe("false");
	expect(checked()).toBe(false);
	await consumedCurrentRead();
	expect(checked()).toBe(false);
	expect(await readPersistedSync(node("B"))).toBe(false);
	expect(
		writes().map((call) => ({
			slot: call.slot,
			body: call.body,
			settled: call.settled,
		}))
	).toEqual([
		{ slot: "A", body: { value: "true" }, settled: true },
		{ slot: "B", body: { value: "true" }, settled: true },
		{ slot: "B", body: { value: "false" }, settled: true },
	]);
	await act(async () => root.unmount());
	root = createRoot(container);
	await mount();
	await ready(false);
});

test("a repeated physical click during the current sync save issues one PUT and retains the accepted value after reload", async () => {
	await mount();
	await ready(false);
	holdNextWrite = true;
	await toggle();
	await until(() => releaseHeld !== null);
	const disabledWhilePending =
		control().getAttribute("aria-disabled") === "true";
	expect(saved("A")).toBe("false");
	// Dispatch the genuine DOM click: BaseUI must refuse it while the accepted
	// current operation is pending, rather than accepting an opposite second PUT.
	await toggle();
	expect(await readPersistedSync(node("A"))).toBe(false);
	await consumedOldWrite();
	await until(() =>
		transports
			.filter((operation) => operation.method === "PUT")
			.every((operation) => operation.decoded)
	);
	expect(
		writes().map((call) => ({
			slot: call.slot,
			body: call.body,
			settled: call.settled,
		}))
	).toEqual([{ slot: "A", body: { value: "true" }, settled: true }]);
	expect(disabledWhilePending).toBe(true);
	await ready(true);
	expect(await readPersistedSync(node("A"))).toBe(true);
	await act(async () => root.unmount());
	root = createRoot(container);
	await mount();
	await ready(true);
});

test("an accepted save from an unmounted view refreshes the remounted same physical node through current credentials", async () => {
	mode = "token";
	selected("A");
	await mount();
	await ready(false);
	holdNextWrite = true;
	await toggle();
	await until(() => releaseHeld !== null);
	await act(async () => root.unmount());
	await rotate("B");
	root = createRoot(container);
	await mount();
	expect(container.textContent?.includes("Cross-device sync")).toBe(true);
	// Flush only real reads already issued by this mount. A pending-resource
	// barrier may defer all reads until ACK, so no pre-ACK usable switch is required.
	const issuedReads = transports
		.filter(
			(operation) =>
				operation.method === "GET" &&
				operation.token === `Bearer ${node("B").token}`
		)
		.map((operation) => operation.id);
	await until(() =>
		issuedReads.every((id) =>
			transports.some((operation) => operation.id === id && operation.decoded)
		)
	);
	await act(async () => {
		await new Promise<void>((resolve) => queueMicrotask(resolve));
	});
	const readsBeforeAck = preferenceReads().length;
	await consumedOldWrite();
	await until(() => preferenceReads().length > readsBeforeAck);
	expect(preferenceReads().at(-1)).toMatchObject({
		slot: "B",
		token: `Bearer ${node("B").token}`,
		jwt: node("B").userJwt,
		settled: true,
	});
	await ready(true);
	expect(saved("A")).toBe("true");
	expect(saved("B")).toBe("true");
	expect(await readPersistedSync(node("B"))).toBe(true);
	expect(
		writes().map((call) => ({
			slot: call.slot,
			body: call.body,
			settled: call.settled,
		}))
	).toEqual([{ slot: "A", body: { value: "true" }, settled: true }]);
	await act(async () => root.unmount());
	root = createRoot(container);
	await mount();
	await ready(true);
});
