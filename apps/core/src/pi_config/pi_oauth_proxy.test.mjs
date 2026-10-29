import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { proxiedFetch, tunnelledFetch } from "./pi_oauth_proxy.mjs";

const PROXY_CREDENTIAL = "ryu:se cret";

/** A throwaway certificate for `localhost`, so TLS stays verified. */
function localhostCertificate() {
	const directory = mkdtempSync(join(tmpdir(), "ryu-oauth-proxy-"));
	try {
		const result = spawnSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-days",
				"1",
				"-subj",
				"/CN=localhost",
				"-addext",
				"subjectAltName=DNS:localhost",
				"-keyout",
				join(directory, "key.pem"),
				"-out",
				join(directory, "cert.pem"),
			],
			{ stdio: "ignore" }
		);
		if (result.status !== 0) {
			throw new Error("openssl must create the test certificate");
		}
		return {
			cert: readFileSync(join(directory, "cert.pem")),
			key: readFileSync(join(directory, "key.pem")),
		};
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
}

function listen(server) {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve(server.address().port));
	});
}

describe("OAuth bridge provider route", () => {
	const certificate = localhostCertificate();
	const tunnels = [];
	let targetPort;
	let proxyPort;

	const target = createHttpsServer(certificate, (request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify({
					body,
					host: request.headers.host,
					method: request.method,
					url: request.url,
				})
			);
		});
	});
	const proxy = createHttpServer().on("connect", (request, socket) => {
		const expected = `Basic ${Buffer.from(PROXY_CREDENTIAL).toString("base64")}`;
		if (request.headers["proxy-authorization"] !== expected) {
			socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
			return;
		}
		tunnels.push(request.url);
		const upstream = connect(targetPort, "127.0.0.1", () => {
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			upstream.pipe(socket);
			socket.pipe(upstream);
		});
	});

	before(async () => {
		targetPort = await listen(target);
		proxyPort = await listen(proxy);
	});

	after(() => {
		target.close();
		proxy.close();
	});

	const proxyUrl = (credential) =>
		new URL(`http://${credential}@127.0.0.1:${proxyPort}`);

	it("tunnels a token request through the proxy with its credential", async () => {
		const fetchThroughRoute = tunnelledFetch(proxyUrl("ryu:se%20cret"), {
			ca: certificate.cert,
		});
		const response = await fetchThroughRoute(
			`https://localhost:${targetPort}/v1/oauth/token?x=1`,
			{
				body: JSON.stringify({ grant_type: "refresh_token" }),
				headers: { "Content-Type": "application/json" },
				method: "POST",
				signal: AbortSignal.timeout(5000),
			}
		);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), {
			body: '{"grant_type":"refresh_token"}',
			host: `localhost:${targetPort}`,
			method: "POST",
			url: "/v1/oauth/token?x=1",
		});
		assert.deepEqual(tunnels, [`localhost:${targetPort}`]);
	});

	it("fails instead of leaving directly when the proxy refuses", async () => {
		const fetchThroughRoute = tunnelledFetch(proxyUrl("ryu:wrong"), {
			ca: certificate.cert,
		});
		await assert.rejects(
			fetchThroughRoute(`https://localhost:${targetPort}/`),
			/refused the connection \(407\)/
		);
	});

	it("verifies the upstream certificate", async () => {
		const fetchThroughRoute = tunnelledFetch(proxyUrl("ryu:se%20cret"));
		await assert.rejects(fetchThroughRoute(`https://localhost:${targetPort}/`));
	});

	it("refuses plain HTTP", async () => {
		const fetchThroughRoute = tunnelledFetch(proxyUrl("ryu:se%20cret"));
		await assert.rejects(
			fetchThroughRoute(`http://localhost:${targetPort}/`),
			/only carries HTTPS/
		);
	});

	it("hands Bun's fetch the proxy option", async () => {
		const calls = [];
		const nativeFetch = (input, init) => {
			calls.push({ init, input });
			return Promise.resolve(new Response("ok"));
		};
		const fetchThroughRoute = proxiedFetch("http://ryu:secret@127.0.0.1:1", {
			isBun: true,
			nativeFetch,
		});
		await fetchThroughRoute("https://platform.claude.com/v1/oauth/token", {
			method: "POST",
		});
		assert.deepEqual(calls, [
			{
				init: { method: "POST", proxy: "http://ryu:secret@127.0.0.1:1" },
				input: "https://platform.claude.com/v1/oauth/token",
			},
		]);
	});

	it("refuses plain HTTP on Bun too", () => {
		const calls = [];
		const fetchThroughRoute = proxiedFetch("http://ryu:secret@127.0.0.1:1", {
			isBun: true,
			nativeFetch: (input) => {
				calls.push(input);
				return Promise.resolve(new Response("ok"));
			},
		});
		assert.throws(
			() => fetchThroughRoute("http://platform.claude.com/v1/oauth/token"),
			/only carries HTTPS/
		);
		assert.deepEqual(calls, []);
	});
});
