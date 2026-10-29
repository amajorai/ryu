import { expect, test } from "bun:test";
import { createFetchFixture } from "../../test-fixtures/native-fetch-fixture.ts";
import {
	analyzeAgentOptimizations,
	applyAgentOptimization,
	formatMicroUsd,
	formatShare,
} from "./optimizer.ts";

const target = { token: "node-token", url: "http://127.0.0.1:7980" };

async function captureRequest<TResult>(
	call: () => Promise<TResult>
): Promise<{ init: RequestInit | undefined; url: string }> {
	const originalFetch = globalThis.fetch;
	let url = "";
	let init: RequestInit | undefined;
	globalThis.fetch = createFetchFixture(
		originalFetch,
		async (input, requestInit) => {
			url = String(input);
			init = requestInit;
			return new Response(
				JSON.stringify({
					lastAnalysis: null,
					readiness: { ready: true, required: 10, sessions: 12 },
					recommendations: [],
					recommendation: {
						id: "opt_1",
						agentId: "support",
						kind: "model",
						status: "applied",
						createdAt: "2026-10-09T00:00:00Z",
						title: "Use a cheaper model",
						summary: "Equivalent quality",
						change: { type: "set_model", from: "gpt-4o", to: "gpt-4o-mini" },
						evidence: { cases: 1, sessions: 12, verified: true },
					},
				}),
				{ headers: { "content-type": "application/json" }, status: 200 }
			);
		}
	);
	try {
		await call();
	} finally {
		globalThis.fetch = originalFetch;
	}
	return { init, url };
}

test("analyze posts candidate models for the encoded agent id", async () => {
	const { init, url } = await captureRequest(() =>
		analyzeAgentOptimizations(target, "acp:claude", {
			candidateModels: ["gpt-4o-mini"],
		})
	);
	expect(url).toBe(
		"http://127.0.0.1:7980/api/agents/acp%3Aclaude/optimizations/analyze"
	);
	expect(init?.method).toBe("POST");
	expect(JSON.parse(String(init?.body))).toEqual({
		candidateModels: ["gpt-4o-mini"],
	});
});

test("apply targets one recommendation", async () => {
	const { init, url } = await captureRequest(() =>
		applyAgentOptimization(target, "support", "opt_1")
	);
	expect(url).toBe(
		"http://127.0.0.1:7980/api/agents/support/optimizations/opt_1/apply"
	);
	expect(init?.method).toBe("POST");
});

test("formatters keep unknown values visible", () => {
	expect(formatMicroUsd(1234)).toBe("$0.0012");
	expect(formatMicroUsd(2_500_000)).toBe("$2.50");
	expect(formatMicroUsd(null)).toBe("unpriced");
	expect(formatShare(0.845)).toBe("85%");
	expect(formatShare(undefined)).toBe("not scored");
});
