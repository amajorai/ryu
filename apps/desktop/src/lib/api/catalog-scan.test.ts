import { expect, test } from "bun:test";
import wireFixture from "../../../../../packages/marketplace/src/catalog/fixtures/agent-audit.json" with {
	type: "json",
};
import { runCatalogScan } from "./catalog-scan.ts";

test("audit adapter preserves structured assessment and node credentials", async () => {
	const original = globalThis.fetch;
	let sent: RequestInit | undefined;
	let url = "";
	const assessment = wireFixture.assessment;
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			url = String(input);
			sent = init;
			return Response.json({
				agent_id: "selected-agent",
				model: "selected-model",
				status: "complete",
				report: "{}",
				assessment,
				auditedAt: "2026-09-09T00:00:00Z",
			});
		},
		{ preconnect: original.preconnect }
	);
	try {
		const input = {
			kind: "gateway" as const,
			id: "gateway",
			name: "Gateway doctor",
			scorecard: null,
			metadata: { doctor: { reachable: false } },
		};
		const result = await runCatalogScan(
			{ url: "http://127.0.0.1:9876", token: "test-only" },
			input
		);
		expect(url).toBe("http://127.0.0.1:9876/api/catalog/scan");
		expect(sent?.method).toBe("POST");
		expect(new Headers(sent?.headers).get("authorization")).toBe(
			"Bearer test-only"
		);
		expect(JSON.parse(String(sent?.body))).toEqual({
			...input,
			execution: "agent",
		});
		expect(JSON.stringify(result.assessment)).toBe(JSON.stringify(assessment));
		expect(result.agentId).toBe("selected-agent");
		expect(result.model).toBe("selected-model");
	} finally {
		globalThis.fetch = original;
	}
});

test("audit errors propagate for visible retry instead of a fabricated report", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = Object.assign(
		async () =>
			Response.json({ error: "Provider unavailable" }, { status: 502 }),
		{ preconnect: original.preconnect }
	);
	try {
		await expect(
			runCatalogScan(
				{ url: "http://127.0.0.1:9876", token: "test-only" },
				{ kind: "agent", id: "draft", name: "Draft agent", scorecard: null }
			)
		).rejects.toThrow("Provider unavailable");
	} finally {
		globalThis.fetch = original;
	}
});
