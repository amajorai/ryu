import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Mounts the shipping desktop App Updates tab against an owned native HTTP
// peer that plays the desktop's own Core (`/api/version`, `/api/update/check`)
// and an IPC bridge that plays the Tauri shell's app-update commands. The
// bridge stores the automatic-download preference the way `app_update.rs`
// does, and every preference write can be held or refused so the tab's write
// ordering and rollback rules are exercised against real interleavings.
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
const ownsDom = !GlobalRegistrator.isRegistered;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
if (ownsDom) {
	GlobalRegistrator.register();
}
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
Object.assign(globalThis, { Response: NativeResponse, fetch: nativeFetch });
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

interface HeldWrite {
	enabled: boolean;
	refuse: () => void;
	settle: () => void;
}

const APP_VERSION = "1.0.0";
const LATEST = "1.1.0";
const runtimeErrors: string[] = [];
const unknown: string[] = [];
const ipc: Array<{ args: unknown; command: string }> = [];
const heldWrites: HeldWrite[] = [];
let nativePreference = true;
let holdWrites = false;
let prepared: Record<string, unknown> | null = null;
let pendingHttp = 0;

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	idleTimeout: 0,
	fetch(request) {
		pendingHttp += 1;
		try {
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/local/api/version") {
				return NativeResponse.json({
					components: [],
					platform: "linux",
					ryu_version: "0.9.0",
				});
			}
			if (
				request.method === "GET" &&
				url.pathname === "/local/api/update/check"
			) {
				return NativeResponse.json({
					asset: null,
					channel: url.searchParams.get("channel") ?? "stable",
					current: APP_VERSION,
					html_url: null,
					latest: LATEST,
					notes: null,
					tag: `v${LATEST}`,
					update_available: true,
				});
			}
			unknown.push(`${request.method} ${url.pathname}`);
			return NativeResponse.json({ error: "undeclared" }, { status: 404 });
		} finally {
			pendingHttp -= 1;
		}
	},
});
const base = server.url.toString().replace(/\/$/, "");
process.env.VITE_CORE_URL = `${base}/local`;

const bridgeDescriptor = Object.getOwnPropertyDescriptor(
	window,
	"__TAURI_INTERNALS__"
);
Object.defineProperty(window, "__TAURI_INTERNALS__", {
	configurable: true,
	value: {
		transformCallback: () => 0,
		invoke: (command: string, args: unknown) => {
			ipc.push({ command, args: structuredClone(args ?? null) });
			if (command === "plugin:app|version") {
				return Promise.resolve(APP_VERSION);
			}
			if (command === "get_app_update_download_preference") {
				return Promise.resolve(nativePreference);
			}
			if (command === "set_app_update_download_preference") {
				const { enabled } = args as { enabled: boolean };
				if (!holdWrites) {
					nativePreference = enabled;
					return Promise.resolve(null);
				}
				return new Promise((resolve, reject) => {
					heldWrites.push({
						enabled,
						settle: () => {
							nativePreference = enabled;
							resolve(null);
						},
						refuse: () => reject(new Error("preference store refused")),
					});
				});
			}
			if (command === "get_prepared_app_update") {
				return Promise.resolve(prepared);
			}
			if (command === "prepare_app_update") {
				const { request } = args as {
					request: { expectedVersion: string; source: unknown };
				};
				prepared = {
					artifactFile: "ryu-update.tar.gz",
					artifactSize: 1024,
					schemaVersion: 1,
					signature: "sig",
					source: request.source,
					version: request.expectedVersion,
				};
				return Promise.resolve(prepared);
			}
			if (command === "get_pending_app_update") {
				return Promise.resolve(null);
			}
			unknown.push(`ipc ${command}`);
			return Promise.reject(new Error(`Undeclared native command ${command}`));
		},
	},
});

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { sileo } = await import("sileo");
const { toast } = await import("@ryu/ui/components/sileo.tsx");
const { useNodeStore, LOCAL_FALLBACK } = await import(
	"@/src/store/useNodeStore.ts"
);
const { RELEASE_CHANNEL_KEY } = await import("@/src/lib/release-channel.ts");
const { AppUpdatesSettings } = await import("./AppUpdatesSettings.tsx");

const previousNodes = useNodeStore.getState();
let root: ReturnType<typeof createRoot> | null = null;
let errorToast: ReturnType<typeof spyOn<typeof sileo, "error">>;
let infoToast: ReturnType<typeof spyOn<typeof toast, "info">>;
const onError = (event: ErrorEvent) => runtimeErrors.push(event.message);
const onRejection = (event: PromiseRejectionEvent) =>
	runtimeErrors.push(String(event.reason));

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
function commands(name: string) {
	return ipc.filter((call) => call.command === name);
}
function downloadSwitch(): HTMLElement {
	const found = document.body.querySelector(
		'[aria-label="Download app updates automatically"]'
	);
	if (!(found instanceof HTMLElement)) {
		throw new Error("Missing automatic-download switch");
	}
	return found;
}
function switchOn(): boolean {
	return downloadSwitch().getAttribute("aria-checked") === "true";
}
function button(label: string): HTMLButtonElement | undefined {
	return [...document.body.querySelectorAll("button")].find(
		(item) => item.textContent?.trim() === label
	);
}
async function mount() {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container, {
		onCaughtError: (error) => runtimeErrors.push(String(error)),
		onUncaughtError: (error) => runtimeErrors.push(String(error)),
		onRecoverableError: (error) => runtimeErrors.push(String(error)),
	});
	await act(async () => root?.render(createElement(AppUpdatesSettings)));
	await until(
		() => commands("get_prepared_app_update").length > 0,
		"The tab never finished its initial native reads"
	);
	await idle();
}
async function unmount() {
	await act(async () => root?.unmount());
	root = null;
	document.body.replaceChildren();
}
async function toggle() {
	await act(async () => downloadSwitch().click());
}

beforeEach(async () => {
	runtimeErrors.length = 0;
	unknown.length = 0;
	ipc.length = 0;
	heldWrites.length = 0;
	nativePreference = true;
	holdWrites = false;
	prepared = null;
	localStorage.setItem(RELEASE_CHANNEL_KEY, "stable");
	errorToast = spyOn(sileo, "error");
	infoToast = spyOn(toast, "info");
	window.addEventListener("error", onError);
	window.addEventListener("unhandledrejection", onRejection);
	const node = { ...LOCAL_FALLBACK, url: `${base}/local`, token: "t" };
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
});
afterEach(async () => {
	await unmount();
	await idle();
	errorToast.mockRestore();
	infoToast.mockRestore();
	window.removeEventListener("error", onError);
	window.removeEventListener("unhandledrejection", onRejection);
	const violations = [
		pendingHttp === 0 ? null : `${pendingHttp} HTTP exchanges still pending`,
		heldWrites.length === 0 ? null : "preference writes left unsettled",
		unknown.length === 0 ? null : `undeclared: ${unknown.join("; ")}`,
		runtimeErrors.length === 0
			? null
			: `runtime errors: ${runtimeErrors.join("; ")}`,
	].filter((violation) => violation !== null);
	if (violations.length > 0) {
		throw new Error(
			`App updates case closure failed: ${violations.join(" | ")}`
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
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

test("the switch shows the stored native preference and a toggle persists it across a remount", async () => {
	nativePreference = false;
	await mount();
	expect(switchOn()).toBe(false);
	await toggle();
	await idle();
	expect(
		commands("set_app_update_download_preference").map((c) => c.args)
	).toEqual([{ enabled: true }]);
	expect(nativePreference).toBe(true);
	await unmount();
	await mount();
	expect(switchOn()).toBe(true);
	expect(errorToast).not.toHaveBeenCalled();
});

test("rapid toggles are written one at a time in order, so the newest choice is the one stored", async () => {
	await mount();
	holdWrites = true;
	await toggle();
	await toggle();
	await idle();
	// The second write must wait for the first: issuing both at once would let
	// a slow older write land after the newer one.
	expect(heldWrites.map((write) => write.enabled)).toEqual([false]);
	expect(switchOn()).toBe(true);
	heldWrites.shift()?.settle();
	await until(
		() => heldWrites.length === 1,
		"The newer write was never issued after the older one settled"
	);
	expect(heldWrites[0]?.enabled).toBe(true);
	heldWrites.shift()?.settle();
	await idle();
	expect(nativePreference).toBe(true);
	expect(switchOn()).toBe(true);
	expect(errorToast).not.toHaveBeenCalled();
});

test("a refused write rolls the switch back to the stored value read at mount and says so", async () => {
	// Stored off, so a rollback to the component's default (on) would show.
	nativePreference = false;
	await mount();
	holdWrites = true;
	await toggle();
	expect(switchOn()).toBe(true);
	heldWrites.shift()?.refuse();
	await idle();
	expect(switchOn()).toBe(false);
	expect(nativePreference).toBe(false);
	expect(errorToast).toHaveBeenCalledTimes(1);
	expect(errorToast.mock.calls[0]?.[0]).toMatchObject({
		title: "Could not save the automatic-download setting",
	});
});

test("when every queued write is refused, the switch returns to the stored value, not the opposite of the last choice", async () => {
	await mount();
	holdWrites = true;
	await toggle();
	await toggle();
	await idle();
	heldWrites.shift()?.refuse();
	await until(() => heldWrites.length === 1, "Second write not issued");
	expect(errorToast).not.toHaveBeenCalled();
	heldWrites.shift()?.refuse();
	await idle();
	// The last choice was "on"; nothing was stored, so the store still says on.
	expect(nativePreference).toBe(true);
	expect(switchOn()).toBe(true);
	expect(errorToast).toHaveBeenCalledTimes(1);
});

test("an older write refused while a newer choice is queued does not roll back over that choice", async () => {
	await mount();
	holdWrites = true;
	await toggle();
	await toggle();
	await toggle();
	await idle();
	expect(switchOn()).toBe(false);
	heldWrites.shift()?.refuse();
	await until(() => heldWrites.length === 1, "Second write not issued");
	// The switch still shows the newest choice; nothing was reported yet.
	expect(switchOn()).toBe(false);
	expect(errorToast).not.toHaveBeenCalled();
	heldWrites.shift()?.settle();
	await until(() => heldWrites.length === 1, "Third write not issued");
	heldWrites.shift()?.settle();
	await idle();
	expect(nativePreference).toBe(false);
	expect(switchOn()).toBe(false);
	expect(errorToast).not.toHaveBeenCalled();
});

test("with automatic download off, Check for updates offers the download instead of staging it", async () => {
	nativePreference = false;
	await mount();
	await act(async () => button("Check for updates")?.click());
	await until(() => infoToast.mock.calls.length > 0, "No update prompt shown");
	await idle();
	expect(commands("prepare_app_update")).toEqual([]);
	expect(infoToast.mock.calls[0]?.[0]).toMatchObject({
		title: `Update available — v${LATEST}`,
		button: { title: "Download update" },
	});
	expect(button("Install and restart")).toBeUndefined();
});

test("with automatic download on, Check for updates stages the release and offers Install and restart", async () => {
	await mount();
	await act(async () => button("Check for updates")?.click());
	await until(
		() => button("Install and restart") !== undefined,
		"The staged update was never offered for install"
	);
	expect(commands("prepare_app_update").map((c) => c.args)).toEqual([
		{ request: { expectedVersion: LATEST, source: { kind: "stable" } } },
	]);
	expect(document.body.textContent).toContain(
		`v${LATEST} is downloaded and signature-verified.`
	);
	expect(infoToast.mock.calls[0]?.[0]).toMatchObject({
		title: `Update ready — v${LATEST}`,
	});
});

test("a refusal rolls back to the value the store last accepted, not the one read at mount", async () => {
	await mount();
	await toggle();
	await idle();
	expect(nativePreference).toBe(false);
	holdWrites = true;
	await toggle();
	expect(switchOn()).toBe(true);
	heldWrites.shift()?.refuse();
	await idle();
	expect(switchOn()).toBe(false);
	expect(nativePreference).toBe(false);
	expect(errorToast).toHaveBeenCalledTimes(1);
});
