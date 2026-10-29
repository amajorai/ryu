import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Mounts the shipping Storage tab (data folder, change-location flow, node
// backups and upload ceiling) against an owned native HTTP peer that serves two
// node authorities. The Tauri bridge below implements only the real IPC
// boundary the tab calls (dialog open, event listen/unlisten, process restart);
// every Core request is a genuine HTTP exchange through the shipping clients.
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
const ownsDom = !GlobalRegistrator.isRegistered;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
if (ownsDom) {
	GlobalRegistrator.register();
}
// Bun's native fetch only accepts the runtime's own abort signals, not
// happy-dom's, and the shipping clients hand it the caller's signal.
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
Object.assign(globalThis, { Response: NativeResponse, fetch: nativeFetch });
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type Owner = "a" | "b";
interface Call {
	bearer: string | null;
	body: unknown;
	delegation: string | null;
	method: string;
	owner: Owner | null;
	path: string;
	status: number;
}
interface NodeState {
	current: string;
	maxInputBytes: number;
	switchedTo: string | null;
	validated: string[];
}
interface Ipc {
	args: unknown;
	command: string;
}

const states: Record<Owner, NodeState> = {
	a: { current: "", maxInputBytes: 0, switchedTo: null, validated: [] },
	b: { current: "", maxInputBytes: 0, switchedTo: null, validated: [] },
};
const calls: Call[] = [];
const unknown: string[] = [];
const runtimeErrors: string[] = [];
const holds = new Map<string, Array<() => void>>();
const held = new Set<string>();
const refuse = new Map<string, number>();
const ipc: Ipc[] = [];
const dialogPaths: string[] = [];
const listeners = new Map<number, string>();
let nextListener = 0;
let pending = 0;

function seed() {
	states.a = {
		current: "/srv/ryu-node-a",
		maxInputBytes: 10 * 1024 * 1024,
		switchedTo: null,
		validated: [],
	};
	states.b = {
		current: "/srv/ryu-node-b",
		maxInputBytes: 48 * 1024 * 1024,
		switchedTo: null,
		validated: [],
	};
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
				bearer: request.headers.get("authorization"),
				delegation: request.headers.get("x-ryu-user-jwt"),
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
				call.bearer !== `Bearer storage-${owner}-token` ||
				call.delegation !== `storage-${owner}-jwt` ||
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
			if (request.method === "GET" && path === "/api/data-path") {
				return reply({
					current: state.current,
					default: "/home/coverage/.ryu",
					free_space_bytes: 64 * 1024 ** 3,
					is_custom: true,
					size_bytes: 3 * 1024 ** 3,
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
					max_input_bytes: state.maxInputBytes,
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
			const target = (call.body as { path?: unknown } | null)?.path;
			if (
				request.method === "POST" &&
				path === "/api/data-path/validate" &&
				typeof target === "string"
			) {
				state.validated.push(target);
				return reply({
					ok: true,
					source_size_bytes: 3 * 1024 ** 3,
					target_free_bytes: owner === "a" ? 500 * 1024 ** 3 : 900 * 1024 ** 3,
				});
			}
			if (
				request.method === "POST" &&
				path === "/api/data-path/switch" &&
				typeof target === "string"
			) {
				if (!state.validated.includes(target)) {
					unknown.push(`${owner} switch to unvalidated ${target}`);
					return reply({ error: "Target was not validated by this node" }, 409);
				}
				state.switchedTo = target;
				return reply({ ok: true, restart_required: true });
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
		transformCallback: () => ++nextListener,
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
				return dialogPaths.shift() ?? null;
			}
			if (command === "plugin:process|restart") {
				return null;
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
const { formatBytes } = await import("@/src/lib/api/spaces.ts");
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
		root!.render(
			createElement(AppSurfaceProvider, {
				surface: "desktop",
				children: createElement(StorageSettings),
			})
		)
	);
}
function release(key: string) {
	for (const resume of holds.get(key) ?? []) {
		resume();
	}
	holds.delete(key);
}
function text() {
	return container?.textContent ?? "";
}
function button(name: string) {
	const found = [...(container?.querySelectorAll("button") ?? [])].find(
		(item) => item.textContent?.trim() === name
	);
	if (!found) {
		throw new Error(`Missing actual Storage action ${name}`);
	}
	return found;
}
function maybeButton(name: string) {
	return [...(container?.querySelectorAll("button") ?? [])].find(
		(item) => item.textContent?.trim() === name
	);
}
function callsFor(owner: Owner, method: string, path: string) {
	return calls.filter(
		(call) =>
			call.owner === owner && call.method === method && call.path === path
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

beforeEach(async () => {
	seed();
	calls.length = 0;
	unknown.length = 0;
	runtimeErrors.length = 0;
	ipc.length = 0;
	dialogPaths.length = 0;
	held.clear();
	refuse.clear();
	queryClient.clear();
	localStorage.setItem("storage-unrelated", "preserved");
	errorToast = spyOn(sileo, "error");
	successToast = spyOn(sileo, "success");
	window.addEventListener("error", onError);
	window.addEventListener("unhandledrejection", onRejection);
	await select("a");
});
afterEach(async () => {
	await unmount();
	await idle();
	errorToast.mockRestore();
	successToast.mockRestore();
	window.removeEventListener("error", onError);
	window.removeEventListener("unhandledrejection", onRejection);
	// Per-case closure: no in-flight exchange, no undeclared or wrong-authority
	// request, no renderer error, the native progress subscription released
	// with the mounted tab, and the unrelated stored record conserved.
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
		localStorage.getItem("storage-unrelated") === "preserved"
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

test("switching nodes rereads the data folder and upload limit from the selected node, and a held prior-node read cannot replace them", async () => {
	held.add("a:GET:/api/data-path");
	held.add("a:GET:/api/documents/parse/capability");
	await mount();
	await until(
		() =>
			holds.has("a:GET:/api/data-path") &&
			holds.has("a:GET:/api/documents/parse/capability"),
		"Node A storage reads did not reach the owned peer"
	);
	expect(text()).toContain("Loading…");
	await select("b");
	await until(
		() =>
			text().includes("/srv/ryu-node-b") &&
			text().includes(formatBytes(48 * 1024 * 1024)),
		"Storage tab did not read the selected node's data folder and upload limit"
	);
	expect(callsFor("b", "GET", "/api/data-path")).toHaveLength(1);
	expect(callsFor("b", "GET", "/api/documents/parse/capability")).toHaveLength(
		1
	);
	// The prior node's genuine replies arrive after the handoff.
	release("a:GET:/api/data-path");
	release("a:GET:/api/documents/parse/capability");
	await until(
		() =>
			callsFor("a", "GET", "/api/data-path")[0]?.status === 200 &&
			callsFor("a", "GET", "/api/documents/parse/capability")[0]?.status ===
				200,
		"Prior node replies were not published"
	);
	await idle();
	expect(text()).toContain("/srv/ryu-node-b");
	expect(text()).not.toContain("/srv/ryu-node-a");
	expect(text()).toContain(formatBytes(48 * 1024 * 1024));
	expect(text()).not.toContain(formatBytes(10 * 1024 * 1024));
	expect(errorToast).not.toHaveBeenCalled();
	// Unmount releases the native progress subscription it opened.
	expect(
		ipc.filter((entry) => entry.command === "plugin:event|listen")
	).toHaveLength(1);
	expect((ipc[0]?.args as { event?: string } | null)?.event).toBe(
		"data-folder-progress"
	);
});

test("a folder validated on the prior node is never switched on the selected node; refusal and retry use only the new node", async () => {
	await mount();
	await until(
		() => text().includes("/srv/ryu-node-a"),
		"Node A data folder not rendered"
	);
	dialogPaths.push("/Volumes/Fast/ryu-data");
	await act(async () => button("Choose folder…").click());
	await until(
		() =>
			states.a.validated.length === 1 &&
			maybeButton("Start fresh here") !== undefined,
		"Folder was not validated by node A"
	);
	expect(callsFor("a", "POST", "/api/data-path/validate")[0]?.body).toEqual({
		path: "/Volumes/Fast/ryu-data",
	});
	expect(text()).toContain("500.0 GB free at target");
	await select("b");
	await until(
		() => text().includes("/srv/ryu-node-b"),
		"Node B data folder not rendered"
	);
	// A validation from node A is not authority to switch node B.
	expect(maybeButton("Start fresh here")).toBeUndefined();
	expect(maybeButton("Copy data & restart")).toBeUndefined();
	expect(text()).not.toContain("/Volumes/Fast/ryu-data");
	expect(button("Choose folder…").disabled).toBe(false);
	expect(calls.filter((call) => call.path === "/api/data-path/switch")).toEqual(
		[]
	);
	// Re-pick: node B validates, refuses the first switch, then accepts a retry.
	dialogPaths.push("/Volumes/Fast/ryu-data");
	await act(async () => button("Choose folder…").click());
	await until(
		() =>
			states.b.validated.length === 1 &&
			maybeButton("Start fresh here") !== undefined,
		"Folder was not validated by node B"
	);
	expect(text()).toContain("900.0 GB free at target");
	refuse.set("b:POST:/api/data-path/switch", 503);
	await act(async () => button("Start fresh here").click());
	await until(
		() => errorToast.mock.calls.length === 1,
		"Refused switch did not surface an error"
	);
	expect(errorToast.mock.calls[0]?.[0]).toMatchObject({
		title: "Could not switch folder",
	});
	expect(String(errorToast.mock.calls[0]?.[0]?.description)).toContain("503");
	expect(button("Start fresh here").disabled).toBe(false);
	expect(ipc.some((entry) => entry.command === "plugin:process|restart")).toBe(
		false
	);
	expect(states.b.switchedTo).toBeNull();
	await act(async () => button("Start fresh here").click());
	await until(
		() => ipc.some((entry) => entry.command === "plugin:process|restart"),
		"Accepted switch did not restart the app"
	);
	expect(
		callsFor("b", "POST", "/api/data-path/switch").map((call) => [
			call.body,
			call.status,
		])
	).toEqual([
		[{ path: "/Volumes/Fast/ryu-data" }, 503],
		[{ path: "/Volumes/Fast/ryu-data" }, 200],
	]);
	expect(states.b.switchedTo).toBe("/Volumes/Fast/ryu-data");
	expect(states.a.switchedTo).toBeNull();
	expect(callsFor("a", "POST", "/api/data-path/switch")).toEqual([]);
	expect(
		ipc.filter((entry) => entry.command === "plugin:process|restart")
	).toHaveLength(1);
});

test("a refused data-folder read offers Retry, and the explicit retry reads only the selected node", async () => {
	refuse.set("a:GET:/api/data-path", 503);
	await mount();
	await until(
		() => text().includes("We couldn't load your data folder details"),
		"Refused data-folder read did not show its recovery state"
	);
	expect(text()).not.toContain("/srv/ryu-node-a");
	await act(async () => button("Retry").click());
	await until(
		() => text().includes("/srv/ryu-node-a"),
		"Retry did not reread node A"
	);
	expect(
		callsFor("a", "GET", "/api/data-path").map((call) => call.status)
	).toEqual([503, 200]);
	expect(text()).not.toContain("We couldn't load your data folder details");
	expect(calls.filter((call) => call.owner === "b")).toEqual([]);
});

test("a validation the prior node answers after a node switch never picks a folder for the selected node", async () => {
	await mount();
	await until(
		() => text().includes("/srv/ryu-node-a"),
		"Node A data folder not rendered"
	);
	// The folder is chosen while node A is selected, and A's check is still in
	// flight when the user selects node B.
	held.add("a:POST:/api/data-path/validate");
	dialogPaths.push("/Volumes/Fast/ryu-data");
	await act(async () => button("Choose folder…").click());
	await until(
		() => holds.has("a:POST:/api/data-path/validate"),
		"Node A validation did not reach the owned peer"
	);
	await select("b");
	await until(
		() => text().includes("/srv/ryu-node-b"),
		"Node B data folder not rendered"
	);
	release("a:POST:/api/data-path/validate");
	await until(
		() => callsFor("a", "POST", "/api/data-path/validate")[0]?.status === 200,
		"Node A validation reply was not published"
	);
	await idle();
	// A's genuine approval arrived, but it is not B's: nothing is picked, no
	// switch or copy can start, and B was never asked to switch.
	expect(states.a.validated).toEqual(["/Volumes/Fast/ryu-data"]);
	expect(text()).not.toContain("/Volumes/Fast/ryu-data");
	expect(text()).not.toContain("500.0 GB free at target");
	expect(maybeButton("Start fresh here")).toBeUndefined();
	expect(maybeButton("Copy data & restart")).toBeUndefined();
	expect(button("Choose folder…").disabled).toBe(false);
	expect(callsFor("b", "POST", "/api/data-path/validate")).toEqual([]);
	expect(calls.filter((call) => call.path === "/api/data-path/switch")).toEqual(
		[]
	);
	expect(ipc.some((entry) => entry.command === "plugin:process|restart")).toBe(
		false
	);
	expect(errorToast).not.toHaveBeenCalled();
	// Picking again asks B, and only B's own figures are shown.
	dialogPaths.push("/Volumes/Fast/ryu-data");
	await act(async () => button("Choose folder…").click());
	await until(
		() => maybeButton("Start fresh here") !== undefined,
		"Node B validation was not shown"
	);
	expect(states.b.validated).toEqual(["/Volumes/Fast/ryu-data"]);
	expect(text()).toContain("900.0 GB free at target");
	expect(text()).not.toContain("500.0 GB free at target");
	expect(callsFor("a", "POST", "/api/data-path/validate")).toHaveLength(1);
});

test("a prior node's refused folder and upload-limit reads that land after a node switch leave the selected node's values without an error state", async () => {
	held.add("a:GET:/api/data-path");
	held.add("a:GET:/api/documents/parse/capability");
	refuse.set("a:GET:/api/data-path", 503);
	refuse.set("a:GET:/api/documents/parse/capability", 503);
	await mount();
	await until(
		() =>
			holds.has("a:GET:/api/data-path") &&
			holds.has("a:GET:/api/documents/parse/capability"),
		"Node A storage reads did not reach the owned peer"
	);
	await select("b");
	await until(
		() =>
			text().includes("/srv/ryu-node-b") &&
			text().includes(formatBytes(48 * 1024 * 1024)),
		"Storage tab did not read the selected node's folder and upload limit"
	);
	release("a:GET:/api/data-path");
	release("a:GET:/api/documents/parse/capability");
	await until(
		() =>
			callsFor("a", "GET", "/api/data-path")[0]?.status === 503 &&
			callsFor("a", "GET", "/api/documents/parse/capability")[0]?.status ===
				503,
		"Prior node refusals were not published"
	);
	await idle();
	// A's refusals describe A, so they neither blank B's folder into the
	// recovery state nor drop B's reported limit back to the built-in default.
	expect(text()).toContain("/srv/ryu-node-b");
	expect(text()).not.toContain("We couldn't load your data folder details");
	expect(maybeButton("Retry")).toBeUndefined();
	expect(text()).toContain(formatBytes(48 * 1024 * 1024));
	expect(text()).toContain("Reported by this node.");
	expect(text()).not.toContain("This node did not report its limit");
	expect(errorToast).not.toHaveBeenCalled();
	expect(callsFor("b", "GET", "/api/data-path")).toHaveLength(1);
	expect(callsFor("a", "GET", "/api/data-path")).toHaveLength(1);
});
