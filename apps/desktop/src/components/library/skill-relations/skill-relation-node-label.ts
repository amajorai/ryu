import type { LiteralMessage } from "@ryu/i18n/react";
import type { SkillRelationNodeKind } from "@/src/lib/skill-relations.ts";

/**
 * The accessible name of a skill-relations graph node: one translated sentence
 * per kind ("Agent: Researcher"), so a screen reader never hears the raw
 * internal kind word.
 */
export function skillRelationNodeLabel(
	kind: SkillRelationNodeKind,
	name: string,
	tl: LiteralMessage
): string {
	return tl(
		"{kind, select, agent {Agent: {name}} skill {Skill: {name}} other {Tool: {name}}}",
		{ kind, name }
	);
}
