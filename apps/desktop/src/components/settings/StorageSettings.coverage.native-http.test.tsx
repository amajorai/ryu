import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Mounts the shipping Storage tab against an owned native HTTP peer that
// serves two node authorities, and an IPC bridge that implements only the real
// Tauri boundary the tab crosses (dialogs, the offline copy and restore
// commands, the progress event and the process restart). Every Core request is
// a genuine HTTP exchange through the shipping clients, so each case observes
// which node acknowledged which write.
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register();
}
Object.assign(globalThis, { Response: NativeResponse, fetch: nativeFetch });
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type Owner = "a" | "b";
interface Call {
	body: unknown;
	method: string;
	owner: Owner | null;
	path: string;
	status: number;
}
interface NodeState {
	current: string;
	defaultPath: string;
	exports: string[];
	isCustom: boolean;
	resets: number;
	switchedTo: string | null;
	validated: string[];
}
interface Ipc {
	args: unknown;
	command: string;
}
interface Deferred<T> {
	promise: Promise<T>;
	reject: (reason: Error) => void;
	resolve: (value: T) => void;
}

const GIB = 1024 ** 3;
const BACKUP_PASSPHRASE = "correct horse battery";
const states: Record<Owner, NodeState> = {
	a: emptyState(),
	b: emptyState(),
};
const calls: Call[] = [];
const unknown: string[] = [];
const runtimeErrors: string[] = [];
const holds = new Map<string, Array<() => void>>();
const held = new Set<string>();
const refuse = new Map<string, number>();
const ipc: Ipc[] = [];
const openQueue: Array<string | null> = [];
const saveQueue: Array<string | null | Deferred<string | null>> = [];
const nativeHolds = new Map<string, Deferred<null>>();
const eventCallbacks = new Map<number, (event: unknown) => void>();
const listeners = new Map<number, string>();
let nextCallback = 0;
let pending = 0;

function emptyState(): NodeState {
	return {
		current: "",
		defaultPath: "",
		exports: [],
		isCustom: true,
		resets: 0,
		switchedTo: null,
		validated: [],
	};
}
function seed() {
	states.a = {
		...emptyState(),
		current: "/srv/ryu-node-a",
		defaultPath: "/home/coverage-a/.ryu",
	};
	states.b = {
		...emptyState(),
		current: "/srv/ryu-node-b",
		defaultPath: "/home/coverage-b/.ryu",
	};
}
function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, reject, resolve };
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	idleTimeout: 0,
	async fetch(request) {
		pending += 1;
		try {
			const url = new URL(request.url);
			const prefix = url.pathname.split("/")[1];
			const owner: Owner | null =
				prefix === "a" || prefix === "b" ? prefix : null;
			const path = owner ? url.pathname.slice(owner.length + 1) : url.pathname;
			const raw = await request.text();
			const call: Call = {
				owner,
				method: request.method,
				path,
				body: raw === "" ? null : JSON.parse(raw),
				status: 0,
			};
			calls.push(call);
			const reply = (body: unknown, status = 200) => {
				call.status = status;
				return NativeResponse.json(body, { status });
			};
			if (
				!owner ||
				request.headers.get("authorization") !==
					`Bearer storage-${owner}-token` ||
				request.headers.get("x-ryu-user-jwt") !== `storage-${owner}-jwt` ||
				url.search !== ""
			) {
				unknown.push(`${request.method} ${url.pathname}: wrong authority`);
				return reply({ error: "Wrong node authority" }, 403);
			}
			const key = `${owner}:${request.method}:${path}`;
			if (held.has(key)) {
				held.delete(key);
				await new Promise<void>((resolve) => {
					holds.set(key, [...(holds.get(key) ?? []), resolve]);
				});
			}
			const refusal = refuse.get(key);
			if (refusal !== undefined) {
				refuse.delete(key);
				return reply({ error: `Owned ${owner} storage peer refused` }, refusal);
			}
			const state = states[owner];
			const body = call.body as {
				out?: unknown;
				passphrase?: unknown;
				path?: unknown;
			} | null;
			if (request.method === "GET" && path === "/api/data-path") {
				return reply({
					current: state.current,
					default: state.defaultPath,
					free_space_bytes: (owner === "a" ? 64 : 96) * GIB,
					is_custom: state.isCustom,
					size_bytes: (owner === "a" ? 3 : 5) * GIB,
				});
			}
			if (
				request.method === "GET" &&
				path === "/api/documents/parse/capability"
			) {
				return reply({
					available: true,
					builtin_extensions: [".txt"],
					extensions: [".txt"],
					max_input_bytes: 16 * 1024 * 1024,
					missing_dependencies: [],
					provider: null,
					provider_name: null,
				});
			}
			if (request.method === "GET" && path === "/api/spaces") {
				return reply({ spaces: [] });
			}
			if (request.method === "GET" && path === "/api/backups") {
				return reply({ destinations: [], operations: [], policies: [] });
			}
			if (
				request.method === "POST" &&
				path === "/api/data-path/validate" &&
				typeof body?.path === "string"
			) {
				state.validated.push(body.path);
				return reply({
					ok: true,
					source_size_bytes: (owner === "a" ? 3 : 5) * GIB,
					target_free_bytes: (owner === "a" ? 500 : 900) * GIB,
				});
			}
			if (request.method === "POST" && path === "/api/data-path/reset") {
				state.resets += 1;
				state.isCustom = false;
				state.current = state.defaultPath;
				return reply({ ok: true, restart_required: true });
			}
			if (
				request.method === "POST" &&
				path === "/api/data-path/export" &&
				typeof body?.out === "string" &&
				body?.passphrase === BACKUP_PASSPHRASE
			) {
				state.exports.push(body.out);
				return reply({ ok: true, bytes: 1.5 * GIB });
			}
			unknown.push(`${request.method} ${path}`);
			return reply({ error: "Undeclared storage contract" }, 404);
		} finally {
			pending -= 1;
		}
	},
});

const bridgeDescriptor = Object.getOwnPropertyDescriptor(
	window,
	"__TAURI_INTERNALS__"
);
const eventDescriptor = Object.getOwnPropertyDescriptor(
	window,
	"__TAURI_EVENT_PLUGIN_INTERNALS__"
);
Object.defineProperty(window, "__TAURI_INTERNALS__", {
	configurable: true,
	value: {
		transformCallback: (callback: (event: unknown) => void) => {
			nextCallback += 1;
			eventCallbacks.set(nextCallback, callback);
			return nextCallback;
		},
		invoke: async (command: string, args: unknown) => {
			ipc.push({ command, args: structuredClone(args ?? null) });
			if (command === "plugin:event|listen") {
				const { event, handler } = args as { event: string; handler: number };
				listeners.set(handler, event);
				return handler;
			}
			if (command === "plugin:event|unlisten") {
				listeners.delete((args as { eventId: number }).eventId);
				return null;
			}
			if (command === "plugin:dialog|open") {
				return openQueue.shift() ?? null;
			}
			if (command === "plugin:dialog|save") {
				const next = saveQueue.shift() ?? null;
				return typeof next === "object" && next !== null
					? await next.promise
					: next;
			}
			if (command === "plugin:process|restart") {
				return null;
			}
			if (
				command === "migrate_data_folder" ||
				command === "import_data_folder"
			) {
				// On success these never resolve: the app restarts. A case holds the
				// command, drives progress, then settles it with a refusal.
				const hold = deferred<null>();
				nativeHolds.set(command, hold);
				return await hold.promise;
			}
			throw new Error(`Undeclared native command ${command}`);
		},
	},
});
Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
	configurable: true,
	value: { unregisterListener: () => undefined },
});

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { sileo } = await import("sileo");
const { useNodeStore, LOCAL_FALLBACK } = await import(
	"@/src/store/useNodeStore.ts"
);
const { AppSurfaceProvider } = await import(
	"@/src/contexts/app-surface-context.tsx"
);
const { queryClient } = await import("@/src/lib/query-client.ts");
const { StorageSettings } = await import("./StorageSettings.tsx");

const previousNodes = useNodeStore.getState();
const base = server.url.toString().replace(/\/$/, "");
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;
let errorToast: ReturnType<typeof spyOn<typeof sileo, "error">>;
let successToast: ReturnType<typeof spyOn<typeof sileo, "success">>;
const onError = (event: ErrorEvent) => runtimeErrors.push(event.message);
const onRejection = (event: PromiseRejectionEvent) =>
	runtimeErrors.push(String(event.reason));

async function typeInto(id: string, value: string) {
	const input = document.getElementById(id);
	if (!(input instanceof HTMLInputElement)) {
		throw new Error(`Missing actual Storage input ${id}`);
	}
	await act(async () => {
		const valueSetter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set;
		valueSetter?.call(input, value);
		input.dispatchEvent(new InputEvent("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));
		await Promise.resolve();
	});
}
/** Click Export…, enter the backup passphrase twice, and continue to the save dialog. */
async function startExport() {
	await act(async () => button("Export…").click());
	await until(
		() => maybeButton("Choose location…") !== undefined,
		"Export did not ask for a passphrase"
	);
	await typeInto("storage-export-passphrase", BACKUP_PASSPHRASE);
	await typeInto("storage-export-passphrase-confirm", BACKUP_PASSPHRASE);
	await act(async () => button("Choose location…").click());
}

async function idle() {
	for (let i = 0; i < 10; i++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
	}
}
async function until(predicate: () => boolean, reason: string) {
	const deadline = Date.now() + 4000;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(reason);
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
	}
}
async function select(owner: Owner) {
	const node = {
		...LOCAL_FALLBACK,
		name: `storage-${owner}`,
		url: `${base}/${owner}`,
		token: `storage-${owner}-token`,
		userJwt: `storage-${owner}-jwt`,
	};
	await act(async () => {
		useNodeStore.setState({
			defaultNode: node.name,
			nodes: [node],
			localNodes: [node],
			cloudNodes: [],
			autoSelect: false,
			autoSelectedNode: null,
			tabOverrides: {},
		});
	});
}
async function mount() {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container, {
		onCaughtError: (error) => runtimeErrors.push(String(error)),
		onUncaughtError: (error) => runtimeErrors.push(String(error)),
		onRecoverableError: (error) => runtimeErrors.push(String(error)),
	});
	await act(async () =>
		root?.render(
			createElement(AppSurfaceProvider, {
				surface: "desktop",
				children: createElement(StorageSettings),
			})
		)
	);
}
async function unmount() {
	for (const key of [...holds.keys()]) {
		release(key);
	}
	await act(async () => root?.unmount());
	root = null;
	container?.remove();
	container = null;
}
function release(key: string) {
	for (const resume of holds.get(key) ?? []) {
		resume();
	}
	holds.delete(key);
}
function text() {
	return document.body.textContent ?? "";
}
function buttons(): HTMLButtonElement[] {
	return [...document.body.querySelectorAll("button")];
}
function maybeButton(name: string) {
	return buttons().find((item) => item.textContent?.trim() === name);
}
function button(name: string) {
	const found = maybeButton(name);
	if (!found) {
		throw new Error(`Missing actual Storage action ${name}`);
	}
	return found;
}
/**
 * One settings row as the user reads it: the card that carries its title and
 * controls, plus the caption the group renders beneath that card.
 */
function row(title: string): { card: HTMLElement; text: string } {
	const heading = [
		...document.body.querySelectorAll('[data-slot="item-title"]'),
	].find((element) => element.textContent?.trim() === title);
	const card = heading?.closest('[role="list"]');
	if (!(card instanceof HTMLElement)) {
		throw new Error(`Missing Storage row ${title}`);
	}
	const caption =
		card.nextElementSibling instanceof HTMLParagraphElement
			? card.nextElementSibling.textContent
			: "";
	return { card, text: `${card.textContent ?? ""} ${caption ?? ""}` };
}
function maybeRow(title: string) {
	try {
		return row(title);
	} catch {
		return null;
	}
}
function callsFor(owner: Owner, method: string, path: string) {
	return calls.filter(
		(call) =>
			call.owner === owner && call.method === method && call.path === path
	);
}
function writes(owner: Owner) {
	return calls
		.filter((call) => call.owner === owner && call.method !== "GET")
		.map((call) => `${call.method} ${call.path} ${call.status}`);
}
function ipcFor(command: string) {
	return ipc.filter((entry) => entry.command === command);
}
async function emitProgress(phase: string, copied: number, total: number) {
	const handlers = [...listeners.entries()]
		.filter(([, event]) => event === "data-folder-progress")
		.map(([handler]) => eventCallbacks.get(handler));
	if (handlers.length !== 1) {
		throw new Error(
			`Expected one progress subscription, found ${handlers.length}`
		);
	}
	await act(async () => {
		handlers[0]?.({
			event: "data-folder-progress",
			id: 1,
			payload: { phase, copied_bytes: copied, total_bytes: total },
		});
	});
}
async function settleNative(command: string, message: string) {
	const hold = nativeHolds.get(command);
	if (!hold) {
		throw new Error(`${command} was never invoked`);
	}
	nativeHolds.delete(command);
	await act(async () => {
		hold.reject(new Error(message));
		await hold.promise.catch(() => undefined);
	});
}
const nodeActions = ["Export…", "Restore…", "Choose folder…"];

beforeEach(async () => {
	seed();
	calls.length = 0;
	unknown.length = 0;
	runtimeErrors.length = 0;
	ipc.length = 0;
	openQueue.length = 0;
	saveQueue.length = 0;
	nativeHolds.clear();
	held.clear();
	refuse.clear();
	queryClient.clear();
	localStorage.setItem("storage-coverage-unrelated", "preserved");
	errorToast = spyOn(sileo, "error");
	successToast = spyOn(sileo, "success");
	window.addEventListener("error", onError);
	window.addEventListener("unhandledrejection", onRejection);
	await select("a");
});
afterEach(async () => {
	await unmount();
	for (const hold of nativeHolds.values()) {
		hold.reject(new Error("case closed"));
	}
	await idle();
	errorToast.mockRestore();
	successToast.mockRestore();
	window.removeEventListener("error", onError);
	window.removeEventListener("unhandledrejection", onRejection);
	// The auth vault keeps one app-lifetime `desktop-secret-changed` listener; only
	// listeners the tab itself registered must be gone.
	const tabListeners = [...listeners.values()].filter(
		(event) => event !== "desktop-secret-changed"
	);
	const violations = [
		pending === 0 ? null : `${pending} native exchanges still pending`,
		unknown.length === 0 ? null : `undeclared requests: ${unknown.join("; ")}`,
		runtimeErrors.length === 0
			? null
			: `runtime errors: ${runtimeErrors.join("; ")}`,
		tabListeners.length === 0
			? null
			: `${tabListeners.length} native event listeners outlived the tab`,
		localStorage.getItem("storage-coverage-unrelated") === "preserved"
			? null
			: "unrelated stored record changed",
	].filter((violation) => violation !== null);
	if (violations.length > 0) {
		throw new Error(`Storage case closure failed: ${violations.join(" | ")}`);
	}
});
afterAll(async () => {
	queryClient.clear();
	useNodeStore.setState(previousNodes);
	await server.stop(true);
	if (bridgeDescriptor) {
		Object.defineProperty(window, "__TAURI_INTERNALS__", bridgeDescriptor);
	} else {
		Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
	}
	if (eventDescriptor) {
		Object.defineProperty(
			window,
			"__TAURI_EVENT_PLUGIN_INTERNALS__",
			eventDescriptor
		);
	} else {
		Reflect.deleteProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__");
	}
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

test("Current location and Default location come from the selected node; Reset to default is acknowledged by that node before the app restarts, and a refusal keeps the custom folder", async () => {
	await mount();
	await until(
		() => text().includes("/srv/ryu-node-a"),
		"Node A data folder not rendered"
	);
	expect(row("Current location").text).toContain("/srv/ryu-node-a");
	expect(row("Size").text).toContain(
		"3.0 GB used · 64.0 GB free on this drive"
	);
	expect(row("Default location").text).toContain("/home/coverage-a/.ryu");
	refuse.set("a:POST:/api/data-path/reset", 503);
	await act(async () => button("Reset to default").click());
	await until(
		() => errorToast.mock.calls.length === 1,
		"Refused reset did not report an error"
	);
	expect(errorToast.mock.calls[0]?.[0]).toMatchObject({
		title: "Could not reset folder",
	});
	expect(String(errorToast.mock.calls[0]?.[0]?.description)).toContain("503");
	expect(ipcFor("plugin:process|restart")).toHaveLength(0);
	expect(states.a.resets).toBe(0);
	expect(button("Reset to default").disabled).toBe(false);
	await act(async () => button("Reset to default").click());
	await until(
		() => ipcFor("plugin:process|restart").length === 1,
		"Acknowledged reset did not restart the app"
	);
	expect(writes("a")).toEqual([
		"POST /api/data-path/reset 503",
		"POST /api/data-path/reset 200",
	]);
	expect(states.a.resets).toBe(1);
	expect(calls.filter((call) => call.owner === "b")).toEqual([]);
	// An independent remount reads what the node now reports: the default
	// folder in use and no custom location to reset.
	await unmount();
	await mount();
	await until(
		() => row("Current location").text.includes("/home/coverage-a/.ryu"),
		"Remount did not reread the reset location"
	);
	expect(maybeRow("Default location")?.text ?? null).toBeNull();
	expect(maybeButton("Reset to default")?.textContent).toBeUndefined();
	expect(successToast).not.toHaveBeenCalled();
});

test("Export backup asks for a destination, sends nothing on cancel, reports a refusal, and saves the zip on the selected node with every action locked while it runs", async () => {
	await mount();
	await until(
		() => text().includes("/srv/ryu-node-a"),
		"Node A data folder not rendered"
	);
	expect(row("Export backup").text).toContain(
		"Save a passphrase-encrypted zip of all your Ryu data."
	);
	// A short or mismatched passphrase never reaches the save dialog.
	await act(async () => button("Export…").click());
	await until(
		() => maybeButton("Choose location…") !== undefined,
		"Export did not ask for a passphrase"
	);
	expect(button("Choose location…").disabled).toBe(true);
	await typeInto("storage-export-passphrase", "short");
	expect(text()).toContain("Use at least 12 characters.");
	await typeInto("storage-export-passphrase", BACKUP_PASSPHRASE);
	await typeInto("storage-export-passphrase-confirm", "something else!");
	expect(text()).toContain("The passphrases do not match.");
	expect(button("Choose location…").disabled).toBe(true);
	await act(async () => button("Cancel").click());
	await until(
		() => maybeButton("Choose location…") === undefined,
		"Cancel did not close the passphrase dialog"
	);
	expect(ipcFor("plugin:dialog|save")).toEqual([]);
	saveQueue.push(null);
	await startExport();
	await until(
		() => ipcFor("plugin:dialog|save").length === 1,
		"Export did not ask for a destination"
	);
	await idle();
	expect(ipcFor("plugin:dialog|save")[0]?.args).toEqual({
		options: {
			defaultPath: "ryu-data-backup.zip",
			filters: [{ name: "Zip archive", extensions: ["zip"] }],
		},
	});
	expect(callsFor("a", "POST", "/api/data-path/export")).toEqual([]);

	saveQueue.push("/Volumes/Backups/ryu-a.zip");
	refuse.set("a:POST:/api/data-path/export", 507);
	await startExport();
	await until(
		() => errorToast.mock.calls.length === 1,
		"Refused export did not report an error"
	);
	expect(errorToast.mock.calls[0]?.[0]).toMatchObject({
		title: "Backup failed",
	});
	expect(String(errorToast.mock.calls[0]?.[0]?.description)).toContain("507");
	expect(states.a.exports).toEqual([]);
	expect(button("Export…").disabled).toBe(false);

	saveQueue.push("/Volumes/Backups/ryu-a.zip");
	held.add("a:POST:/api/data-path/export");
	await startExport();
	await until(
		() => holds.has("a:POST:/api/data-path/export"),
		"Export did not reach node A"
	);
	for (const name of nodeActions) {
		expect(button(name).disabled).toBe(true);
	}
	release("a:POST:/api/data-path/export");
	await until(
		() => successToast.mock.calls.length === 1,
		"Acknowledged export did not report success"
	);
	expect(successToast.mock.calls[0]?.[0]).toEqual({
		title: "Backup created",
		description: "1.5 GB written to /Volumes/Backups/ryu-a.zip",
	});
	expect(
		callsFor("a", "POST", "/api/data-path/export").map((call) => [
			call.body,
			call.status,
		])
	).toEqual([
		[{ out: "/Volumes/Backups/ryu-a.zip", passphrase: BACKUP_PASSPHRASE }, 507],
		[{ out: "/Volumes/Backups/ryu-a.zip", passphrase: BACKUP_PASSPHRASE }, 200],
	]);
	expect(states.a.exports).toEqual(["/Volumes/Backups/ryu-a.zip"]);
	for (const name of nodeActions) {
		expect(button(name).disabled).toBe(false);
	}
	expect(calls.filter((call) => call.owner === "b")).toEqual([]);
	expect(ipcFor("plugin:process|restart")).toHaveLength(0);
});

test("Restore backup confirms the chosen archive and the key warning, restores nothing on cancel, and runs the native import on this device; a failed import reports and unlocks the tab", async () => {
	await mount();
	await until(
		() => text().includes("/srv/ryu-node-a"),
		"Node A data folder not rendered"
	);
	openQueue.push("/Volumes/Backups/ryu-old.zip");
	await act(async () => button("Restore…").click());
	await until(
		() => text().includes("Restore from this backup?"),
		"Restore did not ask for confirmation"
	);
	expect(ipcFor("plugin:dialog|open")[0]?.args).toEqual({
		options: {
			multiple: false,
			filters: [{ name: "Zip archive", extensions: ["zip"] }],
		},
	});
	const dialog = document.body.querySelector('[role="alertdialog"]');
	expect(dialog?.textContent).toContain("/Volumes/Backups/ryu-old.zip");
	expect(dialog?.textContent).toContain(
		"Your encryption key is stored in this machine's keychain"
	);
	await act(async () => button("Cancel").click());
	await until(
		() => !text().includes("Restore from this backup?"),
		"Cancel did not close the restore confirmation"
	);
	expect(ipcFor("import_data_folder")).toEqual([]);

	openQueue.push("/Volumes/Backups/ryu-old.zip");
	await act(async () => button("Restore…").click());
	await until(
		() => maybeButton("Restore & restart") !== undefined,
		"Restore confirmation did not reopen"
	);
	await typeInto("storage-restore-passphrase", BACKUP_PASSPHRASE);
	await act(async () => button("Restore & restart").click());
	await until(
		() => ipcFor("import_data_folder").length === 1,
		"Confirmed restore did not run the native import"
	);
	// The passphrase goes to the native command only; it is never sent to a node.
	expect(ipcFor("import_data_folder")[0]?.args).toEqual({
		archive: "/Volumes/Backups/ryu-old.zip",
		passphrase: BACKUP_PASSPHRASE,
	});
	expect(text()).toContain("Restoring…");
	await emitProgress("extract", 2 * GIB, 5 * GIB);
	expect(text()).toContain("Restoring… 40%");
	for (const name of ["Export…", "Restore…"]) {
		expect(button(name).disabled).toBe(true);
	}
	await settleNative("import_data_folder", "archive checksum mismatch");
	await until(
		() => errorToast.mock.calls.length === 1,
		"Failed restore did not report an error"
	);
	expect(errorToast.mock.calls[0]?.[0]).toMatchObject({
		title: "Restore failed",
	});
	expect(String(errorToast.mock.calls[0]?.[0]?.description)).toContain(
		"archive checksum mismatch"
	);
	expect(text()).not.toContain("Restoring…");
	for (const name of nodeActions) {
		expect(button(name).disabled).toBe(false);
	}
	// The restore is this device's offline import: no node was asked to write.
	expect(writes("a")).toEqual([]);
	expect(calls.filter((call) => call.owner === "b")).toEqual([]);
	expect(ipcFor("plugin:process|restart")).toHaveLength(0);
});

test("Copy data and restart with a remote node selected checks the folder on that node, then copies this device's data folder natively and never asks any node to switch", async () => {
	await select("b");
	await mount();
	await until(
		() => text().includes("/srv/ryu-node-b"),
		"Remote node B data folder not rendered"
	);
	openQueue.push("/Volumes/Fast/ryu-data");
	await act(async () => button("Choose folder…").click());
	await until(
		() => maybeButton("Copy data & restart") !== undefined,
		"Remote validation was not shown"
	);
	// The free-space figures shown are the remote node's, not this device's.
	expect(callsFor("b", "POST", "/api/data-path/validate")[0]?.body).toEqual({
		path: "/Volumes/Fast/ryu-data",
	});
	expect(text()).toContain("5.0 GB to copy · 900.0 GB free at target");
	await act(async () => button("Copy data & restart").click());
	await until(
		() => ipcFor("migrate_data_folder").length === 1,
		"Copy did not start the native migration"
	);
	expect(ipcFor("migrate_data_folder")[0]?.args).toEqual({
		to: "/Volumes/Fast/ryu-data",
		moveSource: false,
	});
	expect(text()).toContain("Copying… 0%");
	expect(text()).toContain("The app will restart automatically when finished.");
	await emitProgress("copy", 1.25 * GIB, 5 * GIB);
	expect(text()).toContain("Copying… 25%");
	expect(maybeButton("Copy data & restart")?.textContent).toBeUndefined();
	await settleNative(
		"migrate_data_folder",
		"Core is owned by turbo in dev; refusing to copy a live database"
	);
	await until(
		() => errorToast.mock.calls.length === 1,
		"Refused migration did not report an error"
	);
	expect(errorToast.mock.calls[0]?.[0]).toMatchObject({
		title: "Relocation failed",
	});
	expect(String(errorToast.mock.calls[0]?.[0]?.description)).toContain(
		"refusing to copy a live database"
	);
	expect(text()).not.toContain("Copying…");
	// The checked folder stays picked, so the copy can be retried as is.
	expect(button("Copy data & restart").disabled).toBe(false);
	await act(async () => button("Copy data & restart").click());
	await until(
		() => ipcFor("migrate_data_folder").length === 2,
		"Retry did not reach the native migration"
	);
	await settleNative("migrate_data_folder", "still refusing");
	await until(
		() => errorToast.mock.calls.length === 2,
		"Second refusal did not report"
	);
	expect(writes("b")).toEqual(["POST /api/data-path/validate 200"]);
	expect(states.b.switchedTo).toBeNull();
	expect(calls.filter((call) => call.owner === "a")).toEqual([]);
	expect(ipcFor("plugin:process|restart")).toHaveLength(0);
});

test("after a node switch, export and reset reach only the node selected now, a folder checked on the prior node must be checked again, and copy and restore stay on this device", async () => {
	await mount();
	await until(
		() => text().includes("/srv/ryu-node-a"),
		"Node A data folder not rendered"
	);
	saveQueue.push("/Volumes/Backups/a.zip");
	await startExport();
	await until(
		() => successToast.mock.calls.length === 1,
		"Node A export did not complete"
	);
	openQueue.push("/Volumes/Fast/ryu-data");
	await act(async () => button("Choose folder…").click());
	await until(
		() => maybeButton("Copy data & restart") !== undefined,
		"Node A did not check the folder"
	);
	expect(text()).toContain("500.0 GB free at target");

	await select("b");
	await until(
		() => row("Current location").text.includes("/srv/ryu-node-b"),
		"Node B data folder not rendered"
	);
	expect(maybeButton("Copy data & restart")?.textContent).toBeUndefined();
	expect(text()).not.toContain("500.0 GB free at target");
	expect(row("Default location").text).toContain("/home/coverage-b/.ryu");
	saveQueue.push("/Volumes/Backups/b.zip");
	await startExport();
	await until(
		() => successToast.mock.calls.length === 2,
		"Node B export did not complete"
	);
	expect(states.b.exports).toEqual(["/Volumes/Backups/b.zip"]);
	expect(states.a.exports).toEqual(["/Volumes/Backups/a.zip"]);

	openQueue.push("/Volumes/Fast/ryu-data");
	await act(async () => button("Choose folder…").click());
	await until(
		() => text().includes("900.0 GB free at target"),
		"Node B did not check the folder"
	);
	await act(async () => button("Copy data & restart").click());
	await until(
		() => ipcFor("migrate_data_folder").length === 1,
		"Copy did not start the native migration"
	);
	expect(ipcFor("migrate_data_folder")[0]?.args).toEqual({
		to: "/Volumes/Fast/ryu-data",
		moveSource: false,
	});
	await settleNative("migrate_data_folder", "copy refused for this case");
	await until(
		() => errorToast.mock.calls.length === 1,
		"Refused migration did not report"
	);

	openQueue.push("/Volumes/Backups/ryu-old.zip");
	await act(async () => button("Restore…").click());
	await until(
		() => maybeButton("Restore & restart") !== undefined,
		"Restore confirmation did not open"
	);
	// The restore replaces this device's data, so selecting another node
	// while it is being confirmed neither cancels it nor routes it to a node.
	await select("a");
	await until(
		() => row("Current location").text.includes("/srv/ryu-node-a"),
		"Node A data folder not reread"
	);
	await act(async () => button("Restore & restart").click());
	await until(
		() => ipcFor("import_data_folder").length === 1,
		"Confirmed restore did not run the native import"
	);
	expect(ipcFor("import_data_folder")[0]?.args).toEqual({
		archive: "/Volumes/Backups/ryu-old.zip",
	});
	await settleNative("import_data_folder", "restore refused for this case");
	await until(
		() => errorToast.mock.calls.length === 2,
		"Refused restore did not report"
	);
	await select("b");
	await until(
		() => row("Current location").text.includes("/srv/ryu-node-b"),
		"Node B data folder not reread"
	);
	await act(async () => button("Reset to default").click());
	await until(
		() => ipcFor("plugin:process|restart").length === 1,
		"Node B reset did not restart the app"
	);
	expect(states.b.resets).toBe(1);
	expect(states.a.resets).toBe(0);

	expect(writes("a")).toEqual([
		"POST /api/data-path/export 200",
		"POST /api/data-path/validate 200",
	]);
	expect(writes("b")).toEqual([
		"POST /api/data-path/export 200",
		"POST /api/data-path/validate 200",
		"POST /api/data-path/reset 200",
	]);
	expect(states.a.switchedTo).toBeNull();
	expect(states.b.switchedTo).toBeNull();
});

test("an export destination chosen after a node switch is not written by the node that was selected when Export was clicked", async () => {
	await mount();
	await until(
		() => text().includes("/srv/ryu-node-a"),
		"Node A data folder not rendered"
	);
	const destination = deferred<string | null>();
	saveQueue.push(destination);
	await startExport();
	await until(
		() => ipcFor("plugin:dialog|save").length === 1,
		"Export did not ask for a destination"
	);
	await select("b");
	await until(
		() => row("Current location").text.includes("/srv/ryu-node-b"),
		"Node B data folder not rendered"
	);
	await act(async () => {
		destination.resolve("/Volumes/Backups/chosen-late.zip");
		await destination.promise;
	});
	await idle();
	// Node A is no longer the tab's authority, so it never writes the zip, and
	// the success that would describe A's data is not shown while B is selected.
	expect(callsFor("a", "POST", "/api/data-path/export")).toEqual([]);
	expect(states.a.exports).toEqual([]);
	expect(successToast).not.toHaveBeenCalled();
	expect(button("Export…").disabled).toBe(false);
	// Exporting again uses the node selected now.
	saveQueue.push("/Volumes/Backups/b.zip");
	await startExport();
	await until(
		() => successToast.mock.calls.length === 1,
		"Node B export did not complete"
	);
	expect(states.b.exports).toEqual(["/Volumes/Backups/b.zip"]);
	expect(writes("a")).toEqual([]);
});
