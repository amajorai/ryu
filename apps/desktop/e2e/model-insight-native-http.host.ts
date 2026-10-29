import type { ModelInsight } from "../src/lib/api/model-insight.ts";
import { createModelInsightAuthorityFixture } from "./model-insight-native-http-authority.ts";

const origin = "http://127.0.0.1:5610";
export function startModelInsightProofHost(port = 5611) {
	const authority = createModelInsightAuthorityFixture();
	const calls: Array<{
		method: string;
		path: string;
		authorization: string | null;
		userJwt: string | null;
		status: number;
	}> = [];
	const unexpected: string[] = [];
	const variants = new Set(["paid", "free", "missing", "refused"]);
	let releaseRefused: (() => void) | null = null;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		async fetch(request) {
			if (authority.matches(request)) {
				return authority.fetch(request);
			}
			const url = new URL(request.url);
			const headers = {
				"access-control-allow-origin": origin,
				"access-control-allow-methods": "GET, OPTIONS",
				"access-control-allow-headers":
					"content-type, authorization, x-ryu-user-jwt, x-ryu-client-id, x-ryu-client-label, x-ryu-surface",
			};
			const output = (body: unknown, status = 200) =>
				Response.json(body, { status, headers });
			if (url.pathname === "/__proof/state" && request.method === "GET") {
				return output({
					calls,
					unexpected,
					heldRefused: releaseRefused !== null,
				});
			}
			if (
				url.pathname === "/__proof/release-refused" &&
				request.method === "POST" &&
				request.headers.get("x-insight-proof-control") ===
					"owned-local-fixture" &&
				releaseRefused
			) {
				releaseRefused();
				releaseRefused = null;
				return output({ released: true });
			}
			if (
				request.method === "OPTIONS" &&
				url.pathname === "/api/models/insight" &&
				request.headers.get("origin") === origin
			) {
				return new Response(null, { status: 204, headers });
			}
			const model = url.searchParams.get("model");
			const variant = model?.split("/")[1];
			const valid =
				request.method === "GET" &&
				url.pathname === "/api/models/insight" &&
				url.searchParams.get("provider") === "openrouter" &&
				model === `openrouter/${variant}` &&
				variant !== undefined &&
				variants.has(variant) &&
				request.headers.get("authorization") ===
					"Bearer model-insight-owned-token" &&
				request.headers.get("x-ryu-user-jwt") === null;
			if (!valid) {
				unexpected.push(`${request.method} ${request.url}`);
				return output({ error: "Unexpected insight request" }, 400);
			}
			const status = variant === "refused" ? 503 : 200;
			calls.push({
				method: request.method,
				path: url.pathname + url.search,
				authorization: request.headers.get("authorization"),
				userJwt: request.headers.get("x-ryu-user-jwt"),
				status,
			});
			if (variant === "refused") {
				await new Promise<void>((resolve) => {
					releaseRefused = resolve;
				});
				return output({ error: "Finite upstream registry unavailable" }, 503);
			}
			const insight: ModelInsight = {
				id: model,
				name: `Insight ${variant}`,
				aaKeyPresent: false,
				modalitiesInput: ["text"],
				modalitiesOutput: ["text"],
				source: "openrouter",
				costInputPer1m:
					variant === "free" ? 0 : variant === "missing" ? null : 2.5,
				costOutputPer1m:
					variant === "free" ? 0 : variant === "missing" ? null : 15,
			};
			return output({ insight });
		},
	});
	return {
		server,
		stop() {
			releaseRefused?.();
			authority.close();
			server.stop(true);
		},
	};
}
if (import.meta.main) {
	const host = startModelInsightProofHost();
	const stop = () => {
		host.stop();
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	console.log(`Owned insight host ${host.server.url}`);
}
