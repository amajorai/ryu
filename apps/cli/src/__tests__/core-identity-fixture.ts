// Shared fake-Core answer for the CLI's credential-free loopback probe.
//
// A plain-HTTP loopback target with a node token is probed with no credential
// (`GET /api/health`) and must answer the identity challenge
// (`GET /api/health/identity?nonce=…`) before the CLI sends it the token. Test
// fixtures that impersonate a local Core answer both here, the way Core does.
//
// The CLI sends such a target's requests over its own loopback connections,
// not `fetch`; `useFetchBackedLoopback()` routes those connections to the
// test's `globalThis.fetch` stub instead of real sockets.

import {
	coreIdentityProof,
	loopbackAddresses,
	setLoopbackConnectorForTests,
} from "../core/coreIdentity.ts";
import type {
	LoopbackConnection,
	LoopbackConnector,
} from "../core/loopbackConnection.ts";

/**
 * The response a real local Core holding `target.token` gives the
 * credential-free probe, or `null` when the request is not part of that probe
 * (it then goes through the fixture's usual authenticated contract).
 */
export function credentialFreeCoreProbe(
	url: URL,
	method: string,
	headers: Headers,
	target: { token: string; url: string }
): Response | null {
	if (
		url.origin !== new URL(target.url).origin ||
		method.toUpperCase() !== "GET" ||
		headers.get("authorization") !== null ||
		headers.get("x-ryu-user-jwt") !== null
	) {
		return null;
	}
	if (url.pathname === "/api/health" && !url.search) {
		return Response.json({ status: "ok" });
	}
	if (url.pathname === "/api/health/identity") {
		const nonce = url.searchParams.get("nonce") ?? "";
		const port = Number(url.port || 80);
		// Core proves the literal address the CLI dialed for this host.
		const address = loopbackAddresses(url.hostname)[0] ?? url.hostname;
		return Response.json({
			proof: coreIdentityProof(target.token, address, port, nonce),
			version: 2,
		});
	}
	return null;
}

/** Who accepted a connection, as seen by an in-memory listener. */
export interface MemoryConnectionInfo {
	address: string;
	id: number;
	port: number;
}

export type MemoryHandler = (
	request: Request,
	connection: MemoryConnectionInfo
) => Response | Promise<Response>;

/**
 * An in-memory loopback network. `listenerAt(address, port)` picks who
 * accepts a NEW connection at that moment (null: connection refused); an
 * established connection stays with whoever accepted it, as on a real socket.
 */
export function memoryLoopback(
	listenerAt: (address: string, port: number) => MemoryHandler | null
): { connector: LoopbackConnector; dialed: string[] } {
	const dialed: string[] = [];
	let nextId = 0;
	const connector: LoopbackConnector = (address, port, signal) => {
		dialed.push(address);
		if (signal.aborted) {
			return Promise.reject(signal.reason);
		}
		const handler = listenerAt(address, port);
		if (!handler) {
			return Promise.reject(
				Object.assign(new Error("connect ECONNREFUSED"), {
					code: "ECONNREFUSED",
				})
			);
		}
		nextId += 1;
		const info = { address, id: nextId, port };
		let open = true;
		const connection: LoopbackConnection = {
			address,
			close: () => {
				open = false;
			},
			get open() {
				return open;
			},
			port,
			send: async (request, options) => {
				if (!open) {
					throw new TypeError("connection closed");
				}
				const response = await handler(request, info);
				if (options.close) {
					open = false;
				}
				return response;
			},
		};
		return Promise.resolve(connection);
	};
	return { connector, dialed };
}

/**
 * Route the CLI's loopback connections to `globalThis.fetch` (read per
 * request, so a test may swap its stub). Returns the restore function.
 */
export function useFetchBackedLoopback(): () => void {
	const { connector } = memoryLoopback(() => async (request) => {
		const body = request.body === null ? undefined : await request.text();
		return globalThis.fetch(request.url, {
			body,
			headers: request.headers,
			method: request.method,
			signal: request.signal,
		});
	});
	setLoopbackConnectorForTests(connector);
	return () => setLoopbackConnectorForTests(null);
}
