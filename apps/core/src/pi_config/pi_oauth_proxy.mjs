// Ryu OAuth bridge: send a vendor flow's requests through a provider route.
//
// Core sets RYU_OAUTH_PROXY_URL (an HTTP proxy with its credential) when a
// provider's traffic must leave through the owner's desktop. Every pi-ai flow
// calls the global `fetch`, so the bridge swaps it for one that always uses the
// proxy. Node's own fetch honours proxy variables only on recent releases, so
// on Node the request is tunnelled here; Bun's fetch takes the proxy directly.
// A failed tunnel fails the request rather than leaving from this host.
//
// `include_str!`-embedded in Core and written beside the bridge as
// `ryu-oauth-proxy.mjs`; tested by `pi_oauth_proxy.test.mjs`.

import { request as httpRequest } from "node:http";
import { connect as tlsConnect } from "node:tls";

/** Open a CONNECT tunnel to `host:port` through `proxy`. */
export function openTunnel(proxy, host, port, signal) {
	const credential = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
	return new Promise((resolve, reject) => {
		const connect = httpRequest({
			headers: {
				Host: `${host}:${port}`,
				"Proxy-Authorization": `Basic ${Buffer.from(credential).toString("base64")}`,
			},
			host: proxy.hostname,
			method: "CONNECT",
			path: `${host}:${port}`,
			port: proxy.port,
			signal,
		});
		connect.once("connect", (response, socket) => {
			if (response.statusCode === 200) {
				resolve(socket);
				return;
			}
			socket.destroy();
			reject(
				new Error(
					`provider route refused the connection (${response.statusCode})`
				)
			);
		});
		connect.once("error", reject);
		connect.end();
	});
}

/**
 * A `fetch` that sends every HTTPS request through `proxy`. `tlsOptions` is for
 * tests that trust their own certificate; certificates are always verified.
 */
export function tunnelledFetch(proxy, tlsOptions = {}) {
	return async (input, init) => {
		const request = new Request(input, init);
		const target = new URL(request.url);
		if (target.protocol !== "https:") {
			throw new TypeError("the provider route only carries HTTPS requests");
		}
		const port = Number(target.port || 443);
		const body = request.body
			? Buffer.from(await request.arrayBuffer())
			: undefined;
		const tunnel = await openTunnel(
			proxy,
			target.hostname,
			port,
			request.signal
		);
		const secure = await new Promise((resolve, reject) => {
			const socket = tlsConnect(
				{
					...tlsOptions,
					ALPNProtocols: ["http/1.1"],
					servername: target.hostname,
					socket: tunnel,
				},
				() => resolve(socket)
			);
			socket.once("error", reject);
		});
		const headers = Object.fromEntries(request.headers);
		if (body) {
			headers["content-length"] = String(body.length);
		}
		return await new Promise((resolve, reject) => {
			const outgoing = httpRequest(
				{
					createConnection: () => secure,
					headers: { ...headers, host: target.host },
					method: request.method,
					path: `${target.pathname}${target.search}`,
					signal: request.signal,
				},
				(response) => {
					const chunks = [];
					response.on("data", (chunk) => chunks.push(chunk));
					response.once("error", reject);
					response.once("end", () => {
						const status = response.statusCode ?? 502;
						const empty = status === 204 || status === 304;
						const responseHeaders = new Headers();
						for (const [name, value] of Object.entries(response.headers)) {
							for (const item of [value].flat()) {
								if (item !== undefined) {
									responseHeaders.append(name, item);
								}
							}
						}
						resolve(
							new Response(empty ? null : Buffer.concat(chunks), {
								headers: responseHeaders,
								status,
								statusText: response.statusMessage,
							})
						);
					});
				}
			);
			outgoing.once("error", reject);
			outgoing.end(body);
		});
	};
}

/**
 * The `fetch` the bridge installs for `proxyUrl`: Bun's native proxy option, or
 * the tunnel on Node.
 */
export function proxiedFetch(
	proxyUrl,
	{ isBun = Boolean(globalThis.Bun), nativeFetch = globalThis.fetch } = {}
) {
	if (isBun) {
		return (input, init) => {
			// Same rule as the tunnel: the route carries HTTPS only, so a plain
			// HTTP URL never leaves through it unencrypted.
			const target = new URL(new Request(input, init).url);
			if (target.protocol !== "https:") {
				throw new TypeError("the provider route only carries HTTPS requests");
			}
			return nativeFetch(input, { ...init, proxy: proxyUrl });
		};
	}
	return tunnelledFetch(new URL(proxyUrl));
}
