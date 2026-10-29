// The loopback HTTP/1.1 client parses raw bytes from a real socket. Each test
// runs a raw `node:net` listener on 127.0.0.1:0 that writes an exact response,
// so framing and protocol errors are exercised against real wire bytes rather
// than a replaced connector.

import { afterEach, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { dialLoopback, type LoopbackConnection } from "./loopbackConnection.ts";

const servers: Server[] = [];
const connections: LoopbackConnection[] = [];

afterEach(async () => {
	for (const connection of connections.splice(0)) {
		connection.close();
	}
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
				})
		)
	);
});

interface RawRequest {
	body: string;
	head: string;
}

/** Answers each complete request on a socket with `respond(request, index)`.
 *  `null` keeps the socket open without answering. */
async function rawServer(
	respond: (
		request: RawRequest,
		index: number,
		socket: Socket
	) => string | Buffer | null
) {
	const requests: RawRequest[] = [];
	const sockets: Socket[] = [];
	const server = createServer((socket) => {
		sockets.push(socket);
		let buffered = Buffer.alloc(0);
		socket.on("error", () => {
			// The client may destroy the socket mid-test.
		});
		socket.on("data", (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			for (;;) {
				const end = buffered.indexOf("\r\n\r\n");
				if (end === -1) {
					return;
				}
				const head = buffered.subarray(0, end).toString("latin1");
				const length = Number(/content-length: (\d+)/iu.exec(head)?.[1] ?? 0);
				if (buffered.length < end + 4 + length) {
					return;
				}
				const body = buffered
					.subarray(end + 4, end + 4 + length)
					.toString("latin1");
				buffered = buffered.subarray(end + 4 + length);
				const request = { body, head };
				requests.push(request);
				const reply = respond(request, requests.length - 1, socket);
				if (reply !== null) {
					socket.write(reply);
				}
			}
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	return { port, requests, sockets };
}

async function dial(port: number): Promise<LoopbackConnection> {
	const connection = await dialLoopback(
		"127.0.0.1",
		port,
		new AbortController().signal
	);
	connections.push(connection);
	return connection;
}

function get(port: number, path = "/x"): Request {
	return new Request(`http://127.0.0.1:${port}${path}`);
}

test("parses status, headers and a Content-Length body", async () => {
	const { port, requests } = await rawServer(
		() =>
			"HTTP/1.1 201 Created\r\nContent-Type: text/plain\r\nX-Two: a\r\nX-Two: b\r\nContent-Length: 5\r\n\r\nhello"
	);
	const connection = await dial(port);
	const response = await connection.send(get(port, "/p?q=1"), {
		close: false,
	});
	expect(response.status).toBe(201);
	expect(response.statusText).toBe("Created");
	expect(response.headers.get("x-two")).toBe("a, b");
	expect(await response.text()).toBe("hello");
	expect(requests[0]?.head.split("\r\n")[0]).toBe("GET /p?q=1 HTTP/1.1");
	expect(requests[0]?.head).toContain("Connection: keep-alive");
	expect(connection.open).toBe(true);
});

test("decodes a chunked body with extensions and trailers", async () => {
	const { port } = await rawServer((_request, index) =>
		index === 0
			? "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4;ext=1\r\nWiki\r\n6\r\npedia \r\nE\r\nin \r\n\r\nchunks.\r\n0\r\nX-Trailer: t\r\n\r\n"
			: "HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nnext"
	);
	const connection = await dial(port);
	const response = await connection.send(get(port), { close: false });
	expect(await response.text()).toBe("Wikipedia in \r\n\r\nchunks.");
	expect(connection.open).toBe(true);
	// The trailer section is fully consumed, so the next response on the same
	// socket starts at its own status line.
	const next = await connection.send(get(port), { close: false });
	expect(next.status).toBe(200);
	expect(await next.text()).toBe("next");
});

test("reads a close-delimited body until the peer closes", async () => {
	const { port } = await rawServer((_request, _index, socket) => {
		socket.end("HTTP/1.1 200 OK\r\n\r\nuntil-close");
		return null;
	});
	const connection = await dial(port);
	const response = await connection.send(get(port), { close: false });
	expect(await response.text()).toBe("until-close");
	expect(connection.open).toBe(false);
});

test("serialises a POST body with its Content-Length and strips managed headers", async () => {
	const { port, requests } = await rawServer(
		() => "HTTP/1.1 204 No Content\r\n\r\n"
	);
	const connection = await dial(port);
	const response = await connection.send(
		new Request(`http://127.0.0.1:${port}/api`, {
			body: '{"a":1}',
			headers: { "x-custom": "yes", "transfer-encoding": "gzip" },
			method: "POST",
		}),
		{ close: true }
	);
	expect(response.status).toBe(204);
	expect(response.body).toBeNull();
	const head = requests[0]?.head ?? "";
	expect(head).toContain("Content-Length: 7");
	expect(head).toContain("x-custom: yes");
	expect(head).toContain("Connection: close");
	expect(head.toLowerCase()).not.toContain("transfer-encoding");
	expect(requests[0]?.body).toBe('{"a":1}');
	expect(connection.open).toBe(false);
});

test("carries sequential requests on one socket", async () => {
	const { port, requests, sockets } = await rawServer(
		(_request, index) => `HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nr${index}`
	);
	const connection = await dial(port);
	const first = await connection.send(get(port, "/one"), { close: false });
	// A second request before the first body is read is refused.
	await expect(
		connection.send(get(port, "/early"), { close: false })
	).rejects.toThrow("not available");
	expect(await first.text()).toBe("r0");
	const second = await connection.send(get(port, "/two"), { close: false });
	expect(await second.text()).toBe("r1");
	expect(sockets).toHaveLength(1);
	expect(requests.map((request) => request.head.split(" ")[1])).toEqual([
		"/one",
		"/two",
	]);
});

test("rejects a conflicting or non-numeric Content-Length", async () => {
	for (const value of ["5, 6", "abc", "-1"]) {
		const { port } = await rawServer(
			() => `HTTP/1.1 200 OK\r\nContent-Length: ${value}\r\n\r\nhello`
		);
		const connection = await dial(port);
		await expect(connection.send(get(port), { close: false })).rejects.toThrow(
			"bad content-length"
		);
		expect(connection.open).toBe(false);
	}
});

test("rejects a bad chunk size and a bad chunk terminator", async () => {
	const badSize = await rawServer(
		() => "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\nabc\r\n"
	);
	const sizeConnection = await dial(badSize.port);
	const sizeResponse = await sizeConnection.send(get(badSize.port), {
		close: false,
	});
	await expect(sizeResponse.text()).rejects.toThrow("bad chunk size");
	expect(sizeConnection.open).toBe(false);

	const badEnd = await rawServer(
		() =>
			"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabcXX\r\n0\r\n\r\n"
	);
	const endConnection = await dial(badEnd.port);
	const endResponse = await endConnection.send(get(badEnd.port), {
		close: false,
	});
	await expect(endResponse.text()).rejects.toThrow("bad chunk terminator");
	expect(endConnection.open).toBe(false);
});

test("rejects an unsupported transfer-encoding, a bad status line and a folded header", async () => {
	const gzip = await rawServer(
		() => "HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n"
	);
	const gzipConnection = await dial(gzip.port);
	await expect(
		gzipConnection.send(get(gzip.port), { close: false })
	).rejects.toThrow("unsupported transfer-encoding");

	const status = await rawServer(() => "HTTP/2 200 OK\r\n\r\n");
	const statusConnection = await dial(status.port);
	await expect(
		statusConnection.send(get(status.port), { close: false })
	).rejects.toThrow("bad status line");
	// An obsolete folded continuation line is refused, not merged.
	const folded = await rawServer(
		() => "HTTP/1.1 200 OK\r\nX-A: 1\r\n X-B: 2\r\nContent-Length: 0\r\n\r\n"
	);
	const foldedConnection = await dial(folded.port);
	await expect(
		foldedConnection.send(get(folded.port), { close: false })
	).rejects.toThrow("bad header line");
});

test("skips 1xx interim responses and refuses a protocol upgrade", async () => {
	const interim = await rawServer(
		() =>
			"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 102 Processing\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"
	);
	const interimConnection = await dial(interim.port);
	const response = await interimConnection.send(get(interim.port), {
		close: false,
	});
	expect(response.status).toBe(200);
	expect(await response.text()).toBe("ok");

	const upgrade = await rawServer(
		() => "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n"
	);
	const upgradeConnection = await dial(upgrade.port);
	await expect(
		upgradeConnection.send(get(upgrade.port), { close: false })
	).rejects.toThrow("unexpected protocol upgrade");
	expect(upgradeConnection.open).toBe(false);
});

test("a response Connection: close closes the socket after the body", async () => {
	// The server keeps its side open, so only the client can close it.
	const { port } = await rawServer(
		() => "HTTP/1.1 200 OK\r\nConnection: Close\r\nContent-Length: 2\r\n\r\nok"
	);
	const connection = await dial(port);
	const response = await connection.send(get(port), { close: false });
	expect(connection.open).toBe(true);
	expect(await response.text()).toBe("ok");
	expect(connection.open).toBe(false);
});

test("rejects an oversized response head", async () => {
	const { port } = await rawServer(
		() => `HTTP/1.1 200 OK\r\nX-Big: ${"a".repeat(70 * 1024)}`
	);
	const connection = await dial(port);
	await expect(connection.send(get(port), { close: false })).rejects.toThrow(
		"header section too large"
	);
	expect(connection.open).toBe(false);
});

test("a body cut short by the peer is a protocol error", async () => {
	const { port } = await rawServer((_request, _index, socket) => {
		socket.end("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort");
		return null;
	});
	const connection = await dial(port);
	const response = await connection.send(get(port), { close: false });
	await expect(response.text()).rejects.toThrow(
		"connection closed before the body ended"
	);
});

test("aborting the signal closes the socket and rejects with the reason", async () => {
	const { port, requests } = await rawServer(() => null);
	const connection = await dial(port);
	const controller = new AbortController();
	const pending = connection.send(get(port), {
		close: false,
		signal: controller.signal,
	});
	// Wait until the server has the request, so the client is reading.
	for (let tries = 0; requests.length === 0 && tries < 200; tries++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
	expect(requests).toHaveLength(1);
	const reason = new Error("user cancelled");
	controller.abort(reason);
	await expect(pending).rejects.toBe(reason);
	expect(connection.open).toBe(false);
});

test("dialLoopback rejects an already-aborted signal without connecting", async () => {
	const { port, sockets } = await rawServer(() => null);
	const controller = new AbortController();
	const reason = new Error("stop");
	controller.abort(reason);
	await expect(dialLoopback("127.0.0.1", port, controller.signal)).rejects.toBe(
		reason
	);
	expect(sockets).toHaveLength(0);
});
