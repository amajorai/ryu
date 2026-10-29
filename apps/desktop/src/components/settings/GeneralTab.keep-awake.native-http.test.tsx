// biome-ignore-all lint/suspicious/noMisplacedAssertion: the shared teardown asserts every case left no undeclared Core request.
// General settings against a loopback Core peer and a recording native bridge:
// "Prevent sleep while running" writes the Gateway ACP policy without resetting
// its other fields, hardware acceleration goes through the native command and
// asks for a restart only when the saved choice differs from the running one,
// and "Reset onboarding" clears the first-run and theme keys and routes back to
// onboarding.
import {
	afterEach,
	beforeEach,
	expect,
	mock,
	setDefaultTimeout,
	test,
} from "bun:test";
import {
	button,
	type CorePeer,
	click,
	installAnimationApis,
	type PeerCall,
	registerDomWithNativeNetworking,
	startCorePeer,
	text,
	until,
} from "./models-plugins-settings.test-support.ts";

registerDomWithNativeNetworking();
installAnimationApis();
setDefaultTimeout(30_000);

interface HardwareStatus {
	active: boolean;
	enabled: boolean;
	supported: boolean;
}
let hardware: HardwareStatus;
const nativeCalls: { args: unknown; command: string }[] = [];
let relaunches = 0;
const realCore = await import("@tauri-apps/api/core");
mock.module("@tauri-apps/api/core", () => ({
	...realCore,
	invoke: (command: string, args?: { enabled?: boolean }) => {
		nativeCalls.push({ args: args ?? null, command });
		if (command === "get_hardware_acceleration") {
			return Promise.resolve({ ...hardware });
		}
		if (command === "set_hardware_acceleration") {
			hardware = { ...hardware, enabled: Boolean(args?.enabled) };
			return Promise.resolve(null);
		}
		return Promise.resolve(null);
	},
}));
const realProcess = await import("@tauri-apps/plugin-process");
mock.module("@tauri-apps/plugin-process", () => ({
	...realProcess,
	relaunch: () => {
		relaunches += 1;
		return Promise.resolve();
	},
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { MemoryRouter, Route, Routes } = await import("react-router-dom");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { STORAGE_KEYS } = await import("@/src/lib/themes/presets.ts");
const { GeneralTab } = await import("./GeneralTab.tsx");

const TOKEN = "general-tab-token";
const initialNodeState = useNodeStore.getState();

interface AcpPolicy {
	idle_timeout_minutes: number;
	keep_computer_awake: boolean;
	max_parallel_agents: number | null;
}
let acp: AcpPolicy;
let peer: CorePeer;
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement;
let client: InstanceType<typeof QueryClient>;

function route(call: PeerCall) {
	if (call.path === "/api/gateway/config") {
		if (call.authorization !== `Bearer ${TOKEN}`) {
			return { status: 401, body: { error: "unauthorized" } };
		}
		if (call.method === "PUT") {
			acp = (call.body as { acp: AcpPolicy }).acp;
			return { body: { ok: true } };
		}
		return {
			body: {
				acp,
				auth: { api_keys: [], require_auth: false },
				providers: {
					anthropic: null,
					core: null,
					genai: { keys: [] },
					local: null,
					openai: null,
					openrouter: null,
				},
			},
		};
	}
	// Every other section of the tab reads node state this suite does not own.
	return { status: 404, body: { error: "not in this fixture" } };
}

function configWrites() {
	return peer.calls.filter(
		(call) => call.method === "PUT" && call.path === "/api/gateway/config"
	);
}

/** The rendered switch whose hidden form input carries `id` (Base UI). */
function findSwitch(id: string): HTMLElement | null {
	return (
		document
			.getElementById(id)
			?.parentElement?.querySelector<HTMLElement>('[role="switch"]') ?? null
	);
}

function switchById(id: string): HTMLElement {
	const control = findSwitch(id);
	if (!control) {
		throw new Error(`Missing switch ${id}: ${text()}`);
	}
	return control;
}

const isChecked = (control: HTMLElement) =>
	control.getAttribute("aria-checked") === "true" ||
	control.hasAttribute("data-checked");
const isDisabledSwitch = (control: HTMLElement) =>
	control.hasAttribute("disabled") ||
	control.getAttribute("aria-disabled") === "true" ||
	control.hasAttribute("data-disabled");

async function mount() {
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client}>
				<MemoryRouter initialEntries={["/settings"]}>
					<Routes>
						<Route element={<GeneralTab />} path="/settings" />
						<Route element={<p>Onboarding route</p>} path="/onboarding" />
					</Routes>
				</MemoryRouter>
			</QueryClientProvider>
		)
	);
}

async function openPage(title: string) {
	await until(() => text().includes(title), `${title} entry`);
	const entry = [...document.querySelectorAll<HTMLElement>("button, a")].find(
		(candidate) => candidate.textContent?.includes(title)
	);
	if (!entry) {
		throw new Error(`Missing ${title} entry: ${text()}`);
	}
	await click(entry);
}

beforeEach(() => {
	acp = {
		idle_timeout_minutes: 42,
		keep_computer_awake: true,
		max_parallel_agents: 3,
	};
	hardware = { active: true, enabled: true, supported: true };
	nativeCalls.length = 0;
	relaunches = 0;
	localStorage.clear();
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	peer = startCorePeer(route);
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: "general-tab",
		nodes: [
			{ name: "general-tab", token: TOKEN, url: peer.url, userJwt: null },
		],
		tabOverrides: {},
	});
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	client.clear();
	container.remove();
	document.body.replaceChildren();
	useNodeStore.setState(initialNodeState, true);
	peer.stop();
	localStorage.clear();
});

test("turning keep-awake off writes only that field and keeps the node's timeout and parallelism", async () => {
	await mount();
	await openPage("System & tray");
	await until(() => {
		const toggle = findSwitch("prevent-sleep-while-running-toggle");
		return toggle !== null && isChecked(toggle) && !isDisabledSwitch(toggle);
	}, "keep-awake loaded");
	await click(switchById("prevent-sleep-while-running-toggle"));
	await until(() => configWrites().length === 1, "policy saved");
	expect(configWrites()[0]?.body).toEqual({
		acp: {
			idle_timeout_minutes: 42,
			keep_computer_awake: false,
			max_parallel_agents: 3,
		},
	});
	// The re-read after the save shows what the node now holds.
	await until(
		() => !isChecked(switchById("prevent-sleep-while-running-toggle")),
		"switch reflects saved policy"
	);
	expect(acp.keep_computer_awake).toBe(false);
});

test("hardware acceleration saves through the native command and offers a restart until it applies", async () => {
	await mount();
	await openPage("System & tray");
	await until(() => {
		const toggle = findSwitch("hardware-acceleration-toggle");
		return toggle !== null && !isDisabledSwitch(toggle);
	}, "hardware status loaded");
	expect(text()).not.toContain("Restart now");
	await click(switchById("hardware-acceleration-toggle"));
	await until(
		() => text().includes("Restart Ryu to turn hardware acceleration off."),
		"restart prompt"
	);
	expect(nativeCalls).toContainEqual({
		args: { enabled: false },
		command: "set_hardware_acceleration",
	});
	await click(button("Restart now"));
	await until(() => relaunches === 1, "relaunch requested");
});

test("a pending re-enable says on, and an unsupported platform locks the switch", async () => {
	hardware = { active: false, enabled: true, supported: true };
	await mount();
	await openPage("System & tray");
	await until(
		() => text().includes("Restart Ryu to turn hardware acceleration on."),
		"pending on"
	);
	await act(async () => root?.unmount());
	client.clear();
	hardware = { active: true, enabled: true, supported: false };
	await mount();
	await openPage("System & tray");
	await until(() => text().includes("can't be turned off here"), "unsupported");
	expect(isDisabledSwitch(switchById("hardware-acceleration-toggle"))).toBe(
		true
	);
	expect(text()).not.toContain("Restart now");
});

test("reset onboarding clears the first-run and theme keys and routes to onboarding", async () => {
	const cleared = [
		"ryu_setup_seen",
		"ryu_default_agent",
		STORAGE_KEYS.lightPreset,
		STORAGE_KEYS.darkPreset,
		STORAGE_KEYS.uiFont,
		STORAGE_KEYS.chatWidth,
	];
	for (const key of cleared) {
		localStorage.setItem(key, "set");
	}
	localStorage.setItem("unrelated_preference", "kept");
	await mount();
	await openPage("Setup & recovery");
	await until(() => text().includes("Reset onboarding"), "setup page");
	await click(button("Reset onboarding"));
	await until(() => text().includes("Onboarding route"), "navigated");
	for (const key of cleared) {
		expect(localStorage.getItem(key)).toBeNull();
	}
	expect(localStorage.getItem("unrelated_preference")).toBe("kept");
});
