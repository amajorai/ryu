import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import type { Root } from "react-dom/client";
import type { Node } from "@/src/store/useNodeStore.ts";
import { registerDomWithNativeNetworking } from "./unswept-a.test-support.ts";

// The REAL Settings → Ryu Apps tab, mounted in happy-dom inside the isolated
// QueryClient the settings dialog gives it, over the REAL useApps hook, plugin
// SDK and the REAL OAuthConnections section it embeds. Core is a loopback Bun
// server that keeps each app's lifecycle record durably for the test and
// enforces the node bearer and user JWT, so every enable/disable the tab sends
// is a real HTTP exchange whose acknowledged record the assertions read back.
setDefaultTimeout(20_000);
const NativeResponse = globalThis.Response;
const NativeRequest = globalThis.Request;
const nativeFetch = globalThis.fetch;
registerDomWithNativeNetworking();

let ownedOrigin: string | null = null;
const rejectedEgress: string[] = [];
const guardedFetch = Object.assign(
	(input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(new NativeRequest(input, init).url);
		if (url.origin !== ownedOrigin) {
			rejectedEgress.push(url.href);
			return Promise.reject(new Error("Ryu Apps coverage refuses egress"));
		}
		return nativeFetch(input, init);
	},
	{ preconnect: nativeFetch.preconnect }
);
globalThis.fetch = guardedFetch;
window.fetch = guardedFetch;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
const { queryClient: appQueryClient } = await import(
	"@/src/lib/query-client.ts"
);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { RyuAppsTab } = await import("./RyuAppsTab.tsx");
const {
	button,
	flush,
	installAnimationApis,
	isDisabled,
	maybeButton,
	text,
	until,
} = await import("./unswept-a.test-support.ts");
installAnimationApis();

// ── Native Core fixture ─────────────────────────────────────────────────────
const TOKEN = "ryu-apps-node-token";
const USER_JWT = "ryu-apps-user-jwt";
const MEETINGS = "com.ryu.meetings";
const BROWSER = "com.ryu.browser";
const SHELL = "com.ryu.shell";
const LINEAR = "com.example.linear";
const ABSENT = "com.example.not-installed";
const HEADLESS = "com.example.headless";

interface AppRow {
	approved: string[];
	builtIn: boolean;
	companion: string | null;
	enabled: boolean;
	grants: string[];
	id: string;
	installed: boolean;
	mandatory: boolean;
	name: string;
	oauth: Record<string, string>;
}

function seed(): Map<string, AppRow> {
	const rows: AppRow[] = [
		{
			approved: ["microphone.capture", "notes.write"],
			builtIn: false,
			companion: "Meetings",
			enabled: true,
			grants: ["microphone.capture", "notes.write"],
			id: MEETINGS,
			installed: true,
			mandatory: false,
			name: "Meetings",
			oauth: {},
		},
		{
			approved: [],
			builtIn: true,
			companion: null,
			enabled: true,
			grants: [],
			id: BROWSER,
			installed: true,
			mandatory: false,
			name: "Browser",
			oauth: {},
		},
		{
			approved: [],
			builtIn: true,
			companion: null,
			enabled: true,
			grants: [],
			id: SHELL,
			installed: true,
			mandatory: true,
			name: "Shell",
			oauth: {},
		},
		{
			approved: [],
			builtIn: false,
			companion: "Linear",
			enabled: false,
			grants: ["network.linear"],
			id: LINEAR,
			installed: true,
			mandatory: false,
			name: "Linear",
			oauth: { linear: "https://mcp.linear.example.test/sse" },
		},
		{
			approved: [],
			builtIn: false,
			companion: "Not installed",
			enabled: false,
			grants: [],
			id: ABSENT,
			installed: false,
			mandatory: false,
			name: "Not installed",
			oauth: {},
		},
		{
			approved: ["files.read"],
			builtIn: false,
			companion: null,
			enabled: true,
			grants: ["files.read"],
			id: HEADLESS,
			installed: true,
			mandatory: false,
			name: "Headless helper",
			oauth: {},
		},
	];
	return new Map(rows.map((row) => [row.id, row]));
}

function manifestWire(row: AppRow) {
	return {
		approved_grants: row.approved,
		built_in: row.builtIn,
		companion: row.companion ? { label: row.companion } : null,
		enabled: row.enabled,
		id: row.id,
		installed: row.installed,
		installed_version: row.installed ? "1.0.0" : null,
		local_only: false,
		mandatory: row.mandatory,
		mcp_servers: Object.fromEntries(
			Object.entries(row.oauth).map(([name, url]) => [
				name,
				{ auth: { client_id: "ryu-desktop", type: "oauth" }, url },
			])
		),
		name: row.name,
		permission_grants: row.grants,
		runnables: [],
		sidecar_name: null,
		version: "1.0.0",
		windows_first: false,
	};
}

interface Exchange {
	method: string;
	path: string;
	surface: string | null;
}
interface Armed {
	body: Record<string, unknown>;
	route: string;
	status: number;
}
let apps = seed();
let exchanges: Exchange[] = [];
let armed: Armed[] = [];
let held: { gate: Promise<void>; route: string } | null = null;
let unexpected: string[] = [];

function lifecycleRecord(row: AppRow) {
	return {
		approved_grants: row.approved,
		created_at: "2026-10-01T00:00:00.000Z",
		enabled: row.enabled,
		id: row.id,
		updated_at: "2026-10-12T00:00:00.000Z",
		version: "1.0.0",
	};
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const route = `${request.method} ${url.pathname}`;
		exchanges.push({
			method: request.method,
			path: url.pathname,
			surface: request.headers.get("x-ryu-surface"),
		});
		if (
			request.headers.get("authorization") !== `Bearer ${TOKEN}` ||
			request.headers.get("x-ryu-user-jwt") !== USER_JWT
		) {
			unexpected.push(`unauthenticated ${route}`);
			return NativeResponse.json({ error: "Unauthorized" }, { status: 401 });
		}
		if (held?.route === route) {
			await held.gate;
		}
		const refusal = armed.find((entry) => entry.route === route);
		if (refusal) {
			armed = armed.filter((entry) => entry !== refusal);
			return NativeResponse.json(refusal.body, { status: refusal.status });
		}
		if (route === "GET /api/plugins") {
			return NativeResponse.json({
				apps: [...apps.values()].map(manifestWire),
			});
		}
		const lifecycle = /^\/api\/plugins\/([^/]+)\/(enable|disable)$/.exec(
			url.pathname
		);
		if (request.method === "POST" && lifecycle) {
			const row = apps.get(decodeURIComponent(lifecycle[1] ?? ""));
			if (!row?.installed) {
				unexpected.push(route);
				return NativeResponse.json({ error: "not installed" }, { status: 404 });
			}
			const enable = lifecycle[2] === "enable";
			row.enabled = enable;
			row.approved = enable ? [...row.grants] : [];
			return NativeResponse.json({ app: lifecycleRecord(row) });
		}
		const auth = /^\/api\/plugins\/([^/]+)\/auth$/.exec(url.pathname);
		if (request.method === "GET" && auth) {
			const row = apps.get(decodeURIComponent(auth[1] ?? ""));
			return NativeResponse.json({
				servers: Object.entries(row?.oauth ?? {}).map(([name, resource]) => ({
					client_id: "ryu-desktop",
					connections: [],
					resource,
					server_name: name,
				})),
			});
		}
		if (route === "GET /api/identities") {
			return NativeResponse.json({ profiles: [] });
		}
		unexpected.push(route);
		return NativeResponse.json({ error: "Unknown route" }, { status: 404 });
	},
});
ownedOrigin = server.url.origin;
const node: Node = {
	name: "ryu-apps-node",
	token: TOKEN,
	url: server.url.origin,
	userJwt: USER_JWT,
};
const savedNodeState = useNodeStore.getState();

// ── Mounting ────────────────────────────────────────────────────────────────
let root: Root | null = null;

async function mount(): Promise<void> {
	// The settings dialog's own isolated client, as SettingsDialog creates it.
	const dialogClient = new QueryClient();
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<QueryClientProvider client={dialogClient}>
				<Toaster />
				<RyuAppsTab />
			</QueryClientProvider>
		)
	);
	await flush(2);
}

async function unmount(): Promise<void> {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	document.body.replaceChildren();
}

/** An independent read: drop every cached roster and mount a fresh tab. */
async function remount(): Promise<void> {
	await unmount();
	appQueryClient.clear();
	await mount();
	await until(() => !text().includes("Loading installed Ryu apps"), "roster");
}

/** The card block for one listed app, found by its displayed id. */
function appBlock(id: string): HTMLElement {
	const idLine = [...document.querySelectorAll("p.font-mono")].find(
		(line) => line.textContent === id
	);
	const block = idLine?.parentElement?.parentElement?.parentElement;
	if (!block) {
		throw new Error(`App ${id} is not listed: ${text()}`);
	}
	return block;
}

function blockText(id: string): string {
	return (appBlock(id).textContent ?? "").replace(/\s+/g, " ");
}

function badges(id: string): string[] {
	return [...appBlock(id).querySelectorAll('[data-slot="badge"]')].map(
		(badge) => badge.textContent ?? ""
	);
}

function listedIds(): string[] {
	return [...document.querySelectorAll("p.font-mono")].map(
		(line) => line.textContent ?? ""
	);
}

function oauthCard(appName: string): HTMLElement | null {
	return (
		[...document.querySelectorAll<HTMLElement>("article")].find(
			(card) => card.querySelector("p")?.textContent === appName
		) ?? null
	);
}

function lifecyclePosts(): string[] {
	return exchanges
		.filter((exchange) => exchange.method === "POST")
		.map((exchange) => exchange.path);
}

function rosterReads(): number {
	return exchanges.filter(
		(exchange) => exchange.method === "GET" && exchange.path === "/api/plugins"
	).length;
}

beforeEach(() => {
	apps = seed();
	exchanges = [];
	armed = [];
	held = null;
	unexpected = [];
	appQueryClient.clear();
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: node.name,
		localNodes: [],
		nodes: [node],
	});
});

afterEach(async () => {
	await unmount();
	sileo.clear();
	useNodeStore.setState(savedNodeState);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must keep to the owned Core contract.
	expect(unexpected).toEqual([]);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must refuse foreign egress.
	expect(rejectedEgress).toEqual([]);
});

afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
	window.fetch = nativeFetch;
});

// ── Cases ───────────────────────────────────────────────────────────────────
test("lists only installed companion or built-in apps with state, provenance, permissions and declared OAuth services", async () => {
	let release: () => void = () => undefined;
	held = {
		gate: new Promise<void>((resolve) => {
			release = resolve;
		}),
		route: "GET /api/plugins",
	};
	await mount();
	await until(
		() => text().includes("Loading installed Ryu apps"),
		"loading skeleton"
	);
	expect(listedIds()).toEqual([]);
	await until(
		() => exchanges.some((exchange) => exchange.path === "/api/plugins"),
		"roster request reached Core"
	);
	expect(text()).toContain("Loading installed Ryu apps");
	release();
	held = null;
	await until(() => listedIds().length > 0, "roster");

	// Core's order, minus the uninstalled app and the companion-less non-built-in.
	expect(listedIds()).toEqual([MEETINGS, BROWSER, SHELL, LINEAR]);
	expect(text()).not.toContain("Headless helper");
	expect(text()).not.toContain("Not installed");

	expect(badges(MEETINGS)).toEqual(["Enabled"]);
	expect(blockText(MEETINGS)).toContain(
		"Permissions: microphone.capture, notes.write"
	);
	expect(maybeButton("Disable", appBlock(MEETINGS)) !== null).toBe(true);

	expect(badges(BROWSER)).toEqual(["Enabled", "Built in"]);
	expect(blockText(BROWSER)).toContain("Permissions: None approved");

	// Mandatory: Core refuses to disable it, so no control is offered.
	expect(badges(SHELL)).toEqual(["Enabled", "Built in"]);
	expect(appBlock(SHELL).querySelectorAll("button")).toHaveLength(0);

	expect(badges(LINEAR)).toEqual(["Disabled"]);
	expect(blockText(LINEAR)).toContain("OAuth services declared: linear");
	expect(maybeButton("Enable", appBlock(LINEAR)) !== null).toBe(true);
	expect(blockText(MEETINGS)).not.toContain("OAuth services declared");

	// The embedded accounts section lists exactly the declared server.
	await until(() => oauthCard("Linear") !== null, "OAuth card");
	expect(text()).toContain("App and plugin accounts");
	expect(document.querySelectorAll("article")).toHaveLength(1);
	expect(oauthCard("Linear")?.textContent).toContain(
		"linear · https://mcp.linear.example.test/sse"
	);

	// The roster read was surface-scoped and authenticated (the fixture
	// refuses anything else).
	const read = exchanges.find((exchange) => exchange.path === "/api/plugins");
	expect(read?.surface).toBe("desktop");
	expect(lifecyclePosts()).toEqual([]);
});

test("Disable and Enable send the lifecycle request, render Core's acknowledged record, persist across an independent remount, and leave other apps untouched", async () => {
	await mount();
	await until(() => listedIds().length === 4, "roster");

	await act(async () => button("Disable", appBlock(MEETINGS)).click());
	await until(() => badges(MEETINGS)[0] === "Disabled", "disabled badge");
	expect(lifecyclePosts()).toEqual([`/api/plugins/${MEETINGS}/disable`]);
	expect(maybeButton("Enable", appBlock(MEETINGS)) !== null).toBe(true);
	// Core cleared the approved grants with the disable, and the tab shows it.
	await until(
		() => blockText(MEETINGS).includes("Permissions: None approved"),
		"grants cleared",
		3000
	);
	expect(apps.get(MEETINGS)?.enabled).toBe(false);
	// Unrelated records are conserved, in Core and on screen.
	expect(apps.get(BROWSER)?.enabled).toBe(true);
	expect(apps.get(LINEAR)?.enabled).toBe(false);
	expect(badges(BROWSER)).toEqual(["Enabled", "Built in"]);

	await remount();
	expect(badges(MEETINGS)).toEqual(["Disabled"]);
	expect(blockText(MEETINGS)).toContain("Permissions: None approved");

	// Enabling Linear also unlocks its OAuth card in the embedded section.
	await until(() => oauthCard("Linear") !== null, "OAuth card");
	expect(oauthCard("Linear")?.textContent).toContain("Enable to connect");
	expect(isDisabled(button("Connect", oauthCard("Linear") ?? document))).toBe(
		true
	);
	await act(async () => button("Enable", appBlock(LINEAR)).click());
	await until(() => badges(LINEAR)[0] === "Enabled", "Linear enabled");
	expect(lifecyclePosts().at(-1)).toBe(`/api/plugins/${LINEAR}/enable`);
	await until(
		() => !oauthCard("Linear")?.textContent?.includes("Enable to connect"),
		"OAuth card unlocked"
	);
	expect(isDisabled(button("Connect", oauthCard("Linear") ?? document))).toBe(
		false
	);
	expect(apps.get(LINEAR)?.enabled).toBe(true);
	expect(apps.get(MEETINGS)?.enabled).toBe(false);

	await remount();
	expect(badges(LINEAR)).toEqual(["Enabled"]);
	expect(blockText(LINEAR)).toContain("Permissions: network.linear");
	expect(badges(MEETINGS)).toEqual(["Disabled"]);
});

test("refused toggles roll back to Core's state and explain why, by display name, until the next success clears the message", async () => {
	await mount();
	await until(() => listedIds().length === 4, "roster");

	armed = [
		{
			body: {
				dependency_error: {
					code: "blocked_by_dependents",
					dependents: [LINEAR],
					plugin: MEETINGS,
				},
				error: "blocked",
			},
			route: `POST /api/plugins/${MEETINGS}/disable`,
			status: 409,
		},
	];
	await act(async () => button("Disable", appBlock(MEETINGS)).click());
	await until(
		() =>
			text().includes("Meetings is needed by Linear. Disable Linear first."),
		"dependency refusal"
	);
	expect(badges(MEETINGS)).toEqual(["Enabled"]);
	expect(maybeButton("Disable", appBlock(MEETINGS)) !== null).toBe(true);
	expect(apps.get(MEETINGS)?.enabled).toBe(true);

	armed = [
		{
			body: { error: "gateway_unreachable", reason: "gateway offline" },
			route: `POST /api/plugins/${LINEAR}/enable`,
			status: 503,
		},
	];
	await act(async () => button("Enable", appBlock(LINEAR)).click());
	await until(
		() => text().includes("Gateway unreachable (fail-closed): gateway offline"),
		"gateway refusal"
	);
	expect(text()).not.toContain("Meetings is needed by Linear");
	expect(badges(LINEAR)).toEqual(["Disabled"]);
	expect(apps.get(LINEAR)?.enabled).toBe(false);

	// A success clears the banner.
	await act(async () => button("Disable", appBlock(BROWSER)).click());
	await until(() => badges(BROWSER)[0] === "Disabled", "browser disabled");
	expect(text()).not.toContain("Gateway unreachable");
	expect(apps.get(BROWSER)?.enabled).toBe(false);
	expect(lifecyclePosts()).toEqual([
		`/api/plugins/${MEETINGS}/disable`,
		`/api/plugins/${LINEAR}/enable`,
		`/api/plugins/${BROWSER}/disable`,
	]);
});

test("a Core acknowledgement for a different app is not reported as success and the roster is re-read", async () => {
	await mount();
	await until(() => listedIds().length === 4, "roster");
	const readsBefore = rosterReads();
	armed = [
		{
			body: { app: lifecycleRecord(apps.get(MEETINGS) as AppRow) },
			route: `POST /api/plugins/${LINEAR}/enable`,
			status: 200,
		},
	];
	await act(async () => button("Enable", appBlock(LINEAR)).click());
	await until(
		() =>
			text().includes(
				`Core confirmed a different app (${MEETINGS}); the app list was reloaded.`
			),
		"wrong-app refusal"
	);
	expect(rosterReads()).toBeGreaterThan(readsBefore);
	expect(badges(LINEAR)).toEqual(["Disabled"]);
	expect(badges(MEETINGS)).toEqual(["Enabled"]);
});

test("a failed roster read shows Core's error, and a node with no qualifying apps says so without an accounts section", async () => {
	armed = [
		{ body: { error: "boom" }, route: "GET /api/plugins", status: 500 },
		{ body: { error: "boom" }, route: "GET /api/plugins", status: 500 },
	];
	await mount();
	await until(
		() => text().includes("/api/plugins failed: 500"),
		"roster error",
		5000
	);
	// The app-wide client retries once before surfacing the failure.
	expect(rosterReads()).toBe(2);
	expect(listedIds()).toEqual([]);
	expect(text()).not.toContain("No marketplace Ryu apps");

	await unmount();
	appQueryClient.clear();
	apps = new Map(
		[...seed().values()]
			.filter((row) => row.id === ABSENT || row.id === HEADLESS)
			.map((row) => [row.id, row])
	);
	await mount();
	await until(
		() =>
			text().includes("No marketplace Ryu apps are installed on this node."),
		"empty state"
	);
	expect(text()).not.toContain("App and plugin accounts");
	expect(document.querySelectorAll("button")).toHaveLength(0);
});
