import type { Plugin } from "vite";

// Deterministic loopback Core responses; no credential or vendor endpoint.
export function quotaProofApi(): Plugin {
	return {
		name: "sdk-account-quota-fixture",
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				const url = request.url ?? "";
				if (!url.startsWith("/api/pi-config/providers/")) {
					next();
					return;
				}
				response.setHeader("Content-Type", "application/json");
				if (url.endsWith("/account-pool")) {
					if (request.method === "PUT") {
						let body = "";
						request.on("data", (chunk) => {
							body += String(chunk);
						});
						request.on("end", () => response.end(body));
						return;
					}
					response.end(
						JSON.stringify({
							strategy: "manual",
							drainThresholdPercent: 90,
							accounts: {
								personal: { enabled: true, priority: 0 },
								work: { enabled: true, priority: 1 },
								disabled: { enabled: false, priority: 2 },
								quarantined: { enabled: true, priority: 3 },
							},
						})
					);
					return;
				}
				if (url.endsWith("/usage")) {
					const known = url.includes("/accounts/personal/");
					response.end(
						JSON.stringify({
							agent_id: known ? "personal" : "work",
							engine: "codex",
							available: known,
							reason: known ? null : "error",
							plan: known ? "Plus" : null,
							windows: known
								? [
										{
											label: "Session",
											used_percent: 35,
											resets_at: "2026-10-04T12:00:00Z",
											window_seconds: 18_000,
										},
									]
								: [],
						})
					);
					return;
				}
				response.statusCode = 404;
				response.end(JSON.stringify({ error: "Unknown proof endpoint" }));
			});
		},
	};
}
