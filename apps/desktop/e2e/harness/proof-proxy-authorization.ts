import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { Plugin } from "vite";

/** A launcher-supplied capability, separate from the isolated Core owner token. */
export function proofClientCapability(): string {
	const capability = process.env.RYU_PROOF_CLIENT_TOKEN;
	if (!(capability && /^[a-zA-Z0-9_-]{43,128}$/.test(capability))) {
		throw new Error(
			"Set RYU_PROOF_CLIENT_TOKEN to a random 32-byte base64url capability before starting a live proof."
		);
	}
	return capability;
}

export function authorizedProofRequest(
	request: IncomingMessage,
	capability: string,
	origin: string
): boolean {
	const supplied = request.headers.authorization;
	const expected = `Bearer ${capability}`;
	if (
		!isNativeText(supplied) ||
		Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
		!timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
	) {
		return false;
	}
	const requestOrigin = request.headers.origin;
	if (requestOrigin !== undefined && requestOrigin !== origin) {
		return false;
	}
	const site = request.headers["sec-fetch-site"];
	return site === undefined || site === "same-origin" || site === "none";
}

export function proofProxyAuthorization(
	capability: string,
	port: number,
	routes?: readonly { methods: readonly string[]; path: RegExp }[]
): Plugin {
	return {
		name: "proof-proxy-authorization",
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				// Match the proxy's raw prefix before any URL normalization.
				if (!request.url?.startsWith("/api")) {
					next();
					return;
				}
				if (
					!authorizedProofRequest(
						request,
						capability,
						`http://127.0.0.1:${port}`
					)
				) {
					response.statusCode = 403;
					response.end("Proof authorization required");
					return;
				}
				if (routes) {
					const rawPath = request.url.split("?")[0] ?? "";
					const path = new URL(request.url, `http://127.0.0.1:${port}`)
						.pathname;
					if (
						rawPath !== path ||
						!routes.some(
							(route) =>
								route.methods.includes(request.method ?? "GET") &&
								route.path.test(path)
						)
					) {
						response.statusCode = 403;
						response.end("Route is outside this proof");
						return;
					}
				}
				next();
			});
		},
	};
}
