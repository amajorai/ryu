import { afterAll, afterEach, beforeEach, spyOn } from "bun:test";
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

export const calls: Call[] = [];
const unknown: string[] = [];
const runtimeErrors: string[] = [];
export const holds = new Map<string, Array<() => void>>();
export const held = new Set<string>();
export const refuse = new Map<
	string,
	Array<{ error: string; status: number }>
>();
export const ipc: Array<{ args: unknown; command: string }> = [];
export const states: Record<Owner, NodeState> = {
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

export const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClientProvider } = await import("@tanstack/react-query");
const { sileo } = await import("sileo");
export const { useNodeStore, LOCAL_FALLBACK, isLocalNode } = await import(
	"@/src/store/useNodeStore.ts"
);
const { useActiveNode } = await import("@/src/hooks/useActiveNode.ts");
const { AppSurfaceProvider } = await import(
	"@/src/contexts/app-surface-context.tsx"
);
export const { queryClient } = await import("@/src/lib/query-client.ts");
const { DangerZoneSettings } = await import("./DangerZoneSettings.tsx");

const previousNodes = useNodeStore.getState();
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;
export let errorToast: ReturnType<typeof spyOn<typeof sileo, "error">>;
export let successToast: ReturnType<typeof spyOn<typeof sileo, "success">>;
export let reload: ReturnType<typeof spyOn<Location, "reload">>;
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

export async function idle() {
	for (let i = 0; i < 6; i++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
	}
}
export async function until(
	predicate: () => boolean,
	reason: string,
	ms = 4000
) {
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
export function nodeFor(owner: Owner) {
	return {
		...LOCAL_FALLBACK,
		name: `${owner}-node`,
		url: `${base}/${owner}`,
		token: `danger-${owner}-token`,
		userJwt: null,
	};
}
export async function select(owner: Owner) {
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
export async function mount() {
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
export async function unmount() {
	for (const key of [...holds.keys()]) {
		release(key);
	}
	await act(async () => root?.unmount());
	root = null;
	container?.remove();
	container = null;
	document.body.replaceChildren();
}
export function release(key: string) {
	for (const resume of holds.get(key) ?? []) {
		resume();
	}
	holds.delete(key);
}
export function text() {
	return document.body.textContent ?? "";
}
export function maybeButton(name: string, scope: ParentNode = document.body) {
	return [...scope.querySelectorAll("button")].find(
		(item) => item.textContent?.trim() === name
	);
}
export function button(name: string, scope: ParentNode = document.body) {
	const found = maybeButton(name, scope);
	if (!found) {
		throw new Error(`Missing Danger Zone action ${name}`);
	}
	return found;
}
export function alertDialog(): HTMLElement {
	const dialog = document.body.querySelector('[role="alertdialog"]');
	if (!(dialog instanceof HTMLElement)) {
		throw new Error("No confirmation is open");
	}
	return dialog;
}
export function optionsDialog(): HTMLElement {
	const dialog = document.body.querySelector('[role="dialog"]');
	if (!(dialog instanceof HTMLElement)) {
		throw new Error("Deep clean options are not open");
	}
	return dialog;
}
export function captionFor(title: string): string {
	const heading = [
		...document.body.querySelectorAll('[data-slot="item-title"]'),
	].find((element) => element.textContent?.trim() === title);
	// A flush settings row renders its description under its own title.
	const caption = heading?.nextElementSibling;
	return caption instanceof HTMLParagraphElement
		? (caption.textContent ?? "")
		: "";
}
export async function type(input: HTMLInputElement, value: string) {
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set;
		setter?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
export function confirmInput(): HTMLInputElement {
	const input = alertDialog().querySelector("input");
	if (!(input instanceof HTMLInputElement)) {
		throw new Error("Confirmation has no type-to-confirm field");
	}
	return input;
}
/** The visible checkbox whose hidden form input carries the profile's id. */
export function profileChoice(scope: ParentNode, profile: string): HTMLElement {
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
export function writes(owner: Owner) {
	return calls
		.filter((call) => call.owner === owner && call.method !== "GET")
		.map((call) => `${call.method} ${call.path} ${JSON.stringify(call.body)}`);
}
export function nativeCalls(command: string) {
	return ipc.filter((entry) => entry.command === command);
}

/** Registers the per-case setup and closure checks every split file shares. */
export function registerDangerZoneHooks() {
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
		reload = spyOn(window.location, "reload").mockImplementation(
			() => undefined
		);
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
			unknown.length === 0
				? null
				: `undeclared requests: ${unknown.join("; ")}`,
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
}

/** Makes the native `deep_clean_node` refuse this profile (`null`: none). */
export function failDeepCleanFor(profile: string | null) {
	failDeepCleanProfile = profile;
}
