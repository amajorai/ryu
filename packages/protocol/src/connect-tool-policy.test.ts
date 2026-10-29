import { describe, expect, test } from "bun:test";
import {
	CONNECT_TOOL_POLICY_CONTRACT_VERSION,
	decideTool,
	deniedUrlRule,
	lifecycleEntrySchema,
	lifecycleProblem,
	POLICY_REFUSAL_STATUS,
	policyFeedSchema,
	tenantPolicyProblem,
	tenantPolicySchema,
} from "./connect-tool-policy.ts";
import cases from "./fixtures/connect-tool-policy-cases-v1.json" with {
	type: "json",
};

const policy = tenantPolicySchema.parse(cases.policy);
const lifecycle = lifecycleEntrySchema.array().parse(cases.lifecycle);

function problemOf(kind: string, raw: unknown): string | null {
	const value =
		raw === "$policy"
			? cases.policy
			: raw === "$lifecycle"
				? cases.lifecycle
				: raw;
	if (kind === "tenant") {
		const parsed = tenantPolicySchema.safeParse(value);
		return parsed.success ? tenantPolicyProblem(parsed.data) : "shape";
	}
	const parsed = lifecycleEntrySchema.array().safeParse(value);
	return parsed.success ? lifecycleProblem(parsed.data) : "shape";
}

describe("connect tool policy shared cases", () => {
	test("the case file matches this contract version", () => {
		expect(cases.version).toBe(CONNECT_TOOL_POLICY_CONTRACT_VERSION);
	});

	for (const shared of cases.validation) {
		test(`validation: ${shared.name}`, () => {
			const problem = problemOf(shared.kind, shared.value);
			if (shared.problem === null) {
				expect(problem).toBeNull();
			} else {
				expect(problem ?? "").toContain(shared.problem);
			}
		});
	}

	for (const shared of cases.tools) {
		test(`tool: ${shared.name}`, () => {
			const decision = decideTool({
				lifecycle: lifecycle.find((entry) => entry.tool === shared.input.tool),
				policy,
				teamId: shared.input.teamId,
				tool: shared.input.tool,
				version: shared.input.version,
			});
			expect(JSON.parse(JSON.stringify(decision))).toStrictEqual(
				shared.expected
			);
		});
	}

	for (const shared of cases.urls) {
		test(`url: ${shared.name}`, () => {
			expect(
				deniedUrlRule(policy, shared.teamId, shared.method, new URL(shared.url))
					?.id ?? null
			).toBe(shared.rule);
		});
	}
});

describe("connect tool policy invariants", () => {
	test("only a version mismatch keeps a refused tool listed", () => {
		for (const shared of cases.tools) {
			const decision = decideTool({
				lifecycle: lifecycle.find((entry) => entry.tool === shared.input.tool),
				policy,
				teamId: shared.input.teamId,
				tool: shared.input.tool,
				version: shared.input.version,
			});
			if (decision.refusal !== null) {
				expect(decision.listed).toBe(
					decision.refusal === "tool_version_mismatch"
				);
			}
		}
	});

	test("every refusal has a client-error status", () => {
		for (const status of Object.values(POLICY_REFUSAL_STATUS)) {
			expect(status).toBeGreaterThanOrEqual(400);
			expect(status).toBeLessThan(500);
		}
	});

	test("the feed refuses unknown fields and a short version", () => {
		const feed = {
			generatedAt: "2026-10-21T00:00:00.000Z",
			lifecycle,
			tenants: [policy],
			ttlSeconds: 60,
			type: "connect.policy",
			version: "a".repeat(64),
		};
		expect(policyFeedSchema.safeParse(feed).success).toBe(true);
		expect(policyFeedSchema.safeParse({ ...feed, extra: 1 }).success).toBe(
			false
		);
		expect(
			policyFeedSchema.safeParse({ ...feed, version: "abc" }).success
		).toBe(false);
	});
});
