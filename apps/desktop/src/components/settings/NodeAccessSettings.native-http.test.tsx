import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

// Devices & access is the approval surface for remote devices: prove the real
// panel sends exactly the narrowed grant, denies and revokes the right device,
// and never shows a failed read as an empty device list.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const ownedOrigins = new Set<string>();
const rejectedEgress: string[] = [];
globalThis.fetch = Object.assign(
	async (...args: Parameters<typeof nativeFetch>) => {
		const input = args[0];
		const address =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		if (!ownedOrigins.has(new URL(address).origin)) {
			rejectedEgress.push(address);
			throw new Error("Node access proof refuses unowned network origin");
		}
		return await nativeFetch(...args);
	},
	{ preconnect: nativeFetch.preconnect }
);
const nativeCommands: string[] = [];
Reflect.set(window, "__TAURI_INTERNALS__", {
	invoke: (command: string) => {
		nativeCommands.push(command);
		if (command === "local_node_token") {
			return Promise.resolve({ source: "file", token: "owner-token" });
		}
		return Promise.reject(new Error(`Unexpected native command ${command}`));
	},
	transformCallback: () => 0,
});
const { createRoot } = await import("react-dom/client");
const { NodeAccessSettings } = await import("./NodeAccessSettings.tsx");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const originalNodeState = useNodeStore.getState();

interface PairingRequestFixture {
	client_name: string;
	created_at: number;
	requested_scopes?: string[];
	user_code: string;
}
interface Call {
	body: unknown;
	method: string;
	path: string;
	token: string | null;
}
let calls: Call[] = [];
let requests: PairingRequestFixture[] = [];
let clients: Record<string, unknown>[] = [];
let failReads = false;
let server: ReturnType<typeof Bun.serve>;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	calls = [];
	failReads = false;
	requests = [];
	clients = [];
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const text = await request.text();
			calls.push({
				body: text ? JSON.parse(text) : null,
				method: request.method,
				path: url.pathname + url.search,
				token: request.headers.get("authorization"),
			});
			if (request.method === "GET" && url.pathname === "/api/pair/requests") {
				return failReads
					? NativeResponse.json({ error: "down" }, { status: 503 })
					: NativeResponse.json({ requests });
			}
			if (request.method === "GET" && url.pathname === "/api/pair/clients") {
				return failReads
					? NativeResponse.json({ error: "down" }, { status: 503 })
					: NativeResponse.json({ clients });
			}
			if (
				request.method === "POST" &&
				["/api/pair/approve", "/api/pair/deny"].includes(url.pathname)
			) {
				const code = JSON.parse(text).user_code;
				requests = requests.filter((item) => item.user_code !== code);
				return NativeResponse.json({ ok: true });
			}
			if (
				request.method === "DELETE" &&
				url.pathname.startsWith("/api/pair/clients/")
			) {
				clients = [];
				return NativeResponse.json({ ok: true });
			}
			return NativeResponse.json({ error: "unknown" }, { status: 404 });
		},
	});
	ownedOrigins.add(server.url.origin);
	const node = {
		name: "local",
		token: "node-token",
		url: server.url.origin,
		userJwt: null,
	};
	useNodeStore.setState({
		autoSelect: false,
		autoSelectedNode: null,
		cloudNodes: [],
		defaultNode: "local",
		localNodes: [node],
		nodes: [node],
		tabOverrides: {},
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	server.stop(true);
	ownedOrigins.clear();
	useNodeStore.setState(originalNodeState, true);
	// biome-ignore lint/suspicious/noMisplacedAssertion: Unowned network access invalidates every case.
	expect(rejectedEgress).toEqual([]);
});
afterAll(() => {
	globalThis.fetch = nativeFetch;
	Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

async function until(check: () => boolean) {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= deadline) {
			throw new Error(
				`Node access did not settle: ${container.textContent} calls=${JSON.stringify(calls)}`
			);
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
	}
}
const text = () => container.textContent ?? "";
async function mount() {
	await act(async () => root.render(<NodeAccessSettings />));
	await until(() => !text().includes("Loading device access"));
}
function button(label: string): HTMLButtonElement {
	const found = container.querySelector<HTMLButtonElement>(
		`button[aria-label="${label}"]`
	);
	if (!found) {
		throw new Error(`No ${label} button in: ${text()}`);
	}
	return found;
}
function scopeLabel(scope: string): HTMLLabelElement {
	for (const label of container.querySelectorAll("label")) {
		if (label.textContent === scope) {
			return label;
		}
	}
	throw new Error(`No ${scope} checkbox in: ${text()}`);
}
const scopeChecked = (scope: string) =>
	scopeLabel(scope)
		.querySelector('[role="checkbox"]')
		?.getAttribute("aria-checked");
// Base UI's visible checkbox is a span; the user's click lands on its native input.
async function toggleScope(scope: string) {
	const input = scopeLabel(scope).querySelector<HTMLInputElement>(
		'input[type="checkbox"]'
	);
	if (!input) {
		throw new Error(`No ${scope} input`);
	}
	await click(input);
}
async function click(element: HTMLElement) {
	await act(async () => element.click());
}
const writes = () => calls.filter((call) => call.method !== "GET");
const reads = () => calls.filter((call) => call.method === "GET").length;

test("approve sends only the scopes the user left checked, with the node bearer", async () => {
	requests = [
		{
			client_name: "Phone",
			created_at: 1,
			requested_scopes: ["chat:read", "files:write", "vault:read"],
			user_code: "ABCD-1234",
		},
	];
	await mount();
	expect(nativeCommands).toContain("local_node_token");
	await toggleScope("vault:read");
	await until(() => scopeChecked("vault:read") === "false");
	await click(button("Approve Phone with requested access"));
	await until(() => writes().length === 1);
	expect(writes()).toEqual([
		{
			body: {
				granted_scopes: ["chat:read", "files:write"],
				user_code: "ABCD-1234",
			},
			method: "POST",
			path: "/api/pair/approve",
			token: "Bearer node-token",
		},
	]);
	await until(() => text().includes("Nothing waiting."));
});

test("a request without requested scopes is approved with no granted_scopes, and deny sends only the code", async () => {
	requests = [
		{ client_name: "Legacy", created_at: 1, user_code: "LEGA-0001" },
		{
			client_name: "Tablet",
			created_at: 2,
			requested_scopes: ["chat:read"],
			user_code: "TABL-0002",
		},
	];
	await mount();
	expect(text()).toContain("Default read-only access");
	await click(button("Approve Legacy with requested access"));
	await until(() => writes().length === 1);
	await until(() => !text().includes("Legacy"));
	await click(button("Deny Tablet"));
	await until(() => writes().length === 2);
	expect(
		writes().map(({ body, method, path }) => ({ body, method, path }))
	).toEqual([
		{
			body: { user_code: "LEGA-0001" },
			method: "POST",
			path: "/api/pair/approve",
		},
		{
			body: { user_code: "TABL-0002" },
			method: "POST",
			path: "/api/pair/deny",
		},
	]);
});

test("revoke deletes the paired client by id", async () => {
	clients = [
		{
			active: true,
			created_at: 1,
			id: "client-42",
			last_seen: 1,
			name: "Laptop",
		},
	];
	await mount();
	await click(button("Revoke Laptop"));
	await until(() => writes().length === 1);
	expect(writes()[0]).toMatchObject({
		method: "DELETE",
		path: "/api/pair/clients/client-42",
		token: "Bearer node-token",
	});
	await until(() => text().includes("No paired devices."));
});

test("a failed access read shows the load error, never an empty device list", async () => {
	failReads = true;
	await mount();
	expect(text()).toContain("Could not load device access");
	expect(text()).not.toContain("Nothing waiting.");
	expect(text()).not.toContain("No paired devices.");
	failReads = false;
	requests = [
		{
			client_name: "Watch",
			created_at: 1,
			requested_scopes: [],
			user_code: "WTCH-0003",
		},
	];
	const before = reads();
	const retry = [...container.querySelectorAll("button")].find(
		(item) => item.textContent === "Retry"
	);
	if (!retry) {
		throw new Error("No Retry button");
	}
	await click(retry);
	await until(() => reads() > before && text().includes("Watch"));
	expect(text()).not.toContain("Could not load device access");
	expect(text()).toContain("No paired devices.");
});

test("a later poll prunes the selection to scopes that are still requested", async () => {
	requests = [
		{
			client_name: "Phone",
			created_at: 1,
			requested_scopes: ["a:read", "b:write", "c:admin"],
			user_code: "PHON-0001",
		},
		{ client_name: "Other", created_at: 2, user_code: "OTHR-0002" },
	];
	await mount();
	await toggleScope("b:write");
	await until(() => scopeChecked("b:write") === "false");
	// The device re-requests without c:admin; the next poll (here, the reload
	// after denying another device) must drop it from the pending grant.
	requests = requests.map((item) =>
		item.user_code === "PHON-0001"
			? { ...item, requested_scopes: ["a:read", "b:write"] }
			: item
	);
	await click(button("Deny Other"));
	await until(() => !(text().includes("Other") || text().includes("c:admin")));
	await click(button("Approve Phone with requested access"));
	await until(() => writes().length === 2);
	expect(writes()[1]?.body).toEqual({
		granted_scopes: ["a:read"],
		user_code: "PHON-0001",
	});
});
