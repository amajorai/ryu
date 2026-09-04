import { describe, expect, test } from "bun:test";
import { runAgentScorecard } from "./agent-scorecard.ts";
import type { AgentHealthInput } from "./agent-scorecard-types.ts";

function healthyAgent(
	overrides: Partial<AgentHealthInput> = {}
): AgentHealthInput {
	return {
		access: {
			composioActionCount: 0,
			highImpactCount: 0,
			identityProfileCount: 0,
		},
		automation: {
			scheduleEnabled: false,
			triggerCount: 0,
		},
		description:
			"Reviews incoming support requests and drafts careful replies.",
		instructions:
			"Review the request, explain the decision, and ask before making any external change.",
		lifecycleStatus: "trial",
		memoryWriteEnabled: false,
		model: { configured: true, required: true },
		name: "Support desk",
		runtime: { label: "Ryu", status: "ready" },
		safetyProfile: "read_only",
		skills: {
			allSelected: false,
			availableCount: 3,
			loaded: true,
			selectedCount: 1,
		},
		tools: {
			allSelected: false,
			availableCount: 4,
			loaded: true,
			selectedCount: 2,
		},
		...overrides,
	};
}

function statusOf(input: AgentHealthInput, id: string) {
	return runAgentScorecard(input).checks.find((check) => check.id === id)
		?.status;
}

describe("runAgentScorecard", () => {
	test("a complete trial agent passes every critical check", () => {
		const card = runAgentScorecard(healthyAgent());

		expect(card.rulesetVersion).toBe("agent-config-1");
		expect(card.grade).toBe("A");
		expect(card.score).toBe(100);
		expect(card.checks.some((check) => check.status === "fail")).toBe(false);
	});

	test("keeps the lightweight creation path healthy without optional copy", () => {
		const card = runAgentScorecard(
			healthyAgent({ description: null, instructions: null })
		);

		expect(statusOf(healthyAgent({ description: null }), "description")).toBe(
			"warn"
		);
		expect(statusOf(healthyAgent({ instructions: null }), "instructions")).toBe(
			"warn"
		);
		expect(card.checks.some((check) => check.status === "fail")).toBe(false);
	});

	test("reports the actual blockers without turning them into vague warnings", () => {
		const card = runAgentScorecard(
			healthyAgent({
				automation: { scheduleEnabled: true, triggerCount: 1 },
				name: "",
				runtime: { status: "unavailable" },
				lifecycleStatus: "trial",
			})
		);

		expect(statusOf(healthyAgent({ name: "" }), "name")).toBe("fail");
		expect(
			statusOf(
				healthyAgent({ runtime: { status: "unavailable" } }),
				"runtime-availability"
			)
		).toBe("fail");
		expect(card.checks.find((check) => check.id === "automation")?.status).toBe(
			"fail"
		);
		expect(card.summary).toContain("fix them before running");
	});

	test("warns on broad autonomous access while preserving a usable score", () => {
		const card = runAgentScorecard(
			healthyAgent({
				access: {
					composioActionCount: 2,
					highImpactCount: 4,
					identityProfileCount: 1,
				},
				lifecycleStatus: "active",
				memoryWriteEnabled: true,
				safetyProfile: "autonomous",
				tools: {
					allSelected: true,
					availableCount: 8,
					loaded: true,
					selectedCount: 8,
				},
				skills: {
					allSelected: true,
					availableCount: 4,
					loaded: true,
					selectedCount: 4,
				},
			})
		);

		expect(
			statusOf(
				healthyAgent({
					lifecycleStatus: "active",
					safetyProfile: "autonomous",
					access: {
						composioActionCount: 1,
						highImpactCount: 1,
						identityProfileCount: 0,
					},
				}),
				"high-impact-access"
			)
		).toBe("warn");
		expect(
			card.checks.find((check) => check.id === "tools-scope")?.status
		).toBe("warn");
		expect(
			card.checks.find((check) => check.id === "memory-write")?.status
		).toBe("warn");
		expect(card.grade).not.toBe("F");
	});

	test("keeps loading catalogs unknown instead of marking them as broken", () => {
		const card = runAgentScorecard(
			healthyAgent({
				skills: {
					allSelected: false,
					availableCount: 0,
					loaded: false,
					selectedCount: 0,
				},
				tools: {
					allSelected: false,
					availableCount: 0,
					loaded: false,
					selectedCount: 0,
				},
			})
		);

		expect(
			statusOf(
				healthyAgent({
					tools: {
						allSelected: false,
						availableCount: 0,
						loaded: false,
						selectedCount: 0,
					},
				}),
				"tools-scope"
			)
		).toBe("unknown");
		expect(
			statusOf(
				healthyAgent({
					skills: {
						allSelected: false,
						availableCount: 0,
						loaded: false,
						selectedCount: 0,
					},
				}),
				"skills-scope"
			)
		).toBe("unknown");
		expect(card.checks.some((check) => check.status === "fail")).toBe(false);
		expect(card.evaluated).toBeLessThan(card.checks.length);
	});
});
