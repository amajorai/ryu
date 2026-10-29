import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Mounts the shipping Danger Zone against an owned native HTTP peer that serves
// two node authorities: `local` (the desktop's own Core, addressed through
// VITE_CORE_URL exactly as a build would) and `remote`. The IPC bridge
// implements only the native commands the tab crosses: the per-profile
// `deep_clean_node` and the Core process controls `restartRyuCore` uses. Every
// node write is a genuine HTTP exchange through the shipping clients, so each
// case observes which node acknowledged which wipe.
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register();
}
Object.assign(globalThis, { Response: NativeResponse, fetch: nativeFetch });
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type Owner = "local" | "remote";
interface Call {
	body: unknown;
	method: string;
	owner: Owner | null;
	path: string;
	status: number;
}
interface Category {
	confirm_word: string;
	count: number;
	detail: string;
	id: string;
	noun: string;
	plugin: string | null;
	title: string;
}
interface NodeState {
	categories: Category[];
	cleared: string[];
	resetConfirms: string[];
}

const calls: Call[] = [];
const unknown: string[] = [];
const runtimeErrors: string[] = [];
const holds = new Map<string, Array<() => void>>();
const held = new Set<string>();
const refuse = new Map<string, Array<{ error: string; status: number }>>();
const ipc: Array<{ args: unknown; command: string }> = [];
const states: Record<Owner, NodeState> = {
	local: { categories: [], cleared: [], resetConfirms: [] },
	remote: { categories: [], cleared: [], resetConfirms: [] },
};
let failDeepCleanProfile: string | null = null;
let pending = 0;

function categories(chats: number, spaces: number, memory: number) {
	return [
		{
			id: "chats",
			title: "Delete all chats",
			noun: "chats",
			confirm_word: "Chats",
			detail: "Every conversation and all of its messages.",
			count: chats,
			plugin: null,
		},
		{
			id: "spaces",
			title: "Delete all spaces",
			noun: "spaces",
			confirm_word: "Spaces",
			detail: "Every Space and its documents.",
			count: spaces,
			plugin: null,
		},
		{
			id: "memory",
			title: "Clear all memory",
			noun: "memory entries",
			confirm_word: "Memory",
			detail: "Every long-term memory entry.",
			count: memory,
			plugin: null,
		},
	];
}
function seed() {
	states.local = {
		categories: categories(7, 2, 0),
		cleared: [],
		resetConfirms: [],
	};
	states.remote = {
		categories: categories(42, 5, 11),
		cleared: [],
		resetConfirms: [],
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
				prefix === "local" || prefix === "remote" ? prefix : null;
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
				request.headers.get("authorization") !== `Bearer danger-${owner}-token`
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
			const refusal = refuse.get(key)?.shift();
			if (refusal) {
				return reply({ error: refusal.error }, refusal.status);
			}
			const state = states[owner];
			if (request.method === "GET" && path === "/api/data/counts") {
				return reply({ categories: state.categories });
			}
			const body = call.body as { category?: unknown; confirm?: unknown };
			if (
				request.method === "POST" &&
				path === "/api/data/clear" &&
				typeof body?.category === "string"
			) {
				const category = state.categories.find(
					(entry) => entry.id === body.category
				);
				const removed = category?.count ?? 0;
				if (category) {
					category.count = 0;
				}
				state.cleared.push(body.category);
				return reply({ removed });
			}
			if (
				request.method === "POST" &&
				path === "/api/node/reset" &&
				typeof body?.confirm === "string"
			) {
				state.resetConfirms.push(body.confirm);
				return reply({ ok: true, restart_required: true });
			}
			unknown.push(`${request.method} ${path}`);
			return reply({ error: "Undeclared danger-zone contract" }, 404);
		} finally {
			pending -= 1;
		}
	},
});
const base = server.url.toString().replace(/\/$/, "");
// The desktop's own Core is whatever VITE_CORE_URL names, so the `local` node
// is local to the shipping `isLocalNode` exactly as in a build.
process.env.VITE_CORE_URL = `${base}/local`;

const bridgeDescriptor = Object.getOwnPropertyDescriptor(
	window,
	"__TAURI_INTERNALS__"
);
let coreStatus = "running";
Object.defineProperty(window, "__TAURI_INTERNALS__", {
	configurable: true,
	value: {
		transformCallback: () => 0,
		invoke: async (command: string, args: unknown) => {
			ipc.push({ command, args: structuredClone(args ?? null) });
			if (command === "deep_clean_node") {
				const { profile } = args as { profile: string };
				if (profile === failDeepCleanProfile) {
					throw new Error(`could not remove the ${profile} data folder`);
				}
				return null;
			}
			if (command === "stop_ryu_core") {
				coreStatus = "stopped";
				return null;
			}
			if (command === "start_ryu_core") {
				coreStatus = "running";
				return "started";
			}
			if (command === "get_ryu_status") {
				return coreStatus;
			}
			throw new Error(`Undeclared native command ${command}`);
		},
	},
});

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClientProvider } = await import("@tanstack/react-query");
const { sileo } = await import("sileo");
const { useNodeStore, LOCAL_FALLBACK, isLocalNode } = await import(
	"@/src/store/useNodeStore.ts"
);
const { useActiveNode } = await import("@/src/hooks/useActiveNode.ts");
const { AppSurfaceProvider } = await import(
	"@/src/contexts/app-surface-context.tsx"
);
const { queryClient } = await import("@/src/lib/query-client.ts");
const { DangerZoneSettings } = await import("./DangerZoneSettings.tsx");

const previousNodes = useNodeStore.getState();
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;
let errorToast: ReturnType<typeof spyOn<typeof sileo, "error">>;
let successToast: ReturnType<typeof spyOn<typeof sileo, "success">>;
let reload: ReturnType<typeof spyOn<Location, "reload">>;
let consoleError: ReturnType<typeof spyOn<Console, "error">>;
const onError = (event: ErrorEvent) => runtimeErrors.push(event.message);
const onRejection = (event: PromiseRejectionEvent) =>
	runtimeErrors.push(String(event.reason));

/**
 * The Gateway dialog that hosts this tab re-renders on every node switch (it
 * reads the active node through `useGatewayStatus`); this parent does the same
 * through the shipping `useActiveNode`, so the tab sees switches as it does in
 * the product.
 */
function GatewayDangerSection() {
	const node = useActiveNode();
	return createElement(
		"div",
		{ "data-node": node.name },
		createElement(DangerZoneSettings)
	);
}

async function idle() {
	for (let i = 0; i < 6; i++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
	}
}
async function until(predicate: () => boolean, reason: string, ms = 4000) {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(reason);
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	}
}
function nodeFor(owner: Owner) {
	return {
		...LOCAL_FALLBACK,
		name: `${owner}-node`,
		url: `${base}/${owner}`,
		token: `danger-${owner}-token`,
		userJwt: null,
	};
}
async function select(owner: Owner) {
	const nodes = [nodeFor("local"), nodeFor("remote")];
	await act(async () => {
		useNodeStore.setState({
			defaultNode: `${owner}-node`,
			nodes,
			localNodes: nodes,
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
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(AppSurfaceProvider, {
					surface: "desktop",
					children: createElement(GatewayDangerSection),
				})
			)
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
	document.body.replaceChildren();
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
function maybeButton(name: string, scope: ParentNode = document.body) {
	return [...scope.querySelectorAll("button")].find(
		(item) => item.textContent?.trim() === name
	);
}
function button(name: string, scope: ParentNode = document.body) {
	const found = maybeButton(name, scope);
	if (!found) {
		throw new Error(`Missing Danger Zone action ${name}`);
	}
	return found;
}
function alertDialog(): HTMLElement {
	const dialog = document.body.querySelector('[role="alertdialog"]');
	if (!(dialog instanceof HTMLElement)) {
		throw new Error("No confirmation is open");
	}
	return dialog;
}
function optionsDialog(): HTMLElement {
	const dialog = document.body.querySelector('[role="dialog"]');
	if (!(dialog instanceof HTMLElement)) {
		throw new Error("Deep clean options are not open");
	}
	return dialog;
}
function captionFor(title: string): string {
	const heading = [
		...document.body.querySelectorAll('[data-slot="item-title"]'),
	].find((element) => element.textContent?.trim() === title);
	const card = heading?.closest('[role="list"]');
	const caption = card?.nextElementSibling;
	return caption instanceof HTMLParagraphElement
		? (caption.textContent ?? "")
		: "";
}
async function type(input: HTMLInputElement, value: string) {
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set;
		setter?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
function confirmInput(): HTMLInputElement {
	const input = alertDialog().querySelector("input");
	if (!(input instanceof HTMLInputElement)) {
		throw new Error("Confirmation has no type-to-confirm field");
	}
	return input;
}
/** The visible checkbox whose hidden form input carries the profile's id. */
function profileChoice(scope: ParentNode, profile: string): HTMLElement {
	const sibling = scope.querySelector(
		`#clean-profile-${profile}`
	)?.previousElementSibling;
	if (
		!(sibling instanceof HTMLElement) ||
		sibling.getAttribute("role") !== "checkbox"
	) {
		throw new Error(`Missing ${profile} profile choice`);
	}
	return sibling;
}
function writes(owner: Owner) {
	return calls
		.filter((call) => call.owner === owner && call.method !== "GET")
		.map((call) => `${call.method} ${call.path} ${JSON.stringify(call.body)}`);
}
function nativeCalls(command: string) {
	return ipc.filter((entry) => entry.command === command);
}

beforeEach(async () => {
	seed();
	calls.length = 0;
	unknown.length = 0;
	runtimeErrors.length = 0;
	ipc.length = 0;
	held.clear();
	refuse.clear();
	failDeepCleanProfile = null;
	coreStatus = "running";
	queryClient.clear();
	localStorage.setItem("danger-coverage-workspace", "/proof/workspace");
	sessionStorage.setItem("danger-coverage-draft", "unsent");
	errorToast = spyOn(sileo, "error");
	successToast = spyOn(sileo, "success");
	reload = spyOn(window.location, "reload").mockImplementation(() => undefined);
	consoleError = spyOn(console, "error").mockImplementation(() => undefined);
	window.addEventListener("error", onError);
	window.addEventListener("unhandledrejection", onRejection);
	await select("remote");
});
afterEach(async () => {
	await unmount();
	await idle();
	errorToast.mockRestore();
	successToast.mockRestore();
	reload.mockRestore();
	consoleError.mockRestore();
	window.removeEventListener("error", onError);
	window.removeEventListener("unhandledrejection", onRejection);
	const violations = [
		pending === 0 ? null : `${pending} native exchanges still pending`,
		unknown.length === 0 ? null : `undeclared requests: ${unknown.join("; ")}`,
		runtimeErrors.length === 0
			? null
			: `runtime errors: ${runtimeErrors.join("; ")}`,
	].filter((violation) => violation !== null);
	localStorage.clear();
	sessionStorage.clear();
	if (violations.length > 0) {
		throw new Error(
			`Danger Zone case closure failed: ${violations.join(" | ")}`
		);
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
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

test("Checking this node holds every delete until the selected node's counts arrive, a refused read keeps deletes disabled behind Retry, and the rows that appear are that node's", async () => {
	expect(isLocalNode(nodeFor("local"))).toBe(true);
	expect(isLocalNode(nodeFor("remote"))).toBe(false);
	held.add("remote:GET:/api/data/counts");
	await mount();
	await until(
		() => holds.has("remote:GET:/api/data/counts"),
		"The counts read did not reach the remote node"
	);
	expect(text()).toContain("Checking this node");
	expect(captionFor("Checking this node")).toBe("Loading…");
	expect(maybeButton("Delete all chats")?.textContent).toBeUndefined();
	release("remote:GET:/api/data/counts");
	await until(
		() => maybeButton("Delete all chats") !== undefined,
		"Remote counts did not render"
	);
	expect(text()).not.toContain("Checking this node");
	expect(captionFor("Delete all chats")).toBe("42 chats");
	expect(captionFor("Clear all memory")).toBe("11 memory entries");
	expect(button("Delete all chats").disabled).toBe(false);

	// A failed read (and its one automatic retry) never offers a delete.
	await unmount();
	queryClient.clear();
	await select("local");
	refuse.set("local:GET:/api/data/counts", [
		{ error: "store busy", status: 503 },
		{ error: "store busy", status: 503 },
	]);
	await mount();
	await until(
		() => text().includes("We couldn't load your data."),
		"A refused counts read did not show its recovery state",
		6000
	);
	expect(maybeButton("Delete all chats")?.textContent).toBeUndefined();
	await act(async () => button("Retry").click());
	await until(
		() => maybeButton("Delete all chats") !== undefined,
		"Retry did not reread the counts"
	);
	expect(captionFor("Delete all chats")).toBe("7 chats");
	// An empty category cannot be deleted.
	expect(captionFor("Clear all memory")).toBe("No memory entries");
	expect(button("Clear all memory").disabled).toBe(true);
	expect(
		calls
			.filter((call) => call.owner === "local")
			.map((call) => `${call.path} ${call.status}`)
	).toEqual([
		"/api/data/counts 503",
		"/api/data/counts 503",
		"/api/data/counts 200",
	]);
	expect(writes("local")).toEqual([]);
	expect(writes("remote")).toEqual([]);
}, 15_000);

test("Reset node to a fresh state arms only on the node's name, is refused visibly without touching this device, then wipes the selected remote node through its own Core, clears client state and reloads without restarting local Core", async () => {
	await mount();
	await until(
		() => maybeButton("Delete all chats") !== undefined,
		"Remote counts did not render"
	);
	expect(captionFor("Reset node to a fresh state")).toBe(
		'Fully resets "remote-node" and restarts it'
	);
	await act(async () => button("Reset node").click());
	const confirm = () => button("Reset node", alertDialog());
	expect(alertDialog().textContent).toContain("remote-node");
	expect(confirm().disabled).toBe(true);
	await type(confirmInput(), "local-node");
	expect(confirm().disabled).toBe(true);
	await type(confirmInput(), "  REMOTE-NODE ");
	expect(confirm().disabled).toBe(false);

	refuse.set("remote:POST:/api/node/reset", [
		{
			error:
				"forbidden: resetting a node wipes ALL data on it and is not allowed on a shared (org-bound) node",
			status: 403,
		},
	]);
	await act(async () => confirm().click());
	await until(
		() => errorToast.mock.calls.length === 1,
		"A refused reset did not report"
	);
	expect(errorToast.mock.calls[0]?.[0]).toEqual({
		title: "Could not reset node",
		description:
			"forbidden: resetting a node wipes ALL data on it and is not allowed on a shared (org-bound) node",
	});
	expect(localStorage.getItem("danger-coverage-workspace")).toBe(
		"/proof/workspace"
	);
	expect(reload).not.toHaveBeenCalled();
	expect(confirm().disabled).toBe(false);

	await act(async () => confirm().click());
	await until(() => reload.mock.calls.length === 1, "Reset did not reload");
	expect(successToast.mock.calls[0]?.[0]).toEqual({
		title: "Node reset",
		description: "Restarting to wipe and start fresh…",
	});
	expect(states.remote.resetConfirms).toEqual(["remote-node"]);
	expect(
		calls
			.filter((call) => call.path === "/api/node/reset")
			.map((call) => [call.owner, call.body, call.status])
	).toEqual([
		["remote", { confirm: "remote-node" }, 403],
		["remote", { confirm: "remote-node" }, 200],
	]);
	expect(writes("local")).toEqual([]);
	// A remote node is restarted by its own host; local Core is left alone.
	expect(nativeCalls("stop_ryu_core")).toEqual([]);
	expect(nativeCalls("start_ryu_core")).toEqual([]);
	expect(localStorage.getItem("danger-coverage-workspace")).toBeNull();
	expect(sessionStorage.getItem("danger-coverage-draft")).toBeNull();
});

test("Reset node on the local node restarts the desktop's own Core before reloading, and a Core too old for reset is named as the cause", async () => {
	await select("local");
	await mount();
	await until(
		() => maybeButton("Delete all chats") !== undefined,
		"Local counts did not render"
	);
	await act(async () => button("Reset node").click());
	await type(confirmInput(), "local-node");
	refuse.set("local:POST:/api/node/reset", [
		{ error: "not found", status: 404 },
	]);
	await act(async () => button("Reset node", alertDialog()).click());
	await until(
		() => errorToast.mock.calls.length === 1,
		"An old Core's missing route was not reported"
	);
	expect(String(errorToast.mock.calls[0]?.[0]?.description)).toContain(
		"This node's Core is too old to support resetting"
	);
	expect(nativeCalls("stop_ryu_core")).toEqual([]);

	await act(async () => button("Reset node", alertDialog()).click());
	await until(
		() => reload.mock.calls.length === 1,
		"Local reset did not reload",
		8000
	);
	expect(states.local.resetConfirms).toEqual(["local-node"]);
	expect(
		calls
			.filter((call) => call.path === "/api/node/reset")
			.map((call) => [call.owner, call.status])
	).toEqual([
		["local", 404],
		["local", 200],
	]);
	expect(nativeCalls("stop_ryu_core")).toHaveLength(1);
	expect(nativeCalls("start_ryu_core")).toHaveLength(1);
	const order = ipc.map((entry) => entry.command);
	expect(order.indexOf("stop_ryu_core")).toBeLessThan(
		order.indexOf("start_ryu_core")
	);
	expect(writes("remote")).toEqual([]);
	expect(localStorage.getItem("danger-coverage-workspace")).toBeNull();
}, 15_000);

test("Run deep clean removes each chosen profile in order, offers no machine-wide shadow or ghost clear, keeps choices after a failure, then restarts local Core once and reloads", async () => {
	await select("local");
	await mount();
	await until(
		() => maybeButton("Deep clean…") !== undefined,
		"Deep clean row did not render"
	);
	expect(captionFor("Run deep clean")).toBe(
		"Choose which profiles and how much to remove, then restart into setup"
	);
	await act(async () => button("Deep clean…").click());
	const options = optionsDialog();
	const devProfile = profileChoice(options, "dev");
	expect(devProfile.getAttribute("aria-checked")).toBe("false");
	expect(profileChoice(options, "release").getAttribute("aria-checked")).toBe(
		"true"
	);
	// The user clicks the profile's labelled row.
	const devLabel = options.querySelector('label[for="clean-profile-dev"]');
	if (!(devLabel instanceof HTMLElement)) {
		throw new Error("Missing dev profile label");
	}
	await act(async () => devLabel.click());
	expect(profileChoice(options, "dev").getAttribute("aria-checked")).toBe(
		"true"
	);
	// Shadow and ghost state live inside each profile's data folder, so there is
	// no separate machine-wide clear to offer.
	expect(
		[...options.querySelectorAll('[role="switch"]')].map((element) =>
			element.getAttribute("aria-label")
		)
	).not.toContain("Also clear shadow and ghost");
	await act(async () => button("Continue", optionsDialog()).click());
	const confirmation = alertDialog().textContent ?? "";
	expect(confirmation).toContain("release, dev");
	expect(confirmation).toContain(
		"clear its data folder while keeping downloaded engines and models"
	);
	expect(confirmation).not.toContain("~/.shadow");
	expect(confirmation).not.toContain("shared by every profile");

	failDeepCleanProfile = "dev";
	await act(async () => button("Remove them", alertDialog()).click());
	await until(
		() => errorToast.mock.calls.length === 1,
		"A failed deep clean did not report"
	);
	expect(errorToast.mock.calls[0]?.[0]).toMatchObject({
		title: "Could not deep clean",
	});
	expect(String(errorToast.mock.calls[0]?.[0]?.description)).toContain(
		"could not remove the dev data folder"
	);
	expect(reload).not.toHaveBeenCalled();
	expect(nativeCalls("stop_ryu_core")).toEqual([]);
	// `deep_clean_node` stopped local Core before failing, and nothing else
	// restarts it, so the failure path starts it again for the retry.
	expect(nativeCalls("start_ryu_core")).toHaveLength(1);
	expect(localStorage.getItem("danger-coverage-workspace")).toBe(
		"/proof/workspace"
	);
	// The options stay as chosen for a retry.
	const retryOptions = optionsDialog();
	expect(profileChoice(retryOptions, "dev").getAttribute("aria-checked")).toBe(
		"true"
	);
	expect(
		profileChoice(retryOptions, "release").getAttribute("aria-checked")
	).toBe("true");

	failDeepCleanProfile = null;
	await act(async () => button("Continue", retryOptions).click());
	await act(async () => button("Remove them", alertDialog()).click());
	await until(
		() => reload.mock.calls.length === 1,
		"Deep clean did not reload",
		8000
	);
	expect(nativeCalls("deep_clean_node").map((entry) => entry.args)).toEqual([
		{ depth: "state", profile: "release" },
		{ depth: "state", profile: "dev" },
		{ depth: "state", profile: "release" },
		{ depth: "state", profile: "dev" },
	]);
	expect(nativeCalls("stop_ryu_core")).toHaveLength(1);
	expect(nativeCalls("start_ryu_core")).toHaveLength(2);
	expect(successToast.mock.calls[0]?.[0]).toMatchObject({
		title: "Deep clean complete",
	});
	expect(localStorage.getItem("danger-coverage-workspace")).toBeNull();
	// Deep clean is a device operation: no node was asked to delete anything.
	expect(writes("local")).toEqual([]);
	expect(writes("remote")).toEqual([]);
}, 15_000);

test("Run deep clean with a remote node selected cleans this device's profiles but leaves Core restarts to the remote host", async () => {
	await mount();
	await until(
		() => maybeButton("Deep clean…") !== undefined,
		"Deep clean row did not render"
	);
	await act(async () => button("Deep clean…").click());
	await act(async () => button("Continue", optionsDialog()).click());
	const confirmation = alertDialog().textContent ?? "";
	expect(confirmation).toContain(
		"permanently remove the release profile's gateway config folder"
	);
	expect(confirmation).not.toContain("~/.shadow");
	expect(confirmation).not.toContain("shared by every profile");
	await act(async () => button("Remove them", alertDialog()).click());
	await until(
		() => reload.mock.calls.length === 1,
		"Deep clean did not reload"
	);
	expect(nativeCalls("deep_clean_node").map((entry) => entry.args)).toEqual([
		{ depth: "state", profile: "release" },
	]);
	expect(nativeCalls("stop_ryu_core")).toEqual([]);
	expect(writes("remote")).toEqual([]);
});

test("a delete confirmed for one node's counts is never carried out on a node selected while the confirmation was open", async () => {
	await mount();
	await until(
		() => maybeButton("Delete all chats") !== undefined,
		"Remote counts did not render"
	);
	await act(async () => button("Delete all chats").click());
	expect(alertDialog().textContent).toContain("This will delete 42 chats.");
	await type(confirmInput(), "Chats");

	// The selection moves to the local node while the remote's count is shown.
	await select("local");
	await until(
		() => captionFor("Delete all chats") === "7 chats",
		"The tab did not reread the selected node's counts"
	);
	const stillOpen = document.body.querySelector('[role="alertdialog"]');
	const deleteButton = stillOpen ? maybeButton("Delete", stillOpen) : undefined;
	if (deleteButton && !deleteButton.disabled) {
		await act(async () => deleteButton.click());
		await idle();
	}
	// Neither node lost data to a confirmation that described the remote's 42
	// chats: the local node was never asked, and the remote was not either.
	expect(states.local.cleared).toEqual([]);
	expect(states.remote.cleared).toEqual([]);
	expect(writes("local")).toEqual([]);
	expect(writes("remote")).toEqual([]);
	await until(
		() => document.body.querySelector('[role="alertdialog"]') === null,
		"The remote's delete confirmation stayed open for the local node"
	);

	// A fresh confirmation names and clears the selected node's own count.
	await act(async () => button("Delete all chats").click());
	expect(alertDialog().textContent).toContain("This will delete 7 chats.");
	await type(confirmInput(), "chats");
	await act(async () => button("Delete", alertDialog()).click());
	await until(
		() => successToast.mock.calls.length === 1,
		"The local delete did not complete"
	);
	expect(successToast.mock.calls[0]?.[0]).toEqual({
		title: "Deleted",
		description: "7 chats deleted.",
	});
	expect(states.local.cleared).toEqual(["chats"]);
	expect(states.remote.cleared).toEqual([]);
	await until(
		() => captionFor("Delete all chats") === "No chats",
		"Counts were not refreshed after the delete"
	);
});

test("a reset confirmation typed for one node is withdrawn when another node is selected, and reopening names the selected node", async () => {
	await mount();
	await until(
		() => maybeButton("Delete all chats") !== undefined,
		"Remote counts did not render"
	);
	await act(async () => button("Reset node").click());
	await type(confirmInput(), "remote-node");
	expect(button("Reset node", alertDialog()).disabled).toBe(false);
	await select("local");
	await until(
		() => document.body.querySelector('[role="alertdialog"]') === null,
		"The remote's reset confirmation stayed open for the local node"
	);
	expect(captionFor("Reset node to a fresh state")).toBe(
		'Fully resets "local-node" and restarts it'
	);
	await act(async () => button("Reset node").click());
	expect(alertDialog().textContent).toContain("local-node");
	expect(confirmInput().value).toBe("");
	expect(button("Reset node", alertDialog()).disabled).toBe(true);
	expect(calls.filter((call) => call.path === "/api/node/reset")).toEqual([]);
	expect(reload).not.toHaveBeenCalled();
});
