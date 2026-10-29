import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Mounts the shipping Safe Mode row against an owned native HTTP peer that
// plays two Cores: `local` (the desktop's own, addressed through VITE_CORE_URL
// exactly as a build would) and `remote`. Each peer keeps Core's split between
// the running process (`enabled`) and the next-boot preference, and only a
// restart moves the first to the second. The IPC bridge implements only the
// native commands the hook crosses: the desktop sentinel and the local Core
// process controls.
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

type Owner = "local" | "remote";
interface CoreState {
	enabled: boolean;
	forced: boolean;
	preference: boolean;
}
interface Call {
	body: unknown;
	method: string;
	owner: Owner | null;
	path: string;
	status: number;
}

const calls: Call[] = [];
const unknown: string[] = [];
const runtimeErrors: string[] = [];
const ipc: Array<{ args: unknown; command: string }> = [];
const cores: Record<Owner, CoreState> = {
	local: { enabled: false, forced: false, preference: false },
	remote: { enabled: false, forced: false, preference: false },
};
const refuseWrite = new Map<Owner, { error: string; status: number }>();
let sentinel = false;
let coreStatus = "running";
let pending = 0;

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
				path !== "/api/safe-mode" ||
				request.headers.get("authorization") !== `Bearer safe-${owner}-token`
			) {
				unknown.push(`${request.method} ${url.pathname}`);
				return reply({ error: "undeclared" }, 404);
			}
			const core = cores[owner];
			if (request.method === "PUT") {
				const refusal = refuseWrite.get(owner);
				if (refusal) {
					refuseWrite.delete(owner);
					return reply({ error: refusal.error }, refusal.status);
				}
				core.preference = (call.body as { enabled: boolean }).enabled;
				return reply({ restart_required: true });
			}
			return reply({
				enabled: core.enabled,
				preference_enabled: core.preference,
				source: core.forced ? "env" : core.enabled ? "preference" : "off",
				user_clearable: !core.forced,
				suppressed: {
					plugins: 3,
					skills: 12,
					mcp_servers: 2,
					kernel_plugins: 4,
				},
			});
		} finally {
			pending -= 1;
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
		invoke: async (command: string, args: unknown) => {
			ipc.push({ command, args: structuredClone(args ?? null) });
			if (command === "get_safe_mode_sentinel") {
				return sentinel;
			}
			if (command === "set_safe_mode_sentinel") {
				sentinel = (args as { enabled: boolean }).enabled;
				return null;
			}
			if (command === "stop_ryu_core") {
				coreStatus = "stopped";
				return null;
			}
			if (command === "start_ryu_core") {
				// The next boot of the desktop's own Core applies the saved choice.
				cores.local.enabled = cores.local.preference || sentinel;
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
const { toast } = await import("@ryu/ui/components/sileo.tsx");
const { useNodeStore, LOCAL_FALLBACK } = await import(
	"@/src/store/useNodeStore.ts"
);
const { SafeModeSettings } = await import("./SafeModeSettings.tsx");

const previousNodes = useNodeStore.getState();
let root: ReturnType<typeof createRoot> | null = null;
let errorToast: ReturnType<typeof spyOn<typeof toast, "error">>;
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
async function select(owner: Owner) {
	const node = {
		...LOCAL_FALLBACK,
		name: `safe-${owner}`,
		url: `${base}/${owner}`,
		token: `safe-${owner}-token`,
		userJwt: null,
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
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container, {
		onCaughtError: (error) => runtimeErrors.push(String(error)),
		onUncaughtError: (error) => runtimeErrors.push(String(error)),
		onRecoverableError: (error) => runtimeErrors.push(String(error)),
	});
	await act(async () => root?.render(createElement(SafeModeSettings)));
	await until(
		() => calls.some((call) => call.method === "GET" && call.status !== 0),
		"Safe Mode state was not read"
	);
	await idle();
}
async function unmount() {
	await act(async () => root?.unmount());
	root = null;
	document.body.replaceChildren();
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
function hasRow(title: string): boolean {
	return [...document.body.querySelectorAll('[data-slot="item-title"]')].some(
		(element) => element.textContent?.trim() === title
	);
}
function leaveButton(): HTMLButtonElement | undefined {
	return [...document.body.querySelectorAll("button")].find(
		(item) => item.textContent?.trim() === "Leave Safe Mode"
	);
}
function requireLeave(): HTMLButtonElement {
	const found = leaveButton();
	if (!found) {
		throw new Error("Back to a normal boot offers no Leave action");
	}
	return found;
}
function safeSwitch(): HTMLElement {
	const found = document.getElementById("safe-mode")?.previousElementSibling;
	if (!(found instanceof HTMLElement)) {
		throw new Error("Missing Safe Mode switch");
	}
	return found;
}
function writes(owner: Owner) {
	return calls
		.filter((call) => call.owner === owner && call.method === "PUT")
		.map((call) => [call.body, call.status]);
}

beforeEach(async () => {
	calls.length = 0;
	unknown.length = 0;
	runtimeErrors.length = 0;
	ipc.length = 0;
	refuseWrite.clear();
	sentinel = false;
	coreStatus = "running";
	cores.local = { enabled: true, forced: false, preference: true };
	cores.remote = { enabled: true, forced: false, preference: true };
	errorToast = spyOn(toast, "error");
	window.addEventListener("error", onError);
	window.addEventListener("unhandledrejection", onRejection);
	await select("remote");
});
afterEach(async () => {
	await unmount();
	await idle();
	errorToast.mockRestore();
	window.removeEventListener("error", onError);
	window.removeEventListener("unhandledrejection", onRejection);
	const violations = [
		pending === 0 ? null : `${pending} native exchanges still pending`,
		unknown.length === 0 ? null : `undeclared requests: ${unknown.join("; ")}`,
		runtimeErrors.length === 0
			? null
			: `runtime errors: ${runtimeErrors.join("; ")}`,
	].filter((violation) => violation !== null);
	if (violations.length > 0) {
		throw new Error(`Safe Mode case closure failed: ${violations.join(" | ")}`);
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

test("Back to a normal boot on a remote node saves the exit on that node only, says the node must restart, survives a remount, and disappears once the node has restarted", async () => {
	await mount();
	expect(captionFor("Back to a normal boot")).toBe(
		"4 core plugins kept running so chat and retrieval still work. Restart the remote node after saving to bring everything back."
	);
	expect(safeSwitch().getAttribute("aria-checked")).toBe("true");
	await act(async () => requireLeave().click());
	await until(
		() => writes("remote").length === 1,
		"Leaving did not reach the remote node"
	);
	await idle();
	expect(writes("remote")).toEqual([[{ enabled: false }, 200]]);
	expect(cores.remote.preference).toBe(false);
	// The running remote is still in Safe Mode until its operator restarts it.
	expect(requireLeave().disabled).toBe(true);
	expect(safeSwitch().getAttribute("aria-checked")).toBe("false");
	expect(captionFor("Safe Mode")).toContain(
		"Saved for this node. Restart the remote node to apply the change."
	);
	// The desktop never restarts its own Core or touches its sentinel for a
	// remote node.
	expect(ipc).toEqual([]);
	expect(writes("local")).toEqual([]);

	await unmount();
	await mount();
	expect(hasRow("Back to a normal boot")).toBe(true);
	expect(safeSwitch().getAttribute("aria-checked")).toBe("false");
	expect(captionFor("Safe Mode")).toContain("Saved for this node.");

	// The remote operator restarts the node; a fresh read shows a normal boot.
	cores.remote.enabled = cores.remote.preference;
	await unmount();
	await mount();
	expect(hasRow("Back to a normal boot")).toBe(false);
	expect(leaveButton()?.textContent).toBeUndefined();
	expect(captionFor("Safe Mode")).toContain(
		"Off. Turning it on would start the node without 3 apps, 12 skills and 2 MCP servers."
	);
});

test("a refused exit keeps the remote in Safe Mode with the reason shown and the action available for a real retry", async () => {
	refuseWrite.set("remote", {
		error: "Safe Mode store is read-only",
		status: 503,
	});
	await mount();
	await act(async () => requireLeave().click());
	await until(
		() => errorToast.mock.calls.length === 1,
		"The refused exit was not reported"
	);
	expect(errorToast).toHaveBeenCalledWith("Safe Mode store is read-only");
	expect(cores.remote.preference).toBe(true);
	expect(requireLeave().disabled).toBe(false);
	expect(safeSwitch().getAttribute("aria-checked")).toBe("true");
	await act(async () => requireLeave().click());
	await until(
		() => writes("remote").length === 2,
		"The retry did not reach the remote node"
	);
	await idle();
	expect(writes("remote")).toEqual([
		[{ enabled: false }, 503],
		[{ enabled: false }, 200],
	]);
	expect(cores.remote.preference).toBe(false);
	expect(ipc).toEqual([]);
});

test("Back to a normal boot on the local node saves through Core, restarts the desktop's own Core, and rereads a normal boot", async () => {
	await select("local");
	await mount();
	expect(captionFor("Back to a normal boot")).toBe(
		"4 core plugins kept running so chat and retrieval still work. Leaving restarts the node and brings everything back."
	);
	await act(async () => requireLeave().click());
	await until(
		() => !hasRow("Back to a normal boot"),
		"The local node did not come back in a normal boot",
		8000
	);
	expect(writes("local")).toEqual([[{ enabled: false }, 200]]);
	const order = ipc.map((entry) => entry.command);
	expect(order).toContain("stop_ryu_core");
	expect(order.indexOf("stop_ryu_core")).toBeLessThan(
		order.indexOf("start_ryu_core")
	);
	expect(cores.local.enabled).toBe(false);
	expect(safeSwitch().getAttribute("aria-checked")).toBe("false");
	expect(writes("remote")).toEqual([]);
}, 15_000);

test("an environment-forced node offers no way back from here", async () => {
	cores.remote = { enabled: true, forced: true, preference: false };
	await mount();
	expect(hasRow("Back to a normal boot")).toBe(false);
	expect(safeSwitch().getAttribute("aria-checked")).toBe("true");
	expect(safeSwitch().getAttribute("aria-disabled")).toBe("true");
	expect(captionFor("Safe Mode")).toContain(
		"forced on by the RYU_SAFE_MODE environment variable"
	);
	expect(writes("remote")).toEqual([]);
});
