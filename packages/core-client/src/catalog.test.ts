import { describe, expect, it } from "bun:test";
import { fetchServices } from "./catalog.ts";
import { createFetchFixture } from "./test-support/http-fixture.ts";

describe("catalog client", () => {
	it("joins sidecar liveness onto catalog rows", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = createFetchFixture(async (input: RequestInfo | URL) => {
			const path = String(input);
			if (path.endsWith("/api/sidecar/status")) {
				return Response.json({ sidecars: [{ name: "voice", running: true }] });
			}
			return Response.json({
				sidecars: [
					{
						category: "media",
						deprecated: false,
						description: "Voice",
						display_name: "Voice",
						install_state: "installed",
						installed_version: "1",
						latest_version: "1",
						name: "voice",
						recommended: true,
					},
				],
			});
		});
		try {
			await expect(
				fetchServices({ token: null, url: "http://node", userJwt: null })
			).resolves.toEqual([
				expect.objectContaining({ name: "voice", running: true }),
			]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
