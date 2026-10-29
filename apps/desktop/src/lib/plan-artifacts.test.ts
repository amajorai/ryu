import { describe, expect, it } from "bun:test";
import { extractPlans, planDocumentTitle } from "./plan-artifacts.ts";

describe("extractPlans", () => {
	it("keeps future tool payloads and live optional fields while filtering incomplete todos", () => {
		const input = {
			todos: [
				null,
				{
					step: " Ship ",
					status: "future-status",
					metadata: { optional: undefined },
				},
				{ content: "", status: "completed" },
			],
			future: JSON.parse('{"__proto__":{"preserved":true}}'),
		};
		const parts = [
			{
				type: "tool-TodoWrite",
				input,
				output: undefined,
				future: { optional: undefined },
			},
		];
		const plans = extractPlans([{ id: " message ", parts, role: "assistant" }]);
		expect(plans).toHaveLength(1);
		expect(plans[0]?.key).toBe("message:0:part-0");
		expect(plans[0]?.markdown).toContain("- [ ] Ship");
		expect(parts[0]?.input).toBe(input);
		expect(Object.hasOwn(input.future, "__proto__")).toBe(true);
	});
	it("keeps ACP, Pi, and update_plan snapshots with stable keys", () => {
		const plans = extractPlans([
			{
				id: "acp-message",
				role: "assistant",
				parts: [
					{
						type: "tool-TodoWrite",
						state: "output-available",
						input: {
							todos: [
								{
									content: "Inspect the repository",
									status: "pending",
								},
							],
						},
						toolCallId: "acp-plan-1",
					},
					{
						type: "tool-PlanWrite",
						state: "output-available",
						input: {
							plan: {
								title: "Ship the plan artifact",
								summary: "Persist the written plan for later review.",
							},
						},
						toolCallId: "pi-plan-1",
					},
				],
			},
			{
				id: "bridge-message",
				role: "assistant",
				parts: [
					{
						type: "dynamic-tool",
						toolName: "update_plan",
						input: {
							plan: [
								{ step: "Save it", status: "in_progress" },
								{ step: "Open it", status: "pending" },
							],
						},
					},
				],
			},
		]);

		expect(plans).toHaveLength(3);
		expect(plans.map((plan) => plan.tool)).toEqual([
			"TodoWrite",
			"PlanWrite",
			"update_plan",
		]);
		expect(plans[0]?.markdown).toContain("- [ ] Inspect the repository");
		expect(plans[1]?.markdown).toContain("Persist the written plan");
		expect(plans[2]?.markdown).toContain("- [ ] Open it");
		expect(plans[0]?.key).toBe("acp-message:0:acp-plan-1");
	});

	it("ignores user and in-flight plan parts", () => {
		expect(
			extractPlans([
				{
					role: "user",
					parts: [
						{
							type: "tool-TodoWrite",
							input: {
								todos: [{ content: "No", status: "pending" }],
							},
						},
					],
				},
				{
					role: "assistant",
					parts: [
						{
							type: "tool-TodoWrite",
							state: "input-available",
							input: {
								todos: [{ content: "Not yet", status: "pending" }],
							},
						},
					],
				},
			])
		).toEqual([]);
	});
});

describe("planDocumentTitle", () => {
	it("is stable and includes a readable title plus a dedupe suffix", () => {
		const title = planDocumentTitle({
			key: "message:0:call",
			title: "My plan",
		});
		expect(title).toMatch(/^Plan — My plan · [0-9a-f]{8}$/);
		expect(title).toBe(
			planDocumentTitle({ key: "message:0:call", title: "My plan" })
		);
	});
});
