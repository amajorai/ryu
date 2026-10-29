import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import { TauriUnavailableError } from "@/src/lib/tauri-ready.ts";

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
const LOCAL_NODE_TOKEN = "connections-coverage-local-node";

interface NativeNode {
	name: string;
	token: string | null;
	url: string;
}
interface Presence {
	client_id: string;
	client_label: string | null;
	first_seen: number;
	last_seen: number;
	surface: string | null;
	user_id: string | null;
	user_name: string | null;
}

let nativeNodes: NativeNode[] = [];
let nativeDefault = "local";
let armedIpcFailure: string | null = null;
const ipc: Array<{ args: unknown; command: string }> = [];
let presence: Presence[] = [];
let presenceStatus = 200;
const presenceRequests: Array<{
	authorization: string | null;
	client: string | null;
}> = [];
const nodeCalls: string[] = [];
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
				if (presenceStatus !== 200) {
					return NativeResponse.json(
						{ error: "presence unavailable" },
						{ status: presenceStatus }
					);
				}
				return NativeResponse.json({
					client_count: presence.length,
					data: presence,
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

const { LOCAL_FALLBACK, useNodeStore } = await import(
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
		if (armedIpcFailure === command) {
			armedIpcFailure = null;
			return Promise.reject(new Error(`Native refused ${command}`));
		}
		switch (command) {
			case "list_nodes":
				return Promise.resolve(
					structuredClone({ default: nativeDefault, nodes: nativeNodes })
				);
			case "local_node_token":
				return Promise.resolve({ source: "file", token: LOCAL_NODE_TOKEN });
			case "get_lan_ip":
				return Promise.resolve("192.168.10.24");
			case "add_node": {
				const name = textArg(args, "name");
				const nodeUrl = textArg(args, "url");
				const token = textArg(args, "token");
				nativeNodes = [
					...nativeNodes,
					{
						name: String(name),
						token: token === null ? null : String(token),
						url: String(nodeUrl),
					},
				];
				return Promise.resolve(null);
			}
			case "remove_node":
				nativeNodes = nativeNodes.filter(
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
const { currentClientId } = await import("@/src/lib/api/client.ts");
const { SSH_CONNECTIONS_STORAGE_KEY } = await import(
	"@/src/lib/ssh-connections.ts"
);
const { syncPlanCapState } = await import("@/src/lib/gating/planCapBridge.ts");
const { ConnectionsTab } = await import("./ConnectionsTab.tsx");
const {
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
let container: HTMLDivElement;
let queryClient = new QueryClient();

function text(): string {
	return document.body.textContent ?? "";
}

async function mount() {
	queryClient = new QueryClient();
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<QueryClientProvider client={queryClient}>
				<ConnectionsTab />
				<Toaster position="bottom-right" />
			</QueryClientProvider>
		)
	);
	await settle(
		() => container.querySelector('[data-testid="connections-hub"]') !== null,
		"connections hub",
		text
	);
}

async function unmount() {
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
async function bootNodeStore() {
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
		...container.querySelectorAll<HTMLElement>('[role="tab"]'),
	].find((candidate) => candidate.textContent?.trim() === name);
	if (!found) {
		throw new Error(`Missing tab ${name}`);
	}
	return found;
}

async function openTab(name: string, heading: string) {
	await click(tab(name));
	await settle(
		() =>
			[...container.querySelectorAll("h3")].some(
				(candidate) => candidate.textContent?.trim() === heading
			),
		`${name} tab`,
		text
	);
}

function remoteDialog(): HTMLElement {
	const dialog = dialogTitled("Add remote node");
	if (!dialog) {
		throw new Error("Missing Add remote node dialog");
	}
	return dialog;
}

async function openRemoteDialog() {
	await click(button("Add remote", container));
	await settle(
		() => dialogTitled("Add remote node") !== null,
		"remote dialog",
		text
	);
}

function remoteFields() {
	const dialog = remoteDialog();
	return {
		name: byPlaceholder("Build server", dialog),
		submit: button("Add remote", dialog),
		token: byPlaceholder("Paste a node token when required", dialog),
		url: byPlaceholder("https://server.example.com:7980", dialog),
	};
}

function sshDialog(): HTMLElement | null {
	return (
		dialogTitled("Add SSH connection") ?? dialogTitled("Edit SSH connection")
	);
}

async function openSshAdd() {
	await click(button("Add manually", container));
	await settle(
		() => dialogTitled("Add SSH connection") !== null,
		"SSH dialog",
		text
	);
}

function sshFields() {
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

function sshAlert(): string {
	return sshDialog()?.querySelector('[role="alert"]')?.textContent ?? "";
}

function storedProfiles(): Record<string, unknown>[] {
	const raw = localStorage.getItem(SSH_CONNECTIONS_STORAGE_KEY);
	return raw ? (JSON.parse(raw) as Record<string, unknown>[]) : [];
}

async function saveSsh() {
	await click(sshFields().save);
}

function settingsRowsWith(label: string): HTMLElement[] {
	return [
		...container.querySelectorAll<HTMLElement>('[data-slot="item"]'),
	].filter((row) => row.textContent?.includes(label));
}

function ipcCalls(command: string): unknown[] {
	return ipc
		.filter((call) => call.command === command)
		.map((call) => call.args);
}

beforeEach(async () => {
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must reach the loopback control plane, not a developer backend.
	expect(BACKEND_URL).toBe(controlPlane.url.origin);
	nativeNodes = [{ name: "local", token: null, url: LOCAL_FALLBACK.url }];
	nativeDefault = "local";
	armedIpcFailure = null;
	ipc.length = 0;
	presence = [];
	presenceStatus = 200;
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
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(async () => {
	await unmount();
	await act(async () => sileo.clear());
	container.remove();
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

test("remote node fields gate Add, send a trimmed native payload, survive a refusal for retry, and persist through a store reload", async () => {
	await mount();
	await openTab("Control other devices", "Remote nodes");
	expect(text()).toContain("No remote nodes yet");
	await openRemoteDialog();

	let fields = remoteFields();
	expect(fields.name.value).toBe("");
	expect(fields.url.value).toBe("");
	expect(fields.token.value).toBe("");
	expect(fields.token.type).toBe("password");
	expect(fields.submit.disabled).toBe(true);
	await typeInto(fields.name, "  Build node  ");
	expect(remoteFields().submit.disabled).toBe(true);
	await typeInto(fields.url, "   ");
	expect(remoteFields().submit.disabled).toBe(true);
	await typeInto(fields.url, "  https://build.example.test:7980  ");
	await typeInto(fields.token, "  build-node-secret  ");
	expect(remoteFields().submit.disabled).toBe(false);

	armedIpcFailure = "add_node";
	await click(remoteFields().submit);
	await settle(
		() => remoteDialog().querySelector('[role="alert"]') !== null,
		"native refusal",
		text
	);
	expect(remoteDialog().querySelector('[role="alert"]')?.textContent).toBe(
		"Native refused add_node"
	);
	fields = remoteFields();
	expect(fields.name.value).toBe("  Build node  ");
	expect(fields.url.value).toBe("  https://build.example.test:7980  ");
	expect(fields.token.value).toBe("  build-node-secret  ");
	expect(nativeNodes.map((candidate) => candidate.name)).toEqual(["local"]);

	await click(remoteFields().submit);
	await settle(
		() => dialogTitled("Add remote node") === null,
		"dialog closed",
		text
	);
	await settle(
		() => settingsRow("Build node", container) !== null,
		"node row",
		text
	);
	expect(text()).toContain("Remote node added");
	expect(rowCaption("Build node", container)).toBe(
		"https://build.example.test:7980"
	);
	const payload = {
		name: "Build node",
		token: "build-node-secret",
		url: "https://build.example.test:7980",
	};
	expect(ipcCalls("add_node")).toEqual([payload, payload]);

	// Reopening starts from empty fields; a blank token is sent as null.
	await openRemoteDialog();
	fields = remoteFields();
	expect([fields.name.value, fields.url.value, fields.token.value]).toEqual([
		"",
		"",
		"",
	]);
	await typeInto(fields.name, "Lab node");
	await typeInto(fields.url, "http://lab.example.test:7980");
	await typeInto(fields.token, "   ");
	await click(remoteFields().submit);
	await settle(
		() => settingsRow("Lab node", container) !== null,
		"second node",
		text
	);
	expect(ipcCalls("add_node").at(-1)).toEqual({
		name: "Lab node",
		token: null,
		url: "http://lab.example.test:7980",
	});

	// Independent reload: drop the in-memory list and rebuild it from nodes.json.
	await unmount();
	await bootNodeStore();
	await mount();
	await openTab("Control other devices", "Remote nodes");
	expect(settingsRow("Build node", container)).not.toBeNull();
	expect(settingsRow("Lab node", container)).not.toBeNull();
	expect(nativeNodes).toEqual([
		{ name: "local", token: null, url: LOCAL_FALLBACK.url },
		payload,
		{ name: "Lab node", token: null, url: "http://lab.example.test:7980" },
	]);
});

test("a signed-in free plan refuses a second remote node before any native write and asks for an upgrade", async () => {
	nativeNodes = [
		{ name: "local", token: null, url: LOCAL_FALLBACK.url },
		{
			name: "First remote",
			token: null,
			url: "https://first.example.test:7980",
		},
	];
	await bootNodeStore();
	let upgradeRequests = 0;
	// Signed in with no purchased plan: the free tier's one-remote-node cap.
	syncPlanCapState(null, () => {
		upgradeRequests += 1;
	});
	await mount();
	await openTab("Control other devices", "Remote nodes");
	await openRemoteDialog();
	const fields = remoteFields();
	await typeInto(fields.name, "Second remote");
	await typeInto(fields.url, "https://second.example.test:7980");
	await click(remoteFields().submit);
	await settle(
		() => remoteDialog().querySelector('[role="alert"]') !== null,
		"plan refusal",
		text
	);
	expect(remoteDialog().querySelector('[role="alert"]')?.textContent).toBe(
		"Plan limit reached for maxRemoteNodes (1)."
	);
	expect(upgradeRequests).toBe(1);
	expect(ipcCalls("add_node")).toEqual([]);
	expect(nativeNodes.map((candidate) => candidate.name)).toEqual([
		"local",
		"First remote",
	]);
	expect(remoteFields().name.value).toBe("Second remote");
});

test("SSH fields validate host, port and identity file before anything is stored", async () => {
	await mount();
	await openTab("SSH", "SSH connections from this device");
	await openSshAdd();
	let fields = sshFields();
	expect(fields.port.value).toBe("22");
	expect(fields.username.value).toBe("");
	expect(fields.identity()).toBeNull();

	await saveSsh();
	expect(sshAlert()).toBe(
		"Enter a display name, valid host, and port from 1 to 65535"
	);
	await typeInto(fields.name, "Release builder");
	// A typed username isolates each check below to the field under test.
	await typeInto(fields.username, "builder");
	await typeInto(fields.host, "build host.example.test");
	await saveSsh();
	expect(sshAlert()).toBe(
		"Enter a display name, valid host, and port from 1 to 65535"
	);
	await typeInto(fields.host, "build.example.test");
	for (const port of ["0", "65536", "22a", "2.5", ""]) {
		await typeInto(fields.port, port);
		await saveSsh();
		expect(sshAlert()).toBe(
			"Enter a display name, valid host, and port from 1 to 65535"
		);
	}
	await typeInto(fields.port, "2222");
	await click(button("Identity file", fields.dialog));
	expect(
		button("Identity file", fields.dialog).getAttribute("aria-pressed")
	).toBe("true");
	expect(fields.identity()).not.toBeNull();
	await saveSsh();
	expect(sshAlert()).toBe("Choose an identity file path");
	expect(storedProfiles()).toEqual([]);
	expect(settingsRow("Release builder", container)).toBeNull();

	fields = sshFields();
	const identity = fields.identity();
	if (!identity) {
		throw new Error("Missing identity file input");
	}
	await typeInto(identity, "  ~/.ssh/id_ed25519  ");
	await saveSsh();
	await settle(() => sshDialog() === null, "SSH dialog closed", text);
	const [saved] = storedProfiles();
	expect(saved).toMatchObject({
		auth: "identity",
		host: "build.example.test",
		identityFile: "~/.ssh/id_ed25519",
		name: "Release builder",
		port: 2222,
		username: "builder",
	});
	expect(rowCaption("Release builder", container)).toBe(
		"builder@build.example.test:2222·~/.ssh/id_ed25519"
	);
	expect(text()).toContain("SSH connection saved");
	// Ryu stores only the path: no native command or request touches the key.
	expect(ipc.some((call) => JSON.stringify(call).includes("id_ed25519"))).toBe(
		false
	);
	expect(nodeCalls.some((route) => route.includes("ssh"))).toBe(false);
});

test("SSH username comes from user@host unless typed, edits keep the id and other profiles, and a remount reads them back", async () => {
	await mount();
	await openTab("SSH", "SSH connections from this device");

	await openSshAdd();
	let fields = sshFields();
	await typeInto(fields.name, "Deploy box");
	await typeInto(fields.host, "deploy@build.example.test");
	await saveSsh();
	await settle(() => sshDialog() === null, "first profile saved", text);

	await openSshAdd();
	fields = sshFields();
	await typeInto(fields.name, "Dev host");
	await typeInto(fields.host, "dev.example.test");
	await typeInto(fields.username, "runner");
	await typeInto(fields.port, "2200");
	await saveSsh();
	await settle(() => sshDialog() === null, "second profile saved", text);

	const [deploy, dev] = storedProfiles();
	expect(deploy).toMatchObject({
		auth: "none",
		host: "build.example.test",
		name: "Deploy box",
		port: 22,
		username: "deploy",
	});
	expect(deploy).not.toHaveProperty("identityFile");
	expect(dev).toMatchObject({
		auth: "none",
		host: "dev.example.test",
		name: "Dev host",
		port: 2200,
		username: "runner",
	});
	expect(rowCaption("Deploy box", container)).toBe(
		"deploy@build.example.test:22·Default SSH auth"
	);

	// Edit the first profile: the dialog is prefilled, and the save keeps its id.
	const deployRow = settingsRow("Deploy box", container);
	if (!deployRow) {
		throw new Error("Missing Deploy box row");
	}
	await click(button("Edit", deployRow));
	await settle(
		() => dialogTitled("Edit SSH connection") !== null,
		"edit dialog",
		text
	);
	fields = sshFields();
	expect(fields.name.value).toBe("Deploy box");
	expect(fields.host.value).toBe("build.example.test");
	expect(fields.username.value).toBe("deploy");
	expect(fields.port.value).toBe("22");
	await typeInto(fields.name, "Deploy host");
	await typeInto(fields.port, "2022");
	await saveSsh();
	await settle(() => sshDialog() === null, "edit saved", text);
	expect(text()).toContain("SSH connection updated");
	const [edited, conserved] = storedProfiles();
	expect(edited).toMatchObject({
		id: deploy?.id,
		name: "Deploy host",
		port: 2022,
		username: "deploy",
	});
	expect(conserved).toEqual(dev);

	// Remove only the edited profile; the other one survives a remount.
	await click(button("Remove Deploy host", container));
	await settle(
		() => settingsRow("Deploy host", container) === null,
		"profile removed",
		text
	);
	expect(storedProfiles()).toEqual([dev]);
	await unmount();
	await mount();
	await openTab("SSH", "SSH connections from this device");
	expect(rowCaption("Dev host", container)).toBe(
		"runner@dev.example.test:2200·Default SSH auth"
	);
	expect(settingsRow("Deploy host", container)).toBeNull();
});

test("a blank optional Username saves a plain-host profile, clearing a username keeps the profile, and both survive a remount", async () => {
	await mount();
	await openTab("SSH", "SSH connections from this device");

	await openSshAdd();
	let fields = sshFields();
	await typeInto(fields.name, "Plain host");
	await typeInto(fields.host, "  plain.example.test  ");
	expect(fields.username.value).toBe("");
	await saveSsh();
	await settle(
		() => sshDialog() === null,
		`plain-host profile saved (alert: ${sshAlert() || "none"})`,
		text
	);
	expect(text()).toContain("SSH connection saved");

	await openSshAdd();
	fields = sshFields();
	await typeInto(fields.name, "Ops host");
	await typeInto(fields.host, "ops.example.test");
	await typeInto(fields.username, "ops");
	await saveSsh();
	await settle(() => sshDialog() === null, "ops profile saved", text);

	const [plain, ops] = storedProfiles();
	expect(plain).toEqual({
		auth: "none",
		host: "plain.example.test",
		id: expect.any(String),
		name: "Plain host",
		port: 22,
		username: "",
	});
	expect(ops).toMatchObject({ host: "ops.example.test", username: "ops" });
	expect(rowCaption("Plain host", container)).toBe(
		"plain.example.test:22·Default SSH auth"
	);

	// Clearing the optional Username (whitespace only) keeps the same profile.
	const opsRow = settingsRow("Ops host", container);
	if (!opsRow) {
		throw new Error("Missing Ops host row");
	}
	await click(button("Edit", opsRow));
	await settle(
		() => dialogTitled("Edit SSH connection") !== null,
		"edit dialog",
		text
	);
	fields = sshFields();
	expect(fields.username.value).toBe("ops");
	await typeInto(fields.username, "   ");
	await saveSsh();
	await settle(
		() => sshDialog() === null,
		`cleared username saved (alert: ${sshAlert() || "none"})`,
		text
	);
	expect(text()).toContain("SSH connection updated");
	expect(storedProfiles()).toEqual([plain, { ...ops, username: "" }]);
	expect(rowCaption("Ops host", container)).toBe(
		"ops.example.test:22·Default SSH auth"
	);

	// A remount rebuilds both username-less profiles from storage, and an
	// unchanged edit of one of them saves under the same id.
	await unmount();
	await mount();
	await openTab("SSH", "SSH connections from this device");
	expect(rowCaption("Plain host", container)).toBe(
		"plain.example.test:22·Default SSH auth"
	);
	expect(rowCaption("Ops host", container)).toBe(
		"ops.example.test:22·Default SSH auth"
	);
	await click(
		button("Edit", settingsRow("Plain host", container) ?? container)
	);
	await settle(
		() => dialogTitled("Edit SSH connection") !== null,
		"edit dialog after remount",
		text
	);
	fields = sshFields();
	expect(fields.host.value).toBe("plain.example.test");
	expect(fields.username.value).toBe("");
	await saveSsh();
	await settle(
		() => sshDialog() === null,
		`unchanged edit saved (alert: ${sshAlert() || "none"})`,
		text
	);
	expect(storedProfiles()).toEqual([plain, { ...ops, username: "" }]);
});

test("switching an identity-file profile back to No auth drops the stored identity path", async () => {
	localStorage.setItem(
		SSH_CONNECTIONS_STORAGE_KEY,
		JSON.stringify([
			{
				auth: "identity",
				host: "keys.example.test",
				id: "ssh-keys-profile",
				identityFile: "~/.ssh/id_ed25519",
				name: "Key host",
				port: 22,
				username: "ops",
			},
		])
	);
	await mount();
	await openTab("SSH", "SSH connections from this device");
	const row = settingsRow("Key host", container);
	expect(rowCaption("Key host", container)).toBe(
		"ops@keys.example.test:22·~/.ssh/id_ed25519"
	);
	await click(button("Edit", row ?? container));
	await settle(
		() => dialogTitled("Edit SSH connection") !== null,
		"edit dialog",
		text
	);
	const fields = sshFields();
	expect(fields.identity()?.value).toBe("~/.ssh/id_ed25519");
	await click(button("No auth", fields.dialog));
	expect(fields.identity()).toBeNull();
	await saveSsh();
	await settle(() => sshDialog() === null, "edit saved", text);
	expect(storedProfiles()).toEqual([
		{
			auth: "none",
			host: "keys.example.test",
			id: "ssh-keys-profile",
			name: "Key host",
			port: 22,
			username: "ops",
		},
	]);
	expect(rowCaption("Key host", container)).toBe(
		"ops@keys.example.test:22·Default SSH auth"
	);
});

test("connected-device presence recovers through Retry and marks only this client as This device", async () => {
	presenceStatus = 503;
	await mount();
	await settle(
		() =>
			text().includes("Connected-device presence is unavailable on this node."),
		"presence error",
		text
	);
	expect(text()).not.toContain("No other devices have connected recently.");
	const now = Math.floor(Date.now() / 1000);
	presenceStatus = 200;
	presence = [
		{
			client_id: currentClientId(),
			client_label: "Desktop",
			first_seen: now - 60,
			last_seen: now,
			surface: "desktop",
			user_id: null,
			user_name: "Studio desktop",
		},
		{
			client_id: "peer-phone",
			client_label: "Pixel phone",
			first_seen: now - 40,
			last_seen: now - 5,
			surface: "mobile",
			user_id: null,
			user_name: null,
		},
	];
	await click(button("Retry connected device presence", container));
	await settle(
		() => !text().includes("Connected-device presence is unavailable"),
		"presence recovered",
		text
	);
	await settle(
		() =>
			maybeButton("Retry connected device presence", container) === null &&
			settingsRowsWith("Studio desktop").length === 1 &&
			settingsRowsWith("Pixel phone").length === 1,
		"presence rows",
		text
	);
	const rows = [
		...container.querySelectorAll<HTMLElement>('[data-slot="item"]'),
	];
	const self = rows.find((row) => row.textContent?.includes("Studio desktop"));
	const peer = rows.find((row) => row.textContent?.includes("Pixel phone"));
	expect(self?.textContent).toContain("This device");
	expect(peer?.textContent).not.toContain("This device");
	expect(presenceRequests).toHaveLength(2);
	for (const sent of presenceRequests) {
		expect(sent).toEqual({
			authorization: `Bearer ${LOCAL_NODE_TOKEN}`,
			client: currentClientId(),
		});
	}
	await flush();
});
