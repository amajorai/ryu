// Agent configuration scorecard rules.
//
// This ruleset is deliberately about the configuration a person is editing,
// not about the quality of the model's answers. It catches setup contradictions
// and risky defaults without pretending that a static scan is a runtime test.

import { translate as tl } from "@ryu/i18n/lite";
import type { AgentHealthInput } from "./agent-scorecard-types.ts";
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
					tl("Has an agent name"),
					3,
					"pass",
					tl("The agent is named “{name}”.", { name })
				)
			: check(
					"name",
					"configuration",
					tl("Has an agent name"),
					3,
					"fail",
					tl("Give the agent a name before saving it.")
				)
	);

	if (instructions.length >= MIN_INSTRUCTIONS_CHARS) {
		checks.push(
			check(
				"instructions",
				"configuration",
				tl("Explains how it should behave"),
				2,
				"pass",
				tl("The instructions give the agent a usable behavioral brief.")
			)
		);
	} else if (instructions) {
		checks.push(
			check(
				"instructions",
				"configuration",
				tl("Explains how it should behave"),
				2,
				"warn",
				tl(
					"The instructions are short. Add its job, boundaries, and preferred answer style."
				)
			)
		);
	} else {
		checks.push(
			check(
				"instructions",
				"configuration",
				tl("Explains how it should behave"),
				2,
				"warn",
				tl(
					"No instructions yet; the runtime will have to rely on its own defaults."
				)
			)
		);
	}

	if (description.length >= MIN_DESCRIPTION_CHARS) {
		checks.push(
			check(
				"description",
				"configuration",
				tl("Describes its job"),
				1,
				"pass",
				tl("The description is long enough to identify the agent in a list.")
			)
		);
	} else {
		checks.push(
			check(
				"description",
				"configuration",
				tl("Describes its job"),
				1,
				"warn",
				description
					? tl(
							"The description is brief; add enough context to recognize this agent later."
						)
					: tl(
							"No description yet. This is optional, but it helps distinguish agents in the sidebar."
						)
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
				tl("Has a runtime selected"),
				3,
				"fail",
				tl("Choose the agent runtime that should handle chat turns.")
			)
		);
	} else {
		checks.push(
			check(
				"runtime",
				"runtime",
				tl("Has a runtime selected"),
				3,
				"pass",
				input.runtime.label
					? tl("Chat turns use {label}.", { label: input.runtime.label })
					: tl("A chat runtime is selected.")
			)
		);
	}

	checks.push(
		runtimeStatus === "unavailable"
			? check(
					"runtime-availability",
					"runtime",
					tl("Runtime is available"),
					3,
					"fail",
					tl(
						"This runtime is not installed on the active node. Add it from the Agents catalog first."
					)
				)
			: runtimeStatus === "missing"
				? check(
						"runtime-availability",
						"runtime",
						tl("Runtime is available"),
						3,
						"unknown",
						tl("Availability is checked after a runtime is selected.")
					)
				: runtimeStatus === "custom"
					? check(
							"runtime-availability",
							"runtime",
							tl("Runtime is available"),
							3,
							"pass",
							tl(
								"The custom ACP command is present and can be checked by the node when it runs."
							)
						)
					: check(
							"runtime-availability",
							"runtime",
							tl("Runtime is available"),
							3,
							"pass",
							tl("The selected runtime is installed on the active node.")
						)
	);

	checks.push(
		input.model.configured
			? check(
					"model",
					"runtime",
					tl("Has a model choice"),
					1,
					"pass",
					tl("A model is pinned for this agent's chat slot.")
				)
			: check(
					"model",
					"runtime",
					tl("Has a model choice"),
					1,
					"warn",
					input.model.required
						? tl(
								"No model is selected; this runtime may fall back to a provider default."
							)
						: tl(
								"No model is pinned; the selected runtime will choose its own default."
							)
				)
	);

	return checks;
}

function safetyChecks(input: AgentHealthInput): ScorecardCheck[] {
	const effectiveSafety =
		input.lifecycleStatus === "trial" ? "read_only" : input.safetyProfile;
	const highImpact = input.access.highImpactCount;
	const highImpactDetail = tl(
		"{count, plural, one {# high-impact capability is} other {# high-impact capabilities are}} available to an autonomous agent; review the access before relying on it.",
		{ count: highImpact }
	);
	return [
		check(
			"lifecycle",
			"safety",
			tl("Has a deliberate lifecycle"),
			2,
			input.lifecycleStatus === "draft" ? "warn" : "pass",
			input.lifecycleStatus === "draft"
				? tl("Draft is authoring-only and cannot run until you promote it.")
				: tl(
						"{status, select, trial {Trial} other {Active}} can be tested under Core's lifecycle rules.",
						{ status: input.lifecycleStatus }
					)
		),
		check(
			"high-impact-access",
			"safety",
			tl("High-impact access is guarded"),
			3,
			input.lifecycleStatus !== "active" || effectiveSafety !== "autonomous"
				? "pass"
				: highImpact > 0
					? "warn"
					: "pass",
			input.lifecycleStatus === "active"
				? effectiveSafety === "autonomous" && highImpact > 0
					? highImpactDetail
					: tl(
							"The selected safety profile covers the capabilities currently configured."
						)
				: tl("Trial and Draft keep high-impact paths from running.")
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
			tl(
				"The available {kind, select, skills {skills} other {tools}} list is still loading.",
				{ kind }
			)
		);
	}
	if (capability.availableCount === 0) {
		return check(
			id,
			"capabilities",
			label,
			2,
			"pass",
			tl(
				"No {kind, select, skills {skills} other {tools}} are available to grant on this node.",
				{
					kind,
				}
			)
		);
	}
	if (capability.allSelected) {
		return check(
			id,
			"capabilities",
			label,
			2,
			"warn",
			tl(
				"All {availableCount} available {kind, select, skills {skills} other {tools}} are enabled; narrow this access if the agent does not need everything.",
				{ availableCount: String(capability.availableCount), kind }
			)
		);
	}
	if (capability.selectedCount === 0) {
		return check(
			id,
			"capabilities",
			label,
			2,
			"pass",
			tl(
				"No {kind, select, skills {skills} other {tools}} are enabled for this agent.",
				{ kind }
			)
		);
	}
	if (capability.selectedCount > capability.availableCount) {
		return check(
			id,
			"capabilities",
			label,
			2,
			"warn",
			tl(
				"The agent references {selectedCount} {kind, select, skills {skills} other {tools}}, but only {availableCount} are currently available.",
				{
					availableCount: String(capability.availableCount),
					kind,
					selectedCount: String(capability.selectedCount),
				}
			)
		);
	}
	return check(
		id,
		"capabilities",
		label,
		2,
		"pass",
		tl(
			"Uses a scoped allowlist: {selectedCount} of {availableCount} {kind, select, skills {skills} other {tools}}.",
			{
				availableCount: String(capability.availableCount),
				kind,
				selectedCount: String(capability.selectedCount),
			}
		)
	);
}

function capabilityChecks(input: AgentHealthInput): ScorecardCheck[] {
	const connectionCount =
		input.access.composioActionCount + input.access.identityProfileCount;
	return [
		scopeCheck(
			"tools-scope",
			tl("Tool access is scoped"),
			"tools",
			input.tools
		),
		scopeCheck(
			"skills-scope",
			tl("Skill access is scoped"),
			"skills",
			input.skills
		),
		check(
			"external-connections",
			"capabilities",
			tl("External connections are intentional"),
			1,
			connectionCount > 0 ? "warn" : "pass",
			connectionCount > 0
				? tl(
						"{count, plural, one {# external connection is} other {# external connections are}} bound; review them before promoting the agent.",
						{ count: connectionCount }
					)
				: tl("No external accounts or identity profiles are bound.")
		),
		check(
			"memory-write",
			"capabilities",
			tl("Memory writes are guarded"),
			2,
			input.memoryWriteEnabled &&
				input.lifecycleStatus === "active" &&
				input.safetyProfile === "autonomous"
				? "warn"
				: "pass",
			input.memoryWriteEnabled
				? input.lifecycleStatus === "trial"
					? tl("Trial blocks memory writes until the agent is promoted.")
					: input.lifecycleStatus === "active" &&
							input.safetyProfile === "autonomous"
						? tl(
								"This autonomous agent may write long-term memory without an approval step."
							)
						: tl(
								"Memory writes are enabled under a guarded lifecycle or safety profile."
							)
				: tl("The agent can recall memory but cannot record new memories.")
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
			tl("Background work has a runnable lifecycle"),
			3,
			backgroundCount > 0 && input.lifecycleStatus !== "active"
				? "fail"
				: "pass",
			backgroundCount === 0
				? tl("No schedule or event trigger is configured.")
				: input.lifecycleStatus === "active"
					? tl(
							"{count, plural, one {# background path is} other {# background paths are}} attached to an Active agent.",
							{ count: backgroundCount }
						)
					: tl(
							"Background work is configured on a non-Active agent; promote it before relying on these paths."
						)
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
