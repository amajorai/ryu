import { afterEach, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import {
	type ApiTarget,
	fetchForTarget,
	makeHeaders,
	setUserJwtProvider,
} from "@ryuhq/core-client/client";
import { ensureCoreRunning } from "../core/bootstrap.ts";
import { streamChat } from "../core/chatStream.ts";
import {
	CORE_IDENTITY_PATH,
	CoreIdentityError,
	coreIdentityProof,
	loopbackAddresses,
	setLoopbackConnectorForTests,
	withCoreIdentityCheck,
} from "../core/coreIdentity.ts";
import { disposeCliIdentity, installCliIdentity } from "../core/identity.ts";
import { healthCheck, nodeToTarget, probeCore } from "../core/nodes.ts";
import { fetchUpdateCheck } from "../core/update.ts";
import { type MemoryHandler, memoryLoopback } from "./core-identity-fixture.ts";

afterEach(() => {
	setLoopbackConnectorForTests(null);
});

interface AuthenticatedNodeProbeObservation {
	authorization: string | null;
	path: string;
	userJwt: string | null;
}

for (const token of [null, "node-bearer"]) {
	test(`health and update probes preserve delegated target credentials with bearer ${token === null ? "absent" : "present"}`, async () => {
		const requests: AuthenticatedNodeProbeObservation[] = [];
		const target: ApiTarget = {
			url: "https://managed.example.test",
			token,
			userJwt: "node-audience-delegation",
			fetch: async (input, init) => {
				const url = new URL(String(input));
				const headers = new Headers(init?.headers);
				expect(url.origin).toBe(target.url);
				expect(init?.signal).toBeInstanceOf(AbortSignal);
				expect(init?.body).toBeUndefined();
				requests.push({
					path: url.pathname,
					authorization: headers.get("authorization"),
					userJwt: headers.get("x-ryu-user-jwt"),
				});
				return Response.json(
					url.pathname === "/api/health"
						? { status: "ok" }
						: { current: "0.4.0", latest: "0.4.0", update_available: false }
				);
			},
		};
		expect(await healthCheck(target)).toBe(true);
		expect(await fetchUpdateCheck(target)).toMatchObject({
			available: false,
			current: "0.4.0",
		});
		expect(requests).toEqual(
			["/api/health", "/api/update/check"].map((path) => ({
				path,
				authorization: `Bearer ${token ?? target.userJwt}`,
				userJwt: target.userJwt ?? null,
			}))
		);
	});
}

test("health rejects a refused or unavailable node without borrowing another target", async () => {
	for (const failure of ["refused", "unavailable"] as const) {
		let calls = 0;
		expect(
			await healthCheck({
				url: "https://refused.example.test",
				token: null,
				fetch: async () => {
					calls += 1;
					if (failure === "unavailable") {
						throw new Error("node unavailable");
					}
					return new Response(null, { status: 403 });
				},
			})
		).toBe(false);
		expect(calls).toBe(1);
	}
});

interface LoopbackObservation {
	authorization: string | null;
	path: string;
	userJwt: string | null;
}

/** A loopback listener that records every request and answers the identity
 *  challenge with `prove` (or 404 when it cannot). */
function loopbackListener(
	prove: ((nonce: string, port: number) => string) | null,
	options: { hostname?: string; port?: number } = {}
) {
	const hostname = options.hostname ?? "127.0.0.1";
	const seen: LoopbackObservation[] = [];
	const server: ReturnType<typeof Bun.serve> = Bun.serve({
		hostname,
		port: options.port ?? 0,
		fetch(request): Response {
			const url = new URL(request.url);
			seen.push({
				authorization: request.headers.get("authorization"),
				path: url.pathname,
				userJwt: request.headers.get("x-ryu-user-jwt"),
			});
			if (url.pathname === "/api/health") {
				return Response.json({ status: "ok" });
			}
			if (url.pathname === CORE_IDENTITY_PATH && prove) {
				const nonce = url.searchParams.get("nonce") ?? "";
				return Response.json({ proof: prove(nonce, server.port ?? 0) });
			}
			return new Response(null, { status: 404 });
		},
	});
	return {
		seen,
		server,
		url: `http://${hostname}:${server.port}`,
	};
}

const NODE_TOKEN = "victim-node-token";

test("an unverified loopback squatter never receives the node bearer and is not Core", async () => {
	const squatter = loopbackListener(null);
	try {
		const target = nodeToTarget({
			name: "local",
			token: NODE_TOKEN,
			url: squatter.url,
			userJwt: "victim-user-jwt",
		});
		expect(await probeCore(target)).toBe("conflict");
		expect(await healthCheck(target)).toBe(false);
		// Any credentialed call through the target is refused before it is sent.
		await expect(
			fetchForTarget(target)(`${squatter.url}/api/agents`, {
				headers: makeHeaders(target.token, target.userJwt),
			})
		).rejects.toBeInstanceOf(CoreIdentityError);
		// Bootstrap reports the conflict instead of treating the port as Core.
		const progress: string[] = [];
		const previous = process.env.RYU_TUI_NO_BOOTSTRAP;
		delete process.env.RYU_TUI_NO_BOOTSTRAP;
		try {
			await ensureCoreRunning(target, {
				onProgress: (line) => progress.push(line),
			});
		} finally {
			if (previous !== undefined) {
				process.env.RYU_TUI_NO_BOOTSTRAP = previous;
			}
		}
		expect(progress).toHaveLength(1);
		expect(progress[0]).toContain("could not prove it is your Ryu Core");
		expect(squatter.seen.length).toBeGreaterThan(0);
		for (const request of squatter.seen) {
			expect(request.authorization).toBeNull();
			expect(request.userJwt).toBeNull();
			expect(request.path).not.toBe("/api/agents");
		}
		expect(JSON.stringify(squatter.seen)).not.toContain(NODE_TOKEN);
	} finally {
		squatter.server.stop(true);
	}
});

test("a squatter relaying a real Core's proof for another port is still refused", async () => {
	const relay = loopbackListener((nonce, port) =>
		coreIdentityProof(NODE_TOKEN, "127.0.0.1", port + 1, nonce)
	);
	try {
		const target = nodeToTarget({
			name: "local",
			token: NODE_TOKEN,
			url: relay.url,
		});
		expect(await probeCore(target)).toBe("conflict");
		for (const request of relay.seen) {
			expect(request.authorization).toBeNull();
		}
	} finally {
		relay.server.stop(true);
	}
});

test("a loopback Core that proves the token is ready and then gets the bearer", async () => {
	const core = loopbackListener((nonce, port) =>
		coreIdentityProof(NODE_TOKEN, "127.0.0.1", port, nonce)
	);
	try {
		const target = nodeToTarget({
			name: "local",
			token: NODE_TOKEN,
			url: core.url,
		});
		expect(await probeCore(target)).toBe("ready");
		// The probe itself stayed credential-free.
		expect(core.seen.map((request) => request.authorization)).toEqual([
			null,
			null,
		]);
		const response = await fetchForTarget(target)(`${core.url}/api/agents`, {
			headers: makeHeaders(target.token, target.userJwt),
		});
		expect(response.status).toBe(404);
		expect(core.seen.at(-1)).toEqual({
			authorization: `Bearer ${NODE_TOKEN}`,
			path: "/api/agents",
			userJwt: null,
		});
	} finally {
		core.server.stop(true);
	}
});

test("the identity proof matches Core's pinned vectors", () => {
	// Same inputs as apps/core/src/server/core_identity.rs tests.
	const nonce =
		"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
	expect(coreIdentityProof("node-secret", "127.0.0.1", 7980, nonce)).toBe(
		"304649b1001efca1392c1cf317f23386536de2d0a6ff81c58944d967f5182d67"
	);
	expect(coreIdentityProof("node-secret", "::1", 7980, nonce)).toBe(
		"b3ff0967bcc5d24f202186d01c9cb19f9e13628400bcfd566ff1eed72fbdfa87"
	);
});

test("loopback host names are dialed as literal addresses", () => {
	expect(loopbackAddresses("127.0.0.1")).toEqual(["127.0.0.1"]);
	expect(loopbackAddresses("127.0.0.2")).toEqual(["127.0.0.2"]);
	expect(loopbackAddresses("[::1]")).toEqual(["::1"]);
	expect(
		loopbackAddresses(new URL("http://[::ffff:127.0.0.1]:1").hostname)
	).toEqual(["127.0.0.1"]);
	for (const name of [
		"localhost",
		"LOCALHOST.",
		"ryu.localhost",
		"0.0.0.0",
		"[::]",
	]) {
		expect(loopbackAddresses(name)).toEqual(["127.0.0.1", "::1"]);
	}
	for (const remote of [
		"example.test",
		"10.0.0.1",
		"[::ffff:10.0.0.1]",
		"[2001:db8::1]",
	]) {
		expect(loopbackAddresses(remote)).toEqual([]);
	}
});

test("a chat turn to an unverified loopback squatter sends no credential", async () => {
	const squatter = loopbackListener(null);
	try {
		const target = nodeToTarget({
			name: "local",
			token: NODE_TOKEN,
			url: squatter.url,
			userJwt: "victim-user-jwt",
		});
		const errors: string[] = [];
		let deltas = 0;
		await streamChat(
			target,
			[{ content: "hi", role: "user" }],
			{},
			{
				onDone: () => undefined,
				onError: (message) => errors.push(message),
				onTextDelta: () => {
					deltas += 1;
				},
			}
		);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("could not prove it is your Ryu Core");
		expect(deltas).toBe(0);
		expect(squatter.seen.map((request) => request.path)).toEqual([
			CORE_IDENTITY_PATH,
		]);
		expect(JSON.stringify(squatter.seen)).not.toContain(NODE_TOKEN);
		expect(JSON.stringify(squatter.seen)).not.toContain("victim-user-jwt");
	} finally {
		squatter.server.stop(true);
	}
});

test("a chat turn to a verified loopback Core carries the node bearer", async () => {
	const core = loopbackListener((nonce, port) =>
		coreIdentityProof(NODE_TOKEN, "127.0.0.1", port, nonce)
	);
	try {
		const target = nodeToTarget({
			name: "local",
			token: NODE_TOKEN,
			url: core.url,
		});
		await streamChat(
			target,
			[{ content: "hi", role: "user" }],
			{},
			{
				onDone: () => undefined,
				onError: () => undefined,
				onTextDelta: () => undefined,
			}
		);
		expect(core.seen.map((request) => request.path)).toEqual([
			CORE_IDENTITY_PATH,
			"/api/chat/stream",
		]);
		expect(core.seen.at(-1)?.authorization).toBe(`Bearer ${NODE_TOKEN}`);
	} finally {
		core.server.stop(true);
	}
});

/** An in-memory Core at one literal address: it proves the token for the
 *  address and port its connection was accepted on, as Core does. */
function memoryCore(seen: LoopbackObservation[]): MemoryHandler {
	return (request, connection) => {
		const url = new URL(request.url);
		seen.push({
			authorization: request.headers.get("authorization"),
			path: url.pathname,
			userJwt: request.headers.get("x-ryu-user-jwt"),
		});
		if (url.pathname === CORE_IDENTITY_PATH) {
			const nonce = url.searchParams.get("nonce") ?? "";
			return Response.json({
				proof: coreIdentityProof(
					NODE_TOKEN,
					connection.address,
					connection.port,
					nonce
				),
			});
		}
		return Response.json({ status: "ok" });
	};
}

/** An in-memory squatter that relays the challenge to `core` (reaching it on
 *  `coreAddress`, the only address Core listens on) and records the rest. */
function memoryRelay(
	seen: LoopbackObservation[],
	core: MemoryHandler,
	coreAddress: string
): MemoryHandler {
	let nextId = 1000;
	return (request, connection) => {
		const url = new URL(request.url);
		seen.push({
			authorization: request.headers.get("authorization"),
			path: url.pathname,
			userJwt: request.headers.get("x-ryu-user-jwt"),
		});
		if (url.pathname === CORE_IDENTITY_PATH || url.pathname === "/api/health") {
			nextId += 1;
			return core(request, {
				address: coreAddress,
				id: nextId,
				port: connection.port,
			});
		}
		return Response.json({ stolen: true });
	};
}

test("a squatter that takes the port is challenged on every new request and gets nothing", async () => {
	const coreSeen: LoopbackObservation[] = [];
	const squatterSeen: LoopbackObservation[] = [];
	const state = { squatting: false };
	const core = memoryCore(coreSeen);
	const squatter = memoryCore([]);
	const net = memoryLoopback((address) => {
		if (address !== "127.0.0.1") {
			return null;
		}
		return state.squatting
			? (request, connection) => {
					squatterSeen.push({
						authorization: request.headers.get("authorization"),
						path: new URL(request.url).pathname,
						userJwt: request.headers.get("x-ryu-user-jwt"),
					});
					// Not holding the token, it can only answer with a wrong proof.
					return squatter(request, { ...connection, port: 1 });
				}
			: core;
	});
	setLoopbackConnectorForTests(net.connector);
	const url = "http://127.0.0.1:7999";
	const target = withCoreIdentityCheck<ApiTarget>({ token: NODE_TOKEN, url });
	const headers = makeHeaders(target.token, null);
	await fetchForTarget(target)(`${url}/api/agents`, { headers });
	await fetchForTarget(target)(`${url}/api/agents`, { headers });
	// One challenge per request: no verdict is carried from one to the next.
	expect(coreSeen.map((request) => request.path)).toEqual([
		CORE_IDENTITY_PATH,
		"/api/agents",
		CORE_IDENTITY_PATH,
		"/api/agents",
	]);
	expect(coreSeen.at(-1)?.authorization).toBe(`Bearer ${NODE_TOKEN}`);

	// Core stops and another process takes the port at once; the very next
	// request (no clock advance, no probe in between) is still challenged.
	state.squatting = true;
	await expect(
		fetchForTarget(target)(`${url}/api/agents`, { headers })
	).rejects.toBeInstanceOf(CoreIdentityError);
	expect(squatterSeen).toEqual([
		{ authorization: null, path: CORE_IDENTITY_PATH, userJwt: null },
	]);
	expect(JSON.stringify(squatterSeen)).not.toContain(NODE_TOKEN);
});

test("a port that changes hands right after the challenge still cannot get the bearer", async () => {
	// The established connection stays with Core; only NEW connections reach
	// the squatter. The credentialed request must ride the connection that
	// passed the challenge, never a fresh one.
	const coreSeen: LoopbackObservation[] = [];
	const squatterSeen: LoopbackObservation[] = [];
	const state = { squatting: false };
	const coreProof = memoryCore(coreSeen);
	const core: MemoryHandler = async (request, connection) => {
		const response = await coreProof(request, connection);
		if (new URL(request.url).pathname === CORE_IDENTITY_PATH) {
			state.squatting = true; // Core crashes; the port is taken at once.
		}
		return response;
	};
	const net = memoryLoopback(() =>
		state.squatting
			? (request) => {
					squatterSeen.push({
						authorization: request.headers.get("authorization"),
						path: new URL(request.url).pathname,
						userJwt: request.headers.get("x-ryu-user-jwt"),
					});
					return Response.json({ stolen: true });
				}
			: core
	);
	setLoopbackConnectorForTests(net.connector);
	const url = "http://127.0.0.1:7999";
	const target = withCoreIdentityCheck<ApiTarget>({ token: NODE_TOKEN, url });
	const response = await fetchForTarget(target)(`${url}/api/agents`, {
		headers: makeHeaders(target.token, null),
	});
	expect(await response.json()).toEqual({ status: "ok" });
	expect(coreSeen.map((request) => request.path)).toEqual([
		CORE_IDENTITY_PATH,
		"/api/agents",
	]);
	expect(squatterSeen).toEqual([]);
});

test("localhost is dialed as literal addresses, and a same-port relay on the other one gets nothing", async () => {
	for (const layout of [
		{ core: "127.0.0.1", squatter: "::1" },
		{ core: "::1", squatter: "127.0.0.1" },
	]) {
		const coreSeen: LoopbackObservation[] = [];
		const squatterSeen: LoopbackObservation[] = [];
		const core = memoryCore(coreSeen);
		const relay = memoryRelay(squatterSeen, core, layout.core);
		const net = memoryLoopback((address) => {
			if (address === layout.core) {
				return core;
			}
			return address === layout.squatter ? relay : null;
		});
		setLoopbackConnectorForTests(net.connector);
		const url = "http://localhost:7980";
		const target = nodeToTarget({
			name: "local",
			token: NODE_TOKEN,
			url,
			userJwt: "victim-user-jwt",
		});
		const response = await fetchForTarget(target)(`${url}/api/agents`, {
			headers: makeHeaders(target.token, target.userJwt),
		});
		expect(await response.json()).toEqual({ status: "ok" });
		// Never the name itself: the proof is bound to the address dialed.
		for (const address of net.dialed) {
			expect(["127.0.0.1", "::1"]).toContain(address);
		}
		expect(coreSeen.at(-1)).toEqual({
			authorization: `Bearer ${NODE_TOKEN}`,
			path: "/api/agents",
			userJwt: "victim-user-jwt",
		});
		expect(squatterSeen.map((request) => request.path)).not.toContain(
			"/api/agents"
		);
		expect(JSON.stringify(squatterSeen)).not.toContain(NODE_TOKEN);
		expect(JSON.stringify(squatterSeen)).not.toContain("victim-user-jwt");
	}
});

/**
 * A raw-socket fake Core that answers each request on its connection, proving
 * the token for the connection's real local address and port (what Core's
 * listener does). With `shutdownOnIdentity`, it answers the challenge the way
 * a Core in graceful shutdown does (`Connection: close`) and hands the port
 * to `shutdownOnIdentity` before closing the connection.
 */
async function rawCore(
	options: {
		host?: string;
		port?: number;
		shutdownOnIdentity?: () => void;
	} = {}
): Promise<{
	port: number;
	seen: LoopbackObservation[];
	server: Server;
	stop: () => void;
}> {
	const seen: LoopbackObservation[] = [];
	const sockets = new Set<Socket>();
	const answer = (socket: Socket, head: string): boolean => {
		const lines = head.split("\r\n");
		const path = (lines[0] ?? "").split(" ")[1] ?? "/";
		const headers = new Map(
			lines.slice(1).map((line) => {
				const colon = line.indexOf(":");
				return [
					line.slice(0, colon).trim().toLowerCase(),
					line.slice(colon + 1).trim(),
				] as const;
			})
		);
		const url = new URL(path, "http://core.invalid");
		seen.push({
			authorization: headers.get("authorization") ?? null,
			path: url.pathname,
			userJwt: headers.get("x-ryu-user-jwt") ?? null,
		});
		const identity = url.pathname === CORE_IDENTITY_PATH;
		const address = (socket.localAddress ?? "").replace(/^::ffff:/u, "");
		const body = JSON.stringify(
			identity
				? {
						proof: coreIdentityProof(
							NODE_TOKEN,
							address,
							socket.localPort ?? 0,
							url.searchParams.get("nonce") ?? ""
						),
					}
				: { status: "ok" }
		);
		const closing = identity && options.shutdownOnIdentity !== undefined;
		socket.write(
			`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n${closing ? "connection: close\r\n" : ""}\r\n${body}`
		);
		if (closing) {
			options.shutdownOnIdentity?.();
			socket.end();
		}
		return closing;
	};
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		let buffer = "";
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("latin1");
			for (;;) {
				const end = buffer.indexOf("\r\n\r\n");
				if (end === -1) {
					return;
				}
				const head = buffer.slice(0, end);
				const length = Number(/content-length: (\d+)/iu.exec(head)?.[1] ?? 0);
				if (buffer.length < end + 4 + length) {
					return;
				}
				buffer = buffer.slice(end + 4 + length);
				if (answer(socket, head)) {
					return;
				}
			}
		});
	});
	await new Promise<void>((resolve) => {
		server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	const stop = () => {
		server.close();
		for (const socket of sockets) {
			socket.destroy();
		}
	};
	return { port, seen, server, stop };
}

test("a squatter on another loopback address at Core's port cannot relay Core's proof", async () => {
	// Core listens on 127.0.0.1:P. Another local account binds 127.0.0.2:P
	// (no conflict with Core's socket) and relays the credential-free probe
	// to the real Core, which answers for the address that connection reached.
	const core = await rawCore();
	const coreUrl = `http://127.0.0.1:${core.port}`;
	const relay = Bun.serve({
		hostname: "127.0.0.2",
		port: core.port,
		async fetch(request): Promise<Response> {
			const url = new URL(request.url);
			squatterSeen.push({
				authorization: request.headers.get("authorization"),
				path: url.pathname,
				userJwt: request.headers.get("x-ryu-user-jwt"),
			});
			if (
				url.pathname === "/api/health" ||
				url.pathname === CORE_IDENTITY_PATH
			) {
				const relayed = await fetch(`${coreUrl}${url.pathname}${url.search}`);
				return new Response(await relayed.text(), {
					headers: { "content-type": "application/json" },
					status: relayed.status,
				});
			}
			return Response.json({ stolen: true });
		},
	});
	const squatterSeen: LoopbackObservation[] = [];
	try {
		const url = `http://127.0.0.2:${core.port}`;
		const target = nodeToTarget({
			name: "local",
			token: NODE_TOKEN,
			url,
			userJwt: "victim-user-jwt",
		});
		const failure = await fetchForTarget(target)(`${url}/api/agents`, {
			headers: makeHeaders(target.token, target.userJwt),
		}).then(
			() => null,
			(error: unknown) => error
		);
		expect(JSON.stringify(squatterSeen)).not.toContain(NODE_TOKEN);
		expect(JSON.stringify(squatterSeen)).not.toContain("victim-user-jwt");
		expect(squatterSeen.map((request) => request.path)).not.toContain(
			"/api/agents"
		);
		expect(failure).toBeInstanceOf(CoreIdentityError);
		expect(await probeCore(target)).toBe("conflict");
		// The relay really reached Core, and still failed.
		expect(core.seen.map((request) => request.path)).toContain(
			CORE_IDENTITY_PATH
		);

		// The same Core, reached directly by name, is verified and served.
		const direct = nodeToTarget({
			name: "local",
			token: NODE_TOKEN,
			url: `http://localhost:${core.port}`,
		});
		expect(await probeCore(direct)).toBe("ready");
		const response = await fetchForTarget(direct)(
			`http://localhost:${core.port}/api/agents`,
			{ headers: makeHeaders(direct.token, null) }
		);
		expect(await response.json()).toEqual({ status: "ok" });
		expect(core.seen.at(-1)).toEqual({
			authorization: `Bearer ${NODE_TOKEN}`,
			path: "/api/agents",
			userJwt: null,
		});
	} finally {
		relay.stop(true);
		core.stop();
	}
});

test("a Core shutting down after the challenge does not let a squatter on its port get the bearer", async () => {
	// Core answers the challenge with `Connection: close` (graceful shutdown for
	// quit or self-update) and releases the port; another local account binds
	// it before the CLI's request. That request must not go to a new connection.
	const squatterSeen: LoopbackObservation[] = [];
	let squatter: ReturnType<typeof Bun.serve> | null = null;
	const holder: { core: Server | null; port: number } = { core: null, port: 0 };
	const core = await rawCore({
		shutdownOnIdentity: () => {
			holder.core?.close();
			for (let attempt = 0; attempt < 50 && squatter === null; attempt += 1) {
				try {
					squatter = Bun.serve({
						hostname: "127.0.0.1",
						port: holder.port,
						fetch(request): Response {
							squatterSeen.push({
								authorization: request.headers.get("authorization"),
								path: new URL(request.url).pathname,
								userJwt: request.headers.get("x-ryu-user-jwt"),
							});
							return Response.json({ stolen: true });
						},
					});
				} catch {
					Bun.sleepSync(2);
				}
			}
		},
	});
	holder.core = core.server;
	holder.port = core.port;
	try {
		const url = `http://127.0.0.1:${core.port}`;
		const target = nodeToTarget({
			name: "local",
			token: NODE_TOKEN,
			url,
			userJwt: "victim-user-jwt",
		});
		const outcome = await fetchForTarget(target)(`${url}/api/agents`, {
			headers: makeHeaders(target.token, target.userJwt),
		}).then(
			async (response) => ({ body: await response.text(), failed: false }),
			() => ({ body: "", failed: true })
		);
		expect(squatter).not.toBeNull();
		expect(JSON.stringify(squatterSeen)).not.toContain(NODE_TOKEN);
		expect(JSON.stringify(squatterSeen)).not.toContain("victim-user-jwt");
		expect(squatterSeen.map((request) => request.path)).not.toContain(
			"/api/agents"
		);
		expect(outcome.failed).toBe(true);
		expect(core.seen.map((request) => request.path)).toEqual([
			CORE_IDENTITY_PATH,
		]);
	} finally {
		(squatter as ReturnType<typeof Bun.serve> | null)?.stop(true);
		core.stop();
	}
});

test("a stream reconnect after Core drops does not hand the bearer to a squatter that took the port", async () => {
	// A real Core on a real loopback port serves a stream that ends abruptly.
	const core = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request): Response {
			const url = new URL(request.url);
			if (url.pathname === CORE_IDENTITY_PATH) {
				const nonce = url.searchParams.get("nonce") ?? "";
				return Response.json({
					proof: coreIdentityProof(
						NODE_TOKEN,
						"127.0.0.1",
						core.port ?? 0,
						nonce
					),
				});
			}
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					// One event, then the stream stays open until Core goes away.
					controller.enqueue(new TextEncoder().encode("data: hello\n\n"));
				},
			});
			return new Response(body, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	const port = core.port ?? 0;
	const url = `http://127.0.0.1:${port}`;
	const target = nodeToTarget({
		name: "local",
		token: NODE_TOKEN,
		url,
		userJwt: "victim-user-jwt",
	});
	const headers = makeHeaders(target.token, target.userJwt);
	const stream = await fetchForTarget(target)(`${url}/api/notifications`, {
		headers,
	});
	expect(stream.ok).toBe(true);
	const reader = stream.body?.getReader();
	expect((await reader?.read())?.done).toBe(false);

	// Core exits (quit, crash, self-update) mid-stream, so the body read ends
	// abnormally; a squatter binds the same port immediately.
	core.stop(true);
	await reader?.read().catch(() => undefined);
	const seen: LoopbackObservation[] = [];
	const squatter = Bun.serve({
		hostname: "127.0.0.1",
		port,
		fetch(request): Response {
			seen.push({
				authorization: request.headers.get("authorization"),
				path: new URL(request.url).pathname,
				userJwt: request.headers.get("x-ryu-user-jwt"),
			});
			return Response.json({ status: "ok" });
		},
	});
	try {
		// The client reconnects well inside any reuse window (immediately).
		await expect(
			fetchForTarget(target)(`${url}/api/notifications`, { headers })
		).rejects.toBeInstanceOf(CoreIdentityError);
		expect(seen.map((request) => request.path)).toEqual([CORE_IDENTITY_PATH]);
		expect(JSON.stringify(seen)).not.toContain(NODE_TOKEN);
		expect(JSON.stringify(seen)).not.toContain("victim-user-jwt");
	} finally {
		squatter.stop(true);
	}
});

test("the conflict message names the fail-closed cases a user can hit", () => {
	const message = new CoreIdentityError("http://127.0.0.1:9000").message;
	expect(message).toContain("could not prove it is your Ryu Core");
	expect(message).toContain("paired-device or delegated token");
	expect(message).toContain("port forward");
	expect(message).toContain("same address and port");
});

test("a loopback target with no node token never sends a user JWT", async () => {
	const squatter = loopbackListener(null);
	setUserJwtProvider(() => "provider-user-jwt");
	try {
		const target = nodeToTarget({
			name: "local",
			token: null,
			url: squatter.url,
			userJwt: "victim-user-jwt",
		});
		await fetchForTarget(target)(`${squatter.url}/api/agents`, {
			headers: makeHeaders(target.token, target.userJwt),
		});
		await fetchForTarget(target)(
			new Request(`${squatter.url}/api/agents`, {
				headers: makeHeaders(null, null),
			})
		);
		await streamChat(
			target,
			[{ content: "hi", role: "user" }],
			{},
			{
				onDone: () => undefined,
				onError: () => undefined,
				onTextDelta: () => undefined,
			}
		);
		expect(squatter.seen.map((request) => request.path)).toEqual([
			"/api/agents",
			"/api/agents",
			"/api/chat/stream",
		]);
		for (const request of squatter.seen) {
			expect(request.authorization).toBeNull();
			expect(request.userJwt).toBeNull();
		}
	} finally {
		setUserJwtProvider(() => null);
		squatter.server.stop(true);
	}
});

test("the identity broker exchange is not sent to an unverified loopback listener", async () => {
	const squatter = loopbackListener(null);
	const previous = {
		token: process.env.RYU_IDENTITY_CORE_TOKEN,
		url: process.env.RYU_IDENTITY_CORE_URL,
	};
	delete process.env.RYU_IDENTITY_CORE_TOKEN;
	delete process.env.RYU_IDENTITY_CORE_URL;
	try {
		const target = nodeToTarget({
			name: "local",
			token: NODE_TOKEN,
			url: squatter.url,
		});
		const source = await installCliIdentity(target);
		expect(source.current()).toBeNull();
		expect(squatter.seen.map((request) => request.path)).not.toContain(
			"/api/auth/user-jwt"
		);
		expect(JSON.stringify(squatter.seen)).not.toContain(NODE_TOKEN);
	} finally {
		disposeCliIdentity();
		if (previous.token !== undefined) {
			process.env.RYU_IDENTITY_CORE_TOKEN = previous.token;
		}
		if (previous.url !== undefined) {
			process.env.RYU_IDENTITY_CORE_URL = previous.url;
		}
		squatter.server.stop(true);
	}
});
