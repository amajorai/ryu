import { expect, test } from "bun:test";
import { fetchPluginDoctor } from "./plugins.ts";

const target = { token: "node-token", url: "http://127.0.0.1:7980" };

test("fetchPluginDoctor requests the Core runtime doctor with the optional id", async () => {
	const originalFetch = globalThis.fetch;
	let requestUrl = "";
	let requestInit: RequestInit | undefined;
	globalThis.fetch = Object.assign(
		async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1]
		) => {
			requestUrl = String(input);
			requestInit = init;
			return new Response(
				JSON.stringify({
					counts: { errors: 0, info: 0, plugins: 1, warnings: 0 },
					generatedAt: "2026-10-06T00:00:00Z",
					profile: "lint",
					readOnly: true,
					rulesetVersion: "1",
					schemaVersion: "1",
					scope: "all",
					findings: [],
					plugins: [],
					score: 100,
				}),
				{ headers: { "content-type": "application/json" }, status: 200 }
			);
		},
		{ preconnect: originalFetch.preconnect }
	);

	try {
		const report = await fetchPluginDoctor(target, "com.example/mail");
		expect(report.score).toBe(100);
	} finally {
		globalThis.fetch = originalFetch;
	}

	expect(requestUrl).toBe(
		"http://127.0.0.1:7980/api/plugins/doctor?id=com.example%2Fmail"
	);
	expect(requestInit?.method).toBe("GET");
	expect(new Headers(requestInit?.headers).get("authorization")).toBe(
		"Bearer node-token"
	);
});
