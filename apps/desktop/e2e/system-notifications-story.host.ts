import { readFileSync } from "node:fs";
import type { DesktopNotification } from "../src/lib/api/events.ts";
export const NOTIFICATION_CORE_ORIGIN = "http://127.0.0.1:5661";
export const NOTIFICATION_BROWSER_ORIGIN = "http://127.0.0.1:5660";
export interface NotificationProofRequest {
	id: number;
	method: string;
	path: string;
	token: string | null;
	userJwt: string | null;
	status: number;
	closed: boolean;
	sent: DesktopNotification[];
	lifecycle: {
		bornAt: string;
		bornMonotonicMs: number;
		signalAbortedAtRegister: boolean;
		peer: { address: string; port: number; family: string } | null;
		closeCause: string | null;
		closedAt: string | null;
		observedPeer?: { address: string; port: number; family: string } | null;
		localPort: number;
		requestHeaders: Record<string, string>;
		kernelTcp?:
			| { supported: true; states: string[] }
			| { supported: false; reason: string };
	};
}
export interface NotificationProofState {
	requests: NotificationProofRequest[];
	unexpected: { method: string; url: string; reason: string }[];
	pendingServerRequests?: number;
}
function kernelTcpSnapshot():
	| { supported: true; rows: string[][] }
	| { supported: false; reason: string } {
	if (process.platform !== "linux")
		return {
			supported: false,
			reason: "Linux /proc TCP diagnostics unavailable on this platform",
		};
	try {
		return {
			supported: true,
			rows: readFileSync("/proc/net/tcp", "utf8")
				.trim()
				.split("\n")
				.slice(1)
				.map((line) => line.trim().split(/\s+/)),
		};
	} catch (error) {
		return {
			supported: false,
			reason:
				error instanceof Error ? error.message : "Could not read /proc/net/tcp",
		};
	}
}
function kernelPeerStates(
	snapshot: ReturnType<typeof kernelTcpSnapshot>,
	port: number,
	peer: NotificationProofRequest["lifecycle"]["peer"],
): NonNullable<NotificationProofRequest["lifecycle"]["kernelTcp"]> {
	if (!snapshot.supported) return snapshot;
	if (peer?.address !== "127.0.0.1")
		return {
			supported: false,
			reason: "Diagnostic expects the owned IPv4 loopback peer",
		};
	const local = `0100007F:${port.toString(16).padStart(4, "0").toUpperCase()}`;
	const remote = `0100007F:${peer.port.toString(16).padStart(4, "0").toUpperCase()}`;
	return {
		supported: true,
		states: snapshot.rows
			.filter((row) => row[1] === local && row[2] === remote)
			.map((row) => row[3]!),
	};
}
export function startNotificationProofHost(port = 5661) {
	const state: NotificationProofState = { requests: [], unexpected: [] };
	const requestLifetimes = new Map<number, Request>();
	const streams = new Map<
		number,
		{
			record: NotificationProofRequest;
			controller: ReadableStreamDefaultController<Uint8Array>;
			timer: ReturnType<typeof setInterval>;
		}
	>();
	let nextId = 0,
		refused = 0;
	const encoder = new TextEncoder();
	const headers = {
		"access-control-allow-origin": NOTIFICATION_BROWSER_ORIGIN,
		"access-control-allow-methods": "GET,POST,OPTIONS",
		"access-control-allow-headers":
			"authorization,content-type,accept,x-ryu-user-jwt,x-ryu-client-id,x-ryu-client-label,x-ryu-surface,x-ryu-user-id,x-ryu-user-name",
	};
	function close(id: number, cause: string) {
		const stream = streams.get(id);
		if (!stream) return;
		stream.record.closed = true;
		stream.record.lifecycle.closeCause = cause;
		stream.record.lifecycle.closedAt = new Date().toISOString();
		clearInterval(stream.timer);
		streams.delete(id);
		try {
			stream.controller.close();
		} catch {}
	}
	function refuse(request: Request, reason: string, status = 503) {
		state.unexpected.push({ method: request.method, url: request.url, reason });
		return Response.json({ error: reason }, { status, headers });
	}
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		async fetch(request, server): Promise<Response> {
			const url = new URL(request.url),
				path = url.pathname;
			if (request.method === "GET" && path === "/__ready")
				return new Response("ready", { headers });
			if (request.method === "GET" && path === "/__proof/state") {
				const kernel = kernelTcpSnapshot();
				for (const record of state.requests) {
					record.lifecycle.kernelTcp = kernelPeerStates(
						kernel,
						record.lifecycle.localPort,
						record.lifecycle.peer,
					);
					const retained = requestLifetimes.get(record.id);
					if (retained)
						record.lifecycle.observedPeer = server.requestIP(retained);
				}
				state.pendingServerRequests = server.pendingRequests;
				return Response.json(state, { headers });
			}
			if (request.method === "POST" && path === "/__proof/control") {
				if (
					request.headers.get("x-notification-proof-control") !==
					"owned-local-fixture"
				)
					return refuse(request, "Unowned fixture control", 401);
				const command: unknown = await request.json().catch(() => null);
				if (!command || typeof command !== "object")
					return refuse(request, "Malformed fixture command", 400);
				const c = command as Record<string, unknown>;
				if (
					c.action === "reset" &&
					Number.isInteger(c.refused) &&
					Number(c.refused) >= 0 &&
					Number(c.refused) <= 2
				) {
					for (const id of [...streams.keys()]) close(id, "fixture-reset");
					state.requests.length = 0;
					requestLifetimes.clear();
					state.unexpected.length = 0;
					refused = Number(c.refused);
					return Response.json({ ok: true }, { headers });
				}
				if (
					c.action === "emit" &&
					Number.isInteger(c.requestId) &&
					c.notification &&
					typeof c.notification === "object"
				) {
					const n = c.notification as Record<string, unknown>;
					if (
						typeof n.title !== "string" ||
						!(
							n.body === undefined ||
							n.body === null ||
							typeof n.body === "string"
						) ||
						!(n.level === undefined || typeof n.level === "string")
					)
						return refuse(request, "Malformed notification", 400);
					const stream = streams.get(Number(c.requestId));
					if (!stream)
						return Response.json(
							{ error: "Requested stream is closed" },
							{ status: 409, headers },
						);
					const value: DesktopNotification = {
						title: n.title,
						body: n.body as string | null | undefined,
						level: n.level as string | undefined,
					};
					stream.record.sent.push(value);
					stream.controller.enqueue(
						encoder.encode(
							`event: notifications\ndata: ${JSON.stringify(value)}\n\n`,
						),
					);
					return Response.json({ ok: true }, { headers });
				}
				if (c.action === "disconnect" && Number.isInteger(c.requestId)) {
					if (!streams.has(Number(c.requestId)))
						return Response.json(
							{ error: "Requested stream is closed" },
							{ status: 409, headers },
						);
					close(Number(c.requestId), "fixture-disconnect");
					return Response.json({ ok: true }, { headers });
				}
				return refuse(request, "Unsupported fixture command", 400);
			}
			if (
				request.method === "OPTIONS" &&
				path === "/api/events/all" &&
				request.headers.get("origin") === NOTIFICATION_BROWSER_ORIGIN &&
				request.headers.get("access-control-request-method") === "GET"
			)
				return new Response(null, { status: 204, headers });
			if (
				request.method !== "GET" ||
				path !== "/api/events/all" ||
				url.search !== "" ||
				request.headers.get("accept") !== "text/event-stream"
			)
				return refuse(request, "Unsupported method/path/stream contract");
			const token = request.headers.get("authorization"),
				userJwt = request.headers.get("x-ryu-user-jwt");
			if (
				!(
					(token === "Bearer notification-node-a" &&
						(userJwt === "notification-user-a" ||
							userJwt === "notification-user-b")) ||
					(token === "Bearer notification-node-b" &&
						userJwt === "notification-user-a")
				)
			)
				return refuse(request, "Unknown credential pair", 401);
			const record: NotificationProofRequest = {
				id: ++nextId,
				method: request.method,
				path,
				token,
				userJwt,
				status: refused > 0 ? 503 : 200,
				closed: false,
				sent: [],
				lifecycle: {
					bornAt: new Date().toISOString(),
					bornMonotonicMs: performance.now(),
					signalAbortedAtRegister: request.signal.aborted,
					peer: server.requestIP(request),
					localPort: server.port!,
					requestHeaders: Object.fromEntries(request.headers.entries()),
					observedPeer: server.requestIP(request),
					closeCause: null,
					closedAt: null,
				},
			};
			state.requests.push(record);
			requestLifetimes.set(record.id, request);
			if (refused > 0) {
				refused--;
				record.closed = true;
				record.lifecycle.closeCause = "HTTP-refusal";
				record.lifecycle.closedAt = new Date().toISOString();
				return new Response("Temporarily unavailable", {
					status: 503,
					headers,
				});
			}
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode(": connected\n\n"));
					const timer = setInterval(() => {
						try {
							controller.enqueue(encoder.encode(": keepalive\n\n"));
						} catch {
							close(record.id, "keepalive-enqueue-refused");
						}
					}, 100);
					streams.set(record.id, { record, controller, timer });
					request.signal.addEventListener(
						"abort",
						() => close(record.id, "request-signal-abort"),
						{
							once: true,
						},
					);
				},
				cancel() {
					close(record.id, "response-body-cancel");
				},
			});
			return new Response(body, {
				headers: {
					...headers,
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
				},
			});
		},
	});
	return {
		server,
		state,
		stop() {
			for (const id of [...streams.keys()]) close(id, "fixture-stop");
			server.stop(true);
		},
	};
}
if (import.meta.main) {
	const host = startNotificationProofHost();
	const shutdown = () => {
		host.stop();
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}
