// Agent configuration scorecard rules.
//
// This ruleset is deliberately about the configuration a person is editing,
// not about the quality of the model's answers. It catches setup contradictions
// and risky defaults without pretending that a static scan is a runtime test.

import type {
	AgentHealthInput,
	AgentLifecycleStatus,
} from "./agent-scorecard-types.ts";
import {
	buildScorecard,
	check,
	type Scorecard,
	type ScorecardCheck,
} from "./scorecard-contract.ts";

const MIN_DESCRIPTION_CHARS = 40;
const MIN_INSTRUCTIONS_CHARS = 80;

function configurationChecks(input: AgentHealthInput): ScorecardCheck[] {
	const checks: ScorecardCheck[] = [];
	const name = input.name.trim();
	const instructions = input.instructions?.trim() ?? "";
	const description = input.description?.trim() ?? "";

	checks.push(
		name
			? check(
					"name",
					"configuration",
					"Has an agent name",
					3,
					"pass",
					`The agent is named “${name}”.`
				)
			: check(
					"name",
					"configuration",
					"Has an agent name",
					3,
					"fail",
					"Give the agent a name before saving it."
				)
	);

	if (instructions.length >= MIN_INSTRUCTIONS_CHARS) {
		checks.push(
			check(
				"instructions",
				"configuration",
				"Explains how it should behave",
				2,
				"pass",
				"The instructions give the agent a usable behavioral brief."
			)
		);
	} else if (instructions) {
		checks.push(
			check(
				"instructions",
				"configuration",
				"Explains how it should behave",
				2,
				"warn",
				"The instructions are short. Add its job, boundaries, and preferred answer style."
			)
		);
	} else {
		checks.push(
			check(
				"instructions",
				"configuration",
				"Explains how it should behave",
				2,
				"warn",
				"No instructions yet; the runtime will have to rely on its own defaults."
			)
		);
	}

	if (description.length >= MIN_DESCRIPTION_CHARS) {
		checks.push(
			check(
				"description",
				"configuration",
				"Describes its job",
				1,
				"pass",
				"The description is long enough to identify the agent in a list."
			)
		);
	} else {
		checks.push(
			check(
				"description",
				"configuration",
				"Describes its job",
				1,
				"warn",
				description
					? "The description is brief; add enough context to recognize this agent later."
					: "No description yet. This is optional, but it helps distinguish agents in the sidebar."
			)
		);
	}

	return checks;
}

function runtimeChecks(input: AgentHealthInput): ScorecardCheck[] {
	const checks: ScorecardCheck[] = [];
	const runtimeStatus = input.runtime.status;

	if (runtimeStatus === "missing") {
		checks.push(
			check(
				"runtime",
				"runtime",
				"Has a runtime selected",
				3,
				"fail",
				"Choose the agent runtime that should handle chat turns."
			)
		);
	} else {
		checks.push(
			check(
				"runtime",
				"runtime",
				"Has a runtime selected",
				3,
				"pass",
				input.runtime.label
					? `Chat turns use ${input.runtime.label}.`
					: "A chat runtime is selected."
			)
		);
	}

	checks.push(
		runtimeStatus === "unavailable"
			? check(
					"runtime-availability",
					"runtime",
					"Runtime is available",
					3,
					"fail",
					"This runtime is not installed on the active node. Add it from the Agents catalog first."
				)
			: runtimeStatus === "missing"
				? check(
						"runtime-availability",
						"runtime",
						"Runtime is available",
						3,
						"unknown",
						"Availability is checked after a runtime is selected."
					)
				: runtimeStatus === "custom"
					? check(
							"runtime-availability",
							"runtime",
							"Runtime is available",
							3,
							"pass",
							"The custom ACP command is present and can be checked by the node when it runs."
						)
					: check(
							"runtime-availability",
							"runtime",
							"Runtime is available",
							3,
							"pass",
							"The selected runtime is installed on the active node."
						)
	);

	checks.push(
		input.model.configured
			? check(
					"model",
					"runtime",
					"Has a model choice",
					1,
					"pass",
					"A model is pinned for this agent's chat slot."
				)
			: check(
					"model",
					"runtime",
					"Has a model choice",
					1,
					"warn",
					input.model.required
						? "No model is selected; this runtime may fall back to a provider default."
						: "No model is pinned; the selected runtime will choose its own default."
				)
	);

	return checks;
}

function postureLabel(status: AgentLifecycleStatus): string {
	return status === "draft" ? "Draft" : status === "trial" ? "Trial" : "Active";
}

function safetyChecks(input: AgentHealthInput): ScorecardCheck[] {
	const effectiveSafety =
		input.lifecycleStatus === "trial" ? "read_only" : input.safetyProfile;
	const highImpact = input.access.highImpactCount;
	const highImpactDetail =
		highImpact === 1
			? "1 high-impact capability is available to an autonomous agent; review the access before relying on it."
			: `${highImpact} high-impact capabilities are available to an autonomous agent; review the access before relying on it.`;
	return [
		check(
			"lifecycle",
			"safety",
			"Has a deliberate lifecycle",
			2,
			input.lifecycleStatus === "draft" ? "warn" : "pass",
			input.lifecycleStatus === "draft"
				? "Draft is authoring-only and cannot run until you promote it."
				: `${postureLabel(input.lifecycleStatus)} can be tested under Core's lifecycle rules.`
		),
		check(
			"high-impact-access",
			"safety",
			"High-impact access is guarded",
			3,
			input.lifecycleStatus !== "active" || effectiveSafety !== "autonomous"
				? "pass"
				: highImpact > 0
					? "warn"
					: "pass",
			input.lifecycleStatus === "active"
				? effectiveSafety === "autonomous" && highImpact > 0
					? highImpactDetail
					: "The selected safety profile covers the capabilities currently configured."
				: "Trial and Draft keep high-impact paths from running."
		),
	];
}

function scopeCheck(
	id: string,
	label: string,
	kind: "skills" | "tools",
	capability: AgentHealthInput["tools"]
): ScorecardCheck {
	if (!capability.loaded) {
		return check(
			id,
			"capabilities",
			label,
			2,
			"unknown",
			`The available ${kind} list is still loading.`
		);
	}
	if (capability.availableCount === 0) {
		return check(
			id,
			"capabilities",
			label,
			2,
			"pass",
			`No ${kind} are available to grant on this node.`
		);
	}
	if (capability.allSelected) {
		return check(
			id,
			"capabilities",
			label,
			2,
			"warn",
			`All ${capability.availableCount} available ${kind} are enabled; narrow this access if the agent does not need everything.`
		);
	}
	if (capability.selectedCount === 0) {
		return check(
			id,
			"capabilities",
			label,
			2,
			"pass",
			`No ${kind} are enabled for this agent.`
		);
	}
	if (capability.selectedCount > capability.availableCount) {
		return check(
			id,
			"capabilities",
			label,
			2,
			"warn",
			`The agent references ${capability.selectedCount} ${kind}, but only ${capability.availableCount} are currently available.`
		);
	}
	return check(
		id,
		"capabilities",
		label,
		2,
		"pass",
		`Uses a scoped allowlist: ${capability.selectedCount} of ${capability.availableCount} ${kind}.`
	);
}

function capabilityChecks(input: AgentHealthInput): ScorecardCheck[] {
	const connectionCount =
		input.access.composioActionCount + input.access.identityProfileCount;
	return [
		scopeCheck("tools-scope", "Tool access is scoped", "tools", input.tools),
		scopeCheck(
			"skills-scope",
			"Skill access is scoped",
			"skills",
			input.skills
		),
		check(
			"external-connections",
			"capabilities",
			"External connections are intentional",
			1,
			connectionCount > 0 ? "warn" : "pass",
			connectionCount > 0
				? `${connectionCount} external connection${connectionCount === 1 ? " is" : "s are"} bound; review them before promoting the agent.`
				: "No external accounts or identity profiles are bound."
		),
		check(
			"memory-write",
			"capabilities",
			"Memory writes are guarded",
			2,
			input.memoryWriteEnabled &&
				input.lifecycleStatus === "active" &&
				input.safetyProfile === "autonomous"
				? "warn"
				: "pass",
			input.memoryWriteEnabled
				? input.lifecycleStatus === "trial"
					? "Trial blocks memory writes until the agent is promoted."
					: input.lifecycleStatus === "active" &&
							input.safetyProfile === "autonomous"
						? "This autonomous agent may write long-term memory without an approval step."
						: "Memory writes are enabled under a guarded lifecycle or safety profile."
				: "The agent can recall memory but cannot record new memories."
		),
	];
}

function operationChecks(input: AgentHealthInput): ScorecardCheck[] {
	const backgroundCount =
		(input.automation.scheduleEnabled ? 1 : 0) + input.automation.triggerCount;
	return [
		check(
			"automation",
			"operations",
			"Background work has a runnable lifecycle",
			3,
			backgroundCount > 0 && input.lifecycleStatus !== "active"
				? "fail"
				: "pass",
			backgroundCount === 0
				? "No schedule or event trigger is configured."
				: input.lifecycleStatus === "active"
					? `${backgroundCount} background path${backgroundCount === 1 ? " is" : "s are"} attached to an Active agent.`
					: "Background work is configured on a non-Active agent; promote it before relying on these paths."
		),
	];
}

/** Run the deterministic checks over the configuration currently shown in the editor. */
export function runAgentScorecard(input: AgentHealthInput): Scorecard {
	const checks = [
		...configurationChecks(input),
		...runtimeChecks(input),
		...safetyChecks(input),
		...capabilityChecks(input),
		...operationChecks(input),
	];
	return buildScorecard(checks, "agent-config-1");
}

export type {
	AgentHealthInput,
	AgentRuntimeStatus,
	AgentSafetyProfile,
} from "./agent-scorecard-types.ts";
