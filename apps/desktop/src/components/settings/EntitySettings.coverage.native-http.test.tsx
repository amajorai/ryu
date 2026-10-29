// biome-ignore-all lint/suspicious/noMisplacedAssertion: the shared teardown asserts every case left no undeclared Core request.
// EntitySettings mounted the way SettingsDialog mounts it: the real
// `useScopedSettingsNav` (contributions + app roster) picks the entity, the
// real `useApps` drives "Turn on", and every read and write reaches a
// loopback Core peer. Nothing in the settings, lifecycle or routing path is
// replaced.
import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import {
	button,
	type CorePeer,
	click,
	fill,
	flush,
	installAnimationApis,
	maybeButton,
	type PeerCall,
	registerDomWithNativeNetworking,
	startCorePeer,
	text,
	until,
} from "./models-plugins-settings.test-support.ts";

registerDomWithNativeNetworking();
installAnimationApis();
setDefaultTimeout(30_000);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClientProvider } = await import("@tanstack/react-query");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { queryClient } = await import("@/src/lib/query-client.ts");
const { EntitlementProvider } = await import(
	"@/src/contexts/entitlement-context.tsx"
);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { useActiveNode } = await import("@/src/hooks/useActiveNode.ts");
const { useScopedSettingsNav } = await import(
	"@/src/hooks/useScopedSettingsNav.ts"
);
const { toTarget } = await import("@/src/lib/api/client.ts");
const { EntitySettings } = await import("./EntitySettings.tsx");
const { TabsContext } = await import("@/src/contexts/TabsContext.tsx");
const { I18nProvider } = await import("@ryu/i18n/react");
const { SkillDistributionProvider } = await import(
	"@/src/components/skills/SkillDistributionProvider.tsx"
);

type TabsContextValue = NonNullable<
	Parameters<typeof TabsContext.Provider>[0]["value"]
>;
// The app shell's tab state, empty: a settings dialog is not inside a tab.
const NO_TABS = { tabs: [], activeTabId: null } as unknown as TabsContextValue;

const TOKEN = "entity-settings-token";
const USER_JWT = "entity-settings-user";
const NOTES = "com.fixture.notes";
const initialNodeState = useNodeStore.getState();

interface CoreApp {
	enabled: boolean;
	id: string;
	name: string;
}

interface CoreState {
	apps: Map<string, CoreApp>;
	companions: Record<string, unknown>[];
	enableReplies: { body: unknown; status: number }[];
	preferences: Map<string, string>;
	tabs: Record<string, unknown>[];
}

let core: CoreState;
let peer: CorePeer;
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement;

function wire(app: CoreApp) {
	return {
		id: app.id,
		name: app.name,
		version: "1.0.0",
		built_in: false,
		enabled: app.enabled,
		installed: true,
		installed_version: "1.0.0",
		local_only: false,
		windows_first: false,
		permission_grants: [],
		runnables: [],
		sidecar_name: null,
	};
}

function record(app: CoreApp) {
	return {
		id: app.id,
		enabled: app.enabled,
		version: "1.0.0",
		approved_grants: [],
		created_at: null,
		updated_at: null,
	};
}

/** Core's `settings_tabs` projection: tabs carry the owning app's enabled bit. */
function settingsTabs() {
	return core.tabs.map((tab) => {
		const app = core.apps.get(String(tab.plugin));
		return app && !app.enabled ? { ...tab, app_enabled: false } : tab;
	});
}

function route(call: PeerCall) {
	if (call.authorization !== `Bearer ${TOKEN}`) {
		return { status: 401, body: { error: "unauthorized" } };
	}
	if (call.method === "POST" && call.path === "/api/ws/ticket") {
		// No realtime transport on this peer; the hooks keep their poll path.
		return { status: 503, body: { error: "realtime unavailable" } };
	}
	if (call.method === "GET" && call.path === "/api/plugins/contributions") {
		return {
			body: { settings_tabs: settingsTabs(), companions: core.companions },
		};
	}
	if (call.method === "GET" && call.path === "/api/plugins") {
		return { body: { apps: [...core.apps.values()].map(wire) } };
	}
	const enable = /^\/api\/plugins\/(.+)\/enable$/.exec(call.path);
	if (call.method === "POST" && enable) {
		const app = core.apps.get(enable[1]);
		const reply = core.enableReplies.shift() ?? { status: 200, body: null };
		if (!app || reply.status !== 200) {
			return reply;
		}
		app.enabled = true;
		return { body: { app: record(app) } };
	}
	if (call.path.startsWith("/api/preferences/")) {
		const key = call.path.slice("/api/preferences/".length);
		if (call.method === "GET") {
			const value = core.preferences.get(key);
			return value === undefined
				? { status: 404, body: { error: "preference_not_found" } }
				: { body: { key, value } };
		}
		if (call.method === "PUT") {
			const value = (call.body as { value?: unknown } | null)?.value;
			core.preferences.set(key, String(value));
			return { body: { key, value } };
		}
	}
	if (call.method === "GET" && call.path === "/api/agents") {
		return { body: { agents: [] } };
	}
	// The companion host asks for the owning app's UI bundle; this fixture app
	// ships none, which the host reports in place.
	if (
		call.method === "GET" &&
		/^\/api\/plugins\/.+\/ui-bundle$/.test(call.path)
	) {
		return { status: 404, body: { error: "no ui bundle" } };
	}
	// What the first-party PredictSettings view reads when it is admitted.
	if (call.method === "GET" && call.path === "/api/predict/config") {
		return {
			body: {
				model: "",
				effort: "",
				appAllowlist: ["Notes"],
				debounceMs: 400,
				maxChars: 240,
			},
		};
	}
	if (call.method === "GET" && call.path === "/api/engines") {
		return { body: { engines: [] } };
	}
	if (call.method === "GET" && call.path === "/api/engine/active") {
		return { body: { active: "pi", available: ["pi"], running: true } };
	}
	if (call.method === "GET" && call.path === "/api/pi-config/catalog") {
		return { body: { apiTypes: [], providers: [], thinkingLevels: [] } };
	}
	return;
}

function SettingsHost({ entityId }: { entityId: string }) {
	const nav = useScopedSettingsNav("user");
	const target = toTarget(useActiveNode());
	const entity = [...nav.apps, ...nav.plugins].find(
		(candidate) => candidate.id === entityId
	);
	if (!entity) {
		return <p>Entity not listed</p>;
	}
	return <EntitySettings entity={entity} target={target} />;
}

/** `entitled` adds the app shell's EntitlementProvider, which first-party
 *  views such as PredictSettings read through `useAgents`. */
async function mount(entityId: string, entitled = false) {
	root = createRoot(container);
	const host = (
		<I18nProvider autoLocalizeDom={false}>
			<TabsContext.Provider value={NO_TABS}>
				<SkillDistributionProvider>
					<SettingsHost entityId={entityId} />
				</SkillDistributionProvider>
			</TabsContext.Provider>
		</I18nProvider>
	);
	await act(async () =>
		root?.render(
			<QueryClientProvider client={queryClient}>
				{entitled ? <EntitlementProvider>{host}</EntitlementProvider> : host}
				<Toaster />
			</QueryClientProvider>
		)
	);
	await flush();
}

function lifecycleCalls() {
	return peer.calls.filter(
		(call) =>
			call.method === "POST" &&
			/^\/api\/plugins\/.+\/(enable|disable)$/.test(call.path)
	);
}

function alertText(): string {
	return [...container.querySelectorAll('[role="alert"]')]
		.map((alert) => alert.textContent ?? "")
		.join(" | ");
}

beforeEach(() => {
	core = {
		apps: new Map([[NOTES, { id: NOTES, name: "Notes", enabled: false }]]),
		companions: [],
		enableReplies: [],
		preferences: new Map([["notes.folder", "Inbox"]]),
		tabs: [
			{
				plugin: NOTES,
				id: "notes.fields",
				title: "Notes fields",
				scope: "user",
				fields: [
					{ pref_key: "notes.folder", type: "text", label: "Notes folder" },
				],
			},
			{
				plugin: NOTES,
				id: "notes.mcp",
				title: "Notes tools",
				scope: "user",
				fields: [],
				mcpSettings: {
					readTool: `${NOTES}.settings.read`,
					updateTool: `${NOTES}.settings.update`,
				},
			},
		],
	};
	peer = startCorePeer(route);
	queryClient.clear();
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: "entity-settings-coverage",
		nodes: [
			{
				name: "entity-settings-coverage",
				token: TOKEN,
				url: peer.url,
				userJwt: USER_JWT,
			},
		],
		tabOverrides: {},
	});
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	container.remove();
	document.body.replaceChildren();
	queryClient.clear();
	useNodeStore.setState(initialNodeState, true);
	peer.stop();
	expect(peer.unexpected).toEqual([]);
});

afterAll(() => {
	useNodeStore.setState(initialNodeState, true);
});

test("Turn on enables a disabled app through Core; a refused enable keeps the notice with Core's reason and a retry brings the app's tool settings in", async () => {
	// Core's 409 names ids only; the hook re-renders it with roster names.
	core.apps.set("com.fixture.files", {
		id: "com.fixture.files",
		name: "Files",
		enabled: false,
	});
	core.enableReplies.push({
		status: 409,
		body: {
			error: "dependency refused",
			dependency_error: {
				code: "missing_dependency",
				plugin: NOTES,
				dependency: "com.fixture.files",
				required: null,
			},
		},
	});
	await mount(NOTES);
	await until(
		() => text().includes("Notes is turned off"),
		"disabled notice for the installed app"
	);
	// Off means: stated outright, declarative settings still editable, but the
	// app's own (MCP) settings panel is not offered.
	expect(text()).toContain(
		"You can set it up now. What you save here is kept and takes effect as soon as you turn it on."
	);
	expect(text()).not.toContain("Agent for plugin access");
	const folder = container.querySelector<HTMLInputElement>(
		'input[aria-label="Notes folder"]'
	);
	await until(() => folder?.value === "Inbox", "saved folder read from Core");

	await click(button("Turn on"));
	await until(
		() => alertText().includes("Notes needs Files. Install it first."),
		"Core's refusal reason"
	);
	expect(text()).toContain("Notes is turned off");
	expect(maybeButton("Turn on")?.disabled).toBe(false);
	expect(core.apps.get(NOTES)?.enabled).toBe(false);

	await click(button("Turn on"));
	await until(
		() => !text().includes("Notes is turned off"),
		"notice retired once Core reports the app enabled"
	);
	await until(
		() => text().includes("Agent for plugin access"),
		"MCP settings panel for the enabled app"
	);
	expect(alertText()).not.toContain("Notes needs Files");
	expect(core.apps.get(NOTES)?.enabled).toBe(true);
	expect(
		lifecycleCalls().map((call) => [
			call.method,
			call.path,
			call.authorization,
			call.userJwt,
		])
	).toEqual([
		["POST", `/api/plugins/${NOTES}/enable`, `Bearer ${TOKEN}`, USER_JWT],
		["POST", `/api/plugins/${NOTES}/enable`, `Bearer ${TOKEN}`, USER_JWT],
	]);
	// The declarative field kept its saved value across the enable.
	expect(
		container.querySelector<HTMLInputElement>(
			'input[aria-label="Notes folder"]'
		)?.value
	).toBe("Inbox");
});

test("settings saved while the app is off reach Core's preference store and survive an independent remount", async () => {
	await mount(NOTES);
	const folder = () =>
		container.querySelector<HTMLInputElement>(
			'input[aria-label="Notes folder"]'
		);
	await until(() => folder()?.value === "Inbox", "saved folder read from Core");
	expect(text()).toContain("Notes is turned off");
	const input = folder();
	if (!input) {
		throw new Error("Missing Notes folder input");
	}
	await fill(input, "  Archive  ");
	await act(async () => input.blur());
	await until(
		() => core.preferences.get("notes.folder") === "Archive",
		"trimmed value written to Core"
	);
	expect(
		peer.calls
			.filter((call) => call.method === "PUT")
			.map((call) => [call.path, call.body])
	).toEqual([["/api/preferences/notes.folder", { value: "Archive" }]]);
	expect(lifecycleCalls()).toEqual([]);
	expect(core.apps.get(NOTES)?.enabled).toBe(false);

	await act(async () => root?.unmount());
	queryClient.clear();
	await mount(NOTES);
	await until(() => folder()?.value === "Archive", "remount reads Core again");
	expect(text()).toContain("Notes is turned off");
});

test("a third-party app naming a first-party view gets its declared fields, while the built-in owner of that view gets the first-party component", async () => {
	core.apps.set("com.thirdparty.predictor", {
		id: "com.thirdparty.predictor",
		name: "Predictor",
		enabled: true,
	});
	core.tabs = [
		{
			plugin: "com.thirdparty.predictor",
			id: "predictor.settings",
			title: "Predictor",
			scope: "user",
			view: "predict",
			fields: [
				{ pref_key: "predictor.style", type: "text", label: "Predictor style" },
			],
		},
	];
	await mount("com.thirdparty.predictor", true);
	await until(
		() =>
			container.querySelector('input[aria-label="Predictor style"]') !== null,
		"third-party fields fallback"
	);
	await flush();
	// PredictSettings' own rows never mount for a borrowed view name.
	expect(text()).not.toContain("Autocomplete (everywhere)");
	expect(text()).not.toContain("In-editor autocomplete");
	// PredictSettings never mounted, so its config was never read.
	expect(peer.calls.some((call) => call.path === "/api/predict/config")).toBe(
		false
	);

	// The id-keyed binding admits the built-in owner of the same view name.
	await act(async () => root?.unmount());
	core.apps.set("predict", { id: "predict", name: "Predict", enabled: true });
	core.tabs = [
		{
			plugin: "predict",
			id: "predict.settings",
			title: "Predict",
			scope: "user",
			view: "predict",
			fields: [],
		},
	];
	queryClient.clear();
	await mount("predict", true);
	await until(
		() => text().includes("Autocomplete (everywhere)"),
		"first-party PredictSettings for its built-in owner"
	);
	expect(container.querySelector('input[aria-label="Predictor style"]')).toBe(
		null
	);
	expect(
		peer.calls.filter((call) => call.path === "/api/predict/config")
	).toHaveLength(1);
});

test("an app's own companion settings UI mounts only while it is on, and a tab naming another app's companion never mounts it", async () => {
	core.companions = [
		{
			id: "app__notes-panel",
			name: "notes-panel",
			label: "Notes panel",
			plugin_id: NOTES,
			has_ui: true,
			approved_grants: [],
			default_csp_enforced: true,
		},
	];
	core.apps.set("com.thirdparty.spy", {
		id: "com.thirdparty.spy",
		name: "Spy",
		enabled: true,
	});
	core.tabs = [
		{
			plugin: NOTES,
			id: "notes.ui",
			title: "Notes panel settings",
			scope: "user",
			companion: "notes-panel",
			fields: [],
		},
		{
			plugin: "com.thirdparty.spy",
			id: "spy.ui",
			title: "Spy panel settings",
			scope: "user",
			companion: "notes-panel",
			fields: [{ pref_key: "spy.mode", type: "text", label: "Spy mode" }],
		},
	];
	const bundleReads = () =>
		peer.calls.filter((call) => call.path.endsWith("/ui-bundle"));
	await mount(NOTES);
	await until(
		() => text().includes("Notes is turned off"),
		"disabled notice for the companion app"
	);
	expect(text()).not.toContain("Notes panel settings");
	expect(bundleReads()).toEqual([]);

	await click(button("Turn on"));
	await until(
		() => text().includes("Notes panel settings"),
		"owned companion section once enabled"
	);
	// The companion host mounted for Notes and asked Core for Notes' own UI.
	await until(() => bundleReads().length > 0, "companion UI bundle read");
	expect(new Set(bundleReads().map((call) => call.path))).toEqual(
		new Set([`/api/plugins/${NOTES}/ui-bundle`])
	);
	await until(
		() => text().includes("Notes panel has nothing to show here"),
		"companion host reported the missing bundle in place"
	);

	// Another app pointing its settings tab at Notes' companion gets its own
	// declarative fields only.
	const readsBeforeSpy = bundleReads().length;
	await act(async () => root?.unmount());
	queryClient.clear();
	await mount("com.thirdparty.spy");
	await until(
		() => container.querySelector('input[aria-label="Spy mode"]') !== null,
		"third-party fields"
	);
	await flush();
	expect(text()).not.toContain("Spy panel settings");
	// No further bundle read: the borrowed companion never mounted.
	expect(bundleReads()).toHaveLength(readsBeforeSpy);
});
