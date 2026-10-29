// "Route traffic through this computer" panel, driven end to end through the
// shipping clients: the control-plane managed-node fetch and the local Core
// `/api/local-egress/desktop` route both go through `fetch`, which this file
// answers in-process. Nothing leaves the process.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { createRoot } = await import("react-dom/client");
const { BACKEND_URL } = await import("@/lib/auth-client.ts");
const { DEFAULT_CORE_URL } = await import("@/lib/core-url.ts");
const { DesktopRouteSettings } = await import("./DesktopRouteSettings.tsx");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { desktopDeviceName } = await import("@/src/lib/api/local-egress.ts");

const USER = "user-me";
const NODES_URL = `${BACKEND_URL.replace(/\/$/, "")}/api/control-plane/nodes`;
const ROUTE_URL = `${DEFAULT_CORE_URL.replace(/\/$/, "")}/api/local-egress/desktop`;

interface ManagedFixture {
	id: string;
	name: string;
	ownerUserId: string | null;
	scope: "org" | "team" | "personal";
	url: string;
	userJwt: string | null;
}
interface RouteStatusFixture {
	enabled: boolean;
	nodes: Record<string, unknown>[];
}

let managedResponses: ManagedFixture[][] = [];
let managedCalls = 0;
let routeStatus: RouteStatusFixture | null = null;
let puts: unknown[] = [];

function managed(
	id: string,
	ownerUserId: string | null,
	jwt: string | null = `jwt-${id}`
): ManagedFixture {
	return {
		id,
		name: `Node ${id}`,
		ownerUserId,
		scope: ownerUserId ? "personal" : "org",
		url: `https://${id}.nodes.test`,
		userJwt: jwt,
	};
}

globalThis.fetch = Object.assign(
	async (input: string | URL | Request, init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		const method = (init?.method ?? "GET").toUpperCase();
		if (url === NODES_URL) {
			const nodes =
				managedResponses[Math.min(managedCalls, managedResponses.length - 1)] ??
				[];
			managedCalls += 1;
			return new NativeResponse(
				JSON.stringify({
					nodes: nodes.map((node) => ({
						...node,
						lastSeenAt: null,
						orgId: "org-1",
						orgName: "Org",
					})),
				}),
				{ headers: { "content-type": "application/json" } }
			);
		}
		if (url === ROUTE_URL) {
			if (!routeStatus) {
				return new NativeResponse("not found", { status: 404 });
			}
			if (method === "PUT") {
				const body: { enabled: boolean } = JSON.parse(String(init?.body));
				puts.push(body);
				routeStatus = { ...routeStatus, enabled: body.enabled };
			}
			return new NativeResponse(JSON.stringify(routeStatus), {
				headers: { "content-type": "application/json" },
			});
		}
		return new NativeResponse("{}", { status: 404 });
	},
	{ preconnect: () => undefined }
);

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	localStorage.setItem(
		"ryu_accounts",
		JSON.stringify([
			{
				email: "me@example.test",
				image: null,
				name: "Me",
				token: "session-me",
				userId: USER,
			},
		])
	);
	localStorage.setItem("ryu_active_user_id", USER);
	localStorage.setItem("ryu_session_token", "session-me");
	useNodeStore.setState({
		localNodes: [
			{ name: "local", url: DEFAULT_CORE_URL, token: "core", userJwt: null },
		],
	});
	managedResponses = [];
	managedCalls = 0;
	routeStatus = null;
	puts = [];
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	localStorage.clear();
});
afterAll(() => {
	globalThis.fetch = nativeFetch;
});

async function settle(check: () => boolean) {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (check()) {
			return;
		}
		await act(async () => {
			await new Promise((resolve) => setImmediate(resolve));
		});
	}
	throw new Error(`Route panel did not settle: ${container.textContent}`);
}
const routeSwitch = () =>
	container.querySelector<HTMLElement>(
		'[role="switch"][aria-label="Route traffic through this computer"]'
	);
async function mount() {
	await act(async () => root.render(<DesktopRouteSettings />));
}

test("turning the switch on re-fetches managed nodes and sends only the signed-in user's routable nodes", async () => {
	// Mount sees a stale list; the toggle must use the fresh one.
	managedResponses = [
		[managed("stale", USER)],
		[
			managed("mine", USER),
			managed("theirs", "user-other"),
			managed("shared", null),
			managed("no-jwt", USER, null),
		],
	];
	routeStatus = { enabled: false, nodes: [] };
	await mount();
	await settle(() => routeSwitch() !== null && managedCalls === 1);
	expect(routeSwitch()?.getAttribute("aria-checked")).toBe("false");

	await act(async () => routeSwitch()?.click());
	await settle(() => puts.length === 1);

	expect(managedCalls).toBe(2);
	expect(puts[0]).toEqual({
		enabled: true,
		deviceName: desktopDeviceName(),
		nodes: [
			{ nodeId: "mine", token: "jwt-mine", url: "https://mine.nodes.test" },
		],
	});
	await settle(() => routeSwitch()?.getAttribute("aria-checked") === "true");
});

test("turning the switch off still sends fresh credentials so Core can release each node", async () => {
	managedResponses = [[managed("mine", USER), managed("theirs", "user-other")]];
	routeStatus = {
		enabled: true,
		nodes: [{ nodeId: "mine", state: "connected", connectedSinceMs: 1 }],
	};
	await mount();
	await settle(() => routeSwitch()?.getAttribute("aria-checked") === "true");
	expect(container.textContent).toContain("Node mine");
	expect(container.textContent).toContain("Connected");

	await act(async () => routeSwitch()?.click());
	await settle(() => puts.length === 1);
	expect(puts[0]).toEqual({
		enabled: false,
		deviceName: desktopDeviceName(),
		nodes: [
			{ nodeId: "mine", token: "jwt-mine", url: "https://mine.nodes.test" },
		],
	});
	await settle(() => routeSwitch()?.getAttribute("aria-checked") === "false");
});

test("every link disabled by the admin locks the switch and explains why", async () => {
	managedResponses = [[managed("a", USER), managed("b", USER)]];
	routeStatus = {
		enabled: true,
		nodes: [
			{ nodeId: "a", state: "disabled_by_admin" },
			{ nodeId: "b", state: "disabled_by_admin" },
		],
	};
	await mount();
	await settle(() => routeSwitch() !== null);
	const control = routeSwitch();
	expect(control?.getAttribute("aria-checked")).toBe("false");
	expect(control?.getAttribute("aria-disabled")).toBe("true");
	expect(container.textContent).toContain(
		"Disabled by your admin. You can't turn this on."
	);
	expect(container.textContent).toContain("Off by admin");
	expect(container.textContent).toContain(
		"Your team admin has turned off local traffic routing."
	);
	await act(async () => control?.click());
	expect(puts).toEqual([]);
});

test("an offline link reads as Paused with its connection error, and a mixed set stays unlocked", async () => {
	managedResponses = [[managed("a", USER), managed("b", USER)]];
	routeStatus = {
		enabled: true,
		nodes: [
			{ nodeId: "a", state: "offline", error: "tunnel refused" },
			{ nodeId: "b", state: "disabled_by_admin" },
		],
	};
	await mount();
	await settle(() => container.textContent?.includes("Paused") === true);
	expect(container.textContent).toContain(
		"Not connected: tunnel refused. Its traffic is paused until this computer reconnects."
	);
	expect(routeSwitch()?.getAttribute("aria-disabled")).not.toBe("true");
	expect(routeSwitch()?.getAttribute("aria-checked")).toBe("true");
});

test("a local Core without the route renders nothing", async () => {
	managedResponses = [[managed("mine", USER)]];
	routeStatus = null;
	await mount();
	await settle(() => managedCalls === 1);
	await act(async () => {
		await new Promise((resolve) => setImmediate(resolve));
	});
	expect(container.innerHTML).toBe("");
	expect(routeSwitch()).toBeNull();
});
