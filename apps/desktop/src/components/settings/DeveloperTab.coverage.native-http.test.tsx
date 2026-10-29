import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
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

const DEV_MODE_KEY = "ryu_developer_mode";
const calls: Call[] = [];
const unknown: string[] = [];
const runtimeErrors: string[] = [];
const ipc: Array<{ args: unknown; command: string }> = [];
const clipboard = { fail: false, text: "", writes: 0 };
let wipeFile: WipeState = freshWipe();
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

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { toast } = await import("@ryu/ui/components/sileo.tsx");
const { useNodeStore, LOCAL_FALLBACK } = await import(
	"@/src/store/useNodeStore.ts"
);
const { useDeveloperMode } = await import("@/src/hooks/useDeveloperMode.ts");
const { isConsoleCaptureActive, getConsoleBufferText, installConsoleCapture } =
	await import("@/src/lib/console-buffer.ts");
const { isDevMetricsEnabled, getHttpSamples } = await import(
	"@/src/lib/dev-metrics.ts"
);
const { getVersionInfo } = await import("@/src/lib/api/update.ts");
const { AgentationToolbar } = await import(
	"@/src/components/AgentationToolbar.tsx"
);
const { DeveloperTab } = await import("./DeveloperTab.tsx");

const previousNodes = useNodeStore.getState();
const base = server.url.toString().replace(/\/$/, "");
const roots: ReturnType<typeof createRoot>[] = [];
let errorToast: ReturnType<typeof spyOn<typeof toast, "error">>;
let successToast: ReturnType<typeof spyOn<typeof toast, "success">>;
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

async function idle() {
	for (let i = 0; i < 6; i++) {
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
async function mount(withReader = false, withToolbar = false) {
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
async function unmountAll() {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
}
function text() {
	return document.body.textContent ?? "";
}
function maybeButton(name: string) {
	return [...document.body.querySelectorAll("button")].find(
		(item) => item.textContent?.trim() === name
	);
}
function button(name: string) {
	const found = maybeButton(name);
	if (!found) {
		throw new Error(`Missing Developer action ${name}`);
	}
	return found;
}
/** The visible switch whose hidden form input carries `id`. */
function switchById(id: string): HTMLElement | null {
	const sibling = document.getElementById(id)?.previousElementSibling;
	return sibling instanceof HTMLElement &&
		sibling.getAttribute("role") === "switch"
		? sibling
		: null;
}
async function pressSpace(element: HTMLElement) {
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
function requireSwitch(id: string): HTMLElement {
	const found = switchById(id);
	if (!found) {
		throw new Error(`Missing switch ${id}`);
	}
	return found;
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
function toolbarCount() {
	return document.querySelectorAll("[data-agentation-toolbar]").length;
}
function nativeCalls(command: string) {
	return ipc.filter((entry) => entry.command === command);
}

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
		unknown.length === 0 ? null : `undeclared requests: ${unknown.join("; ")}`,
		runtimeErrors.length === 0
			? null
			: `runtime errors: ${runtimeErrors.join("; ")}`,
		localStorage.getItem("developer-coverage-unrelated") === "preserved"
			? null
			: "unrelated stored record changed",
	].filter((violation) => violation !== null);
	if (violations.length > 0) {
		throw new Error(`Developer case closure failed: ${violations.join(" | ")}`);
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
test("Enable developer mode persists on this device, reveals the debug rows, starts console capture and metric recording without a reload, and every consumer and a remount read the same choice", async () => {
	expect(isConsoleCaptureActive()).toBe(false);
	localStorage.removeItem(DEV_MODE_KEY);
	await mount(true);
	const devSwitch = requireSwitch("developer-mode");
	expect(devSwitch.getAttribute("aria-checked")).toBe("false");
	expect(text()).toContain("reader:off");
	for (const hidden of [
		"Toolbar active",
		"Console buffer status",
		"Collect & copy diagnostics",
		"Copy console output",
	]) {
		expect(text()).not.toContain(hidden);
	}
	expect(
		switchById("agentation-toolbar")?.getAttribute("role") ?? null
	).toBeNull();
	console.info("developer coverage before opt-in");
	await getVersionInfo({ url: `${base}/a`, token: "developer-a-token" });
	expect(getHttpSamples()).toHaveLength(0);

	// Keyboard operation: the focused switch flips with Space.
	await pressSpace(devSwitch);
	await idle();
	expect(document.activeElement === requireSwitch("developer-mode")).toBe(true);
	expect(requireSwitch("developer-mode").getAttribute("aria-checked")).toBe(
		"true"
	);
	expect(localStorage.getItem(DEV_MODE_KEY)).toBe("true");
	expect(text()).toContain("reader:on");
	// Toolbar active: an always-on indicator while Developer Mode is on.
	const toolbar = requireSwitch("agentation-toolbar");
	expect(toolbar.getAttribute("aria-checked")).toBe("true");
	expect(toolbar.getAttribute("aria-disabled")).toBe("true");
	await act(async () => toolbar.click());
	expect(toolbar.getAttribute("aria-checked")).toBe("true");
	expect(localStorage.getItem(DEV_MODE_KEY)).toBe("true");
	// Console buffer status: capture is installed by the flip itself.
	expect(isConsoleCaptureActive()).toBe(true);
	const capture = requireSwitch("console-capture");
	expect(capture.getAttribute("aria-checked")).toBe("true");
	expect(capture.getAttribute("aria-disabled")).toBe("true");
	expect(captionFor("Console buffer status")).toBe(
		"Capturing. Up to 500 entries are kept in memory."
	);
	// Copy console output on an empty buffer reports it instead of copying.
	await act(async () => button("Copy console").click());
	expect(errorToast).toHaveBeenCalledWith("Console buffer is empty");
	expect(clipboard.writes).toBe(0);
	// Metrics start without a reload: the gate was refreshed by the flip.
	expect(isDevMetricsEnabled()).toBe(true);
	await act(async () => {
		await getVersionInfo({ url: `${base}/a`, token: "developer-a-token" });
	});
	expect(getHttpSamples().map((sample) => sample.path)).toEqual([
		"/api/version",
	]);
	console.info("developer coverage after opt-in");
	expect(getConsoleBufferText()).toContain("developer coverage after opt-in");
	expect(getConsoleBufferText()).not.toContain(
		"developer coverage before opt-in"
	);

	// Turning it off hides every gated row at once and stops both recorders.
	await act(async () => requireSwitch("developer-mode").click());
	await idle();
	expect(localStorage.getItem(DEV_MODE_KEY)).toBe("false");
	expect(text()).toContain("reader:off");
	expect(
		switchById("agentation-toolbar")?.getAttribute("role") ?? null
	).toBeNull();
	expect(
		switchById("console-capture")?.getAttribute("role") ?? null
	).toBeNull();
	expect(maybeButton("Copy diagnostics")?.textContent).toBeUndefined();
	expect(isDevMetricsEnabled()).toBe(false);
	console.info("developer coverage after opt-out");
	await act(async () => {
		await getVersionInfo({ url: `${base}/a`, token: "developer-a-token" });
	});
	expect(getHttpSamples()).toHaveLength(1);
	expect(getConsoleBufferText()).not.toContain(
		"developer coverage after opt-out"
	);

	// An independent remount reads the stored choice.
	await unmountAll();
	await mount();
	expect(requireSwitch("developer-mode").getAttribute("aria-checked")).toBe(
		"false"
	);
	await act(async () => requireSwitch("developer-mode").click());
	await unmountAll();
	await mount();
	expect(requireSwitch("developer-mode").getAttribute("aria-checked")).toBe(
		"true"
	);
	expect(requireSwitch("agentation-toolbar").getAttribute("aria-checked")).toBe(
		"true"
	);
});

test("Copy console output places the captured lines on the clipboard and reports a clipboard failure without copying", async () => {
	localStorage.setItem(DEV_MODE_KEY, "true");
	// Boot installs capture when Developer Mode was left on (main.tsx).
	installConsoleCapture();
	await mount();
	console.warn("developer coverage warning line");
	clipboard.fail = true;
	await act(async () => button("Copy console").click());
	expect(errorToast).toHaveBeenCalledWith("Couldn't copy to clipboard");
	expect(clipboard.text).toBe("");
	clipboard.fail = false;
	await act(async () => button("Copy console").click());
	expect(successToast).toHaveBeenCalledWith(
		"Console output copied to clipboard"
	);
	expect(clipboard.text).toMatch(/WARN developer coverage warning line/);
	expect(clipboard.text).toBe(getConsoleBufferText());
});

test("Collect & copy diagnostics bundles the selected node's probes with that node's authority, reports a clipboard failure, and follows a node switch", async () => {
	localStorage.setItem(DEV_MODE_KEY, "true");
	installConsoleCapture();
	await mount();
	console.info("developer coverage diagnostics marker");
	await act(async () => button("Copy diagnostics").click());
	await until(
		() => successToast.mock.calls.length === 1,
		"Diagnostics were not copied"
	);
	expect(successToast).toHaveBeenCalledWith("Diagnostics copied to clipboard");
	const bundle = clipboard.text;
	expect(bundle).toStartWith("# Ryu diagnostics");
	expect(bundle).toContain(`node ${base}/a`);
	expect(bundle).toContain("## Desktop\nversion 3.2.1-coverage");
	expect(bundle).toContain('"version": "7.4.1-coverage-a"');
	expect(bundle).toContain('"ryu_version": "7.4.1-coverage-a"');
	expect(bundle).toContain('"platform": "coverage-a"');
	expect(bundle).toContain('"parse-a": true');
	expect(bundle).toContain(
		"## Sidecars (/api/catalog)\n(unavailable: catalog fetch failed: 503)"
	);
	expect(bundle).toContain("developer coverage diagnostics marker");
	expect(bundle).toContain("## Performance");
	// Health is the anonymous probe; the rest carry node A's own token.
	const forA = calls.filter((call) => call.owner === "a");
	expect(
		forA.find((call) => call.path === "/api/health")?.authorization
	).toBeNull();
	expect(forA.find((call) => call.path === "/api/version")?.authorization).toBe(
		"Bearer developer-a-token"
	);

	clipboard.fail = true;
	await act(async () => button("Copy diagnostics").click());
	await until(
		() => errorToast.mock.calls.length === 1,
		"Clipboard failure was not reported"
	);
	expect(errorToast).toHaveBeenCalledWith("Couldn't copy diagnostics");
	expect(clipboard.text).toBe(bundle);

	clipboard.fail = false;
	await select("b");
	calls.length = 0;
	await act(async () => button("Copy diagnostics").click());
	await until(
		() => successToast.mock.calls.length === 2,
		"Diagnostics after the node switch were not copied"
	);
	expect(clipboard.text).toContain(`node ${base}/b`);
	expect(clipboard.text).toContain('"version": "7.4.1-coverage-b"');
	expect(clipboard.text).toContain('"ryu_version": "7.4.1-coverage-b"');
	expect(clipboard.text).not.toContain("7.4.1-coverage-a");
	expect(calls.every((call) => call.owner === "b")).toBe(true);
});

test("Wipe this data folder at midnight is saved through the native command, survives a remount, stays reachable with Developer Mode off, and is hidden where the build has no isolated folder", async () => {
	localStorage.setItem(DEV_MODE_KEY, "false");
	await mount();
	await until(
		() => switchById("midnight-wipe") !== null,
		"Daily reset row did not render"
	);
	expect(text()).toContain("Daily data reset");
	expect(captionFor("Wipe this data folder at midnight")).toContain(
		"Deletes everything in /Users/coverage/.ryu-canary"
	);
	expect(captionFor("Wipe this data folder at midnight")).toContain(
		"Last cleared 2026-10-10."
	);
	const wipe = requireSwitch("midnight-wipe");
	expect(wipe.getAttribute("aria-checked")).toBe("false");
	await act(async () => wipe.click());
	await until(
		() => successToast.mock.calls.length === 1,
		"Enabling the daily reset did not report"
	);
	expect(successToast).toHaveBeenCalledWith(
		"Daily reset on. This build's data folder clears at the first launch after midnight"
	);
	expect(nativeCalls("set_midnight_wipe").map((entry) => entry.args)).toEqual([
		{ enabled: true },
	]);
	expect(wipeFile.enabled).toBe(true);
	expect(requireSwitch("midnight-wipe").getAttribute("aria-checked")).toBe(
		"true"
	);

	await unmountAll();
	await mount();
	await until(
		() => switchById("midnight-wipe")?.getAttribute("aria-checked") === "true",
		"Remount did not read the stored daily reset"
	);
	await act(async () => requireSwitch("midnight-wipe").click());
	await until(
		() => successToast.mock.calls.length === 2,
		"Disabling the daily reset did not report"
	);
	expect(successToast).toHaveBeenLastCalledWith("Daily reset off");
	expect(wipeFile.enabled).toBe(false);

	wipeFile = { ...wipeFile, supported: false };
	await unmountAll();
	await mount();
	await idle();
	expect(nativeCalls("get_midnight_wipe").length).toBeGreaterThanOrEqual(3);
	expect(switchById("midnight-wipe")?.getAttribute("role") ?? null).toBeNull();
	expect(text()).not.toContain("Daily data reset");
	expect(localStorage.getItem(DEV_MODE_KEY)).toBe("false");
});

test("Couldn't save that setting: a refused enable keeps the switch off, a failed write shows the command's reason and rereads the stored flag, and the next good write clears it", async () => {
	await mount();
	await until(
		() => switchById("midnight-wipe") !== null,
		"Daily reset row did not render"
	);
	wipeRefusesEnable = true;
	await act(async () => requireSwitch("midnight-wipe").click());
	await until(
		() => errorToast.mock.calls.length === 1,
		"Refused enable did not report"
	);
	expect(errorToast).toHaveBeenCalledWith("Couldn't save that setting");
	expect(requireSwitch("midnight-wipe").getAttribute("aria-checked")).toBe(
		"false"
	);
	expect(wipeFile.enabled).toBe(false);
	// A refusal is not an error: the command answered, so no reason row.
	expect(captionFor("Couldn't save that setting")).toBe("");

	wipeRefusesEnable = false;
	wipeWriteFailure = "wipe state file is read-only";
	const readsBefore = nativeCalls("get_midnight_wipe").length;
	await act(async () => requireSwitch("midnight-wipe").click());
	await until(
		() => errorToast.mock.calls.length === 2,
		"Failed write did not report"
	);
	expect(captionFor("Couldn't save that setting")).toBe(
		"wipe state file is read-only"
	);
	expect(nativeCalls("get_midnight_wipe").length).toBe(readsBefore + 1);
	expect(requireSwitch("midnight-wipe").getAttribute("aria-checked")).toBe(
		"false"
	);
	expect(successToast).not.toHaveBeenCalled();

	wipeWriteFailure = null;
	await act(async () => requireSwitch("midnight-wipe").click());
	await until(
		() => successToast.mock.calls.length === 1,
		"Recovered write did not report"
	);
	expect(requireSwitch("midnight-wipe").getAttribute("aria-checked")).toBe(
		"true"
	);
	expect(text()).not.toContain("wipe state file is read-only");
	expect(
		[...document.body.querySelectorAll('[data-slot="item-title"]')].some(
			(element) => element.textContent === "Couldn't save that setting"
		)
	).toBe(false);
	expect(wipeFile.enabled).toBe(true);
});

// Last on purpose: the toolbar logs its own connection warnings into the
// page-lifetime console buffer that the cases above read.
test("Toolbar active describes the annotation toolbar the shell mounts: it appears with Developer Mode, cannot be switched off on its own, and leaves with Developer Mode", async () => {
	localStorage.setItem(DEV_MODE_KEY, "false");
	await mount(false, true);
	await idle();
	expect(toolbarCount()).toBe(0);
	expect(text()).not.toContain("Toolbar active");
	await act(async () => requireSwitch("developer-mode").click());
	await until(
		() => toolbarCount() === 1,
		"The annotation toolbar did not mount with Developer Mode on"
	);
	const indicator = requireSwitch("agentation-toolbar");
	expect(indicator.getAttribute("aria-checked")).toBe("true");
	await act(async () => indicator.click());
	await idle();
	expect(indicator.getAttribute("aria-checked")).toBe("true");
	await pressSpace(indicator);
	await idle();
	expect(indicator.getAttribute("aria-checked")).toBe("true");
	expect(toolbarCount()).toBe(1);
	await act(async () => requireSwitch("developer-mode").click());
	await until(
		() => toolbarCount() === 0,
		"The annotation toolbar outlived Developer Mode"
	);
	expect(
		switchById("agentation-toolbar")?.getAttribute("role") ?? null
	).toBeNull();
	expect(localStorage.getItem(DEV_MODE_KEY)).toBe("false");
});
