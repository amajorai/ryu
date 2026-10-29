import { ProviderState } from "./provider-connections-native-http-state.ts";
export function startProviderConnectionsProofHost(
	port = 5691,
	origin = "http://127.0.0.1:5690"
) {
	const providerState = new ProviderState(origin);
	const preferences: Record<string, string> = {};
	const calls: Array<{
		method: string;
		path: string;
		body: unknown;
		status: number;
	}> = [];
	const unexpected: string[] = [];
	const known = [
		"/api/agents",
		"/api/auth/get-session",
		"/api/preferences/entitlement-active",
		"/api/preferences/managed-inference-entitled",
	];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		async fetch(request: Request): Promise<Response> {
			const providerResponse = await providerState.handle(request);
			if (providerResponse) {
				return providerResponse;
			}
			const url = new URL(request.url);
			const output = (body: unknown, status = 200) =>
				Response.json(body, { status, headers: providerState.headers() });
			if (url.pathname === "/__state" && request.method === "GET") {
				return output({ calls, unexpected, preferences });
			}
			if (
				request.method === "OPTIONS" &&
				known.includes(url.pathname) &&
				request.headers.get("origin") === origin
			) {
				return new Response(null, {
					status: 204,
					headers: providerState.headers(),
				});
			}
			if (
				url.pathname === "/api/auth/get-session" &&
				request.method === "GET"
			) {
				return output(null);
			}
			const body: unknown = ["POST", "PUT"].includes(request.method)
				? await request.json()
				: null;
			if (
				request.headers.get("authorization") !==
					"Bearer provider-retry-owned-token" ||
				request.headers.get("x-ryu-user-jwt") !== null ||
				!known.includes(url.pathname)
			) {
				unexpected.push(`${request.method} ${url.href}`);
				return output(
					{ error: { message: "Unknown or unauthenticated fixture request" } },
					403
				);
			}
			if (request.method === "GET" && url.pathname === "/api/agents") {
				calls.push({
					method: "GET",
					path: url.pathname,
					body: null,
					status: 200,
				});
				return output({ agents: [] });
			}
			if (
				request.method === "PUT" &&
				[
					"/api/preferences/entitlement-active",
					"/api/preferences/managed-inference-entitled",
				].includes(url.pathname) &&
				body &&
				typeof body === "object" &&
				Object.keys(body).length === 1 &&
				"value" in body &&
				typeof body.value === "string" &&
				["true", "false"].includes(body.value)
			) {
				const key = url.pathname.split("/").at(-1);
				if (!key) {
					throw new Error("Known preference key missing");
				}
				preferences[key] = body.value;
				calls.push({ method: "PUT", path: url.pathname, body, status: 200 });
				return output({ ok: true, key });
			}
			unexpected.push(`${request.method} ${url.href} ${JSON.stringify(body)}`);
			return output(
				{ error: { message: "Unsupported fixture method/body" } },
				400
			);
		},
	});
	return {
		server,
		stop() {
			for (const gate of providerState.holds.values()) {
				gate.release();
			}
			server.stop(true);
		},
	};
}
if (import.meta.main) {
	const host = startProviderConnectionsProofHost();
	const stop = () => {
		host.stop();
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}
