import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PolicyList } from "./policy-list.tsx";
import {
	emptyPolicyRules,
	PLATFORM_POLICY_LABEL,
	type PolicyView,
	UNASSIGNED_POLICY_COPY,
} from "./policy-model.ts";
import { PolicyPreview } from "./policy-preview.tsx";
import { PolicyRulesEditor } from "./policy-rules-editor.tsx";

const options = {
	agent: [],
	key: [{ id: "k1", label: "CI key" }],
	member: [],
	org: [{ id: "o1", label: "Acme" }],
	team: [],
};

function policy(overrides: Partial<PolicyView>): PolicyView {
	return {
		assignments: [],
		description: "",
		id: "gp_1",
		locked: [],
		name: "Baseline",
		rules: emptyPolicyRules(),
		version: 1,
		...overrides,
	};
}

describe("PolicyList", () => {
	test("says an unassigned policy enforces nothing", () => {
		const html = renderToStaticMarkup(
			<PolicyList
				onOpen={() => undefined}
				policies={[policy({})]}
				scopeOptions={options}
			/>
		);
		expect(html).toContain(UNASSIGNED_POLICY_COPY);
	});

	test("shows a chip per assignment", () => {
		const html = renderToStaticMarkup(
			<PolicyList
				onOpen={() => undefined}
				policies={[
					policy({
						assignments: [
							{
								id: "ga_1",
								policyId: "gp_1",
								scope: { id: "o1", kind: "org" },
							},
							{
								id: "ga_2",
								policyId: "gp_1",
								scope: { id: "k1", kind: "key" },
							},
						],
					}),
				]}
				scopeOptions={options}
			/>
		);
		expect(html).toContain("Organization");
		expect(html).toContain("Key: CI key");
		expect(html).not.toContain(UNASSIGNED_POLICY_COPY);
	});
});

describe("PolicyPreview", () => {
	test("labels platform rows and shows which layer set each value", () => {
		const html = renderToStaticMarkup(
			<PolicyPreview
				preview={{
					eligible: {
						models: { allowed: [], restricted: true },
						providers: { allowed: ["anthropic"], restricted: true },
					},
					fields: [
						{
							field: "approvedModels",
							sources: [
								{
									layer: "team",
									locked: false,
									origin: "guardrail_policy",
									policyId: "gp_1",
									policyName: "Baseline",
									policyVersion: 2,
									value: ["anthropic/claude-haiku"],
								},
							],
							value: ["anthropic/claude-haiku"],
						},
						{
							field: "firewall.enabled",
							sources: [
								{
									layer: "platform",
									locked: true,
									origin: "platform_floor",
									value: true,
								},
							],
							value: true,
						},
						{ field: "firewall.scan_outbound", sources: [], value: null },
					],
					notes: [
						"Firewall switches left unset follow the node's own settings.",
					],
					warnings: ["no_models_eligible"],
					zeroDataRetention: { required: true, sources: [] },
				}}
			/>
		);
		expect(html).toContain("Team: Baseline v2");
		expect(html).toContain(PLATFORM_POLICY_LABEL);
		expect(html).toContain("No model is eligible");
		expect(html).toContain("Required");
		expect(html).not.toContain("Scan outbound");
	});
});

describe("PolicyRulesEditor", () => {
	test("renders every rule group with the policy firewall in add-only mode", () => {
		const html = renderToStaticMarkup(
			<PolicyRulesEditor
				locked={["approvedModels"]}
				onChange={() => undefined}
				onLockedChange={() => undefined}
				policyKey="gp_1"
				value={{
					...emptyPolicyRules(),
					approvedModels: ["openai/gpt-5"],
					permissions: [{ action: "tool.call", effect: "deny", resource: "*" }],
				}}
			/>
		);
		for (const title of [
			"Models, providers and regions",
			"Spend cap",
			"Permissions",
			"Guardrails",
			"DLP / Redaction",
			"Evaluators",
			"Locked fields",
		]) {
			expect(html).toContain(title);
		}
		expect(html).toContain("openai/gpt-5");
		expect(html).not.toContain("Inherit (");
		expect(html).not.toContain("Alerts");
	});
});
