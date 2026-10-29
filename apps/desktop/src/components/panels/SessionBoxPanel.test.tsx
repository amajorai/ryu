import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

class FakeRfb {
	static instances: FakeRfb[] = [];
	disconnected = false;
	readonly options: { wsProtocols?: string[] } | undefined;
	readonly url: string;
	resizeSession = true;
	scaleViewport = false;
	viewOnly = false;
	constructor(
		_target: HTMLElement,
		url: string,
		options?: { wsProtocols?: string[] }
	) {
		this.url = url;
		this.options = options;
		FakeRfb.instances.push(this);
	}
	addEventListener() {
		// The panel tests assert how the stream was dialed, not its events.
	}
	removeEventListener() {
		// See addEventListener.
	}
	disconnect() {
		this.disconnected = true;
	}
}

let boxBackendFlag = true;
mock.module("@novnc/novnc", () => ({ default: FakeRfb }));
mock.module("@/src/hooks/useFeatureFlag.ts", () => ({
	useFeatureFlag: () => boxBackendFlag,
}));
const { createRoot } = await import("react-dom/client");
const { SessionBoxChildScreens, SessionBoxPanel } = await import(
	"./SessionBoxPanel.tsx"
);
const { useSessionBoxScreenRequest } = await import(
	"@/src/hooks/useSessionBox.ts"
);

const target: ApiTarget = {
	url: "http://node.fixture:7980",
	token: "node-token",
	userJwt: "user-jwt",
};
const conversationId = "conv-box-1";
const originalFetch = globalThis.fetch;
const roots: Root[] = [];
let client: QueryClient;

interface Call {
	body: unknown;
	method: string;
	path: string;
}
let calls: Call[];
let screenGrant: () => Response;
let statusBody: () => unknown;

function liveBox(overrides: Record<string, unknown> = {}) {
	return {
		id: "box-1",
		size: "small",
		state: "ready",
		source: "session",
		child: null,
		placement: {
			provider: "hetzner",
			location: "nbg1",
			tier: "hetzner",
			isolation: "vm",
		},
		desktop: { ready: true, viewers: 0 },
		runningSince: new Date().toISOString(),
		runningSeconds: 1080,
		accruedMicroUsd: 12_300,
		ratePerHourMicroUsd: 41_000,
		balanceMicroUsd: 5_000_000,
		minutesRemaining: 400,
		warning: "none",
		stopReason: null,
		expiresAt: null,
		...overrides,
	};
}

beforeEach(() => {
	boxBackendFlag = true;
	FakeRfb.instances = [];
	calls = [];
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	statusBody = () => ({
		conversationId,
		box: liveBox(),
		children: [],
		caps: { running: 1, max: 3 },
	});
	screenGrant = () =>
		Response.json({
			mode: "relay",
			path: `/api/session-boxes/${conversationId}/screen/ws`,
			protocols: [],
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		});
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			const call: Call = {
				path: decodeURIComponent(url.pathname),
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(String(init.body)) : null,
			};
			calls.push(call);
			if (url.pathname === "/api/ws/ticket") {
				return Promise.resolve(Response.json({ ticket: "ticket-1" }));
			}
			if (url.pathname.endsWith("/screen")) {
				return Promise.resolve(screenGrant());
			}
			if (url.pathname.startsWith("/api/session-boxes/")) {
				return Promise.resolve(Response.json(statusBody()));
			}
			return Promise.resolve(Response.json({}));
		},
		{ preconnect: originalFetch.preconnect }
	);
});

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	client.clear();
	document.body.replaceChildren();
	globalThis.fetch = originalFetch;
});

async function settle() {
	await act(async () => {
		await Bun.sleep(30);
	});
}

async function mount(element: React.ReactElement) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>{element}</QueryClientProvider>
		)
	);
	await settle();
	await settle();
	return container;
}

test("the relay path takes a session-box ticket and dials Core with it", async () => {
	await mount(
		<SessionBoxPanel conversationId={conversationId} target={target} />
	);
	const screen = calls.find((call) => call.path.endsWith("/screen"));
	expect(screen?.method).toBe("POST");
	expect(screen?.body).toMatchObject({ viewOnly: true });
	const ticket = calls.find((call) => call.path === "/api/ws/ticket");
	expect(ticket?.body).toEqual({
		route: "session-box",
		path: `/api/session-boxes/${conversationId}/screen/ws`,
	});
	expect(FakeRfb.instances).toHaveLength(1);
	const dialed = new URL(FakeRfb.instances[0].url);
	expect(dialed.protocol).toBe("ws:");
	expect(dialed.host).toBe("node.fixture:7980");
	expect(dialed.pathname).toBe(
		`/api/session-boxes/${conversationId}/screen/ws`
	);
	expect(dialed.searchParams.get("ticket")).toBe("ticket-1");
	expect(FakeRfb.instances[0].options?.wsProtocols).toEqual([]);
	// The relay ticket carries view-only too, so Core bridges without input.
	expect(dialed.searchParams.get("viewOnly")).toBe("1");
});

function buttonLabelled(container: HTMLElement, label: string) {
	return [...container.querySelectorAll("button")].find(
		(button) => button.textContent === label
	);
}

test("the screen is view-only until Take control mints an interactive grant", async () => {
	screenGrant = () =>
		Response.json({
			mode: "direct",
			url: "wss://box.ryu.test/v1/boxes/box-1/desktop/ws",
			protocols: ["ryu.box.v1", "ryu.token.abc"],
			expiresAt: new Date(Date.now() + 30_000).toISOString(),
		});
	const container = await mount(
		<SessionBoxPanel conversationId={conversationId} target={target} />
	);
	const screens = () => calls.filter((call) => call.path.endsWith("/screen"));
	expect(screens()).toHaveLength(1);
	expect(screens()[0]?.body).toMatchObject({ viewOnly: true });
	expect(FakeRfb.instances).toHaveLength(1);
	expect(FakeRfb.instances[0]?.viewOnly).toBe(true);

	const take = buttonLabelled(container, "Take control");
	expect(take?.getAttribute("aria-pressed")).toBe("false");
	await act(async () => take?.click());
	await settle();
	expect(screens()).toHaveLength(2);
	expect(screens()[1]?.body).toMatchObject({ viewOnly: false });
	expect(FakeRfb.instances).toHaveLength(2);
	expect(FakeRfb.instances[0]?.disconnected).toBe(true);
	expect(FakeRfb.instances[1]?.viewOnly).toBe(false);

	const stop = buttonLabelled(container, "Stop control");
	expect(stop?.getAttribute("aria-pressed")).toBe("true");
	await act(async () => stop?.click());
	await settle();
	expect(screens()).toHaveLength(3);
	expect(screens()[2]?.body).toMatchObject({ viewOnly: true });
	expect(FakeRfb.instances.at(-1)?.viewOnly).toBe(true);
	expect(buttonLabelled(container, "Take control")).toBeDefined();
});

test("control of one Box does not carry over to another Box", async () => {
	statusBody = () => ({
		conversationId,
		box: liveBox(),
		children: [liveBox({ id: "box-2", child: 2, source: "sub_agent" })],
		caps: null,
	});
	const container = await mount(
		<SessionBoxPanel conversationId={conversationId} target={target} />
	);
	await act(async () => buttonLabelled(container, "Take control")?.click());
	await settle();
	const screens = () => calls.filter((call) => call.path.endsWith("/screen"));
	expect(screens().at(-1)?.body).toMatchObject({ viewOnly: false });
	const select = container.querySelector("select");
	await act(async () => {
		if (select) {
			select.value = "2";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		}
	});
	await settle();
	expect(screens().at(-1)?.path).toBe(
		`/api/session-boxes/${conversationId}#sub:2/screen`
	);
	expect(screens().at(-1)?.body).toMatchObject({ viewOnly: true });
	expect(buttonLabelled(container, "Take control")).toBeDefined();
});

test("the direct path dials the Box ingress with the grant's subprotocols and no Core ticket", async () => {
	screenGrant = () =>
		Response.json({
			mode: "direct",
			url: "wss://box.ryu.test/v1/boxes/box-1/desktop/ws",
			protocols: ["ryu.box.v1", "ryu.token.abc"],
			expiresAt: new Date(Date.now() + 30_000).toISOString(),
		});
	await mount(
		<SessionBoxPanel conversationId={conversationId} target={target} />
	);
	expect(calls.some((call) => call.path === "/api/ws/ticket")).toBe(false);
	expect(FakeRfb.instances[0]?.url).toBe(
		"wss://box.ryu.test/v1/boxes/box-1/desktop/ws"
	);
	expect(FakeRfb.instances[0]?.options?.wsProtocols).toEqual([
		"ryu.box.v1",
		"ryu.token.abc",
	]);
});

test("shows the cost chip and the low-credit warning", async () => {
	statusBody = () => ({
		conversationId,
		box: liveBox({ warning: "low", minutesRemaining: 12 }),
		children: [],
		caps: null,
	});
	const container = await mount(
		<SessionBoxPanel conversationId={conversationId} target={target} />
	);
	expect(
		container.querySelector('[data-testid="box-cost-chip"]')?.textContent
	).toContain("$0.0123 · 18 min");
	expect(container.textContent).toContain("about 12 min of Box time left");
});

test("before the first tick the cost chip reads starting, not $0.0000", async () => {
	statusBody = () => ({
		conversationId,
		box: liveBox({ runningSeconds: 15, accruedMicroUsd: 0 }),
		children: [],
		caps: null,
	});
	const container = await mount(
		<SessionBoxPanel conversationId={conversationId} target={target} />
	);
	expect(
		container.querySelector('[data-testid="box-cost-chip"]')?.textContent
	).toBe("starting");
	expect(container.textContent).not.toContain("$0.0000");
});

test("a parked Box offers Resume and does not dial", async () => {
	statusBody = () => ({
		conversationId,
		box: liveBox({ state: "parked", stopReason: "idle" }),
		children: [],
		caps: null,
	});
	const container = await mount(
		<SessionBoxPanel conversationId={conversationId} target={target} />
	);
	expect(container.textContent).toContain("This Box is parked");
	expect(FakeRfb.instances).toHaveLength(0);
	const resume = [...container.querySelectorAll("button")].find(
		(button) => button.textContent === "Resume Box"
	);
	await act(async () => resume?.click());
	await settle();
	expect(
		calls.some(
			(call) => call.method === "POST" && call.path.endsWith("/resume")
		)
	).toBe(true);
});

test("a sub-agent Box is addressed as <conversation>#sub:<n>", async () => {
	statusBody = () => ({
		conversationId,
		box: liveBox(),
		children: [liveBox({ id: "box-2", child: 2, source: "sub_agent" })],
		caps: null,
	});
	const container = await mount(
		<SessionBoxPanel conversationId={conversationId} target={target} />
	);
	const select = container.querySelector("select");
	expect(select).not.toBeNull();
	await act(async () => {
		if (select) {
			select.value = "2";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		}
	});
	await settle();
	const screens = calls.filter((call) => call.path.endsWith("/screen"));
	expect(screens.at(-1)?.path).toBe(
		`/api/session-boxes/${conversationId}#sub:2/screen`
	);
});

test("the sub-agent list opens a child's screen in the Box screen tab", async () => {
	statusBody = () => ({
		conversationId,
		box: liveBox(),
		children: [liveBox({ id: "box-3", child: 3, source: "sub_agent" })],
		caps: null,
	});
	let seen: { child: number | null } | null = null;
	function Probe() {
		seen = useSessionBoxScreenRequest(conversationId);
		return null;
	}
	const container = await mount(
		<>
			<SessionBoxChildScreens conversationId={conversationId} target={target} />
			<Probe />
		</>
	);
	expect(container.textContent).toContain("Sub-agent 3");
	const view = [...container.querySelectorAll("button")].find(
		(button) => button.textContent === "View screen"
	);
	await act(async () => view?.click());
	expect(seen).toMatchObject({ child: 3 });
});

test("with the rollout flag off the panel neither reads nor dials", async () => {
	boxBackendFlag = false;
	const container = await mount(
		<SessionBoxPanel conversationId={conversationId} target={target} />
	);
	expect(container.textContent).toContain("not available");
	expect(calls).toHaveLength(0);
	expect(FakeRfb.instances).toHaveLength(0);
});

test("a conversation without a Box explains when one starts", async () => {
	statusBody = () => ({ conversationId, box: null, children: [], caps: null });
	const container = await mount(
		<SessionBoxPanel conversationId={conversationId} target={target} />
	);
	expect(container.textContent).toContain("has no Box yet");
	expect(FakeRfb.instances).toHaveLength(0);
});

test("Extend lengthens a running session Box by an hour", async () => {
	statusBody = () => ({
		conversationId,
		box: liveBox({ expiresAt: new Date(Date.now() + 600_000).toISOString() }),
		children: [],
		caps: null,
	});
	const container = await mount(
		<SessionBoxPanel conversationId={conversationId} target={target} />
	);
	const extend = [...container.querySelectorAll("button")].find(
		(button) => button.textContent === "Extend 1 h"
	);
	expect(extend).toBeDefined();
	await act(async () => extend?.click());
	await settle();
	const call = calls.find((entry) => entry.path.endsWith("/extend"));
	expect(call?.method).toBe("POST");
	expect(call?.body).toEqual({ seconds: 3600 });
});
