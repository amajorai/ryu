// Guard for the node settings dialog's computer scope: every section the
// dialog renders must read from and write to the dialog's chosen computer (B),
// never the app-wide default (A), even though nothing but the surrounding
// NodeScopeProvider says which computer that is. A real loopback server answers
// both computers on separate path prefixes with distinct bearers, so a section
// that still resolves the node from the store shows up as an A-prefixed call.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";

const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
const previousCoreUrl = process.env.VITE_CORE_URL;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
// The status poller hands `AbortSignal.any(...)` to the native fetch, which
// only accepts the runtime's own signals, not happy-dom's.
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

interface Call {
	authorization: string | null;
	jwt: string | null;
	method: string;
	path: string;
	slot: string;
}
let calls: Call[] = [];
const egress: string[] = [];
// Requests sent to the loopback server whose responses have not arrived yet.
// The server records a call when it handles the request, so a read a previous
// mount started can land after `calls` was reset unless the test drains first.
let inFlight = 0;
// Preflight's best-effort probe of the device-local Island companion. It is
// this machine's loopback by design, not a computer the dialog can scope.
const ISLAND_CONTROL_URL = "http://127.0.0.1:7989/control";

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const url = new URL(request.url);
		const [, slot = ""] = url.pathname.split("/");
		calls.push({
			slot,
			method: request.method,
			path: url.pathname.slice(slot.length + 1),
			authorization: request.headers.get("authorization"),
			jwt: request.headers.get("x-ryu-user-jwt"),
		});
		// Shapes are irrelevant to routing. Unset preferences answer 404 (the
		// shipping "use the default" path); the detection configs answer the
		// minimal shape their validated clients require; everything else gets an
		// empty object.
		if (
			request.method === "GET" &&
			url.pathname.includes("/api/preferences/")
		) {
			return NativeResponse.json({ error: "unset" }, { status: 404 });
		}
		if (url.pathname.endsWith("/api/meetings/detection-config")) {
			return NativeResponse.json({ apps: [], enabled: true });
		}
		if (url.pathname.endsWith("/api/quests/detection-config")) {
			return NativeResponse.json({
				effort: "",
				interval: "2m",
				mode: "suggest",
				model: "",
			});
		}
		return NativeResponse.json({});
	},
});
// The device-local Core (Shadow capture, which is pinned to this computer on
// purpose) lives on its own prefix so it is never confused with A or B.
process.env.VITE_CORE_URL = `${server.url.origin}/LOCAL`;

// Keep the proof hermetic: only the loopback server may be reached.
globalThis.fetch = Object.assign(
	(...args: Parameters<typeof nativeFetch>) => {
		const input = args[0];
		const href =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		if (new URL(href).origin !== server.url.origin) {
			egress.push(href);
			return Promise.reject(new Error("Unowned egress"));
		}
		inFlight += 1;
		return nativeFetch(...args).finally(() => {
			inFlight -= 1;
		});
	},
	{ preconnect: nativeFetch.preconnect }
);

const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { MemoryRouter } = await import("react-router-dom");
const { EntitlementProvider } = await import(
	"@/src/contexts/entitlement-context.tsx"
);
const { NodeScopeProvider } = await import(
	"@/src/contexts/NodeScopeContext.tsx"
);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { useGatewayStatus } = await import("@/src/hooks/useGatewayStatus.ts");
const { usePluginSettingsTabs } = await import(
	"@/src/hooks/usePluginSettingsTabs.ts"
);
const { IslandSettings } = await import(
	"@/src/components/settings/IslandSettings.tsx"
);
const { DictationSettings } = await import(
	"@/src/components/settings/DictationSettings.tsx"
);
const { MeetingsSettings } = await import(
	"@/src/components/settings/MeetingsSettings.tsx"
);
const { QuestsSettings } = await import(
	"@/src/components/settings/QuestsSettings.tsx"
);
const { IntegrationsTab } = await import(
	"@/src/components/settings/IntegrationsTab.tsx"
);
const { ManagedInferenceSettings, NetworkSettings } = await import(
	"@/src/components/settings/NetworkSettings.tsx"
);
const { EmailAlertsSettings } = await import(
	"@/src/components/settings/EmailAlertsSettings.tsx"
);
const { ConnectDeviceQR } = await import(
	"@/src/components/devices/ConnectDeviceQR.tsx"
);
const { PreflightPage } = await import("@/src/pages/PreflightPage.tsx");

const initialStore = useNodeStore.getState();
const nodeA = {
	name: "a",
	url: `${server.url.origin}/A`,
	token: "token-A",
	userJwt: "jwt-A",
};
const nodeB = {
	name: "b",
	url: `${server.url.origin}/B`,
	token: "token-B",
	userJwt: "jwt-B",
};

let container: HTMLDivElement;
let root: Root | null = null;
let client: InstanceType<typeof QueryClient>;

beforeEach(() => {
	calls = [];
	localStorage.clear();
	useNodeStore.setState({
		nodes: [nodeA, nodeB],
		defaultNode: "a",
		autoSelect: false,
		autoSelectedNode: null,
		tabOverrides: {},
	});
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(async () => {
	await unmountAndDrain();
	client.clear();
	container.remove();
	useNodeStore.setState(initialStore, true);
});

afterAll(() => {
	globalThis.fetch = nativeFetch;
	if (previousCoreUrl === undefined) {
		Reflect.deleteProperty(process.env, "VITE_CORE_URL");
	} else {
		process.env.VITE_CORE_URL = previousCoreUrl;
	}
	server.stop(true);
});

async function settle(ms = 150) {
	await act(async () => {
		await new Promise<void>((resolve) => setTimeout(resolve, ms));
	});
}

// The entitlement mirror (EntitlementProvider -> useEntitlement) is an app-wide
// provider mounted above the dialog, so it writes to the app-wide computer by
// design and is not a section call.
const APP_WIDE_PATHS = new Set([
	"/api/preferences/entitlement-active",
	"/api/preferences/managed-inference-entitled",
]);

/**
 * Unmount, then wait for every read the mount already started (running query
 * functions and requests on the wire) to reach the server, so none of them is
 * recorded against the next mount.
 */
async function unmountAndDrain() {
	await act(async () => {
		root?.unmount();
		root = null;
	});
	const deadline = Date.now() + 3000;
	while ((inFlight > 0 || client.isFetching() > 0) && Date.now() < deadline) {
		await settle(20);
	}
}

/** Calls made by the section under test (not device-local, not app-wide). */
function sectionCalls(): Call[] {
	return calls.filter(
		(call) => call.slot !== "LOCAL" && !APP_WIDE_PATHS.has(call.path)
	);
}

/** Wait until the section has made its first requests, then let it settle. */
async function untilCalls(minimum = 1) {
	const deadline = Date.now() + 3000;
	while (sectionCalls().length < minimum && Date.now() < deadline) {
		await settle(20);
	}
	await settle();
}

async function mount(ui: ReactNode, scope: string | undefined) {
	root = createRoot(container);
	await act(async () => {
		root?.render(
			<QueryClientProvider client={client}>
				<EntitlementProvider>
					<MemoryRouter>
						<NodeScopeProvider nodeName={scope}>{ui}</NodeScopeProvider>
					</MemoryRouter>
				</EntitlementProvider>
			</QueryClientProvider>
		);
	});
	await untilCalls();
}

function mountScoped(ui: ReactNode) {
	return mount(ui, "b");
}

/**
 * Why the section calls so far are not "only B": a call to another computer, a
 * credential that is not B's (health probes are unauthenticated, which is
 * fine), no authenticated B call at all, or egress off the loopback server.
 */
function scopeViolations(): string[] {
	const remote = sectionCalls();
	const problems = remote
		.filter(
			(call) =>
				call.slot !== "B" ||
				(call.authorization !== null &&
					call.authorization !== "Bearer token-B") ||
				(call.jwt !== null && call.jwt !== "jwt-B")
		)
		.map(
			(call) =>
				`${call.method} /${call.slot}${call.path} as ${call.authorization} / ${call.jwt}`
		);
	if (!remote.some((call) => call.authorization === "Bearer token-B")) {
		problems.push("no authenticated call reached B");
	}
	for (const href of egress) {
		if (href !== ISLAND_CONTROL_URL) {
			problems.push(`egress ${href}`);
		}
	}
	return problems;
}

/** Section writes (non-GET) made since `from`. */
function writesSince(from: number): Call[] {
	return calls
		.slice(from)
		.filter(
			(call) =>
				call.method !== "GET" &&
				call.slot !== "LOCAL" &&
				!APP_WIDE_PATHS.has(call.path)
		);
}

/** Flip switches in order until one of them writes to a computer. */
async function flipUntilWrite(): Promise<Call[]> {
	const from = calls.length;
	const toggles = [
		...container.querySelectorAll<HTMLElement>('[role="switch"]'),
	];
	for (const toggle of toggles) {
		await act(async () => {
			toggle.click();
		});
		await settle(60);
		if (writesSince(from).length > 0) {
			break;
		}
	}
	return writesSince(from);
}

/** Edit a text field and blur it, as the shipping save-on-blur fields expect. */
async function editAndBlur(selector: string, value: string): Promise<Call[]> {
	const input = container.querySelector<HTMLInputElement>(selector);
	if (!input) {
		throw new Error(`Missing field ${selector}`);
	}
	const from = calls.length;
	await act(async () => {
		input.focus();
		const setValue = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set;
		setValue?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await act(async () => {
		input.blur();
	});
	await settle();
	return writesSince(from);
}

test("overview status polls the scoped computer", async () => {
	function Status() {
		useGatewayStatus(true);
		return null;
	}
	await mountScoped(<Status />);
	expect(scopeViolations()).toEqual([]);
	expect(calls.some((call) => call.path.startsWith("/api/"))).toBe(true);
});

test("plugin settings tabs load from the scoped computer", async () => {
	function Tabs() {
		usePluginSettingsTabs();
		return null;
	}
	await mountScoped(<Tabs />);
	expect(scopeViolations()).toEqual([]);
});

test("Island settings read and write the scoped computer", async () => {
	await mountScoped(<IslandSettings />);
	expect(scopeViolations()).toEqual([]);
	const writes = await flipUntilWrite();
	expect(writes.length).toBeGreaterThan(0);
	expect(scopeViolations()).toEqual([]);
});

test("Dictation settings read and write the scoped computer", async () => {
	await mountScoped(<DictationSettings />);
	expect(scopeViolations()).toEqual([]);
	const writes = await flipUntilWrite();
	expect(writes.length).toBeGreaterThan(0);
	expect(scopeViolations()).toEqual([]);
});

test("Meetings settings read and write the scoped computer", async () => {
	await mountScoped(<MeetingsSettings />);
	expect(scopeViolations()).toEqual([]);
	const writes = await flipUntilWrite();
	expect(writes.length).toBeGreaterThan(0);
	expect(scopeViolations()).toEqual([]);
});

test("Quests settings read and write the scoped computer", async () => {
	await mountScoped(<QuestsSettings />);
	expect(scopeViolations()).toEqual([]);
	const writes = await editAndBlur("#quest-model", "judge-model");
	expect(writes.length).toBeGreaterThan(0);
	expect(scopeViolations()).toEqual([]);
});

test("Integrations read and write the scoped computer", async () => {
	await mountScoped(<IntegrationsTab />);
	expect(scopeViolations()).toEqual([]);
	const writes = await flipUntilWrite();
	expect(writes.length).toBeGreaterThan(0);
	expect(scopeViolations()).toEqual([]);
});

test("Network and managed inference read from the scoped computer", async () => {
	await mountScoped(
		<>
			<NetworkSettings />
			<ManagedInferenceSettings />
		</>
	);
	expect(scopeViolations()).toEqual([]);
});

test("Email alerts read from the scoped computer", async () => {
	await mountScoped(<EmailAlertsSettings />);
	expect(scopeViolations()).toEqual([]);
});

test("the connect-device QR carries the scoped computer", async () => {
	await mountScoped(<ConnectDeviceQR />);
	const address = container.querySelector<HTMLInputElement>(
		"#connect-device-address"
	);
	expect(address?.value).toBe(nodeB.url);
	expect(container.textContent).toContain("connect B");
});

test("Preflight health reads from the scoped computer", async () => {
	await mountScoped(<PreflightPage embedded />);
	expect(scopeViolations()).toEqual([]);
});

// SettingsDialog has no NodeScopeProvider: the shared views must keep talking to
// the app-wide default and follow it when it changes, exactly as before.
for (const [name, View] of [
	["Island", IslandSettings],
	["Dictation", DictationSettings],
	["Meetings", MeetingsSettings],
	["Quests", QuestsSettings],
] as const) {
	test(`${name} without a scope follows the app-wide default`, async () => {
		await mount(<View />, undefined);
		const first = sectionCalls();
		expect(first.length).toBeGreaterThan(0);
		expect(first.every((call) => call.slot === "A")).toBe(true);
		await unmountAndDrain();
		calls = [];
		useNodeStore.setState({ defaultNode: "b" });
		await mount(<View />, undefined);
		expect(scopeViolations()).toEqual([]);
	});
}
