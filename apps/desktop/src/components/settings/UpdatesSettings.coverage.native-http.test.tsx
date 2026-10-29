import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import {
	button,
	choose,
	click,
	comboIn,
	isOn,
	maybeRow,
	normalized,
	pageText,
	row,
	settle,
	shownValue,
} from "./general-agents-network.test-support.ts";

// Control-level coverage for the Gateway dialog's Updates tab
// (`UpdatesSettings`): the per-node "Quiet hour" time zone, its divergence
// notice and its save error, plus the node's automatic-update switch and manual
// check. Every read and write crosses real loopback HTTP through the production
// clients. One native server plays both peers: Core (node bearer) for
// `/api/version`, `/api/preferences/auto-updates` and `/api/update/check`, and
// the control plane (session bearer) for the server-row routes, whose shapes
// mirror `packages/api/src/routers/servers.ts` (`serializeServer`, the
// `/timezone` PATCH with its `requires nodes.manage permission` refusal).
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
// Bun's native fetch only accepts the runtime's own abort signals, not
// happy-dom's, and the shipping clients hand it the caller's signal.
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
window.fetch = nativeFetch;
globalThis.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
setDefaultTimeout(30_000);

const NODE_TOKEN = "updates-coverage-node-token";
const SESSION_TOKEN = "updates-coverage-session-token";
const USER_JWT = "updates-coverage-user-jwt";
const ORG = "org-quiet";
const SERVER_A = "server-frankfurt";
const SERVER_B = "server-singapore";
const UNRELATED_KEY = "updates-coverage-unrelated";

interface ServerRow {
	detectedTimeZone: string | null;
	id: string;
	location: string;
	timeZone: string | null;
}

interface Exchange {
	auth: string | null;
	body: unknown;
	method: string;
	path: string;
	search: string;
	status: number;
}

const exchanges: Exchange[] = [];
const unexpected: string[] = [];
let rows = new Map<string, ServerRow>();
let role: "admin" | "member" = "admin";
let autoUpdatePref: string | null = null;
let autoUpdateRefusals = 0;
let verdict: Record<string, unknown> = {};
let readRefusals = new Set<string>();

function seedRows() {
	rows = new Map([
		[
			SERVER_A,
			{
				detectedTimeZone: "Europe/Berlin",
				id: SERVER_A,
				location: "fsn1",
				timeZone: null,
			},
		],
		[
			SERVER_B,
			{
				detectedTimeZone: "Asia/Singapore",
				id: SERVER_B,
				location: "sin",
				timeZone: "Asia/Singapore",
			},
		],
	]);
}

function effective(row: ServerRow): string {
	return row.timeZone ?? row.detectedTimeZone ?? "UTC";
}

/** `serializeServer` for a managed row, with the zone precedence applied. */
function serialize(row: ServerRow) {
	return {
		archived: false,
		backupsEnabled: true,
		createdAt: "2026-09-01T00:00:00.000Z",
		createdBy: "user-admin",
		desktopEnabled: false,
		detectedTimeZone: row.detectedTimeZone,
		effectiveTimeZone: effective(row),
		error: null,
		hetznerServerId: `hz-${row.id}`,
		hetznerType: "cx32",
		id: row.id,
		includedWithMax: true,
		includedWithPlan: true,
		inferenceMode: "managed",
		location: row.location,
		monthlyUsdSnapshot: 0,
		organizationId: ORG,
		polarSubscriptionId: null,
		publicUrl: `https://${row.id}.nodes.example.test`,
		removeGraceEndsAt: null,
		removeScheduledAt: null,
		status: "active",
		timeZone: row.timeZone,
		updatedAt: "2026-10-01T00:00:00.000Z",
	};
}

const SERVER_ROUTE =
	/^\/api\/servers\/orgs\/([^/]+)\/servers\/([^/]+)(\/timezone)?$/;

async function controlPlane(request: Request, path: string, call: Exchange) {
	if (call.auth !== `Bearer ${SESSION_TOKEN}`) {
		unexpected.push(`${request.method} ${path} without the session bearer`);
		call.status = 401;
		return NativeResponse.json({ message: "unauthorized" }, { status: 401 });
	}
	const match = SERVER_ROUTE.exec(path);
	const row = match?.[1] === ORG ? rows.get(match[2] ?? "") : undefined;
	if (!(match && row)) {
		call.status = 404;
		return NativeResponse.json(
			{ message: "server not found" },
			{ status: 404 }
		);
	}
	if (request.method === "GET" && !match[3]) {
		if (readRefusals.has(row.id)) {
			call.status = 503;
			return NativeResponse.json(
				{ message: "control plane unavailable" },
				{ status: 503 }
			);
		}
		return NativeResponse.json(serialize(row));
	}
	if (request.method === "PATCH" && match[3]) {
		if (role !== "admin") {
			call.status = 403;
			return NativeResponse.json(
				{ message: "requires nodes.manage permission" },
				{ status: 403 }
			);
		}
		const body = call.body as { timeZone?: unknown } | null;
		if (
			!body ||
			Object.keys(body).join() !== "timeZone" ||
			!(body.timeZone === null || typeof body.timeZone === "string")
		) {
			unexpected.push(`Malformed timezone body ${JSON.stringify(body)}`);
			call.status = 400;
			return NativeResponse.json({ message: "bad body" }, { status: 400 });
		}
		const requested = (body.timeZone ?? "").trim();
		row.timeZone = requested || null;
		return NativeResponse.json({
			detectedTimeZone: row.detectedTimeZone,
			effectiveTimeZone: effective(row),
			id: row.id,
			nextQuietWindow: "2026-10-12T01:00:00.000Z",
			timeZone: row.timeZone,
		});
	}
	unexpected.push(`Undeclared control-plane ${request.method} ${path}`);
	call.status = 405;
	return NativeResponse.json({ message: "undeclared" }, { status: 405 });
}

function core(request: Request, url: URL, call: Exchange) {
	const path = url.pathname;
	if (
		call.auth !== `Bearer ${NODE_TOKEN}` ||
		request.headers.get("x-ryu-user-jwt") !== USER_JWT
	) {
		unexpected.push(`${request.method} ${path} without node credentials`);
		call.status = 401;
		return NativeResponse.json({ error: "unauthorized" }, { status: 401 });
	}
	if (path === "/api/version" && request.method === "GET") {
		return NativeResponse.json({
			components: [],
			platform: "linux-x86_64",
			ryu_version: "0.9.4",
		});
	}
	if (path === "/api/preferences/auto-updates") {
		if (request.method === "GET") {
			if (autoUpdatePref === null) {
				call.status = 404;
				return NativeResponse.json({ error: "not found" }, { status: 404 });
			}
			return NativeResponse.json({
				key: "auto-updates",
				value: autoUpdatePref,
			});
		}
		if (request.method === "PUT") {
			if (autoUpdateRefusals > 0) {
				autoUpdateRefusals -= 1;
				call.status = 503;
				return NativeResponse.json({ error: "busy" }, { status: 503 });
			}
			const body = call.body as { value?: unknown } | null;
			if (typeof body?.value !== "string") {
				unexpected.push(`Malformed preference body ${JSON.stringify(body)}`);
				call.status = 400;
				return NativeResponse.json({ error: "bad body" }, { status: 400 });
			}
			autoUpdatePref = body.value;
			return NativeResponse.json({ key: "auto-updates", value: body.value });
		}
	}
	if (path === "/api/update/check" && request.method === "GET") {
		return NativeResponse.json({
			asset: null,
			channel: url.searchParams.get("channel"),
			current: "0.9.4",
			html_url: null,
			latest: "0.9.4",
			notes: null,
			update_available: false,
			...verdict,
		});
	}
	unexpected.push(`Undeclared Core ${request.method} ${path}`);
	call.status = 404;
	return NativeResponse.json({ error: "undeclared" }, { status: 404 });
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const raw =
			request.method === "GET" || request.method === "HEAD"
				? ""
				: await request.text();
		const call: Exchange = {
			auth: request.headers.get("authorization"),
			body: raw ? JSON.parse(raw) : null,
			method: request.method,
			path: url.pathname,
			search: url.search,
			status: 200,
		};
		exchanges.push(call);
		if (url.pathname.startsWith("/api/servers/")) {
			return await controlPlane(request, url.pathname, call);
		}
		if (url.pathname === "/api/auth/get-session" && request.method === "GET") {
			// The Better-Auth client may refresh its session in the background;
			// it is answered, never relied on by the Updates tab.
			return NativeResponse.json({
				session: { activeOrganizationId: ORG, userId: "user-admin" },
				user: { email: "admin@example.test", id: "user-admin" },
			});
		}
		if (url.pathname === "/api/auth/token" && request.method === "GET") {
			// Better-Auth's jwt plugin: the session bearer mints the member JWT a
			// node without its own delegation attaches to Core calls.
			if (call.auth !== `Bearer ${SESSION_TOKEN}`) {
				unexpected.push("JWT mint without the session bearer");
				call.status = 401;
				return NativeResponse.json(
					{ message: "unauthorized" },
					{ status: 401 }
				);
			}
			return NativeResponse.json({ token: USER_JWT });
		}
		return core(request, url, call);
	},
});

process.env.VITE_APP_BACKEND_URL = server.url.origin;
const ownedFetch = Object.assign(
	(input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		if (new URL(url).origin !== server.url.origin) {
			unexpected.push(`Unowned origin ${url}`);
			return Promise.reject(new Error(`Unowned origin ${url}`));
		}
		return nativeFetch(input, init);
	},
	{ preconnect: nativeFetch.preconnect }
);
globalThis.fetch = ownedFetch;
window.fetch = ownedFetch;

const { createRoot } = await import("react-dom/client");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
const { TOKEN_KEY } = await import("@/lib/auth-client.ts");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { RELEASE_CHANNELS } = await import("@/src/lib/release-channel.ts");
const { UpdatesSettings } = await import("./UpdatesSettings.tsx");

/** The picker label the shipped bundle table gives a channel. */
function channelLabel(channel: string): string {
	const found = RELEASE_CHANNELS.find((entry) => entry.channel === channel);
	if (!found) {
		throw new Error(`Unknown release channel ${channel}`);
	}
	return found.label;
}

const initialNodeState = useNodeStore.getState();
let root: Root | null = null;
let container: HTMLDivElement;

function managedNode(name: string, serverId: string | null, orgId = ORG) {
	return {
		managed: true,
		name,
		orgId,
		serverId,
		token: NODE_TOKEN,
		url: server.url.origin,
		userJwt: USER_JWT,
	};
}

function useNodes(defaultNode: string) {
	useNodeStore.setState({
		autoSelect: false,
		defaultNode,
		nodes: [
			managedNode("frankfurt", SERVER_A),
			managedNode("singapore", SERVER_B),
			managedNode("adopted", null),
			{ name: "this-device", token: NODE_TOKEN, url: server.url.origin },
		],
		tabOverrides: {},
	});
}

beforeEach(async () => {
	seedRows();
	role = "admin";
	autoUpdatePref = null;
	autoUpdateRefusals = 0;
	verdict = {};
	readRefusals = new Set();
	exchanges.length = 0;
	unexpected.length = 0;
	localStorage.clear();
	localStorage.setItem(UNRELATED_KEY, "kept");
	localStorage.setItem(TOKEN_KEY, SESSION_TOKEN);
	await act(async () => {
		sileo.clear();
	});
	useNodes("frankfurt");
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(async () => {
	await unmount();
	await act(async () => {
		sileo.clear();
	});
	container.remove();
	document.body.replaceChildren();
	useNodeStore.setState(initialNodeState, true);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must leave unrelated browser storage untouched.
	expect(localStorage.getItem(UNRELATED_KEY)).toBe("kept");
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case rejects unauthenticated, undeclared or off-fixture requests.
	expect(unexpected).toEqual([]);
});

afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
});

async function mount() {
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<>
				<UpdatesSettings />
				<Toaster position="bottom-right" />
			</>
		)
	);
	await settle(
		() => normalized(container).includes("Current version: v0.9.4."),
		"Core version read"
	);
}

async function unmount() {
	if (root) {
		const mounted = root;
		await act(async () => mounted.unmount());
	}
	root = null;
}

async function remount() {
	await unmount();
	await mount();
}

function zoneReads(serverId: string) {
	return exchanges.filter(
		(call) =>
			call.method === "GET" &&
			call.path === `/api/servers/orgs/${ORG}/servers/${serverId}`
	);
}

function zoneWrites() {
	return exchanges
		.filter((call) => call.method === "PATCH")
		.map((call) => ({ body: call.body, path: call.path, status: call.status }));
}

async function quietHourShown() {
	await settle(
		() => maybeRow("Time zone", container) !== null,
		"Quiet hour section"
	);
}

function settledPatch(count: number) {
	return settle(
		() =>
			zoneWrites().length >= count &&
			!comboIn("Time zone").hasAttribute("data-disabled"),
		`${count} timezone writes acknowledged`
	);
}

function serverRowSnapshot(serverId: string) {
	return { ...rows.get(serverId) };
}

test("Time zone follows the node by default; an override PATCHes the exact zone, adds the divergence notice, survives a remount, and Follow the node clears it", async () => {
	const untouched = serverRowSnapshot(SERVER_B);
	await mount();
	await quietHourShown();
	expect(zoneReads(SERVER_A)).toHaveLength(1);
	expect(zoneReads(SERVER_A)[0]?.auth).toBe(`Bearer ${SESSION_TOKEN}`);
	expect(shownValue(comboIn("Time zone"))).toBe("Follow the node");
	expect(pageText()).toContain("Scheduled resizes use 03:00 in Europe/Berlin.");
	expect(maybeRow("Updates keep the node's own night", container)).toBeNull();
	expect(maybeRow("Couldn't save", container)).toBeNull();

	const offered = await choose(comboIn("Time zone"), "Asia/Tokyo");
	expect(offered[0]).toBe("Follow the node (Europe/Berlin)");
	expect(offered).toContain("UTC");
	await settledPatch(1);
	expect(zoneWrites()).toEqual([
		{
			body: { timeZone: "Asia/Tokyo" },
			path: `/api/servers/orgs/${ORG}/servers/${SERVER_A}/timezone`,
			status: 200,
		},
	]);
	expect(rows.get(SERVER_A)?.timeZone).toBe("Asia/Tokyo");
	expect(shownValue(comboIn("Time zone"))).toBe("Asia/Tokyo");
	expect(pageText()).toContain("Scheduled resizes use 03:00 in Asia/Tokyo.");
	expect(
		maybeRow("Updates keep the node's own night", container)
	).not.toBeNull();
	expect(pageText()).toContain(
		"Deferred Core and Gateway updates are scheduled by the node itself, from its own clock — those still run at 03:00 Europe/Berlin, not Asia/Tokyo. Only resizes, which the control plane performs, follow the override."
	);

	await remount();
	await quietHourShown();
	expect(shownValue(comboIn("Time zone"))).toBe("Asia/Tokyo");
	expect(
		maybeRow("Updates keep the node's own night", container)
	).not.toBeNull();

	await choose(comboIn("Time zone"), "Follow the node (Europe/Berlin)");
	await settledPatch(2);
	expect(zoneWrites()[1]).toEqual({
		body: { timeZone: null },
		path: `/api/servers/orgs/${ORG}/servers/${SERVER_A}/timezone`,
		status: 200,
	});
	expect(rows.get(SERVER_A)?.timeZone).toBeNull();
	expect(shownValue(comboIn("Time zone"))).toBe("Follow the node");
	expect(maybeRow("Updates keep the node's own night", container)).toBeNull();
	expect(pageText()).toContain("Scheduled resizes use 03:00 in Europe/Berlin.");
	expect(serverRowSnapshot(SERVER_B)).toEqual(untouched);
});

test("an override equal to the zone the node reports is stored without a divergence notice", async () => {
	await mount();
	await quietHourShown();
	await choose(comboIn("Time zone"), "Europe/Berlin");
	await settledPatch(1);
	expect(zoneWrites()[0]?.body).toEqual({ timeZone: "Europe/Berlin" });
	expect(rows.get(SERVER_A)?.timeZone).toBe("Europe/Berlin");
	expect(shownValue(comboIn("Time zone"))).toBe("Europe/Berlin");
	expect(maybeRow("Updates keep the node's own night", container)).toBeNull();
});

test("a member's refused PATCH shows Couldn't save with the server's sentence and keeps the saved zone; an admin retry clears the error", async () => {
	role = "member";
	await mount();
	await quietHourShown();
	await choose(comboIn("Time zone"), "America/New_York");
	await settledPatch(1);
	await settle(
		() => maybeRow("Couldn't save", container) !== null,
		"save error row"
	);
	expect(zoneWrites()).toEqual([
		{
			body: { timeZone: "America/New_York" },
			path: `/api/servers/orgs/${ORG}/servers/${SERVER_A}/timezone`,
			status: 403,
		},
	]);
	expect(pageText()).toContain("requires nodes.manage permission");
	expect(rows.get(SERVER_A)?.timeZone).toBeNull();
	expect(shownValue(comboIn("Time zone"))).toBe("Follow the node");
	expect(maybeRow("Updates keep the node's own night", container)).toBeNull();

	role = "admin";
	await choose(comboIn("Time zone"), "America/New_York");
	await settledPatch(2);
	await settle(
		() => maybeRow("Couldn't save", container) === null,
		"save error cleared"
	);
	expect(zoneWrites()[1]?.status).toBe(200);
	expect(rows.get(SERVER_A)?.timeZone).toBe("America/New_York");
	expect(shownValue(comboIn("Time zone"))).toBe("America/New_York");
	expect(
		maybeRow("Updates keep the node's own night", container)
	).not.toBeNull();
});

test("the Quiet hour section is absent for nodes without both ids, for a refused read and when signed out, and never writes", async () => {
	useNodes("this-device");
	await mount();
	await settle(
		() => exchanges.some((call) => call.path === "/api/version"),
		"version"
	);
	expect(maybeRow("Time zone", container)).toBeNull();

	await unmount();
	useNodes("adopted");
	await mount();
	expect(maybeRow("Time zone", container)).toBeNull();
	expect(
		exchanges.filter((call) => call.path.startsWith("/api/servers/"))
	).toEqual([]);

	await unmount();
	useNodes("frankfurt");
	readRefusals.add(SERVER_A);
	await mount();
	await settle(() => zoneReads(SERVER_A).length === 1, "refused read");
	expect(zoneReads(SERVER_A)[0]?.status).toBe(503);
	expect(maybeRow("Time zone", container)).toBeNull();

	await unmount();
	readRefusals.clear();
	localStorage.removeItem(TOKEN_KEY);
	await mount();
	expect(maybeRow("Time zone", container)).toBeNull();
	expect(zoneReads(SERVER_A)).toHaveLength(1);
	expect(zoneWrites()).toEqual([]);
	localStorage.setItem(TOKEN_KEY, SESSION_TOKEN);
});

test("switching the active managed node rereads that node's own zone instead of keeping the previous one", async () => {
	await mount();
	await quietHourShown();
	expect(shownValue(comboIn("Time zone"))).toBe("Follow the node");
	await act(async () => {
		useNodeStore.setState({ defaultNode: "singapore" });
	});
	await settle(() => zoneReads(SERVER_B).length === 1, "second node read");
	await settle(
		() => shownValue(comboIn("Time zone")) === "Asia/Singapore",
		"second node zone"
	);
	expect(pageText()).toContain(
		"Scheduled resizes use 03:00 in Asia/Singapore."
	);
	await choose(comboIn("Time zone"), "UTC");
	await settledPatch(1);
	expect(zoneWrites()[0]?.path).toBe(
		`/api/servers/orgs/${ORG}/servers/${SERVER_B}/timezone`
	);
	expect(rows.get(SERVER_A)?.timeZone).toBeNull();
	expect(rows.get(SERVER_B)?.timeZone).toBe("UTC");
});

test("the automatic-updates switch saves the node preference, a refused save restores it, the Channel pick reaches the check, and Check for updates tells failure from up to date", async () => {
	autoUpdatePref = JSON.stringify({ enabled: true });
	await mount();
	const toggle = () =>
		row("Automatic updates").querySelector<HTMLElement>('[role="switch"]');
	await settle(() => toggle() !== null && isOn(toggle()!), "auto-update read");

	autoUpdateRefusals = 1;
	await click(toggle()!);
	await settle(
		() =>
			pageText().includes("Could not save the auto-update setting") &&
			isOn(toggle()!),
		"refused toggle restored"
	);
	expect(autoUpdatePref).toBe(JSON.stringify({ enabled: true }));

	await click(toggle()!);
	await settle(() => autoUpdatePref === '{"enabled":false}', "toggle saved");
	expect(isOn(toggle()!)).toBe(false);
	const puts = exchanges
		.filter(
			(call) =>
				call.method === "PUT" && call.path === "/api/preferences/auto-updates"
		)
		.map((call) => ({ body: call.body, status: call.status }));
	expect(puts).toEqual([
		{ body: { value: '{"enabled":false}' }, status: 503 },
		{ body: { value: '{"enabled":false}' }, status: 200 },
	]);
	await remount();
	await settle(() => toggle() !== null && !isOn(toggle()!), "toggle reread");

	// The Channel picker is the same control the App tab shows; the node's
	// check asks Core about the channel the user picked.
	expect(shownValue(comboIn("Channel"))).toBe(channelLabel("stable"));
	await choose(comboIn("Channel"), channelLabel("beta"));
	expect(localStorage.getItem("ryu:release-channel")).toBe("beta");
	verdict = { error: "GitHub rate limit" };
	await click(button("Check for updates"));
	await settle(
		() => pageText().includes("Couldn't check for updates"),
		"failed check"
	);
	expect(pageText()).toContain("GitHub rate limit");
	expect(pageText()).not.toContain("Ryu is up to date");
	const check = exchanges
		.filter((call) => call.path === "/api/update/check")
		.at(-1);
	expect(check?.auth).toBe(`Bearer ${NODE_TOKEN}`);
	expect(check?.search).toBe("?channel=beta");

	await act(async () => {
		sileo.clear();
	});
	verdict = {};
	await click(button("Check for updates"));
	await settle(() => pageText().includes("Ryu is up to date"), "clean check");

	await remount();
	expect(shownValue(comboIn("Channel"))).toBe(channelLabel("beta"));
});
