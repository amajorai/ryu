import type { ModelInsight } from "../src/lib/api/model-insight.ts";

const origin = "http://127.0.0.1:5610";
export function createModelInsightAuthorityFixture() {
	interface Call {
		authorization: string | null;
		id: number;
		insight: ModelInsight;
		path: string;
		source: "A" | "B";
		status: "pending" | "accepted";
		userJwt: string | null;
	}
	const calls: Call[] = [];
	const unexpected: string[] = [];
	const held = new Map<number, () => void>();
	let holdNext: "A" | "B" | null = null;
	const response = (body: unknown, status = 200) =>
		Response.json(body, {
			status,
			headers: {
				"access-control-allow-origin": origin,
				"access-control-allow-methods": "GET, OPTIONS",
				"access-control-allow-headers":
					"content-type, authorization, x-ryu-user-jwt, x-ryu-client-id, x-ryu-client-label, x-ryu-surface",
			},
		});
	async function fetch(request: Request) {
		const url = new URL(request.url);
		if (url.pathname === "/__authority/state" && request.method === "GET") {
			return response({ calls, unexpected, held: [...held.keys()] });
		}
		if (
			url.pathname === "/__authority/control" &&
			request.method === "POST" &&
			request.headers.get("x-insight-proof-control") === "owned-local-fixture"
		) {
			const body = await request.json();
			if (body.action === "reset" && Object.keys(body).length === 1) {
				for (const release of held.values()) {
					release();
				}
				held.clear();
				calls.length = 0;
				unexpected.length = 0;
				holdNext = null;
				return response({ ok: true });
			}
			if (
				body.action === "hold_next" &&
				Object.keys(body).length === 2 &&
				["A", "B"].includes(body.source)
			) {
				holdNext = body.source;
				return response({ ok: true });
			}
			if (
				body.action === "release" &&
				Object.keys(body).length === 2 &&
				typeof body.id === "number" &&
				held.has(body.id)
			) {
				held.get(body.id)?.();
				held.delete(body.id);
				return response({ ok: true });
			}
			return response({ error: "Malformed owned control" }, 409);
		}
		const path = /^\/(a|b)\/api\/models\/insight$/.exec(url.pathname);
		if (
			request.method === "OPTIONS" &&
			path &&
			request.headers.get("origin") === origin
		) {
			return new Response(null, {
				status: 204,
				headers: {
					"access-control-allow-origin": origin,
					"access-control-allow-methods": "GET, OPTIONS",
					"access-control-allow-headers":
						"content-type, authorization, x-ryu-user-jwt, x-ryu-client-id, x-ryu-client-label, x-ryu-surface",
				},
			});
		}
		const token = request.headers.get("authorization");
		const jwt = request.headers.get("x-ryu-user-jwt");
		const valid =
			path &&
			request.method === "GET" &&
			url.search === "?model=openrouter%2Fshared&provider=openrouter" &&
			request.headers.get("origin") === origin &&
			((token === "Bearer insight-node-a" &&
				(jwt === "insight-user-a" || jwt === "insight-user-b")) ||
				(token === "Bearer insight-node-b" && jwt === "insight-user-a"));
		if (!valid) {
			unexpected.push(`${request.method} ${url.pathname}${url.search}`);
			return response({ error: "Unknown finite source or authority" }, 400);
		}
		const source =
			path?.[1] === "b" ||
			token === "Bearer insight-node-b" ||
			jwt === "insight-user-b"
				? "B"
				: "A";
		const returnedA = source === "A" && calls.some((c) => c.source === "A");
		const insight: ModelInsight = {
			id: "openrouter/shared",
			name:
				source === "B"
					? "Insight B"
					: returnedA
						? "Insight returned A"
						: "Insight A",
			description:
				source === "B"
					? "Current B registry"
					: returnedA
						? "Current returned A registry"
						: "Original A registry",
			aaKeyPresent: source === "B",
			modalitiesInput: source === "B" ? ["text", "image"] : ["text"],
			modalitiesOutput: ["text"],
			source: source === "B" ? "models.dev" : "openrouter",
			costInputPer1m: source === "B" ? 9 : returnedA ? 3 : 1,
			costOutputPer1m: source === "B" ? 18 : returnedA ? 6 : 2,
		};
		const call: Call = {
			id: calls.length + 1,
			path: url.pathname + url.search,
			authorization: token,
			userJwt: jwt,
			source,
			status: "pending",
			insight,
		};
		calls.push(call);
		if (holdNext === source) {
			holdNext = null;
			await new Promise<void>((resolve) => held.set(call.id, resolve));
			held.delete(call.id);
		}
		call.status = "accepted";
		return response({ insight });
	}
	return {
		fetch,
		matches(request: Request) {
			const path = new URL(request.url).pathname;
			return (
				path.startsWith("/__authority/") ||
				/^\/(a|b)\/api\/models\/insight$/.test(path)
			);
		},
		close() {
			for (const release of held.values()) {
				release();
			}
			held.clear();
		},
	};
}
