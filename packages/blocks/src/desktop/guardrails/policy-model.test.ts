import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	agentUnsupportedFields,
	applyPolicyFirewallPatch,
	emptyPolicyRules,
	formatPreviewValue,
	microFromUsd,
	POLICY_BUDGET_WINDOWS,
	POLICY_LOCKABLE_FIELDS,
	POLICY_PERMISSION_ACTIONS,
	POLICY_PERMISSION_EFFECTS,
	POLICY_SCOPE_KINDS,
	type PolicyView,
	parsePolicyList,
	policiesWithAssignment,
	policiesWithoutAssignment,
	policyErrorHint,
	policyFirewallCtx,
	policyRulesAreEmpty,
	previewFieldLabel,
	scopeChipLabel,
	usdFromMicro,
} from "./policy-model.ts";

function constList(text: string, name: string): string[] {
	const match = new RegExp(
		`export const ${name} = \\[([^\\]]*)\\] as const`
	).exec(text);
	if (!match?.[1]) {
		throw new Error(`missing ${name}`);
	}
	return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1] ?? "");
}

function modelSource(file: string): string {
	return readFileSync(
		new URL(`../../../../db/src/models/${file}`, import.meta.url),
		"utf8"
	);
}

describe("enum copies", () => {
	test("stay in step with the guardrail policy model", () => {
		const source = modelSource("guardrail-policy.model.ts");
		expect<string[]>([...POLICY_SCOPE_KINDS]).toEqual(
			constList(source, "GUARDRAIL_SCOPE_KINDS")
		);
		expect<string[]>([...POLICY_PERMISSION_ACTIONS]).toEqual(
			constList(source, "GUARDRAIL_PERMISSION_ACTIONS")
		);
		expect<string[]>([...POLICY_PERMISSION_EFFECTS]).toEqual(
			constList(source, "GUARDRAIL_PERMISSION_EFFECTS")
		);
		expect<string[]>([...POLICY_LOCKABLE_FIELDS]).toEqual(
			constList(source, "GUARDRAIL_LOCKABLE_FIELDS")
		);
	});

	test("budget windows match the limits model", () => {
		expect<string[]>([...POLICY_BUDGET_WINDOWS]).toEqual(
			constList(modelSource("org-limits.model.ts"), "LIMIT_BUDGET_WINDOWS")
		);
	});
});

describe("policy firewall rules", () => {
	test("switches survive only when turned on", () => {
		const next = applyPolicyFirewallPatch(
			{ enabled: true, redact_pii: true },
			{ enabled: false, redact_pii: null, scan_inbound: true }
		);
		expect(next).toEqual({ scan_inbound: true });
	});

	test("an empty pattern list and an inherited action are dropped", () => {
		const next = applyPolicyFirewallPatch(
			{
				custom_patterns: [{ kind: "pii", name: "ticket", regex: "T-[0-9]+" }],
				policy: "block",
			},
			{ custom_patterns: [], policy: null }
		);
		expect(next).toEqual({});
	});

	test("the editor context is add-only and never names the base", () => {
		let emitted: unknown = null;
		const ctx = policyFirewallCtx({
			disabled: false,
			firewall: { enabled: true },
			onChange: (next) => {
				emitted = next;
			},
			policyKey: "gp_1",
		});
		expect(ctx.addOnly).toBe(true);
		expect(ctx.inheritedUnknown).toBe(true);
		ctx.setOverlayField({ enabled: false, scan_outbound: true });
		expect(emitted).toEqual({ scan_outbound: true });
	});
});

describe("policy rules", () => {
	test("an empty policy tightens nothing", () => {
		expect(policyRulesAreEmpty(emptyPolicyRules())).toBe(true);
		expect(
			policyRulesAreEmpty({
				...emptyPolicyRules(),
				firewall: { custom_patterns: [] },
			})
		).toBe(true);
		expect(
			policyRulesAreEmpty({ ...emptyPolicyRules(), zeroDataRetention: true })
		).toBe(false);
	});

	test("agent assignments carry firewall settings and evaluators only", () => {
		expect(
			agentUnsupportedFields(
				{
					...emptyPolicyRules(),
					evaluators: [{ id: "hazard" }],
					firewall: { enabled: true },
				},
				[]
			)
		).toEqual([]);
		expect(
			agentUnsupportedFields(
				{ ...emptyPolicyRules(), approvedModels: ["openai/gpt-5"] },
				["approvedModels"]
			)
		).toEqual(["approved models", "locked fields"]);
	});

	test("lists split on commas and newlines and drop duplicates", () => {
		expect(parsePolicyList("a, b,\nb ,, c")).toEqual(["a", "b", "c"]);
	});

	test("dollar amounts round-trip through microdollars", () => {
		expect(microFromUsd("12.5")).toBe(12_500_000);
		expect(microFromUsd("")).toBeNull();
		expect(microFromUsd("-1")).toBeNull();
		expect(microFromUsd("ten")).toBeNull();
		expect(usdFromMicro(30_000_000)).toBe("30");
	});
});

describe("labels", () => {
	test("scope chips use the host's names and fall back to the id", () => {
		const options = {
			agent: [],
			key: [],
			member: [],
			org: [],
			team: [{ id: "t1", label: "Platform" }],
		};
		expect(scopeChipLabel({ id: "o1", kind: "org" }, options)).toBe(
			"Organization"
		);
		expect(scopeChipLabel({ id: "t1", kind: "team" }, options)).toBe(
			"Team: Platform"
		);
		expect(scopeChipLabel({ id: "k9", kind: "key" }, options)).toBe("Key: k9");
	});

	test("preview values read as plain words", () => {
		expect(formatPreviewValue(null)).toBe("Not set");
		expect(formatPreviewValue(true)).toBe("On");
		expect(formatPreviewValue("sanitize")).toBe("Sanitize");
		expect(formatPreviewValue([])).toBe("No restriction");
		expect(formatPreviewValue(["<deny-all>"])).toBe("Nothing allowed");
		expect(formatPreviewValue({ usdMicro: 30_000_000, window: "daily" })).toBe(
			"$30 daily"
		);
		expect(
			formatPreviewValue({ enabled: true, id: "pii", inlineAction: "block" })
		).toBe("pii: Block");
		expect(previewFieldLabel("firewall.redact_pii")).toBe("Redact PII");
		expect(previewFieldLabel("evaluators.pii")).toBe("Evaluator: pii");
	});

	test("refusal codes map to guidance and unknown codes defer to the server", () => {
		expect(policyErrorHint("version_conflict")).toContain("Reload");
		expect(policyErrorHint("invalid_regex_pattern")).toContain("lookarounds");
		expect(policyErrorHint("something_else")).toBeNull();
		expect(policyErrorHint(null)).toBeNull();
	});
});

describe("assignment list updates", () => {
	function named(id: string, assignments: PolicyView["assignments"]) {
		return {
			assignments,
			description: "",
			id,
			locked: [],
			name: id,
			rules: emptyPolicyRules(),
			version: 1,
		} satisfies PolicyView;
	}
	const org = { id: "o1", kind: "org" } as const;

	test("an assignment joins its policy", () => {
		const next = policiesWithAssignment(
			[named("gp_1", []), named("gp_2", [])],
			{ id: "ga_1", policyId: "gp_1", scope: org }
		);
		expect(next[0]?.assignments).toEqual([
			{ id: "ga_1", policyId: "gp_1", scope: org },
		]);
		expect(next[1]?.assignments).toEqual([]);
	});

	test("a replace moves the scope off the policy that held it", () => {
		const next = policiesWithAssignment(
			[
				named("gp_1", []),
				named("gp_2", [{ id: "ga_9", policyId: "gp_2", scope: org }]),
			],
			{ id: "ga_9", policyId: "gp_1", scope: org }
		);
		expect(next[0]?.assignments).toEqual([
			{ id: "ga_9", policyId: "gp_1", scope: org },
		]);
		expect(next[1]?.assignments).toEqual([]);
	});

	test("keeps only the view fields of a wire assignment", () => {
		const wire = {
			createdAt: "2026-10-24T00:00:00.000Z",
			id: "ga_1",
			policyId: "gp_1",
			scope: org,
		};
		const [only] = policiesWithAssignment([named("gp_1", [])], wire);
		expect(only?.assignments).toEqual([
			{ id: "ga_1", policyId: "gp_1", scope: org },
		]);
	});

	test("a removal drops the assignment and leaves other policies alone", () => {
		const untouched = named("gp_2", []);
		const next = policiesWithoutAssignment(
			[
				named("gp_1", [{ id: "ga_1", policyId: "gp_1", scope: org }]),
				untouched,
			],
			"ga_1"
		);
		expect(next[0]?.assignments).toEqual([]);
		expect(next[1]).toBe(untouched);
	});
});
