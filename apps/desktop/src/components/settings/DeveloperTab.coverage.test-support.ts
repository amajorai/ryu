import { afterAll, afterEach, beforeEach, spyOn } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Mounts the shipping Developer tab against an owned native HTTP peer that
// serves two node authorities, the real Developer Mode store (localStorage),
// the real console ring buffer and metrics recorder, and an IPC bridge that
// implements only the native commands the tab crosses: the daily-reset flag
// (`get_midnight_wipe` / `set_midnight_wipe`, persisted in a fixture state file)
// and the desktop version. The clipboard is the one browser boundary replaced,
// so each case reads exactly what a user would paste.
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
const NativeReadableStream = globalThis.ReadableStream;
const NativeTransformStream = globalThis.TransformStream;
const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register();
}
Object.assign(globalThis, {
	Response: NativeResponse,
	fetch: nativeFetch,
	ReadableStream: NativeReadableStream,
	TransformStream: NativeTransformStream,
});
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type Owner = "a" | "b";
interface Call {
	authorization: string | null;
	delegation: string | null;
	method: string;
	owner: Owner | null;
	path: string;
}
interface WipeState {
	data_dir: string;
	enabled: boolean;
	last_wipe_date: string | null;
	profile: string;
	state_file: string;
	supported: boolean;
}

export const DEV_MODE_KEY = "ryu_developer_mode";
export const calls: Call[] = [];
const unknown: string[] = [];
const runtimeErrors: string[] = [];
const ipc: Array<{ args: unknown; command: string }> = [];
export const clipboard = { fail: false, text: "", writes: 0 };
export let wipeFile: WipeState = freshWipe();
let wipeRefusesEnable = false;
let wipeWriteFailure: string | null = null;
let pending = 0;

function freshWipe(): WipeState {
	return {
		data_dir: "/Users/coverage/.ryu-canary",
		enabled: false,
		last_wipe_date: "2026-10-10",
		profile: "canary",
		state_file: "/Users/coverage/Library/Application Support/ryu/wipe.json",
		supported: true,
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
			const call: Call = {
				owner,
				method: request.method,
				path,
				authorization: request.headers.get("authorization"),
				delegation: request.headers.get("x-ryu-user-jwt"),
			};
			calls.push(call);
			if (!owner) {
				unknown.push(`${request.method} ${url.pathname}: no node`);
				return NativeResponse.json({ error: "unknown node" }, { status: 404 });
			}
			// Health is the one public probe; every other route needs the node's
			// own token, and the delegated user only where the client sends one.
			if (path === "/api/health") {
				return NativeResponse.json({
					status: "ok",
					version: `7.4.1-coverage-${owner}`,
					capabilities: ["diagnostics"],
				});
			}
			if (call.authorization !== `Bearer developer-${owner}-token`) {
				unknown.push(`${request.method} ${path}: wrong authority`);
				return NativeResponse.json({ error: "forbidden" }, { status: 403 });
			}
			if (path === "/api/version") {
				// Core's `update::VersionInfo`.
				return NativeResponse.json({
					ryu_version: `7.4.1-coverage-${owner}`,
					components: [{ name: "core", version: `7.4.1-coverage-${owner}` }],
					platform: `coverage-${owner}`,
				});
			}
			if (path === "/api/system/status") {
				return NativeResponse.json({
					sidecars: [{ name: `parse-${owner}`, running: true }],
					gateway: { reachable: true },
				});
			}
			if (path === "/api/catalog") {
				return NativeResponse.json(
					{ error: "catalog offline" },
					{ status: 503 }
				);
			}
			unknown.push(`${request.method} ${path}`);
			return NativeResponse.json({ error: "undeclared" }, { status: 404 });
		} finally {
			pending -= 1;
		}
	},
});

const bridgeDescriptor = Object.getOwnPropertyDescriptor(
	window,
	"__TAURI_INTERNALS__"
);
Object.defineProperty(window, "__TAURI_INTERNALS__", {
	configurable: true,
	value: {
		transformCallback: () => 0,
		invoke: async (command: string, args: unknown) => {
			ipc.push({ command, args: structuredClone(args ?? null) });
			if (command === "plugin:app|version") {
				return "3.2.1-coverage";
			}
			if (command === "get_midnight_wipe") {
				return structuredClone(wipeFile);
			}
			if (command === "set_midnight_wipe") {
				if (wipeWriteFailure) {
					throw new Error(wipeWriteFailure);
				}
				const requested = (args as { enabled: boolean }).enabled;
				// The native command refuses to arm on a profile that shares the
				// stable data folder and answers with the unchanged state.
				if (!(requested && wipeRefusesEnable)) {
					wipeFile = { ...wipeFile, enabled: requested };
				}
				return structuredClone(wipeFile);
			}
			throw new Error(`Undeclared native command ${command}`);
		},
	},
});
const clipboardDescriptor = Object.getOwnPropertyDescriptor(
	navigator,
	"clipboard"
);
Object.defineProperty(navigator, "clipboard", {
	configurable: true,
	value: {
		readText: async () => clipboard.text,
		writeText: async (value: string) => {
			if (clipboard.fail) {
				throw new Error("Fixture clipboard failure");
			}
			clipboard.writes += 1;
			clipboard.text = value;
		},
	},
});

export const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { toast } = await import("@ryu/ui/components/sileo.tsx");
const { useNodeStore, LOCAL_FALLBACK } = await import(
	"@/src/store/useNodeStore.ts"
);
const { useDeveloperMode } = await import("@/src/hooks/useDeveloperMode.ts");
export const {
	isConsoleCaptureActive,
	getConsoleBufferText,
	installConsoleCapture,
} = await import("@/src/lib/console-buffer.ts");
export const { isDevMetricsEnabled, getHttpSamples } = await import(
	"@/src/lib/dev-metrics.ts"
);
export const { getVersionInfo } = await import("@/src/lib/api/update.ts");
const { AgentationToolbar } = await import(
	"@/src/components/AgentationToolbar.tsx"
);
const { DeveloperTab } = await import("./DeveloperTab.tsx");

const previousNodes = useNodeStore.getState();
export const base = server.url.toString().replace(/\/$/, "");
const roots: ReturnType<typeof createRoot>[] = [];
export let errorToast: ReturnType<typeof spyOn<typeof toast, "error">>;
export let successToast: ReturnType<typeof spyOn<typeof toast, "success">>;
const onError = (event: ErrorEvent) => runtimeErrors.push(event.message);
const onRejection = (event: PromiseRejectionEvent) =>
	runtimeErrors.push(String(event.reason));

function DeveloperModeReader() {
	const [enabled] = useDeveloperMode();
	return createElement(
		"output",
		{ "data-testid": "developer-mode-reader" },
		enabled ? "reader:on" : "reader:off"
	);
}

export async function idle() {
	for (let i = 0; i < 6; i++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
	}
}
export async function until(predicate: () => boolean, reason: string) {
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
export async function select(owner: Owner) {
	const node = {
		...LOCAL_FALLBACK,
		name: `developer-${owner}`,
		url: `${base}/${owner}`,
		token: `developer-${owner}-token`,
		userJwt: `developer-${owner}-jwt`,
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
export async function mount(withReader = false, withToolbar = false) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container, {
		onCaughtError: (error) => runtimeErrors.push(String(error)),
		onUncaughtError: (error) => runtimeErrors.push(String(error)),
		onRecoverableError: (error) => runtimeErrors.push(String(error)),
	});
	roots.push(root);
	await act(async () =>
		root.render(
			createElement(
				"div",
				null,
				createElement(DeveloperTab),
				withReader ? createElement(DeveloperModeReader) : null,
				// The shell mounts the toolbar the "Toolbar active" row describes.
				withToolbar ? createElement(AgentationToolbar) : null
			)
		)
	);
	await idle();
	return root;
}
export async function unmountAll() {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
}
export function text() {
	return document.body.textContent ?? "";
}
export function maybeButton(name: string) {
	return [...document.body.querySelectorAll("button")].find(
		(item) => item.textContent?.trim() === name
	);
}
export function button(name: string) {
	const found = maybeButton(name);
	if (!found) {
		throw new Error(`Missing Developer action ${name}`);
	}
	return found;
}
/** The visible switch whose hidden form input carries `id`. */
export function switchById(id: string): HTMLElement | null {
	const sibling = document.getElementById(id)?.previousElementSibling;
	return sibling instanceof HTMLElement &&
		sibling.getAttribute("role") === "switch"
		? sibling
		: null;
}
export async function pressSpace(element: HTMLElement) {
	await act(async () => {
		element.focus();
		element.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: " ", code: "Space" })
		);
		element.dispatchEvent(
			new KeyboardEvent("keyup", { bubbles: true, key: " ", code: "Space" })
		);
	});
}
export function requireSwitch(id: string): HTMLElement {
	const found = switchById(id);
	if (!found) {
		throw new Error(`Missing switch ${id}`);
	}
	return found;
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
export function toolbarCount() {
	return document.querySelectorAll("[data-agentation-toolbar]").length;
}
export function nativeCalls(command: string) {
	return ipc.filter((entry) => entry.command === command);
}

/** Registers the per-case setup and closure checks every split file shares. */
export function registerDeveloperTabHooks() {
	beforeEach(async () => {
		calls.length = 0;
		unknown.length = 0;
		runtimeErrors.length = 0;
		ipc.length = 0;
		clipboard.fail = false;
		clipboard.text = "";
		clipboard.writes = 0;
		wipeFile = freshWipe();
		wipeRefusesEnable = false;
		wipeWriteFailure = null;
		localStorage.setItem("developer-coverage-unrelated", "preserved");
		errorToast = spyOn(toast, "error");
		successToast = spyOn(toast, "success");
		window.addEventListener("error", onError);
		window.addEventListener("unhandledrejection", onRejection);
		await select("a");
	});
	afterEach(async () => {
		await unmountAll();
		await idle();
		errorToast.mockRestore();
		successToast.mockRestore();
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
			localStorage.getItem("developer-coverage-unrelated") === "preserved"
				? null
				: "unrelated stored record changed",
		].filter((violation) => violation !== null);
		if (violations.length > 0) {
			throw new Error(
				`Developer case closure failed: ${violations.join(" | ")}`
			);
		}
	});
	afterAll(async () => {
		useNodeStore.setState(previousNodes);
		await server.stop(true);
		if (bridgeDescriptor) {
			Object.defineProperty(window, "__TAURI_INTERNALS__", bridgeDescriptor);
		} else {
			Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
		}
		if (clipboardDescriptor) {
			Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
		}
		if (ownsDom) {
			await GlobalRegistrator.unregister();
		}
	});

	// Runs first on purpose: the console ring buffer and its capture wrapper are
	// page-lifetime singletons, so only a fresh module shows the opt-in moment.
}

/** Makes this build report that it has no isolated folder to wipe. */
export function markWipeUnsupported() {
	wipeFile = { ...wipeFile, supported: false };
}
/** Makes the native wipe command accept but ignore an enable. */
export function refuseWipeEnable(refuses: boolean) {
	wipeRefusesEnable = refuses;
}
/** Makes the native wipe command fail every write with `reason` (`null`: none). */
export function failWipeWrites(reason: string | null) {
	wipeWriteFailure = reason;
}
