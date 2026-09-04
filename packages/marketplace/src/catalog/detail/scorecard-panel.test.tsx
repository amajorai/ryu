import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { runAgentScorecard } from "../agent-scorecard.ts";
import type { AgentHealthInput } from "../agent-scorecard-types.ts";
import { ScorecardPanel } from "./scorecard-panel.tsx";

const input: AgentHealthInput = {
	access: {
		composioActionCount: 0,
		highImpactCount: 0,
		identityProfileCount: 0,
	},
	automation: { scheduleEnabled: false, triggerCount: 0 },
	description: "A focused agent for support triage and careful replies.",
	instructions:
		"Triage support requests, explain the next step, and ask before sending anything.",
	lifecycleStatus: "trial",
	memoryWriteEnabled: false,
	model: { configured: true },
	name: "Support desk",
	runtime: { label: "Ryu", status: "ready" },
	safetyProfile: "read_only",
	skills: {
		allSelected: false,
		availableCount: 2,
		loaded: true,
		selectedCount: 1,
	},
	tools: {
		allSelected: false,
		availableCount: 3,
		loaded: true,
		selectedCount: 1,
	},
};

describe("ScorecardPanel agent presentation", () => {
	test("supports agent-specific labels without changing the shared rows", () => {
		const html = renderToStaticMarkup(
			<ScorecardPanel
				dataTestId="agent-health-scorecard"
				disclaimer={<p>Configuration-only check.</p>}
				rulesetLabel="Agent ruleset"
				scorecard={runAgentScorecard(input)}
				title="Agent health"
			/>
		);

		expect(html).toContain('data-testid="agent-health-scorecard"');
		expect(html).toContain("Agent health");
		expect(html).toContain("Agent ruleset agent-config-1");
		expect(html).toContain("Configuration");
		expect(html).toContain("Runtime");
		expect(html).toContain("Configuration-only check.");
	});
});
