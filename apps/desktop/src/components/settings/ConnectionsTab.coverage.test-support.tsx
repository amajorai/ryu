import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import { TauriUnavailableError } from "@/src/lib/tauri-ready.ts";

// Shared harness for the ConnectionsTab coverage suites
// (`ConnectionsTab.coverage.native-http.test.tsx` and
// `ConnectionsTab.ssh.coverage.native-http.test.tsx`). Importing it installs the
// DOM, the fetch boundary and the Tauri IPC bridge before the shipping modules
// load; each suite calls `registerConnectionsCoverageHooks()` once.
//
// Control-level coverage for the shipping ConnectionsTab (Gateway →
// Connections). Core and the control plane are real loopback HTTP servers:
// the local node answers presence, pairing, cloud-sync and auth-status reads,
// and the control plane answers the linked-account list. The local node keeps
// its configured address, so the fetch boundary forwards that one origin to the
// node fixture. Remote nodes go through the in-process Tauri IPC bridge, which
// models the profile's nodes.json; SSH profiles persist in localStorage.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
// Bun's native fetch only accepts the runtime's own abort signals, not
// happy-dom's, and the shipping clients hand it the caller's signal.
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
setDefaultTimeout(30_000);

const SESSION_TOKEN = "connections-coverage-session";
export const LOCAL_NODE_TOKEN = "connections-coverage-local-node";

interface NativeNode {
	name: string;
	token: string | null;
	url: string;
}
export interface Presence {
	client_id: string;
	client_label: string | null;
	first_seen: number;
	last_seen: number;
	surface: string | null;
	user_id: string | null;
	user_name: string | null;
}

/** Fixture state a case may rewrite: nodes.json, presence, IPC failures. */
export const harness = {
	armedIpcFailure: null as string | null,
	container: document.createElement("div"),
	nativeDefault: "local",
	nativeNodes: [] as NativeNode[],
	presence: [] as Presence[],
	presenceStatus: 200,
};
export const ipc: Array<{ args: unknown; command: string }> = [];
export const presenceRequests: Array<{
	authorization: string | null;
	client: string | null;
}> = [];
export const nodeCalls: string[] = [];
const unexpected: string[] = [];
const rejectedEgress: string[] = [];

const node = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const url = new URL(request.url);
		const route = `${request.method} ${url.pathname}`;
		nodeCalls.push(route);
		if (request.headers.get("authorization") !== `Bearer ${LOCAL_NODE_TOKEN}`) {
			unexpected.push(`${route} without the local node token`);
			return NativeResponse.json({ error: "unauthorized" }, { status: 401 });
		}
		switch (route) {
			case "GET /api/connections":
				presenceRequests.push({
					authorization: request.headers.get("authorization"),
					client: request.headers.get("x-ryu-client-id"),
				});
				if (harness.presenceStatus !== 200) {
					return NativeResponse.json(
						{ error: "presence unavailable" },
						{ status: harness.presenceStatus }
					);
				}
				return NativeResponse.json({
					client_count: harness.presence.length,
					data: harness.presence,
					ttl_secs: 90,
					user_count: 1,
				});
			case "GET /api/pair/requests":
				return NativeResponse.json({ requests: [] });
			case "GET /api/pair/clients":
				return NativeResponse.json({ clients: [] });
			case "GET /api/preferences/cloud-sync-enabled":
				return NativeResponse.json({
					key: "cloud-sync-enabled",
					value: "false",
				});
			case "GET /api/auth/status":
				return NativeResponse.json({ authenticated: false });
			default:
				unexpected.push(`node ${route}`);
				return NativeResponse.json({ error: "undeclared" }, { status: 404 });
		}
	},
});

const controlPlane = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const url = new URL(request.url);
		const route = `${request.method} ${url.pathname}`;
		if (request.headers.get("authorization") !== `Bearer ${SESSION_TOKEN}`) {
			unexpected.push(`control plane ${route} without the session`);
			return NativeResponse.json({ error: "unauthorized" }, { status: 401 });
		}
		if (route === "GET /api/auth/list-accounts") {
			return NativeResponse.json([]);
		}
		if (route === "GET /api/auth/token") {
			// The signed-in member's short-lived JWT that Core requests carry.
			return NativeResponse.json({ token: "connections-coverage-user-jwt" });
		}
		unexpected.push(`control plane ${route}`);
		return NativeResponse.json({ error: "undeclared" }, { status: 404 });
	},
});

// Production modules read the control-plane origin at import time.
const previousBackend = process.env.VITE_APP_BACKEND_URL;
process.env.VITE_APP_BACKEND_URL = controlPlane.url.origin;

// Set once the node store is imported (below); the boundary is installed first
// so every module that captures `fetch` at import time captures this one.
let localOrigin = "";

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") {
		return input;
	}
	return input instanceof URL ? input.href : input.url;
}
globalThis.fetch = Object.assign(
	(input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(requestUrl(input));
		if (url.origin === localOrigin) {
			// The local Core listens at its configured address; forward that one
			// origin to the node fixture without touching method, headers or body.
			return nativeFetch(
				`${node.url.origin}${url.pathname}${url.search}`,
				init ?? (input instanceof Request ? input : undefined)
			);
		}
		if (url.origin !== controlPlane.url.origin) {
			rejectedEgress.push(url.href);
			return Promise.reject(new Error(`Unowned origin ${url.href}`));
		}
		return nativeFetch(input, init);
	},
	{ preconnect: nativeFetch.preconnect }
);
window.fetch = globalThis.fetch;

export const { LOCAL_FALLBACK, useNodeStore } = await import(
	"@/src/store/useNodeStore.ts"
);
localOrigin = new URL(LOCAL_FALLBACK.url).origin;

function textArg(args: unknown, key: string): unknown {
	return args && typeof args === "object"
		? (args as Record<string, unknown>)[key]
		: undefined;
}

Reflect.set(window, "__TAURI_INTERNALS__", {
	invoke: (command: string, args: unknown) => {
		// This harness has no sealed auth-vault slot: the vault seeded in
		// localStorage below is read as a host without one would.
		if (command.startsWith("desktop_secret_")) {
			return Promise.reject(new TauriUnavailableError(command));
		}
		ipc.push({ args, command });
		if (harness.armedIpcFailure === command) {
			harness.armedIpcFailure = null;
			return Promise.reject(new Error(`Native refused ${command}`));
		}
		switch (command) {
			case "list_nodes":
				return Promise.resolve(
					structuredClone({
						default: harness.nativeDefault,
						nodes: harness.nativeNodes,
					})
				);
			case "local_node_token":
				return Promise.resolve({ source: "file", token: LOCAL_NODE_TOKEN });
			case "get_lan_ip":
				return Promise.resolve("192.168.10.24");
			case "add_node": {
				const name = textArg(args, "name");
				const nodeUrl = textArg(args, "url");
				const token = textArg(args, "token");
				harness.nativeNodes = [
					...harness.nativeNodes,
					{
						name: String(name),
						token: token === null ? null : String(token),
						url: String(nodeUrl),
					},
				];
				return Promise.resolve(null);
			}
			case "remove_node":
				harness.nativeNodes = harness.nativeNodes.filter(
					(candidate) => candidate.name !== textArg(args, "name")
				);
				return Promise.resolve(null);
			default:
				return Promise.resolve(null);
		}
	},
	transformCallback: () => 0,
});

const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
const { BACKEND_URL, TOKEN_KEY } = await import("@/lib/auth-client.ts");
export const { currentClientId } = await import("@/src/lib/api/client.ts");
export const { SSH_CONNECTIONS_STORAGE_KEY } = await import(
	"@/src/lib/ssh-connections.ts"
);
export const { syncPlanCapState } = await import(
	"@/src/lib/gating/planCapBridge.ts"
);
const { ConnectionsTab } = await import("./ConnectionsTab.tsx");
export const {
	button,
	byPlaceholder,
	click,
	dialogTitled,
	flush,
	maybeButton,
	rowCaption,
	settle,
	settingsRow,
	typeInto,
} = await import("./connections-providers.test-support.ts");

let root: Root | null = null;
let queryClient = new QueryClient();

export function text(): string {
	return document.body.textContent ?? "";
}

export async function mount() {
	queryClient = new QueryClient();
	root = createRoot(harness.container);
	await act(async () =>
		root?.render(
			<QueryClientProvider client={queryClient}>
				<ConnectionsTab />
				<Toaster position="bottom-right" />
			</QueryClientProvider>
		)
	);
	await settle(
		() =>
			harness.container.querySelector('[data-testid="connections-hub"]') !==
			null,
		"connections hub",
		text
	);
}

export async function unmount() {
	const mounted = root;
	root = null;
	if (mounted) {
		await act(async () => mounted.unmount());
	}
	await act(async () => {
		await queryClient.cancelQueries();
		queryClient.clear();
	});
}

/** Reload the node list from nodes.json the way the app does at boot. */
export async function bootNodeStore() {
	useNodeStore.setState({
		cloudNodes: [],
		defaultNode: "local",
		localNodes: [],
		nodes: [],
	});
	await act(async () => {
		await useNodeStore.getState().refresh();
	});
}

function tab(name: string): HTMLElement {
	const found = [
		...harness.container.querySelectorAll<HTMLElement>('[role="tab"]'),
	].find((candidate) => candidate.textContent?.trim() === name);
	if (!found) {
		throw new Error(`Missing tab ${name}`);
	}
	return found;
}

export async function openTab(name: string, heading: string) {
	await click(tab(name));
	await settle(
		() =>
			[...harness.container.querySelectorAll("h3")].some(
				(candidate) => candidate.textContent?.trim() === heading
			),
		`${name} tab`,
		text
	);
}

export function remoteDialog(): HTMLElement {
	const dialog = dialogTitled("Add remote node");
	if (!dialog) {
		throw new Error("Missing Add remote node dialog");
	}
	return dialog;
}

export async function openRemoteDialog() {
	await click(button("Add remote", harness.container));
	await settle(
		() => dialogTitled("Add remote node") !== null,
		"remote dialog",
		text
	);
}

export function remoteFields() {
	const dialog = remoteDialog();
	return {
		name: byPlaceholder("build-server", dialog),
		submit: button("Add remote", dialog),
		token: byPlaceholder("Paste a node token when required", dialog),
		url: byPlaceholder("https://server.example.com:7980", dialog),
	};
}

export function sshDialog(): HTMLElement | null {
	return (
		dialogTitled("Add SSH connection") ?? dialogTitled("Edit SSH connection")
	);
}

export async function openSshAdd() {
	await click(button("Add manually", harness.container));
	await settle(
		() => dialogTitled("Add SSH connection") !== null,
		"SSH dialog",
		text
	);
}

export function sshFields() {
	const dialog = sshDialog();
	if (!dialog) {
		throw new Error("Missing SSH dialog");
	}
	return {
		dialog,
		host: byPlaceholder("host.com or user@host.com", dialog),
		identity: () =>
			dialog.querySelector<HTMLInputElement>(
				'[placeholder="~/.ssh/id_ed25519"]'
			),
		name: byPlaceholder("Build server", dialog),
		port: byPlaceholder("22", dialog),
		save: button("Save connection", dialog),
		username: byPlaceholder("Optional", dialog),
	};
}

export function sshAlert(): string {
	return sshDialog()?.querySelector('[role="alert"]')?.textContent ?? "";
}

export function storedProfiles(): Record<string, unknown>[] {
	const raw = localStorage.getItem(SSH_CONNECTIONS_STORAGE_KEY);
	return raw ? (JSON.parse(raw) as Record<string, unknown>[]) : [];
}

export async function saveSsh() {
	await click(sshFields().save);
}

export function settingsRowsWith(label: string): HTMLElement[] {
	return [
		...harness.container.querySelectorAll<HTMLElement>('[data-slot="item"]'),
	].filter((row) => row.textContent?.includes(label));
}

export function ipcCalls(command: string): unknown[] {
	return ipc
		.filter((call) => call.command === command)
		.map((call) => call.args);
}

/** The per-case reset and teardown both suites share; call once per file. */
export function registerConnectionsCoverageHooks() {
	beforeEach(async () => {
		// biome-ignore lint/suspicious/noMisplacedAssertion: every case must reach the loopback control plane, not a developer backend.
		expect(BACKEND_URL).toBe(controlPlane.url.origin);
		harness.nativeNodes = [
			{ name: "local", token: null, url: LOCAL_FALLBACK.url },
		];
		harness.nativeDefault = "local";
		harness.armedIpcFailure = null;
		ipc.length = 0;
		harness.presence = [];
		harness.presenceStatus = 200;
		presenceRequests.length = 0;
		nodeCalls.length = 0;
		unexpected.length = 0;
		rejectedEgress.length = 0;
		localStorage.clear();
		localStorage.setItem(TOKEN_KEY, SESSION_TOKEN);
		// A paid licence is uncapped for remote nodes; the plan case narrows it.
		syncPlanCapState("desktop-license", () => undefined);
		await bootNodeStore();
		await act(async () => sileo.clear());
		harness.container = document.createElement("div");
		document.body.append(harness.container);
	});

	afterEach(async () => {
		await unmount();
		await act(async () => sileo.clear());
		harness.container.remove();
		for (const leftover of document.querySelectorAll('[role="dialog"]')) {
			leftover.remove();
		}
		// biome-ignore lint/suspicious/noMisplacedAssertion: every case stays on declared, authenticated routes.
		expect(unexpected).toEqual([]);
		// biome-ignore lint/suspicious/noMisplacedAssertion: no request may leave the loopback fixtures.
		expect(rejectedEgress).toEqual([]);
	});

	afterAll(() => {
		node.stop(true);
		controlPlane.stop(true);
		globalThis.fetch = nativeFetch;
		if (previousBackend === undefined) {
			delete process.env.VITE_APP_BACKEND_URL;
		} else {
			process.env.VITE_APP_BACKEND_URL = previousBackend;
		}
	});
}
