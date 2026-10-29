import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

// Native transport is restored after happy-dom so the shipping contributions
// client, WebSocket-ticket exchange and realtime socket reach a real Bun peer.
const native = {
	fetch: globalThis.fetch,
	Response: globalThis.Response,
	Request: globalThis.Request,
	Headers: globalThis.Headers,
	AbortController: globalThis.AbortController,
	AbortSignal: globalThis.AbortSignal,
	WebSocket: globalThis.WebSocket,
};
if (typeof document === "undefined") {
	GlobalRegistrator.register();
}
Object.assign(globalThis, native);
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const {
	DECLARATIVE_VIEW_HARNESS_PATH,
	pluginCompanionPath,
	pluginViewPath,
	usePluginContributionRoutes,
	usePluginContributionsLiveRefresh,
} = await import("./usePluginContributions.ts");
const { contributionRegistry } = await import("../contributions/registry.ts");
const { useNodeStore } = await import("../store/useNodeStore.ts");
const { queryClient } = await import("../lib/query-client.ts");
const { QueryClientProvider } = await import("@tanstack/react-query");

const previousNodes = useNodeStore.getState();
const TOKEN = "contrib-node-token";
const ALPHA = pluginCompanionPath("app__alpha-companion");
const BETA = pluginCompanionPath("app__beta-companion");
const BETA_VIEW = pluginViewPath("beta", "beta-list");
const CHANGED = {
	channel: "events",
	event: "plugin.contributions.changed",
	data: { type: "contributions_changed" },
};

type Frame = Record<string, unknown>;
interface Peer {
	closed: number;
	enabled: Set<"alpha" | "beta">;
	frames: Frame[];
	opened: number;
	reads: Array<{ status: number; authorization: string | null }>;
	send(frame: Frame): void;
	status: number;
	stop(): void;
	tickets: Array<{ body: unknown; authorization: string | null }>;
	unknown: string[];
}

function companion(plugin: "alpha" | "beta") {
	return {
		id: `app__${plugin}-companion`,
		name: plugin,
		label: `${plugin} companion`,
		plugin_id: plugin,
		has_ui: true,
		approved_grants: [],
		default_csp_enforced: true,
	};
}

function startPeer(): Peer {
	const sockets = new Set<Bun.ServerWebSocket<undefined>>();
	const issued = new Set<string>();
	const peer: Peer = {
		enabled: new Set(["alpha", "beta"]),
		status: 200,
		reads: [],
		tickets: [],
		frames: [],
		opened: 0,
		closed: 0,
		unknown: [],
		send(frame) {
			for (const socket of sockets) {
				socket.send(JSON.stringify(frame));
			}
		},
		stop() {
			server.stop(true);
		},
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request, bun) {
			const url = new URL(request.url);
			const authorization = request.headers.get("authorization");
			if (url.pathname === "/api/realtime/ws") {
				const ticket = url.searchParams.get("ticket") ?? "";
				// Tickets are one-use, never Bearer credentials on the socket URL.
				if (!issued.delete(ticket) || authorization !== null) {
					peer.unknown.push(`refused socket ${url.search}`);
					return new Response(null, { status: 401 });
				}
				return bun.upgrade(request)
					? undefined
					: new Response(null, { status: 400 });
			}
			if (authorization !== `Bearer ${TOKEN}`) {
				peer.unknown.push(`unauthorized ${request.method} ${url.pathname}`);
				return Response.json({ error: "unauthorized" }, { status: 401 });
			}
			if (request.method === "POST" && url.pathname === "/api/ws/ticket") {
				const body: unknown = await request.json();
				peer.tickets.push({ body, authorization });
				const ticket = `ticket-${peer.tickets.length}`;
				issued.add(ticket);
				return Response.json({ ticket });
			}
			if (
				request.method === "GET" &&
				url.pathname === "/api/plugins/contributions" &&
				url.search === ""
			) {
				peer.reads.push({ status: peer.status, authorization });
				if (peer.status !== 200) {
					return Response.json(
						{ error: "plugin host unavailable" },
						{ status: peer.status }
					);
				}
				const plugins = [...peer.enabled].sort();
				return Response.json({
					companions: plugins.map(companion),
					views: plugins.includes("beta")
						? [{ id: "beta-list", view: "list-detail", plugin: "beta" }]
						: [],
				});
			}
			peer.unknown.push(`undeclared ${request.method} ${url.pathname}`);
			return Response.json({ error: "undeclared" }, { status: 404 });
		},
		websocket: {
			open(socket) {
				sockets.add(socket);
				peer.opened += 1;
			},
			message(socket, raw) {
				const frame: Frame = JSON.parse(String(raw));
				peer.frames.push(frame);
				if (frame.type === "join") {
					socket.send(
						JSON.stringify({
							type: "join_ack",
							room_id: frame.room_id,
							member_id: "member-1",
							client_id: frame.client_id,
							access: "write",
							presence: [],
						})
					);
				}
			},
			close(socket) {
				sockets.delete(socket);
				peer.closed += 1;
			},
		},
	});
	const node = {
		name: "contrib-node",
		url: `http://127.0.0.1:${server.port}`,
		token: TOKEN,
	};
	useNodeStore.setState({
		nodes: [node],
		localNodes: [node],
		cloudNodes: [],
		defaultNode: node.name,
		autoSelect: false,
		autoSelectedNode: null,
		tabOverrides: {},
	});
	return peer;
}

let root: ReturnType<typeof createRoot> | undefined;
let peer: Peer | undefined;
const runtimeErrors: string[] = [];

function Host() {
	usePluginContributionRoutes();
	usePluginContributionsLiveRefresh();
	return null;
}

async function mount() {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container, {
		onCaughtError: (error) => runtimeErrors.push(String(error)),
		onUncaughtError: (error) => runtimeErrors.push(String(error)),
	});
	await act(async () =>
		root?.render(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(Host)
			)
		)
	);
}

async function settle(label: string, predicate: () => boolean) {
	for (let attempt = 0; attempt < 300; attempt += 1) {
		if (predicate()) {
			return;
		}
		await act(async () => {
			await Bun.sleep(10);
		});
	}
	throw new Error(`Contribution consumer did not acknowledge: ${label}`);
}

const routed = (path: string) => contributionRegistry.resolve(path) !== null;
const joined = (current: Peer) =>
	current.frames.some(
		(frame) =>
			frame.type === "join" &&
			frame.room_id === "system:plugins" &&
			frame.kind === "conversation"
	);

/** Server ping, client pong: every earlier frame has been dispatched. */
async function drainFrames(current: Peer) {
	const pongs = current.frames.filter((frame) => frame.type === "pong").length;
	current.send({ type: "ping" });
	await settle(
		"realtime frame order",
		() => current.frames.filter((frame) => frame.type === "pong").length > pongs
	);
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	await queryClient.cancelQueries();
	queryClient.clear();
	peer?.stop();
	peer = undefined;
	useNodeStore.setState(previousNodes);
	document.body.replaceChildren();
	const errors = runtimeErrors.splice(0);
	if (errors.length > 0) {
		throw new Error(
			`Mounted consumer reported runtime errors: ${errors.join("; ")}`
		);
	}
});

test("a Core disable event removes only that plugin's routes; unrelated events refetch nothing; unmount releases every route and the room", async () => {
	const current = startPeer();
	peer = current;
	await mount();
	await settle(
		"enabled routes",
		() => routed(ALPHA) && routed(BETA) && routed(BETA_VIEW)
	);
	expect(routed(DECLARATIVE_VIEW_HARNESS_PATH)).toBe(true);
	await settle("joined plugin room", () => joined(current));
	expect(current.tickets).toEqual([
		{
			body: {
				kind: "conversation",
				roomId: "system:plugins",
				route: "realtime",
			},
			authorization: `Bearer ${TOKEN}`,
		},
	]);
	expect(current.reads).toEqual([
		{ status: 200, authorization: `Bearer ${TOKEN}` },
	]);

	// Core disables beta, but only the acknowledged change event may refresh.
	current.enabled.delete("beta");
	current.send({
		channel: "events",
		event: "plugin.other",
		data: { type: "grants_reviewed" },
	});
	current.send({ channel: "events", data: "contributions_changed" });
	await drainFrames(current);
	expect(queryClient.isFetching()).toBe(0);
	expect(current.reads).toHaveLength(1);
	expect(routed(BETA)).toBe(true);

	current.send(CHANGED);
	await settle("disabled beta route removed", () => !routed(BETA));
	expect(routed(BETA_VIEW)).toBe(false);
	expect(routed(ALPHA)).toBe(true);
	expect(routed(DECLARATIVE_VIEW_HARNESS_PATH)).toBe(true);
	expect(current.reads).toHaveLength(2);

	await act(async () => root?.unmount());
	root = undefined;
	await settle("room closed", () => current.closed === 1);
	expect(routed(ALPHA)).toBe(false);
	expect(routed(DECLARATIVE_VIEW_HARNESS_PATH)).toBe(false);
	expect(current.frames.at(-1)).toEqual({ type: "leave" });
	expect(current.reads).toHaveLength(2);
	expect(current.opened).toBe(1);
	expect(current.unknown).toEqual([]);
});

test("a refused refresh keeps the enabled routes; a re-enabled plugin's routes return on the next acknowledged change", async () => {
	const current = startPeer();
	peer = current;
	await mount();
	await settle("enabled routes", () => routed(ALPHA) && routed(BETA));
	await settle("joined plugin room", () => joined(current));

	current.status = 503;
	current.send(CHANGED);
	await settle("refused refresh observed", () => current.reads.length === 2);
	await settle("refused refresh settled", () => queryClient.isFetching() === 0);
	await drainFrames(current);
	expect(current.reads.at(-1)).toEqual({
		status: 503,
		authorization: `Bearer ${TOKEN}`,
	});
	expect(routed(ALPHA)).toBe(true);
	expect(routed(BETA)).toBe(true);
	expect(routed(BETA_VIEW)).toBe(true);

	current.status = 200;
	current.enabled.delete("beta");
	current.send(CHANGED);
	await settle("beta disabled", () => !routed(BETA));
	expect(routed(BETA_VIEW)).toBe(false);
	expect(routed(ALPHA)).toBe(true);

	current.enabled.add("beta");
	current.send(CHANGED);
	await settle("beta re-enabled", () => routed(BETA) && routed(BETA_VIEW));
	expect(routed(ALPHA)).toBe(true);
	expect(current.reads.map((read) => read.status)).toEqual([
		200, 503, 200, 200,
	]);
	expect(current.opened).toBe(1);
	expect(current.unknown).toEqual([]);
});
